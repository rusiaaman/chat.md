import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { ensureDirectoryExists } from './fileUtils';

/**
 * Gets the XDG-compatible state directory for storing chat files
 * 
 * Following XDG Base Directory Specification:
 * - First checks XDG_STATE_HOME environment variable
 * - Falls back to platform-specific locations:
 *   - Linux/macOS: ~/.local/state
 *   - Windows: %LOCALAPPDATA%
 */
export function getChatStateBaseDirectory(): string {
  // Get base XDG directory according to platform
  let baseDir: string;
  
  // Check XDG_STATE_HOME environment variable first
  if (process.env.XDG_STATE_HOME) {
    baseDir = process.env.XDG_STATE_HOME;
  } else {
    // Use platform-specific default locations
    if (process.platform === 'win32') {
      // Windows: use %LOCALAPPDATA%
      baseDir = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    } else {
      // Linux/macOS: use ~/.local/state
      baseDir = path.join(os.homedir(), '.local', 'state');
    }
  }
  
  // Create app-specific subdirectory
  const chatBaseDir = path.join(baseDir, 'vscode-filechat');
  
  // Ensure the directory exists
  ensureDirectoryExists(chatBaseDir);
  
  return chatBaseDir;
}

/**
 * Generates a unique folder name for a new chat
 * Format: chat-YYYYMMDD-HHmmss-RANDOM
 */
export function generateChatFolderName(): string {
  // Get current date and time
  const now = new Date();
  const timestamp = now.toISOString()
    .replace(/[-:]/g, '')
    .replace(/T/, '-')
    .replace(/\..+Z$/, '');
  
  // Generate a random string for uniqueness
  const randomStr = Math.random().toString(36).substring(2, 8);
  
  return `chat-${timestamp.substring(0, 15)}-${randomStr}`;
}

/**
 * Gets workspace-specific directory for organizing chats
 * 
 * @param workspacePath The path to the current workspace folder
 * @returns Path to workspace-specific chat directory
 */
export function getWorkspaceChatDirectory(workspacePath: string | null): string {
  const baseDir = getChatStateBaseDirectory();
  
  // Determine workspace folder name
  let workspaceFolderName = 'root';
  
  if (workspacePath) {
    // Extract folder name from workspace path
    workspaceFolderName = path.basename(workspacePath);
  }
  
  // Create workspace-specific subdirectory
  const workspaceDir = path.join(baseDir, workspaceFolderName);
  
  // Ensure the directory exists
  ensureDirectoryExists(workspaceDir);
  
  return workspaceDir;
}

/**
 * Generates structured paths for a new chat
 * 
 * @param workspacePath The path to the current workspace folder
 * @returns Object containing directory path, chat folder name, and file path
 */
export function getNewChatPaths(workspacePath: string | null): { 
  chatDir: string, 
  chatFolderName: string, 
  chatFolderPath: string,
  chatFilePath: string 
} {
  // Get workspace-specific directory
  const workspaceDir = getWorkspaceChatDirectory(workspacePath);
  
  // Generate unique chat folder name
  const chatFolderName = generateChatFolderName();
  
  // Create chat-specific folder
  const chatFolderPath = path.join(workspaceDir, chatFolderName);
  ensureDirectoryExists(chatFolderPath);
  
  // Chat file path
  const chatFilePath = path.join(chatFolderPath, 'chat.chat.md');
  
  return {
    chatDir: workspaceDir,
    chatFolderName,
    chatFolderPath,
    chatFilePath
  };
}
