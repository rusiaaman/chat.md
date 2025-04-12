import * as vscode from "vscode";
import {
  parseDocument, // Updated signature: returns { messages, systemPrompt, hasImageInSystemBlock }
  hasEmptyAssistantBlock,
  hasEmptyToolExecuteBlock,
  ParsedDocumentResult, // Import the return type interface
} from "./parser";
import { Lock } from "./utils/lock";
import { StreamingService } from "./streamer";
import { StreamerState, MessageParam } from "./types"; // Added MessageParam
import {
  getApiKey, // Keep existing config functions
  // getAnthropicApiKey, // No longer directly used in startStreaming based on latest snippet
  getProvider, // Keep existing config functions
  generateToolCallingSystemPrompt, // Keep existing config functions
  getDefaultSystemPrompt, // Add function to get default system prompt
} from "./config";
import * as path from "path";
import * as fs from "fs"; // Keep fs for file operations
import { log, mcpClientManager, statusManager } from "./extension"; // Import statusManager directly
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
  private readonly lock: Lock = new Lock();
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
      // Check for specific parse error: Invalid content before first block
      if (error instanceof Error && error.message === "INVALID_START_CONTENT") {
        log("Initial check: Invalid content before first block marker.");
        vscode.window.showErrorMessage(
          "Invalid content: Nothing outside of a valid block (# %% user, # %% system, etc.) should be present. Please start with a valid block.",
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

    log(`Document changed: ${this.document.fileName}`);
    const text = this.document.getText();

    try {
        // Parse the document on every change to check for errors first (invalid start, images in system)
        const parseResult = parseDocument(text, this.document);

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
      // Check for specific parse error: Invalid content before first block
      if (error instanceof Error && error.message === "INVALID_START_CONTENT") {
        log("Change detected: Invalid content before first block marker.");
        vscode.window.showErrorMessage(
          "Invalid content: Nothing outside of a valid block (# %% user, # %% system, etc.) should be present. Please start with a valid block.",
        );
        // Prevent triggering stream/tool execution if there's an error
        this.removeLastEmptyBlock("assistant"); // Remove trigger block if it exists
        this.removeLastEmptyBlock("tool_execute"); // Remove trigger block if it exists
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

    // Show tool execution status in the status bar
    statusManager.showToolExecutionStatus();
    log(`DocumentListener: Showing 'executing tool' status for tool_execute block`);

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
      if (error.name === 'AbortError' || 
          (error.message && (
            error.message.includes('AbortError') || 
            error.message.includes('cancelled') || 
            error.message.includes('canceled')
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
    // Extra safety check - if we somehow got a cancellation string or AbortError, ignore it
    if (typeof rawResult === 'string' && (
        rawResult.startsWith('CANCELLED:') || 
        rawResult.includes('AbortError') ||
        rawResult.includes('This operation was aborted')
      )) {
      log(`Caught cancelled result in insertToolResult - no action needed`);
      return;
    }
    
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
    const hasMultipleImages = contentToInsert.match(/!\[Tool generated image \d+\]/g)?.length > 1;
    
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
   * Start streaming response from LLM. Handles parsing, errors, prompt assembly, and initiation.
   */
  private async startStreaming(): Promise<void> {
    // Prevent concurrent streams for the same document
    if (this.getActiveStreamer()) {
        log("Streaming is already active for this document.");
        return;
    }
    await this.lock.acquire();
    log("Acquired streaming lock.");

    try {
      // Config validation (as per current structure)
      let apiKey: string | undefined;
      try {
        // Keep the require here if that's the current pattern
        const { getApiKey, getProvider } = require("./config");
        apiKey = getApiKey();
        // const provider = getProvider(); // Provider not explicitly used later in this snippet's logic
        if (!apiKey) {
          throw new Error("API key not configured");
        }
      } catch (error) {
        const message = `Configuration error: ${error instanceof Error ? error.message : String(error)}. Please configure an API...`; // Shortened message
        log(message);
        vscode.window.showErrorMessage(message);
        this.removeLastEmptyBlock("assistant"); // Clean up trigger
        return;
      }

      const text = this.document.getText();
      // **Parse document using the updated parser**
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
      // const customSystemPrompt: string =; // Removed incomplete duplicate line
      const customSystemPrompt: string = parseResult.systemPrompt; // Keep correct line

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

      // Create StreamingService (ensure constructor matches required args: apiKey, document, lock)
      const streamingService = new StreamingService(
        apiKey, // Pass the validated API key
        this.document,
        this.lock,
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

      // **Start streaming in background, passing the FINAL system prompt**
      streamingService
        .streamResponse(messages, streamer, finalSystemPrompt) // Pass the combined prompt
        .catch((err) => {
          log(`Streaming error for index ${messageIndex}: ${err}`);
          // State management (isActive = false) should happen within StreamingService or cancel
          // streamer.isActive = false; // Avoid setting state directly here if service handles it
        })
        .finally(() => {
            log(`Streamer ${messageIndex} promise finally block reached.`);
             // Consider if map cleanup is needed here or handled by the service/cancel logic
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
