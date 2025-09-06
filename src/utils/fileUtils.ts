import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";
import { MessageParam } from "../types";
import { getBatchedWriter } from "./batchedWriter";

/**
 * Resolves file paths that may be relative to the current document
 */
export function resolveFilePath(
  filePath: string,
  document: vscode.TextDocument,
): string {
  // If path starts with ~ replace with home dir
  if (filePath.startsWith("~")) {
    return filePath.replace(/^~/, process.env.HOME || "");
  }

  // If it's an absolute path, return as is
  if (path.isAbsolute(filePath)) {
    return filePath;
  }

  // Try to resolve relative to the document
  const documentDir = path.dirname(document.uri.fsPath);
  const resolvedPath = path.resolve(documentDir, filePath);

  return resolvedPath;
}

/**
 * Check if a file exists and is accessible
 */
export function fileExists(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read file as a buffer, handling errors gracefully
 * Returns undefined if file can't be read
 */
export function readFileAsBuffer(filePath: string): Buffer | undefined {
  try {
    return fs.readFileSync(filePath);
  } catch (error) {
    console.error(`Error reading file ${filePath}:`, error);
    return undefined;
  }
}

/**
 * Read text file content as string
 * Returns undefined if file can't be read
 */
export function readFileAsText(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    console.error(`Error reading file ${filePath}:`, error);
    return undefined;
  }
}

/**
 * Check if a file is an image based on extension
 */
export function isImageFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return [".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext);
}

/**
 * Ensure a directory exists, creating it if necessary
 */
export function ensureDirectoryExists(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    try {
      fs.mkdirSync(dirPath, { recursive: true });
    } catch (error) {
      console.error(`Error creating directory ${dirPath}:`, error);
      throw error; // Re-throw the error to indicate failure
    }
  } else if (!fs.statSync(dirPath).isDirectory()) {
    throw new Error(`Path exists but is not a directory: ${dirPath}`);
  }
}

/**
 * Write text content to a file
 * Throws error on failure
 */
export function writeFile(filePath: string, content: string): void {
  try {
    fs.writeFileSync(filePath, content, "utf8");
  } catch (error) {
    console.error(`Error writing file ${filePath}:`, error);
    throw error; // Re-throw the error
  }
}

/**
 * Save chat history to a file for debugging purposes
 * @param document The document containing the chat
 * @param messages The messages to be sent to the LLM
 * @param action The action being performed (e.g., "before_llm_call")
 * @param additionalContent Optional additional content to append to the file
 * @param systemPrompt Optional system prompt to include at the top
 */
export function saveChatHistory(
  document: vscode.TextDocument,
  messages: readonly MessageParam[],
  action: string,
  systemPrompt?: string, // Added systemPrompt parameter
  additionalContent?: string,
): string {
  try {
    // Create .cmd_history directory relative to the chat document
    const docDir = path.dirname(document.uri.fsPath);
    const historyDir = path.join(docDir, ".cmd_history");
    ensureDirectoryExists(historyDir);

    // Create a timestamp-based filename
    const timestamp = new Date()
      .toISOString()
      .replace(/:/g, "-")
      .replace(/\..+Z/, "");
    const filename = `history_${timestamp}_${action}.md`;
    const filePath = path.join(historyDir, filename);

    // Format messages into a readable markdown format
    let content = `# Chat History Debug Log\n\n`;
    content += `- **Timestamp:** ${new Date().toISOString()}\n`;
    content += `- **Action:** ${action}\n`;
    content += `- **Document:** ${document.fileName}\n\n`;

    // Add System Prompt if provided
    if (systemPrompt) {
      content += `## System Prompt\n\n\`\`\`\n${systemPrompt}\n\`\`\`\n\n`;
    }

    content += `## Messages\n\n`;
    messages.forEach((msg, index) => {
      content += `### ${index + 1}. ${msg.role.toUpperCase()}\n\n`;

      msg.content.forEach((item) => {
        if (item.type === "text") {
          content += `\`\`\`\n${item.value}\n\`\`\`\n\n`;
        } else if (item.type === "image") {
          content += `[Image: ${item.path}]\n\n`;
        }
      });
    });

    // Add additional content if provided
    if (additionalContent) {
      content += `## Additional Content\n\n\`\`\`\n${additionalContent}\n\`\`\`\n`;
    }

    // Write to file
    writeFile(filePath, content);

    return filePath;
  } catch (error) {
    console.error("Error saving chat history:", error);
    // Don't throw - we want this to be non-blocking
    return "";
  }
}

/**
 * Append content to an existing chat history file
 * @param historyFilePath Path to the history file
 * @param content Content to append
 */
export function appendToChatHistory(
  historyFilePath: string,
  content: string,
): void {
  try {
    if (!historyFilePath || !fileExists(historyFilePath)) {
      return;
    }

    // Use batched writer for better performance, especially for remote files
    const batchedWriter = getBatchedWriter(historyFilePath, {
      maxBatchSize: 5,        // Batch up to 5 token chunks
      maxBatchDelay: 500,     // Flush after 500ms if batch isn't full
      flushOnClose: true,     // Ensure remaining content is written when closing
    });

    // Add content to batch buffer
    batchedWriter.add(content);
  } catch (error) {
    console.error("Error appending to chat history:", error);
    // Don't throw - we want this to be non-blocking
  }
}

/**
 * Get the log file path for a specific MCP server
 * @param logBasePath The base path for MCP logs
 * @param serverId The ID of the MCP server
 * @returns The full path to the log file for the server
 */
export function getMcpServerLogPath(logBasePath: string, serverId: string): string {
  return path.join(logBasePath, `${serverId}.log`);
}
