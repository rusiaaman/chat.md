import { log } from "../extension";
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { mcpClientManager } from "../mcpClientManager";
import { statusManager } from "../extension";

// Track active tool executions for cancellation
const activeToolExecutions = new Map<string, AbortController>();
// Track the current execution ID
let currentToolExecution: string | null = null;
// Track cancelled executions to ignore any late responses
const cancelledExecutions = new Set<string>();

/**
 * Saves the parsed tool call to a log file for debugging
 * @param toolName The name of the tool being called
 * @param params The parameters of the tool call
 * @param rawToolCall The raw XML of the tool call
 */
function saveToolCallLog(
  toolName: string,
  params: Record<string, string>,
  rawToolCall: string,
): void {
  try {
    // Create samples/cmdassets directory if it doesn't exist
    const rootDir = path.resolve(__dirname, "..", "..");
    const assetsDir = path.join(rootDir, "samples", "cmdassets");

    if (!fs.existsSync(assetsDir)) {
      fs.mkdirSync(assetsDir, { recursive: true });
    }

    // Create a timestamp-based filename
    const date = new Date();
    const timestamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}-${String(date.getHours()).padStart(2, "0")}${String(date.getMinutes()).padStart(2, "0")}${String(date.getSeconds()).padStart(2, "0")}`;
    const randomSuffix = Math.random().toString(36).substring(2, 8);
    const filename = `tool-call-${timestamp}-${randomSuffix}.txt`;
    const filePath = path.join(assetsDir, filename);

    // Format the log content
    let content = `# Tool Call Log\n\n`;
    content += `Timestamp: ${date.toISOString()}\n`;
    content += `Tool Name: ${toolName}\n\n`;
    content += `## Parsed Parameters\n\`\`\`json\n${JSON.stringify(params, null, 2)}\n\`\`\`\n\n`;
    content += `## Raw Tool Call XML\n\`\`\`xml\n${rawToolCall}\n\`\`\`\n`;

    // Write to file
    fs.writeFileSync(filePath, content, "utf8");
    log(`Tool call log saved to: ${filePath}`);
  } catch (error) {
    log(`Error saving tool call log: ${error}`);
    // Don't throw - we want this to be non-blocking
  }
}

export async function executeToolCall(
  toolName: string,
  params: Record<string, string>,
  document?: vscode.TextDocument | null,
  rawToolCall?: string,
): Promise<string> {
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
  
  // Show tool execution status
  statusManager.showToolExecutionStatus();
  log(`toolExecutor: Showing 'executing tool' status for tool "${toolName}"`);
  
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

  // Save the parsed tool call to a log file if we have the raw XML
  if (rawToolCall) {
    saveToolCallLog(toolName, params, rawToolCall);
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
    
    if (
      result &&
      !result.startsWith("Error: Tool") &&
      !result.startsWith("Error: No server")
    ) {
      // If we got a successful result from MCP, return it
      return result;
    }
    
    // Otherwise, return the error from MCP
    return result;
  } catch (mcpError) {
    // Check if this is an AbortError from cancellation
    if (mcpError.name === 'AbortError' || cancelledExecutions.has(executionId)) {
      log(`Tool execution cancelled: ${toolName}`);
      // Use a special format to indicate cancellation
      return `CANCELLED:${Symbol('AbortError').toString()}`;
    }
    
    // For other errors, check if the AbortError is mentioned in the error message
    if (mcpError.message && mcpError.message.includes('AbortError')) {
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
    
    // Only change status back to idle if we're not already in another state
    // due to cancellation, which would set its own status
    if (statusManager.getCurrentStatus() !== 'cancelling') {
      log(`toolExecutor: Current status is '${statusManager.getCurrentStatus()}', restoring to idle after tool "${toolName}" execution`);
      statusManager.hideStreamingStatus();
    } else if (statusManager.getCurrentStatus() === 'cancelling' && activeToolExecutions.size === 0) {
      // If we're in cancelling state and this was the last active execution, go back to idle
      log(`toolExecutor: Restoring status to idle after cancellation of tool "${toolName}"`);
      statusManager.hideStreamingStatus();
    }
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
    
    // Show cancellation status
    statusManager.showToolCancellationStatus();
    
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
  try {
    // First, check if the tool call has a proper opening and closing fence
    const properFenceMatch =
      /```(?:xml|tool_call)?\s*\n([\s\S]*?)\n\s*```/s.exec(toolCallXml);

    // If not, check if it has just an opening fence (partially fenced)
    const partialFenceMatch = !properFenceMatch
      ? /```(?:xml|tool_call)?\s*\n([\s\S]*?)$/s.exec(toolCallXml)
      : null;

    // Extract the actual XML content based on the fence status
    const xmlContent = properFenceMatch
      ? properFenceMatch[1]
      : partialFenceMatch
        ? partialFenceMatch[1]
        : toolCallXml;

    log(
      `Tool call format: ${properFenceMatch ? "properly fenced" : partialFenceMatch ? "partially fenced" : "not fenced"}`,
    );

    // Focus on the part between <tool_call> and </tool_call> tags
    // Require the closing tag to be on its own line
    const toolCallContentMatch =
      /<tool_call>\s*([\s\S]*?)\n\s*<\/tool_call>/s.exec(xmlContent);

    // If we can't find the tool_call tags, try on the original string as a fallback
    // Still require the closing tag to be on its own line
    const toolCallContent = toolCallContentMatch
      ? toolCallContentMatch[1]
      : /<tool_call>\s*([\s\S]*?)\n\s*<\/tool_call>/s.exec(toolCallXml)?.[1] ||
        "";

    if (!toolCallContent) {
      log("Could not extract tool call content");
      return null;
    }

    // Simple XML parser for tool calls - allow indentation with more flexible whitespace
    const nameMatch = /<tool_name>\s*(.*?)\s*<\/tool_name>/s.exec(
      toolCallContent,
    );
    if (!nameMatch) {
      log("Could not find tool_name tag");
      return null;
    }

    const toolName = nameMatch[1].trim();
    const params: Record<string, string> = {};

    // Extract parameters with more precise formatting
    // Updated regex to require quotes around parameter names and be flexible with whitespace
    const paramRegex =
      /<param\s+name=["'](.*?)["']>\s*([\s\S]*?)\s*<\/param>/gs;
    let paramMatch;

    while ((paramMatch = paramRegex.exec(toolCallContent)) !== null) {
      const paramName = paramMatch[1].trim(); // No need to replace quotes, they're already handled in the regex
      const paramValue = paramMatch[2].trim();

      // Store all parameter values as strings, even JSON objects or arrays
      params[paramName] = paramValue;

      // Log the parameter type for debugging
      if (
        paramValue.trim().startsWith("{") ||
        paramValue.trim().startsWith("[")
      ) {
        log(
          `Parameter "${paramName}" appears to be JSON, storing as string: ${paramValue.substring(0, 50)}${paramValue.length > 50 ? "..." : ""}`,
        );
      }
    }

    // Log the full details including parameter values for debugging
    log(
      `Parsed tool call ${toolName} with ${Object.keys(params).length} parameters`,
    );
    Object.entries(params).forEach(([key, value]) => {
      log(
        `  Parameter "${key}" = "${value.substring(0, 50)}${value.length > 50 ? "..." : ""}"`,
      );
    });

    // Return the parsed tool call with the raw XML included
    return {
      name: toolName,
      params,
      rawXml: xmlContent,
    };
  } catch (error) {
    log(`Error parsing tool call: ${error}`);
    return null;
  }
}
