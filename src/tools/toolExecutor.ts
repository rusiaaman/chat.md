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
    // First, check if the tool call has a proper opening and closing fence
    const properFenceMatch = /```(?:xml|tool_call)?\s*\n([\s\S]*?)\n\s*```/s.exec(toolCallXml);
    
    // If not, check if it has just an opening fence (partially fenced)
    const partialFenceMatch = !properFenceMatch ? /```(?:xml|tool_call)?\s*\n([\s\S]*?)$/s.exec(toolCallXml) : null;
    
    // Extract the actual XML content based on the fence status
    const xmlContent = properFenceMatch ? properFenceMatch[1] : 
                      partialFenceMatch ? partialFenceMatch[1] : 
                      toolCallXml;
                      
    log(`Tool call format: ${properFenceMatch ? 'properly fenced' : partialFenceMatch ? 'partially fenced' : 'not fenced'}`);
    
    // Focus on the part between <tool_call> and </tool_call> tags
    const toolCallContentMatch = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/s.exec(xmlContent);
    
    // If we can't find the tool_call tags, try on the original string as a fallback
    const toolCallContent = toolCallContentMatch 
      ? toolCallContentMatch[1] 
      : (/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/s.exec(toolCallXml)?.[1] || '');
    
    if (!toolCallContent) {
      log('Could not extract tool call content');
      return null;
    }
    
    // Simple XML parser for tool calls - allow indentation with more flexible whitespace
    const nameMatch = /<tool_name>\s*(.*?)\s*<\/tool_name>/s.exec(toolCallContent);
    if (!nameMatch) {
      log('Could not find tool_name tag');
      return null;
    }
    
    const toolName = nameMatch[1].trim();
    const params: Record<string, string> = {};
    
    // Extract parameters with more precise formatting
    // Updated regex to require quotes around parameter names and be flexible with whitespace
    const paramRegex = /<param\s+name=["'](.*?)["']>\s*([\s\S]*?)\s*<\/param>/sg;
    let paramMatch;
    
    while ((paramMatch = paramRegex.exec(toolCallContent)) !== null) {
      const paramName = paramMatch[1].trim(); // No need to replace quotes, they're already handled in the regex
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