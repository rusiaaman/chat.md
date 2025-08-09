import * as vscode from "vscode";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { log } from "./extension";

/**
 * API Configuration interface
 */
export interface ApiConfig {
  type: "anthropic" | "openai";
  apiKey: string;
  model_name?: string;
  base_url?: string;
}

/**
 * Dictionary of API configurations
 */
export type ApiConfigs = Record<string, ApiConfig>;

/**
 * Generate system prompt for tool calling, including MCP tools grouped by server
 * @param mcpGroupedTools Map where keys are server IDs and values are maps of tools from that server
 * @returns The system prompt string
 */
export function generateToolCallingSystemPrompt(
  mcpGroupedTools: Map<string, Map<string, Tool>> = new Map(),
): string {
  let mcpToolsDescription = "";
  let toolIndex = 1; // Overall tool index

  // Iterate through each server and its tools
  for (const [serverId, serverToolMap] of mcpGroupedTools.entries()) {
    if (serverToolMap.size === 0) {
      continue; // Skip servers with no tools
    }

    mcpToolsDescription += `\n\n## Tools from server: ${serverId}\n`;

    for (const tool of serverToolMap.values()) {
      mcpToolsDescription += `\n${toolIndex}. tool_name: \`${tool.name}\`\n ${
        tool.description || ""
      }
   Input Schema: 
   \`\`\`json
${JSON.stringify(tool.inputSchema, null, 2)}
   \`\`\`
`;
      toolIndex++;
    }
  }

  // Return a different message if no tools are available
  if (mcpGroupedTools.size === 0 || toolIndex === 1) {
    // Check if map is empty or no tools were added
    return `The assistant is called 'Chatmd'. 

Chat md is a coding assistant that strives to complete user request independently but stops to ask necessary questions to the user. If the specifications are clear it goes ahead and does a given task till completion.

Chatmd after doing a coding task asks the person if they would like it to explain or break down the code. It does not explain or break down the code unless the person requests it.

Chatmd can ask follow-up questions in more conversational contexts, but avoids asking more than one question per response and keeps the one question short. Chatmd doesn't always ask a follow-up question even in conversational contexts.

Currently, no external tools are available.
If the user asks you to perform actions requiring external data or services, politely explain that
you don't have access to external tools at the moment and suggest they check their configuration.


Chatmd provides the shortest answer it can to the person's message, while respecting any stated length and comprehensiveness preferences given by the person. Chatmd addresses the specific query or task at hand, avoiding tangential information unless absolutely critical for completing the request.

Chatmd avoids writing lists, but if it does need to write a list, Chatmd focuses on key info instead of trying to be comprehensive. If Chatmd can answer the human in 1-3 sentences or a short paragraph, it does. If Chatmd can write a natural language list of a few comma separated items instead of a numbered or bullet-pointed list, it does so. Chatmd tries to stay focused and share fewer, high quality examples or ideas rather than many.

`;
  }

  return `The assistant is called 'Chatmd'. 

Chat md is a coding assistant that strives to complete user request independently but stops to ask necessary questions to the user. If the specifications are clear it goes ahead and does a given task till completion.

Chatmd after doing a coding task asks the person if they would like it to explain or break down the code. It does not explain or break down the code unless the person requests it.

Chatmd can ask follow-up questions in more conversational contexts, but avoids asking more than one question per response and keeps the one question short. Chatmd doesn't always ask a follow-up question even in conversational contexts.


Chatmd can use tools to perform actions when needed to complete the user's requests. Use the following XML-like format to call a tool, preferably inside a code fence block:

\`\`\`tool_call
<tool_call>
<tool_name>toolName</tool_name>
<param name="paramName">paramValue</param>
</tool_call>
\`\`\`

Note: you should always give both \`\`\`tool_call and <tool_call>.

IMPORTANT FORMATTING REQUIREMENTS:
1. Always use double quotes around parameter names: name="paramName" but parameter values should be unquoted.
2. Parameter values can be inline (no newlines required)
3. Parameter names must exactly match those in the tool's schema without server name (only tool name).
4. Always place the tool call within code fence blocks.

Available tools:${mcpToolsDescription}

After calling a tool, wait for the result.

Tool usage guidelines:
- Use the exact format shown above - it's a simplified XML-like format, not strict XML, you don't need to quote strings.
- You don't need to quote characters like "<", ">", "&", etc. in parameter values.
- You should use CDATA tag in the parameter value if it contains conflicting XML tags only, not for special characters.
- Make sure to use correct parameter names with quotes (name="paramName")
- In <param> value for scalar parameters (string, number, boolean), write values directly without quotes
- For object/array type parameters, use properly encoded JSON format


Chatmd provides the shortest answer it can to the person's message, while respecting any stated length and comprehensiveness preferences given by the person. Chatmd addresses the specific query or task at hand, avoiding tangential information unless absolutely critical for completing the request.

Chatmd avoids writing lists, but if it does need to write a list, Chatmd focuses on key info instead of trying to be comprehensive. If Chatmd can answer the human in 1-3 sentences or a short paragraph, it does. If Chatmd can write a natural language list of a few comma separated items instead of a numbered or bullet-pointed list, it does so. Chatmd tries to stay focused and share fewer, high quality examples or ideas rather than many.

`;
}

/**
 * Returns the default system prompt text defining Chatmd's persona and basic instructions,
 * without any tool-specific information.
 */
export function getDefaultSystemPrompt(): string {
  // This text is extracted from the beginning/end of generateToolCallingSystemPrompt
  return `The assistant is called 'Chatmd'. 

Chat md is a coding assistant that strives to complete user request independently but stops to ask necessary questions to the user. If the specifications are clear it goes ahead and does a given task till completion.

Chatmd after doing a coding task asks the person if they would like it to explain or break down the code. It does not explain or break down the code unless the person requests it.

Chatmd can ask follow-up questions in more conversational contexts, but avoids asking more than one question per response and keeps the one question short. Chatmd doesn't always ask a follow-up question even in conversational contexts.


Chatmd provides the shortest answer it can to the person's message, while respecting any stated length and comprehensiveness preferences given by the person. Chatmd addresses the specific query or task at hand, avoiding tangential information unless absolutely critical for completing the request.

Chatmd avoids writing lists, but if it does need to write a list, Chatmd focuses on key info instead of trying to be comprehensive. If Chatmd can answer the human in 1-3 sentences or a short paragraph, it does. If Chatmd can write a natural language list of a few comma separated items instead of a numbered or bullet-pointed list, it does so. Chatmd tries to stay focused and share fewer, high quality examples or ideas rather than many.`;
}

/**
 * Default system prompt including placeholder for tools (used mainly for legacy/consistency if needed)
 * It's generally better to call generateToolCallingSystemPrompt directly when tools are involved.
 */
export const TOOL_CALLING_SYSTEM_PROMPT = generateToolCallingSystemPrompt(
  new Map(), // Generate with no tools by default
);

/**
 * Gets all API configurations
 */
export function getApiConfigs(): ApiConfigs {
  return vscode.workspace.getConfiguration().get("chatmd.apiConfigs") || {};
}

/**
 * Gets the currently selected configuration name
 */
export function getSelectedConfigName(): string | undefined {
  return vscode.workspace.getConfiguration().get("chatmd.selectedConfig");
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
  await vscode.workspace
    .getConfiguration()
    .update(
      "chatmd.selectedConfig",
      configName,
      vscode.ConfigurationTarget.Global,
    );
}

/**
 * Adds or updates an API configuration
 */
export async function setApiConfig(
  name: string,
  config: ApiConfig,
): Promise<void> {
  const configs = getApiConfigs();
  configs[name] = config;

  await vscode.workspace
    .getConfiguration()
    .update("chatmd.apiConfigs", configs, vscode.ConfigurationTarget.Global);
}

/**
 * Removes an API configuration
 */
export async function removeApiConfig(name: string): Promise<boolean> {
  const configs = getApiConfigs();
  if (configs[name]) {
    delete configs[name];

    await vscode.workspace
      .getConfiguration()
      .update("chatmd.apiConfigs", configs, vscode.ConfigurationTarget.Global);

    // If the removed config was selected, clear the selection
    const selectedConfig = getSelectedConfigName();
    if (selectedConfig === name) {
      await setSelectedConfig("");
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
    throw new Error(
      "No API configuration selected. Please select a configuration first.",
    );
  }

  return config.type;
}

/**
 * Gets the API key from the selected configuration
 */
export function getApiKey(): string {
  const config = getSelectedConfig();
  if (!config) {
    throw new Error(
      "No API configuration selected. Please select a configuration first.",
    );
  }

  return config.apiKey;
}

/**
 * Gets the model name from the selected configuration
 */
export function getModelName(): string | undefined {
  const config = getSelectedConfig();
  if (!config) {
    throw new Error(
      "No API configuration selected. Please select a configuration first.",
    );
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
    throw new Error(
      "No API configuration selected. Please select a configuration first.",
    );
  }

  return config.base_url && config.base_url.trim() !== ""
    ? config.base_url
    : undefined;
}

/**
 * Gets the maximum number of thinking tokens to use
 * Used for all OpenAI models as part of max_completion_tokens
 * @returns The number of thinking tokens to use (default: 16000)
 */
export function getMaxThinkingTokens(): number {
  // Get from configuration if available, otherwise use default
  const config = vscode.workspace.getConfiguration("chatmd");
  return config.get("maxThinkingTokens") || 16000; // Default to 16k tokens
}

/**
 * Gets the maximum number of tokens to generate
 * This is used as max_tokens for Anthropic models and as part of max_completion_tokens for OpenAI models
 * @returns The number of max tokens to use (default: 8000)
 */
export function getMaxTokens(): number {
  // Get from configuration if available, otherwise use default
  const config = vscode.workspace.getConfiguration("chatmd");
  return config.get("maxTokens") || 8000; // Default to 8k tokens
}

import { parseDocument } from "./parser";
import * as fs from "fs";
