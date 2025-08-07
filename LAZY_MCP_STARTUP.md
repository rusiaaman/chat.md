# Lazy MCP Server Startup Implementation

## Overview

This document describes the implementation of lazy startup for MCP (Model Context Protocol) servers in the VS Code extension.

## Problem Statement

Previously, the extension would:
1. Start ALL MCP servers at extension startup
2. Keep all servers continuously connected
3. This could be resource-intensive and slow startup times

## Solution: Lazy Startup

The new implementation provides:
1. **Cataloguing Phase**: At startup, connect briefly to each server to fetch tool/prompt metadata, then disconnect
2. **On-Demand Connection**: When a tool is first used, connect to the specific server and keep it connected
3. **State Tracking**: Distinguish between catalogued servers and actually connected servers

## Implementation Details

### New Class Members

```typescript
// Lazy startup: Track which servers are actually connected vs just catalogued
private connectedServers: Set<string> = new Set();
private cataloguedServers: Set<string> = new Set();
```

### Key Methods

#### `catalogueServer(serverId: string, config: McpServerConfig)`
- Connects temporarily to a server
- Fetches tools and prompts metadata
- Disconnects immediately
- Marks server as "catalogued"

#### `ensureServerConnected(serverId: string)`
- Called before executing tools or prompts
- If server is only catalogued, connects it persistently
- If already connected, does nothing

#### `removeServer(serverId: string)`
- Completely removes a server and its data
- Used for configuration changes and cleanup

### Modified Behavior

1. **Extension Startup**: `initializeClients()` now calls `catalogueServer()` for each configured server instead of `connectServer()`

2. **Tool Execution**: `executeToolCall()` and `getPrompt()` now call `ensureServerConnected()` before execution

3. **Configuration Changes**: Servers are properly removed and re-catalogued when configuration changes

4. **Background Refresh**: Only refreshes actually connected servers, not catalogued ones

## Benefits

1. **Faster Startup**: Extension starts faster since servers aren't kept running
2. **Resource Efficiency**: Only servers being used consume resources
3. **Tool Visibility**: All tools/prompts are still visible in the UI immediately
4. **Transparent**: End users don't notice the difference - tools work the same way
5. **Lazy Loading**: Servers start only when needed

## User Experience

- **At startup**: All configured tools and prompts are available for autocomplete/discovery
- **First tool use**: Small delay as server connects (logs show "First tool use detected for server X, connecting now...")
- **Subsequent uses**: No delay, server stays connected
- **Diagnostics**: New diagnostic report shows which servers are "CATALOGUED ONLY" vs "CONNECTED"

## Example Flow

1. Extension starts
2. Catalogues "filesystem" server → shows file tools in UI, then disconnects
3. Catalogues "github" server → shows GitHub tools in UI, then disconnects  
4. User uses a file tool → "filesystem" server connects and stays connected
5. User uses another file tool → no delay (server already connected)
6. "github" server remains catalogued until first GitHub tool is used

## Configuration

No configuration changes required. The feature works automatically with existing MCP server configurations.

## Diagnostics

Run the "MCP Diagnostics" command to see:
- Total catalogued servers
- Currently connected servers  
- Server status (CONNECTED vs CATALOGUED ONLY)
- Tool/prompt counts per server
