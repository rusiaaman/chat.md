import * as vscode from "vscode";
import { log } from "../extension";

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

  private currentConfigName: string | undefined;
  private currentStatus: "idle" | "streaming" | "executing" | "cancelling" =
    "idle";

  private readonly IDLE_TOOLTIP = "Click to select API configuration.";
  private readonly BUSY_TOOLTIP = "Click to cancel the current operation.";

  private constructor() {
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
   * Disposes of resources.
   */
  public dispose(): void {
    this.clearAnimation();
    this.streamingStatusItem.dispose();
  }
}
