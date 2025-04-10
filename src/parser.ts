import { MessageParam, Content, Role } from "./types";
import { log } from "./extension";
import * as vscode from "vscode"; // Ensure vscode is imported
import {
  isImageFile,
  resolveFilePath,
  // readFileAsText, // No longer reading file content directly here for system block check
  fileExists,
  readFileAsText, // Keep readFileAsText as it's used in parseUserContent
} from "./utils/fileUtils";
// import * as vscode from "vscode"; // Already imported

/**
 * Contains the parsed messages and any aggregated system prompt.
 */
export interface ParsedDocumentResult {
  messages: readonly MessageParam[];
  systemPrompt: string;
  hasImageInSystemBlock: boolean;
}

/**
 * Parses a .chat.md file into structured messages and extracts system prompts.
 * Returns an object containing messages, system prompt, and image detection flag.
 *
 * Note: Will exclude the last empty assistant or tool_execute block (used for triggering actions)
 */
export function parseDocument(
  text: string,
  document?: vscode.TextDocument,
): ParsedDocumentResult {
  const messages: MessageParam[] = [];
  let systemPromptParts: string[] = [];
  let hasImageInSystemBlock = false;

  // Regex to split document on # %% markers, now including 'system'
  const regex = /^# %% (user|assistant|system|tool_execute)\s*$/im;
  const blocks = text.split(regex);

  // Debug logging
  log(`Split document into ${blocks.length} blocks`);
  for (let i = 0; i < Math.min(blocks.length, 10); i++) {
    // Minimal logging for brevity
    // log(
    //   `Block ${i}: "${blocks[i].substring(0, 20).replace(/\n/g, "\\n")}${blocks[i].length > 20 ? "..." : ""}"`,
    // );
  }

  // Skip first empty element if exists
  let startIdx = blocks[0].trim() === "" ? 1 : 0;

  // Check if the last block is an empty assistant or tool_execute block
  const lastRoleIndex = blocks.length - 2;
  const lastRole = lastRoleIndex >= 0 ? blocks[lastRoleIndex].toLowerCase().trim() : null;
  const lastContent = blocks.length > lastRoleIndex + 1 ? blocks[lastRoleIndex + 1].trim() : null;

  const hasEmptyLastAssistant =
    lastRole === "assistant" && lastContent === "";
  const hasEmptyLastToolExecute =
    lastRole === "tool_execute" && lastContent === "";

  // Determine endpoint for parsing (exclude empty last assistant or tool_execute block)
  const endIdx = (hasEmptyLastAssistant || hasEmptyLastToolExecute) ? blocks.length - 2 : blocks.length;

  for (let i = startIdx; i < endIdx; i += 2) {
    // If we have a role but no content block, skip (should not happen with split)
    if (i + 1 >= endIdx) {
      log(`Warning: Found role block '${blocks[i]}' without subsequent content block at index ${i}.`);
      break;
    }

    const role = blocks[i].toLowerCase().trim();
    const rawContent = blocks[i + 1]; // Keep original whitespace/newlines for system prompt
    const content = rawContent.trim();

    // Empty assistant/tool_execute blocks are handled by the endIdx logic above,
    // so no need to explicitly skip them here.
    // Detect system block
    if (role === "system") {
      if (content) { // Only add non-empty system blocks
        systemPromptParts.push(rawContent); // Add raw content including original formatting
        // Check for images within this system block only if we haven't found one yet
        if (!hasImageInSystemBlock && document && containsImageReference(content, document)) {
          hasImageInSystemBlock = true;
          log(`Image reference detected in system block starting with: "${content.substring(0, 50)}..."`);
        }
      }
    }
    // Detect tool_execute block (these contain results from tools)
    else if (role === "tool_execute") {
      // Tool execute blocks (results) are treated as user messages for history context
      if (content) {
        // Process tool_execute blocks to potentially inline file content from links
        const processedContent = processToolResultContent(content, document);
        messages.push({
          role: "user", // Represent tool result as user message for context
          content: [{ type: "text", value: processedContent }],
        });
      }
      // Empty tool_execute blocks are ignored here (handled by endIdx check)
    }
    // Detect user block
    else if (role === "user") {
      const parsedContent = parseUserContent(content, document);
      // Only add user message if it results in non-empty content after parsing
      // Check if there's any non-whitespace text or an image
      if (parsedContent.some(c => (c.type === 'text' && c.value.trim() !== '') || c.type === 'image')) {
        messages.push({
          role: "user",
          content: parsedContent,
        });
      } else {
        log("Skipping user block as it resulted in empty content after parsing.");
      }
    }
    // Detect assistant block
    else if (role === "assistant") {
       // Only add assistant message if it has actual content
       if (content) {
         messages.push({
           role: "assistant",
           content: [{ type: "text", value: content }], // Assistant content is treated as plain text for now
         });
       } else {
         log("Skipping empty assistant block (non-triggering).");
       }
    }
  }

  // Combine system prompts separated by newline
  const finalSystemPrompt = systemPromptParts.join("\n").trim();

  log(`Parsed document. Messages: ${messages.length}, System Prompt Length: ${finalSystemPrompt.length}, Has Image in System: ${hasImageInSystemBlock}`);

  return Object.freeze({
    messages: Object.freeze(messages),
    systemPrompt: finalSystemPrompt,
    hasImageInSystemBlock: hasImageInSystemBlock,
  });
}


/**
 * Checks if the given text content contains any image references (markdown or attached file syntax).
 * This is used specifically for system blocks where images are not allowed.
 */
function containsImageReference(text: string, document: vscode.TextDocument): boolean {
  // Regex for markdown image links or links ending with common image extensions
  const markdownLinkRegex = /\[[^\]]*\]\(([^)]+(\.(png|jpg|jpeg|gif|webp|bmp)))\)/gi;
  // Regex for "Attached file at" syntax pointing to an image file
  const attachedFileRegex = /Attached file at\s+([^\n]+(\.(png|jpg|jpeg|gif|webp|bmp)))/gi;

  let match;

  // Check markdown links
  if (markdownLinkRegex.test(text)) {
      log("Found markdown link possibly pointing to an image in system block.");
      return true; // Found a potential image markdown link
  }

  // Check "Attached file at" syntax
   if (attachedFileRegex.test(text)) {
       log("Found 'Attached file at' possibly pointing to an image in system block.");
       return true; // Found potential attached image file syntax
   }

  // More robust check: Iterate through matches and try resolving paths if needed
  // This part can be added if simple regex is not enough, but adds complexity.
  // For now, the regex check is sufficient to flag potential issues.

  return false;
}


/**
 * Determines the type of the block the cursor is currently in.
 * Iterates backwards from the cursor position to find the most recent block marker (including system (including system).
 */
export function getBlockInfoAtPosition(
  document: vscode.TextDocument,
  position: vscode.Position,
): {
  type: "user" | "assistant" | "system" | "tool_execute" | null; // Added 'system'
  blockStartPosition: vscode.Position | null;
} {
  // Updated regex to include 'system'
  const blockMarkerRegex = /^# %% (user|assistant|system|tool_execute)\s*$/i;

  for (let lineNum = position.line; lineNum >= 0; lineNum--) {
    const line = document.lineAt(lineNum);
    const match = line.text.match(blockMarkerRegex);

    if (match) {
      // Ensure the matched type is one of the allowed roles
      const blockType = match[1].toLowerCase() as
        | "user"
        | "assistant"
        | "system"
        | "tool_execute";
      const blockStartPosition = new vscode.Position(lineNum, 0);
      log(
        `Found block marker '${match[0]}' (type: ${blockType}) at line ${lineNum} for position ${position.line}`,
      );
      return { type: blockType, blockStartPosition };
    }

  }

  // If no marker was found before the cursor position
  log(`No block marker found before line ${position.line}`);
  return { type: null, blockStartPosition: null };
}

/**
 * Parses user content to extract text and resolve file references (both markdown and attached).
 * Handles both relative and absolute paths, including tilde (~).
 */
function parseUserContent(text: string, document?: vscode.TextDocument): Content[] {
  if (!document) {
    log("parseUserContent called without document context, returning raw text.");
    return [{ type: "text", value: text }];
  }

  const content: Content[] = [];
  let currentIndex = 0; // Track position in the original text

  // Regexes need to be slightly adjusted to capture correctly
  // Match markdown links: Capture link text and path. Prioritize [#file] syntax.
  // Pattern: Optional whitespace, '[', capture link text (non-greedy), ']', '(', capture path (non-greedy), ')', optional whitespace
  const markdownLinkRegex = /\s*\[(.*?)\]\((.*?)\)\s*/g;

  // Match "Attached file at": Capture path. Handle potential code blocks after.
  // Pattern: 'Attached file at', whitespace, capture path (non-greedy until newline or end), optionally match newline and code block
  const attachedFileRegex = /Attached file at\s+([^\n]+)(?:\n```[\s\S]*?\n```)?/g;


  interface FileRef {
    path: string;
    isImage: boolean;
    fullMatch: string;
    startIndex: number;
    endIndex: number; // Add end index
    type: 'markdown' | 'attached';
  } // <--- Added missing closing brace
  const fileRefs: FileRef[] = [];

  // 1. Find all potential file references and store their details
  let match;
  while ((match = markdownLinkRegex.exec(text)) !== null) {
    const linkText = match[1];
    const filePath = match[2];
    // Heuristic: Treat as file if linkText is '#file' or path has common extension
    // This might capture non-file links, but resolving path confirms later.
    const isLikelyFile = linkText.toLowerCase() === '#file' || /\.\w{2,5}$/.test(filePath);
    if (isLikelyFile) {
      fileRefs.push({
        path: filePath,
        isImage: isImageFile(filePath), // Check based on extension
        fullMatch: match[0],
        startIndex: match.index,
        endIndex: match.index + match[0].length,
        type: 'markdown'
      });
    }
  }
  // Reset regex lastIndex before using the next one
  attachedFileRegex.lastIndex = 0;
  while ((match = attachedFileRegex.exec(text)) !== null) {
     const filePath = match[1].trim();
     fileRefs.push({
       path: filePath,
       isImage: isImageFile(filePath),
       fullMatch: match[0],
       startIndex: match.index,
       endIndex: match.index + match[0].length,
       type: 'attached'
     });
  }

  // 2. Sort references by start index to process in order
  fileRefs.sort((a, b) => a.startIndex - b.startIndex);

  // 3. Iterate through sorted references, adding text segments and resolved file content
  for (const ref of fileRefs) {
    // Add text segment occurring *before* this file reference
    if (ref.startIndex > currentIndex) {
      const textSegment = text.substring(currentIndex, ref.startIndex);
      if (textSegment.trim()) { // Avoid adding empty/whitespace-only segments
        content.push({ type: "text", value: textSegment });
      }
    }

    // Process the file reference itself
    try {
      const resolvedPath = resolveFilePath(ref.path, document); // Resolve path (handles ~)
      if (fileExists(resolvedPath)) {
        if (ref.isImage) {
          // For images, add an image block using the *original* path provided by the user
          content.push({ type: "image", path: ref.path });
          log(`Added image reference: ${ref.path} (resolved: ${resolvedPath})`);
        } else {
          // For text files, read content and add a text block
          const fileContent = readFileAsText(resolvedPath);
          // Use a clear format to indicate embedded file content
          content.push({
            type: "text",
            value: `Attached file: ${ref.path}\n\`\`\`\n${fileContent}\n\`\`\``,
          });
          log(`Added text file content from: ${ref.path} (resolved: ${resolvedPath})`);
        }
      } else {
        // File not found, add placeholder text
        content.push({ type: "text", value: `[File not found: ${ref.path}]` });
        log(`File reference not found: ${ref.path} (resolved: ${resolvedPath})`);
      }
    } catch (error) {
      // Error during path resolution or file reading
      content.push({ type: "text", value: `[Error processing file: ${ref.path} - ${error}]` });
      log(`Error processing file reference ${ref.path}: ${error}`);
    }

    // Update current index to the end of the matched reference
    currentIndex = ref.endIndex;
  }

  // 4. Add any remaining text after the last file reference
  if (currentIndex < text.length) {
    const remainingText = text.substring(currentIndex);
    if (remainingText.trim()) {
      content.push({ type: "text", value: remainingText });
    }
  }

  // If no content was generated (e.g., user block only contained unresolvable files),
  // return a single empty text block to represent the turn but avoid errors downstream.
  // Note: The main parseDocument function already filters out fully empty user messages.
  // if (content.length === 0) {
  //     log("parseUserContent resulted in zero content blocks.");
  //     // Optionally return [{ type: "text", value: "" }] if needed, but usually handled by caller
  // }


  return content; // Return the array of Content blocks
}

/**
 * Checks if a document ends with an empty block of the specified type ('assistant' or 'tool_execute').
 * An empty block means the marker line is present, followed by optional whitespace,
 * an optional newline, and then only whitespace until the end of the document.
 */
function hasEmptyBlockOfType(text: string, type: "assistant" | "tool_execute"): boolean {
    const marker = `# %% ${type}`;
    const lastMarkerIndex = text.lastIndexOf(marker);

    // If the marker doesn't exist, it can't be the last block
    if (lastMarkerIndex === -1) {
        // log(`No '${marker}' found in the document.`);
        return false;
    }

    // Extract the text *after* the marker line itself
    // Find the newline after the marker
    const newlineAfterMarker = text.indexOf('\n', lastMarkerIndex);
    const contentStartIndex = newlineAfterMarker === -1
        ? lastMarkerIndex + marker.length // Marker is the last line
        : newlineAfterMarker + 1; // Start looking after the newline

    const contentAfterMarker = text.substring(contentStartIndex);

    // Check if the content after the marker line consists *only* of whitespace
    if (/^\s*$/.test(contentAfterMarker)) {
        log(`Found empty ${type} block at the end of the document.`);
        return true;
    }

    // log(`Found ${type} block, but it's not empty or not at the end.`);
    return false;
}

/**
 * Checks if a document ends with an empty assistant block.
 * Used to determine when to start streaming.
 */
export function hasEmptyAssistantBlock(text: string): boolean {
  return hasEmptyBlockOfType(text, "assistant");
}

/**
 * Checks if a document ends with an empty tool_execute block.
 * Used to determine when to execute a tool.
 */
export function hasEmptyToolExecuteBlock(text: string): boolean {
  return hasEmptyBlockOfType(text, "tool_execute");
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
