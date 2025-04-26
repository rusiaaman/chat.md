import * as vscode from "vscode";
import { log } from "../extension";
import { mcpClientManager } from "../extension";

/**
 * Manages status bar items for the chat.md extension.
 * Displays the current state (Idle, Streaming, Executing, Cancelling) and the selected configuration name.
 * Click action is context-dependent: Select API Config when idle, Cancel otherwise.
 */
export class StatusManager {
  private static instance: StatusManager;
  private streamingStatusItem: vscode.StatusBarItem;
  private streamingDots: string = "";
  private animationInterval: NodeJS.Timeout | undefined;
  private hoverDisposables: vscode.Disposable[] = [];

  private currentConfigName: string | undefined;
  private currentStatus: "idle" | "streaming" | "executing" | "cancelling" =
    "idle";

  private readonly IDLE_TOOLTIP = "Click to select API configuration.";
  private readonly BUSY_TOOLTIP = "Click to cancel the current operation.";

  private constructor() {
    // Create streaming status item
    this.streamingStatusItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      10,
    );
    this.currentConfigName = "Loading...";
    this.setIdleStatus();
    this.streamingStatusItem.show();
  }

  /**
   * Gets the singleton instance of StatusManager
   */
  public static getInstance(): StatusManager {
    if (!StatusManager.instance) {
      StatusManager.instance = new StatusManager();
    }
    return StatusManager.instance;
  }

  /**
   * Registers the status bar item with the extension context
   */
  public register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(this.streamingStatusItem);
    log("Status manager registered");
  }

  /**
   * Updates the stored configuration name.
   * @param name The new configuration name (or undefined if none selected).
   */
  public updateConfigName(name: string | undefined): void {
    this.currentConfigName = name;
    log(`StatusManager: Updated config name to '${name}'`);
  }

  /**
   * Clears any running animation interval.
   */
  private clearAnimation(): void {
    if (this.animationInterval) {
      clearInterval(this.animationInterval);
      this.animationInterval = undefined;
    }
    this.streamingDots = "";
  }

  /**
   * Sets the status bar to the Idle state, including the config name.
   */
  private setIdleStatus(): void {
    this.currentStatus = "idle";
    const configText = this.currentConfigName || "No Config";
    this.streamingStatusItem.text = `$(check) chat.md: Idle (${configText})`;
    this.streamingStatusItem.tooltip = this.IDLE_TOOLTIP;
    this.streamingStatusItem.command = "filechat.selectApiConfig";
    this.streamingStatusItem.backgroundColor = undefined;
    log(`Changed to idle status (Config: ${configText})`);
  }

  /**
   * Shows the streaming status with an animation, including the config name.
   */
  public showStreamingStatus(): void {
    this.clearAnimation();
    this.currentStatus = "streaming";
    const configText = this.currentConfigName || "No Config";
    this.streamingStatusItem.text = `$(loading~spin) chat.md: Streaming (${configText})`;
    this.streamingStatusItem.tooltip = `Streaming... ${this.BUSY_TOOLTIP}`;
    this.streamingStatusItem.command = "filechat.cancelStreaming";
    this.streamingStatusItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground",
    );
    log(`Changed to streaming status (Config: ${configText})`);

    this.animationInterval = setInterval(() => {
      this.updateStreamingAnimation();
    }, 500);
  }

  /**
   * Shows the tool execution status, including the config name.
   */
  public showToolExecutionStatus(): void {
    this.clearAnimation();
    this.currentStatus = "executing";
    const configText = this.currentConfigName || "No Config";
    this.streamingStatusItem.text = `$(tools~spin) chat.md: Executing tool (${configText})`;
    this.streamingStatusItem.tooltip = `Executing tool... ${this.BUSY_TOOLTIP}`;
    this.streamingStatusItem.command = "filechat.cancelStreaming";
    this.streamingStatusItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground",
    );
    log(`Changed to tool execution status (Config: ${configText})`);

    this.animationInterval = setInterval(() => {
      this.updateToolExecutionAnimation();
    }, 500);
  }

  /**
   * Updates the animation for the tool execution status, including the config name.
   */
  private updateToolExecutionAnimation(): void {
    this.streamingDots =
      this.streamingDots.length >= 3 ? "" : this.streamingDots + ".";
    const configText = this.currentConfigName || "No Config";
    this.streamingStatusItem.text = `$(tools~spin) chat.md: Executing tool${this.streamingDots} (${configText})`;
  }

  /**
   * Shows the tool cancellation status, including the config name.
   */
  public showToolCancellationStatus(): void {
    this.clearAnimation();
    this.currentStatus = "cancelling";
    const configText = this.currentConfigName || "No Config";
    this.streamingStatusItem.text = `$(stop-circle) chat.md: Cancelling (${configText})`;
    this.streamingStatusItem.tooltip = `Cancellation requested... ${this.BUSY_TOOLTIP}`;
    this.streamingStatusItem.command = "filechat.cancelStreaming";
    this.streamingStatusItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.errorBackground",
    );
    log(`Changed to tool cancellation status (Config: ${configText})`);
  }

  /**
   * Switches to idle status and stops the animation.
   */
  public hideStreamingStatus(): void {
    this.clearAnimation();
    this.setIdleStatus();
  }

  /**
   * Returns the current status.
   */
  public getCurrentStatus(): "idle" | "streaming" | "executing" | "cancelling" {
    return this.currentStatus;
  }

  /**
   * Updates the animation for the streaming status, including the config name.
   */
  private updateStreamingAnimation(): void {
    this.streamingDots =
      this.streamingDots.length >= 3 ? "" : this.streamingDots + ".";
    const configText = this.currentConfigName || "No Config";
    this.streamingStatusItem.text = `$(loading~spin) chat.md: Streaming${this.streamingDots} (${configText})`;
  }

  /**
   * Sets up tooltip and hover handler for MCP prompts
   * @param count The number of available prompts
   */
  public setupPromptHover(count: number): void {
    try {
      // Create a rich markdown tooltip
      const tooltipMarkdown = new vscode.MarkdownString();
      tooltipMarkdown.isTrusted = true; // Enable command URIs
      tooltipMarkdown.supportHtml = true; // Enable HTML for better formatting
      
      // Add the standard tooltip text
      tooltipMarkdown.appendMarkdown(`**${this.IDLE_TOOLTIP}**\n\n`);
      tooltipMarkdown.appendMarkdown(`---\n\n`);
      
      // Get all connected MCP servers and their prompts
      const groupedPrompts = mcpClientManager.getGroupedPrompts();
      const connectedServers = mcpClientManager.getConnectedServers();
      
      // Add header showing connected servers
      tooltipMarkdown.appendMarkdown(`**Connected MCP Servers:**\n\n`);
      
      // List all connected servers
      if (connectedServers.length > 0) {
        for (const serverId of connectedServers) {
          tooltipMarkdown.appendMarkdown(`- **${serverId}**\n`);
        }
        tooltipMarkdown.appendMarkdown(`\n`);
      } else {
        tooltipMarkdown.appendMarkdown(`*No servers currently connected*\n\n`);
      }
      
      // Add header for available prompts
      if (count > 0) {
        tooltipMarkdown.appendMarkdown(`---\n\n`);
        tooltipMarkdown.appendMarkdown(`**${count} MCP Prompts Available:**\n\n`);
        
        // Add prompts from each server
        for (const [serverId, promptMap] of groupedPrompts.entries()) {
          if (promptMap.size === 0) continue;
          
          tooltipMarkdown.appendMarkdown(`**${serverId}**\n\n`);
          
          // Show up to 5 prompts per server in the tooltip
          const promptEntries = Array.from(promptMap.entries()).slice(0, 5);
          for (const [promptName, prompt] of promptEntries) {
            const fullPromptId = `${serverId}.${promptName}`;
            // Create a command URI that will insert this prompt
            tooltipMarkdown.appendMarkdown(`- [${promptName}](command:filechat.insertPrompt?${encodeURIComponent(JSON.stringify({promptId: fullPromptId}))})`);
            
            // Show a short description if available
            if (prompt.description) {
              tooltipMarkdown.appendMarkdown(` - ${prompt.description.substring(0, 30)}${prompt.description.length > 30 ? '...' : ''}`);
            }
            
            tooltipMarkdown.appendMarkdown(`\n`);
          }
          
          // If there are more prompts than we're showing
          if (promptMap.size > 5) {
            tooltipMarkdown.appendMarkdown(`- *${promptMap.size - 5} more prompts...*\n`);
          }
          
          tooltipMarkdown.appendMarkdown(`\n`);
        }
      } else {
        tooltipMarkdown.appendMarkdown(`*No prompts available*\n\n`);
      }
        
      // Add a link to show all prompts
      tooltipMarkdown.appendMarkdown(`---\n\n`);
      tooltipMarkdown.appendMarkdown(`[Show All Prompts](command:filechat.showPromptsHover)`);
      
      // Set the tooltip
      this.streamingStatusItem.tooltip = tooltipMarkdown;
      
      log(`Created rich tooltip with server list and ${count} prompts`);
    } catch (error) {
      log(`Error creating prompt tooltip: ${error}`);
      // Fallback to simple text tooltip
      const currentTooltip = this.IDLE_TOOLTIP;
      this.streamingStatusItem.tooltip = `${currentTooltip}\nHover to see connected servers and available MCP prompts.`;
    }
  }

  /**
   * Disposes of resources.
   */
  public dispose(): void {
    this.clearAnimation();
    this.streamingStatusItem.dispose();
    
    // Dispose of any hover-related disposables
    for (const disposable of this.hoverDisposables) {
      disposable.dispose();
    }
    this.hoverDisposables = [];
  }
}
