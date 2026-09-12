const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const esbuild = require("esbuild");

function loadIsolator() {
  const filename = path.join(__dirname, "../src/codexHome.ts");
  const result = esbuild.buildSync({
    entryPoints: [filename],
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
  });
  const loaded = new Module(filename, module);
  loaded._compile(result.outputFiles[0].text, filename);
  return loaded.exports.isolatedCodexHome;
}

const isolatedCodexHome = loadIsolator();

test("an isolated Codex home shares auth without inheriting config", () => {
  const sourceHome = fs.mkdtempSync(path.join(os.tmpdir(), "chatmd-source-"));
  fs.writeFileSync(path.join(sourceHome, "auth.json"), "credential", {
    mode: 0o600,
  });
  fs.writeFileSync(path.join(sourceHome, "config.toml"), "invalid = true\n");

  const isolated = isolatedCodexHome({ CODEX_HOME: sourceHome, KEEP: "yes" });
  const temporaryHome = isolated.environment.CODEX_HOME;
  try {
    assert.equal(isolated.environment.KEEP, "yes");
    assert.equal(isolated.environment.CODEX_SQLITE_HOME, temporaryHome);
    assert.equal(
      fs.readFileSync(path.join(temporaryHome, "auth.json"), "utf8"),
      "credential",
    );
    assert.equal(fs.existsSync(path.join(temporaryHome, "config.toml")), false);
  } finally {
    isolated.dispose();
    fs.rmSync(sourceHome, { recursive: true, force: true });
  }
  assert.equal(fs.existsSync(temporaryHome), false);
});
