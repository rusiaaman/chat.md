const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { test } = require("node:test");
const { buildSync } = require("esbuild");

function loadHelpers(relativePath) {
  const filename = path.resolve(__dirname, "..", relativePath);
  const result = buildSync({
    entryPoints: [filename],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["../extension"],
    write: false,
  });
  const loaded = new Module(filename, module);
  loaded.require = (specifier) => {
    assert.equal(specifier, "../extension");
    return { log() {} };
  };
  loaded._compile(result.outputFiles[0].text, filename);
  return loaded.exports;
}

const { blockContentRegex, escapeMarkers, unescapeMarkers } =
  loadHelpers("src/utils/markerEscape.ts");
const { stripThinkingSections } = loadHelpers("src/utils/thinkingBlocks.ts");
const { findAllToolCalls, parseToolCall } = loadHelpers("src/tools/toolCallParser.ts");
const vectors = JSON.parse(readFileSync(
  path.resolve(__dirname, "../python/tests/marker_vectors.json"), "utf8",
));

test("escaping agrees with Python's shared vectors", () => {
  for (const [raw, escaped] of vectors.cases) {
    assert.equal(escapeMarkers(raw, true), escaped);
    assert.equal(unescapeMarkers(escaped), raw);
  }
  for (const [raw, atStart, midLine] of vectors.midLine) {
    assert.equal(escapeMarkers(raw, true), atStart);
    assert.equal(escapeMarkers(raw, false), midLine);
  }
});

test("subagent tool input survives block extraction and unescaping", () => {
  const call = '<cmd:tool_call>\n<cmd:tool_name>FileWriteOrEdit</cmd:tool_name>\n'
    + '<cmd:param name="content"># %% user\nCreate an app.\n\n'
    + '# %% assistant\n## %% thinking\nNested reasoning\n## %% text\n'
    + '# %%% user\n</cmd:param>\n</cmd:tool_call>';
  const text = '# %% assistant\n## %% thinking\nOuter reasoning\n## %% text\n'
    + escapeMarkers(call, true) + '\n\n# %% tool_execute\n';
  const matches = [...text.matchAll(blockContentRegex("assistant"))];
  assert.equal(matches.length, 1);
  const restored = unescapeMarkers(stripThinkingSections(matches[0][1])).trim();
  assert.equal(restored, call);
  const calls = findAllToolCalls(restored);
  assert.equal(calls.length, 1);
  assert.equal(parseToolCall(calls[0]).params.content,
    '# %% user\nCreate an app.\n\n# %% assistant\n## %% thinking\n'
    + 'Nested reasoning\n## %% text\n# %%% user');
  assert.equal(matches[0].index + matches[0][0].length, text.indexOf('# %% tool_execute'));
});

test("only complete marker lines end a block, including settings and mixed case", () => {
  for (const ending of ["# %% user", "# %% assistant", "# %% system", "# %% tool_execute", "# %% settings", "# %% UsEr\t\r"]) {
    const content = 'first\n# %%% assistant\ninline # %% assistant\n# %% username\nlast\n';
    const text = '# %% Assistant\r\n' + content + ending + '\nnext\n';
    const match = blockContentRegex("assistant").exec(text);
    assert.equal(match[1].trim(), content.trim());
    assert.equal(match.index + match[0].length, '# %% Assistant\r\n'.length + content.length);
  }
});

test("tool results containing escaped or inline markers remain nonempty", () => {
  const text = '# %% tool_execute\n# %%% assistant\ninline # %% tool_execute\n'
    + '# %% tool_execute\n\n# %% assistant\nKeep this later content\n';
  const blocks = [...text.matchAll(blockContentRegex("tool_execute"))];
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0][1].trim(), '# %%% assistant\ninline # %% tool_execute');
  assert.equal(blocks[1][1].trim(), '');
  const end = blocks[1].index + blocks[1][0].length;
  assert.equal(text.slice(end), '# %% assistant\nKeep this later content\n');
});

test("batch accounting starts at the first tool result", () => {
  const text = '# %% assistant\ncall\n# %%% assistant\n'
    + '# %% tool_execute\nresult\n# %% tool_execute\n';
  const current = text.lastIndexOf('# %% tool_execute');
  const match = blockContentRegex("assistant").exec(text.slice(0, current));
  const end = match.index + match[0].length;
  assert.equal(text.slice(end, current), '# %% tool_execute\nresult\n');
});
