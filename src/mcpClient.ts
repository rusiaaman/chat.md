import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { log } from "./extension";

export interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export class McpClientManager {
  private clients: Map<string, Client> = new Map();
  private tools: Map<string, Tool> = new Map();
  private serverTools: Map<string, Map<string, Tool>> = new Map();
  
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
    
    log(`Connecting to MCP server ${serverId} with command: ${config.command}`);
    
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: combinedEnv
    });
    
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
      await client.connect(transport);
      this.clients.set(serverId, client);
      
      // Get available tools
      const toolsResult = await client.listTools();
      
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