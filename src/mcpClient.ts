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
  
  // Get all tool objects with their original schemas
  public getAllTools(): Tool[] {
    return Array.from(this.tools.values());
  }
  
  // Execute a tool through the appropriate MCP client
  public async executeToolCall(name: string, params: Record<string, string>): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      return `Error: Tool "${name}" not found`;
    }
    
    // Find which client has this tool and execute it
    for (const [serverId, serverToolMap] of this.serverTools.entries()) {
      if (!serverToolMap.has(name)) {
        continue; // This server doesn't have this tool
      }
      
      const client = this.clients.get(serverId);
      if (!client) {
        continue; // Shouldn't happen but check anyway
      }
      
      try {
        log(`Executing tool "${name}" with string parameters: ${JSON.stringify(params)}`);
        
        // Process parameters according to the tool's schema
        const processedParams: Record<string, any> = {};
        const toolSchema = tool.inputSchema?.properties || {};
        
        // Process each parameter based on its declared type in the schema
        for (const [paramName, paramValue] of Object.entries(params)) {
          const paramSchema = toolSchema[paramName];
          
          // For parameters that are declared as objects or arrays in the schema,
          // we might need to parse the JSON string to match the expected type
          if (paramSchema && (paramSchema.type === 'object' || paramSchema.type === 'array')) {
            try {
              // Log that we're parsing the JSON string
              log(`Parameter "${paramName}" has type ${paramSchema.type} in schema, attempting to parse JSON`);
              processedParams[paramName] = JSON.parse(paramValue);
            } catch (e) {
              // If parsing fails, keep as string
              log(`Failed to parse JSON for parameter "${paramName}", keeping as string: ${e}`);
              processedParams[paramName] = paramValue;
            }
          } else {
            // Keep as string for all other types
            processedParams[paramName] = paramValue;
          }
        }
        
        const result = await client.callTool({
          name,
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
        log(`Error executing tool ${name} on server ${serverId}: ${error}`);
        return `Error executing tool ${name}: ${error}`;
      }
    }
    
    return `Error: No server available to execute tool "${name}"`;
  }
}