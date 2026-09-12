import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";
import { ChatHistoryFile, ChatHistoryUsage, MessageParam } from "../types";

export const TOOL_RESULT_LINE_THRESHOLD = 30;

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

/**
 * Attachment contents keyed by path, valid only while mtime and size are unchanged.
 *
 * Parsing a document inlines every attached file, and a long chat re-attaches the
 * same handful of files in turn after turn, so a parse of a 4M character chat was
 * doing thousands of reads of a few distinct files. A stat is two orders of
 * magnitude cheaper than the read and still notices an edit from outside VS Code.
 */
const textCache = new Map<
  string,
  { mtimeMs: number; size: number; content: string }
>();

/** Total cached bytes, so a chat full of large attachments cannot grow unbounded. */
let textCacheBytes = 0;
const TEXT_CACHE_MAX_BYTES = 32 * 1024 * 1024;

/** A file larger than this is never cached: one of them would evict everything else. */
const TEXT_CACHE_MAX_FILE_BYTES = 4 * 1024 * 1024;

function evictOldestUntilUnder(limit: number): void {
  // Map iterates in insertion order, and a cache hit re-inserts, so the front is
  // the least recently used.
  for (const [key, entry] of textCache) {
    if (textCacheBytes <= limit) {
      return;
    }
    textCache.delete(key);
    textCacheBytes -= entry.content.length;
  }
}

/**
 * Reads a text file, reusing the last read when the file has not changed.
 *
 * Use this for content that is read repeatedly and only displayed or sent onward.
 * Anything that must observe a write it just made should call readFileAsText.
 */
export function readFileAsTextCached(filePath: string): string | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return readFileAsText(filePath);
  }

  const cached = textCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    // Re-insert so this entry moves to the back of the LRU order.
    textCache.delete(filePath);
    textCache.set(filePath, cached);
    return cached.content;
  }

  const content = readFileAsText(filePath);
  if (content === undefined) {
    return undefined;
  }

  if (cached) {
    textCache.delete(filePath);
    textCacheBytes -= cached.content.length;
  }
  if (content.length <= TEXT_CACHE_MAX_FILE_BYTES) {
    textCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, content });
    textCacheBytes += content.length;
    evictOldestUntilUnder(TEXT_CACHE_MAX_BYTES);
  }
  return content;
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

export function writeToolResultAttachment(
  docDir: string,
  content: string,
  extension: ".md" | ".txt",
): string {
  const assetsDir = getAssetsDirectory(docDir);
  ensureDirectoryExists(assetsDir);
  const timestamp = new Date()
    .toISOString()
    .replace(/:/g, "")
    .replace(/-/g, "")
    .replace("T", "-")
    .replace(/\..+Z/, "");
  const randomString = Math.random().toString(36).substring(2, 8);
  const filename = `tool-result-${timestamp}-${randomString}${extension}`;
  writeFile(path.join(assetsDir, filename), content);
  return getAssetsRelativePath(docDir, filename);
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

/**
 * In-flight write for each history file, so writes to one file stay ordered.
 *
 * History is diagnostics: nothing in the chat waits on it, but a later update
 * (token usage, appended text) has to land on top of the save that preceded it.
 * A per-path promise chain gives that ordering without making any caller async.
 */
const historyWrites = new Map<string, Promise<void>>();

function queueHistoryWrite(filePath: string, work: () => Promise<void>): void {
  const previous = historyWrites.get(filePath) ?? Promise.resolve();
  const next = previous
    // A macrotask before the work: the payload of a long chat is tens of
    // megabytes, and serializing it is the one part that still blocks. Yielding
    // first keeps it from landing between building an API request and sending it.
    .then(() => new Promise<void>((resolve) => setImmediate(resolve)))
    .then(work)
    .catch((error) => {
      console.error(`Error writing chat history ${filePath}:`, error);
    });
  historyWrites.set(filePath, next);
  void next.then(() => {
    if (historyWrites.get(filePath) === next) {
      historyWrites.delete(filePath);
    }
  });
}

/** Waits for every queued history write. Called on deactivate. */
export async function flushChatHistoryWrites(): Promise<void> {
  await Promise.all(Array.from(historyWrites.values()));
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
    // The path is returned now and the bytes are written later. Callers only ever
    // use the path to address subsequent updates, which queue behind this write.
    queueHistoryWrite(filePath, () =>
      fs.promises.writeFile(filePath, JSON.stringify(history, null, 2) + "\n", "utf8"),
    );
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
  if (!historyFilePath) return;
  // Queued rather than done here, so it runs after the save that created the file.
  // The old version tested fileExists and gave up if the file was not there yet,
  // which is exactly what an in-flight save looks like.
  queueHistoryWrite(historyFilePath, async () => {
    try {
      const raw = await fs.promises.readFile(historyFilePath, "utf8");
      const parsed = JSON.parse(raw) as ChatHistoryFile;
      update(parsed);
      await fs.promises.writeFile(
        historyFilePath,
        JSON.stringify(parsed, null, 2) + "\n",
        "utf8",
      );
    } catch (error) {
      console.error("Error updating chat history:", error);
    }
  });
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
