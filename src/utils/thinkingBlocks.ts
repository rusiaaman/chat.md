/**
 * Pure helpers for the "## %% thinking" / "## %% text" sub-blocks of an assistant
 * turn, and for the streaming token protocol used to carry reasoning from the API
 * clients to the streamer.
 *
 * This module depends only on marker escaping, and nothing on VS Code, so it can
 * still be unit tested standalone.
 */

import { escapeMarkers } from "./markerEscape";

/** Marker that opens a thinking section inside an assistant block */
export const THINKING_SECTION_MARKER = "## %% thinking";

/** Marker that opens a normal text section inside an assistant block */
export const TEXT_SECTION_MARKER = "## %% text";

/**
 * Prefixes used by the API clients to tag non-text stream tokens. They start with
 * NUL so they can never collide with model output.
 */
export const THINKING_TOKEN_PREFIX = "\u0000thinking:";
export const THINKING_PAYLOAD_PREFIX = "\u0000thinking_payload:";

export interface AssistantSection {
  type: "thinking" | "text" | "server_tool" | "server_tool_results";
  content: string;
}

export interface ParsedThinkingSection {
  /** Thinking text without the trailing signature line */
  text: string;
  /** Qualified model name from the signature line */
  model?: string;
  /** 8 character hash from the signature line */
  hash?: string;
}

const SECTION_SPLIT_REGEX =
  /^## %% (thinking|text|server_tool|server_tool_results)[ \t]*$/im;
const SECTION_TEST_REGEX =
  /^## %% (thinking|text|server_tool|server_tool_results)[ \t]*$/im;

/** Greedy model part so the split happens on the last "::" of the line */
const SIGNATURE_LINE_REGEX = /^(.+)::([0-9a-f]{8})$/;

/**
 * True when the assistant block uses the sectioned format. Blocks without any
 * marker are plain text, which is the pre-existing format and stays supported.
 */
export function hasAssistantSections(text: string): boolean {
  return SECTION_TEST_REGEX.test(text);
}

/**
 * Split an assistant block into its thinking/text sections. A block with no
 * markers yields a single text section with the whole content. Content appearing
 * before the first marker is also treated as text.
 */
export function splitAssistantSections(text: string): AssistantSection[] {
  if (!hasAssistantSections(text)) {
    return [{ type: "text", content: text }];
  }

  const parts = text.split(SECTION_SPLIT_REGEX);
  const sections: AssistantSection[] = [];

  if (parts.length > 0 && parts[0].trim() !== "") {
    sections.push({ type: "text", content: parts[0] });
  }

  for (let i = 1; i < parts.length; i += 2) {
    const kind = parts[i].toLowerCase() as AssistantSection["type"];
    sections.push({ type: kind, content: parts[i + 1] ?? "" });
  }

  return sections;
}

/**
 * Parse a thinking section: the last non-empty line is the signature line when it
 * matches "qualified_model_name::hash8", and is not part of the thinking text.
 */
export function parseThinkingSection(content: string): ParsedThinkingSection {
  const lines = content.split(/\r?\n/);

  let lastNonEmpty = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== "") {
      lastNonEmpty = i;
      break;
    }
  }

  if (lastNonEmpty === -1) {
    return { text: "" };
  }

  const match = SIGNATURE_LINE_REGEX.exec(lines[lastNonEmpty].trim());
  if (!match) {
    return { text: content.trim() };
  }

  const model = match[1].trim();
  if (!model) {
    return { text: content.trim() };
  }

  return {
    text: lines.slice(0, lastNonEmpty).join("\n").trim(),
    model,
    hash: match[2],
  };
}

/** Renders the trailing line of a thinking section */
export function formatSignatureLine(model: string, hash: string): string {
  return `${model}::${hash}`;
}

/**
 * Returns only the text sections of an assistant block, so tool call scanning
 * never looks inside thinking text.
 */
export function stripThinkingSections(text: string): string {
  if (!hasAssistantSections(text)) {
    return text;
  }
  return splitAssistantSections(text)
    .filter((section) => section.type === "text")
    .map((section) => section.content)
    .join("\n");
}

/** True when the token carries thinking text rather than assistant text */
export function isThinkingToken(token: string): boolean {
  return token.startsWith(THINKING_TOKEN_PREFIX);
}

/** True when the token carries a reasoning payload */
export function isThinkingPayloadToken(token: string): boolean {
  return token.startsWith(THINKING_PAYLOAD_PREFIX);
}

export function encodeThinkingToken(text: string): string {
  return THINKING_TOKEN_PREFIX + text;
}

export function decodeThinkingToken(token: string): string {
  return token.substring(THINKING_TOKEN_PREFIX.length);
}

export function encodeThinkingPayloadToken(payload: unknown): string {
  return THINKING_PAYLOAD_PREFIX + JSON.stringify(payload);
}

export function decodeThinkingPayloadToken(token: string): any | undefined {
  try {
    return JSON.parse(token.substring(THINKING_PAYLOAD_PREFIX.length));
  } catch {
    return undefined;
  }
}

/**
 * Which section of the assistant block the streamer is currently writing into.
 */
export interface SectionState {
  thinkingOpen: boolean;
  textOpen: boolean;
  sawThinking: boolean;
  /** Offset in the assistant block where the current text section content starts */
  scanOffset: number;
  /**
   * Offset in the assistant block where the current text section content ends,
   * or null while the text section is still open (it extends to the end).
   *
   * Set when a thinking section opens, which closes the text section before it.
   * Together with scanOffset this bounds the region that may be scanned for tool
   * calls to assistant text only, so `<cmd:...>` written inside thinking is
   * never parsed or executed as a tool call.
   */
  textSectionEnd: number | null;
}

/**
 * Renders a batch of stream tokens into the text to append to the assistant block,
 * inserting section markers as the token kind changes and updating `state`.
 *
 * Writing is strictly append-only: a signature arriving after text has started
 * opens another thinking section instead of editing the earlier one.
 *
 * @param recordPayload stores the payload and returns its "model::hash" line, or
 *        undefined when the payload could not be stored
 */
export function renderStreamTokens(
  tokens: string[],
  alreadyWritten: string,
  state: SectionState,
  recordPayload: (token: string) => string | undefined,
): string {
  let out = "";

  const needsNewline = (): boolean => {
    const soFar = alreadyWritten + out;
    return soFar.length > 0 && !soFar.endsWith("\n");
  };

  /** Escapes content against its real position in the document. */
  const emit = (text: string): string => {
    const soFar = alreadyWritten + out;
    return escapeMarkers(text, soFar.length === 0 || soFar.endsWith("\n"));
  };

  const openThinkingSection = (): void => {
    // Thinking closes whatever text section preceded it. Freeze the scannable
    // region here so the thinking text that follows is never scanned for tool
    // calls, while a tool call completed in the text before it still is.
    //
    // A text section is only actually open when one was started after the last
    // thinking section (textOpen), or when no thinking has appeared yet and the
    // whole block so far is text. Otherwise this call is opening a second
    // thinking section straight after a previous one (a signature ends a
    // section without ending the reasoning), and there is no text to scan:
    // collapse the region to empty rather than letting it cover the earlier
    // thinking content.
    state.textSectionEnd =
      state.textOpen || !state.sawThinking
        ? alreadyWritten.length + out.length
        : state.scanOffset;
    if (needsNewline()) {
      out += "\n";
    }
    out += THINKING_SECTION_MARKER + "\n";
    state.sawThinking = true;
    state.textOpen = false;
  };

  for (const token of tokens) {
    if (isThinkingPayloadToken(token)) {
      const signatureLine = recordPayload(token);
      if (!signatureLine) {
        continue;
      }
      if (!state.thinkingOpen) {
        openThinkingSection();
      } else if (needsNewline()) {
        out += "\n";
      }
      out += signatureLine + "\n";
      // The signature always ends its thinking section
      state.thinkingOpen = false;
      continue;
    }

    if (isThinkingToken(token)) {
      const thinkingText = decodeThinkingToken(token);
      if (!thinkingText) {
        continue;
      }
      if (!state.thinkingOpen) {
        openThinkingSection();
        state.thinkingOpen = true;
      }
      // The model's own text is escaped; the section markers emitted above are
      // real markers and must stay readable as such. Escaping here rather than
      // afterwards keeps the offsets recorded in `state` in document coordinates.
      out += emit(thinkingText);
      continue;
    }

    // Normal assistant text: once thinking has appeared, text must live under a
    // "## %% text" marker
    if (state.sawThinking && !state.textOpen) {
      if (needsNewline()) {
        out += "\n";
      }
      out += TEXT_SECTION_MARKER + "\n";
      state.textOpen = true;
      state.thinkingOpen = false;
      // Tool call scanning starts after the marker, so thinking text and signature
      // lines can never be mistaken for a tool call
      state.scanOffset = alreadyWritten.length + out.length;
      // The new text section is open, so it extends to the end of the block
      state.textSectionEnd = null;
    }
    out += emit(token);
  }

  return out;
}
