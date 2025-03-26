import * as vscode from 'vscode';
import { MessageParam, StreamerState } from './types';
import { Lock } from './utils/lock';
import { AnthropicClient } from './anthropicClient';
import { findAssistantBlocks } from './parser';

/**
 * Service for streaming LLM responses
 */
export class StreamingService {
  private readonly client: AnthropicClient;
  
  constructor(
    apiKey: string,
    private readonly document: vscode.TextDocument,
    private readonly lock: Lock
  ) {
    this.client = new AnthropicClient(apiKey);
  }
  
  /**
   * Stream LLM response for given messages
   * Updates document idempotently as tokens arrive
   */
  public async streamResponse(
    messages: readonly MessageParam[],
    streamer: StreamerState
  ): Promise<void> {
    try {
      // Start streaming completion, passing document for file path resolution
      const stream = await this.client.streamCompletion(messages, this.document);
      
      for await (const tokens of stream) {
        if (!streamer.isActive) {
          break;
        }
        
        await this.updateDocumentWithTokens(streamer, tokens);
      }
    } catch (error) {
      console.error('Streaming error:', error);
      // Show error in status bar
      vscode.window.setStatusBarMessage(`FileChat streaming error: ${error}`, 5000);
    } finally {
      streamer.isActive = false;
    }
  }
  
  /**
   * Updates document with new tokens idempotently
   */
  private async updateDocumentWithTokens(
    streamer: StreamerState,
    newTokens: string[]
  ): Promise<void> {
    if (newTokens.length === 0) {
      return;
    }
    
    await this.lock.acquire();
    
    try {
      const text = this.document.getText();
      const tokensSoFar = streamer.tokens.join('');
      
      // Find all assistant blocks
      const assistantBlocks = findAssistantBlocks(text);
      
      if (assistantBlocks.length === 0) {
        streamer.isActive = false;
        return;
      }
      
      // Get the last assistant block
      const lastBlock = assistantBlocks[assistantBlocks.length - 1];
      const blockStart = lastBlock.end;
      
      // Check if our tokens match what's already in the document
      const textAfterBlock = text.substring(blockStart);
      if (!textAfterBlock.startsWith(tokensSoFar)) {
        // Our tokens don't match, document might have been modified
        streamer.isActive = false;
        return;
      }
      
      // Insert new tokens at the end of our existing tokens
      const insertPosition = this.document.positionAt(blockStart + tokensSoFar.length);
      
      const edit = new vscode.WorkspaceEdit();
      edit.insert(this.document.uri, insertPosition, newTokens.join(''));
      
      await vscode.workspace.applyEdit(edit);
      
      // Update tokens history
      streamer.tokens.push(...newTokens);
    } catch (error) {
      console.error('Error updating document:', error);
      streamer.isActive = false;
    } finally {
      this.lock.release();
    }
  }
}