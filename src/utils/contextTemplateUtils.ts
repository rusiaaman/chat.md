import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Generates a chat template with workspace and selection context
 * 
 * @param workspacePath Current workspace folder path or null if none
 * @param filePath Currently active file path or null if none
 * @param selectedText Text selected in the current file or empty string if none
 * @returns Formatted template string for a new chat
 */
export function generateChatTemplate(
  workspacePath: string | null,
  filePath: string | null,
  selectedText: string
): string {
  let template = '# %% user\n\n';
  
  // Add workspace context
  template += `Current workspace dir: \`${workspacePath || 'No workspace open'}\`\n`;
  
  // Add current file context (as plain text, not a link)
  if (filePath) {
    template += `Current working file: ${filePath}\n`;
  } else {
    template += 'No file currently open\n';
  }
  
  // Add selected text if any
  if (selectedText && selectedText.trim()) {
    template += '\nSelected text in the file:\n\n```\n';
    template += selectedText;
    template += '\n```\n';
  }
  
  return template;
}

/**
 * Gets the current context information from VS Code
 * @returns Object containing workspace path, file path, and selected text
 */
export function getCurrentContext(): { 
  workspacePath: string | null, 
  filePath: string | null, 
  selectedText: string 
} {
  // Get workspace folder
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const workspacePath = workspaceFolder ? workspaceFolder.uri.fsPath : null;
  
  // Get active editor and file
  const editor = vscode.window.activeTextEditor;
  const filePath = editor ? editor.document.uri.fsPath : null;
  
  // Get selected text if any
  const selectedText = editor ? editor.document.getText(editor.selection) : '';
  
  return { workspacePath, filePath, selectedText };
}
