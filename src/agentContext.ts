import { MessageParam, ToolResultContent, ToolUseContent } from "./types";

export const RECENT_TOOL_PAIRS = 5;
export const TOOL_PREVIEW_CHARACTERS = 100;

interface ToolActivity {
  ordinal: number;
  call: ToolUseContent;
  result?: ToolResultContent;
}

export function chatmdFormatInstructions(configLocation: string): string {
  return `## ChatMD document format

The editable \`.chat.md\` file is the source of truth. Top-level blocks use \`# %% system\`,
\`# %% user\`, \`# %% assistant\`, \`# %% tool_execute\`, and \`# %% settings\`. Assistant
reasoning may appear under \`## %% thinking\`; visible answers use \`## %% text\`. Tool
calls are stored as \`<cmd:tool_call>\` blocks and results are stored in corresponding
\`# %% tool_execute\` blocks; an SDK-written result may start with \`<cmd:tool_id>\` to
preserve its call association. SDK built-in activity is recorded inside inert
\`## %% server_tool\` and \`## %% server_tool_results\` assistant sections. MCP activity
from an SDK still uses ordinary tool-call and tool-execute blocks. When history is sent
to any provider, both forms become the same native tool-use/tool-result message structure.

Markdown attachments use paths relative to the directory containing the chat file.
Read the chat file or a referenced attachment when a detail omitted from the pruned
transcript is relevant enough to check.

ChatMD configuration lives at ${configLocation}. Provider profiles are named entries in
\`apiConfigs\`; select one globally with \`selectedConfig\` or per chat in the preamble.
Add, edit, or remove shared MCP servers through \`mcpServers\`.`;
}

function messageText(message: MessageParam): string {
  return message.content
    .filter((item) => item.type === "text" && item.value.trim() !== "")
    .map((item) => (item.type === "text" ? item.value.trim() : ""))
    .join("\n\n");
}

function toolActivities(messages: readonly MessageParam[]): ToolActivity[] {
  const results = new Map<string, ToolResultContent>();
  const calls: ToolUseContent[] = [];
  for (const message of messages) {
    for (const item of message.content) {
      if (item.type === "tool_use") calls.push(item);
      if (item.type === "tool_result") results.set(item.toolUseId, item);
    }
  }
  return calls.map((call, index) => ({
    ordinal: index + 1,
    call,
    result: results.get(call.id),
  }));
}

function preview(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= TOOL_PREVIEW_CHARACTERS
    ? compact
    : compact.substring(0, TOOL_PREVIEW_CHARACTERS) + "…";
}

function compactToolIndex(activities: ToolActivity[]): string {
  if (activities.length === 0) return "No tool activity has been recorded.";
  return activities
    .map((activity) => {
      const result = activity.result?.rawText ?? "[result missing]";
      return `${activity.ordinal}. ${activity.call.name} | arguments=${preview(
        JSON.stringify(activity.call.input),
      )} | result=${preview(result)}`;
    })
    .join("\n");
}

function recentToolActivity(activities: ToolActivity[]): string {
  const recent = activities.slice(-RECENT_TOOL_PAIRS);
  if (recent.length === 0) return "No recent tool activity.";
  return recent
    .map((activity) => {
      const result =
        activity.result?.rawText ??
        "[Tool result is missing; the turn may have been interrupted.]";
      return `Tool #${activity.ordinal}: ${activity.call.name}\n${activity.call.rawXml}\n\n# %% tool_execute\n${result}`;
    })
    .join("\n\n");
}

function prunedMessages(messages: readonly MessageParam[]): string {
  const blocks = messages.flatMap((message) => {
    const content = messageText(message);
    return content ? [`# %% ${message.role}\n${content}`] : [];
  });
  return blocks.join("\n\n") || "[No visible user or assistant text.]";
}

export function buildAgentPrompt(
  messages: readonly MessageParam[],
  chatPath: string,
  configLocation: string,
  customSystemPrompt: string,
  agentSection: string,
): string {
  const activities = toolActivities(messages);
  const custom = customSystemPrompt.trim()
    ? `## Chat-specific system instructions\n${customSystemPrompt.trim()}`
    : "";
  return [
    "You are responding to the latest user turn in an editable ChatMD transcript.",
    `Current chat file: ${chatPath}`,
    chatmdFormatInstructions(configLocation),
    custom,
    agentSection,
    `## Pruned visible transcript\n${prunedMessages(messages)}`,
    `## Complete tool activity index\n${compactToolIndex(activities)}`,
    `## Most recent tool calls and results in full\n${recentToolActivity(
      activities,
    )}`,
    "Continue the latest request. Use the current chat file when omitted details matter.",
  ]
    .filter((section) => section.trim() !== "")
    .join("\n\n");
}
