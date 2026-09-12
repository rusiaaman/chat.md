const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");

test("the CommonJS extension bundle preserves SDK import.meta.url", () => {
  const originalLoad = Module._load;
  let callable;
  callable = new Proxy(function () {
    return callable;
  }, {
    get(_target, property) {
      if (property === "then") return undefined;
      if (property === Symbol.iterator) return function* () {};
      return callable;
    },
    apply() {
      return callable;
    },
    construct() {
      return callable;
    },
  });
  const window = new Proxy(
    {
      createOutputChannel: () => callable,
      createStatusBarItem: () => callable,
    },
    {
      get(target, property) {
        return property in target ? target[property] : callable;
      },
    },
  );
  const workspace = new Proxy(
    { getConfiguration: () => ({ get: () => undefined }) },
    {
      get(target, property) {
        return property in target ? target[property] : callable;
      },
    },
  );
  const vscode = {
    workspace,
    window,
    commands: callable,
    Uri: callable,
    EventEmitter: callable,
    Disposable: callable,
    ThemeColor: callable,
    RelativePattern: callable,
    StatusBarAlignment: callable,
    ConfigurationTarget: callable,
    ExtensionMode: callable,
  };

  Module._load = function (request, parent, isMain) {
    return request === "vscode"
      ? vscode
      : originalLoad.call(this, request, parent, isMain);
  };
  try {
    const extension = require("../dist/extension.js");
    assert.equal(typeof extension.activate, "function");
  } finally {
    Module._load = originalLoad;
  }
});
