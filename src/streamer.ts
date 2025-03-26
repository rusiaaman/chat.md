import * as vscode from 'vscode';
import { MessageParam, StreamerState } from './types';
import { Lock } from './utils/lock';
import { AnthropicClient } from './anthropicClient';
import { findAssistantBlocks } from './parser';
import { log } from './extension';

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
      log(`Starting to stream response for ${messages.length} messages`);
      
      // Start streaming completion, passing document for file path resolution
      const stream = await this.client.streamCompletion(messages, this.document);
      log('Stream connection established');
      
      // Debug the document state before streaming
      const currentText = this.document.getText();
      log(`Current document text length: ${currentText.length} chars`);
      log(`Current streamer tokens: ${streamer.tokens.length} tokens`);
      
      // Extract message for logging
      const lastUserMessage = messages.length > 0 && messages[messages.length - 1].role === 'user' 
        ? messages[messages.length - 1].content
          .filter(c => c.type === 'text')
          .map(c => (c as any).value)
          .join(' ')
        : 'No user message';
      log(`Streaming response to: "${lastUserMessage.substring(0, 50)}${lastUserMessage.length > 50 ? '...' : ''}"`);
      
      let tokenCount = 0;
      
      for await (const tokens of stream) {
        if (!streamer.isActive) {
          log('Streamer no longer active, stopping stream');
          break;
        }
        
        if (tokens.length > 0) {
          tokenCount += tokens.length;
          log(`Received ${tokens.length} tokens: "${tokens.join('')}"`);
          
          try {
            await this.updateDocumentWithTokens(streamer, tokens);
          } catch (error) {
            log(`Error updating document with tokens: ${error}`);
            // Continue streaming even if one update fails
          }
        } else {
          log('Received empty tokens array, skipping update');
        }
      }
      
      log(`Stream completed successfully, processed ${tokenCount} tokens total`);
    } catch (error) {
      log(`Streaming error: ${error}`);
      console.error('Streaming error:', error);
      // Show error in status bar
      vscode.window.setStatusBarMessage(`FileChat streaming error: ${error}`, 5000);
    } finally {
      log('Streaming finished, marking streamer as inactive');
      streamer.isActive = false;
    }
  }
  
  /**
   * Updates document with new tokens idempotently
   * Follows the pattern:
   * 1. Save history of tokens in streamer
   * 2. Search for past text in last assistant block
   * 3. If found, append new tokens; if not found, abort streamer
   */
  private async updateDocumentWithTokens(
    streamer: StreamerState,
    newTokens: string[]
  ): Promise<void> {
    if (newTokens.length === 0) {
      log('No tokens to update');
      return;
    }
    
    await this.lock.acquire();
    
    try {
      const text = this.document.getText();
      const tokensSoFar = streamer.tokens.join('');
      
      log(`Looking for insertion point for ${newTokens.length} new tokens: "${newTokens.join('')}"`);
      
      // First, find the last #%% assistant marker in the text
      // Revert to the original working pattern
      const lastAssistantIdx = text.lastIndexOf('#%% assistant');
      if (lastAssistantIdx === -1) {
        log('No #%% assistant marker found in document, stopping streamer');
        streamer.isActive = false;
        return;
      }
      
      // Find the end of the assistant marker line
      let blockStart = lastAssistantIdx + 13; // Length of '#%% assistant'
      
      // Skip any whitespace after the marker
      while (blockStart < text.length && 
             (text[blockStart] === ' ' || text[blockStart] === '\t')) {
        blockStart++;
      }
      
      // Skip newline - should always be present based on our hasEmptyAssistantBlock check
      if (blockStart < text.length && text[blockStart] === '\n') {
        blockStart++;
      } else {
        // If no newline, log a warning but continue
        log('Warning: No newline found after #%% assistant, but continuing anyway');
      }
      
      log(`Found last assistant marker at position ${lastAssistantIdx}, block starts at ${blockStart}`);
      log(`Document text at block start (20 chars): "${text.substring(blockStart, blockStart+20)}"`);
      
      // Check if our tokens match what's already in the document
      // This is the key idempotent check - we need to find our previous tokens
      const textAfterBlock = text.substring(blockStart);
      if (!textAfterBlock.startsWith(tokensSoFar)) {
        log(`Tokens don't match what's in the document, stopping streamer`);
        log(`Expected: "${tokensSoFar.substring(0, 20)}${tokensSoFar.length > 20 ? '...' : ''}"`);
        log(`Found: "${textAfterBlock.substring(0, 20)}${textAfterBlock.length > 20 ? '...' : ''}"`);
        streamer.isActive = false;
        return;
      }
      
      // Calculate the insert position at the end of our existing tokens
      const insertPosition = this.document.positionAt(blockStart + tokensSoFar.length);
      log(`Inserting at position: line ${insertPosition.line}, character ${insertPosition.character}`);
      
      // Insert text using a workspace edit as per original design
      log(`Inserting text: "${newTokens.join('')}"`);
      
      const edit = new vscode.WorkspaceEdit();
      edit.insert(this.document.uri, insertPosition, newTokens.join(''));
      
      // Log before applying edit
      log(`About to apply edit at document version: ${this.document.version}`);
      const applied = await vscode.workspace.applyEdit(edit);
      log(`Edit applied: ${applied}`);
      
      // If edit failed, we log the error but don't try alternative approaches
      // This follows the idempotent design in the original docs
      if (!applied) {
        log('WorkspaceEdit failed, streamer will continue to try with next tokens');
      }
      
      // Update tokens history
      streamer.tokens.push(...newTokens);
      log(`Updated token history, now have ${streamer.tokens.length} tokens total`);
    } catch (error) {
      log(`Error updating document: ${error}`);
      console.error('Error updating document:', error);
      streamer.isActive = false;
    } finally {
      this.lock.release();
    }
  }
}