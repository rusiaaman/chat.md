const assert = require("node:assert/strict");
const http = require("node:http");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const esbuild = require("esbuild");

async function loadOpenAiClient() {
  const filename = path.join(__dirname, "../src/openaiClient.ts");
  const result = await esbuild.build({
    entryPoints: [filename],
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
    plugins: [
      {
        name: "extension-stream-test-stubs",
        setup(build) {
          build.onResolve({ filter: /^vscode$/ }, () => ({
            path: "vscode",
            namespace: "chatmd-test",
          }));
          build.onResolve({ filter: /^\.\/extension$/ }, () => ({
            path: "extension",
            namespace: "chatmd-test",
          }));
          build.onResolve({ filter: /^\.\/config$/ }, () => ({
            path: "config",
            namespace: "chatmd-test",
          }));
          build.onLoad({ filter: /^vscode$/, namespace: "chatmd-test" }, () => ({
            contents: [
              "export const window = { showErrorMessage() {}, showInformationMessage() {} };",
              "export const workspace = { getConfiguration: () => ({ get: (_key, fallback) => fallback }) };",
            ].join("\n"),
            loader: "js",
          }));
          build.onLoad({ filter: /^extension$/, namespace: "chatmd-test" }, () => ({
            contents: "export function log() {}",
            loader: "js",
          }));
          build.onLoad({ filter: /^config$/, namespace: "chatmd-test" }, () => ({
            contents: [
              "export const getModelName = () => 'gpt-4.1';",
              "export const getBaseUrl = () => '';",
              "export const getMaxTokens = () => 1024;",
              "export const getReasoningEffort = () => 'none';",
              "export const getDefaultSystemPrompt = () => '';",
              "export const generateToolCallingSystemPrompt = () => '';",
            ].join("\n"),
            loader: "js",
          }));
        },
      },
    ],
  });
  const loaded = new Module(filename, module);
  loaded._compile(result.outputFiles[0].text, filename);
  return loaded.exports.OpenAIClient;
}

test("aborting a direct API signal closes an in-flight stream", { timeout: 10000 }, async () => {
  const sockets = new Set();
  let requestStarted;
  const started = new Promise((resolve) => {
    requestStarted = resolve;
  });
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
    requestStarted();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const OpenAIClient = await loadOpenAiClient();
    const address = server.address();
    assert.equal(typeof address, "object");
    const client = new OpenAIClient("test-key", `http://127.0.0.1:${address.port}`);
    const controller = new AbortController();
    const stream = client.streamCompletion(
      [{ role: "user", content: [{ type: "text", value: "hello" }] }],
      [],
      controller.signal,
      undefined,
      "system",
      "gpt-4.1",
      undefined,
      {},
    );
    const pending = stream.next();
    const earlyCompletion = pending.then(
      () => {
        throw new Error("Direct API stream completed before opening the response");
      },
      (error) => {
        throw error;
      },
    );
    let startTimeout;
    try {
      await Promise.race([
        started,
        earlyCompletion,
        new Promise((_, reject) => {
          startTimeout = setTimeout(
            () => reject(new Error("Direct API request did not start within 3 seconds")),
            3000,
          );
        }),
      ]);
    } finally {
      clearTimeout(startTimeout);
    }
    controller.abort();

    let timeout;
    try {
      await Promise.race([
        assert.rejects(pending, (error) => error.name === "AbortError"),
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Direct API stream did not abort within 3 seconds")),
            3000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});
