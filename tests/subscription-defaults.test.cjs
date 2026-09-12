const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const esbuild = require("esbuild");

function loadDefaults() {
  const filename = path.join(__dirname, "../src/subscriptionDefaults.ts");
  const result = esbuild.buildSync({
    entryPoints: [filename],
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
  });
  const loaded = new Module(filename, module);
  loaded._compile(result.outputFiles[0].text, filename);
  return loaded.exports.subscriptionDefaults;
}

const subscriptionDefaults = loadDefaults();

test("subscription defaults prefer Claude and preserve explicit selections", () => {
  const defaults = subscriptionDefaults({}, undefined, true, true);
  assert.deepEqual(defaults.configs, {
    "claude-code-opus": {
      type: "claude-code",
      model_name: "claude-opus-5",
      reasoningEffort: "high",
      claudeCode: { permissionMode: "bypassPermissions" },
    },
    "codex-sol": {
      type: "codex",
      model_name: "gpt-5.6-sol",
      reasoningEffort: "high",
      codex: {
        thread: {
          sandboxMode: "danger-full-access",
          approvalPolicy: "never",
        },
      },
    },
  });
  assert.equal(defaults.selectedConfig, "claude-code-opus");

  const existing = subscriptionDefaults(
    { api: { type: "openai", apiKey: "placeholder" } },
    "api",
    true,
    false,
  );
  assert.equal(existing.selectedConfig, "api");
});

test("subscription defaults use Codex when Claude is unavailable", () => {
  const defaults = subscriptionDefaults({}, undefined, false, true);
  assert.equal(defaults.selectedConfig, "codex-sol");
  assert.equal(defaults.configs["codex-sol"].model_name, "gpt-5.6-sol");
});
