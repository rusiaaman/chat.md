const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const esbuild = require("esbuild");

async function loadNativeTools() {
  const filename = path.join(__dirname, "../src/nativeTools.ts");
  const result = await esbuild.build({
    entryPoints: [filename],
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
  });
  const loaded = new Module(filename, module);
  loaded._compile(result.outputFiles[0].text, filename);
  return loaded.exports;
}

test("rendered tool calls and results contain no persisted IDs", async () => {
  const { renderServerToolResult, renderToolCall } = await loadNativeTools();
  const call = renderToolCall("files.read", { path: "a.txt" });
  const result = renderServerToolResult(
    "<tool_result>\ncontents\n</tool_result>",
  );

  assert.match(call, /<cmd:tool_name>files\.read<\/cmd:tool_name>/);
  assert.doesNotMatch(call, /<cmd:tool_id>/);
  assert.equal(result, "<tool_result>\ncontents\n</tool_result>");
});

test("provider-facing tool IDs are assigned from transcript order", async () => {
  const { assignDeterministicToolIds } = await loadNativeTools();
  const messages = [
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "sdk-b",
          name: "first",
          input: {},
          rawXml: "a",
        },
        {
          type: "tool_use",
          id: "sdk-a",
          name: "second",
          input: {},
          rawXml: "b",
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: "sdk-a",
          name: "second",
          content: [],
          rawText: "first result in file",
          isError: false,
        },
        {
          type: "tool_result",
          toolUseId: "sdk-b",
          name: "first",
          content: [],
          rawText: "second result in file",
          isError: false,
        },
      ],
    },
  ];

  const normalized = assignDeterministicToolIds(messages);
  assert.deepEqual(
    normalized.flatMap((message) =>
      message.content
        .filter((item) => item.type === "tool_use")
        .map((item) => item.id),
    ),
    ["chatmd_call_0", "chatmd_call_1"],
  );
  assert.deepEqual(
    normalized.flatMap((message) =>
      message.content
        .filter((item) => item.type === "tool_result")
        .map((item) => item.toolUseId),
    ),
    ["chatmd_call_0", "chatmd_call_1"],
  );
});

test("SDK result rendering keeps output text and drops execution metadata", async () => {
  const { toolResultText } = await loadNativeTools();

  assert.equal(
    toolResultText({
      output: "file contents",
      exitCode: 0,
      status: "completed",
    }),
    "file contents",
  );
  assert.equal(
    toolResultText({
      content: [{ type: "text", text: "MCP contents" }],
      status: "completed",
    }),
    "MCP contents",
  );
});
