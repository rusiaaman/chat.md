import * as vscode from "vscode";
import {
  parseDocument,
  hasEmptyAssistantBlock,
  hasEmptyToolExecuteBlock,
} from "./parser";
import { Lock } from "./utils/lock";
import { StreamingService } from "./streamer";
import { StreamerState } from "./types";
import {
  getApiKey,
  getAnthropicApiKey,
  getProvider,
  generateToolCallingSystemPrompt,
} from "./config"; // Added generateToolCallingSystemPrompt
import * as path from "path";
import * as fs from "fs";
import { log, mcpClientManager } from "./extension"; // Added mcpClientManager
import { executeToolCall, formatToolResult } from "./tools/toolExecutor"; // Removed parseToolCall from here
import { parseToolCall } from "./tools/toolCallParser"; // Added import for the correct parser
import {
  ensureDirectoryExists,
  writeFile,
  saveChatHistory,
} from "./utils/fileUtils";

/**
 * Listens for document changes and manages streaming LLM responses
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
   * Check document for empty assistant block
   */
  private async checkDocument(): Promise<void> {
    if (this.document.fileName.endsWith(".chat.md")) {
      log(`Checking document: ${this.document.fileName}`);
      const text = this.document.getText();
      if (hasEmptyAssistantBlock(text)) {
        log(`Found empty assistant block, starting streaming`);
        await this.startStreaming();
      } else {
        log(`No empty assistant block found`);
      }
    }
  }

  /**
   * Handle document changes and start streaming if needed
   */
  private async handleDocumentChange(
    event: vscode.TextDocumentChangeEvent,
  ): Promise<void> {
    if (event.document.uri.toString() !== this.document.uri.toString()) {
      return;
    }

    if (this.document.fileName.endsWith(".chat.md")) {
      log(`Document changed: ${this.document.fileName}`);
      const text = this.document.getText();

      // Check if any change added an empty assistant block
      if (hasEmptyAssistantBlock(text)) {
        log(`Found empty assistant block after change, starting streaming`);
        await this.startStreaming();
      }
      // Check if any change added an empty tool_execute block
      else if (hasEmptyToolExecuteBlock(text)) {
        log(`Found empty tool_execute block after change, executing tool`);
        await this.executeToolFromPreviousBlock();
      } else {
        log(`No empty assistant or tool_execute block found after change`);
      }
    }
  }

  /**
   * Execute tool from previous assistant block with tool call
   */
  private async executeToolFromPreviousBlock(): Promise<void> {
    await this.lock.acquire();

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

      // Append the result to the execution log
      executionLog += `## Tool Execution Result\n\n\`\`\`\n${rawResult}\n\`\`\`\n`;
      fs.writeFileSync(executionLogPath, executionLog);
      log(`Tool execution result appended to log: ${executionLogPath}`);

      // Insert the raw result (insertToolResult will handle formatting/linking)
      await this.insertToolResult(rawResult);
    } catch (error) {
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
    const text = this.document.getText();
    let contentToInsert = "";
    const lineCountThreshold = 30;

    if (isPreformattedError) {
      // If it's a preformatted error, use it directly
      contentToInsert = rawResult;
      log("Inserting preformatted error message.");
    } else {
      // Process the raw tool result
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
      rawResult.split("\n").length > lineCountThreshold &&
      contentToInsert.includes("[Tool Result]");

    // If it's a markdown link to a file, don't wrap in code fences so it's clickable
    // Otherwise, wrap in code fences for better display of code/text content
    let textToInsert = isMarkdownLink
      ? `\n${contentToInsert.trim()}\n\n# %% assistant\n`
      : `\n\`\`\`\n${contentToInsert.trim()}\n\`\`\`\n\n# %% assistant\n`;
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
  }

  /**
   * Start streaming response from LLM
   */
  private async startStreaming(): Promise<void> {
    await this.lock.acquire();

    try {
      let apiKey;
      try {
        // Import config functions to ensure they're available
        const { getApiKey, getProvider } = require("./config");

        // Get API key from the selected configuration
        apiKey = getApiKey();
        const provider = getProvider();

        if (!apiKey) {
          throw new Error("API key not configured");
        }
      } catch (error) {
        // Handle configuration errors gracefully
        const message = `Configuration error: ${error instanceof Error ? error.message : String(error)}. Please configure an API using the "Add or Edit API Configuration" command and select it.`;
        log(message);
        vscode.window.showErrorMessage(message);
        return;
      }

      const text = this.document.getText();
      const messages = parseDocument(text, this.document);

      log(`Parsed ${messages.length} messages from document`);

      // Generate system prompt first, using grouped tools
      const mcpGroupedTools = mcpClientManager.getGroupedTools(); // Get tools grouped by server
      const systemPrompt = generateToolCallingSystemPrompt(mcpGroupedTools); // Pass the map
      log(
        `Generated system prompt for history log: ${systemPrompt.substring(0, 100)}...`,
      );

      // Save chat history for debugging, now including the system prompt
      const historyFilePath = saveChatHistory(
        this.document,
        messages,
        "before_llm_call",
        systemPrompt,
      );
      log(`Saved chat history to: ${historyFilePath}`);

      if (messages.length === 0) {
        log("No messages to process, not starting streaming");
        return;
      }

      const messageIndex = messages.length - 1;

      // Check if we already have an active streamer for this message
      if (
        this.streamers.has(messageIndex) &&
        this.streamers.get(messageIndex)!.isActive
      ) {
        log(
          `Streamer for message index ${messageIndex} already active, not starting new one`,
        );
        return;
      }

      // Create streaming service first so we can reference it in the cancel method
      const streamingService = new StreamingService(
        apiKey,
        this.document,
        this.lock,
      );

      // Create new streamer state with cancellation capability
      const streamer: StreamerState = {
        messageIndex,
        tokens: [],
        isActive: true,
        historyFilePath, // Store the history file path in the streamer state
        cancel: () => streamingService.cancelStreaming(streamer),
      };

      this.streamers.set(messageIndex, streamer);
      log(
        `Created new streamer for message index ${messageIndex} with cancellation capability`,
      );

      // Start streaming without awaiting, passing the generated system prompt
      streamingService
        .streamResponse(messages, streamer, systemPrompt)
        .catch((err) => {
          log(`Streaming error: ${err}`);
          streamer.isActive = false;
        });
    } finally {
      this.lock.release();
    }
  }
}
