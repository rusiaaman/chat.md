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
export function getChatStateDirectory(): string {
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
  const chatDir = path.join(baseDir, 'vscode-filechat', 'chats');
  
  // Ensure the directory exists
  ensureDirectoryExists(chatDir);
  
  return chatDir;
}

/**
 * Generates a unique filename for a new chat
 * Format: chat-YYYYMMDD-HHmmss-RANDOM.chat.md
 */
export function generateChatFilename(): string {
  // Get current date and time
  const now = new Date();
  const timestamp = now.toISOString()
    .replace(/[-:]/g, '')
    .replace(/T/, '-')
    .replace(/\..+Z$/, '');
  
  // Generate a random string for uniqueness
  const randomStr = Math.random().toString(36).substring(2, 8);
  
  return `chat-${timestamp.substring(0, 15)}-${randomStr}.chat.md`;
}

/**
 * Generates the full path for a new chat file
 */
export function getNewChatFilePath(): string {
  const chatDir = getChatStateDirectory();
  const filename = generateChatFilename();
  return path.join(chatDir, filename);
}
