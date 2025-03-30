import { log } from '../extension';
import * as vscode from 'vscode';
import { mcpClientManager } from '../mcpClientManager';

export async function executeToolCall(toolName: string, params: Record<string, string>, document?: vscode.TextDocument): Promise<string> {
  log(`Executing tool: ${toolName} with params: ${JSON.stringify(params)}`);
  
  // Execute through MCP
  try {
    const result = await mcpClientManager.executeToolCall(toolName, params);
    if (result && !result.startsWith('Error: Tool') && !result.startsWith('Error: No server')) {
      // If we got a successful result from MCP, return it
      return result;
    }
    // Otherwise, return the error from MCP
    return result;
  } catch (mcpError) {
    log(`MCP tool execution error: ${mcpError}`);
    return `Error executing tool ${toolName}: ${mcpError}`;
  }
}

export function formatToolResult(result: string): string {
  return `<tool_result>\n${result}\n</tool_result>`;
}

export function parseToolCall(toolCallXml: string): { name: string, params: Record<string, string> } | null {
  try {
    // Simple XML parser for tool calls
    const nameMatch = /<tool_name>(.*?)<\/tool_name>/s.exec(toolCallXml);
    if (!nameMatch) {
      return null;
    }
    
    const toolName = nameMatch[1].trim();
    const params: Record<string, string> = {};
    
    // Extract parameters
    const paramRegex = /<param\s+name=(.*?)>([\s\S]*?)<\/param>/sg;
    let paramMatch;
    
    while ((paramMatch = paramRegex.exec(toolCallXml)) !== null) {
      const paramName = paramMatch[1].trim().replace(/["']/g, '');
      const paramValue = paramMatch[2].trim();
      
      // Store all parameter values as strings, even JSON objects or arrays
      params[paramName] = paramValue;
      
      // Log the parameter type for debugging
      if (paramValue.trim().startsWith('{') || paramValue.trim().startsWith('[')) {
        log(`Parameter "${paramName}" appears to be JSON, storing as string: ${paramValue.substring(0, 50)}${paramValue.length > 50 ? '...' : ''}`);
      }
    }
    
    log(`Parsed tool call with parameters: ${JSON.stringify(Object.keys(params))}`);
    return { name: toolName, params };
  } catch (error) {
    log(`Error parsing tool call: ${error}`);
    return null;
  }
}