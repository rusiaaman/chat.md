import * as vscode from 'vscode';
import { parseDocument, hasEmptyAssistantBlock } from './parser';
import { Lock } from './utils/lock';
import { StreamingService } from './streamer';
import { StreamerState } from './types';
import { getAnthropicApiKey } from './config';
import { log } from './extension';

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
      } else {
        log(`No empty assistant block found after change`);
      }
    }
  }
  
  /**
   * Start streaming response from LLM
   */
  private async startStreaming(): Promise<void> {
    await this.lock.acquire();
    
    try {
      const apiKey = getAnthropicApiKey();
      
      if (!apiKey) {
        const message = 'Anthropic API key not configured. Please use the "Configure Chat Markdown API Key" command.';
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