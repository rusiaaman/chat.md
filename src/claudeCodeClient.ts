import {
  Options,
  Query,
  SDKMessage,
  query,
} from "@anthropic-ai/claude-agent-sdk";
import * as path from "path";
import * as vscode from "vscode";
import { buildAgentPrompt } from "./agentContext";
import { getMaxThinkingTokens, getReasoningEffort } from "./config";
import { encodeAgentToolEvent } from "./nativeTools";
import { MessageParam, ChatHistoryUsage } from "./types";
import { chatmdAgentSection, findChatmdCommand } from "./utils/chatmdCli";
import {
  activeApiConfig,
  claudeMcpServers,
  subscriptionEnvironment,
} from "./sdkConfig";
import { encodeThinkingToken } from "./utils/thinkingBlocks";
import { sdkMcpBridge } from "./sdkMcpBridge";
import { executableOnPath } from "./utils/executable";

function jsonText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function mcpName(
  name: string,
  serverNames: readonly string[],
): string | undefined {
  for (const serverName of [...serverNames].sort(
    (left, right) => right.length - left.length,
  )) {
    const prefix = `mcp__${serverName}__`;
    if (name.startsWith(prefix)) {
      return `${serverName}.${name.substring(prefix.length)}`;
    }
  }
  return undefined;
}

export class ClaudeCodeClient {
  private activeQuery?: Query;
  private controller?: AbortController;
  private lastUsage: ChatHistoryUsage | null = null;

  public cancel(): void {
    this.controller?.abort();
    const active = this.activeQuery;
    if (active) {
      void active.interrupt().catch(() => undefined);
      active.close();
    }
  }

  public getLastUsage(): ChatHistoryUsage | null {
    return this.lastUsage;
  }

  public async *streamCompletion(
    messages: readonly MessageParam[],
    document: vscode.TextDocument,
    customSystemPrompt: string,
    modelName: string | undefined,
    configName: string | undefined,
    fileConfig: Record<string, any> | undefined,
  ): AsyncGenerator<string[], void, unknown> {
    this.lastUsage = null;
    const profile = activeApiConfig(configName);
    const raw = { ...(profile.claudeCode ?? {}) } as Record<string, unknown>;
    const configuredModel =
      typeof raw.model === "string" ? raw.model : undefined;
    const configuredCwd = typeof raw.cwd === "string" ? raw.cwd : undefined;
    const configuredTokens =
      typeof raw.maxThinkingTokens === "number"
        ? raw.maxThinkingTokens
        : undefined;
    const configuredEffort =
      typeof raw.effort === "string"
        ? (raw.effort as Options["effort"])
        : undefined;
    const configuredThinking = raw.thinking as Options["thinking"] | undefined;
    const configuredPermissionMode =
      typeof raw.permissionMode === "string"
        ? (raw.permissionMode as Options["permissionMode"])
        : undefined;
    const configuredCliPath =
      typeof raw.cliPath === "string"
        ? raw.cliPath
        : typeof raw.pathToClaudeCodeExecutable === "string"
        ? raw.pathToClaudeCodeExecutable
        : undefined;
    const claudePath = configuredCliPath ?? executableOnPath("claude");
    if (!claudePath) {
      throw new Error(
        "Claude Code CLI was not found on PATH. Install and log in to Claude Code, " +
          "or set chatmd.apiConfigs.<name>.claudeCode.cliPath.",
      );
    }
    for (const reserved of [
      "abortController",
      "continue",
      "resume",
      "forkSession",
      "mcpServers",
      "includePartialMessages",
      "cwd",
      "model",
      "maxThinkingTokens",
      "effort",
      "env",
      "persistSession",
      "sessionStore",
      "thinking",
      "cliPath",
      "pathToClaudeCodeExecutable",
      "permissionMode",
      "strictMcpConfig",
    ]) {
      delete raw[reserved];
    }
    const controller = new AbortController();
    this.controller = controller;
    const bridge = await sdkMcpBridge.acquire(document, controller.signal);
    const reasoning = getReasoningEffort(configName, fileConfig);
    const configuredAllowedTools = Array.isArray(raw.allowedTools)
      ? raw.allowedTools.filter(
          (tool): tool is string => typeof tool === "string",
        )
      : [];
    const options: Options = {
      ...(raw as Options),
      abortController: controller,
      continue: false,
      forkSession: false,
      persistSession: false,
      includePartialMessages: true,
      cwd: configuredCwd ?? path.dirname(document.uri.fsPath),
      model: configuredModel ?? modelName,
      maxThinkingTokens:
        configuredTokens ?? getMaxThinkingTokens(configName, fileConfig),
      effort:
        configuredEffort ??
        (reasoning && reasoning !== "none" && reasoning !== "minimal"
          ? reasoning
          : reasoning === "minimal"
          ? "low"
          : undefined),
      thinking:
        configuredThinking ??
        (reasoning === "none" ? { type: "disabled" } : undefined),
      pathToClaudeCodeExecutable: claudePath,
      permissionMode: configuredPermissionMode ?? "bypassPermissions",
      allowDangerouslySkipPermissions:
        (configuredPermissionMode ?? "bypassPermissions") ===
        "bypassPermissions",
      strictMcpConfig: true,
      env: subscriptionEnvironment("claude-code", profile.claudeCode?.env),
      mcpServers: claudeMcpServers(bridge.urls) as Options["mcpServers"],
      allowedTools: [
        ...configuredAllowedTools,
        ...bridge.claudeAllowedTools.filter(
          (tool) => !configuredAllowedTools.includes(tool),
        ),
      ],
    };
    const prompt = buildAgentPrompt(
      messages,
      document.uri.fsPath,
      "VS Code Settings: chatmd.apiConfigs and chatmd.mcpServers",
      customSystemPrompt,
      chatmdAgentSection(findChatmdCommand()),
    );
    const running = query({ prompt, options });
    this.activeQuery = running;
    const emittedTools = new Set<string>();
    const emittedResults = new Set<string>();
    const toolNames = new Map<string, { name: string; serverTool: boolean }>();
    const serverNames = Object.keys(bridge.urls);
    let sawPartialText = false;
    let sawPartialThinking = false;

    try {
      for await (const message of running) {
        const item = message as SDKMessage;
        if (item.type === "stream_event") {
          const event = item.event as any;
          if (event.type !== "content_block_delta") continue;
          if (event.delta?.type === "text_delta" && event.delta.text) {
            sawPartialText = true;
            yield [event.delta.text];
          } else if (
            event.delta?.type === "thinking_delta" &&
            event.delta.thinking
          ) {
            sawPartialThinking = true;
            yield [encodeThinkingToken(event.delta.thinking)];
          }
          continue;
        }

        if (item.type === "assistant") {
          for (const block of item.message.content as any[]) {
            if (block.type === "text" && block.text && !sawPartialText) {
              yield [block.text];
            } else if (
              block.type === "thinking" &&
              block.thinking &&
              !sawPartialThinking
            ) {
              yield [encodeThinkingToken(block.thinking)];
            } else if (
              (block.type === "tool_use" || block.type === "server_tool_use") &&
              !emittedTools.has(block.id)
            ) {
              emittedTools.add(block.id);
              const nativeName = mcpName(block.name, serverNames);
              const name = nativeName ?? block.name;
              const serverTool = nativeName === undefined;
              toolNames.set(block.id, { name, serverTool });
              yield [
                encodeAgentToolEvent({
                  type: "tool_use",
                  id: block.id,
                  name,
                  input: block.input ?? {},
                  serverTool,
                }),
              ];
            } else if (
              (block.type === "tool_result" ||
                block.type === "server_tool_result") &&
              !emittedResults.has(block.tool_use_id)
            ) {
              emittedResults.add(block.tool_use_id);
              const identity = toolNames.get(block.tool_use_id) ?? {
                name: "tool",
                serverTool: true,
              };
              yield [
                encodeAgentToolEvent({
                  type: "tool_result",
                  toolUseId: block.tool_use_id,
                  name: identity.name,
                  content: jsonText(block.content),
                  isError: block.is_error === true,
                  serverTool: identity.serverTool,
                }),
              ];
            }
          }
          sawPartialText = false;
          sawPartialThinking = false;
          continue;
        }

        if (item.type === "user" && Array.isArray(item.message.content)) {
          for (const block of item.message.content as any[]) {
            if (block.type !== "tool_result") continue;
            if (emittedResults.has(block.tool_use_id)) continue;
            emittedResults.add(block.tool_use_id);
            const identity = toolNames.get(block.tool_use_id) ?? {
              name: "tool",
              serverTool: true,
            };
            yield [
              encodeAgentToolEvent({
                type: "tool_result",
                toolUseId: block.tool_use_id,
                name: identity.name,
                content: jsonText(item.tool_use_result ?? block.content),
                isError: block.is_error === true,
                serverTool: identity.serverTool,
              }),
            ];
          }
          continue;
        }

        if (item.type === "result") {
          this.lastUsage = {
            inputTokens: item.usage.input_tokens,
            outputTokens: item.usage.output_tokens,
            cacheReadTokens: item.usage.cache_read_input_tokens,
            cacheWriteTokens: item.usage.cache_creation_input_tokens,
          };
          if (item.is_error) {
            const detail =
              "errors" in item ? item.errors.join("; ") : item.result;
            throw new Error(detail || `Claude Code ended with ${item.subtype}`);
          }
        }
      }
    } finally {
      this.activeQuery = undefined;
      this.controller = undefined;
      running.close();
      bridge.release();
    }
  }
}
