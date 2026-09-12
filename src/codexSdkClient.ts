import {
  Codex,
  CodexOptions,
  ThreadEvent,
  ThreadItem,
  ThreadOptions,
  TurnOptions,
} from "@openai/codex-sdk";
import * as path from "path";
import * as vscode from "vscode";
import { buildAgentPrompt } from "./agentContext";
import { isolatedCodexHome } from "./codexHome";
import { getReasoningEffort } from "./config";
import { encodeAgentToolEvent } from "./nativeTools";
import {
  activeApiConfig,
  allowAllCodexMcpTools,
  codexMcpServers,
  subscriptionEnvironment,
} from "./sdkConfig";
import { ChatHistoryUsage, MessageParam } from "./types";
import { chatmdAgentSection, findChatmdCommand } from "./utils/chatmdCli";
import { encodeThinkingToken } from "./utils/thinkingBlocks";
import { sdkMcpBridge } from "./sdkMcpBridge";
import { executableOnPath } from "./utils/executable";

const BUILTIN_TOOL_NAMES: Partial<Record<ThreadItem["type"], string>> = {
  command_execution: "command_execution",
  file_change: "apply_patch",
  web_search: "web_search",
  todo_list: "update_plan",
};

function itemInput(item: ThreadItem): Record<string, unknown> {
  switch (item.type) {
    case "command_execution":
      return { command: item.command };
    case "file_change":
      return { changes: item.changes };
    case "web_search":
      return { query: item.query };
    case "todo_list":
      return { items: item.items };
    default:
      return {};
  }
}

function itemResult(item: ThreadItem): string {
  switch (item.type) {
    case "command_execution":
      return JSON.stringify(
        {
          output: item.aggregated_output,
          exitCode: item.exit_code,
          status: item.status,
        },
        null,
        2,
      );
    case "file_change":
      return JSON.stringify(
        { changes: item.changes, status: item.status },
        null,
        2,
      );
    case "web_search":
      return JSON.stringify({ query: item.query }, null, 2);
    case "todo_list":
      return JSON.stringify({ items: item.items }, null, 2);
    default:
      return "Completed";
  }
}

function appendDelta(
  item: { id: string; text: string },
  emittedLengths: Map<string, number>,
): string {
  const previous = emittedLengths.get(item.id) ?? 0;
  emittedLengths.set(item.id, item.text.length);
  return item.text.substring(previous);
}

function isMcpServerOverride(value: string): boolean {
  return /^\s*mcp_servers(?:\.|=)/.test(value);
}

export class CodexSdkClient {
  private controller?: AbortController;
  private lastUsage: ChatHistoryUsage | null = null;

  public cancel(): void {
    this.controller?.abort();
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
    const configured = profile.codex ?? {};
    const rawOptions = { ...(configured.options ?? {}) } as Record<
      string,
      unknown
    >;
    const configuredCodexPath =
      typeof rawOptions.codexPathOverride === "string"
        ? rawOptions.codexPathOverride
        : undefined;
    const codexPath = configuredCodexPath ?? executableOnPath("codex");
    if (!codexPath) {
      throw new Error(
        "Codex CLI was not found on PATH. Install and run codex login, or set " +
          "chatmd.apiConfigs.<name>.codex.options.codexPathOverride.",
      );
    }
    delete rawOptions.apiKey;
    delete rawOptions.baseUrl;
    const configuredOverrides = Array.isArray(rawOptions.configOverrides)
      ? rawOptions.configOverrides.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    delete rawOptions.configOverrides;
    const rawConfig = rawOptions.config;
    const config =
      rawConfig && typeof rawConfig === "object" && !Array.isArray(rawConfig)
        ? { ...(rawConfig as Record<string, any>) }
        : {};
    delete config.model_provider;
    delete config.model_providers;
    config.forced_login_method = "chatgpt";
    config.approvals_reviewer = config.approvals_reviewer ?? "auto_review";
    const rawThreadValues = { ...(configured.thread ?? {}) } as Record<
      string,
      unknown
    >;
    delete rawThreadValues.modelProvider;
    const rawThread = rawThreadValues as ThreadOptions;
    const workingDirectory =
      rawThread.workingDirectory ?? path.dirname(document.uri.fsPath);
    const controller = new AbortController();
    this.controller = controller;
    const codexHome = isolatedCodexHome(
      subscriptionEnvironment("codex", rawOptions.env),
    );
    try {
      const bridge = await sdkMcpBridge.acquire(document, controller.signal);
      try {
        config.mcp_servers = allowAllCodexMcpTools(
          codexMcpServers(bridge.codexUrls),
        );
        const options: CodexOptions = {
          ...(rawOptions as CodexOptions),
          codexPathOverride: codexPath,
          apiKey: undefined,
          baseUrl: undefined,
          config,
          configOverrides: [
            ...configuredOverrides.filter(
              (value) => !isMcpServerOverride(value),
            ),
          ],
          env: codexHome.environment,
        };
        const reasoning = getReasoningEffort(configName, fileConfig);
        const threadOptions: ThreadOptions = {
          ...rawThread,
          model: rawThread.model ?? modelName,
          workingDirectory,
          skipGitRepoCheck: rawThread.skipGitRepoCheck ?? true,
          sandboxMode: rawThread.sandboxMode ?? "danger-full-access",
          approvalPolicy: rawThread.approvalPolicy ?? "never",
          modelReasoningEffort:
            rawThread.modelReasoningEffort ??
            (reasoning === "none"
              ? undefined
              : reasoning === "minimal"
              ? "minimal"
              : reasoning),
        };
        const rawTurn = { ...(configured.turn ?? {}) } as TurnOptions;
        const turnOptions: TurnOptions = {
          ...rawTurn,
          signal: controller.signal,
        };
        const prompt = buildAgentPrompt(
          messages,
          document.uri.fsPath,
          "VS Code Settings: chatmd.apiConfigs and chatmd.mcpServers",
          customSystemPrompt,
          chatmdAgentSection(findChatmdCommand()),
        );
        const emittedLengths = new Map<string, number>();
        const tools = new Map<string, { name: string; serverTool: boolean }>();
        const thread = new Codex(options).startThread(threadOptions);
        const streamed = await thread.runStreamed(prompt, turnOptions);
        for await (const event of streamed.events) {
          const tokens = this.translateEvent(
            event,
            emittedLengths,
            tools,
            bridge.codexServerNames,
          );
          if (tokens.length > 0) yield tokens;
        }
      } finally {
        bridge.release();
      }
    } finally {
      codexHome.dispose();
      this.controller = undefined;
    }
  }

  private translateEvent(
    event: ThreadEvent,
    emittedLengths: Map<string, number>,
    tools: Map<string, { name: string; serverTool: boolean }>,
    codexServerNames: Readonly<Record<string, string>>,
  ): string[] {
    if (event.type === "turn.completed") {
      this.lastUsage = {
        inputTokens: event.usage.input_tokens,
        outputTokens: event.usage.output_tokens,
        cacheReadTokens: event.usage.cached_input_tokens,
        cacheWriteTokens: event.usage.cache_write_input_tokens,
      };
      return [];
    }
    if (event.type === "turn.failed") throw new Error(event.error.message);
    if (event.type === "error") throw new Error(event.message);
    if (
      event.type !== "item.started" &&
      event.type !== "item.updated" &&
      event.type !== "item.completed"
    ) {
      return [];
    }

    const item = event.item;
    if (item.type === "agent_message") {
      const delta = appendDelta(item, emittedLengths);
      return delta ? [delta] : [];
    }
    if (item.type === "reasoning") {
      const delta = appendDelta(item, emittedLengths);
      return delta ? [encodeThinkingToken(delta)] : [];
    }
    if (item.type === "error") {
      return event.type === "item.completed" ? [`Error: ${item.message}`] : [];
    }

    const identity =
      item.type === "mcp_tool_call"
        ? {
            name: `${codexServerNames[item.server] ?? item.server}.${
              item.tool
            }`,
            serverTool: false,
          }
        : BUILTIN_TOOL_NAMES[item.type]
        ? { name: BUILTIN_TOOL_NAMES[item.type] as string, serverTool: true }
        : undefined;
    if (!identity) return [];

    const output: string[] = [];
    if (!tools.has(item.id)) {
      tools.set(item.id, identity);
      output.push(
        encodeAgentToolEvent({
          type: "tool_use",
          id: item.id,
          name: identity.name,
          input:
            item.type === "mcp_tool_call"
              ? item.arguments && typeof item.arguments === "object"
                ? (item.arguments as Record<string, unknown>)
                : { value: item.arguments }
              : itemInput(item),
          serverTool: identity.serverTool,
        }),
      );
    }
    if (event.type !== "item.completed") return output;

    if (item.type === "mcp_tool_call") {
      const result = item.result ?? item.error ?? { message: "No result" };
      output.push(
        encodeAgentToolEvent({
          type: "tool_result",
          toolUseId: item.id,
          name: identity.name,
          content: JSON.stringify(result, null, 2),
          isError: item.error !== undefined,
          serverTool: false,
        }),
      );
    } else {
      output.push(
        encodeAgentToolEvent({
          type: "tool_result",
          toolUseId: item.id,
          name: identity.name,
          content: itemResult(item),
          isError: "status" in item && item.status === "failed",
          serverTool: true,
        }),
      );
    }
    return output;
  }
}
