const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const esbuild = require("esbuild");

function uri(value) {
  return { toString: () => value };
}

async function loadFileUtils(groups) {
  globalThis.__chatmdTabGroups = groups;
  const filename = path.join(__dirname, "../src/utils/fileUtils.ts");
  const result = await esbuild.build({
    entryPoints: [filename],
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
    plugins: [
      {
        name: "vscode-tab-test-stub",
        setup(build) {
          build.onResolve({ filter: /^vscode$/ }, () => ({
            path: "vscode",
            namespace: "chatmd-test",
          }));
          build.onLoad({ filter: /.*/, namespace: "chatmd-test" }, () => ({
            contents: [
              "export const window = { tabGroups: { all: globalThis.__chatmdTabGroups } };",
              "export const workspace = { getConfiguration: () => ({ get: (_key, fallback) => fallback }) };",
            ].join("\n"),
            loader: "js",
          }));
        },
      },
    ],
  });
  const loaded = new Module(filename, module);
  loaded._compile(result.outputFiles[0].text, filename);
  return loaded.exports;
}

test("a document counts as open in normal, background, and diff tabs", async () => {
  const target = "file:///workspace/chat.chat.md";
  const groups = [
    {
      tabs: [
        { isActive: false, input: { uri: uri(target) } },
        {
          isActive: true,
          input: {
            original: uri("file:///workspace/old.chat.md"),
            modified: uri(target),
          },
        },
      ],
    },
  ];
  const { isDocumentOpenInTab } = await loadFileUtils(groups);

  assert.equal(isDocumentOpenInTab({ uri: uri(target) }), true);
  assert.equal(
    isDocumentOpenInTab({ uri: uri("file:///workspace/closed.chat.md") }),
    false,
  );
});

test("closing the last matching tab makes the document closed", async () => {
  const target = "file:///workspace/chat.chat.md";
  const groups = [{ tabs: [{ input: { uri: uri(target) } }] }];
  const { isDocumentOpenInTab } = await loadFileUtils(groups);
  const document = { uri: uri(target) };

  assert.equal(isDocumentOpenInTab(document), true);
  groups[0].tabs.length = 0;
  assert.equal(isDocumentOpenInTab(document), false);
});
