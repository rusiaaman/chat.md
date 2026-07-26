import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";
import { ChatHistoryFile, ChatHistoryUsage, MessageParam } from "../types";

/**
 * Resolves file paths that may be relative to the current document.
 */
export function resolveFilePath(
  filePath: string,
  document: vscode.TextDocument,
): string {
  if (filePath.startsWith("~")) {
    return filePath.replace(/^~/, process.env.HOME || "");
  }
  if (path.isAbsolute(filePath)) {
    return filePath;
  }
  return path.resolve(path.dirname(document.uri.fsPath), filePath);
}

export function fileExists(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export function readFileAsBuffer(filePath: string): Buffer | undefined {
  try {
    return fs.readFileSync(filePath);
  } catch (error) {
    console.error(`Error reading file ${filePath}:`, error);
    return undefined;
  }
}

export function readFileAsText(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    console.error(`Error reading file ${filePath}:`, error);
    return undefined;
  }
}

export function isImageFile(filePath: string): boolean {
  return [".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(
    path.extname(filePath).toLowerCase(),
  );
}

export function ensureDirectoryExists(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  } else if (!fs.statSync(dirPath).isDirectory()) {
    throw new Error(`Path exists but is not a directory: ${dirPath}`);
  }
}

export function writeFile(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, "utf8");
}

/**
 * Returns the configured asset directory. Relative paths are resolved against
 * the chat document directory; absolute paths are used as-is.
 */
export function getAssetsDirectory(docDir: string): string {
  const configured = vscode.workspace
    .getConfiguration("chatmd")
    .get<string>("assetsPath", "cmdassets");
  if (configured.startsWith("~")) {
    return path.resolve(configured.replace(/^~/, process.env.HOME || ""));
  }
  return path.isAbsolute(configured)
    ? configured
    : path.resolve(docDir, configured);
}

export function getAssetsRelativePath(docDir: string, fileName: string): string {
  return path
    .relative(docDir, path.join(getAssetsDirectory(docDir), fileName))
    .replace(/\\/g, "/");
}

function getChatMdCacheDirectory(): string {
  const cacheRoot =
    process.env.XDG_CACHE_HOME ||
    path.join(process.env.HOME || process.cwd(), ".cache");
  return path.join(cacheRoot, "chat.md");
}

function createHistoryFileName(document: vscode.TextDocument): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const baseName = path
    .basename(document.fileName)
    .replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${baseName}-${timestamp}-${Math.random().toString(36).slice(2, 8)}.json`;
}

export function saveChatHistory(
  document: vscode.TextDocument,
  messages: readonly MessageParam[],
  _action: string,
  systemPrompt = "",
  metadata: Record<string, unknown> = {},
): string {
  try {
    const historyDir = getChatMdCacheDirectory();
    ensureDirectoryExists(historyDir);
    const filePath = path.join(historyDir, createHistoryFileName(document));
    const history: ChatHistoryFile = {
      system: systemPrompt,
      history: [...messages],
      usage: null,
      cost: null,
      metadata: {
        document: document.uri.fsPath,
        createdAt: new Date().toISOString(),
        ...metadata,
      },
    };
    writeFile(filePath, JSON.stringify(history, null, 2) + "\n");
    return filePath;
  } catch (error) {
    console.error("Error saving chat history:", error);
    return "";
  }
}

export function appendToChatHistory(
  historyFilePath: string,
  content: string,
): void {
  updateChatHistory(historyFilePath, (history) => {
    const lastMessage = history.history[history.history.length - 1];
    if (lastMessage?.role === "assistant") {
      const text = lastMessage.content.find((item) => item.type === "text");
      if (text && text.type === "text") {
        text.value += content;
      } else {
        lastMessage.content.push({ type: "text", value: content });
      }
    } else {
      history.history.push({
        role: "assistant",
        content: [{ type: "text", value: content }],
      });
    }
  });
}

export function updateChatHistory(
  historyFilePath: string,
  update: (history: ChatHistoryFile) => void,
): void {
  try {
    if (!historyFilePath || !fileExists(historyFilePath)) return;
    const parsed = JSON.parse(readFileAsText(historyFilePath) || "") as ChatHistoryFile;
    update(parsed);
    writeFile(historyFilePath, JSON.stringify(parsed, null, 2) + "\n");
  } catch (error) {
    console.error("Error updating chat history:", error);
  }
}

export function updateChatHistoryUsage(
  historyFilePath: string,
  usage: ChatHistoryUsage | undefined,
): void {
  if (!usage) return;
  updateChatHistory(historyFilePath, (history) => {
    history.usage = usage;
    history.metadata.completedAt = new Date().toISOString();
  });
}

export function getMcpServerLogPath(
  logBasePath: string,
  serverId: string,
): string {
  return path.join(logBasePath, `${serverId}.log`);
}