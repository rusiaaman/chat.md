import * as vscode from "vscode";
import { McpClientManager } from "../mcpClient";
import { getApiConfigs, getSelectedConfigName } from "../config";

type SidebarState = {
  apiConfigs: Record<string, any>;
  selectedConfig: string | undefined;
  prompts: { id: string; label: string }[];
};

export class ChatmdSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "chatmd.sidebarView";

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly mcpManager: McpClientManager,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.getHtml();

    const sendState = () => {
      const grouped = this.mcpManager.getGroupedPrompts();
      const prompts: { id: string; label: string }[] = [];
      for (const [serverId, promptMap] of grouped) {
        for (const [promptName] of promptMap) {
          prompts.push({
            id: `${serverId}.${promptName}`,
            label: `${serverId} • ${promptName}`,
          });
        }
      }

      const state: SidebarState = {
        apiConfigs: getApiConfigs(),
        selectedConfig: getSelectedConfigName(),
        prompts,
      };
      webviewView.webview.postMessage({ type: "state", state });
    };

    // Initial state
    sendState();

    // Handle messages
    webviewView.webview.onDidReceiveMessage(async (msg) => {
      try {
        switch (msg?.type) {
          case "runCommand": {
            const { command, args } = msg;
            await vscode.commands.executeCommand(command, ...(args ?? []));
            // After running a command, refresh state (configs/prompts may have changed)
            sendState();
            break;
          }
          case "selectApiConfigByName": {
            const name = msg?.name as string;
            if (name) {
              await vscode.commands.executeCommand("filechat.selectApiConfig");
              // If user cancels, selection won't change; still refresh UI
              sendState();
            }
            break;
          }
          case "refresh": {
            sendState();
            break;
          }
        }
      } catch (err) {
        vscode.window.showErrorMessage(
          `chat.md sidebar error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }

  private getHtml(): string {
    const nonce = String(Math.random()).slice(2);
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>chat.md</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: var(--vscode-font-family); padding: 10px; }
  h3 { margin: 12px 0 6px; }
  section { border: 1px solid var(--vscode-editorWidget-border); border-radius: 6px; padding: 10px; margin-bottom: 10px; }
  .row { display: flex; gap: 6px; flex-wrap: wrap; }
  button, select, input { font-size: 12px; }
  button { padding: 4px 8px; }
  .muted { opacity: 0.8; }
  label { display:block; margin: 6px 0 4px; }
</style>
</head>
<body>
  <section>
    <h3>Chats</h3>
    <div class="row">
      <button id="newChat">New chat.md</button>
      <button id="newContextChat">New Chat (with context)</button>
    </div>
  </section>

  <section>
    <h3>API Config</h3>
    <div class="row">
      <span class="muted">Active:</span>
      <strong id="activeConfig">(loading)</strong>
    </div>
    <label for="configSelect">All configs</label>
    <select id="configSelect"></select>
    <div class="row" style="margin-top:6px">
      <button id="addApiConfig">Add / Edit</button>
      <button id="selectApiConfig">Select</button>
      <button id="removeApiConfig">Remove</button>
    </div>
    <div class="row" style="margin-top:6px">
      <button id="selectConfig1">Select #1</button>
      <button id="selectConfig2">Select #2</button>
      <button id="selectConfig3">Select #3</button>
      <button id="selectConfig4">Select #4</button>
      <button id="selectConfig5">Select #5</button>
    </div>
  </section>

  <section>
    <h3>MCP</h3>
    <div class="row">
      <button id="refreshMcpTools">Refresh Tools</button>
      <button id="configureMcpServer">Configure Server</button>
    </div>
    <div class="row" style="margin-top:6px">
      <button id="mcpDiagnostics">Diagnostics</button>
      <button id="testSseConnection">Test SSE</button>
    </div>
  </section>

  <section>
    <h3>Streaming</h3>
    <div class="row">
      <button id="insertNextBlock">Insert Next Block</button>
      <button id="resumeStreaming">Resume</button>
      <button id="cancelStreaming">Cancel</button>
    </div>
  </section>

  <section>
    <h3>Prompts</h3>
    <label for="promptSelect">Available prompts</label>
    <select id="promptSelect"></select>
    <div class="row" style="margin-top:6px">
      <button id="insertPrompt">Insert Prompt</button>
      <button id="refreshAll">Refresh Lists</button>
    </div>
  </section>

<script nonce="${nonce}">
(function(){
  const vscode = acquireVsCodeApi();

  const els = {
    activeConfig: document.getElementById('activeConfig'),
    configSelect: document.getElementById('configSelect'),
    promptSelect: document.getElementById('promptSelect'),
  };

  function post(type, payload) { vscode.postMessage({ type, ...payload }); }
  function run(command, args) { post('runCommand', { command, args }); }

  // Wire buttons
  document.getElementById('newChat').addEventListener('click', () => run('filechat.newChat'));
  document.getElementById('newContextChat').addEventListener('click', () => run('filechat.newContextChat'));

  document.getElementById('addApiConfig').addEventListener('click', () => run('filechat.addApiConfig'));
  document.getElementById('selectApiConfig').addEventListener('click', () => run('filechat.selectApiConfig'));
  document.getElementById('removeApiConfig').addEventListener('click', () => run('filechat.removeApiConfig'));

  document.getElementById('selectConfig1').addEventListener('click', () => run('filechat.selectApiConfigByIndex.0'));
  document.getElementById('selectConfig2').addEventListener('click', () => run('filechat.selectApiConfigByIndex.1'));
  document.getElementById('selectConfig3').addEventListener('click', () => run('filechat.selectApiConfigByIndex.2'));
  document.getElementById('selectConfig4').addEventListener('click', () => run('filechat.selectApiConfigByIndex.3'));
  document.getElementById('selectConfig5').addEventListener('click', () => run('filechat.selectApiConfigByIndex.4'));

  document.getElementById('refreshMcpTools').addEventListener('click', () => run('filechat.refreshMcpTools'));
  document.getElementById('configureMcpServer').addEventListener('click', () => run('filechat.configureMcpServer'));
  document.getElementById('mcpDiagnostics').addEventListener('click', () => run('filechat.mcpDiagnostics'));
  document.getElementById('testSseConnection').addEventListener('click', () => run('filechat.testSseConnection'));

  document.getElementById('insertNextBlock').addEventListener('click', () => run('filechat.insertNextBlock'));
  document.getElementById('resumeStreaming').addEventListener('click', () => run('filechat.resumeStreaming'));
  document.getElementById('cancelStreaming').addEventListener('click', () => run('filechat.cancelStreaming'));

  document.getElementById('insertPrompt').addEventListener('click', () => {
    const val = els.promptSelect.value;
    if (val) run('filechat.insertPrompt', [{ promptId: val }]);
  });

  document.getElementById('refreshAll').addEventListener('click', () => post('refresh'));

  // Update view on state
  window.addEventListener('message', (event) => {
    const { type, state } = event.data || {};
    if (type !== 'state' || !state) return;

    try {
      els.activeConfig.textContent = state.selectedConfig || '(none)';
      // Populate configs
      els.configSelect.innerHTML = '';
      const names = Object.keys(state.apiConfigs || {});
      for (const name of names) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        if (name === state.selectedConfig) opt.selected = true;
        els.configSelect.appendChild(opt);
      }

      // Clicking the select triggers the normal quick pick so validation etc happens
      els.configSelect.onchange = () => {
        const name = els.configSelect.value;
        vscode.postMessage({ type: 'selectApiConfigByName', name });
      };

      // Populate prompts
      els.promptSelect.innerHTML = '';
      for (const p of (state.prompts || [])) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.label;
        els.promptSelect.appendChild(opt);
      }
    } catch (e) {
      // no-op
    }
  });
})();
</script>
</body>
</html>`;
  }
}
