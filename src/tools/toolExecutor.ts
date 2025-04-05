import { log } from "../extension";
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { mcpClientManager } from "../mcpClientManager";

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
  document?: vscode.TextDocument,
  rawToolCall?: string,
): Promise<string> {
  log(`Executing tool: ${toolName} with params: ${JSON.stringify(params)}`);

  // Save the parsed tool call to a log file if we have the raw XML
  if (rawToolCall) {
    saveToolCallLog(toolName, params, rawToolCall);
  }

  // Execute through MCP
  try {
    const result = await mcpClientManager.executeToolCall(toolName, params);
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
    log(`MCP tool execution error: ${mcpError}`);
    return `Error executing tool ${toolName}: ${mcpError}`;
  }
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
