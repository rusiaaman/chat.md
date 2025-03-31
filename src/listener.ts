import * as vscode from 'vscode';
import { parseDocument, hasEmptyAssistantBlock, hasEmptyToolExecuteBlock } from './parser';
import { Lock } from './utils/lock';
import { StreamingService } from './streamer';
import { StreamerState } from './types';
import { getApiKey, getAnthropicApiKey, getProvider } from './config';
import * as path from 'path';
import { log } from './extension';
import { executeToolCall, formatToolResult, parseToolCall } from './tools/toolExecutor';
import { ensureDirectoryExists, writeFile } from './utils/fileUtils';

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
    const changeListener = vscode.workspace.onDidChangeTextDocument(
      event => this.handleDocumentChange(event)
    );
    
    this.disposables.push(changeListener);
    
    // Check document initially
    this.checkDocument();
    
    return {
      dispose: () => {
        this.disposables.forEach(d => d.dispose());
        this.streamers.forEach(streamer => {
          streamer.isActive = false;
        });
        this.streamers.clear();
      }
    };
  }
  
  /**
   * Check document for empty assistant block
   */
  private async checkDocument(): Promise<void> {
    if (this.document.fileName.endsWith('.chat.md')) {
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
  private async handleDocumentChange(event: vscode.TextDocumentChangeEvent): Promise<void> {
    if (event.document.uri.toString() !== this.document.uri.toString()) {
      return;
    }
    
    if (this.document.fileName.endsWith('.chat.md')) {
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
      }
      else {
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
      const blockRegex = /#%% tool_execute\s*([\s\S]*?)(?=#%%|$)/gm;
      const emptyBlocks = [];
      let match;
      
      while ((match = blockRegex.exec(text)) !== null) {
        const content = match[1].trim();
        const position = match.index;
        const blockLength = match[0].length;
        
        if (content === '') {
          emptyBlocks.push({ position, blockLength });
          log(`Found empty tool_execute block at position ${position}`);
        } else {
          log(`Found non-empty tool_execute block at position ${position}`);
        }
      }
      
      if (emptyBlocks.length === 0) {
        log('No empty tool_execute blocks found');
        return;
      }
      
      // Use the LAST empty block
      const lastEmptyBlock = emptyBlocks[emptyBlocks.length - 1];
      log(`Using last empty tool_execute block at position ${lastEmptyBlock.position}`);
      
      const toolExecutePosition = lastEmptyBlock.position;
      
      // Find the previous assistant block with a tool call
      const textBeforeToolExecute = text.substring(0, toolExecutePosition);
      const assistantBlockRegex = /#%% assistant\s+([\s\S]*?)(?=\n#%%|$)/g;
      
      // Find the last match
      let assistantBlockMatch;
      let lastMatch;
      
      while ((assistantBlockMatch = assistantBlockRegex.exec(textBeforeToolExecute)) !== null) {
        lastMatch = assistantBlockMatch;
      }
      
      if (!lastMatch) {
        log('No assistant block found before tool_execute');
        const errorResult = formatToolResult("Error: No assistant block found before tool_execute");
        await this.insertToolResult(errorResult);
        return;
      }
      
      // Extract the assistant's response
      const assistantResponse = lastMatch[1].trim();
      log(`Found assistant response: "${assistantResponse.substring(0, 100)}${assistantResponse.length > 100 ? '...' : ''}"`);
      
      // Look for tool call XML - find the LAST match instead of first
      const toolCallRegex = /<tool_call>\n([\s\S]*?)\n<\/tool_call>/sg; // Ensure newlines around content
      
      // Find all matches and use the last one
      let toolCallMatch;
      let lastToolCallMatch = null;
      while ((toolCallMatch = toolCallRegex.exec(assistantResponse)) !== null) {
        lastToolCallMatch = toolCallMatch;
      }
      
      // Use the last match
      toolCallMatch = lastToolCallMatch;
      
      if (!toolCallMatch) {
        log('No tool call found in assistant response');
        const errorResult = formatToolResult("Error: No tool call found in assistant response");
        await this.insertToolResult(errorResult);
        return;
      }
      
      const toolCallXml = toolCallMatch[0];
      log(`Found tool call: "${toolCallXml.substring(0, 100)}${toolCallXml.length > 100 ? '...' : ''}"`);
      
      const parsedToolCall = parseToolCall(toolCallXml);
      
      if (!parsedToolCall) {
        log('Invalid tool call format');
        const errorResult = formatToolResult("Error: Invalid tool call format");
        await this.insertToolResult(errorResult);
        return;
      }
      
      log(`Executing tool: ${parsedToolCall.name} with params: ${JSON.stringify(parsedToolCall.params)}`);
      
      // Execute the tool
      const rawResult = await executeToolCall(parsedToolCall.name, parsedToolCall.params, this.document);
      
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
  private async insertToolResult(rawResult: string, isPreformattedError = false): Promise<void> {
    const text = this.document.getText();
    let contentToInsert = '';
    const lineCountThreshold = 30;

    if (isPreformattedError) {
      // If it's a preformatted error, use it directly
      contentToInsert = rawResult;
      log('Inserting preformatted error message.');
    } else {
      // Process the raw tool result
      const lines = rawResult.split('\n');
      log(`Tool result has ${lines.length} lines.`);

      if (lines.length > lineCountThreshold) {
        log(`Result exceeds ${lineCountThreshold} lines, saving to file.`);
        try {
          const docDir = path.dirname(this.document.uri.fsPath);
          const assetsDir = path.join(docDir, 'cmdassets');
          ensureDirectoryExists(assetsDir);

          const timestamp = new Date().toISOString()
            .replace(/:/g, '')
            .replace(/-/g, '')
            .replace('T', '-')
            .replace(/\..+Z/, '');
          const randomString = Math.random().toString(36).substring(2, 8);
          const filename = `tool-result-${timestamp}-${randomString}.txt`;
          const relativeFilePath = path.join('cmdassets', filename);
          const fullFilePath = path.join(assetsDir, filename);

          writeFile(fullFilePath, rawResult);
          log(`Saved tool result to: ${fullFilePath}`);

          const markdownLink = `[Tool Result](${relativeFilePath.replace(/\\/g, '/')})`; // Ensure forward slashes for Markdown
          contentToInsert = formatToolResult(markdownLink); // Wrap the link in result tags
          log(`Inserting Markdown link: ${markdownLink}`);

        } catch (fileError) {
          log(`Error saving tool result to file: ${fileError}`);
          // Fallback: insert truncated result with error message
          const truncatedResult = lines.slice(0, lineCountThreshold).join('\n');
          contentToInsert = formatToolResult(
            `${truncatedResult}\n...\n[Error: Failed to save full result to file - ${fileError}]`
          );
          log('Inserting truncated result with error message due to file save failure.');
        }
      } else {
        // Result is small enough, insert directly
        contentToInsert = formatToolResult(rawResult);
        log('Inserting full tool result directly.');
      }
    }

    // Find the insertion point (within the last empty tool_execute block)
    const blockRegex = /#%% tool_execute\s*([\s\S]*?)(?=#%%|$)/gm;
    const emptyBlocks = [];
    let match;
    
    while ((match = blockRegex.exec(text)) !== null) {
      const content = match[1].trim();
      const position = match.index;
      const blockLength = match[0].length;
      
      if (content === '') {
        emptyBlocks.push({ position, blockLength });
        log(`Found empty tool_execute block at position ${position} for result insertion`);
      }
    }
    
    if (emptyBlocks.length === 0) {
      log('No empty tool_execute blocks found for inserting result');
      return;
    }

    // Use the LAST empty block
    const lastEmptyBlock = emptyBlocks[emptyBlocks.length - 1];
    const insertOffset = lastEmptyBlock.position + '#%% tool_execute'.length; // Position after the marker line
    log(`Targeting insert offset ${insertOffset} within the empty tool_execute block at ${lastEmptyBlock.position}`);

    // We need to replace the empty content within the block, not insert after it.
    const startPos = this.document.positionAt(insertOffset);
    // Find the end of the empty block content (before the next #%% or EOF)
    const endOffset = text.indexOf('%%#', insertOffset); // Look for the start of the next marker reversed
    const actualEndOffset = endOffset !== -1 ? text.substring(0, endOffset).lastIndexOf('#') : text.length; // Find the actual start of the next marker or EOF
    const endPos = this.document.positionAt(actualEndOffset);

    log(`Calculated insertion range: Start(${startPos.line},${startPos.character}), End(${endPos.line},${endPos.character})`);

    // Create an edit that replaces the empty content with the result and adds a new assistant block after
    // Ensure proper newlines around the content
    let textToInsert = `\n${contentToInsert.trim()}\n\n#%% assistant\n`;
    // If the block wasn't just the marker but had whitespace, adjust insertion
    const existingContent = text.substring(insertOffset, actualEndOffset);
    if (existingContent.trim() !== '') {
       log(`Warning: Overwriting non-empty whitespace in tool_execute block: "${existingContent}"`);
    }

    const edit = new vscode.WorkspaceEdit();
    // Replace the content between the tool_execute marker and the next block/EOF
    edit.replace(this.document.uri, new vscode.Range(startPos, endPos), textToInsert);

    log(`Applying edit to insert: "${textToInsert.substring(0,100)}..."`);
    
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      log('Failed to insert tool result into document');
    } else {
      log('Successfully inserted tool result and new assistant block');
      
      // Auto-scroll to keep the newly inserted content visible and ensure we're scrolled to the bottom
      try {
        // Find the editor for this document
        const editor = vscode.window.visibleTextEditors.find(
          e => e.document.uri.toString() === this.document.uri.toString()
        );
        
        if (editor) {
          // Get the position of the very end of the document to ensure we scroll all the way to the bottom
          const docEnd = this.document.lineAt(this.document.lineCount - 1).range.end;
          
          // Reveal the end of the document in the editor, always ensuring it's visible
          editor.revealRange(
            new vscode.Range(docEnd, docEnd),
            vscode.TextEditorRevealType.InCenterIfOutsideViewport
          );
          
          // Move cursor to the end of the document for better user experience
          editor.selection = new vscode.Selection(docEnd, docEnd);
          
          log(`Auto-scrolled editor to the end of the document to show inserted content`);
        }
      } catch (scrollError) {
        log(`Auto-scroll error (non-critical): ${scrollError}`);
        // Continue even if auto-scroll fails
      }
    }
  }
  
  /**
   * Start streaming response from LLM
   */
  private async startStreaming(): Promise<void> {
    await this.lock.acquire();
    
    try {
      // Check for API key based on provider
      const provider = getProvider();
      let apiKey = getApiKey();
      
      // For backward compatibility, try the legacy anthropic key if we're using Anthropic
      if (!apiKey && provider === 'anthropic') {
        apiKey = getAnthropicApiKey();
      }
      
      if (!apiKey) {
        const message = `${provider.charAt(0).toUpperCase() + provider.slice(1)} API key not configured. Please use the "Configure Chat Markdown API Key" command.`;
        log(message);
        vscode.window.showErrorMessage(message);
        return;
      }
      
      const text = this.document.getText();
      const messages = parseDocument(text, this.document);
      
      log(`Parsed ${messages.length} messages from document`);
      
      if (messages.length === 0) {
        log('No messages to process, not starting streaming');
        return;
      }
      
      const messageIndex = messages.length - 1;
      
      // Check if we already have an active streamer for this message
      if (this.streamers.has(messageIndex) && this.streamers.get(messageIndex)!.isActive) {
        log(`Streamer for message index ${messageIndex} already active, not starting new one`);
        return;
      }
      
      // Create new streamer state
      const streamer: StreamerState = {
        messageIndex,
        tokens: [],
        isActive: true
      };
      
      this.streamers.set(messageIndex, streamer);
      log(`Created new streamer for message index ${messageIndex}`);
      
      // Start streaming in background
      const streamingService = new StreamingService(apiKey, this.document, this.lock);
      
      // Start streaming without awaiting to allow it to run in the background
      streamingService.streamResponse(messages, streamer).catch(err => {
        log(`Streaming error: ${err}`);
        streamer.isActive = false;
      });
    } finally {
      this.lock.release();
    }
  }
}