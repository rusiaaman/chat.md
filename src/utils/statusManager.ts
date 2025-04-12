import * as vscode from "vscode";
import { log } from "../extension";

/**
 * Manages status bar items for the chat.md extension
 */
export class StatusManager {
  private static instance: StatusManager;
  private streamingStatusItem: vscode.StatusBarItem;
  private streamingDots: string = "";
  private animationInterval: NodeJS.Timeout | undefined;
  
  // Tracks current status to handle transitions
  private currentStatus: 'idle' | 'streaming' | 'executing' | 'cancelling' = 'idle';

  private constructor() {
    // Create streaming status bar item with higher priority (lower number)
    this.streamingStatusItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      10,
    );
    this.streamingStatusItem.text = "$(check) chat.md: Idle";
    this.streamingStatusItem.tooltip =
      "chat.md is ready. When streaming or executing a tool, click to cancel.";
    this.streamingStatusItem.command = "filechat.cancelStreaming";
    // Always show the status bar item, even in idle state
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
   * Shows the streaming status with an animation
   */
  public showStreamingStatus(): void {
    if (this.animationInterval) {
      clearInterval(this.animationInterval);
    }

    this.currentStatus = 'streaming';
    this.streamingDots = "";
    // Change to streaming state with animation
    this.streamingStatusItem.text = "$(loading~spin) chat.md: Streaming";
    this.streamingStatusItem.tooltip =
      "An AI response is currently streaming. Click to cancel.";
    this.streamingStatusItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground",
    );

    log("Changed to streaming status");

    // Start animation for the dots
    this.animationInterval = setInterval(() => {
      this.updateStreamingAnimation();
    }, 500);
  }
  
  /**
   * Shows the tool execution status
   */
  public showToolExecutionStatus(): void {
    if (this.animationInterval) {
      clearInterval(this.animationInterval);
    }

    this.currentStatus = 'executing';
    this.streamingDots = "";
    // Change to tool execution state with animation
    this.streamingStatusItem.text = "$(tools~spin) chat.md: Executing tool";
    this.streamingStatusItem.tooltip =
      "A tool is currently being executed. Click to cancel.";
    this.streamingStatusItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground",
    );

    log("Changed to tool execution status");
    
    // Start animation for the dots
    this.animationInterval = setInterval(() => {
      this.updateToolExecutionAnimation();
    }, 500);
  }
  
  /**
   * Updates the animation for the tool execution status
   */
  private updateToolExecutionAnimation(): void {
    // Cycle through 1, 2, and 3 dots
    this.streamingDots =
      this.streamingDots.length >= 3 ? "" : this.streamingDots + ".";
    this.streamingStatusItem.text = `$(tools~spin) chat.md: Executing tool${this.streamingDots}`;
  }
  
  /**
   * Shows the tool cancellation status
   */
  public showToolCancellationStatus(): void {
    if (this.animationInterval) {
      clearInterval(this.animationInterval);
    }

    this.currentStatus = 'cancelling';
    this.streamingDots = "";
    // Change to cancelling state
    this.streamingStatusItem.text = "$(stop-circle) chat.md: Cancelling tool execution";
    this.streamingStatusItem.tooltip =
      "Cancellation requested. The tool may still execute on the server side.";
    this.streamingStatusItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.errorBackground",
    );

    log("Changed to tool cancellation status");
  }

  /**
   * Switches to idle status and stops the animation
   */
  public hideStreamingStatus(): void {
    if (this.animationInterval) {
      clearInterval(this.animationInterval);
      this.animationInterval = undefined;
    }

    this.currentStatus = 'idle';
    // Change to idle state
    this.streamingStatusItem.text = "$(check) chat.md: Idle";
    this.streamingStatusItem.tooltip =
      "chat.md is ready. When streaming or executing a tool, click to cancel.";
    this.streamingStatusItem.backgroundColor = undefined; // Remove background color

    log("Changed to idle status");
  }
  
  /**
   * Get the current status
   */
  public getCurrentStatus(): 'idle' | 'streaming' | 'executing' | 'cancelling' {
    return this.currentStatus;
  }

  /**
   * Updates the animation for the streaming status
   */
  private updateStreamingAnimation(): void {
    // Cycle through 1, 2, and 3 dots
    this.streamingDots =
      this.streamingDots.length >= 3 ? "" : this.streamingDots + ".";
    this.streamingStatusItem.text = `$(loading~spin) chat.md: Streaming${this.streamingDots}`;
  }

  /**
   * Disposes of resources
   */
  public dispose(): void {
    if (this.animationInterval) {
      clearInterval(this.animationInterval);
    }
    this.streamingStatusItem.dispose();
  }
}
