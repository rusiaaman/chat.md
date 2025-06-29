import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Tool, Prompt } from "@modelcontextprotocol/sdk/types.js";
import { log } from "./extension";
import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";

export interface McpServerConfig {
  // For both transport types
  env?: Record<string, string>;

  // For stdio transport (traditional config)
  command?: string;
  args?: string[];

  // For SSE transport
  url?: string;
}

export class McpClientManager {
  private clients: Map<string, Client> = new Map();
  private tools: Map<string, Tool> = new Map();
  private prompts: Map<string, Prompt> = new Map(); // Store prompts by name
  private serverTools: Map<string, Map<string, Tool>> = new Map();
  private serverPrompts: Map<string, Map<string, Prompt>> = new Map(); // Store prompts by server
  private transports: Map<string, Transport> = new Map();
  private sseRetryIntervals: Map<string, NodeJS.Timeout> = new Map();
  private sseMaxRetries: number = 5;
  private sseRetryCount: Map<string, number> = new Map();
  private refreshInterval: NodeJS.Timeout | null = null;
  private refreshIntervalMs: number = 5000; // 5 seconds
  private lastKnownConfigs: Record<string, McpServerConfig> = {};
  
  // Lazy loading state management
  private serverConfigs: Record<string, McpServerConfig> = {};
  private lazyServerStates: Map<string, 'not-started' | 'connecting' | 'connected'> = new Map();
  private pendingConnections: Map<string, Promise<void>> = new Map();

  // Initialize MCP clients from configuration with lazy loading
  public async initializeClients(
    mcpServers: Record<string, McpServerConfig>,
  ): Promise<void> {
    // Stop any existing refresh interval
    this.stopBackgroundRefresh();

    // Store the current configs for comparison later and for lazy loading
    this.lastKnownConfigs = JSON.parse(JSON.stringify(mcpServers));
    this.serverConfigs = JSON.parse(JSON.stringify(mcpServers));

    // Clear existing state
    this.clients.clear();
    this.tools.clear();
    this.prompts.clear();
    this.serverTools.clear();
    this.serverPrompts.clear();
    this.lazyServerStates.clear();
    this.pendingConnections.clear();

    // Initialize lazy loading state for each server
    for (const serverId of Object.keys(mcpServers)) {
      this.lazyServerStates.set(serverId, 'not-started');
    }

    // Fetch tools and prompts from each server but disconnect immediately
    await this.initializeLazyServers(mcpServers);

    // Start background refresh for tool lists (only for connected servers)
    this.startBackgroundRefresh();
  }

  /**
   * Initialize servers in lazy mode - connect, fetch tools/prompts, then disconnect
   */
  private async initializeLazyServers(
    mcpServers: Record<string, McpServerConfig>,
  ): Promise<void> {
    for (const [serverId, config] of Object.entries(mcpServers)) {
      try {
        log(`Initializing server ${serverId} in lazy mode - fetching tools and disconnecting`);
        
        // Connect temporarily
        await this.connectServer(serverId, config);
        
        // Tools and prompts are already fetched in connectServer
        log(`Server ${serverId}: fetched ${this.serverTools.get(serverId)?.size || 0} tools and ${this.serverPrompts.get(serverId)?.size || 0} prompts`);
        
        // Disconnect immediately to implement lazy loading
        await this.disconnectServerKeepingToolInfo(serverId);
        
        log(`Server ${serverId} disconnected - will be started on first tool use`);
      } catch (error) {
        log(`Failed to initialize lazy server ${serverId}: ${error}`);
        // Keep the server in not-started state for potential retry later
        this.lazyServerStates.set(serverId, 'not-started');
      }
    }
  }

  /**
   * Starts the background refresh interval for tool lists
   */
  private startBackgroundRefresh(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }

    // Only log once when starting the refresh interval
    log(`Starting background tool refresh at ${this.refreshIntervalMs}ms intervals`);
    this.refreshInterval = setInterval(() => {
      this.refreshAllToolLists().catch((error) => {
        log(`Error in background tool refresh: ${error}`);
      });
    }, this.refreshIntervalMs);
  }

  /**
   * Stops the background refresh interval
   */
  private stopBackgroundRefresh(): void {
    if (this.refreshInterval) {
      log("Stopping background tool refresh");
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }

  /**
   * Check for configuration changes and reload affected servers
   */
  public async checkConfigChanges(
    newConfigs: Record<string, McpServerConfig>,
  ): Promise<void> {
    log("Checking for MCP server configuration changes");

    // Find servers that need to be reloaded
    const serversToReload: string[] = [];
    const serversToRemove: string[] = [];
    const serversToAdd: string[] = [];

    // First, find servers that changed or were removed
    for (const [serverId, oldConfig] of Object.entries(this.lastKnownConfigs)) {
      if (!newConfigs[serverId]) {
        // Server was removed from configuration
        serversToRemove.push(serverId);
        log(`Server ${serverId} removed from configuration`);
      } else if (!this.configsEqual(oldConfig, newConfigs[serverId])) {
        // Server config changed
        serversToReload.push(serverId);
        log(`Configuration changed for server ${serverId}`);
      }
    }

    // Find new servers that were added
    for (const serverId of Object.keys(newConfigs)) {
      if (!this.lastKnownConfigs[serverId]) {
        serversToAdd.push(serverId);
        log(`New server ${serverId} added to configuration`);
      }
    }

    // Remove servers that were removed from configuration
    for (const serverId of serversToRemove) {
      await this.disconnectServer(serverId);
    }

    // Reload servers with changed configuration
    for (const serverId of serversToReload) {
      log(`Reloading server ${serverId} due to configuration change`);
      await this.disconnectServer(serverId);
      try {
        await this.connectServer(serverId, newConfigs[serverId]);
        log(`Successfully reloaded server ${serverId}`);
      } catch (error) {
        log(`Failed to reload server ${serverId}: ${error}`);
      }
    }

    // Add new servers
    for (const serverId of serversToAdd) {
      try {
        await this.connectServer(serverId, newConfigs[serverId]);
        log(`Connected to new server ${serverId}`);
      } catch (error) {
        log(`Failed to connect to new server ${serverId}: ${error}`);
      }
    }

    // Update the stored configuration
    this.lastKnownConfigs = JSON.parse(JSON.stringify(newConfigs));
  }

  /**
   * Compare two server configurations for equality
   */
  private configsEqual(
    config1: McpServerConfig,
    config2: McpServerConfig,
  ): boolean {
    // Compare URL (for SSE servers)
    if (config1.url !== config2.url) {
      return false;
    }

    // Compare command and args (for stdio servers)
    if (config1.command !== config2.command) {
      return false;
    }

    // Compare args array
    const args1 = config1.args || [];
    const args2 = config2.args || [];
    if (args1.length !== args2.length) {
      return false;
    }
    for (let i = 0; i < args1.length; i++) {
      if (args1[i] !== args2[i]) {
        return false;
      }
    }

    // Compare environment variables
    const env1 = config1.env || {};
    const env2 = config2.env || {};
    const env1Keys = Object.keys(env1);
    const env2Keys = Object.keys(env2);

    if (env1Keys.length !== env2Keys.length) {
      return false;
    }

    for (const key of env1Keys) {
      if (env1[key] !== env2[key]) {
        return false;
      }
    }

    return true;
  }

  // Connect to a single MCP server
  private async connectServer(
    serverId: string,
    config: McpServerConfig,
  ): Promise<void> {
    // Create environment that includes both current process.env (for PATH) and custom env from config
    // Filter out undefined values to satisfy the Record<string, string> type
    const combinedEnv: Record<string, string> = {};

    // Add process.env, filtering out undefined values
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        combinedEnv[key] = value;
      }
    }

    // Add custom env values from config
    if (config.env) {
      Object.assign(combinedEnv, config.env);
    }

    let transport: Transport;

    // Determine the transport type based on configuration
    if (config.url) {
      try {
        // Validate URL format
        const parsedUrl = new URL(config.url);
        log(
          `Parsed SSE URL: ${parsedUrl.href} (protocol: ${parsedUrl.protocol}, host: ${parsedUrl.host}, path: ${parsedUrl.pathname})`,
        );

        // SSE transport - pass the URL object, not string
        log(
          `Connecting to MCP server ${serverId} with SSE URL: ${parsedUrl.href}`,
        );
        transport = new SSEClientTransport(parsedUrl);

        // Log transport details
        log(`Created SSE transport for ${serverId}`);

        // Set up reconnection logic for SSE with improved rate limit handling
        this.setupSSEReconnection(
          serverId,
          config,
          transport as SSEClientTransport,
        );
      } catch (error) {
        log(`Error creating SSE transport for server ${serverId}: ${error}`);
        log(
          `Invalid URL format: "${config.url}". URLs must include protocol (http:// or https://)`,
        );
        throw new Error(
          `Invalid URL format for SSE server ${serverId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else if (config.command) {
      // Stdio transport
      log(
        `Connecting to MCP server ${serverId} with command: ${config.command}`,
      );
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args || [],
        env: combinedEnv,
      });
    } else {
      throw new Error(
        `Invalid MCP server configuration for ${serverId}: must specify either 'url' for SSE or 'command' for stdio`,
      );
    }

    // Store the transport for later reference
    this.transports.set(serverId, transport);

    const client = new Client(
      {
        name: "filechat",
        version: "0.1.0",
      },
      {
        capabilities: {
          tools: {}, // Request tools capability
          prompts: {}, // Also request prompts capability
        },
      },
    );

    try {
      // Connect to the server
      log(`Attempting to connect to MCP server ${serverId}...`);
      await client.connect(transport);
      log(`Successfully connected to MCP server ${serverId}`);

      this.clients.set(serverId, client);

      // Get available tools
      log(`Requesting tool list from server ${serverId}...`);
      const toolsResult = await client.listTools();
      log(`Received ${toolsResult.tools.length} tools from server ${serverId}`);

      // Store tools by server
      const serverToolMap = new Map<string, Tool>();
      this.serverTools.set(serverId, serverToolMap);

      // Register each tool
      for (const tool of toolsResult.tools) {
        this.tools.set(tool.name, tool);
        serverToolMap.set(tool.name, tool);
        log(`Registered tool: ${tool.name} from server ${serverId}`);
        log(
          `Tool schema for ${tool.name}:\n${JSON.stringify(tool.inputSchema, null, 2)}`,
        );
      }
      
      // Check if server supports prompts
      const serverCapabilities = client.getServerCapabilities();
      if (serverCapabilities?.prompts) {
        try {
          // Get available prompts
          log(`Requesting prompt list from server ${serverId}...`);
          const promptsResult = await client.listPrompts();
          log(`Received ${promptsResult.prompts.length} prompts from server ${serverId}`);
          
          // Store prompts by server
          const serverPromptMap = new Map<string, Prompt>();
          this.serverPrompts.set(serverId, serverPromptMap);
          
          // Register each prompt
          for (const prompt of promptsResult.prompts) {
            this.prompts.set(`${serverId}.${prompt.name}`, prompt);
            serverPromptMap.set(prompt.name, prompt);
            log(`Registered prompt: ${prompt.name} from server ${serverId}`);
            if (prompt.arguments) {
              log(`Prompt arguments for ${prompt.name}:\n${JSON.stringify(prompt.arguments, null, 2)}`);
            }
          }
        } catch (promptError) {
          // Don't fail connection if prompts fail
          log(`Error fetching prompts from server ${serverId}: ${promptError}`);
          log(`Continuing with only tools support for server ${serverId}`);
        }
      } else {
        log(`Server ${serverId} does not support prompts capability`);
      }
    } catch (error) {
      log(`Error connecting to MCP server ${serverId}: ${error}`);

      // Enhanced error logging
      if (error instanceof Error) {
        log(`Error type: ${error.name}`);
        log(`Error message: ${error.message}`);
        if (error.stack) {
          log(`Error stack: ${error.stack}`);
        }

        // Check for specific error types
        if (error.message.includes("ECONNREFUSED")) {
          log(
            `Connection refused: The SSE server at ${config.url} is not running or not accessible`,
          );
        } else if (error.message.includes("SSL")) {
          log(
            `SSL Error: There might be an issue with the SSL certificate or HTTPS connection`,
          );
        } else if (error.message.includes("timeout")) {
          log(`Connection timeout: The server took too long to respond`);
        } else if (error.message.includes("invalid or illegal string")) {
          log(
            `Invalid URL format or response: Check that the URL format is correct and the server is returning proper SSE format`,
          );
        }
      } else {
        log(`Non-Error object thrown: ${JSON.stringify(error)}`);
      }

      throw error;
    }
  }

  // Get all tool objects with their original schemas (flat list)
  public getAllTools(): Tool[] {
    return Array.from(this.tools.values());
  }

  // Get all prompt objects (flat list)
  public getAllPrompts(): Prompt[] {
    return Array.from(this.prompts.values());
  }

  // Get tools grouped by server ID
  public getGroupedTools(): Map<string, Map<string, Tool>> {
    return this.serverTools;
  }

  // Get prompts grouped by server ID
  public getGroupedPrompts(): Map<string, Map<string, Prompt>> {
    return this.serverPrompts;
  }
  
  // Get a list of all connected server IDs
  public getConnectedServers(): string[] {
    return Array.from(this.clients.keys());
  }
  /**
   * Ensures a server is connected, starting it lazily if needed
   */
  private async ensureServerConnected(serverId: string): Promise<void> {
    const state = this.lazyServerStates.get(serverId);
    
    if (state === 'connected') {
      // Already connected
      return;
    }
    
    if (state === 'connecting') {
      // Connection in progress, wait for it
      const pendingConnection = this.pendingConnections.get(serverId);
      if (pendingConnection) {
        await pendingConnection;
        return;
      }
    }
    
    if (state === 'not-started') {
      // Start the connection
      this.lazyServerStates.set(serverId, 'connecting');
      
      const connectionPromise = this.connectLazyServer(serverId);
      this.pendingConnections.set(serverId, connectionPromise);
      
      try {
        await connectionPromise;
        this.lazyServerStates.set(serverId, 'connected');
        log(`Server ${serverId} successfully connected on demand`);
      } catch (error) {
        this.lazyServerStates.set(serverId, 'not-started');
        log(`Failed to connect server ${serverId} on demand: ${error}`);
        throw error;
      } finally {
        this.pendingConnections.delete(serverId);
      }
    }
  }

  /**
   * Connects a server that was previously initialized in lazy mode
   */
  private async connectLazyServer(serverId: string): Promise<void> {
    const config = this.serverConfigs[serverId];
    if (!config) {
      throw new Error(`No configuration found for server ${serverId}`);
    }
    
    log(`Connecting lazy server ${serverId} for first tool use`);
    await this.connectServer(serverId, config);
  }

  // Execute a tool through the appropriate MCP client
  // Tool name is expected in the format "serverName.toolName"
  public async executeToolCall(
    fullName: string,
    params: Record<string, string>,
    document?: vscode.TextDocument | null,
    signal?: AbortSignal,
  ): Promise<string> {
    log(`executeToolCall called with document=${document ? 'provided' : 'not provided'}`);
    
    // Additional check for ReadImage tool specifically
    if (fullName.includes("ReadImage")) {
      log(`SPECIAL HANDLING FOR ReadImage TOOL:`);
      log(`- Document provided: ${document ? 'YES' : 'NO'}`);
      log(`- Params: ${JSON.stringify(params)}`);
      
      // Check if we have a file_path parameter
      if (params.file_path) {
        log(`- file_path parameter: ${params.file_path}`);
        
        // Check if document is available to resolve relative paths
        if (!document) {
          log(`WARNING: Document not available to resolve relative file path for ReadImage tool`);
          return `Error: Cannot resolve relative file path "${params.file_path}" without document context`;
        }
      }
    }
    
    // Parse the fullName to get serverName and actualToolName
    const dotIndex = fullName.indexOf(".");
    let serverName: string | undefined = undefined;
    let actualToolName: string = fullName; // Default to fullName if parsing fails

    if (dotIndex > 0 && dotIndex < fullName.length - 1) {
      serverName = fullName.substring(0, dotIndex);
      actualToolName = fullName.substring(dotIndex + 1);
      log(`Parsed tool name: server="${serverName}", tool="${actualToolName}"`);
    } else {
      log(
        `Warning: Tool name "${fullName}" does not follow the expected "serverName.toolName" format. Falling back to legacy lookup.`,
      );
      // Fallback: Use the old method of iterating through all servers
      return this.executeToolCallLegacyFallback(fullName, params, document, signal);
    }

    // --- Lazy loading: Ensure server is connected before executing tool ---
    try {
      await this.ensureServerConnected(serverName);
    } catch (error) {
      return `Error: Failed to connect to MCP server "${serverName}": ${error}`;
    }

    // Get the specific client for the server
    const client = this.clients.get(serverName);
    if (!client) {
      return `Error: MCP server "${serverName}" not found or not connected.`;
    }

    // Get the specific tool definition from the server's map
    const serverToolMap = this.serverTools.get(serverName);
    const tool = serverToolMap?.get(actualToolName);
    if (!tool) {
      return `Error: Tool "${actualToolName}" not found on server "${serverName}".`;
    }

    // Execute the tool using the specific client and actual tool name
    try {
      // Make sure we pass the document parameter to _executeToolOnClient
      return await this._executeToolOnClient(
        client,
        serverName,
        actualToolName,
        tool,
        params,
        document,
        signal,
      );
    } catch (error) {
      log(
        `Error executing tool ${actualToolName} on server ${serverName}: ${error}`,
      );
      
      // More detailed error logging for debugging
      if (error instanceof Error) {
        log(`Error type: ${error.name}`);
        log(`Error message: ${error.message}`);
        if (error.stack) {
          log(`Error stack: ${error.stack}`);
        }
        
        // Look for specific "document is not defined" errors
        if (error.message.includes("document is not defined")) {
          log(`CRITICAL: 'document is not defined' error detected for tool ${actualToolName}`);
          log(`This usually happens when trying to resolve file paths without document context`);
        }
        
        // Handle AbortError specifically
        if (error.name === 'AbortError' || 
            (error.message && (
              error.message.includes('AbortError') ||
              error.message.includes('cancelled') ||
              error.message.includes('canceled') ||
              error.message.includes('aborted')
            ))
        ) {
          log(`Tool execution cancelled via AbortError: ${actualToolName}`);
          // Special return value to indicate cancellation
          return `CANCELLED:${Symbol('AbortError').toString()}`;
        }
      }
      
      return `Error executing tool ${actualToolName}: ${error}`;
    }
  }

  // Fallback method for the old way of finding the tool across all servers
  private async executeToolCallLegacyFallback(
    name: string,
    params: Record<string, string>,
    document?: vscode.TextDocument | null,
    signal?: AbortSignal,
  ): Promise<string> {
    log(`Executing legacy fallback for tool "${name}"`);
    // Find which server has this tool and execute it
    for (const [serverId, serverToolMap] of this.serverTools.entries()) {
      const tool = serverToolMap.get(name);
      if (!tool) {
        continue; // This server doesn't have this tool
      }

      // Ensure server is connected before attempting to execute
      try {
        await this.ensureServerConnected(serverId);
      } catch (error) {
        log(`Failed to connect server ${serverId} for tool ${name}: ${error}`);
        continue; // Try next server
      }

      const client = this.clients.get(serverId);
      if (!client) {
        continue; // Shouldn't happen but check anyway
      }

      try {
        return await this._executeToolOnClient(
          client,
          serverId,
          name,
          tool,
          params,
          document,
          signal,
        );
      } catch (error) {
        log(
          `Error executing tool ${name} on server ${serverId} (fallback): ${error}`,
        );
        // Continue searching on other servers in case of error? Or return error immediately?
        // For now, return the error from the first server that failed.
        return `Error executing tool ${name}: ${error}`;
      }
    }

    // If loop completes without finding the tool
    return `Error: Tool "${name}" not found on any server.`;
  }

  /**
   * Sets up SSE-specific reconnection logic for a server
   */
  private setupSSEReconnection(
    serverId: string,
    config: McpServerConfig,
    transport: SSEClientTransport,
  ): void {
    log(`Setting up SSE reconnection handlers for server ${serverId}`);

    // Set up error handler for SSE transport
    transport.onerror = (error) => {
      log(`SSE connection error for server ${serverId}: ${error}`);
      log(`Error details: ${error.name}: ${error.message}`);
      if (error.stack) {
        log(`Error stack: ${error.stack}`);
      }
      this.attemptReconnect(serverId, config);
    };

    // Set up close handler if available
    if (typeof transport.onclose === "function") {
      const originalOnClose = transport.onclose;
      transport.onclose = () => {
        log(`SSE connection closed for server ${serverId}`);
        if (originalOnClose) {
          originalOnClose.call(transport);
        }
        this.attemptReconnect(serverId, config);
      };
    }

    // Log successful setup
    log(`SSE reconnection handlers set up for server ${serverId}`);
  }

  /**
   * Attempts to reconnect to an SSE server with exponential backoff
   */
  private attemptReconnect(serverId: string, config: McpServerConfig): void {
    // Clear any existing retry interval
    if (this.sseRetryIntervals.has(serverId)) {
      clearInterval(this.sseRetryIntervals.get(serverId)!);
      this.sseRetryIntervals.delete(serverId);
    }

    // Check if we've exceeded max retries
    const retryCount = this.sseRetryCount.get(serverId) || 0;
    if (retryCount >= this.sseMaxRetries) {
      log(
        `Exceeded maximum retry attempts (${this.sseMaxRetries}) for SSE server ${serverId}`,
      );
      this.sseRetryCount.delete(serverId);
      return;
    }

    // Increment retry count
    this.sseRetryCount.set(serverId, retryCount + 1);

    // Set up retry with exponential backoff
    const backoffTime = Math.min(30000, 1000 * Math.pow(2, retryCount));
    log(
      `Will attempt to reconnect to SSE server ${serverId} in ${backoffTime}ms (retry ${retryCount + 1}/${this.sseMaxRetries})`,
    );

    const interval = setInterval(async () => {
      clearInterval(interval);
      this.sseRetryIntervals.delete(serverId);

      log(`Attempting to reconnect to SSE server ${serverId}`);
      try {
        await this.connectServer(serverId, config);
        log(`Successfully reconnected to SSE server ${serverId}`);
        this.sseRetryCount.delete(serverId);
      } catch (error) {
        log(`Failed to reconnect to SSE server ${serverId}: ${error}`);
        this.attemptReconnect(serverId, config);
      }
    }, backoffTime);

    this.sseRetryIntervals.set(serverId, interval);
  }

  /**
   * Refreshes tool lists and prompt lists for all connected servers
   */
  public async refreshAllToolLists(): Promise<void> {
    // Track successes and failures
    let successCount = 0;
    let failCount = 0;

    // Only refresh actually connected servers (not lazy ones)
    for (const [serverId, client] of this.clients.entries()) {
      const state = this.lazyServerStates.get(serverId);
      if (state === 'connected') {
        try {
          await this.refreshServerTools(serverId, client);
          await this.refreshServerPrompts(serverId, client);
          successCount++;
        } catch (error) {
          failCount++;
          log(`Failed to refresh tools/prompts for server ${serverId}: ${error}`);
        }
      }
    }
    
    // Update the prompt count in the status bar if available
    try {
      const promptCount = this.prompts.size;
      const connectedServers = Array.from(this.lazyServerStates.entries())
        .filter(([_, state]) => state === 'connected')
        .map(([serverId, _]) => serverId);
      // Import the status manager here to avoid circular dependencies
      const { statusManager } = await import("./extension");
      statusManager.setupPromptHover(promptCount);
      log(`Updated status bar: ${connectedServers.length} connected servers, ${promptCount} prompts available`);
    } catch (error) {
      log(`Error updating prompt count: ${error}`);
    }
  }

  /**
   * Refreshes the tool list for a specific server
   */
  private async refreshServerTools(
    serverId: string,
    client: Client,
  ): Promise<void> {
    try {
      // Get available tools
      const toolsResult = await client.listTools();

      // Create or get the server's tool map
      let serverToolMap = this.serverTools.get(serverId);
      if (!serverToolMap) {
        serverToolMap = new Map<string, Tool>();
        this.serverTools.set(serverId, serverToolMap);
      }

      // Keep track of which tools were updated
      const currentTools = new Set(serverToolMap.keys());
      const updatedTools = new Set<string>();

      // Process each tool in the result
      for (const tool of toolsResult.tools) {
        updatedTools.add(tool.name);

        // Check if the tool exists and needs updating
        const existingTool = serverToolMap.get(tool.name);
        if (
          !existingTool ||
          JSON.stringify(existingTool) !== JSON.stringify(tool)
        ) {
          // Update or add the tool
          this.tools.set(tool.name, tool);
          serverToolMap.set(tool.name, tool);
          // Keep logs for tool changes
          log(`Updated tool: ${tool.name} from server ${serverId}`);
        }
      }

      // Remove tools that no longer exist
      for (const toolName of currentTools) {
        if (!updatedTools.has(toolName)) {
          serverToolMap.delete(toolName);
          // Only remove from global tools if no other server has it
          let stillExists = false;
          for (const [
            otherServerId,
            otherToolMap,
          ] of this.serverTools.entries()) {
            if (otherServerId !== serverId && otherToolMap.has(toolName)) {
              stillExists = true;
              break;
            }
          }

          if (!stillExists) {
            this.tools.delete(toolName);
            // Keep logs for tool removals
            log(`Removed tool: ${toolName} from server ${serverId}`);
          }
        }
      }
    } catch (error) {
      log(`Error refreshing tools for server ${serverId}: ${error}`);
      throw error;
    }
  }

  /**
   * Refreshes the prompts list for a specific server
   */
  private async refreshServerPrompts(
    serverId: string,
    client: Client,
  ): Promise<void> {
    try {
      // Check if the server has prompts capability before trying to access it
      const serverCapabilities = client.getServerCapabilities();
      if (!serverCapabilities?.prompts) {
        log(`Server ${serverId} does not support prompts, skipping prompt refresh`);
        return;
      }

      // Get available prompts
      log(`Requesting prompt list from server ${serverId}...`);
      const promptsResult = await client.listPrompts();
      log(`Received ${promptsResult.prompts.length} prompts from server ${serverId}`);

      // Create or get the server's prompt map
      let serverPromptMap = this.serverPrompts.get(serverId);
      if (!serverPromptMap) {
        serverPromptMap = new Map<string, Prompt>();
        this.serverPrompts.set(serverId, serverPromptMap);
      }

      // Keep track of which prompts were updated
      const currentPrompts = new Set(serverPromptMap.keys());
      const updatedPrompts = new Set<string>();

      // Process each prompt in the result
      for (const prompt of promptsResult.prompts) {
        updatedPrompts.add(prompt.name);

        // Check if the prompt exists and needs updating
        const existingPrompt = serverPromptMap.get(prompt.name);
        if (
          !existingPrompt ||
          JSON.stringify(existingPrompt) !== JSON.stringify(prompt)
        ) {
          // Update or add the prompt
          this.prompts.set(`${serverId}.${prompt.name}`, prompt);
          serverPromptMap.set(prompt.name, prompt);
          // Keep logs for prompt changes
          log(`Updated prompt: ${prompt.name} from server ${serverId}`);
        }
      }

      // Remove prompts that no longer exist
      for (const promptName of currentPrompts) {
        if (!updatedPrompts.has(promptName)) {
          serverPromptMap.delete(promptName);
          // Remove from global prompts map
          this.prompts.delete(`${serverId}.${promptName}`);
          // Keep logs for prompt removals
          log(`Removed prompt: ${promptName} from server ${serverId}`);
        }
      }
    } catch (error) {
      log(`Error refreshing prompts for server ${serverId}: ${error}`);
      // Don't throw here, since prompt failures shouldn't block tool updates
      // This allows servers without prompt support to still work
    }
  }

  /**
   * Disconnects server while keeping tool and prompt information for lazy loading
   */
  private async disconnectServerKeepingToolInfo(serverId: string): Promise<void> {
    log(`Disconnecting server ${serverId} while keeping tool info for lazy loading`);

    const client = this.clients.get(serverId);
    if (client) {
      try {
        await client.close();
      } catch (error) {
        log(`Error closing client for server ${serverId}: ${error}`);
      }

      this.clients.delete(serverId);
    }

    // Clean up transport
    const transport = this.transports.get(serverId);
    if (transport) {
      this.transports.delete(serverId);
    }

    // Clear any reconnection timers
    if (this.sseRetryIntervals.has(serverId)) {
      clearInterval(this.sseRetryIntervals.get(serverId)!);
      this.sseRetryIntervals.delete(serverId);
    }

    // Clear retry counts
    this.sseRetryCount.delete(serverId);

    // DO NOT remove tools and prompts - keep them for lazy loading
    // Just update the server state
    this.lazyServerStates.set(serverId, 'not-started');

    log(`Server ${serverId} disconnected but tools/prompts retained for lazy loading`);
  }

  /**
   * Disconnects and cleans up resources for a specific server
   */
  private async disconnectServer(serverId: string): Promise<void> {
    log(`Disconnecting server ${serverId}`);

    const client = this.clients.get(serverId);
    if (client) {
      try {
        await client.close();
      } catch (error) {
        log(`Error closing client for server ${serverId}: ${error}`);
      }

      this.clients.delete(serverId);
    }

    // Clean up transport
    const transport = this.transports.get(serverId);
    if (transport) {
      this.transports.delete(serverId);
    }

    // Clear any reconnection timers
    if (this.sseRetryIntervals.has(serverId)) {
      clearInterval(this.sseRetryIntervals.get(serverId)!);
      this.sseRetryIntervals.delete(serverId);
    }

    // Clear retry counts
    this.sseRetryCount.delete(serverId);

    // Remove tools for this server
    const serverToolMap = this.serverTools.get(serverId);
    if (serverToolMap) {
      // For each tool in this server
      for (const [toolName, _] of serverToolMap.entries()) {
        // Check if tool exists in other servers
        let stillExists = false;
        for (const [
          otherServerId,
          otherToolMap,
        ] of this.serverTools.entries()) {
          if (otherServerId !== serverId && otherToolMap.has(toolName)) {
            stillExists = true;
            break;
          }
        }

        // If tool doesn't exist elsewhere, remove from global map
        if (!stillExists) {
          this.tools.delete(toolName);
        }
      }

      // Remove the server's tool map
      this.serverTools.delete(serverId);
    }
    
    // Remove prompts for this server
    const serverPromptMap = this.serverPrompts.get(serverId);
    if (serverPromptMap) {
      // For each prompt in this server
      for (const [promptName, _] of serverPromptMap.entries()) {
        // Remove from global prompts map
        this.prompts.delete(`${serverId}.${promptName}`);
      }
      
      // Remove the server's prompt map
      this.serverPrompts.delete(serverId);
    }

    // Clear lazy loading state
    this.lazyServerStates.delete(serverId);

    log(`Server ${serverId} disconnected`);
  }

  /**
   * Retrieves a prompt from a server and returns the formatted content
   * @param fullName The full prompt name (serverName.promptName)
   * @param args The arguments for the prompt (if any)
   * @returns The prompt content as a string
   */
  public async getPrompt(
    fullName: string,
    args?: Record<string, string>,
  ): Promise<string> {
    log(`getPrompt called for ${fullName} with args: ${JSON.stringify(args || {})}`);
    
    // Parse the fullName to get serverName and actualPromptName
    const dotIndex = fullName.indexOf(".");
    if (dotIndex <= 0 || dotIndex >= fullName.length - 1) {
      return `Error: Prompt name "${fullName}" does not follow the expected "serverName.promptName" format.`;
    }
    
    const serverName = fullName.substring(0, dotIndex);
    const promptName = fullName.substring(dotIndex + 1);
    log(`Parsed prompt name: server="${serverName}", prompt="${promptName}"`);
    
    // Ensure server is connected for prompt execution
    try {
      await this.ensureServerConnected(serverName);
    } catch (error) {
      return `Error: Failed to connect to MCP server "${serverName}": ${error}`;
    }
    
    // Get the specific client for the server
    const client = this.clients.get(serverName);
    if (!client) {
      return `Error: MCP server "${serverName}" not found or not connected.`;
    }
    
    // Check if the server supports prompts
    const serverCapabilities = client.getServerCapabilities();
    if (!serverCapabilities?.prompts) {
      return `Error: Server "${serverName}" does not support prompts.`;
    }
    
    try {
      // Get the prompt from the server
      log(`Requesting prompt "${promptName}" from server "${serverName}"`);
      const promptResult = await client.getPrompt({
        name: promptName,
        arguments: args
      });
      
      // Extract and format the prompt content
      if (promptResult && promptResult.messages) {
        // Format messages into a string
        let result = '';
        for (const message of promptResult.messages) {
          // Don't add "# %% user" block, just use the content directly
          if (message.role === 'user') {
            result += `${message.content.text}\n\n`;
          } else if (message.role === 'assistant') {
            result += `# %% assistant\n${message.content.text}\n\n`;
          }
        }
        return result.trim();
      }
      
      return `Error: Invalid prompt result format from server "${serverName}"`;
    } catch (error) {
      log(`Error getting prompt ${promptName} from server ${serverName}: ${error}`);
      return `Error: Failed to get prompt "${promptName}" from server "${serverName}": ${error}`;
    }
  }

  /**
   * Cleans up all MCP client connections and resources
   */
  public async cleanup(): Promise<void> {
    // Stop the background refresh interval
    this.stopBackgroundRefresh();

    // Close all connections
    for (const [serverId, _] of this.clients.entries()) {
      await this.disconnectServer(serverId);
    }

    this.clients.clear();
    this.tools.clear();
    this.prompts.clear();
    this.serverTools.clear();
    this.serverPrompts.clear();
    this.transports.clear();
    this.sseRetryCount.clear();
    this.lazyServerStates.clear();
    this.pendingConnections.clear();
    this.serverConfigs = {};
  }

  /**
   * Generates a diagnostic report about the MCP clients and connections
   */
  public async generateDiagnosticsReport(): Promise<string> {
    const lines: string[] = [];

    const totalConfiguredServers = Object.keys(this.serverConfigs).length;
    const connectedServers = Array.from(this.lazyServerStates.entries())
      .filter(([_, state]) => state === 'connected').length;
    const lazyServers = Array.from(this.lazyServerStates.entries())
      .filter(([_, state]) => state === 'not-started').length;

    lines.push(`Total configured MCP servers: ${totalConfiguredServers}`);
    lines.push(`Currently connected servers: ${connectedServers}`);
    lines.push(`Lazy (not yet started) servers: ${lazyServers}`);
    lines.push(`Total registered tools: ${this.tools.size}`);
    lines.push(`Total registered prompts: ${this.prompts.size}`);
    lines.push("");

    // Show all configured servers with their state
    for (const serverId of Object.keys(this.serverConfigs)) {
      const state = this.lazyServerStates.get(serverId) || 'unknown';
      const client = this.clients.get(serverId);
      const transport = this.transports.get(serverId);
      const transportType = transport instanceof StdioClientTransport ? "stdio" : "sse";
      const toolCount = this.serverTools.get(serverId)?.size || 0;
      const promptCount = this.serverPrompts.get(serverId)?.size || 0;

      lines.push(`Server: ${serverId}`);
      lines.push(`  State: ${state}`);
      if (client) {
        lines.push(`  Transport type: ${transportType}`);
      }
      lines.push(`  Tools: ${toolCount}`);
      lines.push(`  Prompts: ${promptCount}`);

      if (toolCount > 0) {
        lines.push("  Tool list:");
        for (const toolName of this.serverTools.get(serverId)?.keys() || []) {
          lines.push(`    - ${toolName}`);
        }
      }
      
      if (promptCount > 0) {
        lines.push("  Prompt list:");
        for (const promptName of this.serverPrompts.get(serverId)?.keys() || []) {
          lines.push(`    - ${promptName}`);
        }
      }

      if (state === 'connected' && transportType === "sse") {
        const retryCount = this.sseRetryCount.get(serverId) || 0;
        lines.push(`  SSE retry count: ${retryCount}`);
        lines.push(
          `  SSE retry timer active: ${this.sseRetryIntervals.has(serverId) ? "Yes" : "No"}`,
        );
      }

      lines.push("");
    }

    return lines.join("\n");
  }

  // Private helper method for the core tool execution logic
  private async _executeToolOnClient(
    client: Client,
    serverId: string,
    toolName: string,
    tool: Tool,
    params: Record<string, string>,
    document?: vscode.TextDocument | null,
    signal?: AbortSignal,
  ): Promise<string> {
    try {
      log(
        `Executing tool "${toolName}" on server "${serverId}" with string parameters: ${JSON.stringify(params)}`,
      );

      // Process parameters according to the tool's schema
      const processedParams: Record<string, any> = {};
      const toolSchema = tool.inputSchema?.properties || {};

      // Process each parameter - try JSON parsing for all string values first
      for (const [paramName, paramValue] of Object.entries(params)) {
        const paramSchema = toolSchema[paramName] as
          | { type?: string }
          | undefined;

        // Try to parse JSON for all string parameters first
        try {
          const parsedValue = JSON.parse(paramValue);
          log(
            `Parameter "${paramName}" for tool "${toolName}" successfully parsed as JSON`,
          );
          processedParams[paramName] = parsedValue;
        } catch (e) {
          // If JSON parsing fails, check if schema expects object/array types
          if (
            paramSchema?.type &&
            (paramSchema.type === "object" || paramSchema.type === "array")
          ) {
            log(
              `Parameter "${paramName}" for tool "${toolName}" has type ${paramSchema.type} in schema but failed JSON parsing, keeping as string: ${e}`,
            );
          }
          // Keep as string for all parsing failures
          processedParams[paramName] = paramValue;
        }
      }

      // Listen for abort signal to log cancellation
      if (signal) {
        signal.addEventListener('abort', () => {
          log(`Abort signal triggered for tool "${toolName}" on server "${serverId}"`);
        });
      }
      
      const result = await client.callTool(
        {
          name: toolName, // Use the actual tool name here
          arguments: processedParams,
        }, 
        undefined, // Use default result schema
        { signal } // Pass the abort signal in the options
      );

      // Process result content which may include both text and images
      if (result && result.content && Array.isArray(result.content)) {
        // Check if there are any image items in the content
        const hasImageContent = result.content.some((item: any) => item.type === "image");
        
        if (hasImageContent) {
          // If there are images, process the mixed content using a special handler
          // Make sure we pass the document parameter to processMixedToolResult
          return this.processMixedToolResult(result.content, serverId, toolName, document);
        } else {
          // Process text-only content as before
          const resultText = result.content
            .filter((item: any) => item.type === "text")
            .map((item: any) => item.text)
            .join("\n");

          return resultText;
        }
      }

      return "Error: Invalid result format from MCP tool";
    } catch (error) {
      // Logged by the caller, rethrow to be handled there
      throw error;
    }
    }
  
    /**
     * Process tool result that contains mixed content (text and images)
     * Saves images to disk and returns a formatted result with markdown links
     * @param content The content array from the tool result
     * @param serverId The server ID that executed the tool
     * @param toolName The name of the tool that was executed
     * @param document The current document (for resolving relative paths)
     * @returns A formatted string with text content and markdown links to saved images
     */
    private processMixedToolResult(
      content: any[],
      serverId: string,
      toolName: string,
      document?: vscode.TextDocument | null
    ): string {
      try {
        log(`Processing mixed content result from tool ${toolName} on server ${serverId}`);
        
        // Create cmdassets directory:
        // If we have a document, create directory relative to it
        // Otherwise fall back to extension root
        let assetsDir;
        let relativePath;
        
        if (document) {
          // Get directory of the current document and create cmdassets within it
          const docDir = path.dirname(document.uri.fsPath);
          assetsDir = path.join(docDir, "cmdassets");
          relativePath = "cmdassets"; // Relative to the chat document
          log(`Using document-relative assets directory: ${assetsDir}`);
        } else {
          // Fallback to extension root if no document provided
          const rootDir = path.resolve(__dirname, "..", "..");
          assetsDir = path.join(rootDir, "samples", "cmdassets");
          relativePath = path.join("samples", "cmdassets");
          log(`No document provided, using extension root assets directory: ${assetsDir}`);
        }
        
        if (!fs.existsSync(assetsDir)) {
          fs.mkdirSync(assetsDir, { recursive: true });
          log(`Created assets directory: ${assetsDir}`);
        }
        
        // Process each content item
        const processedParts: string[] = [];
        // Track the number of images to provide sequential numbering
        let imageCount = 0;
        // Track if the previous item was text to optimize spacing
        let prevItemWasText = false;
        
        for (const item of content) {
          if (item.type === "text") {
            // Add text content directly
            // If previous item was also text, we may want to preserve some formatting
            if (prevItemWasText && processedParts.length > 0) {
              // If the text starts with a list, heading, or other markdown structure, 
              // we need a paragraph break
              if (/^[#\-\*\d]/.test(item.text.trimStart())) {
                processedParts.push(item.text);
              } else {
                // For continuing text, append to the previous text with just a space in between
                processedParts[processedParts.length - 1] += "\n\n" + item.text;
              }
            } else {
              processedParts.push(item.text);
            }
            prevItemWasText = true;
          } 
          else if (item.type === "image" && item.data && item.mimeType) {
            try {
              // Increment image counter
              imageCount++;
              
              // For image content, save the image to disk
              const date = new Date();
              const timestamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}-${String(date.getHours()).padStart(2, "0")}${String(date.getMinutes()).padStart(2, "0")}${String(date.getSeconds()).padStart(2, "0")}`;
              const randomSuffix = Math.random().toString(36).substring(2, 8);
              
              // Determine file extension based on MIME type
              let fileExtension = ".png"; // Default
              if (item.mimeType === "image/jpeg" || item.mimeType === "image/jpg") {
                fileExtension = ".jpg";
              } else if (item.mimeType === "image/gif") {
                fileExtension = ".gif";
              } else if (item.mimeType === "image/webp") {
                fileExtension = ".webp";
              }
              
              const filename = `tool-image-${timestamp}-${randomSuffix}${fileExtension}`;
              const imagePath = path.join(assetsDir, filename);
              
              // Decode base64 data and save to file
              const imageBuffer = Buffer.from(item.data, 'base64');
              fs.writeFileSync(imagePath, imageBuffer);
              
              log(`Saved image #${imageCount} from tool result to: ${imagePath}`);
              
              // Create a markdown link to the image using the relative path with sequential numbering
              const relativeImagePath = path.join(relativePath, filename).replace(/\\/g, "/");
              // If there are multiple images, add numbering to the alt text
              const altText = content.filter(i => i.type === "image").length > 1 
                ? `Tool generated image ${imageCount}` 
                : `Tool generated image`;
              const markdownLink = `![${altText}](${relativeImagePath})`;
              
              // Add the markdown link to the processed parts
              processedParts.push(markdownLink);
              prevItemWasText = false;
            } catch (imageError) {
              log(`Error saving image from tool result: ${imageError}`);
              processedParts.push(`[Error saving image ${imageCount}: ${imageError}]`);
              prevItemWasText = true; // Error message is text
            }
          }
          else if (item.type === "image") {
            // Image without required data
            imageCount++; // Still count it for consistency
            log(`Image content missing required fields: ${JSON.stringify(item)}`);
            processedParts.push(`[Image ${imageCount} data invalid or missing]`);
            prevItemWasText = true; // Error message is text
          }
        }
        
        // Intelligently join the content:
        // This approach maintains proper markdown formatting while avoiding excessive spacing
        const result = processedParts.join("\n\n");
        log(`Processed ${processedParts.length} content items (${imageCount} images)`);
        return result;
      } catch (error) {
        log(`Error processing mixed tool result: ${error}`);
        return `Error processing tool result: ${error}`;
      }
    }
  }
