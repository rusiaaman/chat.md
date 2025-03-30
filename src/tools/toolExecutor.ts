import * as fs from 'fs';
import * as path from 'path';
import { log } from '../extension';
import { resolveFilePath } from '../utils/fileUtils';
import * as vscode from 'vscode';
import { mcpClientManager } from '../mcpClientManager';

export async function executeToolCall(toolName: string, params: Record<string, any>, document?: vscode.TextDocument): Promise<string> {
  log(`Executing tool: ${toolName} with params: ${JSON.stringify(params)}`);
  
  // Try executing through MCP first
  try {
    const result = await mcpClientManager.executeToolCall(toolName, params);
    if (result && !result.startsWith('Error: Tool') && !result.startsWith('Error: No server')) {
      // If we got a successful result from MCP, return it
      return result;
    }
    // Otherwise, fall through to built-in tools
    log(`MCP tool execution failed or not found, trying built-in tools`);
  } catch (mcpError) {
    log(`MCP tool execution error: ${mcpError}, falling back to built-in tools`);
  }
  
  // Fall back to built-in tools for backward compatibility
  if (toolName.toLowerCase() === 'readfile') {
    return await executeReadFileTool(params, document);
  }
  
  return `Error: Tool "${toolName}" not supported. Check your configuration or use 'readFile'.`;
}

async function executeReadFileTool(params: Record<string, any>, document?: vscode.TextDocument): Promise<string> {
  const filePath = params.path;
  
  if (!filePath) {
    return 'Error: No file path provided';
  }
  
  try {
    // Handle relative paths if a document is provided
    const resolvedPath = document 
      ? resolveFilePath(filePath, document)
      : path.resolve(filePath);
      
    const content = fs.readFileSync(resolvedPath, 'utf8');
    return content;
  } catch (error) {
    return `Error reading file: ${error}`;
  }
}

export function formatToolResult(result: string): string {
  return `<tool_result>\n${result}\n</tool_result>`;
}

export function parseToolCall(toolCallXml: string): { name: string, params: Record<string, any> } | null {
  try {
    // Simple XML parser for tool calls
    const nameMatch = /<tool_name>(.*?)<\/tool_name>/s.exec(toolCallXml);
    if (!nameMatch) {
      return null;
    }
    
    const toolName = nameMatch[1].trim();
    const params: Record<string, any> = {};
    
    // Extract parameters
    const paramRegex = /<param\s+name=(.*?)>([\s\S]*?)<\/param>/sg;
    let paramMatch;
    
    while ((paramMatch = paramRegex.exec(toolCallXml)) !== null) {
      const paramName = paramMatch[1].trim().replace(/["']/g, '');
      const paramValue = paramMatch[2].trim();
      
      // Try to parse as JSON if it looks like JSON
      try {
        if (paramValue.trim().startsWith('{') || paramValue.trim().startsWith('[')) {
          params[paramName] = JSON.parse(paramValue);
          continue;
        }
      } catch {}
      
      // Try to parse as number
      const numValue = Number(paramValue);
      if (!isNaN(numValue) && paramValue.trim() !== '') {
        params[paramName] = numValue;
        continue;
      }
      
      // Handle boolean values
      if (paramValue.toLowerCase() === 'true') {
        params[paramName] = true;
        continue;
      }
      if (paramValue.toLowerCase() === 'false') {
        params[paramName] = false;
        continue;
      }
      
      // Default to string
      params[paramName] = paramValue;
    }
    
    return { name: toolName, params };
  } catch (error) {
    log(`Error parsing tool call: ${error}`);
    return null;
  }
}