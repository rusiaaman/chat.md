import { createHash } from "crypto";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { getSystemToolDefinitions } from "./systemTools";
import type {
  ImageContent,
  MessageParam,
  TextContent,
  ToolResultContent,
} from "./types";

export const MAX_TOOL_RESULT_TEXT_CHARACTERS = 100_000;
export const TOOL_RESULT_TRUNCATION_MARKER = "\n...truncated";

export interface NativeToolDefinition {
  apiName: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type AgentToolEvent =
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
      serverTool: boolean;
    }
  | {
      type: "tool_result";
      toolUseId: string;
      name: string;
      content: string;
      isError: boolean;
      serverTool: boolean;
    };

const AGENT_TOOL_EVENT_PREFIX = "\u0000agent_tool:";

export function encodeAgentToolEvent(event: AgentToolEvent): string {
  return AGENT_TOOL_EVENT_PREFIX + JSON.stringify(event);
}

export function isAgentToolEvent(token: string): boolean {
  return token.startsWith(AGENT_TOOL_EVENT_PREFIX);
}

export function decodeAgentToolEvent(
  token: string,
): AgentToolEvent | undefined {
  try {
    return JSON.parse(
      token.substring(AGENT_TOOL_EVENT_PREFIX.length),
    ) as AgentToolEvent;
  } catch {
    return undefined;
  }
}

const VALID_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export function usesNativeTools(modelName: string): boolean {
  return !modelName.toLowerCase().startsWith("google");
}

export function nativeToolName(name: string): string {
  if (VALID_NAME.test(name)) {
    return name;
  }
  const readable =
    name.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+|_+$/g, "") || "tool";
  const digest = createHash("sha256")
    .update(name)
    .digest("hex")
    .substring(0, 10);
  return `${readable.substring(0, 53)}_${digest}`;
}

export function buildNativeTools(
  groupedTools: ReadonlyMap<string, ReadonlyMap<string, Tool>>,
): NativeToolDefinition[] {
  const definitions = [...getSystemToolDefinitions()];
  for (const tools of groupedTools.values()) {
    definitions.push(...tools.values());
  }
  return definitions.map((tool) => ({
    apiName: nativeToolName(tool.name),
    name: tool.name,
    description: tool.description || "",
    inputSchema: tool.inputSchema as Record<string, unknown>,
  }));
}

export function canonicalToolName(
  apiName: string,
  tools: readonly NativeToolDefinition[],
): string {
  return tools.find((tool) => tool.apiName === apiName)?.name || apiName;
}

export function apiToolName(
  name: string,
  tools: readonly NativeToolDefinition[],
): string {
  return (
    tools.find((tool) => tool.name === name)?.apiName || nativeToolName(name)
  );
}

export function anthropicToolSchemas(
  tools: readonly NativeToolDefinition[],
): Record<string, unknown>[] {
  return tools.map((tool) => ({
    name: tool.apiName,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}

export function openaiChatToolSchemas(
  tools: readonly NativeToolDefinition[],
): Record<string, unknown>[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.apiName,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

export function openaiResponsesToolSchemas(
  tools: readonly NativeToolDefinition[],
): Record<string, unknown>[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.apiName,
    description: tool.description,
    parameters: tool.inputSchema,
  }));
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function renderParamValue(value: unknown): string {
  const rendered =
    typeof value === "string"
      ? value
      : value === undefined
      ? ""
      : JSON.stringify(value);
  if (!/<\/?cmd:|<!\[CDATA\[|\]\]>/.test(rendered)) return rendered;
  return `<![CDATA[${rendered.replace(/\]\]>/g, "]]]]><![CDATA[>")}]]>`;
}

export function renderToolCall(
  name: string,
  input: Record<string, unknown>,
): string {
  const params = Object.entries(input)
    .map(
      ([key, value]) =>
        `<cmd:param name="${escapeXml(key)}">${renderParamValue(
          value,
        )}</cmd:param>`,
    )
    .join("\n");
  return `\n<cmd:tool_call>\n<cmd:tool_name>${escapeXml(
    name,
  )}</cmd:tool_name>\n${params}${params ? "\n" : ""}</cmd:tool_call>`;
}

export function renderToolCallFromArguments(
  name: string,
  argumentsJson: string,
): string {
  return renderToolCall(name, parseNativeArguments(argumentsJson) ?? {});
}

export function renderServerToolResult(result: string): string {
  return result;
}

export function toolResultText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(toolResultText).filter(Boolean).join("\n");
  }
  if (value && typeof value === "object") {
    const result = value as Record<string, unknown>;
    for (const key of [
      "output",
      "aggregatedOutput",
      "stdout",
      "text",
      "content",
      "message",
      "error",
      "structuredContent",
      "structured_content",
    ]) {
      if (result[key] === undefined) continue;
      const text = toolResultText(result[key]);
      if (text) return text;
    }
    return "";
  }
  return value === undefined || value === null ? "" : String(value);
}

function truncatedToolResultRawText(
  rawText: string,
  content: readonly (TextContent | ImageContent)[],
): string {
  const body = content
    .map((part) =>
      part.type === "text" ? part.value : `![Tool result image](${part.path})`,
    )
    .join("\n\n");
  return /<tool_result>[\s\S]*?<\/tool_result>/.test(rawText)
    ? `<tool_result>\n${body}\n</tool_result>`
    : body;
}

function truncateToolResult(result: ToolResultContent): ToolResultContent {
  const textCharacters = result.content.reduce(
    (total, part) => total + (part.type === "text" ? part.value.length : 0),
    0,
  );
  if (textCharacters <= MAX_TOOL_RESULT_TEXT_CHARACTERS) return result;

  let remaining =
    MAX_TOOL_RESULT_TEXT_CHARACTERS - TOOL_RESULT_TRUNCATION_MARKER.length;
  const content: Array<TextContent | ImageContent> = [];
  for (const part of result.content) {
    if (part.type === "image") {
      content.push(part);
      continue;
    }
    if (remaining <= 0) continue;
    const value = part.value.substring(0, remaining);
    remaining -= value.length;
    if (value) content.push({ type: "text", value });
  }
  content.push({ type: "text", value: TOOL_RESULT_TRUNCATION_MARKER });

  return {
    ...result,
    content,
    rawText: truncatedToolResultRawText(result.rawText, content),
  };
}

export function truncateToolResultsForApi(
  messages: readonly MessageParam[],
): MessageParam[] {
  return messages.map((message) => ({
    ...message,
    content: message.content.map((item) =>
      item.type === "tool_result" ? truncateToolResult(item) : item,
    ),
  }));
}

export function assignDeterministicToolIds(
  messages: readonly MessageParam[],
): MessageParam[] {
  const pendingIds: string[] = [];
  let callIndex = 0;
  let orphanResultIndex = 0;

  return messages.map((message) => {
    if (
      message.role === "user" &&
      !message.content.some((item) => item.type === "tool_result")
    ) {
      pendingIds.length = 0;
    }
    return {
      ...message,
      content: message.content.map((item) => {
        if (item.type === "tool_use") {
          const id = `chatmd_call_${callIndex}`;
          callIndex++;
          pendingIds.push(id);
          return { ...item, id };
        }
        if (item.type === "tool_result") {
          let toolUseId = pendingIds.shift();
          if (!toolUseId) {
            toolUseId = `chatmd_orphan_result_${orphanResultIndex}`;
            orphanResultIndex++;
          }
          return { ...item, toolUseId };
        }
        return item;
      }),
    };
  });
}

export function parseServerToolResult(value: string): {
  id?: string;
  result: string;
} {
  const matched =
    /^\s*<cmd:tool_id>([^<]*)<\/cmd:tool_id>[ \t]*(?:\r?\n)?/.exec(value);
  if (!matched) return { result: value };
  return {
    id: unescapeXml(matched[1]),
    result: value.substring(matched[0].length),
  };
}

export function parseNativeArguments(
  value: string,
): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(unescapeXml(value));
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function paramsFromInput(
  input: Record<string, unknown>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).map(([name, value]) => [
      name,
      typeof value === "string" ? value : JSON.stringify(value),
    ]),
  );
}

export function inputFromParams(
  params: Record<string, string>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(params).map(([name, value]) => {
      try {
        return [name, JSON.parse(value)];
      } catch {
        return [name, value];
      }
    }),
  );
}
