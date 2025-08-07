```typescript
// /Users/arusia/repos/filechat/statusManager.d.ts
/**
 * StatusManager state definition
 * Represents the state managed by the StatusManager singleton
 */

import { Disposable } from 'vscode';

export interface StatusManagerState {
  /**
   * The current configuration name selected by the user
   */
  currentConfigName: string | undefined;

  /**
   * The current status of the application
   */
  currentStatus: 'idle' | 'streaming' | 'executing' | 'cancelling';

  /**
   * Animation dots used for streaming or execution status
   */
  streamingDots: string;

  /**
   * Interval for animations
   */
  animationInterval: NodeJS.Timeout | undefined;

  /**
   * Disposables for hover functionality
   */
  hoverDisposables: Disposable[];
}
```

```typescript
// /Users/arusia/repos/filechat/mcpClientManager.d.ts
/**
 * McpClientManager state definition
 * Represents the state managed by the McpClientManager
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { Tool, Prompt } from '@modelcontextprotocol/sdk/types.js';
import { McpServerConfig } from 'src/mcpClient';

export interface McpClientManagerState {
  /**
   * Map of MCP clients by server ID
   */
  clients: Map<string, Client>;

  /**
   * Map of tools by tool name
   */
  tools: Map<string, Tool>;

  /**
   * Map of prompts by name (in format "serverId.promptName")
   */
  prompts: Map<string, Prompt>;

  /**
   * Map of tools by server ID
   */
  serverTools: Map<string, Map<string, Tool>>;

  /**
   * Map of prompts by server ID
   */
  serverPrompts: Map<string, Map<string, Prompt>>;

  /**
   * Map of transports by server ID
   */
  transports: Map<string, Transport>;

  /**
   * Map of retry intervals for SSE connections by server ID
   */
  sseRetryIntervals: Map<string, NodeJS.Timeout>;

  /**
   * Maximum number of retries for SSE connections
   */
  sseMaxRetries: number;

  /**
   * Map of retry counts for SSE connections by server ID
   */
  sseRetryCount: Map<string, number>;

  /**
   * Interval for background refreshing of tool lists
   */
  refreshInterval: NodeJS.Timeout | null;

  /**
   * Interval in milliseconds for background refreshing
   */
  refreshIntervalMs: number;

  /**
   * Last known server configurations
   */
  lastKnownConfigs: Record<string, McpServerConfig>;
}
```

```typescript
// /Users/arusia/repos/filechat/streamerState.d.ts
/**
 * StreamerState definition
 * Represents the state of a streaming response
 */

import { StreamerState } from 'src/types';

export interface StreamerStoreState {
  /**
   * Map of streamers by ID
   * Used to track multiple active streamers
   */
  streamers: Map<number, StreamerState>;
}
```

```typescript
// src/mcpClient.d.ts


export interface McpServerConfig {
  // For both transport types
  env?: Record<string, string>;

  // For stdio transport (traditional config)
  command?: string;
  args?: string[];

  // For SSE transport
  url?: string;
}

```
```typescript
// src/types.d.ts


/**
 * State of a streaming response
 */
export interface StreamerState {
  messageIndex: number;
  tokens: string[];
  isActive: boolean;

  /**
   * Path to the history file where chat context is saved
   * Used for debugging purposes
   */
  historyFilePath?: string;

  /**
   * Flag to indicate whether the streamer is handling a tool call
   * Used to determine whether to automatically add a user block after completion
   */
  isHandlingToolCall?: boolean;

  /**
   * Function to cancel the stream. This can be called externally
   * by components holding a reference to the streamer.
   */
  cancel?: () => void;
}
```
