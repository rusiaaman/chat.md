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
  assert.match(call, /<cmd:param name="path">a\.txt<\/cmd:param>/);
  assert.doesNotMatch(call, /<cmd:arguments>/);
  assert.doesNotMatch(call, /<cmd:tool_id>/);
  assert.equal(result, "<tool_result>\ncontents\n</tool_result>");

  const protectedCall = renderToolCall("files.write", {
    content: "before </cmd:tool_call> and ]]> after",
  });
  assert.match(protectedCall, /<!\[CDATA\[/);
  assert.doesNotMatch(protectedCall, /<cmd:arguments>/);
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

test("tool result text is capped before an API request without dropping images", async () => {
  const {
    MAX_TOOL_RESULT_TEXT_CHARACTERS,
    TOOL_RESULT_TRUNCATION_MARKER,
    truncateToolResultsForApi,
  } = await loadNativeTools();
  const first = "a".repeat(60_000);
  const second = "b".repeat(60_000);
  const original = {
    role: "user",
    content: [
      {
        type: "tool_result",
        toolUseId: "call",
        name: "files.read",
        content: [
          { type: "text", value: first },
          { type: "image", path: "result.png" },
          { type: "text", value: second },
        ],
        rawText: `<tool_result>\n${first}${second}\n</tool_result>`,
        isError: false,
      },
    ],
  };

  const [processed] = truncateToolResultsForApi([original]);
  const [result] = processed.content;
  const textCharacters = result.content
    .filter((part) => part.type === "text")
    .reduce((total, part) => total + part.value.length, 0);

  assert.equal(textCharacters, MAX_TOOL_RESULT_TEXT_CHARACTERS);
  assert.equal(result.content.at(-1).value, TOOL_RESULT_TRUNCATION_MARKER);
  assert.equal(result.content[1].path, "result.png");
  assert.match(result.rawText, /\.\.\.truncated\n<\/tool_result>$/);
  assert.equal(original.content[0].content[2].value.length, 60_000);
});
