import * as vscode from "vscode";
import * as path from "path";
import { MessageParam, StreamerState } from "./types";
import { Lock } from "./utils/lock";
import { AnthropicClient } from "./anthropicClient";
import { OpenAIClient } from "./openaiClient";
import { OpenAIResponsesClient } from "./openaiResponsesClient";
import { couldBecomeMarkerLine } from "./utils/markerEscape";
import {
  stripThinkingSections,
  decodeThinkingPayloadToken,
  decodeThinkingToken,
  encodeThinkingToken,
  formatSignatureLine,
  isThinkingPayloadToken,
  isThinkingToken,
  renderStreamTokens,
} from "./utils/thinkingBlocks";
import { putThinkingEntry } from "./utils/thinkingMap";
import {
  findAssistantBlocks,
  findAllAssistantBlocks,
  parseAssistantContent,
  blockMarkerPrefix,
} from "./parser";
import { log, statusManager, requestStatusBarUpdate } from "./extension";
import { generateToolCallingSystemPrompt, getAutoSaveAfterStreaming } from "./config";
import { mcpClientManager } from "./mcpClientManager";
import {
  appendToChatHistory,
  updateChatHistoryUsage,
} from "./utils/fileUtils";
import {
  parseToolCall,
  checkForCompletedToolCall,
  findWaitMarker,
  waitMarkerPrefixLength,
  CMD_TOOL_CALL_OPEN_TAG,
  CMD_TOOL_CALL_CLOSE_TAG,
  CMD_WAIT_TOOL_RESULT_TAG,
} from "./tools/toolCallParser";

// Written with unicode escapes on purpose so that these literals are never mistaken
// for an actual tool call by chat.md's own parser.
const TOOL_CALL_OPEN_TAG = CMD_TOOL_CALL_OPEN_TAG;
/** End-of-batch marker the model emits after its last tool call */
const WAIT_TOOL_RESULT_TAG = CMD_WAIT_TOOL_RESULT_TAG;
/** Any use of the qualified namespace, including a malformed one */
const CMD_NAMESPACE_PREFIX = "\u003ccmd:";
const CMD_TOOL_NAME_TAGS = "\u003ccmd:tool_name\u003e...\u003c/cmd:tool_name\u003e";
const CMD_PARAM_TAGS =
  "\u003ccmd:param name=\"...\"\u003e...\u003c/cmd:param\u003e";

/**
 * Service for streaming LLM responses
 */
export class StreamingService {
  private readonly anthropicClient?: AnthropicClient;
  private readonly openaiClient?: OpenAIClient;
  private openaiResponsesClient?: OpenAIResponsesClient;
  private readonly openaiApiKey?: string;
  private readonly openaiBaseUrl?: string;
  private readonly provider: string;

  constructor(
    apiKey: string,
    private readonly document: vscode.TextDocument,
    private readonly lock: Lock,
    providerOverride?: string,
    baseUrlOverride?: string,
    private readonly configNameOverride?: string,
  ) {
    try {
      // Decide provider (use per-file override or global)
      let resolvedProvider: string;
      if (providerOverride) {
        resolvedProvider = providerOverride;
      } else if (this.configNameOverride) {
        // Use per-file config for fallback
        const { getProviderForConfig } = require("./config");
        resolvedProvider = getProviderForConfig(this.configNameOverride);
      } else {
        // Use global config
        const { getProvider } = require("./config");
        resolvedProvider = getProvider();
      }
      this.provider = resolvedProvider;
      log(`Using LLM provider: ${this.provider} (configOverride: ${this.configNameOverride || 'none'})`);

      // Decide base URL (use per-file override or file-specific config)
      let baseUrl = baseUrlOverride;
      if (this.provider === "openai") {
        try {
          if (!baseUrl) {
            if (this.configNameOverride) {
              // Use per-file config for fallback
              const { getBaseUrlForConfig } = require("./config");
              baseUrl = getBaseUrlForConfig(this.configNameOverride);
            } else {
              // Use global config
              const { getBaseUrl } = require("./config");
              baseUrl = getBaseUrl();
            }
          }
        } catch (e) {
          log(`Could not get base URL: ${e}, will use default`);
          baseUrl = undefined;
        }
      }

      if (this.provider === "anthropic") {
        this.anthropicClient = new AnthropicClient(apiKey);
      } else if (this.provider === "openai") {
        this.openaiBaseUrl = baseUrl;
        this.openaiClient = new OpenAIClient(apiKey, baseUrl);
        // The Responses API client is created lazily, since the choice depends on
        // per-file configuration that is only known per request.
        this.openaiApiKey = apiKey;
      } else {
        log(`Unknown provider: ${this.provider}, falling back to Anthropic`);
        this.provider = "anthropic";
        this.anthropicClient = new AnthropicClient(apiKey);
      }
    } catch (error) {
      log(`Error initializing streaming service: ${error}`);
      throw new Error(
        `Could not initialize streaming service: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Creates a batching wrapper around a stream that collects tokens for a specified interval
   * before emitting them as batches
   */
  private async* createBatchingWrapper(
    stream: AsyncIterable<string[]>,
    batchIntervalMs: number = 100
  ): AsyncGenerator<string[], void, unknown> {
    const tokenBatch: string[] = [];
    let batchTimer: NodeJS.Timeout | null = null;
    let isTimerActive = false;
    
    // Queue to store batches ready for emission
    const batchQueue: string[][] = [];
    let streamEnded = false;
    let streamError: Error | null = null; // Track errors from the stream

    const emitCurrentBatch = () => {
      if (tokenBatch.length > 0) {
        log(`Batching: queuing batch of ${tokenBatch.length} tokens`);
        batchQueue.push([...tokenBatch]);
        tokenBatch.length = 0; // Clear the batch
      }
    };

    const startBatchTimer = () => {
      if (isTimerActive) return;
      
      isTimerActive = true;
      const timerTick = () => {
        emitCurrentBatch();
        
        if (!streamEnded) {
          batchTimer = setTimeout(timerTick, batchIntervalMs);
        } else {
          isTimerActive = false;
          batchTimer = null;
        }
      };
      
      batchTimer = setTimeout(timerTick, batchIntervalMs);
    };

    // The source is driven through its iterator rather than a for-await loop, so
    // that the consumer can close it early. Reading tokens nobody will use costs
    // real time: the turn ends the moment a tool call batch is complete, and
    // without this the wrapper would sit here until the model stopped talking.
    const iterator = stream[Symbol.asyncIterator]();
    let consumerDone = false;

    // Start processing the stream asynchronously
    const processStream = async () => {
      try {
        while (!consumerDone) {
          const next = await iterator.next();
          if (next.done || consumerDone) {
            break;
          }
          const tokens = next.value;
          if (tokens && tokens.length > 0) {
            log(`Batching: received ${tokens.length} tokens`);
            tokenBatch.push(...tokens);
            
            // Start timer on first tokens
            if (!isTimerActive) {
              startBatchTimer();
            }
          }
        }
      } catch (error) {
        log(`Batching: stream processing error: ${error}`);
        // Store the error to be re-thrown after yielding remaining batches
        streamError = error instanceof Error ? error : new Error(String(error));
      } finally {
        log('Batching: stream ended');
        streamEnded = true;
        
        // Clear timer and emit final batch
        if (batchTimer) {
          clearTimeout(batchTimer);
          batchTimer = null;
        }
        isTimerActive = false;
        
        // Emit any remaining tokens
        emitCurrentBatch();
      }
    };

    // Start stream processing (don't await - let it run in background)
    const streamPromise = processStream();

    try {
      // Keep emitting batches until stream is done and queue is empty
      while (!streamEnded || batchQueue.length > 0 || tokenBatch.length > 0) {
        // Check for queued batches first
        if (batchQueue.length > 0) {
          const batch = batchQueue.shift()!;
          log(`Batching: yielding batch of ${batch.length} tokens`);
          yield batch;
          continue;
        }
        
        // If stream ended and we have remaining tokens, emit them
        if (streamEnded && tokenBatch.length > 0) {
          log(`Batching: yielding final ${tokenBatch.length} tokens`);
          const finalBatch = [...tokenBatch];
          tokenBatch.length = 0;
          yield finalBatch;
          continue;
        }
        
        // Wait a bit for more tokens or timer to fire
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      
      log('Batching: all batches emitted, wrapper complete');
      
      // After all batches are emitted, re-throw any error that occurred during stream processing
      // This ensures max_tokens errors and other important errors are propagated to the caller
      if (streamError) {
        const errorMessage = String(streamError);
        log(`Batching: re-throwing stream error after all batches emitted: ${errorMessage}`);
        throw streamError;
      }

    } finally {
      // Cleanup
      consumerDone = true;
      if (batchTimer) {
        clearTimeout(batchTimer);
        batchTimer = null;
      }
      isTimerActive = false;

      // Closing the source iterator unwinds the provider generator, which breaks
      // its own loop over the SDK stream and aborts the underlying request. Without
      // it, awaiting streamPromise below would block until the model had finished
      // generating a response that has already been thrown away.
      try {
        await iterator.return?.();
      } catch (error) {
        log(`Batching: error closing source stream early: ${error}`);
      }

      // Wait for stream processing to complete
      await streamPromise;
      
      log('Batching: cleanup complete');
    }
  }

  /**
   * Cancels an active streaming response
   * This can be called by external components holding a reference to the streamer
   */
  public cancelStreaming(streamer: StreamerState): void {
    if (streamer && streamer.isActive) {
      log("Explicitly cancelling active streamer");
      // Set to inactive regardless of current state to ensure cancellation works
      // during retries, waiting periods, or normal streaming
      streamer.isActive = false;
      
      // Immediately hide streaming status
      requestStatusBarUpdate(this.document.uri.fsPath, "streaming cancelled");
      
      // Notify user that cancellation request was processed
      vscode.window.showInformationMessage("Streaming cancellation initiated");
    }
  }

  /**
   * Stream LLM response for given messages
   * Updates document idempotently as tokens arrive
   */
  /**
   * Check if an error is due to max tokens being reached
   */
  private isMaxTokensError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const message = error.message;

    return (
      message.includes("max_tokens") ||
      message.includes("max_completion_tokens") ||
      message.includes("max_output_tokens") ||
      message.includes("token limit") ||
      message.includes("context length") ||
      message.includes("finish_reason=length")
    );
  }

  /**
   * Check for completed tool calls in text
   * @param text The text to check for tool calls
   * @returns Result with completion status and metadata
   */
  private checkForCompletedToolCall(text: string) {
    // Use the imported checkForCompletedToolCall function directly
    return checkForCompletedToolCall(text);
  }

  /**
   * Stores a reasoning payload in cmdassets/thinking_map.json and returns the
   * "qualified_model_name::hash8" line that references it.
   */
  private recordThinkingPayload(token: string): string | undefined {
    const decoded = decodeThinkingPayloadToken(token);
    if (!decoded || typeof decoded !== "object") {
      log("Ignoring malformed thinking payload token");
      return undefined;
    }

    const { model, ...payload } = decoded as any;
    if (!model || !payload.kind) {
      log("Ignoring thinking payload without model or kind");
      return undefined;
    }

    try {
      const docDir = path.dirname(this.document.uri.fsPath);
      const hash = putThinkingEntry(docDir, model, payload);
      log(`Stored ${payload.kind} thinking payload as ${model}::${hash}`);
      return formatSignatureLine(model, hash);
    } catch (error) {
      log(`Failed to store thinking payload: ${error}`);
      return undefined;
    }
  }

  /**
   * Turns a batch of stream tokens into the text to append to the assistant block,
   * inserting "## %% thinking" / "## %% text" markers as the token kind changes.
   */
  private renderTokens(streamer: StreamerState, tokens: string[]): string[] {
    const state = {
      thinkingOpen: streamer.thinkingOpen ?? false,
      textOpen: streamer.textOpen ?? false,
      sawThinking: streamer.sawThinking ?? false,
      scanOffset: streamer.scanOffset ?? 0,
      textSectionEnd: streamer.textSectionEnd ?? null,
    };

    const rendered = renderStreamTokens(
      tokens,
      streamer.tokens.join(""),
      state,
      (token) => this.recordThinkingPayload(token),
    );

    streamer.thinkingOpen = state.thinkingOpen;
    streamer.textOpen = state.textOpen;
    streamer.sawThinking = state.sawThinking;
    streamer.scanOffset = state.scanOffset;
    streamer.textSectionEnd = state.textSectionEnd;

    return rendered.length > 0 ? [rendered] : [];
  }

  /**
   * Keeps only the first `keepLength` characters worth of rendered tokens,
   * splitting the token that straddles the boundary.
   *
   * Used to end a write exactly at a chosen offset: the close of a completed tool
   * call, or the start of an end-of-batch marker that must not be written.
   */
  private truncateTokens(tokens: string[], keepLength: number): string[] {
    const kept: string[] = [];
    let currentLength = 0;

    for (const token of tokens) {
      if (currentLength >= keepLength) {
        break;
      }

      if (currentLength + token.length <= keepLength) {
        kept.push(token);
        currentLength += token.length;
      } else {
        const partialToken = token.substring(0, keepLength - currentLength);
        if (partialToken) {
          kept.push(partialToken);
        }
        break;
      }
    }

    return kept;
  }

  /**
   * Prepares rendered tokens for writing when no tool call completed in this batch.
   *
   * The end-of-batch marker is a control signal, so it must never land in the
   * document. Reaching here means nothing was detected to execute, so a complete
   * marker is the model asking for results it never requested: the write is cut at
   * the marker and the caller ends the turn. A trailing fragment that could still
   * become the marker is held back on the streamer and prepended to the next batch
   * instead, so a marker split across two batches is never written either.
   *
   * When a tool call *does* complete the marker needs no handling here: it sits
   * past the tool call's end index, so the truncation that ends the assistant
   * block at the closing tag already keeps it out and hands it to the buffer.
   */
  private trimWaitMarkerFromWrite(
    streamer: StreamerState,
    renderedTokens: string[],
    currentTokens: string,
    scanStart: number,
    scanEnd: number,
  ): { tokens: string[]; strayMarker: boolean } {
    if (scanEnd <= scanStart) {
      return { tokens: renderedTokens, strayMarker: false };
    }

    const alreadyWritten = streamer.tokens.join("").length;
    const section = currentTokens.substring(scanStart, scanEnd);

    const markerIndex = findWaitMarker(section);
    if (markerIndex !== -1) {
      log(
        "End-of-batch marker generated without a completed tool call, cutting it out of the write",
      );
      const keepLength = Math.max(0, scanStart + markerIndex - alreadyWritten);
      return {
        tokens: this.truncateTokens(renderedTokens, keepLength),
        strayMarker: true,
      };
    }

    // Only a fragment at the very end of what has been generated can still grow
    // into the marker. A text section closed by a later thinking section cannot.
    if (scanEnd < currentTokens.length) {
      return { tokens: renderedTokens, strayMarker: false };
    }

    const holdBack = waitMarkerPrefixLength(section);
    if (holdBack === 0) {
      return { tokens: renderedTokens, strayMarker: false };
    }

    const keepLength = Math.max(
      0,
      currentTokens.length - holdBack - alreadyWritten,
    );
    streamer.pendingText = currentTokens.substring(
      currentTokens.length - holdBack,
    );
    log(
      `Holding back ${holdBack} chars that may still become the end-of-batch marker`,
    );
    return {
      tokens: this.truncateTokens(renderedTokens, keepLength),
      strayMarker: false,
    };
  }

  /**
   * Re-delivers text withheld from the previous batch.
   *
   * Prepended as a raw token rather than to the rendered output, so the section
   * state machine accounts for it when computing the scan offsets, and so it is
   * escaped exactly once - escaping before withholding would escape it again on
   * the way back in.
   */
  private withPendingText(
    streamer: StreamerState,
    tokens: string[],
  ): string[] {
    const pending = streamer.pendingText ?? "";
    if (!pending) {
      return tokens;
    }
    const wasThinking = streamer.pendingIsThinking === true;
    streamer.pendingText = "";
    streamer.pendingIsThinking = false;
    return [wasThinking ? encodeThinkingToken(pending) : pending, ...tokens];
  }

  /**
   * Merges adjacent tokens of the same kind.
   *
   * Purely so the tail of a batch can be examined as one string; the renderer
   * concatenates them anyway, so nothing else changes.
   */
  private coalesceTokens(tokens: string[]): string[] {
    const merged: string[] = [];
    for (const token of tokens) {
      const previous = merged.length > 0 ? merged[merged.length - 1] : undefined;
      if (previous === undefined || isThinkingPayloadToken(token)) {
        merged.push(token);
        continue;
      }
      const bothThinking = isThinkingToken(token) && isThinkingToken(previous);
      const bothText =
        !isThinkingToken(token) &&
        !isThinkingPayloadToken(token) &&
        !isThinkingToken(previous) &&
        !isThinkingPayloadToken(previous);
      if (bothThinking) {
        merged[merged.length - 1] = encodeThinkingToken(
          decodeThinkingToken(previous) + decodeThinkingToken(token),
        );
      } else if (bothText) {
        merged[merged.length - 1] = previous + token;
      } else {
        merged.push(token);
      }
    }
    return merged;
  }

  /**
   * Withholds a trailing partial line that might still become a block marker.
   *
   * A marker is only a marker once its line ends: `# %% user` could still turn
   * into `# %% username`. Escaping it early would corrupt ordinary prose, and
   * writing it raw would split the document, so it waits for the newline.
   *
   * Only the tail needs checking. Any earlier partial line was withheld by this
   * same rule on a previous batch and has just been prepended, so the undecided
   * line is always wholly inside this batch. The exception is a block that
   * already held a partial marker line before streaming began - a resumed turn -
   * which append-only writing cannot go back and fix.
   */
  private holdBackMarkerLine(
    streamer: StreamerState,
    tokens: string[],
  ): string[] {
    if (tokens.length === 0) {
      return tokens;
    }
    const last = tokens[tokens.length - 1];
    if (isThinkingPayloadToken(last)) {
      return tokens;
    }

    const isThinking = isThinkingToken(last);
    const text = isThinking ? decodeThinkingToken(last) : last;
    const newline = text.lastIndexOf("\n");
    const line = text.substring(newline + 1);
    if (!line || !couldBecomeMarkerLine(line)) {
      return tokens;
    }

    streamer.pendingText = line;
    streamer.pendingIsThinking = isThinking;
    const kept = text.substring(0, newline + 1);
    const head = tokens.slice(0, -1);
    if (!kept) {
      return head;
    }
    return [...head, isThinking ? encodeThinkingToken(kept) : kept];
  }

  /**
   * Classify buffered text that follows an already emitted tool call.
   *
   * - "tool_call": the buffer starts with another tool call
   * - "wait_marker": the buffer starts with the end-of-batch marker, so the batch
   *   is complete and the turn ends here
   * - "incomplete": the buffer could still become one of the above, wait for tokens
   * - "invalid": the buffer is normal assistant text, so the stream must stop
   */
  private classifyBuffer(
    buffer: string,
  ): "tool_call" | "wait_marker" | "incomplete" | "invalid" {
    const value = buffer.replace(/^\s+/, "");
    if (!value) return "incomplete";
    if (value.startsWith(TOOL_CALL_OPEN_TAG)) return "tool_call";
    if (value.startsWith(WAIT_TOOL_RESULT_TAG)) return "wait_marker";
    // Both tags share the "<cmd:" prefix, so a buffer that is still a prefix of
    // either one has to wait rather than being judged now.
    if (TOOL_CALL_OPEN_TAG.startsWith(value)) return "incomplete";
    if (WAIT_TOOL_RESULT_TAG.startsWith(value)) return "incomplete";
    return "invalid";
  }

  /**
   * Process buffered text that follows an already emitted tool call.
   * Pops complete tool calls off the left of the buffer, emitting each one into the
   * assistant block without executing anything. Stops streaming once the buffer
   * holds the end-of-batch marker, or no longer looks like another tool call.
   *
   * @returns the unconsumed buffer, whether streaming should stop, whether it
   *          stopped because a document update failed, and whether it stopped on
   *          the end-of-batch marker
   */
  private async processBufferedToolCalls(
    streamer: StreamerState,
    bufferText: string,
  ): Promise<{
    remainingBuffer: string;
    stop: boolean;
    failed: boolean;
    waitMarker: boolean;
  }> {
    let buffer = bufferText;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const classification = this.classifyBuffer(buffer);

      if (classification === "incomplete") {
        // Could still become another tool call or the marker - wait for more tokens
        return {
          remainingBuffer: buffer,
          stop: false,
          failed: false,
          waitMarker: false,
        };
      }

      if (classification === "wait_marker") {
        // The model declared the batch complete. The marker is a control signal, so
        // it is consumed here and never written into the document, and anything the
        // model streamed after it is dropped.
        log("End-of-batch marker found in buffer, ending the turn");
        return {
          remainingBuffer: "",
          stop: true,
          failed: false,
          waitMarker: true,
        };
      }

      if (classification === "invalid") {
        // A model that forgot the marker still gets its batch executed: prose after
        // the last tool call ends the turn just as the marker would.
        log(
          `Buffered content is neither another tool call nor the end-of-batch marker, interrupting stream and discarding buffer: "${buffer.substring(0, 80)}${buffer.length > 80 ? "..." : ""}"`,
        );
        return {
          remainingBuffer: "",
          stop: true,
          failed: false,
          waitMarker: false,
        };
      }

      // classification === "tool_call"
      const toolCallResult = this.checkForCompletedToolCall(buffer);
      if (!toolCallResult || !toolCallResult.isComplete) {
        // Tool call is still streaming in - wait for more tokens
        return {
          remainingBuffer: buffer,
          stop: false,
          failed: false,
          waitMarker: false,
        };
      }

      const toolCallText = buffer.substring(0, toolCallResult.endIndex);
      log(
        `Emitting additional parallel tool call (${toolCallText.length} chars) without executing it`,
      );
      const updateSuccess = await this.updateDocumentWithTokens(streamer, [
        toolCallText,
      ]);
      if (!updateSuccess) {
        log("Token update failed when emitting buffered tool call, canceling");
        streamer.isActive = false;
        return {
          remainingBuffer: "",
          stop: true,
          failed: true,
          waitMarker: false,
        };
      }

      buffer = buffer.substring(toolCallResult.endIndex);
    }
  }

  /**
   * Insert a single tool_execute block after the tool calls written into the
   * assistant block. The document listener executes the tool calls one at a time,
   * adding a further tool_execute block after each result until all of them ran.
   */
  private async insertToolExecuteBlockAfterToolCalls(
    streamer: StreamerState,
  ): Promise<void> {
    const text = this.document.getText();
    const blockStart = this.findBlockStartPosition(text, streamer);

    if (blockStart === -1) {
      log("Could not find position to insert tool_execute block");
      return;
    }

    const currentText = streamer.tokens.join("");
    const insertPosition = this.document.positionAt(
      blockStart + currentText.length,
    );

    // Check for unbalanced fence blocks: an opening ``` with no matching closing ```
    const openingFenceMatch =
      /```(?:[a-zA-Z0-9_\-]*)?(?:\s*\n|\s+)\s*[<]tool_call[>][\s\S]*?\n\s*<\/tool_call>(?!\s*\n\s*```)/s.exec(
        currentText,
      );

    let textToInsert = "";

    if (openingFenceMatch) {
      log(
        "Detected unbalanced fence block - adding closing fence before tool_execute block",
      );
      textToInsert = "\n```\n\n# %% tool_execute\n";
    } else {
      textToInsert = `${blockMarkerPrefix(
        text.substring(0, blockStart + currentText.length),
      )}# %% tool_execute\n`;
    }

    const edit = new vscode.WorkspaceEdit();
    edit.insert(this.document.uri, insertPosition, textToInsert);
    const applied = await vscode.workspace.applyEdit(edit);

    if (applied) {
      log(
        `Successfully inserted ${openingFenceMatch ? "closing fence and " : ""}tool_execute block`,
      );

      // The tool_execute block has been added, but the status must stay visible
      // until the DocumentListener picks up the change and executes the tool
      requestStatusBarUpdate(
        this.document.uri.fsPath,
        "tool auto-execution started",
      );

      // Mark streamer as inactive BEFORE auto-save to prevent conflicts
      streamer.isActive = false;
      log("Marked streamer as inactive after tool_execute block insertion");

      // Small delay to ensure state propagation before auto-save document changes
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Auto-save after tool_execute block generation if enabled
      try {
        if (getAutoSaveAfterStreaming()) {
          log("Auto-saving document after tool_execute block generation");

          // Brief delay to ensure the insertion is processed by VS Code
          await new Promise((resolve) => setTimeout(resolve, 100));

          const saved = await this.document.save();

          if (saved && !this.document.isDirty) {
            log(
              "Document auto-saved successfully after tool_execute block generation",
            );
          } else {
            log(
              "Document auto-save did not complete after tool_execute block generation",
            );
          }
        } else {
          log(
            "Auto-save is disabled, skipping save after tool_execute block generation",
          );
        }
      } catch (error) {
        log(
          `Error during auto-save after tool_execute block generation: ${error}`,
        );
        // Don't show error to user as auto-save is a convenience feature
      }
    } else {
      log(
        `Failed to insert ${openingFenceMatch ? "closing fence and " : ""}tool_execute block`,
      );
      // Since adding the tool_execute block failed, hide the status
      requestStatusBarUpdate(this.document.uri.fsPath, "streaming finished");
    }
  }

  /**
   * Check if an error is a server error (5xx) or a rate limit error (429)
   * or any other error that would benefit from retrying
   */
  private isServerError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const message = error.message;

    return (
      /^5\d{2}/.test(message) ||
      message.includes("status 5") ||
      /^429/.test(message) ||
      message.includes("status 429") ||
      message.includes("Too Many Requests") ||
      message.includes("rate limit") ||
      message.includes("RateLimitError") ||
      message.includes("ECONNRESET") ||
      message.includes("socket hang up") ||
      message.includes("network error") ||
      message.includes("timeout")
    );
  }

  public getLastUsage(): Record<string, unknown> | undefined {
    if (this.provider === "anthropic") {
      return this.anthropicClient?.lastUsage;
    }
    if (this.openaiResponsesClient?.lastUsage) {
      return this.openaiResponsesClient.lastUsage;
    }
    return this.openaiClient?.lastUsage;
  }

  public async streamResponse(
    messages: readonly MessageParam[],
    streamer: StreamerState,
    systemPrompt: string, // Added systemPrompt parameter
    currentRetryAttempt: number = 0, // Add parameter to track retry attempts across recursive calls
    maxTokenRetryAttempt: number = 0, // Add parameter to track max token retries
    fileConfig?: Record<string, any> // Add optional file configuration parameter
  ): Promise<void> {
    // Flag to track if we need to restart due to max tokens
    let maxTokensReached = false;
    // Track retry attempts for server errors - initialize from passed parameter
    let retryAttempt = currentRetryAttempt;
    // Track max token retry attempts separately
    let tokenRetryAttempt = maxTokenRetryAttempt;
    const maxRetries = 5;
    const maxTokenRetries = 10; // Maximum number of retries for max token errors
    
    // Capture the success state early to avoid race conditions with isActive flag
    let streamCompletedSuccessfully = false;
    let shouldAutoSaveOnCompletion = false;
    // Set when a malformed tool call correction turn was appended, which already
    // includes its own user and assistant blocks
    let correctionInserted = false;

    try {
      log(
        `streamResponse called for ${messages.length} messages, provider: ${this.provider}, max retries allowed: ${maxRetries}, current retry: ${retryAttempt}, max token retries: ${maxTokenRetries}, current token retry: ${tokenRetryAttempt}`,
      );

      // Start streaming with retry logic for server errors
      while (retryAttempt < maxRetries) {  // Changed <= to < to enforce max retry limit correctly
        try {
          log(
            `Starting to stream response for ${messages.length} messages${retryAttempt > 0 ? ` (retry ${retryAttempt})` : ""}`,
          );
          // Invariant 4: On any streamer status update the status bar refresh is triggered
          requestStatusBarUpdate(this.document.uri.fsPath, "streaming started");

          // Resolve model name (allow per-file override)
          const { getModelName, getModelNameForConfig } = require("./config");
          const modelNameOverride: string | undefined = this.configNameOverride ? getModelNameForConfig(this.configNameOverride) : undefined;

          // Use the provided system prompt
          log(`Using provided system prompt (${systemPrompt.length} chars)`);

          // Start streaming completion based on provider, passing document for file path resolution
          let stream;
          if (this.provider === "anthropic" && this.anthropicClient) {
            stream = await this.anthropicClient.streamCompletion(
              messages,
              this.document,
              systemPrompt,
              modelNameOverride,
              this.configNameOverride,
              fileConfig,
            );
          } else if (this.provider === "openai" && this.openaiClient) {
            // gpt-* and o-series models on OpenAI itself go through the Responses
            // API, which is the only way to keep encrypted reasoning across turns
            const { resolveOpenaiApiStyle } = require("./config");
            let modelForRouting = modelNameOverride;
            if (!modelForRouting) {
              try {
                modelForRouting = getModelName();
              } catch {
                modelForRouting = undefined;
              }
            }
            const apiStyle = resolveOpenaiApiStyle(
              modelForRouting,
              this.openaiBaseUrl,
              this.configNameOverride,
              fileConfig,
            );
            log(`Using OpenAI API style: ${apiStyle}`);

            if (apiStyle === "responses") {
              if (!this.openaiResponsesClient) {
                this.openaiResponsesClient = new OpenAIResponsesClient(
                  this.openaiApiKey ?? "",
                  this.openaiBaseUrl,
                );
              }
              stream = await this.openaiResponsesClient.streamCompletion(
                messages,
                this.document,
                systemPrompt,
                modelNameOverride,
                this.configNameOverride,
                fileConfig,
              );
            } else {
              stream = await this.openaiClient.streamCompletion(
                messages,
                this.document,
                systemPrompt,
                modelNameOverride,
                this.configNameOverride,
                fileConfig,
              );
            }
          } else {
            throw new Error(
              `Provider ${this.provider} not properly configured`,
            );
          }

          log("Stream connection established");

          // Debug the document state before streaming
          const currentText = this.document.getText();
          log(`Current document text length: ${currentText.length} chars`);
          log(`Current streamer tokens: ${streamer.tokens.length} tokens`);

          // Add information about assistant blocks in the document
          const assistantBlocks = findAllAssistantBlocks(currentText);
          log(
            `Document contains ${assistantBlocks.length} assistant blocks, will look for last non-empty block if needed`,
          );

          // Extract message for logging
          const lastUserMessage =
            messages.length > 0 && messages[messages.length - 1].role === "user"
              ? messages[messages.length - 1].content
                  .filter((c) => c.type === "text")
                  .map((c) => (c as any).value)
                  .join(" ")
              : "No user message";
          log(
            `Streaming response to: "${lastUserMessage.substring(0, 50)}${lastUserMessage.length > 50 ? "..." : ""}"`,
          );

          let tokenCount = 0;

          // Parallel tool call support: once a tool call completes, everything that
          // follows is buffered and further complete tool calls are popped off the
          // left of the buffer and emitted (but not executed) until the buffer stops
          // looking like a tool call or the stream ends.
          let bufferingMode = false;
          let bufferText = "";
          let toolExecuteInserted = false;
          let updateFailed = false;
          let cancelledExternally = false;
          // Set when the model emitted the end-of-batch marker without a valid tool
          // call, so there is nothing to execute and the turn has to be corrected.
          let strayWaitMarker = false;
          // Whether the turn ended because the model marked the batch complete,
          // rather than by running out of things to say
          let endedOnWaitMarker = false;

          // Create a batching wrapper for the stream
          const batchingStream = this.createBatchingWrapper(stream, 100); // 100ms batching interval

          for await (const tokens of batchingStream) {
            // Check streamer status at the beginning of each token processing
            if (!streamer.isActive) {
              log("Streamer no longer active, stopping stream immediately");
              cancelledExternally = true;
              break;
            }

            if (tokens.length > 0) {
              tokenCount += tokens.length;
              log(`Received batched ${tokens.length} tokens: "${tokens.join("")}"`);

              // Log received tokens to the chat history file if available
              if (streamer.historyFilePath) {
                appendToChatHistory(streamer.historyFilePath, tokens.join(""));
              }

              if (bufferingMode) {
                // A tool call has already completed in this turn: buffer what follows
                // and keep popping further tool calls off the left of the buffer.
                const textTokens = tokens.filter(
                  (token) =>
                    !isThinkingToken(token) && !isThinkingPayloadToken(token),
                );
                if (textTokens.length !== tokens.length) {
                  log("Ignoring thinking tokens received while buffering tool calls");
                }
                if (textTokens.length === 0) {
                  continue;
                }
                bufferText += textTokens.join("");
                const bufferResult = await this.processBufferedToolCalls(
                  streamer,
                  bufferText,
                );
                bufferText = bufferResult.remainingBuffer;
                if (bufferResult.stop) {
                  updateFailed = bufferResult.failed;
                  endedOnWaitMarker = bufferResult.waitMarker;
                  break;
                }
                continue;
              }

              // Deliver text held back from the previous batch because it could
              // still have grown into the end-of-batch marker. It is prepended to
              // the raw tokens rather than the rendered output, so renderTokens
              // accounts for it when it computes the scan offsets.
              const batchTokens = this.holdBackMarkerLine(
                streamer,
                this.coalesceTokens(this.withPendingText(streamer, tokens)),
              );

              // Turn thinking/text tokens into document text with section markers
              const renderedTokens = this.renderTokens(streamer, batchTokens);
              if (renderedTokens.length === 0) {
                continue;
              }

              // Check if adding these tokens would complete a tool call. Only the
              // current text section is scanned, never thinking content: the region
              // is bounded below by scanOffset (start of the text section) and above
              // by textSectionEnd (set when a thinking section opened after it, and
              // null while the text section is still open).
              const currentTokens = [...streamer.tokens, ...renderedTokens].join("");
              const scanStart = streamer.scanOffset ?? 0;
              const scanEnd = streamer.textSectionEnd ?? currentTokens.length;
              const toolCallResult =
                scanEnd > scanStart
                  ? this.checkForCompletedToolCall(
                      currentTokens.substring(scanStart, scanEnd),
                    )
                  : null;

              // Check if we have a completed tool call
              if (toolCallResult && toolCallResult.isComplete) {
                log(
                  "Detected completed tool call, entering buffering mode at position " +
                    toolCallResult.endIndex,
                );
                
                // Set flag to indicate we're handling a tool call
                log(`Setting isHandlingToolCall flag to true for streamer at index ${streamer.messageIndex}`);
                streamer.isHandlingToolCall = true;

                try {
                  // Get the end index of the completed tool call (absolute, since
                  // detection ran on the current text section only)
                  const endIndex = scanStart + toolCallResult.endIndex;
                  const toolName = 'toolName' in toolCallResult ? toolCallResult.toolName : '';
                  
                  // Always show the status bar when a tool call is detected
                  requestStatusBarUpdate(this.document.uri.fsPath, "tool execution detected");
                  log(`Showing 'executing tool' status for detected tool "${toolName}"`);
                  
                  // All tools are always auto-executed since the feature to disable auto-execution has been removed
                  const isAutoExecuteDisabled = false; 
                  log(`Auto-execute is always enabled for all tools`);

                  // Truncate existing tokens if needed
                  if (streamer.tokens.join("").length > endIndex) {
                    log(
                      "Truncating existing tokens to remove content after tool call",
                    );
                    const joinedTokens = streamer.tokens.join("");
                    streamer.tokens = [joinedTokens.substring(0, endIndex)];
                  }

                  // Calculate how much of the new tokens we should keep
                  const existingLength = streamer.tokens.join("").length;
                  const keepLength = Math.max(0, endIndex - existingLength);

                  // Create a new array of tokens that only includes content up to
                  // the </cmd:tool_call> tag. Anything past it, the end-of-batch
                  // marker included, is left for the buffer to classify.
                  const truncatedNewTokens = this.truncateTokens(
                    renderedTokens,
                    keepLength,
                  );

                  log(
                    `Truncated tokens from ${renderedTokens.length} to ${truncatedNewTokens.length} to exclude content after </cmd:tool_call>`,
                  );

                  // Update the document with truncated tokens
                  if (truncatedNewTokens.length > 0) {
                    // Only proceed with tool_execute if token update is successful
                    const updateSuccess = await this.updateDocumentWithTokens(
                      streamer,
                      truncatedNewTokens,
                    );
                    if (!updateSuccess) {
                      log(
                        "Token update failed when handling completed tool call, canceling further processing",
                      );
                      streamer.isActive = false;
                      break;
                    }
                  }

                  // Parallel tool calls: don't stop here. Buffer everything that
                  // follows this tool call and keep emitting further tool calls.
                  // The tool_execute block is added once the sequence ends.
                  bufferingMode = true;
                  bufferText = currentTokens.substring(endIndex);
                  log(
                    `Entering buffering mode with ${bufferText.length} buffered chars`,
                  );

                  const bufferResult = await this.processBufferedToolCalls(
                    streamer,
                    bufferText,
                  );
                  bufferText = bufferResult.remainingBuffer;
                  if (bufferResult.stop) {
                    updateFailed = bufferResult.failed;
                    endedOnWaitMarker = bufferResult.waitMarker;
                    break;
                  }
                  continue;
                } catch (error) {
                  log(`Error handling tool call: ${error}`);
                  // Continue as normal if handling tool call fails
                }
              } else {
                // Normal token processing
                try {
                  // Nothing completed in this batch, so the end-of-batch marker has
                  // to be kept out of the document here rather than by the tool call
                  // truncation above.
                  const { tokens: tokensToWrite, strayMarker } =
                    this.trimWaitMarkerFromWrite(
                      streamer,
                      renderedTokens,
                      currentTokens,
                      scanStart,
                      scanEnd,
                    );

                  if (tokensToWrite.length > 0) {
                    const updateSuccess = await this.updateDocumentWithTokens(
                      streamer,
                      tokensToWrite,
                    );
                    if (!updateSuccess) {
                      log("Token update failed, canceling streaming entirely");
                      streamer.isActive = false;
                      break;
                    }
                  }

                  if (strayMarker) {
                    // The model asked to wait for results it never requested. There
                    // is nothing to execute, so end the turn and let the correction
                    // below tell it what went wrong.
                    strayWaitMarker = true;
                    break;
                  }
                } catch (error) {
                  const message =
                    error instanceof Error ? error.message : String(error);
                  log(`Error updating document with tokens: ${message}`);
                  // Show error notification to the user
                  vscode.window.showErrorMessage(
                    `Failed to update document with stream content: ${message}`,
                  );
                  // Cancel the streamer on any error
                  streamer.isActive = false;
                  break;
                }
              }
            } else {
              log("Received empty tokens array, skipping update");
            }
          }

          // Text held back as a possible end-of-batch marker that the stream never
          // completed into one is ordinary assistant text, so write it out rather
          // than dropping the last few characters of the turn.
          if (
            streamer.pendingText &&
            streamer.isActive &&
            !updateFailed &&
            !cancelledExternally
          ) {
            const flushed = streamer.pendingText;
            const flushedThinking = streamer.pendingIsThinking === true;
            streamer.pendingText = "";
            streamer.pendingIsThinking = false;
            log(
              `Flushing ${flushed.length} held-back chars that never became a marker`,
            );
            const flushTokens = this.renderTokens(streamer, [
              flushedThinking ? encodeThinkingToken(flushed) : flushed,
            ]);
            if (flushTokens.length > 0) {
              updateFailed = !(await this.updateDocumentWithTokens(
                streamer,
                flushTokens,
              ));
            }
          }

          updateChatHistoryUsage(streamer.historyFilePath || "", this.getLastUsage());
          log(
            `Stream completed successfully, processed ${tokenCount} tokens total, provider: ${this.provider}${bufferingMode ? " (buffered tool calls)" : ""}${endedOnWaitMarker ? ", ended on end-of-batch marker" : ""}`,
          );

          // Parallel tool calls: a single tool_execute block is added after the whole
          // sequence of tool calls has been written to the assistant block. The
          // document listener then executes them one at a time, adding another
          // tool_execute block after each result until all of them are done.
          if (
            bufferingMode &&
            !toolExecuteInserted &&
            !updateFailed &&
            !cancelledExternally
          ) {
            if (bufferText.trim().length > 0) {
              log(
                `Discarding ${bufferText.length} buffered chars that were not part of a tool call`,
              );
            }
            await this.insertToolExecuteBlockAfterToolCalls(streamer);
            toolExecuteInserted = true;
          } else if (
            strayWaitMarker &&
            !updateFailed &&
            !cancelledExternally &&
            streamer.isActive
          ) {
            // The model ended a batch that never existed. Nothing was executed, so
            // ask it to retry rather than leaving the turn hanging on results that
            // are never coming.
            await this.appendStrayWaitMarkerCorrection(streamer);
            correctionInserted = true;
          } else if (
            !bufferingMode &&
            !updateFailed &&
            !cancelledExternally &&
            streamer.isActive &&
            streamer.tokens.length > 0 &&
            stripThinkingSections(streamer.tokens.join("")).includes(
              CMD_NAMESPACE_PREFIX,
            )
          ) {
            // The turn ended naturally without a single complete tool call, yet the
            // assistant text mentions the cmd namespace: it tried to call a tool and
            // got the format wrong. Append a correction user turn together with an
            // empty assistant block, so the document change resumes streaming and the
            // model can retry. Only reached on natural exit, never on cancellation or
            // failure.
            await this.appendMalformedToolCorrection(streamer);
            correctionInserted = true;
          }
          
          // Capture success state immediately to avoid race conditions
          streamCompletedSuccessfully = true;
          shouldAutoSaveOnCompletion = getAutoSaveAfterStreaming() && 
                                      streamer.tokens.length > 0 && 
                                      streamer.isActive && 
                                      !streamer.isHandlingToolCall;
          
          log(`Auto-save decision captured: ${shouldAutoSaveOnCompletion} (tokens: ${streamer.tokens.length}, active: ${streamer.isActive}, toolCall: ${streamer.isHandlingToolCall})`);

          // Log information about completed stream
          if (tokenCount < 100) {
            log(`Note: Low token count (${tokenCount}) for completed stream`);
          }
        } catch (error) {
          // Check if this is a server error or rate limit error that we should retry
          if (this.isServerError(error)) {
            // Increment retry attempt before checking limits
            retryAttempt++;
            log(`Server error encountered, incrementing retry attempt to ${retryAttempt} of ${maxRetries} max`);
            
            if (retryAttempt < maxRetries && streamer.isActive) {
              const backoffDelay = Math.min(
                1000 * Math.pow(2, retryAttempt),
                32000,
              );
              
              // Determine if this is a rate limit error
              const isRateLimit = error instanceof Error && 
                (error.message.includes("429") || 
                 error.message.includes("Too Many Requests") || 
                 error.message.includes("rate limit"));
              
              // Log with appropriate error type
              log(
                `${isRateLimit ? "Rate limit" : "Server"} error: ${error}. Retrying in ${backoffDelay}ms (attempt ${retryAttempt}/${maxRetries})`,
              );
              
              // Show different messages based on error type
              const message = `${isRateLimit ? "Rate limit reached" : "Server error"}. Retrying in ${backoffDelay / 1000} seconds...`;
              vscode.window.showInformationMessage(
                message + " (Click 'Cancel Streaming' to abort)",
              );
              
              // Simpler implementation for backoff with better cancellation handling
              let isCancelled = false;
              const checkIntervalId = setInterval(() => {
                if (!streamer.isActive) {
                  isCancelled = true;
                }
              }, 100);
              
              try {
                log(`Starting backoff wait for ${backoffDelay}ms at ${new Date().toISOString()}`);
                // Wait for the backoff delay, but allow for early cancellation
                const startTime = Date.now();
                while (!isCancelled && (Date.now() - startTime) < backoffDelay) {
                  // Wait in small chunks to allow for more responsive cancellation
                  await new Promise(resolve => setTimeout(resolve, 100));
                }
                log(`Completed backoff wait at ${new Date().toISOString()}, waited for ${Date.now() - startTime}ms, cancelled=${isCancelled}`);
              } finally {
                // Always clean up the interval
                clearInterval(checkIntervalId);
              }
              
              // Check if streaming was cancelled during the timeout
              if (!streamer.isActive) {
                log("Streaming was cancelled during retry backoff, aborting retry attempts");
                break; // Exit the retry loop
              }
              
              log(`Retry attempt ${retryAttempt} of ${maxRetries} starting now after ${backoffDelay}ms backoff`);
              continue; // Try again with backoff
            } else {
              // Handle max retries reached or streamer no longer active
              if (retryAttempt >= maxRetries) {
                // We've reached or exceeded the maximum number of retries
                log(`Maximum retry attempts (${maxRetries}) reached, giving up`);
                vscode.window.showErrorMessage(
                  `Reached maximum retry attempts (${maxRetries}). Unable to connect to LLM service.`
                );
              } else {
                log("Streaming is no longer active, aborting retry attempts");
              }
              break; // Exit the retry loop
            }
          }

          // Check if it's a max tokens error
          if (this.isMaxTokensError(error) && streamer.isActive) {
            // Increment the token retry counter
            tokenRetryAttempt++;
            
            // Check if we've reached the maximum token retries
            if (tokenRetryAttempt >= maxTokenRetries) {
              log(
                `🛑 Max token retry limit (${maxTokenRetries}) reached. Stopping stream.`,
              );
              vscode.window.showErrorMessage(
                `Maximum token retry limit (${maxTokenRetries}) reached. Unable to complete response.`
              );
              maxTokensReached = false; // Force cleanup in finally block
              streamer.isActive = false;
              break;
            }
            
            maxTokensReached = true;
            log(
              `🚨 Max tokens reached: ${error}. Will restart stream automatically (token retry ${tokenRetryAttempt}/${maxTokenRetries}).`,
            );

            // For debugging purposes, log additional info about the current state
            log(
              `Current streamer state: tokens=${streamer.tokens.length}, isActive=${streamer.isActive}`,
            );

            // Show notification to user
            vscode.window.showInformationMessage(
              `Maximum token limit reached. Restarting stream automatically (retry ${tokenRetryAttempt}/${maxTokenRetries})... (Click 'Cancel Streaming' to abort)`,
            );
            
            // Check if streaming was cancelled while showing the notification
            if (!streamer.isActive) {
              log("Streaming was cancelled before max tokens restart, aborting");
              break; // Exit the retry loop
            }

            // Create an updated messages array that includes the current partial assistant response
            const updatedMessages = [...messages];

            // Only add the partial response if we have generated tokens
            if (streamer.tokens.length > 0) {
              const partialResponse = streamer.tokens.join("");
              log(
                `Adding partial assistant response to context: ${partialResponse.substring(0, 100)}${partialResponse.length > 100 ? "..." : ""}`,
              );

              // Parse the partial response so thinking sections become thinking
              // blocks instead of leaking their "## %%" markers into the API
              const partialContent = parseAssistantContent(
                partialResponse,
                this.document,
              );

              // Check if the last message is from the assistant (it should be a continuation)
              if (
                updatedMessages.length > 0 &&
                updatedMessages[updatedMessages.length - 1].role === "assistant"
              ) {
                log("Last message is from assistant, appending to it");
                updatedMessages[updatedMessages.length - 1] = {
                  role: "assistant",
                  content: [
                    ...updatedMessages[updatedMessages.length - 1].content,
                    ...partialContent,
                  ],
                };
              } else {
                // Add a new assistant message with the partial response
                log("Adding new assistant message with partial response");
                updatedMessages.push({
                  role: "assistant",
                  content: partialContent,
                });
              }

              log(`Updated context with ${updatedMessages.length} messages`);
            } else {
              log("No tokens generated yet, using original messages");
            }

            // Add a small delay before restarting to ensure clean state
            await new Promise((resolve) => setTimeout(resolve, 100));

            // Re-call the same method to restart the stream with updated messages,
            // but only if streaming is still active
            if (streamer.isActive) {
              try {
                log(
                  `🔄 RESTARTING STREAM after max tokens error with updated context (server retry: ${retryAttempt}, token retry: ${tokenRetryAttempt}/${maxTokenRetries})`,
                );
                await this.streamResponse(
                  updatedMessages,
                  streamer,
                  systemPrompt,
                  retryAttempt, // Pass the current retry count to maintain it across calls
                  tokenRetryAttempt, // Pass the token retry count
                  fileConfig // Pass the file configuration
                );
                return; // If successful, exit this function
              } catch (retryError) {
                log(`❌ Error restarting stream after max tokens: ${retryError}`);
                // Fall through to general error handling
              }
            } else {
              log("Streaming cancelled during token handling, aborting restart");
            }
          }

          // For any other errors, rethrow to be caught by the main catch block
          throw error;
        }

        // If we made it here, we have a successful stream connection
        break;
      }

      // Continue with normal processing...
      log("Stream connection established");

      // ... (rest of the original streamResponse function goes here)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // Don't log or show errors if this was due to max tokens (we already handled that)
      if (!maxTokensReached && !this.isMaxTokensError(error)) {
        log(`Streaming error: ${message}`);
        console.error("Streaming error:", error);
        vscode.window.showErrorMessage(`chat.md streaming error: ${message}`);
      } else if (this.isMaxTokensError(error)) {
        // Just log it without showing error to user
        log(`Max tokens error being handled automatically: ${message}`);
        maxTokensReached = true; // Ensure we mark this for proper handling
      }
    } finally {
      // Only mark as inactive if not interrupted due to max tokens
      if (!maxTokensReached) {
        log(
          `Streaming finished (${maxTokensReached ? "max tokens reached" : "normal completion"}), marking streamer as inactive`,
        );
        
        // Add a new user block after the assistant response completes successfully
        // But only if tokens were successfully added to document (check tokens length and streamer state)
        let userBlockAdded = false;
        try {
          // Only add user block if:
          // 1. The streaming finished naturally (not due to a tool call)
          // 2. Tokens were actually written successfully to the document (non-zero tokens)
          // 3. The streamer wasn't cancelled or failed due to other errors
          if (correctionInserted) {
            log('Not adding user block since a tool call correction turn was appended');
            userBlockAdded = true;
          } else if (!streamer.isHandlingToolCall && streamer.tokens.length > 0 && streamer.isActive) {
            log('Adding new user block after completed assistant response');
            await this.appendNewUserBlock(streamer);
            userBlockAdded = true;
          } else if (streamer.isHandlingToolCall) {
            log('Not adding user block since streaming completed due to tool call');
          } else if (streamer.tokens.length === 0) {
            log('Not adding user block since no tokens were written to document');
          } else if (!streamer.isActive) {
            log('Not adding user block since streaming was cancelled or failed');
          }
        } catch (error) {
          log(`Error adding new user block: ${error}`);
        }
        
        // Auto-save AFTER user block is added (correct order)
        try {
          if (shouldAutoSaveOnCompletion) {
            log(`Auto-saving document after user block added (userBlockAdded: ${userBlockAdded})`);
            
            // Brief delay to ensure user block addition is processed by VS Code
            await new Promise(resolve => setTimeout(resolve, 100));
            
            log(`Document state before save: isDirty=${this.document.isDirty}, version=${this.document.version}`);
            
            const saved = await this.document.save();
            
            log(`Auto-save result: ${saved}, final isDirty=${this.document.isDirty}`);
            
            if (saved && !this.document.isDirty) {
              log("Document auto-saved successfully");
            } else if (saved && this.document.isDirty) {
              log("Document save returned true but document is still dirty - this may indicate a problem");
            } else {
              log("Document auto-save failed - save() returned false");
            }
          } else if (streamCompletedSuccessfully) {
            log("Stream completed successfully but auto-save was not needed (captured at completion time)");
          } else {
            log("Auto-save skipped - stream did not complete successfully or conditions not met");
          }
        } catch (error) {
          log(`Error during auto-save: ${error}`);
          // Don't show error to user as auto-save is a convenience feature
        }
        
        streamer.isActive = false;
        
        // Only hide streaming status if we're NOT handling a tool call
        if (!streamer.isHandlingToolCall) {
          log(`Streaming completed normally, restoring status to idle`);
          requestStatusBarUpdate(this.document.uri.fsPath, "streaming finished with error");
        } else {
          log(`Streaming completed due to tool call detection, keeping 'executing tool' status visible`);
        }
      } else {
        log(
          `Stream finished due to max tokens, keeping streamer active for restart`,
        );
      }
    }
  }

  /**
   * Updates document with new tokens idempotently
   * Follows the pattern:
   * 1. Save history of tokens in streamer
   * 2. Search for past text in last assistant block
   * 3. If found, append new tokens; if not found, abort streamer
   */
  /**
   * Find the start position for the current block
   */
  private findBlockStartPosition(
    text: string,
    streamer: StreamerState,
  ): number {
    // Get all assistant blocks in the document
    const assistantMarkers = findAllAssistantBlocks(text);

    if (assistantMarkers.length === 0) {
      log("No assistant blocks found in document");
      return -1;
    }

    const isFirstStreamingEvent = streamer.tokens.length === 0;

    if (isFirstStreamingEvent) {
      // For first streaming event, find first empty assistant block
      for (let i = 0; i < assistantMarkers.length; i++) {
        const marker = assistantMarkers[i];
        const nextMarkerStart =
          i < assistantMarkers.length - 1
            ? assistantMarkers[i + 1].markerStart
            : text.length;

        // Check if this block is empty
        const content = text
          .substring(marker.contentStart, nextMarkerStart)
          .trim();

        if (content.length === 0) {
          log(
            `First streaming event: using first empty assistant block at position ${marker.contentStart}`,
          );
          return marker.contentStart;
        }
      }

      log("No empty assistant blocks found for first streaming event");
      return -1;
    } else {
      // For subsequent streaming events, use the last assistant block
      const lastMarker = assistantMarkers[assistantMarkers.length - 1];
      log(
        `Subsequent streaming event: using last assistant block at position ${lastMarker.contentStart}`,
      );
      return lastMarker.contentStart;
    }
  }

  // This function has been replaced with the one at the beginning of the class

  /**
   * Tells the model how to write a tool call, in the exact shape the parser
   * accepts: qualified tags, no fences, closing tag on its own line, and the
   * end-of-batch marker after the last call.
   *
   * Kept on a single line so the description itself can never match a real tool
   * call, and assembled from the tag constants for the same reason.
   */
  private describeToolCallFormat(): string {
    return (
      "Use the exact format: " +
      CMD_TOOL_CALL_OPEN_TAG +
      " on its own line, then " +
      CMD_TOOL_NAME_TAGS +
      ", then one " +
      CMD_PARAM_TAGS +
      " per parameter, then " +
      CMD_TOOL_CALL_CLOSE_TAG +
      " on its own line, then " +
      WAIT_TOOL_RESULT_TAG +
      " once after the last call of the batch. No triple-backtick fences."
    );
  }

  /**
   * Appends a user turn carrying `message` plus an empty assistant block, so the
   * resulting document change resumes streaming and the model can retry.
   */
  private async appendCorrectionTurn(
    streamer: StreamerState,
    message: string,
  ): Promise<void> {
    await this.lock.acquire();
    try {
      const text = this.document.getText();
      const blocks = findAllAssistantBlocks(text);
      if (blocks.length === 0) {
        log("No assistant blocks found, cannot add tool call correction");
        return;
      }

      const block = blocks[blocks.length - 1];
      const offset = block.contentStart + streamer.tokens.join("").length;

      const correction =
        blockMarkerPrefix(text.substring(0, offset)) +
        "# %% user\n" +
        message +
        "\n\n# %% assistant\n";

      // This streamer has to be marked done BEFORE the edit is applied. The edit
      // fires a document change whose handler calls startStreaming, and that has a
      // pre-lock guard which returns immediately if any streamer is still active
      // instead of queueing on the lock. Marking it afterwards means the retry turn
      // is silently never started.
      streamer.isActive = false;

      const edit = new vscode.WorkspaceEdit();
      edit.insert(this.document.uri, this.document.positionAt(offset), correction);
      const applied = await vscode.workspace.applyEdit(edit);

      if (!applied) {
        log("Failed to append tool call correction turn");
        return;
      }

      log("Appended tool call correction turn, streaming will resume");
      requestStatusBarUpdate(this.document.uri.fsPath, "streaming finished");

      try {
        if (getAutoSaveAfterStreaming()) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          await this.document.save();
        }
      } catch (error) {
        log(`Error during auto-save after tool call correction: ${error}`);
      }
    } finally {
      this.lock.release();
    }
  }

  /**
   * The turn mentioned the cmd namespace but produced no valid tool call, so it
   * tried to call a tool and got the format wrong. Guidance a model could follow
   * into another rejected call would just repeat this correction, so the message
   * spells the format out instead.
   */
  private async appendMalformedToolCorrection(
    streamer: StreamerState,
  ): Promise<void> {
    await this.appendCorrectionTurn(
      streamer,
      "That response used the " +
        CMD_NAMESPACE_PREFIX +
        " namespace but contained no valid tool call. " +
        this.describeToolCallFormat(),
    );
  }

  /**
   * The turn ended with the end-of-batch marker but no valid tool call, so there
   * are no results coming. Say so plainly, since a model that waits for results
   * it never requested would otherwise just wait again.
   */
  private async appendStrayWaitMarkerCorrection(
    streamer: StreamerState,
  ): Promise<void> {
    await this.appendCorrectionTurn(
      streamer,
      "That response ended with " +
        WAIT_TOOL_RESULT_TAG +
        " but contained no valid tool call, so nothing ran and there are no results. " +
        this.describeToolCallFormat() +
        " If no tool is needed, answer directly and leave the marker out.",
    );
  }

  private async appendNewUserBlock(streamer: StreamerState): Promise<void> {
    await this.lock.acquire();
    
    try {
      const text = this.document.getText();
      const tokensSoFar = streamer.tokens.join("");
      
      // Find the last assistant block
      const assistantMarkers = findAllAssistantBlocks(text);
      
      if (assistantMarkers.length === 0) {
        log('No assistant blocks found, cannot add user block');
        return;
      }
      
      // Get the last assistant block
      const lastMarker = assistantMarkers[assistantMarkers.length - 1];
      
      // Calculate position to insert the new user block
      const insertOffset = lastMarker.contentStart + tokensSoFar.length;
      const insertPosition = this.document.positionAt(insertOffset);
      
      // Create the edit to insert the new user block
      const textToInsert = `${blockMarkerPrefix(
        text.substring(0, insertOffset),
      )}# %% user\n`;
      const edit = new vscode.WorkspaceEdit();
      edit.insert(this.document.uri, insertPosition, textToInsert);
      
      // Apply the edit
      const applied = await vscode.workspace.applyEdit(edit);
      
      if (applied) {
        log('Successfully added new user block after assistant response');
      } else {
        log('Failed to add new user block after assistant response');
      }
    } catch (error) {
      log(`Error appending user block: ${error}`);
    } finally {
      this.lock.release();
    }
  }

  /**
   * Updates document with new tokens idempotently.
   * Returns true if tokens were successfully added to the document.
   * Returns false if tokens couldn't be added (document changed, no matching assistant block found, etc.)
   */
  private async updateDocumentWithTokens(
    streamer: StreamerState,
    newTokens: string[],
  ): Promise<boolean> {
    if (newTokens.length === 0) {
      log("No tokens to update");
      return true; // Consider empty tokens a successful update
    }

    log(
      `STREAMER DEBUG: Attempting to update with ${newTokens.length} tokens: "${newTokens.join("")}"`,
    );
    await this.lock.acquire();

    try {
      const text = this.document.getText();
      const tokensSoFar = streamer.tokens.join("");
      const isFirstStreamingEvent = streamer.tokens.length === 0;

      log(
        `Looking for insertion point for ${newTokens.length} new tokens: "${newTokens.join("")}"`,
      );
      log(`Is first streaming event: ${isFirstStreamingEvent}`);

      // Find appropriate assistant block for streaming
      let targetAssistantIdx = -1;
      let blockStart = -1;
      let isEmptyBlock = true;

      // Get all assistant blocks in the document
      const assistantMarkers = findAllAssistantBlocks(text);
      log(`Found ${assistantMarkers.length} assistant blocks in document`);

      if (isFirstStreamingEvent) {
        // For the first streaming event, find the first empty assistant block
        log(`First streaming event: looking for empty assistant blocks`);
        let foundEmptyBlock = false;

        for (let i = 0; i < assistantMarkers.length; i++) {
          const marker = assistantMarkers[i];
          const nextMarkerStart =
            i < assistantMarkers.length - 1
              ? assistantMarkers[i + 1].markerStart
              : text.length;

          // Check if this block is empty
          const content = text
            .substring(marker.contentStart, nextMarkerStart)
            .trim();

          if (content.length === 0) {
            // Found an empty block
            targetAssistantIdx = marker.markerStart;
            blockStart = marker.contentStart;
            isEmptyBlock = true;
            foundEmptyBlock = true;
            log(
              `Found empty assistant block at position ${targetAssistantIdx}, will use it for first streaming event`,
            );
            break; // Use the first empty block we find
          }
        }

        if (!foundEmptyBlock) {
          log(
            `No empty assistant blocks found, canceling streaming for first event`,
          );
          streamer.isActive = false;
          return false;
        }
      } else {
        // For subsequent streaming events, use the last assistant block only
        if (assistantMarkers.length > 0) {
          const i = assistantMarkers.length - 1;
          const marker = assistantMarkers[i];

          // Check content of the last block
          const nextMarkerStart = text.length;
          const content = text
            .substring(marker.contentStart, nextMarkerStart)
            .trim();

          targetAssistantIdx = marker.markerStart;
          blockStart = marker.contentStart;
          isEmptyBlock = content.length === 0;
          log(
            `Subsequent streaming event: using last assistant block at position ${targetAssistantIdx}`,
          );
          log(`Last block is ${isEmptyBlock ? "empty" : "non-empty"}`);
        }
      }

      if (targetAssistantIdx === -1 || blockStart === -1) {
        log("No suitable assistant block found in document, stopping streamer");
        streamer.isActive = false;
        return false;
      }
      log(
        `Document text at block start (20 chars): "${text.substring(blockStart, blockStart + 20)}"`,
      );

      // Check if our tokens match what's already in the document
      // This is the key idempotent check - we need to find our previous tokens
      const textAfterBlock = text.substring(blockStart);
      if (!textAfterBlock.startsWith(tokensSoFar)) {
        log(
          `STREAMER ERROR: Tokens don't match what's in the document, stopping streamer`,
        );
        log(
          `Expected: "${tokensSoFar.substring(0, 20)}${tokensSoFar.length > 20 ? "..." : ""}"`,
        );
        log(
          `Found: "${textAfterBlock.substring(0, 20)}${textAfterBlock.length > 20 ? "..." : ""}"`,
        );

        // Additional troubleshooting logs
        log(`STREAMER ERROR DETAILS:`);
        log(`- Target assistant block position: ${targetAssistantIdx}`);
        log(`- Block start position: ${blockStart}`);
        log(`- Document length: ${text.length}`);
        log(`- tokensSoFar length: ${tokensSoFar.length}`);
        log(
          `- Last 3 token chunks: ${JSON.stringify(streamer.tokens.slice(-3).map((t) => t.substring(0, 10) + (t.length > 10 ? "..." : "")))}`,
        );

        // Do not attempt to find tokens elsewhere - simply stop the streamer
        log(
          `STREAMER CANCELED: Stopping streamer due to token mismatch in target assistant block`,
        );

        streamer.isActive = false;
        return false;
      }

      // Calculate the insert position at the end of our existing tokens
      const insertPosition = this.document.positionAt(
        blockStart + tokensSoFar.length,
      );
      log(
        `Inserting at position: line ${insertPosition.line}, character ${insertPosition.character}`,
      );

      // Check if we need to add a newline before the first token
      let textToInsert = newTokens.join("");
      if (isFirstStreamingEvent && tokensSoFar.length === 0) {
        // Check if there's no newline between the heading and where we're about to insert
        // blockStart points to where content should start, check the character before it
        if (blockStart > 0 && text[blockStart - 1] !== '\n') {
          log("No newline after assistant heading, adding one before first token");
          textToInsert = '\n' + textToInsert;
        }
      }

      // Insert text using a workspace edit as per original design
      log(`Inserting text: "${textToInsert}"`);

      const edit = new vscode.WorkspaceEdit();
      edit.insert(this.document.uri, insertPosition, textToInsert);

      // Log before applying edit
      log(
        `STREAMER ACTION: About to apply edit at document version: ${this.document.version}`,
      );
      const applied = await vscode.workspace.applyEdit(edit);
      log(`STREAMER RESULT: Edit applied: ${applied}`);

      if (applied) {
        // Auto-scrolling disabled - users can scroll manually as needed
      } else {
        log(`STREAMER ERROR: Failed to apply edit, details:`);
        log(`- Document URI: ${this.document.uri.toString()}`);
        log(
          `- Insert position: Line ${insertPosition.line}, Character ${insertPosition.character}`,
        );
        log(`- Document version: ${this.document.version}`);
        log(
          `- Document read-only: ${this.document.isUntitled ? "No" : "Unknown"}`,
        );
      }

      // If edit failed, we log the error and immediately abort
      if (!applied) {
        log("WorkspaceEdit failed, stopping streamer entirely");
        streamer.isActive = false;
        return false;
      }

      // Update tokens history
      streamer.tokens.push(...newTokens);
      log(
        `Updated token history, now have ${streamer.tokens.length} tokens total`,
      );
      return true; // Update successful
    } catch (error) {
      log(`Error updating document: ${error}`);
      console.error("Error updating document:", error);
      streamer.isActive = false;
      return false; // Update failed due to error
    } finally {
      this.lock.release();
    }
  }
}
