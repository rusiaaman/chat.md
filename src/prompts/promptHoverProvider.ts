import * as vscode from 'vscode';
import { mcpClientManager } from '../extension';
import { log } from '../extension';
import { insertPrompt } from './promptExecutor';

export class PromptHoverProvider {
  private statusBarItem: vscode.StatusBarItem;
  private hoverDisposable: vscode.Disposable | undefined;
  private popupPanel: vscode.WebviewPanel | undefined;
  private groupedPrompts: Map<string, Map<string, any>>;

  constructor(statusBarItem: vscode.StatusBarItem) {
    this.statusBarItem = statusBarItem;
    this.groupedPrompts = new Map();
    this.registerHoverEvent();
  }

  /**
   * Registers a hover event on the status bar item
   */
  private registerHoverEvent() {
    // Currently VS Code does not provide direct API to track hover events on status bar items
    // Instead, we'll register a command for the status bar item to open a popup panel
    this.statusBarItem.command = 'filechat.showPrompts';
  }

  /**
   * Shows a popup panel with the list of available prompts
   */
  public async showPromptsPanel() {
    // Refresh the grouped prompts
    this.groupedPrompts = mcpClientManager.getGroupedPrompts();
    
    // If no prompts are available, show a message
    if (this.groupedPrompts.size === 0) {
      vscode.window.showInformationMessage('No prompts are available. Ensure your MCP server supports prompts.');
      return;
    }

    // Create a webview panel positioned near the status bar
    const panel = vscode.window.createWebviewPanel(
      'promptSelector',
      'Available Prompts',
      {
        viewColumn: vscode.ViewColumn.Active,
        preserveFocus: true
      },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: []
      }
    );

    // Set the panel's HTML content
    panel.webview.html = this.getPromptListHtml();

    // Handle messages from the webview
    panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case 'insertPrompt':
            // Parse the prompt ID in the format "serverName.promptName"
            const [serverId, promptName] = message.promptId.split('.');
            
            // Find the prompt object
            const promptMap = this.groupedPrompts.get(serverId);
            if (promptMap) {
              const prompt = promptMap.get(promptName);
              if (prompt) {
                // Insert the prompt at the cursor position
                await insertPrompt(message.promptId, prompt);
              }
            }
            
            // Close the panel after insertion
            panel.dispose();
            break;
        }
      },
      undefined,
      []
    );

    // Position the panel at the bottom of the screen
    // (near the status bar, but exact positioning is not possible)
    // Store the panel reference to dispose it later
    this.popupPanel = panel;

    // Dispose the panel when it's closed
    panel.onDidDispose(() => {
      this.popupPanel = undefined;
    });
  }

  /**
   * Generates the HTML content for the prompt list
   */
  private getPromptListHtml(): string {
    // Build HTML with grouped prompts
    let promptListHtml = '';
    let anyPrompts = false;

    for (const [serverId, promptMap] of this.groupedPrompts.entries()) {
      if (promptMap.size === 0) {
        continue;
      }

      anyPrompts = true;
      promptListHtml += `<h3>${serverId}</h3>`;
      promptListHtml += '<div class="prompt-group">';
      
      for (const [promptName, prompt] of promptMap.entries()) {
        // Format arguments string if any
        let argsStr = '';
        if (prompt.arguments && prompt.arguments.length > 0) {
          argsStr = `<span class="args">Args: ${prompt.arguments.map((arg: any) => 
            `${arg.name}${arg.required ? '*' : ''}`).join(', ')}</span>`;
        }

        // Create a prompt entry with description and click handler
        promptListHtml += `
          <div class="prompt-item" data-prompt-id="${serverId}.${promptName}">
            <div class="prompt-name">${promptName}</div>
            <div class="prompt-desc">${prompt.description || 'No description'}</div>
            ${argsStr}
          </div>
        `;
      }
      
      promptListHtml += '</div>';
    }

    if (!anyPrompts) {
      promptListHtml = '<p>No prompts available. Ensure your MCP server supports prompts.</p>';
    }

    // Full HTML with styles and script
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Available Prompts</title>
        <style>
          body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            padding: 10px;
            margin: 0;
            max-height: 400px;
            overflow-y: auto;
          }
          h3 {
            margin-top: 10px;
            margin-bottom: 5px;
            border-bottom: 1px solid var(--vscode-panel-border);
            padding-bottom: 5px;
            color: var(--vscode-symbolIcon-classForeground);
          }
          .prompt-group {
            margin-bottom: 15px;
          }
          .prompt-item {
            padding: 8px;
            margin-bottom: 5px;
            border-radius: 3px;
            background-color: var(--vscode-editor-lineHighlightBackground);
            cursor: pointer;
            transition: background-color 0.2s;
          }
          .prompt-item:hover {
            background-color: var(--vscode-list-hoverBackground);
          }
          .prompt-name {
            font-weight: bold;
            color: var(--vscode-symbolIcon-functionForeground);
          }
          .prompt-desc {
            margin-top: 3px;
            font-size: 0.9em;
            color: var(--vscode-descriptionForeground);
          }
          .args {
            display: block;
            margin-top: 3px;
            font-size: 0.85em;
            color: var(--vscode-editorCodeLens-foreground);
          }
        </style>
      </head>
      <body>
        <h2>Available Prompts</h2>
        ${promptListHtml}
        
        <script>
          (function() {
            // Get VS Code API
            const vscode = acquireVsCodeApi();
            
            // Add click listeners to prompt items
            document.querySelectorAll('.prompt-item').forEach(item => {
              item.addEventListener('click', () => {
                const promptId = item.getAttribute('data-prompt-id');
                vscode.postMessage({
                  command: 'insertPrompt',
                  promptId: promptId
                });
              });
            });
          })();
        </script>
      </body>
      </html>
    `;
  }

  /**
   * Disposes of resources
   */
  public dispose() {
    if (this.hoverDisposable) {
      this.hoverDisposable.dispose();
      this.hoverDisposable = undefined;
    }
    
    if (this.popupPanel) {
      this.popupPanel.dispose();
      this.popupPanel = undefined;
    }
  }
}
