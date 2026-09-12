import { createHash } from "crypto";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { getSystemToolDefinitions } from "./systemTools";

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

export function decodeAgentToolEvent(token: string): AgentToolEvent | undefined {
  try {
    return JSON.parse(token.substring(AGENT_TOOL_EVENT_PREFIX.length)) as AgentToolEvent;
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

export function renderToolCallStart(id: string, name: string): string {
  return `\n<cmd:tool_call>\n<cmd:tool_id>${escapeXml(
    id,
  )}</cmd:tool_id>\n<cmd:tool_name>${escapeXml(
    name,
  )}</cmd:tool_name>\n<cmd:arguments>`;
}

export function renderToolArgumentsDelta(delta: string): string {
  return escapeXml(delta);
}

export function renderToolCallEnd(): string {
  return "</cmd:arguments>\n</cmd:tool_call>";
}

export function renderToolCall(
  id: string,
  name: string,
  input: Record<string, unknown>,
): string {
  return renderToolCallStart(id, name)
    + renderToolArgumentsDelta(JSON.stringify(input))
    + renderToolCallEnd();
}

export function renderServerToolResult(id: string, result: string): string {
  return `<cmd:tool_id>${escapeXml(id)}</cmd:tool_id>\n${result}`;
}

export function parseServerToolResult(
  value: string,
): { id?: string; result: string } {
  const matched = /^\s*<cmd:tool_id>([^<]*)<\/cmd:tool_id>[ \t]*(?:\r?\n)?/.exec(value);
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
