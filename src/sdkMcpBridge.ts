import { createHash, randomBytes } from "crypto";
import * as http from "http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import * as vscode from "vscode";
import { log } from "./extension";
import { mcpClientManager } from "./mcpClientManager";
import { McpToolExecutionResult } from "./types";

interface BridgeContext {
  document: vscode.TextDocument;
  signal: AbortSignal;
}

export interface SdkMcpBridgeLease {
  urls: Record<string, string>;
  codexUrls: Record<string, string>;
  codexServerNames: Record<string, string>;
  claudeAllowedTools: string[];
  release(): void;
}

function stringParams(input: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).map(([name, value]) => [
      name,
      typeof value === "string" ? value : JSON.stringify(value),
    ]),
  );
}

function toolResult(result: McpToolExecutionResult | string): {
  content: McpToolExecutionResult["content"];
  isError: boolean;
  structuredContent?: Record<string, unknown>;
} {
  if (typeof result === "string") {
    return {
      content: [{ type: "text", text: result }],
      isError: result.startsWith("Error:") || result.startsWith("CANCELLED:"),
    };
  }
  return {
    content: result.content,
    isError: result.isError,
    ...(result.structuredContent &&
    typeof result.structuredContent === "object" &&
    !Array.isArray(result.structuredContent)
      ? {
          structuredContent: result.structuredContent as Record<
            string,
            unknown
          >,
        }
      : {}),
  };
}

async function requestBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 4 * 1024 * 1024) {
      throw new Error("MCP bridge request exceeded 4 MiB.");
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function errorResponse(
  response: http.ServerResponse,
  status: number,
  message: string,
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32603, message },
      id: null,
    }),
  );
}

export class SdkMcpBridge {
  private readonly contexts = new Map<string, BridgeContext>();
  private server: http.Server | undefined;
  private address: string | undefined;
  private starting: Promise<string> | undefined;

  public async acquire(
    document: vscode.TextDocument,
    signal: AbortSignal,
  ): Promise<SdkMcpBridgeLease> {
    const address = await this.start();
    const token = randomBytes(32).toString("hex");
    this.contexts.set(token, { document, signal });
    const groupedTools = mcpClientManager.getGroupedTools();
    const urls = Object.fromEntries(
      [...groupedTools.keys()].map((serverId) => [
        serverId,
        `${address}/${token}/${encodeURIComponent(serverId)}`,
      ]),
    );
    const codexServerNames = Object.fromEntries(
      [...groupedTools.keys()].map((serverId) => [
        `chatmd_${createHash("sha256")
          .update(`${token}:${serverId}`)
          .digest("hex")
          .substring(0, 16)}`,
        serverId,
      ]),
    );
    const codexUrls = Object.fromEntries(
      Object.entries(codexServerNames).map(([internalName, serverId]) => [
        internalName,
        urls[serverId],
      ]),
    );
    return {
      urls,
      codexUrls,
      codexServerNames,
      claudeAllowedTools: [...groupedTools.entries()].flatMap(
        ([serverId, tools]) =>
          [...tools.keys()].map((tool) => `mcp__${serverId}__${tool}`),
      ),
      release: () => {
        this.contexts.delete(token);
      },
    };
  }

  public async close(): Promise<void> {
    this.contexts.clear();
    const server = this.server;
    this.server = undefined;
    this.address = undefined;
    this.starting = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async start(): Promise<string> {
    if (this.address) return this.address;
    if (this.starting) return this.starting;
    const starting = new Promise<string>((resolve, reject) => {
      const server = http.createServer((request, response) => {
        void this.handleRequest(request, response);
      });
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const bound = server.address();
        if (!bound || typeof bound === "string") {
          server.close();
          reject(new Error("Could not bind the local MCP bridge."));
          return;
        }
        server.removeListener("error", reject);
        this.server = server;
        this.address = `http://127.0.0.1:${bound.port}/mcp`;
        log(`SDK MCP bridge listening on ${this.address}`);
        resolve(this.address);
      });
    });
    this.starting = starting;
    try {
      return await starting;
    } finally {
      if (this.starting === starting) this.starting = undefined;
    }
  }

  private async handleRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    try {
      if (request.method !== "POST") {
        errorResponse(response, 405, "Method not allowed.");
        return;
      }
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length !== 3 || parts[0] !== "mcp") {
        errorResponse(response, 404, "Unknown MCP bridge endpoint.");
        return;
      }
      const context = this.contexts.get(parts[1]);
      const serverId = decodeURIComponent(parts[2]);
      const tools = mcpClientManager.getGroupedTools().get(serverId);
      if (!context || !tools) {
        errorResponse(
          response,
          404,
          "MCP bridge lease or server was not found.",
        );
        return;
      }
      const body = await requestBody(request);
      const mcp = this.createMcpServer(serverId, tools, context);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await mcp.connect(transport);
      try {
        await transport.handleRequest(request, response, body);
      } finally {
        await transport.close();
        await mcp.close();
      }
    } catch (error) {
      log(`SDK MCP bridge request failed: ${error}`);
      if (!response.headersSent) {
        errorResponse(
          response,
          500,
          error instanceof Error ? error.message : String(error),
        );
      } else if (!response.writableEnded) {
        response.end();
      }
    }
  }

  private createMcpServer(
    serverId: string,
    tools: Map<string, Tool>,
    context: BridgeContext,
  ): Server {
    const server = new Server(
      { name: `chatmd-${serverId}`, version: "0.7.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [...tools.values()],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const args = request.params.arguments ?? {};
      const result = await mcpClientManager.executeToolCall(
        `${serverId}.${request.params.name}`,
        stringParams(args),
        context.document,
        context.signal,
      );
      return toolResult(result);
    });
    return server;
  }
}

export const sdkMcpBridge = new SdkMcpBridge();
