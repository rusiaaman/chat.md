import * as https from "https";
import * as http from "http";
import * as path from "path";
import * as url from "url";
import { MessageParam, Content } from "./types";
import { resolveFilePath, readFileAsBuffer } from "./utils/fileUtils";
import * as vscode from "vscode";
import { log } from "./extension";
import {
  getModelName,
  getBaseUrl,
  generateToolCallingSystemPrompt,
} from "./config";

/**
 * Client for communicating with the OpenAI API
 */
export class OpenAIClient {
  private readonly apiUrl: string;

  constructor(
    private readonly apiKey: string,
    private readonly customBaseUrl?: string,
  ) {
    // Use custom base URL if provided directly
    if (this.customBaseUrl) {
      // Construct the full URL by joining the base URL with the chat completions endpoint
      this.apiUrl = this.joinUrl(this.customBaseUrl, "/chat/completions");
      log(`Using custom OpenAI base URL: ${this.customBaseUrl}`);
    } else {
      this.apiUrl = "https://api.openai.com/v1/chat/completions";
      log("Using default OpenAI API URL");
    }
  }

  /**
   * Safely joins a base URL with a path
   */
  private joinUrl(baseUrl: string, path: string): string {
    // Remove trailing slash from base URL if present
    const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
    // Remove leading slash from path if present
    const cleanPath = path.startsWith("/") ? path : "/" + path;
    return base + cleanPath;
  }

  /**
   * Stream completion from OpenAI API
   * Returns generator that yields token chunks
   */
  public async *streamCompletion(
    messages: readonly MessageParam[],
    document?: vscode.TextDocument,
    systemPrompt?: string,
  ): AsyncGenerator<string[], void, unknown> {
    log(`Starting OpenAI API request with ${messages.length} messages`);

    try {
      // First prepare messages with system prompt
      const systemPromptToUse =
        systemPrompt || generateToolCallingSystemPrompt();
      const systemMessage = { role: "system", content: systemPromptToUse };

      // Format regular messages
      const formattedMessages = this.formatMessages(messages, document);

      // Add system message as the first message
      const allMessages = [systemMessage, ...formattedMessages];

      // Try to get model name safely
      let modelName;
      try {
        const { getModelName } = require("./config");
        modelName = getModelName();
      } catch (e) {
        log(`Error getting model name: ${e}`);
        modelName = null;
      }

      // Use fallback if needed
      modelName = modelName || "gpt-3.5-turbo";

      const requestBody = {
        model: modelName,
        messages: allMessages,
        stream: true,
        max_tokens: 4000,
      };

      log(
        `Using system prompt for tool calling (${systemPromptToUse.length} chars)`,
      );

      log(`Using OpenAI model: ${requestBody.model}`);

      const requestOptions = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
      };

      log(`Creating request to OpenAI API at ${this.apiUrl}`);

      // Parse URL to determine whether to use HTTP or HTTPS
      const parsedUrl = new URL(this.apiUrl);
      let req;

      if (parsedUrl.protocol === "http:") {
        log("Using HTTP protocol for request");
        req = http.request(this.apiUrl, requestOptions);
      } else {
        log("Using HTTPS protocol for request");
        req = https.request(this.apiUrl, requestOptions);
      }

      req.on("error", (error) => {
        const message = error instanceof Error ? error.message : String(error);
        log(`OpenAI API request error: ${message}`);
        console.error("OpenAI API request error:", error);
        vscode.window.showErrorMessage(`OpenAI API request error: ${message}`);
        // We still need to reject the promise or throw to stop the process
        // The promise rejection in the main try/catch handles this
        throw error;
      });

      log("Writing request body");
      req.write(JSON.stringify(requestBody));
      req.end();

      log("Waiting for response");
      const response = await new Promise<http.IncomingMessage>(
        (resolve, reject) => {
          req.on("response", resolve);
          req.on("error", reject);
        },
      );

      log(`Received response with status code: ${response.statusCode}`);

      if (response.statusCode !== 200) {
        let errorData = "";
        for await (const chunk of response) {
          errorData += chunk.toString();
        }
        const errorMessage = `OpenAI API request failed with status ${response.statusCode}: ${errorData}`;
        log(errorMessage);
        vscode.window.showErrorMessage(
          `OpenAI API Error (${response.statusCode}): ${errorData || "Failed to get error details"}`,
        );
        throw new Error(errorMessage);
      }

      log("Processing streaming response from OpenAI");
      yield* this.createStreamGenerator(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Error in streamCompletion: ${message}`);
      vscode.window.showErrorMessage(
        `Failed to initiate OpenAI stream: ${message}`,
      );
      throw error; // Re-throw the error to be caught by the caller (e.g., streamer.ts)
    }
  }

  /**
   * Creates a generator to process streaming response from OpenAI
   * OpenAI's streaming format is different from Anthropic's
   */
  private async *createStreamGenerator(
    response: http.IncomingMessage,
  ): AsyncGenerator<string[], void, unknown> {
    let buffer = "";
    let eventCount = 0;

    // Keep track of the last chunks for debugging
    const lastChunks = [];
    const maxTrackedChunks = 5;

    try {
      for await (const chunk of response) {
        const chunkStr = chunk.toString();
        buffer += chunkStr;

        // Track the last few chunks for debugging
        lastChunks.push(chunkStr);
        if (lastChunks.length > maxTrackedChunks) {
          lastChunks.shift(); // Remove oldest chunk
        }

        log(`Received chunk of size ${chunk.length}`);

        // Process complete events in buffer
        while (true) {
          const eventEnd = buffer.indexOf("\n\n");
          if (eventEnd === -1) break;

          const event = buffer.substring(0, eventEnd);
          buffer = buffer.substring(eventEnd + 2);

          if (event.trim() === "data: [DONE]") {
            log("Received [DONE] event, stream complete");

            // Check the last chunks for finish_reason="length" which indicates max tokens
            let maxTokensDetected = false;

            // Log the last chunks for debugging
            log("--- LAST CHUNKS BEFORE DONE (for debugging) ---");
            lastChunks.forEach((chunk, idx) => {
              const cleanChunk = chunk.replace(/\n/g, "\\n");
              log(`Chunk ${idx + 1}/${lastChunks.length}: "${cleanChunk}"`);

              // Check for finish_reason="length"
              if (
                chunk.includes('"finish_reason"') &&
                chunk.includes('"length"')
              ) {
                log(`⚠️ Found finish_reason="length" in chunk ${idx + 1}`);
                maxTokensDetected = true;
              }
            });
            log("--- END LAST CHUNKS ---");

            // If any recent chunk had finish_reason="length", throw max tokens error
            if (maxTokensDetected) {
              log(
                "🚨 Max tokens detected in recent chunks! Will restart stream.",
              );
              throw new Error("max_tokens: Detected finish_reason=length");
            }

            break;
          }

          if (event.startsWith("data: ")) {
            try {
              // Extract the data part (after 'data: ')
              const dataStart = event.indexOf("data: ") + 6;
              const jsonData = event.substring(dataStart);

              if (jsonData.trim()) {
                try {
                  const data = JSON.parse(jsonData);

                  // OpenAI's format has choices with delta that contains content
                  if (data.choices && data.choices.length > 0) {
                    const choice = data.choices[0];

                    // Check for finish_reason="length" which indicates max tokens reached
                    if (choice.finish_reason === "length") {
                      log(
                        `🚨 Detected finish_reason="length" - Max tokens reached`,
                      );

                      // Yield the final token if there is one
                      if (choice.delta && choice.delta.content) {
                        eventCount++;
                        log(
                          `Received final token event ${eventCount}: "${choice.delta.content}"`,
                        );
                        yield [choice.delta.content];
                      }

                      // Throw error to trigger max tokens handling
                      throw new Error(
                        "max_tokens: Detected finish_reason=length",
                      );
                    }

                    // Normal processing
                    if (choice.delta && choice.delta.content) {
                      eventCount++;
                      log(
                        `Received token event ${eventCount}: "${choice.delta.content}"`,
                      );
                      yield [choice.delta.content];
                    }
                  }
                } catch (jsonParseError) {
                  log(`JSON parsing error: ${jsonParseError}`);
                  log(`Corrupted JSON data: ${jsonData}`);

                  // Attempt to salvage content from corrupted JSON
                  // Look for content patterns in the corrupted JSON
                  const contentMatch =
                    /"content"\s*:\s*"([^"\\]*(\\.[^"\\]*)*)"/g.exec(jsonData);
                  if (contentMatch && contentMatch[1]) {
                    const recoveredContent = contentMatch[1]
                      .replace(/\\"/g, '"')
                      .replace(/\\\\/g, "\\")
                      .replace(/\\n/g, "\n")
                      .replace(/\\t/g, "\t")
                      .replace(/\\r/g, "\r");

                    log(
                      `Recovered content from corrupted JSON: "${recoveredContent}"`,
                    );
                    eventCount++;
                    yield [recoveredContent];
                  } else {
                    log(`Could not recover content from corrupted JSON`);
                  }
                }
              }
            } catch (e) {
              log(`Error processing event: ${e}`);
              log(`Raw event data: ${event}`);
            }
          }
        }
      }

      // Process any remaining buffer content at the end of the stream
      if (buffer.trim()) {
        log(`Processing remaining buffer at end of stream: "${buffer}"`);

        // Handle case where final chunk doesn't end with \n\n
        if (buffer.startsWith("data: ")) {
          try {
            // Extract the data part (after 'data: ')
            const dataStart = buffer.indexOf("data: ") + 6;
            const jsonData = buffer.substring(dataStart);

            if (jsonData.trim() && jsonData !== "[DONE]") {
              try {
                const data = JSON.parse(jsonData);

                // Process the final chunk similar to the main loop
                if (data.choices && data.choices.length > 0) {
                  const delta = data.choices[0].delta;

                  if (delta && delta.content) {
                    eventCount++;
                    log(
                      `Received final token event ${eventCount}: "${delta.content}"`,
                    );
                    yield [delta.content];
                  }
                }
              } catch (e) {
                log(`Error parsing final event data: ${e}`);
                log(`Raw final event data: ${buffer}`);
              }
            }
          } catch (e) {
            log(`Error processing remaining buffer: ${e}`);
          }
        }
      }

      log(`Stream completed, processed ${eventCount} events`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Error in createStreamGenerator: ${message}`);

      // Don't show error notification for max tokens errors - they're handled gracefully
      if (!message.includes("max_tokens")) {
        // Only notify about unexpected errors, not max tokens which we handle
        vscode.window.showErrorMessage(
          `Error during OpenAI stream processing: ${message}`,
        );
      } else {
        // For max tokens, just log it without user notification
        log(
          `Max tokens error detected in createStreamGenerator - will be handled by streamResponse`,
        );
      }

      // Re-throw the error so the main streamCompletion loop knows something went wrong
      throw error;
    }
  }

  /**
   * Formats messages for the OpenAI API
   * OpenAI expects a slightly different format than Anthropic
   */
  private formatMessages(
    messages: readonly MessageParam[],
    document?: vscode.TextDocument,
  ): any[] {
    return messages.map((msg) => ({
      role: msg.role,
      content: this.formatContent(msg.content, document),
    }));
  }

  /**
   * Formats content items for OpenAI API
   */
  private formatContent(
    contentItems: readonly Content[],
    document?: vscode.TextDocument,
  ): any {
    // For text-only content, return as simple string
    if (contentItems.every((item) => item.type === "text")) {
      return contentItems
        .filter((item) => item.type === "text")
        .map((item) => (item as any).value)
        .join("\n\n");
    }

    // For mixed content (images + text), return as array
    const formattedContent = [];

    for (const content of contentItems) {
      if (content.type === "text") {
        formattedContent.push({
          type: "text",
          text: content.value,
        });
      } else if (content.type === "image") {
        try {
          // Resolve image path relative to document if needed
          const imagePath = document
            ? resolveFilePath(content.path, document)
            : content.path;

          // Read image file and convert to base64
          const imageData = readFileAsBuffer(imagePath);
          if (!imageData) {
            formattedContent.push({
              type: "text",
              text: `[Failed to load image: ${content.path}]`,
            });
            continue;
          }

          const base64Data = imageData.toString("base64");
          const mimeType = this.getMimeType(imagePath);

          formattedContent.push({
            type: "image_url",
            image_url: {
              url: `data:${mimeType};base64,${base64Data}`,
            },
          });
        } catch (error) {
          console.error(`Error processing image ${content.path}:`, error);
          // Return text if image can't be processed
          formattedContent.push({
            type: "text",
            text: `[Failed to load image: ${content.path}]`,
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
      case ".png":
        return "image/png";
      case ".jpg":
      case ".jpeg":
        return "image/jpeg";
      case ".gif":
        return "image/gif";
      case ".webp":
        return "image/webp";
      default:
        return "application/octet-stream";
    }
  }
}
