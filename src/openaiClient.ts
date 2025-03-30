import * as https from 'https';
import * as http from 'http';
import * as path from 'path';
import * as url from 'url';
import { MessageParam, Content } from './types';
import { resolveFilePath, readFileAsBuffer } from './utils/fileUtils';
import * as vscode from 'vscode';
import { log } from './extension';
import { getModelName, getBaseUrl, generateToolCallingSystemPrompt } from './config';

/**
 * Client for communicating with the OpenAI API
 */
export class OpenAIClient {
  private readonly apiUrl: string;
  
  constructor(private readonly apiKey: string) {
    // Use custom base URL if provided, otherwise use OpenAI's default
    const baseUrl = getBaseUrl();
    if (baseUrl) {
      // Construct the full URL by joining the base URL with the chat completions endpoint
      this.apiUrl = this.joinUrl(baseUrl, '/chat/completions');
      log(`Using custom OpenAI base URL: ${baseUrl}`);
    } else {
      this.apiUrl = 'https://api.openai.com/v1/chat/completions';
      log('Using default OpenAI API URL');
    }
  }
  
  /**
   * Safely joins a base URL with a path
   */
  private joinUrl(baseUrl: string, path: string): string {
    // Remove trailing slash from base URL if present
    const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    // Remove leading slash from path if present
    const cleanPath = path.startsWith('/') ? path : '/' + path;
    return base + cleanPath;
  }
  
  /**
   * Stream completion from OpenAI API
   * Returns generator that yields token chunks
   */
  public async *streamCompletion(
    messages: readonly MessageParam[],
    document?: vscode.TextDocument,
    systemPrompt?: string
  ): AsyncGenerator<string[], void, unknown> {
    log(`Starting OpenAI API request with ${messages.length} messages`);
    
    try {
      // First prepare messages with system prompt
      const systemPromptToUse = systemPrompt || generateToolCallingSystemPrompt();
      const systemMessage = { role: 'system', content: systemPromptToUse };
      
      // Format regular messages
      const formattedMessages = this.formatMessages(messages, document);
      
      // Add system message as the first message
      const allMessages = [systemMessage, ...formattedMessages];
      
      const modelName = getModelName() || 'gpt-3.5-turbo';
      
      const requestBody = {
        model: modelName,
        messages: allMessages,
        stream: true,
        max_tokens: 4000
      };
      
      log(`Using system prompt for tool calling (${systemPromptToUse.length} chars)`);
      
      log(`Using OpenAI model: ${requestBody.model}`);
      
      const requestOptions = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        }
      };
      
      log('Creating HTTPS request to OpenAI');
      const req = https.request(this.apiUrl, requestOptions);
      
      req.on('error', (error) => {
        log(`OpenAI API request error: ${error}`);
        console.error('OpenAI API request error:', error);
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
        const errorMessage = `OpenAI API request failed with status ${response.statusCode}: ${errorData}`;
        log(errorMessage);
        throw new Error(errorMessage);
      }
      
      log('Processing streaming response from OpenAI');
      yield* this.createStreamGenerator(response);
    } catch (error) {
      log(`Error in streamCompletion: ${error}`);
      throw error;
    }
  }
  
  /**
   * Creates a generator to process streaming response from OpenAI
   * OpenAI's streaming format is different from Anthropic's
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
        
        // Process complete events in buffer
        while (true) {
          const eventEnd = buffer.indexOf('\n\n');
          if (eventEnd === -1) break;
          
          const event = buffer.substring(0, eventEnd);
          buffer = buffer.substring(eventEnd + 2);
          
          if (event.trim() === 'data: [DONE]') {
            log('Received [DONE] event, stream complete');
            break;
          }
          
          if (event.startsWith('data: ')) {
            try {
              // Extract the data part (after 'data: ')
              const dataStart = event.indexOf('data: ') + 6;
              const jsonData = event.substring(dataStart);
              
              if (jsonData.trim()) {
                const data = JSON.parse(jsonData);
                
                // OpenAI's format has choices with delta that contains content
                if (data.choices && data.choices.length > 0) {
                  const delta = data.choices[0].delta;
                  
                  if (delta && delta.content) {
                    eventCount++;
                    log(`Received token event ${eventCount}: "${delta.content}"`);
                    yield [delta.content];
                  }
                }
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
   * Formats messages for the OpenAI API
   * OpenAI expects a slightly different format than Anthropic
   */
  private formatMessages(messages: readonly MessageParam[], document?: vscode.TextDocument): any[] {
    return messages.map(msg => ({
      role: msg.role,
      content: this.formatContent(msg.content, document)
    }));
  }
  
  /**
   * Formats content items for OpenAI API
   */
  private formatContent(contentItems: readonly Content[], document?: vscode.TextDocument): any {
    // For text-only content, return as simple string
    if (contentItems.every(item => item.type === 'text')) {
      return contentItems
        .filter(item => item.type === 'text')
        .map(item => (item as any).value)
        .join('\n\n');
    }
    
    // For mixed content (images + text), return as array
    const formattedContent = [];
    
    for (const content of contentItems) {
      if (content.type === 'text') {
        formattedContent.push({
          type: 'text',
          text: content.value
        });
      } else if (content.type === 'image') {
        try {
          // Resolve image path relative to document if needed
          const imagePath = document 
            ? resolveFilePath(content.path, document)
            : content.path;
            
          // Read image file and convert to base64
          const imageData = readFileAsBuffer(imagePath);
          if (!imageData) {
            formattedContent.push({
              type: 'text',
              text: `[Failed to load image: ${content.path}]`
            });
            continue;
          }
          
          const base64Data = imageData.toString('base64');
          const mimeType = this.getMimeType(imagePath);
          
          formattedContent.push({
            type: 'image_url',
            image_url: {
              url: `data:${mimeType};base64,${base64Data}`
            }
          });
        } catch (error) {
          console.error(`Error processing image ${content.path}:`, error);
          // Return text if image can't be processed
          formattedContent.push({
            type: 'text',
            text: `[Failed to load image: ${content.path}]`
          });
        }
      }
    }
    
    return formattedContent;
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