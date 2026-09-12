const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const esbuild = require("esbuild");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StreamableHTTPClientTransport,
} = require("@modelcontextprotocol/sdk/client/streamableHttp.js");

async function loadBridge(manager) {
  globalThis.__chatmdTestMcpManager = manager;
  const result = await esbuild.build({
    entryPoints: [path.join(__dirname, "../src/sdkMcpBridge.ts")],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node18",
    write: false,
    plugins: [
      {
        name: "chatmd-bridge-test-stubs",
        setup(build) {
          build.onResolve({ filter: /^\.\/extension$/ }, () => ({
            path: "extension",
            namespace: "chatmd-test",
          }));
          build.onResolve({ filter: /^\.\/mcpClientManager$/ }, () => ({
            path: "mcpClientManager",
            namespace: "chatmd-test",
          }));
          build.onLoad({ filter: /.*/, namespace: "chatmd-test" }, (args) => ({
            contents:
              args.path === "extension"
                ? "export const log = () => undefined;"
                : "export const mcpClientManager = globalThis.__chatmdTestMcpManager;",
            loader: "js",
          }));
        },
      },
    ],
  });
  const loaded = new Module("sdkMcpBridge.test.js");
  loaded.paths = module.paths;
  loaded._compile(result.outputFiles[0].text, "sdkMcpBridge.test.js");
  return loaded.exports.SdkMcpBridge;
}

test("the SDK MCP bridge lists and executes ChatMD-owned tools", async () => {
  const calls = [];
  const manager = {
    getGroupedTools() {
      return new Map([
        [
          "files",
          new Map([
            [
              "read",
              {
                name: "read",
                description: "Read a file",
                inputSchema: {
                  type: "object",
                  properties: { path: { type: "string" } },
                },
              },
            ],
          ]),
        ],
      ]);
    },
    async executeToolCall(name, params, document, signal) {
      calls.push({ name, params, document, signal });
      return {
        serverId: "files",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "contents" }],
      };
    },
  };
  const SdkMcpBridge = await loadBridge(manager);
  const bridge = new SdkMcpBridge();
  const document = { uri: { fsPath: "/tmp/chat.md" } };
  const controller = new AbortController();
  const lease = await bridge.acquire(document, controller.signal);
  const client = new Client({ name: "bridge-test", version: "1.0.0" });

  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(lease.urls.files)),
    );
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      ["read"],
    );
    assert.deepEqual(lease.claudeAllowedTools, ["mcp__files__read"]);
    assert.deepEqual(Object.values(lease.codexServerNames), ["files"]);
    assert.equal(Object.values(lease.codexUrls)[0], lease.urls.files);

    const result = await client.callTool({
      name: "read",
      arguments: { path: "a.txt", options: { encoding: "utf8" } },
    });
    assert.equal(result.content[0].text, "contents");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "files.read");
    assert.deepEqual(calls[0].params, {
      path: "a.txt",
      options: '{"encoding":"utf8"}',
    });
    assert.equal(calls[0].document, document);
    assert.equal(calls[0].signal, controller.signal);
  } finally {
    await client.close();
    lease.release();
    await bridge.close();
    delete globalThis.__chatmdTestMcpManager;
  }
});
