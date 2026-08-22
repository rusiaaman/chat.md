import { log } from "../extension";

/**
 * Represents the structure of a parsed tool call
 */
export interface ParsedToolCall {
  name: string;
  params: Record<string, string>;
}

/**
 * Represents the results of checking for completed tool calls
 */
export type ToolCallCheckResult =
  | { isComplete: false }
  | { isComplete: true; endIndex: number };

/**
 * Types of tool call formatting. Only the un-fenced cmd format is supported.
 */
export enum ToolCallFormatType {
  NON_FENCED = "non-fenced",
  UNKNOWN = "unknown",
}

/** Qualified tags of the only supported tool call format */
export const CMD_TOOL_CALL_OPEN_TAG = "\u003ccmd:tool_call\u003e";
export const CMD_TOOL_CALL_CLOSE_TAG = "\u003c/cmd:tool_call\u003e";

/**
 * The single source of truth for what a complete tool call looks like: the opening
 * tag, any body, and a closing tag that starts its own line. The newline keeps a
 * closing tag mentioned inline inside a parameter value from ending the call early.
 *
 * Used by findToolCallPatterns (streaming detection), findAllToolCalls (listener)
 * and parseToolCall, which must all agree.
 */
export const TOOL_CALL_PATTERN =
  CMD_TOOL_CALL_OPEN_TAG + "[\\s\\S]*?\\n\\s*" + CMD_TOOL_CALL_CLOSE_TAG;

/**
 * Marker the model emits once, after the last tool call of a batch, to say "that is
 * the whole batch, run it and give me the results".
 *
 * It is a stream-control signal, not part of the .chat.md format: it is never
 * written into the document and never parsed back out of one. The streamer strips
 * it while streaming, and parseDocument re-synthesises it into the API payload
 * after each historical tool batch so the model always sees its own past turns in
 * the shape it is asked to produce.
 */
export const CMD_WAIT_TOOL_RESULT_TAG =
  "\u003ccmd:wait-tool-result/\u003e";

/**
 * Index of the first complete wait marker in `text`, or -1 when there is none.
 */
export function findWaitMarker(text: string): number {
  return text.indexOf(CMD_WAIT_TOOL_RESULT_TAG);
}

/**
 * Length of the longest suffix of `text` that is a proper prefix of the wait
 * marker, or 0 when the text does not end mid-marker.
 *
 * Used to hold back the tail of a batch that may still turn into a marker, so a
 * marker split across two token batches is never written to the document.
 */
export function waitMarkerPrefixLength(text: string): number {
  const max = Math.min(text.length, CMD_WAIT_TOOL_RESULT_TAG.length - 1);
  for (let len = max; len > 0; len--) {
    if (CMD_WAIT_TOOL_RESULT_TAG.startsWith(text.substring(text.length - len))) {
      return len;
    }
  }
  return 0;
}

/**
 * Appends the wait marker after the last complete tool call in `text`.
 *
 * Used when replaying a finished assistant turn to the API: the document holds the
 * tool calls without the marker, and the model is asked to always end a batch with
 * one, so history has to carry it too.
 *
 * Returns `text` unchanged when it holds no complete tool call.
 */
export function appendWaitMarkerAfterLastToolCall(text: string): string {
  const matches = Array.from(text.matchAll(new RegExp(TOOL_CALL_PATTERN, "gs")));
  if (matches.length === 0) {
    return text;
  }
  const last = matches[matches.length - 1];
  const insertAt = (last.index ?? 0) + last[0].length;
  return (
    text.substring(0, insertAt) +
    "\n" +
    CMD_WAIT_TOOL_RESULT_TAG +
    text.substring(insertAt)
  );
}

/**
 * Extracts XML content from a fenced or non-fenced tool call
 * @param toolCallXml The raw tool call XML string
 * @returns The extracted XML content with fencing removed
 */
export function extractXmlContent(toolCallXml: string): string {
  const content = toolCallXml.trim();
  if (content.startsWith("<cmd:tool_call>")) {
    log(`Tool call format: ${ToolCallFormatType.NON_FENCED}`);
    return content;
  }
  log("Tool call must use the un-fenced cmd format");
  return "";
}

/**
 * Preprocesses XML content with CDATA sections to handle special cases
 * This helps ensure that XML tags inside CDATA sections don't interfere with parsing
 * @param xml The XML content to preprocess
 * @returns The preprocessed XML
 */
export function preprocessXmlWithCdata(xml: string): string {
  const cdataSections: string[] = [];
  let index = 0;

  // Replace CDATA sections with placeholders
  const processedXml = xml.replace(
    /<!\[CDATA\[([\s\S]*?)\]\]>/gs,
    (match, content) => {
      const placeholder = `__CDATA_PLACEHOLDER_${index}__`;
      cdataSections[index] = content;
      index++;
      return placeholder;
    },
  );

  // No need to restore placeholders as we're just using this for tag matching
  // The actual CDATA content will be processed separately when parsing parameters

  return processedXml;
}

/**
 * Checks if CDATA tags are balanced in the given text
 * @param text The text to check for balanced CDATA tags
 * @returns True if CDATA tags are balanced, false otherwise
 */
export function areCdataTagsBalanced(text: string): boolean {
  // Track CDATA tag states by parsing character by character
  // This is more accurate than just counting tags as it respects nesting order
  let isInsideCdata = false;
  let i = 0;

  while (i < text.length) {
    if (!isInsideCdata) {
      // Look for opening CDATA tag when not inside CDATA
      if (i + 8 < text.length && text.substring(i, i + 9) === "<![CDATA[") {
        isInsideCdata = true;
        i += 9; // Skip the CDATA opening tag
      } else {
        i++; // Move to next character
      }
    } else {
      // Look for closing CDATA tag when inside CDATA
      if (i + 2 < text.length && text.substring(i, i + 3) === "]]>") {
        isInsideCdata = false;
        i += 3; // Skip the CDATA closing tag
      } else {
        i++; // Move to next character
      }
    }
  }

  // If we're still inside CDATA at the end, tags are not balanced
  if (isInsideCdata) {
    log("CDATA tags are not balanced: missing closing tag");
    return false;
  }

  return true;
}

/**
 * Checks if all parameter blocks have balanced CDATA tags
 * @param text The text containing parameter blocks
 * @returns True if all parameter blocks have balanced CDATA tags, false otherwise
 */
export function areParamsComplete(text: string): boolean {
  // Extract each param block and verify it's properly formed
  const paramBlocks: string[] = [];
  const paramRegex = /<cmd:param\s+name=["'](.*?)["']>([\s\S]*?)<\/cmd:param>/gs;
  let paramMatch;

  while ((paramMatch = paramRegex.exec(text)) !== null) {
    paramBlocks.push(paramMatch[0]);
  }

  // Check each param block for balanced CDATA tags using the improved checking logic
  for (const block of paramBlocks) {
    if (!areCdataTagsBalanced(block)) {
      log(
        `Param block has unbalanced CDATA tags: ${block.substring(0, 50)}...`,
      );
      return false;
    }
  }

  return true;
}

/**
 * Preprocess text for safe matching, handling CDATA sections
 * @param text The text to preprocess
 * @returns The preprocessed text
 */
export function preprocessCdataForMatching(text: string): string {
  // More robust CDATA preprocessing that handles nested tags correctly
  // This prevents XML-like content inside CDATA from being interpreted as actual XML

  let processedText = "";
  let isInsideCdata = false;
  let cdataContent = "";
  let i = 0;

  while (i < text.length) {
    if (!isInsideCdata) {
      // Look for opening CDATA tag when not inside CDATA
      if (i + 8 < text.length && text.substring(i, i + 9) === "<![CDATA[") {
        isInsideCdata = true;
        cdataContent = "";
        i += 9; // Skip the CDATA opening tag
        processedText += "<![CDATA["; // Keep the opening tag in the processed text
      } else {
        processedText += text[i];
        i++;
      }
    } else {
      // Look for closing CDATA tag when inside CDATA
      if (i + 2 < text.length && text.substring(i, i + 3) === "]]>") {
        isInsideCdata = false;
        // Replace XML-like tags in the CDATA content with placeholders
        // This ensures they don't interfere with XML parsing
        const safeContent = cdataContent.replace(/<\/?[^>]+(>|$)/g, (match) => {
          // Create a distinctive placeholder that won't be confused with actual content
          return `__XML_TAG_PLACEHOLDER_${Buffer.from(match).toString("base64")}__`;
        });
        processedText += safeContent + "]]>"; // Add safe content and closing tag
        i += 3; // Skip the CDATA closing tag
      } else {
        cdataContent += text[i];
        i++;
      }
    }
  }

  return processedText;
}

/**
 * Extracts the content of a CDATA section if present
 * @param text The text possibly containing a CDATA section
 * @returns The content inside the CDATA tags if present, or the original text if not
 */
export function extractCdataContent(text: string): string {
  // Trim whitespace first to handle potential padding around the CDATA tag itself
  const trimmedText = text.trim();

  // Check if the entire trimmed string matches the CDATA pattern
  // Use ^ and $ anchors to ensure it's the whole string
  // Use the 's' flag for dotall matching multi-line content
  const cdataMatch = trimmedText.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/s);

  if (cdataMatch) {
    // If the entire trimmed text is a CDATA block, return the captured content (group 1)
    log("Found parameter value fully wrapped in CDATA, extracting content.");
    return cdataMatch[1];
  }

  // If the entire string wasn't a CDATA block, check if CDATA exists *within* the text.
  // This handles cases where CDATA might be mixed with other text, though less common for params.
  // Use the original 'replace' logic as a fallback, operating on the original 'text'
  // to preserve surrounding characters if it wasn't a full CDATAblock.
  if (text.includes("<![CDATA[")) {
    log("Found CDATA section within parameter value, attempting replacement.");
    // Use the original replace logic but apply it to the original text, not trimmed
    return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gs, (match, content) => {
      return content;
    });
  }

  // If no CDATA found at all, return the original text
  log("No CDATA found in parameter value.");
  return text;
}

/**
 * Parses a tool call XML string into a structured object
 * Handles CDATA tags in parameters
 * @param toolCallXml The raw tool call XML string
 * @returns A parsed tool call object or null if parsing fails
 */
export function parseToolCall(toolCallXml: string): ParsedToolCall | null {
  try {
    // Extract the XML content
    const xmlContent = extractXmlContent(toolCallXml);

    // Process XML content to handle CDATA sections for structural validation only
    // This helps with finding tag boundaries but preserves the original content for parameter extraction
    const preprocessedXml = preprocessXmlWithCdata(xmlContent);

    // Focus on the part between <cmd:tool_call> and \n</cmd:tool_call> tags using the preprocessed XML
    // Require the closing tag to be on its own line
    const toolCallContentMatch =
      /<cmd:tool_call>\s*([\s\S]*?)\n\s*<\/cmd:tool_call>/s.exec(preprocessedXml);

    // Get the corresponding part from the original XML for parameter extraction
    // This ensures we have the original CDATA tags intact when parsing parameters
    let originalToolCallContent = "";
    if (toolCallContentMatch) {
      // Use the same pattern with newline requirement for the original content
      const fullMatch = /<cmd:tool_call>[\s\S]*?\n\s*<\/cmd:tool_call>/s.exec(
        xmlContent,
      );
      if (fullMatch) {
        originalToolCallContent = fullMatch[0].replace(
          /<cmd:tool_call>\s*|\n\s*<\/cmd:tool_call>/g,
          "",
        );
      }
    } else {
      // Fallback to the original string if preprocessed matching fails
      // Still require newline before closing tag
      originalToolCallContent =
        /<cmd:tool_call>\s*([\s\S]*?)\n\s*<\/cmd:tool_call>/s.exec(xmlContent)?.[1] ||
        "";
    }

    if (!originalToolCallContent) {
      log("Could not extract tool call content");
      return null;
    }

    // Simple XML parser for tool calls - allow indentation with more flexible whitespace
    // Use the original content for name extraction
    const nameMatch = /<cmd:tool_name>\s*(.*?)\s*<\/cmd:tool_name>/s.exec(
      originalToolCallContent,
    );
    if (!nameMatch) {
      log("Could not find tool_name tag");
      return null;
    }

    const toolName = nameMatch[1].trim();
    const params: Record<string, string> = {};

    // Extract parameters with more precise formatting
    // Updated regex to require quotes around parameter names and be flexible with whitespace
    // Use the original content with intact CDATA sections
    const paramRegex =
      /<cmd:param\s+name=["'](.*?)["']>\s*([\s\S]*?)\s*<\/cmd:param>/gs;
    let paramMatch;

    while ((paramMatch = paramRegex.exec(originalToolCallContent)) !== null) {
      const paramName = paramMatch[1].trim(); // No need to replace quotes, they're already handled in the regex
      let paramValue = paramMatch[2].trim();

      // Check for CDATA sections in the parameter value using our improved extractor
      // This will handle multiple CDATA sections and strip only the CDATA tags, preserving content
      paramValue = extractCdataContent(paramValue);

      // Store all parameter values as strings, even JSON objects or arrays
      params[paramName] = paramValue;

      // Log the parameter type for debugging
      if (
        paramValue.trim().startsWith("{") ||
        paramValue.trim().startsWith("[")
      ) {
        log(
          `Parameter "${paramName}" appears to be JSON, storing as string: ${paramValue.substring(0, 50)}${paramValue.length > 50 ? "..." : ""}`,
        );
      }
    }

    log(
      `Parsed tool call with parameters: ${JSON.stringify(Object.keys(params))}`,
    );
    return { name: toolName, params };
  } catch (error) {
    log(`Error parsing tool call: ${error}`);
    return null;
  }
}

/**
 * Finds tool call patterns in text with regexes for different formats
 * @param text The text to check for tool calls
 * @returns An array of matches by format type
 */
export function findToolCallPatterns(
  text: string,
): Array<{ type: ToolCallFormatType; match: RegExpExecArray }> {
  const match = new RegExp(TOOL_CALL_PATTERN, "s").exec(text);
  return match ? [{ type: ToolCallFormatType.NON_FENCED, match }] : [];
}

/**
 * Finds every complete tool call in a finished assistant block, in order.
 *
 * This shares TOOL_CALL_PATTERN with the streaming detector and parseToolCall, so
 * a call that is collected here is always a call the parser accepts. Divergence
 * here would break the positional matching of tool calls to tool_execute blocks.
 */
export function findAllToolCalls(text: string): string[] {
  return Array.from(
    text.matchAll(new RegExp(TOOL_CALL_PATTERN, "gs")),
    (match) => match[0],
  );
}

/**
 * Checks if text contains a complete tool call
 * Handles CDATA sections in parameters
 * @param text The text to check for completed tool calls
 * @returns A result indicating if a complete tool call was found and its position, and optionally the tool name
 */
export function checkForCompletedToolCall(text: string): ToolCallCheckResult | { isComplete: true; endIndex: number; toolName: string } {
  // Log for debugging
  log(`Checking for completed tool call in text of length ${text.length}`);

  // First preprocess the text to handle CDATA sections
  // This ensures that XML-like content in CDATA sections doesn't interfere with tag matching
  const preprocessedText = preprocessCdataForMatching(text);

  // Find all potential tool call patterns in the preprocessed text
  const patterns = findToolCallPatterns(preprocessedText);

  // If no patterns found, return not complete
  if (patterns.length === 0) {
    return { isComplete: false };
  }

  // Sort patterns by their position in the text
  patterns.sort((a, b) => a.match.index - b.match.index);

  // Take the first (earliest) pattern
  const firstPattern = patterns[0];
  const { type, match } = firstPattern;

  // Get the full match and its end position
  const fullMatch = match[0];
  const matchEndIndex = match.index + fullMatch.length;

  // Now check the original text for completeness
  // Map the match to the original text
  const originalTextPortion = text.substring(0, matchEndIndex);

  // Enhanced check for balanced CDATA tags using our improved character-by-character checker
  if (!areCdataTagsBalanced(originalTextPortion)) {
    log(`Tool call has unbalanced CDATA tags, not considering it complete`);
    return { isComplete: false };
  }

  // Check for complete parameters with balanced CDATA using the improved checker
  if (!areParamsComplete(originalTextPortion)) {
    log(
      `Tool call has incomplete parameter sections, not considering it complete`,
    );
    return { isComplete: false };
  }

  // Extract the tool name from the completed tool call
  const toolNameMatch = /<cmd:tool_name>\s*(.*?)\s*<\/cmd:tool_name>/s.exec(originalTextPortion);
  const toolName = toolNameMatch ? toolNameMatch[1].trim() : '';

  // Log the finding
  log(
    `Found completed tool call (${type}) for tool "${toolName}": "${fullMatch.substring(0, 50)}${fullMatch.length > 50 ? "..." : ""}"`,
  );
  log("Stopping streaming at completed tool call");

  return { isComplete: true, endIndex: matchEndIndex, toolName };
}
