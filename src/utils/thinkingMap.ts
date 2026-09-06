/**
 * Storage for provider reasoning payloads.
 *
 * The document only carries "qualified_model_name::hash8" at the end of a thinking
 * section; the payload itself (Anthropic signature, OpenAI encrypted content,
 * OpenRouter reasoning_details, ...) lives in cmdassets/thinking_map.json next to
 * the tool result assets, shared by every .chat.md file in that directory.
 *
 * Entries are never garbage collected, and a missing entry degrades gracefully:
 * the thinking section is then treated as display only raw text.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { ThinkingMapEntry, ThinkingMapFile, ThinkingPayload } from "../types";
import { getAssetsDirectory } from "./fileUtils";

const MAP_FILE_NAME = "thinking_map.json";

/** Absolute path of the map for a document directory */
export function getThinkingMapPath(docDir: string): string {
  return path.join(getAssetsDirectory(docDir), MAP_FILE_NAME);
}

/** Deterministic JSON so the same payload always hashes to the same value */
function stableStringify(value: any): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  return (
    "{" +
    keys
      .map((key) => JSON.stringify(key) + ":" + stableStringify(value[key]))
      .join(",") +
    "}"
  );
}

/** 8 character hash of a payload, used as the document facing id */
export function computeThinkingHash(entry: ThinkingMapEntry): string {
  const { createdAt: _createdAt, ...hashable } = entry;
  return crypto
    .createHash("sha256")
    .update(stableStringify(hashable))
    .digest("hex")
    .substring(0, 8);
}

/**
 * Parsed maps keyed by file path, valid only while the file's mtime and size are
 * unchanged.
 *
 * Parsing a document looks a hash up once per thinking section, and the map grows
 * with the number of thinking sections in the directory, so reading it afresh each
 * time makes parsing quadratic in the length of the chat. At 4M characters that was
 * 92% of the parse. Another process (the chat.md CLI driving the same file) may
 * write the map, hence the stat rather than a plain memo.
 */
const mapCache = new Map<
  string,
  { mtimeMs: number; size: number; map: ThinkingMapFile }
>();

export function readThinkingMap(docDir: string): ThinkingMapFile {
  const mapPath = getThinkingMapPath(docDir);
  try {
    const stat = fs.statSync(mapPath);
    const cached = mapCache.get(mapPath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.map;
    }
    const parsed = JSON.parse(fs.readFileSync(mapPath, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.entries) {
      const map: ThinkingMapFile = { version: 1, entries: parsed.entries };
      mapCache.set(mapPath, { mtimeMs: stat.mtimeMs, size: stat.size, map });
      return map;
    }
  } catch {
    // Missing, corrupt or unreadable map: behave as if empty rather than breaking
    // the chat. Not cached, so a map that appears later is picked up.
  }
  return { version: 1, entries: {} };
}

function writeThinkingMap(docDir: string, map: ThinkingMapFile): boolean {
  const mapPath = getThinkingMapPath(docDir);
  try {
    fs.mkdirSync(path.dirname(mapPath), { recursive: true });
    fs.writeFileSync(mapPath, JSON.stringify(map, null, 2), "utf8");
    // Seed the cache from what was just written rather than invalidating it: the
    // next read is the streamer parsing the turn it just wrote, and a same-
    // millisecond mtime would otherwise be indistinguishable from a stale entry.
    const stat = fs.statSync(mapPath);
    mapCache.set(mapPath, { mtimeMs: stat.mtimeMs, size: stat.size, map });
    return true;
  } catch {
    mapCache.delete(mapPath);
    return false;
  }
}

/**
 * Store a payload and return its hash. Storing the same payload twice is a no-op
 * because the hash is derived from the payload itself.
 */
export function putThinkingEntry(
  docDir: string,
  model: string,
  payload: ThinkingPayload,
): string {
  const entry: ThinkingMapEntry = {
    ...payload,
    model,
    createdAt: new Date().toISOString(),
  };
  const hash = computeThinkingHash(entry);

  const map = readThinkingMap(docDir);
  if (!map.entries[hash]) {
    // A fresh object rather than a mutation: readThinkingMap hands back the cached
    // map, and mutating it in place would leave the cache holding an entry that is
    // not in the file if the write below fails.
    writeThinkingMap(docDir, {
      version: 1,
      entries: { ...map.entries, [hash]: entry },
    });
  }
  return hash;
}

/** Look up a payload by hash, or undefined when the entry is unknown */
export function getThinkingEntry(
  docDir: string,
  hash: string,
): ThinkingMapEntry | undefined {
  return readThinkingMap(docDir).entries[hash];
}
