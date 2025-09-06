import * as https from "https";
import * as http from "http";
import * as path from "path";
import { MessageParam, Content } from "./types";
import { resolveFilePath, readFileAsBuffer } from "./utils/fileUtils";
import * as vscode from "vscode";
import { log } from "./extension";
import { generateToolCallingSystemPrompt } from "./config";

/**
 * Client for communicating with the Anthropic API
 */
export class AnthropicClient {
  private readonly apiUrl = "https://api.anthropic.com/v1/messages";
  private readonly apiVersion = "2023-06-01"; // This version should work for streaming

  constructor(private readonly apiKey: string) {}

  /**
   * Stream completion from Anthropic API
   * Returns generator that yields token chunks
   */
  public async *streamCompletion(
    messages: readonly MessageParam[],
    document?: vscode.TextDocument,
    systemPrompt?: string,
    modelNameOverride?: string,
  ): AsyncGenerator<string[], void, unknown> {
    log(`Starting API request with ${messages.length} messages`);

    try {
      const formattedMessages = this.formatMessages(messages, document);
      // Resolve model name (allow per-file override)
      let modelName = modelNameOverride;
      if (!modelName) {
        try {
          const { getModelName } = require("./config");
          modelName = getModelName();
        } catch (e) {
          log(`Error getting model name: ${e}`);
          modelName = undefined;
        }
      }

      // Use fallback if needed
      modelName = modelName || "claude-3-5-haiku-latest";

      const systemPromptToUse =
        systemPrompt || generateToolCallingSystemPrompt();

      // Get configuration values
      const { getMaxTokens, getMaxThinkingTokens, getReasoningEffort, calculateThinkingTokensFromEffort } = require("./config");
      const maxTokens = getMaxTokens();
      const configuredThinkingTokens = getMaxThinkingTokens();
      const reasoningEffort = getReasoningEffort();
      
      const requestBody: any = {
        model: modelName,
        messages: formattedMessages,
        system: systemPromptToUse,
        stream: true,
        max_tokens: maxTokens,
      };

      // Determine thinking token budget for Anthropic
      let thinkingTokens;
      
      // If maxThinkingTokens is explicitly configured and not the default, use that
      if (configuredThinkingTokens && configuredThinkingTokens !== 16000) {
        thinkingTokens = configuredThinkingTokens;
        log(`Using configured thinking tokens: ${thinkingTokens}`);
      } 
      // If reasoning effort is configured, calculate thinking tokens from it
      else if (reasoningEffort) {
        thinkingTokens = calculateThinkingTokensFromEffort(maxTokens, reasoningEffort);
        log(`Using thinking tokens calculated from reasoning effort "${reasoningEffort}": ${thinkingTokens}`);
      }
      // Otherwise, don't set thinking tokens (let Anthropic handle it automatically)
      else {
        log("No thinking token configuration, letting Anthropic handle automatically");
      }
      
      // Add thinking tokens parameter if we calculated one
      if (thinkingTokens) {
        requestBody.thinking = { max_tokens: thinkingTokens };
        log(`Setting Anthropic thinking.max_tokens: ${thinkingTokens}`);
      }

      log(
        `Using system prompt for tool calling (${systemPromptToUse.length} chars)`,
      );

      log(`Using Anthropic model: ${requestBody.model}`);

      const requestOptions = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Anthropic-Version": this.apiVersion,
          "x-api-key": this.apiKey,
        },
      };

      log("Creating HTTPS request");
      const req = https.request(this.apiUrl, requestOptions);

      req.on("error", (error) => {
        const message = error instanceof Error ? error.message : String(error);
        log(`API request error: ${message}`);
        console.error("API request error:", error);
        vscode.window.showErrorMessage(
          `Anthropic API request error: ${message}`,
        );
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

        // Format error message to start with status code for easier error type detection
        const errorMessage = `${response.statusCode} - API request failed: ${errorData}`;
        log(errorMessage);

        if (response.statusCode! >= 500) {
          // 5xx errors will be retried by the streamer
          vscode.window.showErrorMessage(
            `Anthropic API Server Error (${response.statusCode}): Will automatically retry`,
          );
        } else if (response.statusCode === 429) {
          // 429 errors will be retried by the streamer
          vscode.window.showErrorMessage(
            `Anthropic API Rate Limit (${response.statusCode}): Will automatically retry with backoff`,
          );
        } else if (
          errorData.includes("max_tokens") ||
          errorData.includes("token limit")
        ) {
          vscode.window.showInformationMessage(
            `Anthropic API Token Limit Error: Will automatically restart the stream`,
          );
        } else {
          vscode.window.showErrorMessage(
            `Anthropic API Error (${response.statusCode}): ${errorData || "Failed to get error details"}`,
          );
        }

        throw new Error(errorMessage);
      }

      log("Processing streaming response");
      yield* this.createStreamGenerator(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Error in streamCompletion: ${message}`);
      vscode.window.showErrorMessage(
        `Failed to initiate Anthropic stream: ${message}`,
      );
      throw error; // Re-throw the error to be caught by the caller (e.g., streamer.ts)
    }
  }

  /**
   * Creates a generator to process streaming response
   */
  private async *createStreamGenerator(
    response: http.IncomingMessage,
  ): AsyncGenerator<string[], void, unknown> {
    let buffer = "";
    let eventCount = 0;

    try {
      for await (const chunk of response) {
        buffer += chunk.toString();
        log(`Received chunk of size ${chunk.length}`);

        // Log raw buffer for debugging (limited size)
        if (buffer.length < 200) {
          log(`Current buffer: ${buffer}`);
        } else {
          log(
            `Current buffer (first 200 chars): ${buffer.substring(0, 200)}...`,
          );
        }

        // Process complete events in buffer
        while (true) {
          const eventEnd = buffer.indexOf("\n\n");
          if (eventEnd === -1) break;

          const event = buffer.substring(0, eventEnd);
          buffer = buffer.substring(eventEnd + 2);

          eventCount++;
          log(
            `Processing event ${eventCount}: ${event.substring(0, 100)}${event.length > 100 ? "..." : ""}`,
          );

          if (event.startsWith("event: ")) {
            // Get the event type (after 'event: ' and before newline)
            const eventType = event.substring(7, event.indexOf("\n"));
            log(`SSE event type: ${eventType}`);
          }

          if (event.includes("data: ")) {
            try {
              // Extract the data part (after 'data: ')
              const dataStart = event.indexOf("data: ") + 6;
              const jsonData = event.substring(dataStart);
              log(`Parsing JSON: ${jsonData}`);

              const data = JSON.parse(jsonData);
              log(`Event type: ${data.type}`);

              // Handle different event types from Claude API
              if (
                data.type === "content_block_delta" &&
                data.delta &&
                data.delta.type === "text_delta" &&
                data.delta.text
              ) {
                log(`Received token: "${data.delta.text}"`);
                // Ensure we're sending tokens for text_delta events
                yield [data.delta.text];
              } else if (data.type === "content_block_start") {
                log(
                  `Content block start: ${JSON.stringify(data.content_block)}`,
                );
              } else if (data.type === "message_delta") {
                log(`Message delta received: ${JSON.stringify(data.delta)}`);
              } else if (data.type === "message_start") {
                log(`Message start received: ${JSON.stringify(data.message)}`);
              } else if (data.type === "message_stop") {
                log("Received message_stop event");
              } else if (data.type === "ping") {
                log("Received ping event");
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
      const message = error instanceof Error ? error.message : String(error);
      log(`Error in createStreamGenerator: ${message}`);

      // Don't show error notification for max tokens errors - they're handled gracefully
      if (!message.includes("max_tokens") && !message.includes("token limit")) {
        // Only notify about unexpected errors, not max tokens which we handle
        vscode.window.showErrorMessage(
          `Error during Anthropic stream processing: ${message}`,
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
   * Formats messages for the Anthropic API
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
   * Formats content items for Anthropic API
   */
  private formatContent(
    contentItems: readonly Content[],
    document?: vscode.TextDocument,
  ): any[] {
    return contentItems.map((content) => {
      if (content.type === "text") {
        return { type: "text", text: content.value };
      } else if (content.type === "image") {
        try {
          // Resolve image path relative to document if needed
          const imagePath = document
            ? resolveFilePath(content.path, document)
            : content.path;

          // Read image file and convert to base64
          const imageData = readFileAsBuffer(imagePath);
          if (!imageData) {
            return {
              type: "text",
              text: `[Failed to load image: ${content.path}]`,
            };
          }

          const base64Data = imageData.toString("base64");
          const mimeType = this.getMimeType(imagePath);

          return {
            type: "image",
            source: {
              type: "base64",
              media_type: mimeType,
              data: base64Data,
            },
          };
        } catch (error) {
          console.error(`Error processing image ${content.path}:`, error);
          // Return empty text if image can't be processed
          return {
            type: "text",
            text: `[Failed to load image: ${content.path}]`,
          };
        }
      }
      return { type: "text", text: "" };
    });
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
