import * as vscode from "vscode";
import {
  parseDocument, // Updated signature: returns { messages, systemPrompt, hasImageInSystemBlock }
  hasEmptyAssistantBlock,
  hasEmptyToolExecuteBlock,
  ParsedDocumentResult, // Import the return type interface
  findAllAssistantBlocks, // Add this import for resumeStreaming
} from "./parser";
import { Lock } from "./utils/lock";
import { StreamingService } from "./streamer";
import { StreamerState, MessageParam } from "./types"; // Added MessageParam and StreamerState
import {
  getApiKey, // Keep existing config functions
  // getAnthropicApiKey, // No longer directly used in startStreaming based on latest snippet
  getProvider, // Keep existing config functions
  generateToolCallingSystemPrompt, // Keep existing config functions
  getDefaultSystemPrompt, // Add function to get default system prompt
} from "./config";
import * as path from "path";
import * as fs from "fs"; // Keep fs for file operations
import { log, mcpClientManager, statusManager, requestStatusBarUpdate } from "./extension"; // Import statusManager and updater
import { executeToolCall, formatToolResult } from "./tools/toolExecutor"; // Keep existing imports
import { parseToolCall } from "./tools/toolCallParser"; // Keep existing imports
import {
  ensureDirectoryExists, // Keep existing imports
  writeFile, // Keep existing imports
  saveChatHistory, // Keep existing imports
} from "./utils/fileUtils";

/**
 * Listens for document changes and manages streaming LLM responses.
 * Handles system prompt aggregation, image errors, and triggering actions.
 */
export class DocumentListener {
  private readonly streamers: Map<number, StreamerState> = new Map();
  private defaultConfigInserted: boolean = false;
  private readonly lock: Lock = new Lock();
  private isExecutingTool: boolean = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly document: vscode.TextDocument) {}

  /**
   * Start listening for document changes
   * Returns disposable to clean up listeners
   */
  public startListening(): vscode.Disposable {
    // Watch for document changes
    const changeListener = vscode.workspace.onDidChangeTextDocument((event) =>
      this.handleDocumentChange(event),
    );

    this.disposables.push(changeListener);

    // Check document initially
    this.checkDocument();

    return {
      dispose: () => {
        this.disposables.forEach((d) => d.dispose());
        this.streamers.forEach((streamer) => {
          if (streamer.cancel) {
            streamer.cancel();
          } else {
            streamer.isActive = false;
          }
        });
        this.streamers.clear();
      },
    };
  }

  /**
   * Get the active streamer for the current document
   * @returns The active streamer if one exists, undefined otherwise
   */
  public getActiveStreamer(): StreamerState | undefined {
    // Find the first active streamer
    for (const [_, streamer] of this.streamers.entries()) {
      if (streamer.isActive) {
        return streamer;
      }
    }
    return undefined;
  }

  /**
   * Get count of active streamers for this document
   */
  public getActiveStreamerCount(): number {
    let count = 0;
    for (const s of this.streamers.values()) {
      if (s.isActive) count++;
    }
    return count;
  }

  /**
   * Whether this document is currently executing a tool
   */
  public getIsExecuting(): boolean {
    return this.isExecutingTool;
  }

  /**
   * Check document on initial load for actionable states (errors or triggers).
   */
  private async checkDocument(): Promise<void> {
    // Ignore if not a .chat.md file
    if (!this.document.fileName.endsWith(".chat.md")) return;

    log(`Checking document initially: ${this.document.fileName}`);
    const text = this.document.getText();
    try {
      // Parse first to check for critical errors like images in system prompt or invalid start content
      const parseResult = parseDocument(text, this.document);

      // Check for image error first
      if (parseResult.hasImageInSystemBlock) {
        log("Initial check: Image found in system block. Showing error.");
        vscode.window.showErrorMessage(
          "Images are not allowed in '# %% system' blocks. Please remove image references.",
        );
        // Don't proceed if there's an error
        return;
      }

      // If no errors, check for trigger conditions
      if (hasEmptyAssistantBlock(text)) {
        log(`Initial check: Found empty assistant block, starting streaming`);
        // Call the main startStreaming function which handles parsing and error checks again
        await this.startStreaming();
      } else if (hasEmptyToolExecuteBlock(text)) {
         log(`Initial check: Found empty tool_execute block, executing tool`);
         await this.executeToolFromPreviousBlock();
      } else {
        log(`Initial check: No empty assistant or tool_execute block found.`);
      }
    } catch (error) {
      // Check for specific parse errors
      if (error instanceof Error && error.message === "INVALID_START_CONTENT") {
        log("Initial check: Invalid content before first block marker.");
        vscode.window.showErrorMessage(
          "Invalid content: Nothing outside of a valid block (# %% user, # %% system, etc.) should be present. Please start with a valid block.",
        );
      } else if (error instanceof Error && error.message.startsWith("FORBIDDEN_INLINE_CONFIG_KEY:")) {
        const forbiddenKey = error.message.split(": ")[1];
        log(`Initial check: Forbidden config key '${forbiddenKey}' in inline config.`);
        vscode.window.showErrorMessage(
          `Configuration key '${forbiddenKey}' is not allowed in .chat.md files. These keys (type, apiKey, base_url, model_name, apiConfigs) must be defined in global settings only. Use 'selectedConfig' to reference a named configuration.`,
        );
      } else {
        log(`Error during initial document check: ${error}`);
        // Avoid showing other error messages on initial load unless critical
      }
    }
  }


  /**
   * Handle document changes: check for errors, trigger streaming, or trigger tool execution.
   */
  private async handleDocumentChange(
    event: vscode.TextDocumentChangeEvent,
  ): Promise<void> {
    // Ignore changes to other documents or non-chat files
    if (event.document.uri.toString() !== this.document.uri.toString() || !this.document.fileName.endsWith(".chat.md")) {
      return;
    }
    
    // Check if there are actual content changes (not just file save or metadata changes)
    if (event.contentChanges.length === 0) {
      log(`Document saved without content changes: ${this.document.fileName} - ignoring`);
      return;
    }

    log(`Document content changed: ${this.document.fileName}`);
    const text = this.document.getText();

    try {
        // Parse the document on every change to check for errors first (invalid start, images in system)
        const parseResult = parseDocument(text, this.document);

        // Update status bar with file-specific provider/config hover info
        try {
          requestStatusBarUpdate(this.document.uri.fsPath, "document changed");
        } catch (e) {
          log(`Failed to update status bar after parse: ${e}`);
        }

        // Insert default configuration block on first file update if missing
        if (!this.defaultConfigInserted && !parseResult.hasConfigurationBlock) {
          try {
            const { getSelectedConfigName } = require("./config");
            const cfgName = getSelectedConfigName();
            if (cfgName && this.document.fileName.endsWith(".chat.md")) {
              const edit = new vscode.WorkspaceEdit();
              const insertText = `selectedConfig="${cfgName}"\n\n`;
              edit.insert(this.document.uri, new vscode.Position(0, 0), insertText);
              const applied = await vscode.workspace.applyEdit(edit);
              if (applied) {
                this.defaultConfigInserted = true;
                log(`Inserted default configuration preamble selectedConfig="${cfgName}"`);
              } else {
                log("Failed to insert default configuration preamble");
              }
            }
          } catch (e) {
            log(`Error inserting default configuration preamble: ${e}`);
          }
        }

        // **Handle Image in System Block Error**
        if (parseResult.hasImageInSystemBlock) {
          log("Change detected: Image found in system block. Aborting actions.");
          vscode.window.showErrorMessage(
            "Images are not allowed in '# %% system' blocks. Please remove image references and try again.",
          );
          // Prevent triggering stream/tool execution if there's an error
          this.removeLastEmptyBlock("assistant"); // Remove trigger block if it exists
          this.removeLastEmptyBlock("tool_execute"); // Remove trigger block if it exists
          return;
        }

        // If no errors, check for action triggers
        // Check for empty assistant block first (streaming priority)
        if (hasEmptyAssistantBlock(text)) {
          log(`Change detected: Found empty assistant block, starting streaming`);
          await this.startStreaming(); // This function now handles parsing internally
        }
        // Otherwise, check for empty tool_execute block
        else if (hasEmptyToolExecuteBlock(text)) {
          log(`Change detected: Found empty tool_execute block, executing tool`);
          await this.executeToolFromPreviousBlock();
        } else {
          // Log only if neither trigger is found
          // log(`Change detected: No empty assistant or tool_execute block found`);
        }
    } catch (error) {
      // Check for specific parse errors
      if (error instanceof Error && error.message === "INVALID_START_CONTENT") {
        log("Change detected: Invalid content before first block marker.");
        vscode.window.showErrorMessage(
          "Invalid content: Nothing outside of a valid block (# %% user, # %% system, etc.) should be present. Please start with a valid block.",
        );
        // Prevent triggering stream/tool execution if there's an error
        this.removeLastEmptyBlock("assistant");
        this.removeLastEmptyBlock("tool_execute");
      } else if (error instanceof Error && error.message.startsWith("FORBIDDEN_INLINE_CONFIG_KEY:")) {
        const forbiddenKey = error.message.split(": ")[1];
        log(`Change detected: Forbidden config key '${forbiddenKey}' in inline config.`);
        vscode.window.showErrorMessage(
          `Configuration key '${forbiddenKey}' is not allowed in .chat.md files. These keys (type, apiKey, base_url, model_name, apiConfigs) must be defined in global settings only. Use 'selectedConfig' to reference a named configuration.`,
        );
        // Prevent triggering stream/tool execution if there's an error
        this.removeLastEmptyBlock("assistant");
        this.removeLastEmptyBlock("tool_execute");
      } else {
        // Handle other errors
        log(`Error handling document change: ${error}`);
        vscode.window.showErrorMessage(`Error processing document change: ${error}`);
      }
    }
  }

  /**
   * Execute tool from previous assistant block with tool call
   */
  private async executeToolFromPreviousBlock(): Promise<void> {
    await this.lock.acquire();

    // Mark executing for this document and request status update
    this.isExecutingTool = true;
    requestStatusBarUpdate(this.document.uri.fsPath, "tool execution started");
    log(`DocumentListener: Requested status update for tool execution`);

    try {
      const text = this.document.getText();

      // Find all tool_execute blocks and check which ones are empty
      const blockRegex = /# %% tool_execute\s*([\s\S]*?)(?=# %%|$)/gm;
      const emptyBlocks = [];
      let match;

      while ((match = blockRegex.exec(text)) !== null) {
        const content = match[1].trim();
        const position = match.index;
        const blockLength = match[0].length;

        if (content === "") {
          emptyBlocks.push({ position, blockLength });
          log(`Found empty tool_execute block at position ${position}`);
        } else {
          log(`Found non-empty tool_execute block at position ${position}`);
        }
      }

      if (emptyBlocks.length === 0) {
        log("No empty tool_execute blocks found");
        return;
      }

      // Use the LAST empty block
      const lastEmptyBlock = emptyBlocks[emptyBlocks.length - 1];
      log(
        `Using last empty tool_execute block at position ${lastEmptyBlock.position}`,
      );

      const toolExecutePosition = lastEmptyBlock.position;

      // Find the previous assistant block with a tool call
      const textBeforeToolExecute = text.substring(0, toolExecutePosition);
      const assistantBlockRegex = /# %% assistant\s+([\s\S]*?)(?=\n# %%|$)/g;

      // Find the last match
      let assistantBlockMatch;
      let lastMatch;

      while (
        (assistantBlockMatch = assistantBlockRegex.exec(
          textBeforeToolExecute,
        )) !== null
      ) {
        lastMatch = assistantBlockMatch;
      }

      if (!lastMatch) {
        log("No assistant block found before tool_execute");
        const errorResult = formatToolResult(
          "Error: No assistant block found before tool_execute",
        );
        await this.insertToolResult(errorResult);
        return;
      }

      // Extract the assistant's response
      const assistantResponse = lastMatch[1].trim();
      log(
        `Found assistant response: "${assistantResponse.substring(0, 100)}${assistantResponse.length > 100 ? "..." : ""}"`,
      );

      // Look for tool call XML - find the LAST match instead of first
      // Support both fenced and non-fenced tool calls

      // Match for properly fenced tool calls (with opening and closing fences)
      // Allow for any annotation after the triple backticks
      const properlyFencedToolCallRegex =
        /```(?:[a-zA-Z0-9_\-]*)?(?:\s*\n|\s+)\s*<tool_call>[\s\S]*?\n\s*<\/tool_call>\s*\n\s*```/gs;

      // Match for partially fenced tool calls (with opening fence but missing closing fence)
      // Allow for any annotation after the triple backticks
      const partiallyFencedToolCallRegex =
        /```(?:[a-zA-Z0-9_\-]*)?(?:\s*\n|\s+)\s*<tool_call>[\s\S]*?\n\s*<\/tool_call>(?!\s*\n\s*```)/gs;

      // Match for non-fenced tool calls
      const nonFencedToolCallRegex =
        /\n\s*<tool_call>[\s\S]*?\n\s*<\/tool_call>/gs;

      // Find all matches for all patterns
      let properlyFencedMatch;
      let lastProperlyFencedMatch = null;
      let partiallyFencedMatch;
      let lastPartiallyFencedMatch = null;
      let nonFencedMatch;
      let lastNonFencedMatch = null;

      // Find all properly fenced matches
      while (
        (properlyFencedMatch =
          properlyFencedToolCallRegex.exec(assistantResponse)) !== null
      ) {
        lastProperlyFencedMatch = properlyFencedMatch;
      }

      // Find all partially fenced matches
      while (
        (partiallyFencedMatch =
          partiallyFencedToolCallRegex.exec(assistantResponse)) !== null
      ) {
        lastPartiallyFencedMatch = partiallyFencedMatch;
      }

      // Find all non-fenced matches
      while (
        (nonFencedMatch = nonFencedToolCallRegex.exec(assistantResponse)) !==
        null
      ) {
        lastNonFencedMatch = nonFencedMatch;
      }

      // Determine which match to use (last one found, prioritizing in order: properly fenced, partially fenced, non-fenced)
      let toolCallMatch = null;

      // Find the last position of any match
      const positions = [];
      if (lastProperlyFencedMatch)
        positions.push({
          type: "properly-fenced",
          match: lastProperlyFencedMatch,
          index: lastProperlyFencedMatch.index,
        });
      if (lastPartiallyFencedMatch)
        positions.push({
          type: "partially-fenced",
          match: lastPartiallyFencedMatch,
          index: lastPartiallyFencedMatch.index,
        });
      if (lastNonFencedMatch)
        positions.push({
          type: "non-fenced",
          match: lastNonFencedMatch,
          index: lastNonFencedMatch.index,
        });

      // Sort by position in descending order (last in the text first)
      positions.sort((a, b) => b.index - a.index);

      if (positions.length > 0) {
        toolCallMatch = positions[0].match;
        log(
          `Using last ${positions[0].type} tool call at position ${positions[0].index}`,
        );
      }

      if (!toolCallMatch) {
        log("No tool call found in assistant response");
        const errorResult = formatToolResult(
          "Error: No tool call found in assistant response",
        );
        await this.insertToolResult(errorResult);
        return;
      }

      const toolCallXml = toolCallMatch[0];
      log(
        `Found tool call: "${toolCallXml.substring(0, 100)}${toolCallXml.length > 100 ? "..." : ""}"`,
      );

      const parsedToolCall = parseToolCall(toolCallXml);

      if (!parsedToolCall) {
        log("Invalid tool call format");
        const errorResult = formatToolResult("Error: Invalid tool call format");
        await this.insertToolResult(errorResult);
        return;
      }

      // Log that we have a valid parsed tool call with parameter details
      log(
        `Successfully parsed tool call: ${parsedToolCall.name} with ${Object.keys(parsedToolCall.params).length} parameters`,
      );

      log(
        `Executing tool: ${parsedToolCall.name} with params: ${JSON.stringify(parsedToolCall.params)}`,
      );

      // Add detailed parsing information to the document itself
      const paramDetailsBlock = `## Parsed Tool Call Parameters (debug info)
\`\`\`json
${JSON.stringify(parsedToolCall.params, null, 2)}
\`\`\`
`;

      // Create a history entry that captures the tool execution process
      const docDir = path.dirname(this.document.uri.fsPath);
      const historyDir = path.join(docDir, ".cmd_history");
      if (!fs.existsSync(historyDir)) {
        fs.mkdirSync(historyDir, { recursive: true });
      }

      const timestamp = new Date()
        .toISOString()
        .replace(/:/g, "-")
        .replace(/\..+Z/, "");
      const executionLogPath = path.join(
        historyDir,
        `tool_execution_${timestamp}.md`,
      );

      // Log pre-execution information
      let executionLog = `# Tool Call Execution Flow\n\n`;
      executionLog += `- **Timestamp:** ${new Date().toISOString()}\n`;
      executionLog += `- **Document:** ${this.document.fileName}\n`;
      executionLog += `- **Tool Name:** ${parsedToolCall.name}\n\n`;

      executionLog += `## Raw Tool Call XML\n\n\`\`\`xml\n${toolCallXml}\n\`\`\`\n\n`;
      executionLog += `## Parsed Parameters\n\n\`\`\`json\n${JSON.stringify(parsedToolCall.params, null, 2)}\n\`\`\`\n\n`;

      // Write pre-execution information
      fs.writeFileSync(executionLogPath, executionLog);
      log(`Tool execution flow log created: ${executionLogPath}`);

      // Execute the tool, passing the raw tool call XML for logging
      const rawResult = await executeToolCall(
        parsedToolCall.name,
        parsedToolCall.params,
        this.document,
        toolCallXml, // Pass the raw XML for logging
      );

      // Check if this is a cancellation result
      if (typeof rawResult === 'string' && rawResult.startsWith('CANCELLED:')) {
        log(`Tool execution was cancelled - not inserting any result`);
        
        // Remove the empty tool_execute block
        this.removeLastEmptyBlock("tool_execute");
        
        // Log cancellation in the execution log file
        executionLog += `## Tool Execution Cancelled\n\nTool execution was cancelled by user.\n`;
        fs.writeFileSync(executionLogPath, executionLog);
        log(`Tool cancellation recorded in log: ${executionLogPath}`);
        
        // Set status back to idle
        vscode.window.showInformationMessage("Tool execution cancelled, but it may still have gone through successfully");
        
        // Don't insert anything into the document
        return;
      }

      // Append the result to the execution log
      executionLog += `## Tool Execution Result\n\n\`\`\`\n${rawResult}\n\`\`\`\n`;
      fs.writeFileSync(executionLogPath, executionLog);
      log(`Tool execution result appended to log: ${executionLogPath}`);

      // Insert the raw result (insertToolResult will handle formatting/linking)
      await this.insertToolResult(rawResult);
    } catch (error) {
      // Check if this is a cancellation-related error
      if ((error as any).name === 'AbortError' || 
          ((error as any).message && (
            (error as any).message.includes('AbortError') || 
            (error as any).message.includes('cancelled') || 
            (error as any).message.includes('canceled')
          ))
      ) {
        log(`Tool execution cancelled (caught in error handler): ${error}`);
        // Remove the empty tool_execute block without inserting any error
        this.removeLastEmptyBlock("tool_execute");
        return;
      }
      
      log(`Error executing tool: ${error}`);
      // Format and insert the error message directly
      const formattedError = formatToolResult(`Error executing tool: ${error}`);
      await this.insertToolResult(formattedError, true); // Pass flag indicating this is already formatted
    } finally {
      this.lock.release();
      this.isExecutingTool = false;
      try { 
        requestStatusBarUpdate(this.document.uri.fsPath, "tool execution finished");
      } catch {}
    }
  }

  /**
   * Insert tool result (or error) into the document and add a new assistant block.
   * If the result is large, it saves it to a file and inserts a link.
   * @param rawResult The raw string content returned by the tool, or a pre-formatted error message.
   * @param isPreformattedError Indicates if rawResult is already formatted (e.g., an error message).
   */
  private async insertToolResult(
    rawResult: string,
    isPreformattedError = false,
  ): Promise<void> {

    const text = this.document.getText();
    let contentToInsert = "";
    const lineCountThreshold = 30;

    if (isPreformattedError) {
      // If it's a preformatted error, use it directly
      contentToInsert = rawResult;
      log("Inserting preformatted error message.");
    } else {
      // Check if the result contains image markdown links (from MCP tool image output)
      const containsImageMarkdown = rawResult.includes("![Tool generated image]");
      
      if (containsImageMarkdown) {
        log("Tool result contains image markdown, preserving it as-is.");
        contentToInsert = formatToolResult(rawResult);
      } else {
        // Process the raw tool result as before (for text-only content)
        const lines = rawResult.split("\n");
        log(`Tool result has ${lines.length} lines.`);

        if (lines.length > lineCountThreshold) {
          log(`Result exceeds ${lineCountThreshold} lines, saving to file.`);
          try {
            const docDir = path.dirname(this.document.uri.fsPath);
            const assetsDir = path.join(docDir, "cmdassets");
            ensureDirectoryExists(assetsDir);

            const timestamp = new Date()
              .toISOString()
              .replace(/:/g, "")
              .replace(/-/g, "")
              .replace("T", "-")
              .replace(/\..+Z/, "");
            const randomString = Math.random().toString(36).substring(2, 8);
            const filename = `tool-result-${timestamp}-${randomString}.txt`;
            const relativeFilePath = path.join("cmdassets", filename);
            const fullFilePath = path.join(assetsDir, filename);

            writeFile(fullFilePath, rawResult);
            log(`Saved tool result to: ${fullFilePath}`);

            const markdownLink = `[Tool Result](${relativeFilePath.replace(/\\/g, "/")})`; // Ensure forward slashes for Markdown
            contentToInsert = formatToolResult(markdownLink); // Wrap the link in result tags
            log(`Inserting Markdown link: ${markdownLink}`);
          } catch (fileError) {
            log(`Error saving tool result to file: ${fileError}`);
            // Fallback: insert truncated result with error message
            const truncatedResult = lines.slice(0, lineCountThreshold).join("\n");
            contentToInsert = formatToolResult(
              `${truncatedResult}\n...\n[Error: Failed to save full result to file - ${fileError}]`,
            );
            log(
              "Inserting truncated result with error message due to file save failure.",
            );
          }
        } else {
          // Result is small enough, insert directly
          contentToInsert = formatToolResult(rawResult);
          log("Inserting full tool result directly.");
        }
      }
    }

    // Find the insertion point (within the last empty tool_execute block)
    const blockRegex = /# %% tool_execute\s*([\s\S]*?)(?=# %%|$)/gm;
    const emptyBlocks = [];
    let match;

    while ((match = blockRegex.exec(text)) !== null) {
      const content = match[1].trim();
      const position = match.index;
      const blockLength = match[0].length;

      if (content === "") {
        emptyBlocks.push({ position, blockLength });
        log(
          `Found empty tool_execute block at position ${position} for result insertion`,
        );
      }
    }

    if (emptyBlocks.length === 0) {
      log("No empty tool_execute blocks found for inserting result");
      return;
    }

    // Use the LAST empty block
    const lastEmptyBlock = emptyBlocks[emptyBlocks.length - 1];
    const insertOffset = lastEmptyBlock.position + "# %% tool_execute".length; // Position after the marker line
    log(
      `Targeting insert offset ${insertOffset} within the empty tool_execute block at ${lastEmptyBlock.position}`,
    );

    // We need to replace the empty content within the block, not insert after it.
    const startPos = this.document.positionAt(insertOffset);
    // Find the end of the empty block content (before the next # %% or EOF)
    const endOffset = text.indexOf("%%#", insertOffset); // Look for the start of the next marker reversed
    const actualEndOffset =
      endOffset !== -1
        ? text.substring(0, endOffset).lastIndexOf("#")
        : text.length; // Find the actual start of the next marker or EOF
    const endPos = this.document.positionAt(actualEndOffset);

    log(
      `Calculated insertion range: Start(${startPos.line},${startPos.character}), End(${endPos.line},${endPos.character})`,
    );

    // Create an edit that replaces the empty content with the result and adds a new assistant block after
    // Determine whether to use code fences based on content type
    let isMarkdownLink =
      (rawResult.split("\n").length > lineCountThreshold &&
      contentToInsert.includes("[Tool Result]")) || 
      contentToInsert.includes("![Tool generated image]");

    // Determine how to handle the content:
    // 1. If it contains multiple images, we need special handling to ensure proper rendering
    // 2. If it's a markdown link or contains image markdown, don't wrap in code fences
    // 3. Otherwise, wrap in code fences for better display of code/text content
    const hasMultipleImages = (contentToInsert.match(/!\[Tool generated image \d+\]/g)?.length || 0) > 1;
    
    let textToInsert;
    if (hasMultipleImages) {
      // For multiple images, keep the tool_result tags but don't add code fences
      // This ensures images are properly displayed with their numbering
      textToInsert = `\n${contentToInsert.trim()}\n\n# %% assistant\n`;
      log(`Inserting content with multiple numbered images (${hasMultipleImages} images detected)`);
    } else if (isMarkdownLink) {
      // For regular markdown links or single images
      textToInsert = `\n${contentToInsert.trim()}\n\n# %% assistant\n`;
      log(`Inserting content with markdown links/images (no code fences)`);
    } else {
      // For regular text content, wrap in code fences
      textToInsert = `\n\`\`\`\n${contentToInsert.trim()}\n\`\`\`\n\n# %% assistant\n`;
      log(`Inserting plain text content with code fences`);
    }
    // If the block wasn't just the marker but had whitespace, adjust insertion
    const existingContent = text.substring(insertOffset, actualEndOffset);
    if (existingContent.trim() !== "") {
      log(
        `Warning: Overwriting non-empty whitespace in tool_execute block: "${existingContent}"`,
      );
    }

    const edit = new vscode.WorkspaceEdit();
    // Replace the content between the tool_execute marker and the next block/EOF
    edit.replace(
      this.document.uri,
      new vscode.Range(startPos, endPos),
      textToInsert,
    );

    log(`Applying edit to insert: "${textToInsert.substring(0, 100)}..."`);

    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      log("Failed to insert tool result into document");
    } else {
      log("Successfully inserted tool result and new assistant block");
      // Auto-scrolling disabled - users can scroll manually if needed
    }
  } // <--- Added missing closing brace for insertToolResult

  /**
   * Resume streaming from the last assistant block, continuing in the same block
   * This mimics the behavior when max tokens is reached and streaming continues
   */
  public async resumeStreaming(): Promise<void> {
    const text = this.document.getText();
    
    // Find the last assistant block
    const assistantMarkers = findAllAssistantBlocks(text);
    
    if (assistantMarkers.length === 0) {
      log("No assistant blocks found, cannot resume streaming");
      vscode.window.showWarningMessage("No assistant blocks found to resume from");
      return;
    }
    
    // Get the last assistant block
    const lastMarker = assistantMarkers[assistantMarkers.length - 1];
    log(`Found last assistant block at position ${lastMarker.markerStart}`);
    
    // Get the content of the last assistant block (from contentStart to end of document)
    const nextMarkerStart = text.length; // End of document since it's the last block
    const existingContent = text.substring(lastMarker.contentStart, nextMarkerStart);
    
    log(`Resuming streaming in existing assistant block with ${existingContent.length} characters of existing content`);
    
    // Parse the document to get messages, treating the existing content as partial assistant response
    const parseResult: ParsedDocumentResult = parseDocument(text, this.document);
    
    if (parseResult.hasImageInSystemBlock) {
      log("Error: Image found in system block during resumeStreaming. Aborting.");
      vscode.window.showErrorMessage("Images are not allowed in system blocks. Please remove image references.");
      return;
    }
    
    const messages: readonly MessageParam[] = parseResult.messages;
    const customSystemPrompt: string = parseResult.systemPrompt;
    
    if (messages.length === 0) {
      log("No valid messages found to resume streaming.");
      vscode.window.showWarningMessage("No valid conversation found to resume from");
      return;
    }
    
    // Create updated messages that include the existing partial assistant response
    const updatedMessages = [...messages];
    
    // If there's existing content in the last assistant block, we need to include it in the context
    if (existingContent.trim()) {
      log(`Including existing assistant content (${existingContent.trim().length} chars) in context for resumption`);
      
      // Check if the last message is from the assistant
      if (updatedMessages.length > 0 && updatedMessages[updatedMessages.length - 1].role === "assistant") {
        // Append to existing assistant message
        const existingAssistantContent = updatedMessages[updatedMessages.length - 1].content
          .filter((c) => c.type === "text")
          .map((c) => (c as any).value)
          .join("\n\n");
        
        // Replace the content with combined text
        const newContent = updatedMessages[updatedMessages.length - 1].content.filter(c => c.type !== "text");
        newContent.push({
          type: "text",
          value: existingAssistantContent + existingContent.trim()
        });
        
        updatedMessages[updatedMessages.length - 1].content = newContent;
      } else {
        // Add new assistant message with the partial response
        updatedMessages.push({
          role: "assistant",
          content: [{ type: "text", value: existingContent.trim() }]
        });
      }
    }
    
    // API key will be resolved later based on per-file config
    // Don't get global API key here as it might fail when per-file config is valid
    
    // Build final system prompt
    const { getDefaultSystemPrompt, generateToolCallingSystemPrompt } = require("./config");
    const defaultSystemPrompt = getDefaultSystemPrompt();
    const mcpGroupedTools = mcpClientManager.getGroupedTools();
    const toolSystemPrompt = generateToolCallingSystemPrompt(mcpGroupedTools);
    
    const finalSystemPrompt = [
      defaultSystemPrompt,
      customSystemPrompt,
      toolSystemPrompt
    ].filter(p => p && p.trim() !== '').join('\n\n');
    
    // Create StreamingService with per-file overrides if available
    const StreamingService = require("./streamer").StreamingService;

    // Determine per-file config
    const perFileConfigName: string | undefined = (parseResult as any).fileConfig?.selectedConfig;

    // Resolve API key and provider/baseUrl with per-file override if provided
    let apiKeyToUse: string;
    let providerOverride: string | undefined = undefined;
    let baseUrlOverride: string | undefined = undefined;
    try {
      if (perFileConfigName) {
        const { getApiKeyForConfig, getProviderForConfig, getBaseUrlForConfig } = require("./config");
        apiKeyToUse = getApiKeyForConfig(perFileConfigName);
        providerOverride = getProviderForConfig(perFileConfigName);
        baseUrlOverride = getBaseUrlForConfig(perFileConfigName);
        statusManager.updateProvider(providerOverride);
      } else {
        const { getApiKey, getProvider, getBaseUrl } = require("./config");
        apiKeyToUse = getApiKey();
        providerOverride = getProvider();
        baseUrlOverride = getBaseUrl();
        statusManager.updateProvider(providerOverride);
      }
    } catch (e) {
      const errorMsg = `Configuration error: ${e instanceof Error ? e.message : String(e)}`;
      log(errorMsg);
      vscode.window.showErrorMessage(errorMsg);
      return;
    }

    const streamingService = new StreamingService(
      apiKeyToUse as string,
      this.document,
      this.lock,
      providerOverride,
      baseUrlOverride,
      perFileConfigName,
    );
    
    // Create a streamer state that will resume in the existing assistant block
    const messageIndex = updatedMessages.length - 1;
    const streamer: StreamerState = {
      messageIndex,
      tokens: existingContent ? [existingContent] : [], // Initialize with existing content as tokens
      isActive: true,
      historyFilePath: undefined, // Will be set by streaming service if needed
      isHandlingToolCall: false,
      cancel: () => streamingService.cancelStreaming(streamer),
    };
    
    // Store the streamer
    this.streamers.set(messageIndex, streamer);
    log(`Created streamer for resuming in message index ${messageIndex} with ${streamer.tokens.length} existing tokens`);
    
    // Start streaming, which will continue from where the last response left off
    streamingService
      .streamResponse(updatedMessages, streamer, finalSystemPrompt, 0, 0, (parseResult as any).fileConfig)
      .catch((err: any) => {
        log(`Resume streaming error for index ${messageIndex}: ${err}`);
      })
      .finally(() => {
        log(`Resume streamer ${messageIndex} promise finally block reached.`);
        try { 
          requestStatusBarUpdate(this.document.uri.fsPath, "resume streaming finished");
        } catch {}
      });
  }

  /**
   * Start streaming response from LLM. Handles parsing, errors, prompt assembly, and initiation.
   */
  private async startStreaming(): Promise<void> {
    // Prevent concurrent streams for the same document
    const activeStreamer = this.getActiveStreamer();
    if (activeStreamer) {
        log(`Streaming is already active for this document. Active streamer: messageIndex=${activeStreamer.messageIndex}, isActive=${activeStreamer.isActive}, tokensLength=${activeStreamer.tokens.length}, isHandlingToolCall=${activeStreamer.isHandlingToolCall}`);
        return;
    }
    await this.lock.acquire();
    log("Acquired streaming lock.");

    try {
      const text = this.document.getText();
      // Parse document to read per-file configuration preamble first
      const parseResult: ParsedDocumentResult = parseDocument(text, this.document);

      // **Handle Image in System Block Error**
      if (parseResult.hasImageInSystemBlock) {
        log("Error: Image found in system block during startStreaming. Aborting.");
        this.removeLastEmptyBlock("assistant"); // Clean up trigger
        // Error message already shown by handleDocumentChange or checkDocument
        return;
      }

      // Extract messages and custom system prompt
      const messages: readonly MessageParam[] = parseResult.messages;

      // Determine per-file config (selectedConfig) if present
      const perFileConfigName: string | undefined = (parseResult as any).fileConfig?.selectedConfig;
      const customSystemPrompt: string = parseResult.systemPrompt;

      // Resolve API key using per-file config if present, else global
      let apiKeyToUse: string | undefined;
      try {
        const { getApiKeyForConfig, getApiKey } = require("./config");
        apiKeyToUse = perFileConfigName ? getApiKeyForConfig(perFileConfigName) : getApiKey();
      } catch (e) {
        apiKeyToUse = undefined;
      }
      if (!apiKeyToUse) {
        const which = perFileConfigName ? `for config "${perFileConfigName}"` : "in settings";
        const message = `Configuration error: API key missing ${which}.`;
        log(message);
        vscode.window.showErrorMessage(message);
        this.removeLastEmptyBlock("assistant");
        return;
      }

      log(`Parsed ${messages.length} messages. Custom system prompt length: ${customSystemPrompt.length}`);

      // **Check for Valid Messages**
      if (messages.length === 0) {
        log("No valid messages found to start streaming.");
        this.removeLastEmptyBlock("assistant"); // Clean up trigger
        return;
      }

      // **Construct Final System Prompt** (Combining default, custom, and tool prompts)
      const defaultSystemPrompt = getDefaultSystemPrompt();
      // Tool prompt generation (as per current structure)
      const mcpGroupedTools = mcpClientManager.getGroupedTools();
      const toolSystemPrompt = generateToolCallingSystemPrompt(mcpGroupedTools);
      // Combine
      const finalSystemPrompt = [
          defaultSystemPrompt,
          customSystemPrompt, // Add the custom prompt from the file
          toolSystemPrompt
      ].filter(p => p && p.trim() !== '').join('\n\n'); // Join non-empty parts

      log(`Final System Prompt Length: ${finalSystemPrompt.length}`);
      // log(`Final System Prompt:\n---\n${finalSystemPrompt}\n---`); // Debug if needed

      // **Save Chat History (with the final system prompt)**
      const historyFilePath = saveChatHistory(
        this.document,
        messages,
        "before_llm_call",
        finalSystemPrompt, // Use the combined prompt
      );
      log(`Saved chat history (before call) to: ${historyFilePath}`);


      // **Streamer Initialization and Management (as per current structure)**
      const messageIndex = messages.length - 1;

      if (this.streamers.has(messageIndex) && this.streamers.get(messageIndex)?.isActive) {
        log(`Streamer for message index ${messageIndex} already active, skipping.`);
        return;
      }

      // Resolve provider/baseUrl with per-file override if provided
      let providerOverride: string | undefined = undefined;
      let baseUrlOverride: string | undefined = undefined;
      try {
        if (perFileConfigName) {
          const { getApiKeyForConfig, getProviderForConfig, getBaseUrlForConfig } = require("./config");
          apiKeyToUse = getApiKeyForConfig(perFileConfigName);
          providerOverride = getProviderForConfig(perFileConfigName);
          baseUrlOverride = getBaseUrlForConfig(perFileConfigName);
          statusManager.updateProvider(providerOverride);
        } else {
          // fall back to currently selected provider
          const { getProvider, getBaseUrl } = require("./config");
          providerOverride = getProvider();
          baseUrlOverride = getBaseUrl();
          statusManager.updateProvider(providerOverride);
        }
      } catch (e) {
        const errorMsg = `Configuration error: ${e instanceof Error ? e.message : String(e)}`;
        log(errorMsg);
        vscode.window.showErrorMessage(errorMsg);
        this.removeLastEmptyBlock("assistant");
        return;
      }

      const streamingService = new StreamingService(
        apiKeyToUse as string, // Per-file or global API key
        this.document,
        this.lock,
        providerOverride,
        baseUrlOverride,
        perFileConfigName,
      );

      // Create streamer state
      const streamer: StreamerState = {
        messageIndex,
        tokens: [],
        isActive: true,
        historyFilePath,
        isHandlingToolCall: false,
        cancel: () => streamingService.cancelStreaming(streamer),
      };

      this.streamers.set(messageIndex, streamer);
      log(`Created new streamer for message index ${messageIndex}.`);
      // Update status bar to reflect new active streamer count/provider
      try { 
        requestStatusBarUpdate(this.document.uri.fsPath, "new streamer created");
      } catch {}

      // **Start streaming in background, passing the FINAL system prompt and file config**
      streamingService
        .streamResponse(messages, streamer, finalSystemPrompt, 0, 0, (parseResult as any).fileConfig) // Pass the combined prompt and file config
        .catch((err) => {
          log(`Streaming error for index ${messageIndex}: ${err}`);
        })
        .finally(() => {
          log(`Streamer ${messageIndex} promise finally block reached.`);
          // Refresh status bar when stream ends
          try { 
            requestStatusBarUpdate(this.document.uri.fsPath, "start streaming finished");
          } catch {}
        });

    } catch (error) {
        log(`Error in startStreaming setup phase: ${error}`);
        vscode.window.showErrorMessage(`Failed to initiate streaming: ${error}`);
        this.removeLastEmptyBlock("assistant"); // Clean up trigger on setup error
    }
    finally {
      // Always release the lock
      this.lock.release();
      log("Released streaming lock.");
    }
  }

  /**
   * Helper to remove the last empty block (assistant or tool_execute) from the end of the document.
   */
   // --- Keep the removeLastEmptyBlock function as defined in the previous attempt ---
   // --- (Assuming that part was correct and only startStreaming needed adjustment) ---
   private async removeLastEmptyBlock(type: "assistant" | "tool_execute"): Promise<void> {
       const text = this.document.getText();
       const marker = `# %% ${type}`;
       const lastMarkerIndex = text.lastIndexOf(marker);

       if (lastMarkerIndex === -1 || lastMarkerIndex < text.length - (marker.length + 50)) {
           return;
       }

        const newlineAfterMarker = text.indexOf('\n', lastMarkerIndex);
        const contentStartIndex = newlineAfterMarker === -1
            ? lastMarkerIndex + marker.length
            : newlineAfterMarker + 1;
        const contentAfterMarker = text.substring(contentStartIndex);

        if (/^\s*$/.test(contentAfterMarker)) {
            log(`Removing empty ${type} block starting at index ${lastMarkerIndex}`);
            let lineStartIndex = lastMarkerIndex;
            while (lineStartIndex > 0 && text[lineStartIndex - 1] !== '\n') {
                lineStartIndex--;
            }
            const adjustedStartPos = this.document.positionAt(lineStartIndex);
            const endPos = this.document.positionAt(text.length);
            const adjustedRange = new vscode.Range(adjustedStartPos, endPos);

            const edit = new vscode.WorkspaceEdit();
            edit.replace(this.document.uri, adjustedRange, "");

            try {
                 const success = await vscode.workspace.applyEdit(edit);
                 if (success) {
                     log(`Successfully removed empty ${type} block.`);
                 } else {
                     log(`Failed to apply edit to remove empty ${type} block.`);
                 }
            } catch (editError) {
                log(`Error applying edit to remove empty ${type} block: ${editError}`);
            }
        }
   }
   // --- End of removeLastEmptyBlock ---

   // ... (rest of the listener class, e.g., executeToolFromPreviousBlock, insertToolResult) ...
}
