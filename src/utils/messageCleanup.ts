/**
 * Message cleanup performed immediately before an API call, modelled on
 * llm-codegen's anthropic_utils.clean_messages.
 *
 * Invariants:
 *  - the number of messages never changes (a message emptied by cleanup gets a
 *    "[continuing]" text block instead of being dropped)
 *  - at most one thinking block survives per assistant message, and it is moved to
 *    the front of the content
 *  - thinking produced by a different model, or a payload that the target API
 *    cannot replay, is dropped (the payload only; the text may survive as raw)
 *
 * Kept free of vscode/extension imports so it can be tested standalone.
 */

import { Content, MessageParam, ThinkingContent } from "../types";

export type ApiStyle = "anthropic" | "openai_chat" | "openai_responses";

export interface CleanupOptions {
  /** Model name the request is about to be sent to */
  modelName: string;
  /** Whether thinking is actually enabled for this request */
  thinkingEnabled: boolean;
  apiStyle: ApiStyle;
}

const CONTINUING_PLACEHOLDER = "[continuing]";

function isThinking(block: Content): block is ThinkingContent {
  return block.type === "thinking";
}

/**
 * A payload can only be replayed to the API family that produced it. On a mismatch
 * (for instance the same model switched from the Responses API to chat completions)
 * the payload is dropped and the block degrades to raw thinking text.
 */
export function payloadUsableForApi(
  block: ThinkingContent,
  apiStyle: ApiStyle,
): boolean {
  const kind = block.payload?.kind;
  if (!kind || kind === "raw") {
    return false;
  }
  switch (apiStyle) {
    case "anthropic":
      return kind === "anthropic_signature" || kind === "anthropic_redacted";
    case "openai_responses":
      return kind === "openai_encrypted";
    case "openai_chat":
      return kind === "reasoning_details";
  }
}

/**
 * Thinking from another model must not be replayed. A block with no model
 * attribution (hand written, or written before this feature) is kept as raw text.
 */
export function thinkingMatchesModel(
  block: ThinkingContent,
  modelName: string,
): boolean {
  if (!block.model) {
    return true;
  }
  return block.model === modelName;
}

/** Trailing whitespace in the final assistant text block breaks the Anthropic API */
function stripTrailingWhitespace(blocks: Content[]): Content[] {
  const result = [...blocks];
  for (let i = result.length - 1; i >= 0; i--) {
    const block = result[i];
    if (block.type !== "text") {
      break;
    }
    const trimmed = block.value.replace(/\s+$/, "");
    if (trimmed === "") {
      result.splice(i, 1);
      continue;
    }
    result[i] = { type: "text", value: trimmed };
    break;
  }
  return result;
}

/**
 * Select the single thinking block to send: the first one carrying a replayable
 * payload, else the first one at all. Ordering follows the document, so an
 * out-of-order signature that landed in a later section still wins over an earlier
 * summary-only section.
 */
export function selectThinkingBlock(
  blocks: ThinkingContent[],
  apiStyle: ApiStyle,
): ThinkingContent | undefined {
  const withPayload = blocks.find((block) => payloadUsableForApi(block, apiStyle));
  if (withPayload) {
    return withPayload;
  }
  return blocks[0];
}

export function cleanMessagesForApi(
  messages: readonly MessageParam[],
  options: CleanupOptions,
): MessageParam[] {
  return messages.map((message) => {
    let blocks: Content[] = message.content.filter((block) => {
      if (block.type === "text") {
        return block.value.trim() !== "";
      }
      return true;
    });

    const thinkingBlocks = blocks.filter(isThinking);

    if (thinkingBlocks.length > 0) {
      // Thinking only belongs to assistant turns
      if (message.role !== "assistant" || !options.thinkingEnabled) {
        blocks = blocks.filter((block) => !isThinking(block));
      } else {
        const candidates = thinkingBlocks.filter((block) =>
          thinkingMatchesModel(block, options.modelName),
        );
        const chosen = selectThinkingBlock(candidates, options.apiStyle);
        const others = blocks.filter((block) => !isThinking(block));

        const usable = chosen
          ? payloadUsableForApi(chosen, options.apiStyle)
          : false;

        if (!chosen || (!usable && options.apiStyle === "anthropic")) {
          // Anthropic rejects thinking blocks it did not sign, so unsigned
          // thinking is display only.
          blocks = others;
        } else {
          const normalised: ThinkingContent = usable
            ? chosen
            : { type: "thinking", value: chosen.value, model: chosen.model };
          // Thinking always goes first: Anthropic requires it and it keeps the
          // replayed turn identical in shape to how it was produced.
          blocks =
            !usable && normalised.value.trim() === ""
              ? others
              : [normalised, ...others];
        }
      }
    }

    if (message.role === "assistant") {
      blocks = stripTrailingWhitespace(blocks);
    }

    if (blocks.length === 0) {
      blocks = [{ type: "text", value: CONTINUING_PLACEHOLDER }];
    }

    return { role: message.role, content: blocks };
  });
}
