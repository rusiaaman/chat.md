import * as vscode from 'vscode';
import { parseDocument, hasEmptyAssistantBlock, hasEmptyToolExecuteBlock } from './parser';
import { Lock } from './utils/lock';
import { StreamingService } from './streamer';
import { StreamerState } from './types';
import { getApiKey, getAnthropicApiKey, getProvider } from './config';
import { log } from './extension';
import { executeToolCall, formatToolResult, parseToolCall } from './tools/toolExecutor';

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
      
      // Find the empty tool_execute block
      const toolExecuteMatch = /#%% tool_execute\s*$/m.exec(text);
      if (!toolExecuteMatch) {
        log('No empty tool_execute block found');
        return;
      }
      
      // Check if this block already has content (already executed)
      const blockStart = toolExecuteMatch.index + toolExecuteMatch[0].length;
      const blockEndMatch = /#%%/m.exec(text.substring(blockStart));
      const blockEnd = blockEndMatch ? blockStart + blockEndMatch.index : text.length;
      const blockContent = text.substring(blockStart, blockEnd).trim();
      
      if (blockContent.length > 0) {
        log('Tool_execute block already has content, not executing again');
        return;
      }
      
      const toolExecutePosition = toolExecuteMatch.index;
      
      // Find the previous assistant block with a tool call
      const textBeforeToolExecute = text.substring(0, toolExecutePosition);
      const assistantBlockRegex = /#%% assistant\s+([\s\S]*?)(?=#%%|$)/g;
      
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
      
      // Look for tool call XML
      const toolCallRegex = /<tool_call>([\s\S]*?)<\/tool_call>/s;
      const toolCallMatch = toolCallRegex.exec(assistantResponse);
      
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
      const result = await executeToolCall(parsedToolCall.name, parsedToolCall.params, this.document);
      
      // Format and insert the result
      const formattedResult = formatToolResult(result);
      await this.insertToolResult(formattedResult);
    } catch (error) {
      log(`Error executing tool: ${error}`);
      const errorResult = formatToolResult(`Error executing tool: ${error}`);
      await this.insertToolResult(errorResult);
    } finally {
      this.lock.release();
    }
  }
  
  /**
   * Insert tool result into the document and add a new assistant block
   */
  private async insertToolResult(result: string): Promise<void> {
    const text = this.document.getText();
    const toolExecuteMatch = /#%% tool_execute\s*$/m.exec(text);
    
    if (!toolExecuteMatch) {
      log('Tool_execute block not found for inserting result');
      return;
    }
    
    const position = this.document.positionAt(toolExecuteMatch.index + toolExecuteMatch[0].length);
    
    // Create an edit that adds the tool result followed by a new assistant block
    const edit = new vscode.WorkspaceEdit();
    edit.insert(this.document.uri, position, `\n${result}\n\n#%% assistant\n`);
    
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      log('Failed to insert tool result into document');
    } else {
      log('Successfully inserted tool result and new assistant block');
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