/**
 * Cross-process lock on a .chat.md file, shared with the chat.md Python CLI.
 *
 * The CLI additionally takes a kernel lock (flock) on this same file, which is
 * released automatically if its process dies. Node cannot flock without a native
 * module, so this side relies on the advisory JSON body: pid, host and a heartbeat
 * refreshed while the lock is held. A holder whose pid is gone, or whose heartbeat
 * has gone quiet for three intervals, is treated as dead and its lock reclaimed —
 * which is what stops a crashed process from wedging a chat file forever.
 *
 * Field names and units match the Python implementation exactly (seconds since the
 * epoch, camelCase keys) so each side can read the other's lock.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { log } from "../extension";

const OWNER = "vscode";
const HEARTBEAT_INTERVAL_MS = 5000;
const STALE_FACTOR = 3;

export interface ChatLockInfo {
  owner: string;
  pid: number;
  host: string;
  /** Seconds since the epoch, to match the Python side. */
  startedAt: number;
  heartbeat: number;
}

/** Hidden sibling of the chat file, e.g. `.notes.chat.md.lock`. */
export function chatLockPath(chatFilePath: string): string {
  const dir = path.dirname(chatFilePath);
  const name = path.basename(chatFilePath);
  return path.join(dir, `.${name}.lock`);
}

/**
 * Reads a lock body, or undefined when it is absent, empty or unparseable.
 *
 * Unparseable counts as absent on purpose: a half-written lock file must not be
 * able to block a chat permanently.
 */
export function readChatLockInfo(lockPath: string): ChatLockInfo | undefined {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    if (raw.trim() === "") {
      return undefined;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }
    return {
      owner: String(parsed.owner ?? "unknown"),
      pid: Number(parsed.pid ?? 0),
      host: String(parsed.host ?? ""),
      startedAt: Number(parsed.startedAt ?? 0),
      heartbeat: Number(parsed.heartbeat ?? 0),
    };
  } catch {
    return undefined;
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isStale(info: ChatLockInfo): boolean {
  if (info.host === os.hostname() && !pidAlive(info.pid)) {
    return true;
  }
  const ageMs = Date.now() - info.heartbeat * 1000;
  return ageMs > HEARTBEAT_INTERVAL_MS * STALE_FACTOR;
}

/**
 * Who is driving this chat file, if anyone live is. Undefined when the lock is
 * absent or its holder is provably gone, so callers can report "free" without
 * having to take it.
 */
export function chatLockHolder(chatFilePath: string): ChatLockInfo | undefined {
  const info = readChatLockInfo(chatLockPath(chatFilePath));
  if (!info || isStale(info)) {
    return undefined;
  }
  return info;
}

class ChatFileLock {
  private refs = 1;
  private timer: NodeJS.Timeout | undefined;

  private constructor(
    public readonly lockPath: string,
    private fd: number,
    private info: ChatLockInfo,
  ) {
    this.write();
    this.timer = setInterval(() => this.beat(), HEARTBEAT_INTERVAL_MS);
  }

  static create(lockPath: string): ChatFileLock | undefined {
    let fd: number;
    try {
      // Neither O_EXCL nor an unlink of a stale file: a stale lock is taken over in
      // place. Unlinking here would destroy the inode of a process that created the
      // file microseconds ago and has not written its body yet, leaving two holders
      // each guarding a different inode.
      fd = fs.openSync(lockPath, "r+");
    } catch {
      try {
        fd = fs.openSync(lockPath, "w");
      } catch (error) {
        log(`Could not open lock file ${lockPath}: ${error}`);
        return undefined;
      }
    }

    const now = Date.now() / 1000;
    return new ChatFileLock(lockPath, fd, {
      owner: OWNER,
      pid: process.pid,
      host: os.hostname(),
      startedAt: now,
      heartbeat: now,
    });
  }

  retain(): void {
    this.refs += 1;
  }

  private write(): void {
    try {
      const payload = JSON.stringify(this.info, null, 2) + "\n";
      fs.ftruncateSync(this.fd, 0);
      fs.writeSync(this.fd, payload, 0, "utf8");
    } catch (error) {
      // A lock we cannot describe is still a lock we hold.
      log(`Could not write lock body for ${this.lockPath}: ${error}`);
    }
  }

  private beat(): void {
    this.info = { ...this.info, heartbeat: Date.now() / 1000 };
    this.write();
  }

  release(): void {
    this.refs -= 1;
    if (this.refs > 0) {
      return;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    try {
      fs.unlinkSync(this.lockPath);
    } catch {
      // Already gone; nothing to do.
    }
    try {
      fs.closeSync(this.fd);
    } catch {
      // Already closed.
    }
    active.delete(this.lockPath);
  }
}

/** Locks held by this process, so nested acquisitions do not deadlock. */
const active = new Map<string, ChatFileLock>();

export type ChatLockHandle = { release: () => void };

/**
 * Takes the lock for a chat file, or returns undefined when someone live holds it.
 *
 * Re-entrant within this process: the extension streams, appends a tool_execute
 * block, and re-triggers on its own edit, so a strictly exclusive lock would block
 * the extension's own follow-up work. Cross-process exclusion is the point, and
 * that is what the body provides.
 */
export function acquireChatFileLock(chatFilePath: string): ChatLockHandle | undefined {
  const lockPath = chatLockPath(chatFilePath);

  const existing = active.get(lockPath);
  if (existing) {
    existing.retain();
    return { release: () => existing.release() };
  }

  const info = readChatLockInfo(lockPath);
  if (info && !isStale(info)) {
    log(
      `Chat file ${path.basename(chatFilePath)} is locked by ${info.owner} (pid ${info.pid})`,
    );
    return undefined;
  }

  const lock = ChatFileLock.create(lockPath);
  if (!lock) {
    return undefined;
  }
  active.set(lockPath, lock);
  return { release: () => lock.release() };
}

/** Releases every lock this process holds. Called on deactivate. */
export function releaseAllChatFileLocks(): void {
  for (const lock of Array.from(active.values())) {
    while (active.has(lock.lockPath)) {
      lock.release();
    }
  }
}
