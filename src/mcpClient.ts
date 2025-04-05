import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { log } from "./extension";

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
  private serverTools: Map<string, Map<string, Tool>> = new Map();
  private transports: Map<string, Transport> = new Map();
  private sseRetryIntervals: Map<string, NodeJS.Timeout> = new Map();
  private sseMaxRetries: number = 5;
  private sseRetryCount: Map<string, number> = new Map();
  
  // Initialize MCP clients from configuration
  public async initializeClients(mcpServers: Record<string, McpServerConfig>): Promise<void> {
    // Clear existing clients and tools
    this.clients.clear();
    this.tools.clear();
    this.serverTools.clear();
    
    // Initialize each configured server
    for (const [serverId, config] of Object.entries(mcpServers)) {
      try {
        await this.connectServer(serverId, config);
      } catch (error) {
        log(`Failed to connect to MCP server ${serverId}: ${error}`);
      }
    }
  }
  
  // Connect to a single MCP server
  private async connectServer(serverId: string, config: McpServerConfig): Promise<void> {
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
        log(`Parsed SSE URL: ${parsedUrl.href} (protocol: ${parsedUrl.protocol}, host: ${parsedUrl.host}, path: ${parsedUrl.pathname})`);
        
        // SSE transport - pass the URL object, not string
        log(`Connecting to MCP server ${serverId} with SSE URL: ${parsedUrl.href}`);
        transport = new SSEClientTransport(parsedUrl);
        
        // Log transport details
        log(`Created SSE transport for ${serverId}`);
        
        // Set up reconnection logic for SSE
        this.setupSSEReconnection(serverId, config, transport as SSEClientTransport);
      } catch (error) {
        log(`Error creating SSE transport for server ${serverId}: ${error}`);
        log(`Invalid URL format: "${config.url}". URLs must include protocol (http:// or https://)`);
        throw new Error(`Invalid URL format for SSE server ${serverId}: ${error.message}`);
      }
    } else if (config.command) {
      // Stdio transport
      log(`Connecting to MCP server ${serverId} with command: ${config.command}`);
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args || [],
        env: combinedEnv
      });
    } else {
      throw new Error(`Invalid MCP server configuration for ${serverId}: must specify either 'url' for SSE or 'command' for stdio`);
    }
    
    // Store the transport for later reference
    this.transports.set(serverId, transport);
    
    const client = new Client({ 
      name: "filechat", 
      version: "0.1.0" 
    }, {
      capabilities: {
        tools: {}  // Only request tools capability
      }
    });
    
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
        log(`Tool schema for ${tool.name}:\n${JSON.stringify(tool.inputSchema, null, 2)}`);
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
        if (error.message.includes('ECONNREFUSED')) {
          log(`Connection refused: The SSE server at ${config.url} is not running or not accessible`);
        } else if (error.message.includes('SSL')) {
          log(`SSL Error: There might be an issue with the SSL certificate or HTTPS connection`);
        } else if (error.message.includes('timeout')) {
          log(`Connection timeout: The server took too long to respond`);
        } else if (error.message.includes('invalid or illegal string')) {
          log(`Invalid URL format or response: Check that the URL format is correct and the server is returning proper SSE format`);
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

  // Get tools grouped by server ID
  public getGroupedTools(): Map<string, Map<string, Tool>> {
    return this.serverTools;
  }
  // Execute a tool through the appropriate MCP client
  // Tool name is expected in the format "serverName.toolName"
  public async executeToolCall(fullName: string, params: Record<string, string>): Promise<string> {
    // Parse the fullName to get serverName and actualToolName
    const dotIndex = fullName.indexOf('.');
    let serverName: string | undefined = undefined;
    let actualToolName: string = fullName; // Default to fullName if parsing fails

    if (dotIndex > 0 && dotIndex < fullName.length - 1) {
      serverName = fullName.substring(0, dotIndex);
      actualToolName = fullName.substring(dotIndex + 1);
      log(`Parsed tool name: server="${serverName}", tool="${actualToolName}"`);
    } else {
      log(`Warning: Tool name "${fullName}" does not follow the expected "serverName.toolName" format. Falling back to legacy lookup.`);
      // Fallback: Use the old method of iterating through all servers
      return this.executeToolCallLegacyFallback(fullName, params);
    }

    // --- New Logic using parsed serverName and actualToolName ---

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
      return await this._executeToolOnClient(client, serverName, actualToolName, tool, params);
    } catch (error) {
      log(`Error executing tool ${actualToolName} on server ${serverName}: ${error}`);
      return `Error executing tool ${actualToolName}: ${error}`;
    }
  }

  // Fallback method for the old way of finding the tool across all servers
  private async executeToolCallLegacyFallback(name: string, params: Record<string, string>): Promise<string> {
     log(`Executing legacy fallback for tool "${name}"`);
     // Find which client has this tool and execute it
     for (const [serverId, serverToolMap] of this.serverTools.entries()) {
       const tool = serverToolMap.get(name);
       if (!tool) {
         continue; // This server doesn't have this tool
       }

       const client = this.clients.get(serverId);
       if (!client) {
         continue; // Shouldn't happen but check anyway
       }

       try {
         return await this._executeToolOnClient(client, serverId, name, tool, params);
       } catch (error) {
         log(`Error executing tool ${name} on server ${serverId} (fallback): ${error}`);
         // Continue searching on other servers in case of error? Or return error immediately?
         // For now, return the error from the first server that failed.
         return `Error executing tool ${name}: ${error}`;
       }
     }

     // If loop completes without finding the tool
     return `Error: Tool "${name}" not found on any connected server.`;
  }
  
  /**
   * Sets up SSE-specific reconnection logic for a server
   */
  private setupSSEReconnection(serverId: string, config: McpServerConfig, transport: SSEClientTransport): void {
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
    if (typeof transport.onclose === 'function') {
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
      log(`Exceeded maximum retry attempts (${this.sseMaxRetries}) for SSE server ${serverId}`);
      this.sseRetryCount.delete(serverId);
      return;
    }
    
    // Increment retry count
    this.sseRetryCount.set(serverId, retryCount + 1);
    
    // Set up retry with exponential backoff
    const backoffTime = Math.min(30000, 1000 * Math.pow(2, retryCount));
    log(`Will attempt to reconnect to SSE server ${serverId} in ${backoffTime}ms (retry ${retryCount + 1}/${this.sseMaxRetries})`);
    
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
   * Cleans up all MCP client connections and resources
   */
  public async cleanup(): Promise<void> {
    // Close all connections
    for (const [serverId, client] of this.clients.entries()) {
      try {
        await client.close();
        
        // Clear any reconnection timers
        if (this.sseRetryIntervals.has(serverId)) {
          clearInterval(this.sseRetryIntervals.get(serverId)!);
          this.sseRetryIntervals.delete(serverId);
        }
      } catch (error) {
        log(`Error closing client ${serverId}: ${error}`);
      }
    }
    
    this.clients.clear();
    this.tools.clear();
    this.serverTools.clear();
    this.transports.clear();
    this.sseRetryCount.clear();
  }
  
  /**
   * Generates a diagnostic report about the MCP clients and connections
   */
  public async generateDiagnosticsReport(): Promise<string> {
    const lines: string[] = [];
    
    lines.push(`Total MCP servers: ${this.clients.size}`);
    lines.push(`Total registered tools: ${this.tools.size}`);
    lines.push('');
    
    for (const [serverId, client] of this.clients.entries()) {
      const transport = this.transports.get(serverId);
      const transportType = transport instanceof StdioClientTransport ? 'stdio' : 'sse';
      const toolCount = this.serverTools.get(serverId)?.size || 0;
      
      lines.push(`Server: ${serverId}`);
      lines.push(`  Transport type: ${transportType}`);
      lines.push(`  Tools: ${toolCount}`);
      
      if (toolCount > 0) {
        lines.push('  Tool list:');
        for (const toolName of this.serverTools.get(serverId)?.keys() || []) {
          lines.push(`    - ${toolName}`);
        }
      }
      
      if (transportType === 'sse') {
        const retryCount = this.sseRetryCount.get(serverId) || 0;
        lines.push(`  SSE retry count: ${retryCount}`);
        lines.push(`  SSE retry timer active: ${this.sseRetryIntervals.has(serverId) ? 'Yes' : 'No'}`);
      }
      
      lines.push('');
    }
    
    return lines.join('\n');
  }

  // Private helper method for the core tool execution logic
  private async _executeToolOnClient(client: Client, serverId: string, toolName: string, tool: Tool, params: Record<string, string>): Promise<string> {
    try {
      log(`Executing tool "${toolName}" on server "${serverId}" with string parameters: ${JSON.stringify(params)}`);

      // Process parameters according to the tool's schema
      const processedParams: Record<string, any> = {};
      const toolSchema = tool.inputSchema?.properties || {};

      // Process each parameter based on its declared type in the schema
      for (const [paramName, paramValue] of Object.entries(params)) {
        const paramSchema = toolSchema[paramName] as { type?: string } | undefined;

        // For parameters that are declared as objects or arrays in the schema,
        // we might need to parse the JSON string to match the expected type
        if (paramSchema?.type && (paramSchema.type === 'object' || paramSchema.type === 'array')) {
          try {
            // Log that we're parsing the JSON string
            log(`Parameter "${paramName}" for tool "${toolName}" has type ${paramSchema.type} in schema, attempting to parse JSON`);
            processedParams[paramName] = JSON.parse(paramValue);
          } catch (e) {
            // If parsing fails, keep as string
            log(`Failed to parse JSON for parameter "${paramName}" of tool "${toolName}", keeping as string: ${e}`);
            processedParams[paramName] = paramValue;
          }
        } else {
          // Keep as string for all other types
          processedParams[paramName] = paramValue;
        }
      }

      const result = await client.callTool({
        name: toolName, // Use the actual tool name here
        arguments: processedParams
      });

      // Convert result to string format
      if (result && result.content && Array.isArray(result.content)) {
        const resultText = result.content
          .filter((item: any) => item.type === 'text')
          .map((item: any) => item.text)
          .join('\n');

        return resultText;
      }

      return "Error: Invalid result format from MCP tool";
    } catch (error) {
      // Logged by the caller, rethrow to be handled there
      throw error;
    }
  }
}