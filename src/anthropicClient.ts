import * as https from "https";
import * as http from "http";
import * as path from "path";
import { MessageParam, Content, ThinkingPayload } from "./types";
import { resolveFilePath, readFileAsBuffer } from "./utils/fileUtils";
import * as vscode from "vscode";
import { log } from "./extension";
import { generateToolCallingSystemPrompt } from "./config";
import {
  encodeThinkingPayloadToken,
  encodeThinkingToken,
} from "./utils/thinkingBlocks";
import { cleanMessagesForApi } from "./utils/messageCleanup";
import {
  isAdaptiveThinkingModel,
  needsInterleavedThinkingBeta,
  omitsThinkingByDefault,
  requiresAlwaysOnThinking,
  toAdaptiveEffort,
} from "./utils/modelCapabilities";

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
    configName?: string,
    fileConfig?: Record<string, any>,
  ): AsyncGenerator<string[], void, unknown> {
    log(`Starting API request with ${messages.length} messages`);

    try {
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
        systemPrompt || generateToolCallingSystemPrompt(new Map(), new Map());

      // Get configuration values with proper precedence (file config > provider config > global config)
      const { getMaxTokens, getMaxThinkingTokens, getReasoningEffort, calculateThinkingTokensFromEffort } = require("./config");
      const maxTokens = getMaxTokens(configName, fileConfig);
      const configuredThinkingTokens = getMaxThinkingTokens(configName, fileConfig);
      const reasoningEffort = getReasoningEffort(configName, fileConfig);

      // Thinking is on unless it was explicitly turned off
      const thinkingEnabled = reasoningEffort !== "none";
      const adaptive = isAdaptiveThinkingModel(modelName);

      const requestBody: any = {
        model: modelName,
        system: systemPromptToUse,
        stream: true,
        max_tokens: maxTokens,
      };

      if (adaptive) {
        // Claude 4.6+ replaced budget_tokens with adaptive thinking + effort
        if (thinkingEnabled) {
          requestBody.thinking = { type: "adaptive" };
          if (omitsThinkingByDefault(modelName)) {
            // These models omit thinking from the response unless asked for it
            requestBody.thinking.display = "summarized";
          }
          if (reasoningEffort) {
            requestBody.output_config = {
              effort: toAdaptiveEffort(reasoningEffort),
            };
          }
          log(
            `Using adaptive thinking: ${JSON.stringify(requestBody.thinking)}${requestBody.output_config ? ` with ${JSON.stringify(requestBody.output_config)}` : ""}`,
          );
        } else if (!requiresAlwaysOnThinking(modelName)) {
          requestBody.thinking = { type: "disabled" };
          log("Thinking disabled for adaptive thinking model");
        } else {
          log(
            "Model requires always-on adaptive thinking, omitting thinking param",
          );
        }
      } else if (thinkingEnabled) {
        // Older models: extended thinking with an explicit token budget
        let thinkingTokens: number | undefined;
        if (configuredThinkingTokens && configuredThinkingTokens !== 16000) {
          thinkingTokens = configuredThinkingTokens;
          log(`Using configured thinking tokens: ${thinkingTokens}`);
        } else if (reasoningEffort) {
          thinkingTokens = calculateThinkingTokensFromEffort(maxTokens, reasoningEffort);
          log(
            `Using thinking tokens calculated from reasoning effort "${reasoningEffort}": ${thinkingTokens}`,
          );
        } else {
          log("No thinking token configuration, letting Anthropic decide");
        }

        if (thinkingTokens) {
          const budgetTokens = Math.max(1024, thinkingTokens);
          requestBody.thinking = {
            type: "enabled",
            budget_tokens: budgetTokens,
          };
          // Anthropic requires max_tokens to be greater than the thinking budget
          if (requestBody.max_tokens <= budgetTokens) {
            requestBody.max_tokens = budgetTokens + maxTokens;
            log(
              `Raised max_tokens to ${requestBody.max_tokens} to exceed thinking budget ${budgetTokens}`,
            );
          }
          log(`Setting Anthropic thinking budget_tokens: ${budgetTokens}`);
        }
      }

      // Thinking blocks may only be replayed when thinking is actually enabled
      const thinkingActive = Boolean(requestBody.thinking) && thinkingEnabled;
      const cleanedMessages = cleanMessagesForApi(messages, {
        modelName,
        thinkingEnabled: thinkingActive,
        apiStyle: "anthropic",
      });
      requestBody.messages = this.formatMessages(cleanedMessages, document);

      log(
        `Using system prompt for tool calling (${systemPromptToUse.length} chars)`,
      );

      log(`Using Anthropic model: ${requestBody.model}`);

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Anthropic-Version": this.apiVersion,
        "x-api-key": this.apiKey,
      };

      if (thinkingActive && needsInterleavedThinkingBeta(modelName)) {
        headers["anthropic-beta"] = "interleaved-thinking-2025-05-14";
        log("Requesting interleaved thinking beta");
      }

      const requestOptions = {
        method: "POST",
        headers,
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
      yield* this.createStreamGenerator(response, modelName);
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
    modelName: string,
  ): AsyncGenerator<string[], void, unknown> {
    let buffer = "";
    let eventCount = 0;
    // Accumulated thinking text of the block currently being streamed
    let thinkingText = "";

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
              } else if (
                data.type === "content_block_delta" &&
                data.delta &&
                data.delta.type === "thinking_delta" &&
                data.delta.thinking
              ) {
                thinkingText += data.delta.thinking;
                yield [encodeThinkingToken(data.delta.thinking)];
              } else if (
                data.type === "content_block_delta" &&
                data.delta &&
                data.delta.type === "signature_delta" &&
                data.delta.signature
              ) {
                // The signature closes the thinking block. Keep the exact thinking
                // text with it so it can be replayed byte for byte later on.
                log("Received thinking signature");
                const payload: ThinkingPayload & { model: string } = {
                  model: modelName,
                  kind: "anthropic_signature",
                  signature: data.delta.signature,
                  text: thinkingText,
                };
                thinkingText = "";
                yield [encodeThinkingPayloadToken(payload)];
              } else if (data.type === "content_block_start") {
                log(
                  `Content block start: ${JSON.stringify(data.content_block)}`,
                );
                const block = data.content_block;
                if (block && block.type === "redacted_thinking" && block.data) {
                  log("Received redacted thinking block");
                  const payload: ThinkingPayload & { model: string } = {
                    model: modelName,
                    kind: "anthropic_redacted",
                    data: block.data,
                  };
                  yield [
                    encodeThinkingToken("[redacted thinking]"),
                    encodeThinkingPayloadToken(payload),
                  ];
                } else if (block && block.type === "thinking" && block.thinking) {
                  thinkingText += block.thinking;
                  yield [encodeThinkingToken(block.thinking)];
                }
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
    const blocks: any[] = [];

    for (const content of contentItems) {
      if (content.type === "text") {
        blocks.push({ type: "text", text: content.value });
      } else if (content.type === "thinking") {
        const payload = content.payload;
        if (payload?.kind === "anthropic_redacted" && payload.data) {
          blocks.push({ type: "redacted_thinking", data: payload.data });
        } else if (payload?.kind === "anthropic_signature" && payload.signature) {
          // Prefer the exact text captured with the signature; the document copy is
          // trimmed for display and would not verify.
          blocks.push({
            type: "thinking",
            thinking: payload.text ?? "",
            signature: payload.signature,
          });
        } else {
          // Raw thinking without a signature cannot be replayed to Anthropic
          log("Skipping thinking block without an Anthropic signature");
        }
      } else if (content.type === "image") {
        try {
          // Resolve image path relative to document if needed
          const imagePath = document
            ? resolveFilePath(content.path, document)
            : content.path;

          // Read image file and convert to base64
          const imageData = readFileAsBuffer(imagePath);
          if (!imageData) {
            blocks.push({
              type: "text",
              text: `[Failed to load image: ${content.path}]`,
            });
            continue;
          }

          const base64Data = imageData.toString("base64");
          const mimeType = this.getMimeType(imagePath);

          blocks.push({
            type: "image",
            source: {
              type: "base64",
              media_type: mimeType,
              data: base64Data,
            },
          });
        } catch (error) {
          console.error(`Error processing image ${content.path}:`, error);
          // Push text if image can't be processed
          blocks.push({
            type: "text",
            text: `[Failed to load image: ${content.path}]`,
          });
        }
      }
    }

    if (blocks.length === 0) {
      blocks.push({ type: "text", text: "[continuing]" });
    }

    return blocks;
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
