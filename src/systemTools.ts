import { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  McpReadResourceResult,
  McpRenderableContent,
  McpToolExecutionResult,
} from "./types";

const SYSTEM_TOOL_SERVER_ID = "system";
const FETCH_MCP_RESOURCE_TOOL_NAME = "fetch_mcp_resource";
const FETCH_MCP_RESOURCE_FULL_NAME = `${SYSTEM_TOOL_SERVER_ID}.${FETCH_MCP_RESOURCE_TOOL_NAME}`;

const fetchMcpResourceTool: Tool = {
  name: FETCH_MCP_RESOURCE_FULL_NAME,
  description:
    "Read an MCP resource by server ID and exact resource URI. Use this when you need the actual contents of an advertised MCP resource.",
  inputSchema: {
    type: "object",
    properties: {
      serverId: {
        type: "string",
        description: "Configured MCP server ID that advertised the resource.",
      },
      uri: {
        type: "string",
        description: "Exact MCP resource URI to read from that server.",
      },
    },
    required: ["serverId", "uri"],
    additionalProperties: false,
  },
};

export function getSystemToolDefinitions(): Tool[] {
  return [fetchMcpResourceTool];
}

export function getGroupedSystemTools(): Map<string, Map<string, Tool>> {
  const groupedSystemTools = new Map<string, Map<string, Tool>>();
  const systemToolMap = new Map<string, Tool>();

  for (const tool of getSystemToolDefinitions()) {
    systemToolMap.set(tool.name, tool);
  }

  groupedSystemTools.set(SYSTEM_TOOL_SERVER_ID, systemToolMap);
  return groupedSystemTools;
}

export function isSystemTool(fullName: string): boolean {
  return getSystemToolDefinitions().some((tool) => tool.name === fullName);
}

export async function executeSystemTool(
  fullName: string,
  params: Record<string, string>,
  readResource: (serverId: string, uri: string) => Promise<McpReadResourceResult>,
): Promise<McpToolExecutionResult | string> {
  if (fullName !== FETCH_MCP_RESOURCE_FULL_NAME) {
    return `Error: Unknown system tool \"${fullName}\".`;
  }

  const serverId = params.serverId;
  const uri = params.uri;

  if (!serverId || !uri) {
    return "Error: system.fetch_mcp_resource requires both serverId and uri parameters.";
  }

  try {
    const result = await readResource(serverId, uri);
    const content = mapReadResourceResultToRenderableContent(result, serverId, uri);

    return {
      serverId: SYSTEM_TOOL_SERVER_ID,
      toolName: FETCH_MCP_RESOURCE_FULL_NAME,
      isError: false,
      content,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      serverId: SYSTEM_TOOL_SERVER_ID,
      toolName: FETCH_MCP_RESOURCE_FULL_NAME,
      isError: true,
      content: [
        {
          type: "text",
          text: `Failed to read MCP resource \"${uri}\" from server \"${serverId}\": ${message}`,
        },
      ],
    };
  }
}

function mapReadResourceResultToRenderableContent(
  result: McpReadResourceResult,
  serverId: string,
  uri: string,
): McpRenderableContent[] {
  if (result.contents.length === 0) {
    return [
      {
        type: "text",
        text: `MCP resource \"${uri}\" from server \"${serverId}\" returned no contents.`,
      },
    ];
  }

  return result.contents.map((contentItem) => ({
    type: "resource",
    resource: {
      uri: contentItem.uri,
      mimeType: contentItem.mimeType,
      text: contentItem.text,
      blob: contentItem.blob,
    },
  }));
}
