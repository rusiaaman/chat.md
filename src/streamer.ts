import * as vscode from "vscode";
import { MessageParam, StreamerState } from "./types";
import { Lock } from "./utils/lock";
import { AnthropicClient } from "./anthropicClient";
import { OpenAIClient } from "./openaiClient";
import { findAssistantBlocks, findAllAssistantBlocks } from "./parser";
import { log, statusManager } from "./extension";
import { generateToolCallingSystemPrompt, isToolAutoExecuteDisabled } from "./config";
import { mcpClientManager } from "./mcpClientManager";
import { appendToChatHistory } from "./utils/fileUtils";
import { parseToolCall } from "./tools/toolCallParser";

/**
 * Service for streaming LLM responses
 */
export class StreamingService {
  private readonly anthropicClient?: AnthropicClient;
  private readonly openaiClient?: OpenAIClient;
  private readonly provider: string;

  constructor(
    apiKey: string,
    private readonly document: vscode.TextDocument,
    private readonly lock: Lock,
  ) {
    try {
      // Import the config functions to ensure they're available
      const { getProvider, getBaseUrl } = require("./config");

      this.provider = getProvider();
      log(`Using LLM provider: ${this.provider}`);

      let baseUrl;
      try {
        baseUrl = getBaseUrl();
      } catch (e) {
        log(`Could not get base URL: ${e}, will use default`);
        baseUrl = undefined;
      }

      if (this.provider === "anthropic") {
        this.anthropicClient = new AnthropicClient(apiKey);
      } else if (this.provider === "openai") {
        this.openaiClient = new OpenAIClient(apiKey, baseUrl);
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
   * Cancels an active streaming response
   * This can be called by external components holding a reference to the streamer
   */
  public cancelStreaming(streamer: StreamerState): void {
    if (streamer) {
      log("Explicitly cancelling active streamer");
      // Set to inactive regardless of current state to ensure cancellation works
      // during retries, waiting periods, or normal streaming
      streamer.isActive = false;
      
      // Immediately hide streaming status
      statusManager.hideStreamingStatus();
      
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
  private checkForCompletedToolCall(text: string): ReturnType<typeof parseToolCall.checkForCompletedToolCall> {
    // Use the imported parseToolCall function to check for completed tool calls
    return parseToolCall.checkForCompletedToolCall(text);
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

  public async streamResponse(
    messages: readonly MessageParam[],
    streamer: StreamerState,
    systemPrompt: string, // Added systemPrompt parameter
  ): Promise<void> {
    // Flag to track if we need to restart due to max tokens
    let maxTokensReached = false;
    // Track retry attempts for server errors
    let retryAttempt = 0;
    const maxRetries = 5;

    try {
      log(
        `streamResponse called for ${messages.length} messages, provider: ${this.provider}`,
      );

      // Start streaming with retry logic for server errors
      while (retryAttempt <= maxRetries) {
        try {
          log(
            `Starting to stream response for ${messages.length} messages${retryAttempt > 0 ? ` (retry ${retryAttempt})` : ""}`,
          );
          statusManager.showStreamingStatus();

          // Import getModelName to make sure it's available
          const { getModelName } = require("./config");

          // Use the provided system prompt
          log(`Using provided system prompt (${systemPrompt.length} chars)`);

          // Start streaming completion based on provider, passing document for file path resolution
          let stream;
          if (this.provider === "anthropic" && this.anthropicClient) {
            stream = await this.anthropicClient.streamCompletion(
              messages,
              this.document,
              systemPrompt,
            );
          } else if (this.provider === "openai" && this.openaiClient) {
            stream = await this.openaiClient.streamCompletion(
              messages,
              this.document,
              systemPrompt,
            );
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

          for await (const tokens of stream) {
            // Check streamer status at the beginning of each token processing
            if (!streamer.isActive) {
              log("Streamer no longer active, stopping stream immediately");
              break;
            }

            if (tokens.length > 0) {
              tokenCount += tokens.length;
              log(`Received ${tokens.length} tokens: "${tokens.join("")}"`);

              // Log received tokens to the chat history file if available
              if (streamer.historyFilePath) {
                appendToChatHistory(streamer.historyFilePath, tokens.join(""));
              }

              // Check if adding these tokens would complete a tool call
              const currentTokens = [...streamer.tokens, ...tokens].join("");
              const toolCallResult =
                this.checkForCompletedToolCall(currentTokens);

              // Check if we have a completed tool call
              if (toolCallResult && typeof toolCallResult !== "boolean" && toolCallResult.isComplete) {
                log(
                  "Detected completed tool call, will truncate at position " +
                    toolCallResult.endIndex,
                );
                
                // Set flag to indicate we're handling a tool call
                streamer.isHandlingToolCall = true;

                try {
                  // Get the end index of the completed tool call
                  const { endIndex } = toolCallResult;
                  const toolName = 'toolName' in toolCallResult ? toolCallResult.toolName : '';
                  
                  // Check if auto-execute is disabled for this tool in this file
                  const isAutoExecuteDisabled = isToolAutoExecuteDisabled(toolName, this.document.uri.fsPath);
                  
                  if (isAutoExecuteDisabled) {
                    log(`Auto-execution is disabled for tool "${toolName}" in this file. Will not add tool_execute block.`);
                  }

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

                  // Create a new array of tokens that only includes content up to the </tool_call> tag
                  const truncatedNewTokens: string[] = [];
                  let currentLength = 0;

                  for (const token of tokens) {
                    if (currentLength >= keepLength) {
                      break; // Stop adding tokens if we've reached the end of the tool call
                    }

                    if (currentLength + token.length <= keepLength) {
                      // Can include the full token
                      truncatedNewTokens.push(token);
                      currentLength += token.length;
                    } else {
                      // Need to truncate this token
                      const partialToken = token.substring(
                        0,
                        keepLength - currentLength,
                      );
                      if (partialToken) {
                        truncatedNewTokens.push(partialToken);
                      }
                      break;
                    }
                  }

                  log(
                    `Truncated tokens from ${tokens.length} to ${truncatedNewTokens.length} to exclude content after </tool_call>`,
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

                  // Only add tool_execute block if auto-execution is not disabled for this tool
                  if (!isAutoExecuteDisabled) {
                    // Add tool_execute block after the last token
                    const text = this.document.getText();
                    const blockStart = this.findBlockStartPosition(
                      text,
                      streamer,
                    );

                    if (blockStart !== -1) {
                      const currentText = streamer.tokens.join("");
                      const insertPosition = this.document.positionAt(
                        blockStart + currentText.length,
                      );

                      // Check for unbalanced fence blocks
                      // Look for opening ``` before <tool_call> but no matching closing ```
                      // Allow for any annotation after the triple backticks
                      const openingFenceMatch =
                        /```(?:[a-zA-Z0-9_\-]*)?(?:\s*\n|\s+)\s*<tool_call>[\s\S]*?\n\s*<\/tool_call>(?!\s*\n\s*```)/s.exec(
                          currentText,
                        );

                      let textToInsert = "";

                      if (openingFenceMatch) {
                        log(
                          "Detected unbalanced fence block - adding closing fence before tool_execute block",
                        );
                        textToInsert = "\n```\n\n# %% tool_execute\n";
                      } else {
                        textToInsert = "\n\n# %% tool_execute\n";
                      }

                      const edit = new vscode.WorkspaceEdit();
                      edit.insert(
                        this.document.uri,
                        insertPosition,
                        textToInsert,
                      );
                      const applied = await vscode.workspace.applyEdit(edit);

                      if (applied) {
                        log(
                          `Successfully inserted ${openingFenceMatch ? "closing fence and " : ""}tool_execute block`,
                        );
                      } else {
                        log(
                          `Failed to insert ${openingFenceMatch ? "closing fence and " : ""}tool_execute block`,
                        );
                      }
                    } else {
                      log("Could not find position to insert tool_execute block");
                    }
                  }

                  // Mark streamer as inactive to stop streaming
                  streamer.isActive = false;
                  break;
                } catch (error) {
                  log(`Error handling tool call: ${error}`);
                  // Continue as normal if handling tool call fails
                }
              } else {
                // Normal token processing
                try {
                  const updateSuccess = await this.updateDocumentWithTokens(
                    streamer,
                    tokens,
                  );
                  if (!updateSuccess) {
                    log("Token update failed, canceling streaming entirely");
                    streamer.isActive = false;
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

          log(
            `Stream completed successfully, processed ${tokenCount} tokens total, provider: ${this.provider}`,
          );

          // Log information about completed stream
          if (tokenCount < 100) {
            log(`Note: Low token count (${tokenCount}) for completed stream`);
          }
        } catch (error) {
          // Check if this is a server error or rate limit error that we should retry
          if (this.isServerError(error)) {
            if (retryAttempt < maxRetries && streamer.isActive) {
              retryAttempt++;
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
              
              // Use a cancellable timeout instead of Promise
              let timeoutCancelled = false;
              const timeoutPromise = new Promise<void>((resolve) => {
                const timeout = setTimeout(() => {
                  if (!timeoutCancelled) {
                    resolve();
                  }
                }, backoffDelay);
                
                // Set up a watcher that checks if streaming was cancelled during wait
                const checkInterval = setInterval(() => {
                  if (!streamer.isActive) {
                    clearTimeout(timeout);
                    clearInterval(checkInterval);
                    timeoutCancelled = true;
                    resolve(); // Resolve immediately to continue execution flow
                  }
                }, 100); // Check every 100ms
                
                // Clean up interval when timeout completes
                timeout.unref(); // Allow Node.js to exit if this is the only active timer
                timeout.ref();   // Ensure the timer runs
                
                // Cleanup function
                return () => {
                  clearTimeout(timeout);
                  clearInterval(checkInterval);
                };
              });
              
              await timeoutPromise;
              
              // Check if streaming was cancelled during the timeout
              if (!streamer.isActive) {
                log("Streaming was cancelled during retry backoff, aborting retry attempts");
                break; // Exit the retry loop
              }
              
              continue; // Try again with backoff
            } else if (!streamer.isActive) {
              log("Streaming is no longer active, aborting retry attempts");
              break; // Exit the retry loop
            }
          }

          // Check if it's a max tokens error
          if (this.isMaxTokensError(error) && streamer.isActive) {
            maxTokensReached = true;
            log(
              `🚨 Max tokens reached: ${error}. Will restart stream automatically.`,
            );

            // For debugging purposes, log additional info about the current state
            log(
              `Current streamer state: tokens=${streamer.tokens.length}, isActive=${streamer.isActive}`,
            );

            // Show notification to user
            vscode.window.showInformationMessage(
              "Maximum token limit reached. Restarting stream automatically... (Click 'Cancel Streaming' to abort)",
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

              // Check if the last message is from the assistant (it should be a continuation)
              if (
                updatedMessages.length > 0 &&
                updatedMessages[updatedMessages.length - 1].role === "assistant"
              ) {
                log("Last message is from assistant, appending to it");

                // Create a new text content item for the existing partial response
                const existingContent =
                  updatedMessages[updatedMessages.length - 1].content;
                const existingText = existingContent
                  .filter((c) => c.type === "text")
                  .map((c) => (c as any).value)
                  .join("\n\n");

                // Create a new content array with the combined text
                const newContent = existingContent.filter(
                  (c) => c.type !== "text",
                );
                newContent.push({
                  type: "text",
                  value: existingText + partialResponse,
                });

                // Replace the content in the last message
                updatedMessages[updatedMessages.length - 1].content =
                  newContent;
              } else {
                // Add a new assistant message with the partial response
                log("Adding new assistant message with partial response");
                updatedMessages.push({
                  role: "assistant",
                  content: [{ type: "text", value: partialResponse }],
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
                  `🔄 RESTARTING STREAM after max tokens error with updated context`,
                );
                await this.streamResponse(
                  updatedMessages,
                  streamer,
                  systemPrompt,
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
        try {
          // Only add user block if the streaming finished naturally (not due to a tool call)
          if (!streamer.isHandlingToolCall) {
            log('Adding new user block after completed assistant response');
            this.appendNewUserBlock(streamer);
          } else {
            log('Not adding user block since streaming completed due to tool call');
          }
        } catch (error) {
          log(`Error adding new user block: ${error}`);
        }
        
        streamer.isActive = false;
        // Hide streaming status when done
        statusManager.hideStreamingStatus();
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

  /**
   * Check if text contains a complete tool call
   * Returns:
   * - false if no complete tool call is found
   * - { isComplete: true, endIndex: number } if a complete tool call is found
   */
  private checkForCompletedToolCall(
    text: string,
  ): boolean | { isComplete: true; endIndex: number } {
    // Match both fenced and non-fenced tool calls
    // 1. Fenced tool call: ```\n<tool_call>...\n</tool_call>\n```
    // 2. Non-fenced tool call: <tool_call>...\n</tool_call>

    // First try to match properly fenced tool calls (with opening and closing fences)
    // Allow for any annotation after the triple backticks like ```tool_code or ```xml
    const properlyFencedToolCallRegex =
      /```(?:[a-zA-Z0-9_\-]*)?(?:\s*\n|\s+)\s*<tool_call>[\s\S]*?\n\s*<\/tool_call>\s*\n\s*```/s;
    const properlyFencedMatch = properlyFencedToolCallRegex.exec(text);

    // Then try to match partially fenced tool calls (with opening fence but missing closing fence)
    // Allow for any annotation after the triple backticks
    const partiallyFencedToolCallRegex =
      /```(?:[a-zA-Z0-9_\-]*)?(?:\s*\n|\s+)\s*<tool_call>[\s\S]*?\n\s*<\/tool_call>(?!\s*\n\s*```)/s;
    const partiallyFencedMatch = partiallyFencedToolCallRegex.exec(text);

    // Then try to match non-fenced tool calls - make pattern consistent with listener.ts
    const nonFencedToolCallRegex =
      /\n\s*<tool_call>[\s\S]*?\n\s*<\/tool_call>/s;
    const nonFencedMatch = nonFencedToolCallRegex.exec(text);

    // Determine which match to use if any
    let toolCallMatch = null;
    let matchType = "none";

    if (properlyFencedMatch && partiallyFencedMatch && nonFencedMatch) {
      // If all three exist, use the one that appears first in the text
      if (
        properlyFencedMatch.index <= partiallyFencedMatch.index &&
        properlyFencedMatch.index <= nonFencedMatch.index
      ) {
        toolCallMatch = properlyFencedMatch;
        matchType = "properly-fenced";
      } else if (
        partiallyFencedMatch.index <= properlyFencedMatch.index &&
        partiallyFencedMatch.index <= nonFencedMatch.index
      ) {
        toolCallMatch = partiallyFencedMatch;
        matchType = "partially-fenced";
      } else {
        toolCallMatch = nonFencedMatch;
        matchType = "non-fenced";
      }
    } else if (properlyFencedMatch && partiallyFencedMatch) {
      // If both fenced types exist, use the one that appears first
      if (properlyFencedMatch.index <= partiallyFencedMatch.index) {
        toolCallMatch = properlyFencedMatch;
        matchType = "properly-fenced";
      } else {
        toolCallMatch = partiallyFencedMatch;
        matchType = "partially-fenced";
      }
    } else if (properlyFencedMatch && nonFencedMatch) {
      // If properly fenced and non-fenced exist, use the one that appears first
      if (properlyFencedMatch.index <= nonFencedMatch.index) {
        toolCallMatch = properlyFencedMatch;
        matchType = "properly-fenced";
      } else {
        toolCallMatch = nonFencedMatch;
        matchType = "non-fenced";
      }
    } else if (partiallyFencedMatch && nonFencedMatch) {
      // If partially fenced and non-fenced exist, use the one that appears first
      if (partiallyFencedMatch.index <= nonFencedMatch.index) {
        toolCallMatch = partiallyFencedMatch;
        matchType = "partially-fenced";
      } else {
        toolCallMatch = nonFencedMatch;
        matchType = "non-fenced";
      }
    } else if (properlyFencedMatch) {
      toolCallMatch = properlyFencedMatch;
      matchType = "properly-fenced";
    } else if (partiallyFencedMatch) {
      toolCallMatch = partiallyFencedMatch;
      matchType = "partially-fenced";
    } else if (nonFencedMatch) {
      toolCallMatch = nonFencedMatch;
      matchType = "non-fenced";
    }

    if (toolCallMatch) {
      // Make sure this is a complete tool call
      const fullMatch = toolCallMatch[0];
      const matchEndIndex = toolCallMatch.index + fullMatch.length;

      // Log the completed tool call
      log(
        `Found completed tool call (${matchType}): "${fullMatch.substring(0, 50)}${fullMatch.length > 50 ? "..." : ""}"`,
      );

      // Check if there's another opening tag after this complete tag
      // Look for both fenced and non-fenced opening patterns
      // Allow for any annotation after the triple backticks
      const nextOpeningFencedRegex =
        /```(?:[a-zA-Z0-9_\-]*)?(?:\s*\n|\s+)\s*<tool_call>/g;
      const nextOpeningNonFencedRegex = /\n\s*<tool_call>/g;

      nextOpeningFencedRegex.lastIndex = matchEndIndex;
      nextOpeningNonFencedRegex.lastIndex = matchEndIndex;

      const nextFencedMatch = nextOpeningFencedRegex.exec(text);
      const nextNonFencedMatch = nextOpeningNonFencedRegex.exec(text);

      let nextOpeningTagIndex = -1;

      if (nextFencedMatch && nextNonFencedMatch) {
        nextOpeningTagIndex = Math.min(
          nextFencedMatch.index,
          nextNonFencedMatch.index,
        );
      } else if (nextFencedMatch) {
        nextOpeningTagIndex = nextFencedMatch.index;
      } else if (nextNonFencedMatch) {
        nextOpeningTagIndex = nextNonFencedMatch.index;
      }

      // Always stop at the first complete tool call, regardless of subsequent content
      log("Found completed tool call - stopping streaming immediately");
      return { isComplete: true, endIndex: matchEndIndex };
    }

    return false;
  }

  /**
   * Appends a new user block after the assistant response has completed
   */
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
      const textToInsert = "\n\n# %% user\n";
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

      // Insert text using a workspace edit as per original design
      log(`Inserting text: "${newTokens.join("")}"`);

      const edit = new vscode.WorkspaceEdit();
      edit.insert(this.document.uri, insertPosition, newTokens.join(""));

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
