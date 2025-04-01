import * as vscode from 'vscode';
import { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * API Configuration interface
 */
export interface ApiConfig {
  type: 'anthropic' | 'openai';
  apiKey: string;
  model_name?: string;
  base_url?: string;
}

/**
 * Dictionary of API configurations
 */
export type ApiConfigs = Record<string, ApiConfig>;

/**
 * Generate system prompt for tool calling, including MCP tools
 * @param mcpTools Array of MCP tools to include in the prompt
 * @returns The system prompt string
 */
export function generateToolCallingSystemPrompt(mcpTools: Tool[] = []): string {
  const mcpToolsDescription = mcpTools.map((tool, index) => `
${index + 1}. ${tool.name} - ${tool.description || ''}
   Input Schema: 
   \`\`\`json
   ${JSON.stringify(tool.inputSchema, null, 2)}
   \`\`\`
`).join('');

  // Return a different message if no tools are available
  if (mcpTools.length === 0) {
    return `
You are an AI assistant helping the user with their tasks. Currently, no external tools are available.
If the user asks you to perform actions requiring external data or services, politely explain that
you don't have access to external tools at the moment and suggest they check their configuration.
`;
  }

  return `
This AI assistant can use tools to perform actions when needed to complete the user's requests. Use the following XML-like format to call a tool, preferably inside a code fence block:

\`\`\`
<tool_call>
<tool_name>toolName</tool_name>
<param name="paramName">paramValue</param>
</tool_call>
\`\`\`

IMPORTANT FORMATTING REQUIREMENTS:
1. Always use double quotes around parameter names: name="paramName"
2. Parameter values can be inline (no newlines required)
3. Parameter names must exactly match those in the tool's schema
4. Preferably place the tool call within code fence blocks, though the parser will accept tool calls without fences as well

Available tools:${mcpToolsDescription}
   
After calling a tool, wait for the result which will be provided in the following format:

<tool_result>
The content or result of the tool execution will appear here.
</tool_result>

Tool usage guidelines:
- Only use tools when necessary to fulfill the user's request
- Always wait for tool results before continuing
- Use the exact format shown above - it's a simplified XML-like format, not strict XML
- You don't need to worry about CDATA tags or XML escaping
- Make sure to use correct parameter names with quotes (name="paramName")
- For scalar parameters (string, number, boolean), write values directly without quotes
- For object/array type parameters, use properly encoded JSON format
`;
}

/**
 * Default system prompt for backward compatibility
 */
export const TOOL_CALLING_SYSTEM_PROMPT = generateToolCallingSystemPrompt();

/**
 * Gets all API configurations
 */
export function getApiConfigs(): ApiConfigs {
  return vscode.workspace.getConfiguration().get('filechat.apiConfigs') || {};
}

/**
 * Gets the currently selected configuration name
 */
export function getSelectedConfigName(): string | undefined {
  return vscode.workspace.getConfiguration().get('filechat.selectedConfig');
}

/**
 * Gets the currently selected configuration
 */
export function getSelectedConfig(): ApiConfig | undefined {
  const configName = getSelectedConfigName();
  if (!configName) {
    return undefined;
  }
  
  const configs = getApiConfigs();
  return configs[configName];
}

/**
 * Sets the selected configuration
 */
export async function setSelectedConfig(configName: string): Promise<void> {
  await vscode.workspace.getConfiguration().update(
    'filechat.selectedConfig',
    configName,
    vscode.ConfigurationTarget.Global
  );
}

/**
 * Adds or updates an API configuration
 */
export async function setApiConfig(name: string, config: ApiConfig): Promise<void> {
  const configs = getApiConfigs();
  configs[name] = config;
  
  await vscode.workspace.getConfiguration().update(
    'filechat.apiConfigs',
    configs,
    vscode.ConfigurationTarget.Global
  );
}

/**
 * Removes an API configuration
 */
export async function removeApiConfig(name: string): Promise<boolean> {
  const configs = getApiConfigs();
  if (configs[name]) {
    delete configs[name];
    
    await vscode.workspace.getConfiguration().update(
      'filechat.apiConfigs',
      configs,
      vscode.ConfigurationTarget.Global
    );
    
    // If the removed config was selected, clear the selection
    const selectedConfig = getSelectedConfigName();
    if (selectedConfig === name) {
      await setSelectedConfig('');
    }
    
    return true;
  }
  return false;
}

/**
 * Gets the current provider type from the selected configuration
 */
export function getProvider(): string {
  const config = getSelectedConfig();
  if (!config) {
    throw new Error('No API configuration selected. Please select a configuration first.');
  }
  
  return config.type;
}

/**
 * Gets the API key from the selected configuration
 */
export function getApiKey(): string {
  const config = getSelectedConfig();
  if (!config) {
    throw new Error('No API configuration selected. Please select a configuration first.');
  }
  
  return config.apiKey;
}

/**
 * Gets the model name from the selected configuration
 */
export function getModelName(): string | undefined {
  const config = getSelectedConfig();
  if (!config) {
    throw new Error('No API configuration selected. Please select a configuration first.');
  }
  
  return config.model_name;
}

/**
 * Gets the base URL from the selected configuration
 * Returns undefined if the base_url is empty or not set
 */
export function getBaseUrl(): string | undefined {
  const config = getSelectedConfig();
  if (!config) {
    throw new Error('No API configuration selected. Please select a configuration first.');
  }
  
  return config.base_url && config.base_url.trim() !== '' ? config.base_url : undefined;
}