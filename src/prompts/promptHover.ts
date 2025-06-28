import * as vscode from 'vscode';
import { mcpClientManager } from '../extension';
import { log } from '../extension';
import { insertPrompt } from './promptExecutor';

/**
 * This class handles showing a hover widget for prompts when 
 * the user hovers over the status bar
 */
export class PromptHoverHandler {
  private static hoverProvider: vscode.Disposable | undefined;
  private static hoverPanel: vscode.WebviewPanel | undefined;
  private static statusBarElement: any | undefined;
  private static isHovering = false;
  private static timeoutHandle: NodeJS.Timeout | undefined;

  /**
   * Register the hover handler for MCP prompts
   * This is a bit of a hack since VS Code doesn't provide direct API
   * for hover on status bar items.
   * @param context The extension context
   */
  public static register(context: vscode.ExtensionContext): vscode.Disposable[] {
    const disposables: vscode.Disposable[] = [];
    
    // Create a command to show prompts that can be attached to status bar item
    // Check if command already exists to avoid duplicate registration
    try {
      const showPromptsCommand = vscode.commands.registerCommand('filechat.showPromptsHover', async () => {
        log('Command triggered: filechat.showPromptsHover');
        await this.showPromptsList();
      });
      disposables.push(showPromptsCommand);
    } catch (error) {
      // Command likely already registered
      log(`Command 'filechat.showPromptsHover' already exists - using existing registration`);
      // We'll still hook into it through the status bar
    }
    
    // Use status bar click as fallback for hover
    try {
      const clickCommand = vscode.commands.registerCommand('filechat.statusBarPromptClick', async () => {
        log('Status bar clicked, showing prompts');
        await this.showPromptsList();
      });
      disposables.push(clickCommand);
    } catch (error) {
      // Command likely already registered
      log(`Command 'filechat.statusBarPromptClick' already exists - using existing registration`);
    }
    
    // Try to monitor when mouse moves over the status bar
    // This uses DOM events which are unofficial and may break in future VS Code versions
    this.setupStatusBarHover();
    
    return disposables;
  }
  
  /**
   * Sets up hover functionality for the status bar item
   * Note: We can't directly access DOM elements in VS Code extensions,
   * so instead we'll use the command invocation approach
   */
  private static setupStatusBarHover(): void {
    // Instead of trying to add DOM event listeners (which won't work in VS Code extensions),
    // we'll use the VS Code API to show prompts when the status bar item is clicked
    log('Setting up status bar command handling (hover not directly supported by VS Code API)');
    
    // The actual hover functionality will be provided by the rich tooltip
    // we've set up in the StatusManager class using MarkdownString
  }
  
  /**
   * Shows the list of available prompts in a hover panel
   */
  public static async showPromptsList(): Promise<void> {
    // Get all prompts from the MCP client
    const groupedPrompts = mcpClientManager.getGroupedPrompts();
    const totalPrompts = mcpClientManager.getAllPrompts().length;
    const connectedServers = mcpClientManager.getConnectedServers();
    
    // Only show warning if there are no servers connected
    if (connectedServers.length === 0) {
      vscode.window.showInformationMessage('No MCP servers are connected');
      // Continue to show the panel anyway to display the "no servers" message
    }
    
    // If a hover panel is already showing, dispose it
    if (this.hoverPanel) {
      this.hoverPanel.dispose();
      this.hoverPanel = undefined;
    }
    
    // Create a webview panel that looks like a hover widget
    this.hoverPanel = vscode.window.createWebviewPanel(
      'promptHover',
      'MCP Servers and Prompts',
      {
        viewColumn: vscode.ViewColumn.Active,
        preserveFocus: true,
      },
      {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots: []
      }
    );
    
    // Configure the webview to look like a hover widget
    this.hoverPanel.webview.html = this.getPromptsHtml(groupedPrompts);
    
    // Handle messages from the webview
    this.hoverPanel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case 'insertPrompt':
            // Close the panel first to avoid focus issues
            this.hoverPanel?.dispose();
            this.hoverPanel = undefined;
            
            // Parse prompt ID (server.promptName format)
            const parts = message.promptId.split('.');
            if (parts.length !== 2) {
              vscode.window.showErrorMessage(`Invalid prompt ID: ${message.promptId}`);
              return;
            }
            
            const serverId = parts[0];
            const promptName = parts[1];
            
            // Get the prompt object from the server
            const promptMap = groupedPrompts.get(serverId);
            if (!promptMap) {
              vscode.window.showErrorMessage(`Server ${serverId} not found`);
              return;
            }
            
            const prompt = promptMap.get(promptName);
            if (!prompt) {
              vscode.window.showErrorMessage(`Prompt ${promptName} not found on server ${serverId}`);
              return;
            }
            
            // Insert the prompt at the cursor position
            try {
              await insertPrompt(message.promptId, prompt);
            } catch (error) {
              vscode.window.showErrorMessage(`Error inserting prompt: ${error}`);
            }
            break;
        }
      },
      undefined,
      []
    );
    
    // Make the panel look like a hover by removing title bar and making it small
    this.hoverPanel.onDidDispose(() => {
      this.hoverPanel = undefined;
    });
    
    // Position the panel near the status bar (approximate)
    // Note: VS Code doesn't provide exact positioning for webviews
  }
  
  /**
   * Generates the HTML content for the prompts hover panel
   */
  private static getPromptsHtml(
    groupedPrompts: Map<string, Map<string, any>>
  ): string {
    // Get list of connected servers
    const connectedServers = mcpClientManager.getConnectedServers();
    
    // Generate the servers section
    let serversHtml = '';
    serversHtml += `<div class="section-title">Connected MCP Servers</div>`;
    serversHtml += `<div class="server-list">`;
    
    if (connectedServers.length > 0) {
      for (const serverId of connectedServers) {
        serversHtml += `<div class="server-item">${serverId}</div>`;
      }
    } else {
      serversHtml += `<div class="no-servers">No servers currently connected</div>`;
    }
    
    serversHtml += `</div>`;
    
    // Generate the prompts section
    let promptsHtml = '';
    
    if (groupedPrompts.size > 0) {
      promptsHtml += `<div class="section-title">Available Prompts</div>`;
      
      for (const [serverId, promptMap] of groupedPrompts.entries()) {
        if (promptMap.size === 0) continue;
        
        promptsHtml += `<div class="server-group">`;
        promptsHtml += `<div class="server-name">${serverId}</div>`;
        
        for (const [promptName, prompt] of promptMap.entries()) {
          const hasArgs = prompt.arguments && prompt.arguments.length > 0;
          const argsInfo = hasArgs ? 
            `<span class="args">(${prompt.arguments.map((a: any) => a.name).join(', ')})</span>` : 
            '';
          
          promptsHtml += `
            <div class="prompt-item" data-id="${serverId}.${promptName}">
              <div class="prompt-name">${promptName} ${argsInfo}</div>
              <div class="prompt-desc">${prompt.description || ''}</div>
            </div>
          `;
        }
        
        promptsHtml += `</div>`;
      }
    } else {
      promptsHtml += `<div class="no-prompts">No prompts available</div>`;
    }
    
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body {
            font-family: var(--vscode-font-family);
            background-color: var(--vscode-editorHoverWidget-background);
            color: var(--vscode-editorHoverWidget-foreground);
            border: 1px solid var(--vscode-editorHoverWidget-border);
            border-radius: 3px;
            padding: 8px;
            margin: 0;
            max-height: 400px;
            max-width: 400px;
            overflow-y: auto;
            font-size: 13px;
          }
          .section-title {
            font-weight: bold;
            font-size: 14px;
            margin-top: 8px;
            margin-bottom: 8px;
            color: var(--vscode-editorHoverWidget-foreground);
            border-bottom: 1px solid var(--vscode-editorHoverWidget-border);
            padding-bottom: 4px;
          }
          .server-list {
            margin-bottom: 12px;
          }
          .server-item {
            padding: 3px 5px;
            margin-bottom: 3px;
            border-radius: 3px;
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            display: inline-block;
            margin-right: 5px;
            margin-bottom: 5px;
          }
          .no-servers, .no-prompts {
            font-style: italic;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 8px;
          }
          .server-group {
            margin-bottom: 12px;
          }
          .server-name {
            font-weight: bold;
            margin-bottom: 5px;
            color: var(--vscode-editorHoverWidget-foreground);
            border-bottom: 1px solid var(--vscode-editorHoverWidget-border);
            padding-bottom: 3px;
          }
          .prompt-item {
            padding: 5px;
            margin-bottom: 5px;
            cursor: pointer;
            border-radius: 3px;
          }
          .prompt-item:hover {
            background-color: var(--vscode-list-hoverBackground);
          }
          .prompt-name {
            font-weight: bold;
            color: var(--vscode-editor-foreground);
          }
          .args {
            font-size: 12px;
            color: var(--vscode-editorHoverWidget-foreground);
            opacity: 0.8;
          }
          .prompt-desc {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin-top: 2px;
          }
          h3 {
            margin-top: 0;
            margin-bottom: 8px;
            color: var(--vscode-editorHoverWidget-foreground);
          }
        </style>
      </head>
      <body>
        <h3>MCP Servers and Prompts</h3>
        ${serversHtml}
        ${promptsHtml}
        
        <script>
          (function() {
            const vscode = acquireVsCodeApi();
            
            // Add click handlers to all prompt items
            document.querySelectorAll('.prompt-item').forEach(item => {
              item.addEventListener('click', () => {
                const promptId = item.getAttribute('data-id');
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
   * Dispose of all resources
   */
  public static dispose(): void {
    if (this.hoverPanel) {
      this.hoverPanel.dispose();
      this.hoverPanel = undefined;
    }
    
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = undefined;
    }
    
    if (this.statusBarElement) {
      // Remove event listeners if they exist
      if (this.statusBarElement.removeEventListener) {
        try {
          this.statusBarElement.removeEventListener('mouseover', (this as any).onStatusBarHover);
          this.statusBarElement.removeEventListener('mouseout', (this as any).onStatusBarLeave);
        } catch (error) {
          // Ignore errors during cleanup
        }
      }
      this.statusBarElement = undefined;
    }
    
    if (this.hoverProvider) {
      this.hoverProvider.dispose();
      this.hoverProvider = undefined;
    }
  }
}