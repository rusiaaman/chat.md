import * as https from "https";
import * as http from "http";
import * as path from "path";
import * as url from "url";
import { MessageParam, Content, ThinkingPayload } from "./types";
import { resolveFilePath, readFileAsBuffer } from "./utils/fileUtils";
import * as vscode from "vscode";
import { log } from "./extension";
import {
  getModelName,
  getBaseUrl,
  generateToolCallingSystemPrompt,
} from "./config";
import {
  encodeThinkingPayloadToken,
  encodeThinkingToken,
} from "./utils/thinkingBlocks";
import { cleanMessagesForApi } from "./utils/messageCleanup";

/**
 * Accumulates OpenRouter style reasoning_details deltas so the full array can be
 * replayed on the next turn. Modelled on llm-codegen's ReasoningDetailsAccumulator.
 */
class ReasoningDetailsAccumulator {
  private readonly details: any[] = [];
  private readonly indexes = new Map<string, number>();

  public processDelta(detail: any): string {
    if (!detail || typeof detail !== "object") {
      return "";
    }

    const displayText = this.displayText(detail);
    const key = this.keyFor(detail, this.details.length);
    const existingIndex = this.indexes.get(key);

    if (existingIndex === undefined) {
      this.indexes.set(key, this.details.length);
      this.details.push({ ...detail });
      return displayText;
    }

    const existing = this.details[existingIndex];
    for (const [field, value] of Object.entries(detail)) {
      if ((field === "text" || field === "summary") && typeof value === "string") {
        existing[field] =
          typeof existing[field] === "string" ? existing[field] + value : value;
      } else if (value !== null && value !== undefined) {
        existing[field] = value;
      }
    }
    return displayText;
  }

  public hasDetails(): boolean {
    return this.details.length > 0;
  }

  public getDetails(): any[] {
    return JSON.parse(JSON.stringify(this.details));
  }

  private keyFor(detail: any, fallbackIndex: number): string {
    const type = typeof detail.type === "string" ? detail.type : "reasoning.unknown";
    if (typeof detail.id === "string" && detail.id) {
      return `${type}::id::${detail.id}`;
    }
    if (typeof detail.index === "number") {
      return `${type}::index::${detail.index}`;
    }
    return `${type}::pos::${fallbackIndex}`;
  }

  private displayText(detail: any): string {
    if (typeof detail.text === "string") {
      return detail.text;
    }
    if (typeof detail.summary === "string") {
      return detail.summary;
    }
    return "";
  }
}

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
      if (!this.customBaseUrl.includes("/chat/completions")) {
        this.apiUrl = this.joinUrl(this.customBaseUrl, "/chat/completions");
      } else {
        this.apiUrl = this.customBaseUrl;
      }
      log(`Using custom OpenAI base URL: ${this.apiUrl}`);
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
    modelNameOverride?: string,
    configName?: string,
    fileConfig?: Record<string, any>,
  ): AsyncGenerator<string[], void, unknown> {
    log(`Starting OpenAI API request with ${messages.length} messages`);

    try {
      // First prepare messages with system prompt
      const systemPromptToUse =
        systemPrompt || generateToolCallingSystemPrompt(new Map(), new Map());
      const systemMessage = { role: "system", content: systemPromptToUse };

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
      modelName = modelName || "gpt-3.5-turbo";

      // Get configuration values with proper precedence (file config > provider config > global config)
      const { getMaxTokens, getReasoningEffort } = require("./config");
      const maxTokens = getMaxTokens(configName, fileConfig);
      const reasoningEffort = getReasoningEffort(configName, fileConfig);

      // Reasoning is replayed unless it was explicitly turned off
      const cleanedMessages = cleanMessagesForApi(messages, {
        modelName,
        thinkingEnabled: reasoningEffort !== "none",
        apiStyle: "openai_chat",
      });

      // Add system message as the first message
      const allMessages = [
        systemMessage,
        ...this.formatMessages(cleanedMessages, document),
      ];

      // Initial request body
      const requestBody: any = {
        model: modelName,
        messages: allMessages,
        stream: true,
      };

      // Add reasoning_effort parameter if configured
      if (reasoningEffort) {
        requestBody.reasoning_effort = reasoningEffort;
        log(`Using reasoning_effort: ${reasoningEffort}`);
      }

      // Use max_completion_tokens for reasoning models (includes both thinking and response tokens)
      log(`Using max_completion_tokens: ${maxTokens} for model ${modelName}`);
      requestBody.max_completion_tokens = maxTokens;

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
      let req: http.ClientRequest;

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
        
        if (response.statusCode! >= 500) {
          // 5xx errors will be retried by the streamer
          vscode.window.showErrorMessage(
            `OpenAI API Server Error (${response.statusCode}): Will automatically retry`,
          );
        } else if (response.statusCode === 429) {
          // 429 errors will be retried by the streamer
          vscode.window.showErrorMessage(
            `OpenAI API Rate Limit (${response.statusCode}): Will automatically retry with backoff`,
          );
        } else {
          vscode.window.showErrorMessage(
            `OpenAI API Error (${response.statusCode}): ${errorData || "Failed to get error details"}`,
          );
        }
        
        throw new Error(errorMessage);
      }

      log("Processing streaming response from OpenAI");
      yield* this.createStreamGenerator(response, modelName);
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
    modelName: string,
  ): AsyncGenerator<string[], void, unknown> {
    let buffer = "";
    let eventCount = 0;

    // Reasoning state for the current assistant turn
    let reasoningAccumulator = new ReasoningDetailsAccumulator();
    let reasoningText = "";
    let reasoningField: "reasoning" | "reasoning_content" | "reasoning_summary" =
      "reasoning_content";
    let reasoningOpen = false;

    /**
     * Builds the payload token that closes the current reasoning run. Returns an
     * empty array when there is no open reasoning.
     */
    const closeReasoning = (): string[] => {
      if (!reasoningOpen) {
        return [];
      }
      reasoningOpen = false;

      const payload: ThinkingPayload & { model: string } =
        reasoningAccumulator.hasDetails()
          ? {
              model: modelName,
              kind: "reasoning_details",
              reasoningDetails: reasoningAccumulator.getDetails(),
            }
          : {
              model: modelName,
              kind: "raw",
              field: reasoningField,
            };

      reasoningAccumulator = new ReasoningDetailsAccumulator();
      reasoningText = "";
      return [encodeThinkingPayloadToken(payload)];
    };

    /**
     * Extracts reasoning from a streaming delta. Providers disagree on the field
     * name, and OpenRouter sends structured reasoning_details.
     */
    const readReasoning = (delta: any): string[] => {
      if (!delta) {
        return [];
      }

      const tokens: string[] = [];

      // Providers sometimes send the same reasoning in multiple fields at
      // once (e.g. both "reasoning" and "reasoning_content"). Pick the first
      // field that has content and ignore the rest to avoid duplicates.
      let foundTextField = false;
      for (const field of [
        "reasoning_content",
        "reasoning",
        "reasoning_summary",
      ] as const) {
        const value = delta[field];
        if (typeof value === "string" && value) {
          reasoningField = field;
          reasoningOpen = true;
          reasoningText += value;
          tokens.push(encodeThinkingToken(value));
          foundTextField = true;
          break;
        }
      }

      // Only process reasoning_details when no text field carried the same
      // text in this delta. Some providers (e.g. OpenRouter) send both
      // "reasoning_content" and "reasoning_details" with identical content,
      // which would duplicate every reasoning chunk.
      if (!foundTextField && Array.isArray(delta.reasoning_details)) {
        for (const detail of delta.reasoning_details) {
          const text = reasoningAccumulator.processDelta(detail);
          reasoningOpen = true;
          if (text) {
            reasoningText += text;
            tokens.push(encodeThinkingToken(text));
          }
        }
      }

      return tokens;
    };

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
                "🚨 Max completion tokens detected in recent chunks! Will restart stream.",
                );
              throw new Error("max_completion_tokens: Detected finish_reason=length");
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

                    // Reasoning deltas arrive before content on reasoning models
                    const reasoningTokens = readReasoning(choice.delta);
                    if (reasoningTokens.length > 0) {
                      eventCount++;
                      yield reasoningTokens;
                    }

                    // The first content delta closes the reasoning run
                    if (choice.delta && choice.delta.content && reasoningOpen) {
                      yield closeReasoning();
                    }

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
                        "max_completion_tokens: Detected finish_reason=length",
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

      // Reasoning that was never followed by content still needs its payload
      if (reasoningOpen) {
        yield closeReasoning();
      }

      log(`Stream completed, processed ${eventCount} events`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Error in createStreamGenerator: ${message}`);

      // Don't show error notification for max completion tokens errors - they're handled gracefully
      if (!message.includes("max_completion_tokens")) {
        // Only notify about unexpected errors, not max tokens which we handle
        vscode.window.showErrorMessage(
          `Error during OpenAI stream processing: ${message}`,
        );
      } else {
        // For max tokens, just log it without user notification
        log(
          `Max completion tokens error detected in createStreamGenerator - will be handled by streamResponse`,
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
    return messages.map((msg) => {
      const thinking = msg.content.find((block) => block.type === "thinking");
      const rest = msg.content.filter((block) => block.type !== "thinking");
      const formatted: any = {
        role: msg.role,
        content: this.formatContent(
          rest.length > 0 ? rest : [{ type: "text", value: "" }],
          document,
        ),
      };

      // Reasoning travels in top level fields on the assistant message, never in
      // the content array (see llm-codegen openai_wrapper).
      if (thinking && thinking.type === "thinking" && msg.role === "assistant") {
        const payload = thinking.payload;
        if (payload?.kind === "reasoning_details" && payload.reasoningDetails) {
          formatted.reasoning_details = payload.reasoningDetails;
        } else if (thinking.value.trim() !== "") {
          const field = payload?.field ?? "reasoning_content";
          formatted[field] = thinking.value;
        }
      }

      return formatted;
    });
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
