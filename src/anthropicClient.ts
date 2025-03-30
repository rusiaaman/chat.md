import * as https from 'https';
import * as http from 'http';
import * as path from 'path';
import { MessageParam, Content } from './types';
import { resolveFilePath, readFileAsBuffer } from './utils/fileUtils';
import * as vscode from 'vscode';
import { log } from './extension';
import { getModelName, generateToolCallingSystemPrompt } from './config';

/**
 * Client for communicating with the Anthropic API
 */
export class AnthropicClient {
  private readonly apiUrl = 'https://api.anthropic.com/v1/messages';
  private readonly apiVersion = '2023-06-01'; // This version should work for streaming
  
  constructor(private readonly apiKey: string) {}
  
  /**
   * Stream completion from Anthropic API
   * Returns generator that yields token chunks
   */
  public async *streamCompletion(
    messages: readonly MessageParam[],
    document?: vscode.TextDocument,
    systemPrompt?: string
  ): AsyncGenerator<string[], void, unknown> {
    log(`Starting API request with ${messages.length} messages`);
    
    try {
      const formattedMessages = this.formatMessages(messages, document);
      const modelName = getModelName() || 'claude-3-5-haiku-latest';
      
      const systemPromptToUse = systemPrompt || generateToolCallingSystemPrompt();
      
      const requestBody: any = {
        model: modelName,
        messages: formattedMessages,
        system: systemPromptToUse,
        stream: true,
        max_tokens: 4000
      };
      
      log(`Using system prompt for tool calling (${systemPromptToUse.length} chars)`);
      
      log(`Using Anthropic model: ${requestBody.model}`);
      
      const requestOptions = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Anthropic-Version': this.apiVersion,
          'x-api-key': this.apiKey
        }
      };
      
      log('Creating HTTPS request');
      const req = https.request(this.apiUrl, requestOptions);
      
      req.on('error', (error) => {
        log(`API request error: ${error}`);
        console.error('API request error:', error);
        throw error;
      });
      
      log('Writing request body');
      req.write(JSON.stringify(requestBody));
      req.end();
      
      log('Waiting for response');
      const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
        req.on('response', resolve);
        req.on('error', reject);
      });
      
      log(`Received response with status code: ${response.statusCode}`);
      
      if (response.statusCode !== 200) {
        let errorData = '';
        for await (const chunk of response) {
          errorData += chunk.toString();
        }
        const errorMessage = `API request failed with status ${response.statusCode}: ${errorData}`;
        log(errorMessage);
        throw new Error(errorMessage);
      }
      
      log('Processing streaming response');
      yield* this.createStreamGenerator(response);
    } catch (error) {
      log(`Error in streamCompletion: ${error}`);
      throw error;
    }
  }
  
  /**
   * Creates a generator to process streaming response
   */
  private async *createStreamGenerator(
    response: http.IncomingMessage
  ): AsyncGenerator<string[], void, unknown> {
    let buffer = '';
    let eventCount = 0;
    
    try {
      for await (const chunk of response) {
        buffer += chunk.toString();
        log(`Received chunk of size ${chunk.length}`);
        
        // Log raw buffer for debugging (limited size)
        if (buffer.length < 200) {
          log(`Current buffer: ${buffer}`);
        } else {
          log(`Current buffer (first 200 chars): ${buffer.substring(0, 200)}...`);
        }
        
        // Process complete events in buffer
        while (true) {
          const eventEnd = buffer.indexOf('\n\n');
          if (eventEnd === -1) break;
          
          const event = buffer.substring(0, eventEnd);
          buffer = buffer.substring(eventEnd + 2);
          
          eventCount++;
          log(`Processing event ${eventCount}: ${event.substring(0, 100)}${event.length > 100 ? '...' : ''}`);
          
          if (event.startsWith('event: ')) {
            // Get the event type (after 'event: ' and before newline)
            const eventType = event.substring(7, event.indexOf('\n'));
            log(`SSE event type: ${eventType}`);
          }
          
          if (event.includes('data: ')) {
            try {
              // Extract the data part (after 'data: ')
              const dataStart = event.indexOf('data: ') + 6;
              const jsonData = event.substring(dataStart);
              log(`Parsing JSON: ${jsonData}`);
              
              const data = JSON.parse(jsonData);
              log(`Event type: ${data.type}`);
              
              // Handle different event types from Claude API
              if (data.type === 'content_block_delta' && data.delta && data.delta.type === 'text_delta' && data.delta.text) {
                log(`Received token: "${data.delta.text}"`);
                // Ensure we're sending tokens for text_delta events
                yield [data.delta.text];
              } else if (data.type === 'content_block_start') {
                log(`Content block start: ${JSON.stringify(data.content_block)}`);
              } else if (data.type === 'message_delta') {
                log(`Message delta received: ${JSON.stringify(data.delta)}`);
              } else if (data.type === 'message_start') {
                log(`Message start received: ${JSON.stringify(data.message)}`);
              } else if (data.type === 'message_stop') {
                log('Received message_stop event');
              } else if (data.type === 'ping') {
                log('Received ping event');
              } else {
                log(`Unknown event type: ${data.type}`);
              }
            } catch (e) {
              log(`Error parsing event data: ${e}`);
              log(`Raw event data: ${event}`);
            }
          }
        }
      }
      
      log(`Stream completed, processed ${eventCount} events`);
    } catch (error) {
      log(`Error in createStreamGenerator: ${error}`);
      throw error;
    }
  }
  
  /**
   * Formats messages for the Anthropic API
   */
  private formatMessages(messages: readonly MessageParam[], document?: vscode.TextDocument): any[] {
    return messages.map(msg => ({
      role: msg.role,
      content: this.formatContent(msg.content, document)
    }));
  }
  
  /**
   * Formats content items for Anthropic API
   */
  private formatContent(contentItems: readonly Content[], document?: vscode.TextDocument): any[] {
    return contentItems.map(content => {
      if (content.type === 'text') {
        return { type: 'text', text: content.value };
      } else if (content.type === 'image') {
        try {
          // Resolve image path relative to document if needed
          const imagePath = document 
            ? resolveFilePath(content.path, document)
            : content.path;
            
          // Read image file and convert to base64
          const imageData = readFileAsBuffer(imagePath);
          if (!imageData) {
            return { type: 'text', text: `[Failed to load image: ${content.path}]` };
          }
          
          const base64Data = imageData.toString('base64');
          const mimeType = this.getMimeType(imagePath);
          
          return {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mimeType,
              data: base64Data
            }
          };
        } catch (error) {
          console.error(`Error processing image ${content.path}:`, error);
          // Return empty text if image can't be processed
          return { type: 'text', text: `[Failed to load image: ${content.path}]` };
        }
      }
      return { type: 'text', text: '' };
    });
  }
  
  /**
   * Gets MIME type from file extension
   */
  private getMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
      case '.png': return 'image/png';
      case '.jpg':
      case '.jpeg': return 'image/jpeg';
      case '.gif': return 'image/gif';
      case '.webp': return 'image/webp';
      default: return 'application/octet-stream';
    }
  }
}