import * as vscode from 'vscode';
import { MessageParam, StreamerState } from './types';
import { Lock } from './utils/lock';
import { AnthropicClient } from './anthropicClient';
import { findAssistantBlocks, findAllAssistantBlocks } from './parser';
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
      
      // Add information about assistant blocks in the document
      const assistantBlocks = findAllAssistantBlocks(currentText);
      log(`Document contains ${assistantBlocks.length} assistant blocks, will look for last non-empty block if needed`);
      
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
    
    log(`STREAMER DEBUG: Attempting to update with ${newTokens.length} tokens: "${newTokens.join('')}"`);
    await this.lock.acquire();
    
    try {
      const text = this.document.getText();
      const tokensSoFar = streamer.tokens.join('');
      
      log(`Looking for insertion point for ${newTokens.length} new tokens: "${newTokens.join('')}"`);
      
      // Find the last non-empty assistant block for streaming
      let lastAssistantIdx = -1;
      let blockStart = -1;
      let isEmptyBlock = true;
      
      // Get all assistant blocks in the document
      const assistantMarkers = findAllAssistantBlocks(text);
      log(`Found ${assistantMarkers.length} assistant blocks in document`);
      
      // Check blocks from last to first to find the last non-empty one
      for (let i = assistantMarkers.length - 1; i >= 0; i--) {
        const marker = assistantMarkers[i];
        // Check if there's any content after the content start position
        const nextMarkerStart = i < assistantMarkers.length - 1 ? 
          assistantMarkers[i + 1].markerStart : text.length;
        
        // Extract the content between this marker and the next one (or end of document)
        const content = text.substring(marker.contentStart, nextMarkerStart).trim();
        
        // If this is the very last block, always use it (might be empty on purpose)
        if (i === assistantMarkers.length - 1) {
          lastAssistantIdx = marker.markerStart;
          blockStart = marker.contentStart;
          isEmptyBlock = content.length === 0;
          log(`Using last assistant block at position ${lastAssistantIdx}, block starts at ${blockStart}`);
          log(`Last block is ${isEmptyBlock ? 'empty' : 'non-empty'}`);
          
          // If the last block is non-empty or if we're just starting (no tokens yet), use it
          if (!isEmptyBlock || streamer.tokens.length === 0) {
            break;
          }
        }
        
        // If we're here and looking at a previous block, only use it if it's non-empty
        if (content.length > 0) {
          lastAssistantIdx = marker.markerStart;
          blockStart = marker.contentStart;
          isEmptyBlock = false;
          log(`Found previous non-empty assistant block at position ${lastAssistantIdx}, block starts at ${blockStart}`);
          break;
        }
      }
      
      if (lastAssistantIdx === -1 || blockStart === -1) {
        log('No suitable assistant block found in document, stopping streamer');
        streamer.isActive = false;
        return;
      }
      log(`Document text at block start (20 chars): "${text.substring(blockStart, blockStart+20)}"`);
      
      // Check if our tokens match what's already in the document
      // This is the key idempotent check - we need to find our previous tokens
      const textAfterBlock = text.substring(blockStart);
      if (!textAfterBlock.startsWith(tokensSoFar)) {
        log(`STREAMER ERROR: Tokens don't match what's in the document, stopping streamer`);
        log(`Expected: "${tokensSoFar.substring(0, 20)}${tokensSoFar.length > 20 ? '...' : ''}"`);
        log(`Found: "${textAfterBlock.substring(0, 20)}${textAfterBlock.length > 20 ? '...' : ''}"`);
        
        // Additional troubleshooting logs
        log(`STREAMER ERROR DETAILS:`);
        log(`- Last assistant block position: ${lastAssistantIdx}`);
        log(`- Block start position: ${blockStart}`);
        log(`- Document length: ${text.length}`);
        log(`- tokensSoFar length: ${tokensSoFar.length}`);
        log(`- Last 3 token chunks: ${JSON.stringify(streamer.tokens.slice(-3).map(t => t.substring(0, 10) + (t.length > 10 ? '...' : '')))}`);
        
        // Check if textAfterBlock contains tokensSoFar anywhere (not just at start)
        const indexInText = textAfterBlock.indexOf(tokensSoFar);
        if (indexInText > 0) {
          log(`STREAMER NOTE: Found tokens at offset ${indexInText} instead of at beginning`);
        }
        
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
      log(`STREAMER ACTION: About to apply edit at document version: ${this.document.version}`);
      const applied = await vscode.workspace.applyEdit(edit);
      log(`STREAMER RESULT: Edit applied: ${applied}`);
      
      if (!applied) {
        log(`STREAMER ERROR: Failed to apply edit, details:`);
        log(`- Document URI: ${this.document.uri.toString()}`);
        log(`- Insert position: Line ${insertPosition.line}, Character ${insertPosition.character}`);
        log(`- Document version: ${this.document.version}`);
        log(`- Document read-only: ${this.document.isUntitled ? 'No' : 'Unknown'}`);
      }
      
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