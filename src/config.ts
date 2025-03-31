import * as vscode from 'vscode';
import { Tool } from "@modelcontextprotocol/sdk/types.js";

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
This AI assistant can use tools to perform actions when needed to complete the user's requests. Use the following XML-like format to call a tool:

<tool_call>
<tool_name>toolName</tool_name>
<param name="paramName">paramValue</param>
</tool_call>

IMPORTANT FORMATTING REQUIREMENTS:
1. Always use double quotes around parameter names: name="paramName"
2. Parameter values can be inline (no newlines required)
3. Parameter names must exactly match those in the tool's schema

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
 * Gets the configured provider (anthropic or openai)
 * Returns 'anthropic' as default if not configured
 */
export function getProvider(): string {
  return vscode.workspace.getConfiguration().get('filechat.provider') || 'anthropic';
}

/**
 * Gets the configured model name for the current provider
 * Returns undefined to use the default model for each provider
 */
export function getModelName(): string | undefined {
  return vscode.workspace.getConfiguration().get('filechat.model_name');
}

/**
 * Gets the configured base URL for the OpenAI API
 * Returns undefined to use the default OpenAI base URL
 * This is only used when provider is 'openai'
 */
export function getBaseUrl(): string | undefined {
  return vscode.workspace.getConfiguration().get('filechat.base_url');
}

/**
 * Sets the base URL in configuration
 */
export async function setBaseUrl(baseUrl: string): Promise<void> {
  await vscode.workspace.getConfiguration().update(
    'filechat.base_url',
    baseUrl,
    vscode.ConfigurationTarget.Global
  );
}

/**
 * Sets the model name in configuration
 */
export async function setModelName(modelName: string): Promise<void> {
  await vscode.workspace.getConfiguration().update(
    'filechat.model_name',
    modelName,
    vscode.ConfigurationTarget.Global
  );
}

/**
 * Sets the provider in configuration
 */
export async function setProvider(provider: string): Promise<void> {
  await vscode.workspace.getConfiguration().update(
    'filechat.provider',
    provider,
    vscode.ConfigurationTarget.Global
  );
}

/**
 * Gets the configured API key for the current provider
 * Returns undefined if not configured
 */
export function getApiKey(): string | undefined {
  return vscode.workspace.getConfiguration().get('filechat.apiKey');
}

/**
 * Sets the API key in configuration
 */
export async function setApiKey(apiKey: string): Promise<void> {
  await vscode.workspace.getConfiguration().update(
    'filechat.apiKey',
    apiKey,
    vscode.ConfigurationTarget.Global
  );
}

/**
 * Gets the configured Anthropic API key (legacy)
 * Returns undefined if not configured
 */
export function getAnthropicApiKey(): string | undefined {
  // Try the new unified API key first if provider is anthropic
  if (getProvider() === 'anthropic') {
    const apiKey = getApiKey();
    if (apiKey) {
      return apiKey;
    }
  }
  
  // Fall back to legacy anthropic-specific key
  return vscode.workspace.getConfiguration().get('filechat.anthropicApiKey');
}

/**
 * Sets the Anthropic API key (legacy)
 */
export async function setAnthropicApiKey(apiKey: string): Promise<void> {
  // If we're using anthropic as provider, set the unified key too
  if (getProvider() === 'anthropic') {
    await setApiKey(apiKey);
  }
  
  // Also set the legacy key for backward compatibility
  await vscode.workspace.getConfiguration().update(
    'filechat.anthropicApiKey',
    apiKey,
    vscode.ConfigurationTarget.Global
  );
}