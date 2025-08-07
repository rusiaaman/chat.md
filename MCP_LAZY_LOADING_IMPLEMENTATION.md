# MCP Lazy Loading Implementation

## Overview

This implementation adds lazy loading support to the MCP (Model Context Protocol) client in the VSCode extension. The key changes enable MCP servers to be started only when needed, rather than keeping all servers connected at startup.

## How It Works

### 1. Initialization Phase
- All MCP servers are started at extension startup
- Tools and prompts are fetched from each server
- Servers are immediately disconnected after fetching metadata
- Tool/prompt information is cached for later use

### 2. Lazy Connection Phase
- When the first tool call is made to a server, the server is reconnected
- The server stays connected after the first use
- Subsequent tool calls use the existing connection

### 3. Connection State Management
- Each server has a connection state: `disconnected`, `connecting`, `connected`, or `failed`
- Pending connections are tracked to avoid race conditions
- Failed connections are marked and not automatically retried

## Key Changes Made

### Added State Management
```typescript
// Lazy loading state management
private serverConfigs: Record<string, McpServerConfig> = {}; // Store configs for lazy loading  
private serverConnectionStates: Map<string, 'disconnected' | 'connecting' | 'connected' | 'failed'> = new Map();
private pendingConnections: Map<string, Promise<void>> = new Map(); // Track ongoing connections
```

### Modified Initialization
- `initializeClients()` now calls `initializeServerLazily()` for each server
- `initializeServerLazily()` connects, fetches tools/prompts, then disconnects
- `disconnectServerOnly()` disconnects without removing cached tools/prompts

### Added Lazy Connection
- `ensureServerConnected()` checks if a server needs to be connected
- `connectServerForUse()` handles the actual connection on first tool use
- Connection state is properly managed throughout the process

### Updated Tool Execution
- `executeToolCall()` now calls `ensureServerConnected()` before executing tools
- Both the main logic and legacy fallback support lazy loading

### Enhanced Diagnostics
- Diagnostic reports now show connection states for all configured servers
- Distinguishes between configured servers and currently connected servers

## Benefits

1. **Faster Startup**: MCP servers are not kept running unnecessarily
2. **Resource Efficiency**: Only active servers consume system resources
3. **Better User Experience**: Tool discovery happens immediately, but connections are on-demand
4. **Maintained Functionality**: All existing features continue to work exactly as before

## Configuration

No configuration changes are required. The lazy loading is automatically enabled for all MCP servers defined in the `chatmd.mcpServers` configuration.

## Testing

To test the lazy loading:

1. Configure MCP servers in your VSCode settings
2. Open a `.chat.md` file
3. Observe that tools are available immediately (from cached metadata)
4. Use a tool - the server will connect on first use
5. Check the MCP diagnostics to see connection states

## Backwards Compatibility

This implementation is fully backwards compatible. All existing functionality works exactly as before, with the only difference being that servers are now connected on-demand rather than at startup.
