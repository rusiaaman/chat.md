# Batched Streaming Implementation

## Overview

This document describes the implementation of batched streaming to reduce the overhead of frequent file writes, especially important for remote files where each write operation can be expensive.

## Problem

Previously, each streaming event triggered an immediate file write:
- Chat history was appended immediately for every token chunk
- MCP logs were written immediately for each log message
- This caused performance issues, especially for remote files

## Solution

Implemented a `BatchedWriter` utility that:
- Buffers multiple writes before performing a single file operation
- Uses configurable batch size and timing thresholds
- Automatically flushes remaining content when closing
- Provides global registry to avoid duplicate writers for the same file

## Key Components

### 1. BatchedWriter Class

Located in `src/utils/batchedWriter.ts`:

```typescript
export class BatchedWriter {
  constructor(
    filePath: string,
    options: BatchedWriteOptions = {}
  )
  
  public add(content: string): void
  public flush(): void
  public close(): void
}
```

**Configuration Options:**
- `maxBatchSize`: Maximum number of items to batch before writing (default: 10)
- `maxBatchDelay`: Maximum delay in ms before writing (default: 1000ms)
- `flushOnClose`: Whether to flush remaining items when closing (default: true)

### 2. Global Registry

```typescript
export function getBatchedWriter(
  filePath: string,
  options?: BatchedWriteOptions
): BatchedWriter

export function closeAllBatchedWriters(): void
export function flushAllBatchedWriters(): void
```

## Usage

### Chat History Batching

Modified `appendToChatHistory()` in `src/utils/fileUtils.ts`:

```typescript
export function appendToChatHistory(
  historyFilePath: string,
  content: string,
): void {
  // Use batched writer for better performance, especially for remote files
  const batchedWriter = getBatchedWriter(historyFilePath, {
    maxBatchSize: 5,        // Batch up to 5 token chunks
    maxBatchDelay: 500,     // Flush after 500ms if batch isn't full
    flushOnClose: true,     // Ensure remaining content is written when closing
  });

  // Add content to batch buffer
  batchedWriter.add(content);
}
```

### MCP Log Batching

Modified `appendToMcpLog()` in `src/utils/mcpLogUtils.ts`:

```typescript
// Use batched writer for better performance, especially for remote files
const batchedWriter = getBatchedWriter(logPath, {
  maxBatchSize: 20,       // Batch up to 20 log messages
  maxBatchDelay: 1000,    // Flush after 1 second if batch isn't full
  flushOnClose: true,     // Ensure remaining content is written when closing
});

batchedWriter.add(formattedMessage);
```

### Streaming Service Integration

Modified `StreamingService` in `src/streamer.ts`:

```typescript
private setStreamerInactive(streamer: StreamerState, reason: string): void {
  // Flush any remaining batched content for chat history before deactivating
  if (streamer.historyFilePath) {
    try {
      const batchedWriter = getBatchedWriter(streamer.historyFilePath);
      batchedWriter.flush();
      log(`Flushed remaining batched content for chat history file before deactivation: ${streamer.historyFilePath}`);
    } catch (error) {
      log(`Error flushing batched content for chat history during deactivation: ${error}`);
    }
  }
  
  streamer.isActive = false;
}
```

## Benefits

1. **Reduced File I/O**: Multiple small writes are batched into fewer, larger operations
2. **Better Performance**: Especially noticeable for remote files (SSH, network drives, etc.)
3. **Configurable**: Batch size and timing can be tuned based on use case
4. **Automatic Cleanup**: Remaining content is flushed when writers are closed
5. **Error Handling**: Graceful fallback if batching fails

## Configuration

### Chat History
- **Batch Size**: 5 token chunks
- **Batch Delay**: 500ms
- **Flush on Close**: Yes

### MCP Logs
- **Batch Size**: 20 log messages
- **Batch Delay**: 1000ms (1 second)
- **Flush on Close**: Yes

## Cleanup

Batched writers are automatically cleaned up:
- When streaming completes successfully
- When streaming is cancelled
- When the extension is deactivated
- When `closeAllBatchedWriters()` is called

## Testing

A test suite is provided in `src/tests/batchedWriterTest.ts` that verifies:
- File creation and writing
- Batching behavior
- Flush on close functionality
- Global registry behavior
- Error handling

## Migration

The implementation is backward compatible:
- Existing code continues to work
- File writes are now batched automatically
- No changes required to calling code
- Performance improvements are transparent to users

## Future Enhancements

Potential improvements could include:
- Dynamic batch sizing based on file system performance
- Compression of batched content
- Metrics collection for batch performance
- Configurable batch policies per file type
