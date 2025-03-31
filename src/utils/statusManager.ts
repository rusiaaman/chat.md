import * as vscode from 'vscode';
import { log } from '../extension';

/**
 * Manages status bar items for the FileChat extension
 */
export class StatusManager {
  private static instance: StatusManager;
  private streamingStatusItem: vscode.StatusBarItem;
  private streamingDots: string = "";
  private animationInterval: NodeJS.Timeout | undefined;

  private constructor() {
    // Create streaming status bar item with higher priority (lower number)
    this.streamingStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10);
    this.streamingStatusItem.text = "$(check) FileChat: Idle";
    this.streamingStatusItem.tooltip = "FileChat is ready. When streaming, click to cancel.";
    this.streamingStatusItem.command = 'filechat.cancelStreaming';
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
    log('Status manager registered');
  }

  /**
   * Shows the streaming status with an animation
   */
  public showStreamingStatus(): void {
    if (this.animationInterval) {
      clearInterval(this.animationInterval);
    }

    this.streamingDots = "";
    // Change to streaming state with animation
    this.streamingStatusItem.text = "$(loading~spin) FileChat: Streaming";
    this.streamingStatusItem.tooltip = "An AI response is currently streaming. Click to cancel.";
    this.streamingStatusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    
    log('Changed to streaming status');

    // Start animation for the dots
    this.animationInterval = setInterval(() => {
      this.updateStreamingAnimation();
    }, 500);
  }

  /**
   * Switches to idle status and stops the animation
   */
  public hideStreamingStatus(): void {
    if (this.animationInterval) {
      clearInterval(this.animationInterval);
      this.animationInterval = undefined;
    }
    
    // Change to idle state
    this.streamingStatusItem.text = "$(check) FileChat: Idle";
    this.streamingStatusItem.tooltip = "FileChat is ready. When streaming, click to cancel.";
    this.streamingStatusItem.backgroundColor = undefined; // Remove background color
    
    log('Changed to idle status');
  }

  /**
   * Updates the animation for the streaming status
   */
  private updateStreamingAnimation(): void {
    // Cycle through 1, 2, and 3 dots
    this.streamingDots = this.streamingDots.length >= 3 ? "" : this.streamingDots + ".";
    this.streamingStatusItem.text = `$(loading~spin) FileChat: Streaming${this.streamingDots}`;
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
