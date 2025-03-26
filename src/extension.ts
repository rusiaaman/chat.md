import * as vscode from 'vscode';
import * as path from 'path';
import { DocumentListener } from './listener';
import { getAnthropicApiKey, setAnthropicApiKey } from './config';

// Map to keep track of active document listeners
const documentListeners = new Map<string, vscode.Disposable>();

// Output channel for logging
export const outputChannel = vscode.window.createOutputChannel('FileChat');

// Helper function for logging
export function log(message: string): void {
  outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
  // Make sure the output channel is visible
  outputChannel.show(true);
}

/**
 * Activate the extension
 */
export function activate(context: vscode.ExtensionContext) {
  log('FileChat extension is now active');
  
  // Register for .chat.md files
  const selector: vscode.DocumentSelector = { pattern: '**/*.chat.md' };
  
  // Set up listeners for currently open chat files
  for (const document of vscode.workspace.textDocuments) {
    setupDocumentListener(document, context);
  }
  
  // Listen for newly opened documents
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(document => {
      setupDocumentListener(document, context);
    })
  );
  
  // Listen for document closes to clean up listeners
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument(document => {
      const key = document.uri.toString();
      if (documentListeners.has(key)) {
        documentListeners.get(key)!.dispose();
        documentListeners.delete(key);
      }
    })
  );
  
  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('filechat.newChat', async () => {
      // Create a new chat file
      const document = await vscode.workspace.openTextDocument({
        content: '#%% user\n',
        language: 'markdown'
      });
      
      await vscode.window.showTextDocument(document);
      
      // Save the file with .chat.md extension
      const defaultPath = path.join(
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '~',
        'new.chat.md'
      );
      
      const saveUri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(defaultPath),
        filters: { 'Chat Markdown': ['chat.md'] }
      });
      
      if (saveUri) {
        await vscode.workspace.fs.writeFile(saveUri, Buffer.from(document.getText()));
        const savedDoc = await vscode.workspace.openTextDocument(saveUri);
        await vscode.window.showTextDocument(savedDoc);
      }
    }),
    
    vscode.commands.registerCommand('filechat.configureApi', async () => {
      // Check current key
      const currentKey = getAnthropicApiKey();
      const message = currentKey 
        ? 'Your Anthropic API key is configured. Enter a new key to update it.' 
        : 'Enter your Anthropic API key:';
      
      const apiKey = await vscode.window.showInputBox({
        prompt: message,
        password: true,
        value: currentKey
      });
      
      if (apiKey !== undefined) {  // Undefined means user cancelled
        await setAnthropicApiKey(apiKey);
        vscode.window.showInformationMessage(
          apiKey ? 'Anthropic API key configured successfully' : 'Anthropic API key cleared'
        );
      }
    })
  );
}

/**
 * Sets up a document listener for a specific document
 */
function setupDocumentListener(document: vscode.TextDocument, context: vscode.ExtensionContext) {
  if (document.fileName.endsWith('.chat.md')) {
    const key = document.uri.toString();
    
    // Don't set up duplicates
    if (!documentListeners.has(key)) {
      // Make sure the document is shown in an editor
      // This helps ensure document edits can be applied
      vscode.window.showTextDocument(document, { preview: false })
        .then(() => {
          log(`Document shown in editor: ${document.fileName}`);
        }, (err: Error) => {
          log(`Error showing document: ${err}`);
        });
      
      const listener = new DocumentListener(document);
      const disposable = listener.startListening();
      documentListeners.set(key, disposable);
      
      // Add to context for cleanup
      context.subscriptions.push(disposable);
    }
  }
}

/**
 * Deactivate the extension
 */
export function deactivate() {
  // Clean up happens automatically through disposables
  documentListeners.forEach(disposable => {
    disposable.dispose();
  });
  documentListeners.clear();
}