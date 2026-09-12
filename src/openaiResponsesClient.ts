import * as https from "https";
import * as http from "http";
import * as path from "path";
import { MessageParam, Content, ThinkingPayload } from "./types";
import { resolveFilePath, readFileAsBuffer } from "./utils/fileUtils";
import * as vscode from "vscode";
import { log } from "./extension";
import { generateToolCallingSystemPrompt, getDefaultSystemPrompt } from "./config";
import {
  encodeThinkingPayloadToken,
  encodeThinkingToken,
} from "./utils/thinkingBlocks";
import { cleanMessagesForApi } from "./utils/messageCleanup";
import {
  NativeToolDefinition,
  apiToolName,
  canonicalToolName,
  openaiResponsesToolSchemas,
  renderToolArgumentsDelta,
  renderToolCallEnd,
  renderToolCallStart,
  usesNativeTools,
} from "./nativeTools";

/**
 * Client for the OpenAI Responses API.
 *
 * Requests are stateless (store: false) and ask for encrypted reasoning so the
 * reasoning items can be replayed on later turns, which is the only way to keep
 * reasoning context on gpt-* and o-series models.
 */
export class OpenAIResponsesClient {
  public lastUsage: Record<string, unknown> | undefined;
  private readonly apiUrl: string;

  constructor(
    private readonly apiKey: string,
    private readonly customBaseUrl?: string,
  ) {
    if (this.customBaseUrl) {
      if (this.customBaseUrl.includes("/responses")) {
        this.apiUrl = this.customBaseUrl;
      } else {
        this.apiUrl = this.joinUrl(this.customBaseUrl, "/responses");
      }
    } else {
      this.apiUrl = "https://api.openai.com/v1/responses";
    }
    log(`Using OpenAI Responses API URL: ${this.apiUrl}`);
  }

  private joinUrl(baseUrl: string, suffix: string): string {
    const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
    const cleanSuffix = suffix.startsWith("/") ? suffix : "/" + suffix;
    return base + cleanSuffix;
  }

  public async *streamCompletion(
    messages: readonly MessageParam[],
    nativeTools: readonly NativeToolDefinition[],
    document?: vscode.TextDocument,
    systemPrompt?: string,
    modelNameOverride?: string,
    configName?: string,
    fileConfig?: Record<string, any>,
  ): AsyncGenerator<string[], void, unknown> {
    this.lastUsage = undefined;
    log(`Starting OpenAI Responses request with ${messages.length} messages`);

    try {
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
      modelName = modelName || "gpt-4.1-mini";
      const native = usesNativeTools(modelName);

      const systemPromptToUse =
        systemPrompt ||
        (native
          ? getDefaultSystemPrompt()
          : generateToolCallingSystemPrompt(new Map(), new Map()));

      const { getMaxTokens, getReasoningEffort } = require("./config");
      const maxTokens = getMaxTokens(configName, fileConfig);
      const reasoningEffort = getReasoningEffort(configName, fileConfig);
      const thinkingEnabled = reasoningEffort !== "none";

      const cleanedMessages = cleanMessagesForApi(messages, {
        modelName,
        thinkingEnabled,
        apiStyle: "openai_responses",
      });

      const requestBody: any = {
        model: modelName,
        input: this.convertToResponsesInput(
          cleanedMessages,
          nativeTools,
          native,
          document,
        ),
        instructions: systemPromptToUse,
        max_output_tokens: maxTokens,
        stream: true,
        // Stateless: chat.md keeps the whole conversation in the document
        store: false,
      };
      if (native && nativeTools.length > 0) {
        requestBody.tools = openaiResponsesToolSchemas(nativeTools);
      }

      if (thinkingEnabled) {
        const reasoning: any = { summary: "auto" };
        if (reasoningEffort) {
          reasoning.effort = reasoningEffort;
        }
        requestBody.reasoning = reasoning;
        // Without this the encrypted reasoning cannot be replayed later
        requestBody.include = ["reasoning.encrypted_content"];
        log(`Using Responses reasoning config: ${JSON.stringify(reasoning)}`);
      }

      log(`Using OpenAI Responses model: ${modelName}`);

      const parsedUrl = new URL(this.apiUrl);
      const requestOptions = {
        method: "POST",
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
      };

      const requester = parsedUrl.protocol === "https:" ? https : http;
      const req = requester.request(requestOptions);

      req.on("error", (error) => {
        const message = error instanceof Error ? error.message : String(error);
        log(`Responses API request error: ${message}`);
        vscode.window.showErrorMessage(
          `OpenAI Responses API request error: ${message}`,
        );
        throw error;
      });

      req.write(JSON.stringify(requestBody));
      req.end();

      const response = await new Promise<http.IncomingMessage>(
        (resolve, reject) => {
          req.on("response", resolve);
          req.on("error", reject);
        },
      );

      log(`Responses API status code: ${response.statusCode}`);

      if (response.statusCode !== 200) {
        let errorData = "";
        for await (const chunk of response) {
          errorData += chunk.toString();
        }

        const errorMessage = `${response.statusCode} - API request failed: ${errorData}`;
        log(errorMessage);

        if (response.statusCode! >= 500) {
          vscode.window.showErrorMessage(
            `OpenAI Responses API Server Error (${response.statusCode}): Will automatically retry`,
          );
        } else if (response.statusCode === 429) {
          vscode.window.showErrorMessage(
            `OpenAI Responses API Rate Limit (${response.statusCode}): Will automatically retry with backoff`,
          );
        } else {
          vscode.window.showErrorMessage(
            `OpenAI Responses API Error (${response.statusCode}): ${errorData || "Failed to get error details"}`,
          );
        }

        throw new Error(errorMessage);
      }

      yield* this.createStreamGenerator(response, modelName, nativeTools);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Error in Responses streamCompletion: ${message}`);
      if (!message.includes("max_output_tokens")) {
        vscode.window.showErrorMessage(
          `Failed to initiate OpenAI Responses stream: ${message}`,
        );
      }
      throw error;
    }
  }

  /**
   * Processes the Responses SSE stream.
   *
   * Text arrives as response.output_text.delta, reasoning summaries as
   * response.reasoning_summary_text.delta, and the encrypted payload only shows up
   * when the reasoning item is done.
   */
  private async *createStreamGenerator(
    response: http.IncomingMessage,
    modelName: string,
    nativeTools: readonly NativeToolDefinition[],
  ): AsyncGenerator<string[], void, unknown> {
    let buffer = "";
    let eventCount = 0;
    const calls = new Map<
      number,
      {
        callId: string;
        name: string;
        arguments: string;
        emitted: number;
        started: boolean;
        done: boolean;
        closed: boolean;
      }
    >();
    let activeIndex: number | undefined;

    try {
      for await (const chunk of response) {
        buffer += chunk.toString();

        while (true) {
          const eventEnd = buffer.indexOf("\n\n");
          if (eventEnd === -1) {
            break;
          }

          const rawEvent = buffer.substring(0, eventEnd);
          buffer = buffer.substring(eventEnd + 2);

          const dataLine = rawEvent
            .split(/\r?\n/)
            .find((line) => line.startsWith("data: "));
          if (!dataLine) {
            continue;
          }

          const jsonData = dataLine.substring(6).trim();
          if (!jsonData || jsonData === "[DONE]") {
            continue;
          }

          let data: any;
          try {
            data = JSON.parse(jsonData);
          } catch (e) {
            log(`Responses API: could not parse event data: ${e}`);
            continue;
          }

          eventCount++;
          if (data.response?.usage || data.usage) {
            const usage = data.response?.usage || data.usage;
            this.lastUsage = {
              inputTokens: usage.input_tokens,
              outputTokens: usage.output_tokens,
              cacheReadTokens: usage.input_tokens_details?.cached_tokens,
            };
          }

          switch (data.type) {
            case "response.output_item.added": {
              if (data.item?.type === "function_call") {
                const index = data.output_index || 0;
                const state = calls.get(index) || {
                  callId: "",
                  name: "",
                  arguments: "",
                  emitted: 0,
                  started: false,
                  done: false,
                  closed: false,
                };
                state.callId = data.item.call_id || state.callId;
                state.name = data.item.name || state.name;
                state.arguments += data.item.arguments || "";
                calls.set(index, state);
                if (activeIndex === undefined) {
                  activeIndex = index;
                  state.started = true;
                  const tokens = [
                    renderToolCallStart(
                      state.callId || `chatmd_call_${index}`,
                      canonicalToolName(state.name, nativeTools),
                    ),
                  ];
                  if (state.arguments) {
                    state.emitted = state.arguments.length;
                    tokens.push(renderToolArgumentsDelta(state.arguments));
                  }
                  yield tokens;
                }
              }
              break;
            }
            case "response.function_call_arguments.delta": {
              const index = data.output_index || 0;
              const state = calls.get(index);
              if (state && typeof data.delta === "string") {
                state.arguments += data.delta;
                if (activeIndex === index) {
                  state.emitted = state.arguments.length;
                  yield [renderToolArgumentsDelta(data.delta)];
                }
              }
              break;
            }
            case "response.function_call_arguments.done": {
              const index = data.output_index || 0;
              const state = calls.get(index);
              if (state) {
                if (typeof data.arguments === "string" && data.arguments) {
                  state.arguments = data.arguments;
                }
                state.done = true;
                if (activeIndex === index) {
                  const pending = state.arguments.substring(state.emitted);
                  yield [
                    ...(pending ? [renderToolArgumentsDelta(pending)] : []),
                    renderToolCallEnd(),
                  ];
                  state.closed = true;
                  activeIndex = undefined;
                  while (activeIndex === undefined) {
                    const next = Array.from(calls.entries()).find(
                      ([, candidate]) => !candidate.started && !candidate.closed,
                    );
                    if (!next) {
                      break;
                    }
                    const [nextIndex, candidate] = next;
                    candidate.started = true;
                    activeIndex = nextIndex;
                    candidate.emitted = candidate.arguments.length;
                    yield [
                      renderToolCallStart(
                        candidate.callId || `chatmd_call_${nextIndex}`,
                        canonicalToolName(candidate.name, nativeTools),
                      ),
                      ...(candidate.arguments
                        ? [renderToolArgumentsDelta(candidate.arguments)]
                        : []),
                    ];
                    if (candidate.done) {
                      yield [renderToolCallEnd()];
                      candidate.closed = true;
                      activeIndex = undefined;
                    }
                  }
                }
              }
              break;
            }
            case "response.output_text.delta": {
              if (typeof data.delta === "string" && data.delta) {
                yield [data.delta];
              }
              break;
            }
            case "response.reasoning_summary_text.delta":
            case "response.reasoning_text.delta": {
              if (typeof data.delta === "string" && data.delta) {
                yield [encodeThinkingToken(data.delta)];
              }
              break;
            }
            case "response.output_item.done": {
              const item = data.item;
              if (item && item.type === "reasoning" && item.encrypted_content) {
                const payload: ThinkingPayload & { model: string } = {
                  model: modelName,
                  kind: "openai_encrypted",
                  itemId: item.id,
                  encryptedContent: item.encrypted_content,
                };
                log(`Received encrypted reasoning item ${item.id}`);
                yield [encodeThinkingPayloadToken(payload)];
              } else if (item?.type === "function_call") {
                const index = data.output_index || 0;
                const state = calls.get(index);
                if (state) {
                  state.callId = item.call_id || state.callId;
                  state.name = item.name || state.name;
                  state.arguments = item.arguments || state.arguments;
                }
              }
              break;
            }
            case "response.incomplete": {
              const reason = data.response?.incomplete_details?.reason;
              log(`Responses API incomplete: ${reason}`);
              if (reason === "max_output_tokens") {
                throw new Error(
                  "max_output_tokens: Response incomplete due to token limit",
                );
              }
              break;
            }
            case "response.failed":
            case "error": {
              const message =
                data.response?.error?.message || data.message || "unknown error";
              log(`Responses API error event: ${message}`);
              throw new Error(`Responses API error: ${message}`);
            }
            default:
              break;
          }
        }
      }

      for (const [index, state] of calls) {
        if (state.closed) {
          continue;
        }
        yield [
          ...(!state.started
            ? [
                renderToolCallStart(
                  state.callId || `chatmd_call_${index}`,
                  canonicalToolName(state.name, nativeTools),
                ),
              ]
            : []),
          ...(state.arguments.substring(state.emitted)
            ? [renderToolArgumentsDelta(state.arguments.substring(state.emitted))]
            : []),
          renderToolCallEnd(),
        ];
      }

      log(`Responses stream completed, processed ${eventCount} events`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Error in Responses createStreamGenerator: ${message}`);
      if (!message.includes("max_output_tokens")) {
        vscode.window.showErrorMessage(
          `Error during OpenAI Responses stream processing: ${message}`,
        );
      }
      throw error;
    }
  }

  /**
   * Converts chat.md messages into Responses API input items.
   *
   * Reasoning items have to precede the assistant message they belong to, which is
   * automatic here because cleanup moves thinking to the front of the content.
   */
  private convertToResponsesInput(
    messages: readonly MessageParam[],
    nativeTools: readonly NativeToolDefinition[],
    native: boolean,
    document?: vscode.TextDocument,
  ): any[] {
    const input: any[] = [];

    for (const message of messages) {
      if (!native) {
        const hasToolUse = message.content.some((block) => block.type === "tool_use");
        const materialized = message.content.flatMap((block): Content[] => {
          if (block.type === "tool_use") {
            return [{ type: "text", value: block.rawXml }];
          }
          if (block.type === "tool_result") {
            return [{ type: "text", value: block.rawText }];
          }
          return [block];
        });
        if (hasToolUse) {
          materialized.push({ type: "text", value: "<cmd:wait-tool-result/>" });
        }
        input.push(
          ...this.convertToResponsesInput(
            [{ role: message.role, content: materialized }],
            nativeTools,
            true,
            document,
          ),
        );
        continue;
      }

      if (message.role === "assistant") {
        const textParts: any[] = [];
        const functionCalls: any[] = [];

        for (const block of message.content) {
          if (block.type === "thinking") {
            const payload = block.payload;
            if (
              payload?.kind === "openai_encrypted" &&
              payload.itemId &&
              payload.encryptedContent
            ) {
              input.push({
                id: payload.itemId,
                type: "reasoning",
                summary: [],
                encrypted_content: payload.encryptedContent,
              });
            }
            // Raw reasoning text has nothing replayable in this API
            continue;
          }

          if (block.type === "text" && block.value.trim() !== "") {
            textParts.push({
              type: "output_text",
              text: block.value,
              annotations: [],
            });
          } else if (block.type === "image") {
            textParts.push({
              type: "output_text",
              text: "[Assistant Image]",
              annotations: [],
            });
          } else if (block.type === "tool_use") {
            functionCalls.push({
              type: "function_call",
              name: apiToolName(block.name, nativeTools),
              arguments: JSON.stringify(block.input),
              call_id: block.id,
            });
          }
        }

        if (textParts.length > 0) {
          input.push({
            role: "assistant",
            content: textParts,
          });
        }
        input.push(...functionCalls);
        continue;
      }

      const userParts: any[] = [];
      for (const block of message.content) {
        if (block.type === "text") {
          if (block.value.trim() !== "") {
            userParts.push({ type: "input_text", text: block.value });
          }
        } else if (block.type === "image") {
          const imageUrl = this.buildImageDataUrl(block, document);
          if (imageUrl) {
            userParts.push({ type: "input_image", image_url: imageUrl });
          } else {
            userParts.push({
              type: "input_text",
              text: `[Failed to load image: ${block.path}]`,
            });
          }
        } else if (block.type === "tool_result") {
          const output = block.content.map((part) => {
            if (part.type === "text") {
              return { type: "input_text", text: part.value };
            }
            const imageUrl = this.buildImageDataUrl(part, document);
            return imageUrl
              ? { type: "input_image", image_url: imageUrl }
              : {
                  type: "input_text",
                  text: `[Failed to load image: ${part.path}]`,
                };
          });
          input.push({
            type: "function_call_output",
            call_id: block.toolUseId,
            output,
          });
        }
      }

      if (userParts.length > 0) {
        input.push({ role: "user", content: userParts });
      }
    }

    return input;
  }

  private buildImageDataUrl(
    content: Content & { type: "image" },
    document?: vscode.TextDocument,
  ): string | undefined {
    try {
      const imagePath = document
        ? resolveFilePath(content.path, document)
        : content.path;
      const imageData = readFileAsBuffer(imagePath);
      if (!imageData) {
        return undefined;
      }
      return `data:${this.getMimeType(imagePath)};base64,${imageData.toString("base64")}`;
    } catch (error) {
      log(`Error processing image ${content.path}: ${error}`);
      return undefined;
    }
  }

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
