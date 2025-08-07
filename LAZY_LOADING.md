# MCP Server Lazy Loading Implementation

## Overview

This implementation adds lazy loading functionality to the MCP (Model Context Protocol) client manager. MCP servers now:

1. **Connect briefly at startup** to fetch tool and prompt information
2. **Disconnect immediately** after fetching capabilities  
3. **Reconnect automatically** when their first tool is called
4. **Stay connected** after the first tool use

## Key Benefits

- ✅ **Faster extension startup** - servers disconnect after capability fetch
- ✅ **Resource efficiency** - only maintain connections to actively used servers
- ✅ **Same user experience** - all tools/prompts appear available immediately
- ✅ **Transparent operation** - users don't need to change anything

## Implementation Details

### New State Management

```typescript
// Lazy loading state management
private serverConfigs: Record<string, McpServerConfig> = {};
private serverConnectionState: Map<string, 'disconnected' | 'connecting' | 'connected'> = new Map();
private serverHasBeenUsed: Map<string, boolean> = new Map();
```

### Key Methods Added

- `initializeServerCapabilities()` - Connects briefly to fetch tools/prompts, then disconnects
- `ensureServerConnected()` - Ensures server is connected before tool execution
- `disconnectServerButKeepInfo()` - Disconnects but preserves tool/prompt information
- `getConfiguredServers()`, `getServerConnectionState()`, `hasServerBeenUsed()` - State inspection

### Updated Flow

1. **Extension Startup**: 
   - For each configured server: connect → fetch tools/prompts → disconnect
   - All tool/prompt info is preserved for UI display

2. **First Tool Call**:
   - Check if server is connected, if not: connect automatically
   - Execute tool on connected server
   - Server stays connected for future use

3. **Subsequent Tool Calls**:
   - Use existing connection (no delay)

## Configuration

No configuration changes required. The lazy loading is automatic and transparent.

## Logging

The implementation provides detailed logging to track server states:

```
LAZY LOADING: Servers will connect briefly to fetch capabilities, then disconnect until first tool use
Successfully fetched capabilities for server example-server
Disconnected from MCP server example-server after fetching capabilities
LAZY LOADING: Connecting to MCP server example-server for first tool use
```

## Diagnostics

The MCP diagnostics command now shows lazy loading state:

```
Total configured MCP servers: 3
Currently connected servers: 1
Server: example-server
  Connection state: connected
  Currently connected: Yes
  Has been used for tools: Yes
```

## Backward Compatibility

This implementation is fully backward compatible. Existing MCP server configurations continue to work without any changes.
