import * as fs from "fs";
import * as path from "path";
import { Writable } from "stream";
import { getMcpServerLogPath } from "./fileUtils";
import { log } from "../extension";

// Keep track of open write streams for each server
const logStreams: Map<string, fs.WriteStream> = new Map();

/**
 * Appends a message to the log file for a specific MCP server.
 * Creates the file and stream if they don't exist.
 * @param logBasePath The base directory for logs.
 * @param serverId The ID of the server.
 * @param message The message to log.
 */
export function appendToMcpLog(
  logBasePath: string,
  serverId: string,
  message: string,
): void {
  try {
    let stream = logStreams.get(serverId);

    if (!stream) {
      const logPath = getMcpServerLogPath(logBasePath, serverId);
      // Ensure the directory exists (should be handled by getMcpLogBasePath, but double-check)
      const logDir = path.dirname(logPath);
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      // Create stream with append flag
      stream = fs.createWriteStream(logPath, { flags: "a" });
      logStreams.set(serverId, stream);

      // Handle stream errors
      stream.on("error", (err) => {
        log(`Error writing to MCP log file ${logPath}: ${err}`);
        // Attempt to clean up the stream entry on error
        logStreams.delete(serverId);
        try {
          stream?.close();
        } catch (closeErr) {
          // Ignore errors during cleanup close
        }
      });

      // Handle stream close event (optional, for cleanup)
      stream.on("close", () => {
        // console.log(`MCP log stream closed for server: ${serverId}`);
        // Optionally remove from map on close, but might reopen frequently.
        // logStreams.delete(serverId);
      });
    }

    // Add timestamp and write the message
    const timestamp = new Date().toISOString();
    stream.write(`[${timestamp}] ${message}\n`);
  } catch (error) {
    log(`Failed to append to MCP log for server ${serverId}: ${error}`);
    // Attempt to clean up if stream creation failed
    const stream = logStreams.get(serverId);
    if (stream) {
      logStreams.delete(serverId);
      try {
        stream.close();
      } catch (closeErr) {
        // Ignore errors during cleanup close
      }
    }
  }
}

/**
 * Creates a writable stream that redirects its output to the specified server's log file.
 * Useful for capturing stdout/stderr of stdio processes.
 * @param logBasePath The base directory for logs.
 * @param serverId The ID of the server.
 * @returns A Writable stream.
 */
export function createMcpLogStream(
  logBasePath: string,
  serverId: string,
): Writable {
  const logStream = new Writable({
    write(chunk, encoding, callback) {
      // Convert chunk to string (assuming utf8)
      const message = chunk instanceof Buffer ? chunk.toString("utf8") : chunk;
      // Append message line by line to avoid partial lines in the log
      message.split("\n").forEach((line: string) => {
        if (line.trim().length > 0) {
          // Avoid logging empty lines
          appendToMcpLog(logBasePath, serverId, `[STDERR/STDOUT] ${line}`);
        }
      });
      callback(); // Indicate success
    },
    decodeStrings: false, // Handle chunks as buffers or strings directly
  });

  logStream.on("error", (err) => {
    log(`Error in MCP log Writable stream for server ${serverId}: ${err}`);
  });

  return logStream;
}

/**
 * Closes all open MCP log streams.
 * Should be called during extension deactivation.
 */
export function closeAllMcpLogStreams(): void {
  log(`Closing ${logStreams.size} MCP log streams.`);
  logStreams.forEach((stream, serverId) => {
    try {
      stream.end(() => {
        // console.log(`Closed log stream for ${serverId}`);
      });
    } catch (error) {
      log(`Error closing log stream for ${serverId}: ${error}`);
    }
  });
  logStreams.clear();
}
