import * as fs from "fs";
import * as path from "path";
import { log } from "../extension";

export interface BatchedWriteOptions {
  maxBatchSize?: number;        // Maximum number of items to batch before writing
  maxBatchDelay?: number;       // Maximum delay in ms before writing (even if batch isn't full)
  flushOnClose?: boolean;       // Whether to flush remaining items when closing
}

export class BatchedWriter {
  private buffer: string[] = [];
  private lastWriteTime: number = Date.now();
  private flushTimeout?: NodeJS.Timeout;
  private isClosed: boolean = false;
  private writeStream?: fs.WriteStream;
  private readonly filePath: string;
  private readonly options: Required<BatchedWriteOptions>;

  constructor(
    filePath: string,
    options: BatchedWriteOptions = {}
  ) {
    this.filePath = filePath;
    this.options = {
      maxBatchSize: options.maxBatchSize ?? 10,
      maxBatchDelay: options.maxBatchDelay ?? 1000, // 1 second default
      flushOnClose: options.flushOnClose ?? true,
    };

    // Ensure directory exists
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Create write stream
    this.writeStream = fs.createWriteStream(filePath, { flags: "a" });
    
    this.writeStream.on("error", (err) => {
      log(`Error writing to batched file ${filePath}: ${err}`);
    });

    this.writeStream.on("close", () => {
      log(`Batched write stream closed for ${filePath}`);
    });
  }

  /**
   * Add content to the batch buffer
   */
  public add(content: string): void {
    if (this.isClosed) {
      log(`Warning: Attempted to add content to closed BatchedWriter for ${this.filePath}`);
      return;
    }

    this.buffer.push(content);

    // Check if we should flush based on batch size
    if (this.buffer.length >= this.options.maxBatchSize) {
      this.flush();
      return;
    }

    // Schedule flush based on time if not already scheduled
    if (!this.flushTimeout) {
      this.flushTimeout = setTimeout(() => {
        this.flush();
      }, this.options.maxBatchDelay);
    }
  }

  /**
   * Force flush the current buffer to file
   */
  public flush(): void {
    if (this.buffer.length === 0 || !this.writeStream || this.isClosed) {
      return;
    }

    try {
      // Join all buffered content
      const contentToWrite = this.buffer.join("");
      
      // Write to stream
      this.writeStream.write(contentToWrite, (err) => {
        if (err) {
          log(`Error writing batched content to ${this.filePath}: ${err}`);
        } else {
          log(`Successfully wrote ${this.buffer.length} batched items (${contentToWrite.length} chars) to ${this.filePath}`);
        }
      });

      // Clear buffer and reset timer
      this.buffer = [];
      this.lastWriteTime = Date.now();
      
      if (this.flushTimeout) {
        clearTimeout(this.flushTimeout);
        this.flushTimeout = undefined;
      }
    } catch (error) {
      log(`Error flushing batched content to ${this.filePath}: ${error}`);
    }
  }

  /**
   * Close the writer and optionally flush remaining content
   */
  public close(): void {
    if (this.isClosed) {
      return;
    }

    this.isClosed = true;

    // Clear any pending timeout
    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout);
      this.flushTimeout = undefined;
    }

    // Flush remaining content if requested
    if (this.options.flushOnClose) {
      this.flush();
    }

    // Close the write stream
    if (this.writeStream) {
      this.writeStream.end();
      this.writeStream = undefined;
    }
  }

  /**
   * Get current buffer size
   */
  public getBufferSize(): number {
    return this.buffer.length;
  }

  /**
   * Check if writer is closed
   */
  public get isWriterClosed(): boolean {
    return this.isClosed;
  }
}

// Global registry of batched writers to avoid creating multiple instances for the same file
const batchedWriters = new Map<string, BatchedWriter>();

/**
 * Get or create a batched writer for a specific file
 */
export function getBatchedWriter(
  filePath: string,
  options?: BatchedWriteOptions
): BatchedWriter {
  let writer = batchedWriters.get(filePath);
  
  if (!writer || writer.isWriterClosed) {
    writer = new BatchedWriter(filePath, options);
    batchedWriters.set(filePath, writer);
  }
  
  return writer;
}

/**
 * Close all batched writers
 */
export function closeAllBatchedWriters(): void {
  log(`Closing ${batchedWriters.size} batched writers`);
  batchedWriters.forEach((writer, filePath) => {
    try {
      writer.close();
    } catch (error) {
      log(`Error closing batched writer for ${filePath}: ${error}`);
    }
  });
  batchedWriters.clear();
}

/**
 * Flush all batched writers
 */
export function flushAllBatchedWriters(): void {
  batchedWriters.forEach((writer, filePath) => {
    try {
      writer.flush();
    } catch (error) {
      log(`Error flushing batched writer for ${filePath}: ${error}`);
    }
  });
}
