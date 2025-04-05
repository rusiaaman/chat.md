import { MessageParam, Content, Role } from "./types";
import { log } from "./extension";
import {
  isImageFile,
  resolveFilePath,
  readFileAsText,
  fileExists,
} from "./utils/fileUtils";
import * as vscode from "vscode";

/**
 * Parses a .chat.md file into structured messages
 * Returns a readonly array to prevent mutations
 *
 * Note: Will exclude the last empty assistant block (used for triggering streaming)
 */
export function parseDocument(
  text: string,
  document?: vscode.TextDocument,
): readonly MessageParam[] {
  const messages: MessageParam[] = [];

  // Regex to split document on # %% markers - fixing the pattern to properly match all cases
  // We need to keep the original pattern that works, not the modified one that's causing issues
  const regex = /^# %% (user|assistant|tool_execute)\s*$/im;
  const blocks = text.split(regex);

  // Debug logging
  log(`Split document into ${blocks.length} blocks`);
  for (let i = 0; i < Math.min(blocks.length, 10); i++) {
    log(
      `Block ${i}: "${blocks[i].substring(0, 20).replace(/\n/g, "\\n")}${blocks[i].length > 20 ? "..." : ""}"`,
    );
  }

  // Skip first empty element if exists
  let startIdx = blocks[0].trim() === "" ? 1 : 0;

  // Check if the last block is an empty assistant block
  const hasEmptyLastAssistant =
    blocks.length >= startIdx + 2 &&
    blocks[blocks.length - 2].toLowerCase().trim() === "assistant" &&
    blocks[blocks.length - 1].trim() === "";

  // Determine endpoint for parsing (exclude empty last assistant block)
  const endIdx = hasEmptyLastAssistant ? blocks.length - 2 : blocks.length;

  for (let i = startIdx; i < endIdx; i += 2) {
    // If we have a role but no content block, skip
    if (i + 1 >= endIdx) {
      break;
    }

    const role = blocks[i].toLowerCase().trim();
    const content = blocks[i + 1].trim();

    // Skip empty assistant blocks entirely (they're just triggers)
    if (role === "assistant" && content === "") {
      continue;
    }

    // Detect if this is a tool_execute block
    if (role === "tool_execute") {
      // Tool execute blocks are treated as user messages
      if (content) {
        // Process tool_execute blocks that contain tool results
        const processedContent = processToolResultContent(content, document);
        messages.push({
          role: "user",
          content: [{ type: "text", value: processedContent }],
        });
      }
      // Skip this block in normal processing
      continue;
    }

    if (role === ("user" as Role)) {
      // Only add user message if it has actual content
      const parsedContent = parseUserContent(content, document);
      if (parsedContent.length > 0) {
        messages.push({
          role,
          content: parsedContent,
        });
      }
    } else if (role === "assistant") {
      messages.push({
        role,
        content: [{ type: "text", value: content }],
      });
    }
  }

  return Object.freeze(messages);
}

/**
 * Determines the type of the block the cursor is currently in.
 * Iterates backwards from the cursor position to find the most recent block marker.
 */
export function getBlockInfoAtPosition(
  document: vscode.TextDocument,
  position: vscode.Position,
): {
  type: "user" | "assistant" | "tool_execute" | null;
  blockStartPosition: vscode.Position | null;
} {
  const blockMarkerRegex = /^# %% (user|assistant|tool_execute)\s*$/i;

  for (let lineNum = position.line; lineNum >= 0; lineNum--) {
    const line = document.lineAt(lineNum);
    const match = line.text.match(blockMarkerRegex);

    if (match) {
      const blockType = match[1].toLowerCase() as
        | "user"
        | "assistant"
        | "tool_execute";
      const blockStartPosition = new vscode.Position(lineNum, 0);
      log(
        `Found block marker '${match[0]}' at line ${lineNum} for position ${position.line}`,
      );
      return { type: blockType, blockStartPosition };
    }
  }

  // If no marker was found before the cursor position
  log(`No block marker found before line ${position.line}`);
  return { type: null, blockStartPosition: null };
}

/**
 * Parses user content to extract text and file references
 */
function parseUserContent(
  text: string,
  document?: vscode.TextDocument,
): Content[] {
  const content: Content[] = [];

  // Only use Markdown-style links for file attachments
  const markdownLinkRegex = /\[([^\]]*)\]\(([^)]+)\)/g;
  const fileAttachments: Array<{
    path: string;
    isImage: boolean;
    content?: string;
  }> = [];

  // First pass - identify all file references in markdown links
  if (document) {
    let mdMatch;
    // Collect all file references from markdown links
    while ((mdMatch = markdownLinkRegex.exec(text)) !== null) {
      const filePath = mdMatch[2];
      const resolvedPath = resolveFilePath(filePath, document);
      const isImage = isImageFile(filePath);

      // For text files, read the content
      let fileContent;
      if (!isImage && fileExists(resolvedPath)) {
        fileContent = readFileAsText(resolvedPath);
      }

      // Store file information for processing
      fileAttachments.push({
        path: filePath,
        isImage,
        content: !isImage ? fileContent : undefined,
      });

      log(`Added file reference: ${filePath} (${isImage ? "image" : "text"})`);
    }
  }

  // Process each file attachment directly, rather than relying on regex matching of "Attached file at" text
  for (const attachment of fileAttachments) {
    if (attachment.isImage) {
      // Add image file as an image content type
      content.push({ type: "image", path: attachment.path });
      log(`Added image content: ${attachment.path}`);
    } else {
      // Add text file as text content - with format matching exactly what's expected
      if (attachment.content) {
        // Add introduction text for the file - without any extra characters
        content.push({
          type: "text",
          value: `Attached file at ${attachment.path}\n\`\`\`\n${attachment.content}\n\`\`\``,
        });
        log(`Added text file content: ${attachment.path}`);
      } else {
        content.push({
          type: "text",
          value: `Attached file at ${attachment.path}\n\`\`\`\nUnable to read file content\n\`\`\``,
        });
        log(`Added placeholder for unreadable file: ${attachment.path}`);
      }
    }
  }

  // Add the original text (without processing "Attached file at" syntax)
  if (text.trim()) {
    content.push({ type: "text", value: text });
    log(`Added original text content (${text.length} chars)`);
  }

  return content;
}

/**
 * Checks if a document ends with an empty assistant block
 * Used to determine when to start streaming
 */
export function hasEmptyAssistantBlock(text: string): boolean {
  // Log the exact document text for debugging (truncated)
  const displayText =
    text.length > 100 ? text.substring(text.length - 100) : text;
  log(
    `Checking for empty assistant block in: "${displayText.replace(/\n/g, "\\n")}"`,
  );

  // Check if the document ends with a pattern that should trigger streaming
  // Specifically, we want "# %% assistant" followed by a newline and optional whitespace at the end
  const lastAssistantIndex = text.lastIndexOf("# %% assistant");

  // If no assistant block found or it's not near the end, return false
  if (lastAssistantIndex === -1 || lastAssistantIndex < text.length - 30) {
    log("No assistant block found near the end of the document");
    return false;
  }

  // Check if there's a newline after "# %% assistant"
  const textAfterMarker = text.substring(lastAssistantIndex + 14); // Length of '# %% assistant'

  // First, check for at least one newline
  if (!textAfterMarker.includes("\n")) {
    log('No newline after "# %% assistant", not triggering streaming');
    return false;
  }

  // Now check if there's only whitespace after the newline
  const hasContentAfterNewline = /\n\s*[^\s]/.test(textAfterMarker);

  if (hasContentAfterNewline) {
    log("Found content after newline, not an empty assistant block");
    return false;
  }

  // If we got here, we have "# %% assistant" followed by a newline and only whitespace after that
  log("Found empty assistant block with newline, triggering streaming");
  return true;
}

/**
 * Checks if a document has an empty tool_execute block
 * Used to determine when to execute a tool
 */
export function hasEmptyToolExecuteBlock(text: string): boolean {
  // Log document suffix for debugging
  const displayText =
    text.length > 100 ? text.substring(text.length - 100) : text;
  log(
    `Checking for empty tool_execute block in: "${displayText.replace(/\n/g, "\\n")}"`,
  );

  // More precise approach: find all tool_execute blocks and check if any are empty
  // Look for blocks that are either at the end of the document or followed by another block
  const blockMatches = [];
  const regex = /# %% tool_execute\s*([\s\S]*?)(?=\n# %%|$)/gm;
  let match;

  while ((match = regex.exec(text)) !== null) {
    const blockContent = match[1].trim();
    const position = match.index;
    blockMatches.push({ position, content: blockContent });

    log(
      `Found tool_execute block at ${position}: content=${blockContent ? "non-empty" : "empty"}`,
    );
  }

  // Check if we found any empty blocks
  const emptyBlocks = blockMatches.filter((block) => block.content === "");

  if (emptyBlocks.length > 0) {
    log(
      `Found ${emptyBlocks.length} empty tool_execute block(s), will trigger tool execution`,
    );
    return true;
  }

  return false;
}

/**
 * Gets all assistant block positions in a document
 * Used to find where to place streamed content
 */
export function findAssistantBlocks(
  text: string,
): { start: number; end: number }[] {
  const blocks: { start: number; end: number }[] = [];
  const regex = /^# %% assistant\s*$/im;

  let match;
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) {
      // Found an assistant block
      const start = lines.slice(0, i).join("\n").length + (i > 0 ? 1 : 0); // Add newline except for first line
      const end = start + lines[i].length;
      blocks.push({ start, end });
    }
  }

  return blocks;
}

/**
 * Process tool result content - replacing markdown links with file content when appropriate
 * Specifically for <tool_result> blocks containing a single markdown link
 */
function processToolResultContent(
  content: string,
  document?: vscode.TextDocument,
): string {
  if (!document) {
    return content; // Can't resolve paths without document context
  }

  // Check if this is a tool result block
  const toolResultMatch = content.match(
    /<tool_result>([\s\S]*?)<\/tool_result>/,
  );
  if (!toolResultMatch) {
    return content; // Not a tool result block
  }

  const toolResultContent = toolResultMatch[1].trim();

  // Look for a markdown link as the ONLY content inside the tool result tags
  // First strip code fences if present
  const withoutCodeFences = toolResultContent.replace(
    /^```[\s\S]*?```$/g,
    (match) => {
      // Extract content from within code fences
      const fenceMatch = match.match(/```(?:.*?)?\n([\s\S]*?)\n```/);
      return fenceMatch ? fenceMatch[1].trim() : match;
    },
  );

  // Check if we have a single markdown link
  const linkOnlyContent = withoutCodeFences.trim();
  const linkMatch = linkOnlyContent.match(/^\[([^\]]+)\]\(([^)]+)\)$/);

  if (!linkMatch) {
    return content; // Not a single markdown link or other content exists
  }

  const linkText = linkMatch[1];
  const linkTarget = linkMatch[2];

  // Only process "Tool Result" links which are our auto-generated ones
  if (linkText !== "Tool Result") {
    return content;
  }

  log(`Found a tool result with single markdown link to: ${linkTarget}`);

  // Resolve the path and read the file
  const resolvedPath = resolveFilePath(linkTarget, document);

  if (!fileExists(resolvedPath)) {
    log(`File not found: ${resolvedPath}`);
    return content;
  }

  const fileContent = readFileAsText(resolvedPath);
  if (!fileContent) {
    log(`Could not read file: ${resolvedPath}`);
    return content;
  }

  log(`Successfully loaded content from tool result file: ${linkTarget}`);

  // Replace the markdown link with the actual content
  return content.replace(
    /<tool_result>[\s\S]*?<\/tool_result>/,
    `<tool_result>\n${fileContent}\n</tool_result>`,
  );
}

/**
 * Finds all assistant blocks with their content start positions
 * Used for more precise token insertion
 */
export function findAllAssistantBlocks(
  text: string,
): { markerStart: number; contentStart: number }[] {
  const blocks: { markerStart: number; contentStart: number }[] = [];
  const lines = text.split("\n");
  let lineOffset = 0;

  for (let i = 0; i < lines.length; i++) {
    if (/^# %% assistant\s*$/i.test(lines[i])) {
      // Found an assistant block
      const markerStart = lineOffset;

      // Calculate the content start (after the marker line)
      let contentStart = lineOffset + lines[i].length;

      // Skip any whitespace after the marker
      while (
        contentStart < text.length &&
        (text[contentStart] === " " || text[contentStart] === "\t")
      ) {
        contentStart++;
      }

      // Skip newline if present
      if (contentStart < text.length && text[contentStart] === "\n") {
        contentStart++;
      }

      blocks.push({ markerStart, contentStart });
    }

    lineOffset += lines[i].length + 1; // +1 for the newline
  }

  return blocks;
}
