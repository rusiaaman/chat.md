import { log, requestStatusBarUpdate, onActiveFileChanged } from "../extension";
import * as vscode from "vscode";
import { mcpClientManager } from "../mcpClientManager";
import { statusManager } from "../extension";
import { McpToolExecutionResult } from "../types";
import { parseToolCall as parseCanonicalToolCall } from "./toolCallParser";

// Track active tool executions for cancellation
const activeToolExecutions = new Map<string, AbortController>();
// Track the current execution ID
let currentToolExecution: string | null = null;
// Track cancelled executions to ignore any late responses
const cancelledExecutions = new Set<string>();

export async function executeToolCall(
  toolName: string,
  params: Record<string, string>,
  document?: vscode.TextDocument | null,
  rawToolCall?: string,
): Promise<McpToolExecutionResult | string> {
  log(`Executing tool: ${toolName} with params: ${JSON.stringify(params)}`);
  log(`Document passed to executeToolCall: ${document ? 'yes' : 'no'}`);
  
  // Create unique ID for this tool execution
  const executionId = `${toolName}-${Date.now()}`;
  currentToolExecution = executionId;
  
  // Check if this execution was previously cancelled (should never happen, but just to be safe)
  if (cancelledExecutions.has(executionId)) {
    log(`Tool execution ${executionId} was previously cancelled - skipping execution`);
    return `CANCELLED:${Symbol('AlreadyCancelled').toString()}`;
  }
  
  // Create AbortController for cancellation
  const abortController = new AbortController();
  activeToolExecutions.set(executionId, abortController);
  
  // Show tool execution status - use coordinated system
  if (document) {
    requestStatusBarUpdate(document.uri.fsPath, `tool execution started: ${toolName}`);
    log(`toolExecutor: Requested status update for tool "${toolName}" from ${document.fileName}`);
  } else {
    log(`toolExecutor: No document provided for tool "${toolName}" - cannot update status bar`);
  }
  
  // Additional debug info for document
  if (document) {
    log(`Document details: fileName=${document.fileName}, languageId=${document.languageId}`);
  } else {
    log(`WARNING: No document context available for tool execution`);
  }

  // Special handling for ReadImage tool which requires document context
  if (toolName.includes("ReadImage")) {
    if (!document) {
      log(`ERROR: ReadImage tool cannot be executed without document context`);
      return `Error: ReadImage tool requires document context to resolve file paths. The current chat document must be saved before using this tool.`;
    }
    
    // Validate file_path parameter
    if (!params.file_path) {
      log(`ERROR: ReadImage tool called without file_path parameter`);
      return `Error: ReadImage tool requires a file_path parameter`;
    }
    
    log(`ReadImage with file_path=${params.file_path} and document context from ${document.fileName}`);
  }

  // Execute through MCP
  try {
    log(`Calling mcpClientManager.executeToolCall with document=${document ? 'provided' : 'not provided'}`);
    const result = await mcpClientManager.executeToolCall(
      toolName, 
      params, 
      document, 
      abortController.signal
    );
    
    return result;
  } catch (mcpError) {
    // Check if this is an AbortError from cancellation
    if ((mcpError as any).name === 'AbortError' || cancelledExecutions.has(executionId)) {
      log(`Tool execution cancelled: ${toolName}`);
      // Use a special format to indicate cancellation
      return `CANCELLED:${Symbol('AbortError').toString()}`;
    }
    
    // For other errors, check if the AbortError is mentioned in the error message
    if ((mcpError as any).message && (mcpError as any).message.includes('AbortError')) {
      log(`Tool execution cancelled (detected from error message): ${toolName}`);
      return `CANCELLED:${Symbol('AbortError').toString()}`;
    }
    
    log(`MCP tool execution error: ${mcpError}`);
    return `Error executing tool ${toolName}: ${mcpError}`;
  } finally {
    // Clean up and restore status
    activeToolExecutions.delete(executionId);
    cancelledExecutions.delete(executionId);
    
    if (currentToolExecution === executionId) {
      currentToolExecution = null;
    }
    
    // Refresh status based on current active file after tool execution ends
    log(`toolExecutor: Tool "${toolName}" execution finished, refreshing status for active file`);
    onActiveFileChanged();
  }
}

/**
 * Cancels the current tool execution if one is active
 * @returns True if a tool execution was cancelled, false otherwise
 */
export function cancelCurrentToolExecution(): boolean {
  // If we're already in cancellation state, don't do anything
  if (statusManager.getCurrentStatus() === 'cancelling') {
    log('Already in cancellation state - ignoring duplicate cancel request');
    return false;
  }
  
  if (currentToolExecution && activeToolExecutions.has(currentToolExecution)) {
    const executionId = currentToolExecution;
    log(`Cancelling tool execution: ${executionId}`);
    
    // Mark this execution as cancelled so any future responses will be ignored
    cancelledExecutions.add(executionId);
    
    // Refresh status for cancellation - will show cancelling state if active file has executing tool
    log(`toolExecutor: Tool "${executionId}" cancellation requested, refreshing status`);
    onActiveFileChanged();
    
    // Abort the execution
    const controller = activeToolExecutions.get(executionId);
    controller?.abort();
    
    // Status is automatically restored to idle when the execution completes or errors out
    // in the executeToolCall function's finally block
    
    return true;
  }
  
  return false;
}

export function formatToolResult(result: string): string {
  return `<tool_result>\n${result}\n</tool_result>`;
}

export function parseToolCall(
  toolCallXml: string,
): { name: string; params: Record<string, string>; rawXml: string } | null {
  const parsed = parseCanonicalToolCall(toolCallXml);
  return parsed ? { ...parsed, rawXml: toolCallXml } : null;
}
