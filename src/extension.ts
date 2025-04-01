import * as vscode from 'vscode';
import * as path from 'path';
import { DocumentListener } from './listener';
import {
  getAnthropicApiKey,
  setAnthropicApiKey, 
  getApiKey, 
  setApiKey, 
  getProvider, 
  setProvider,
  getModelName,
  setModelName,
  getBaseUrl,
  setBaseUrl
} from './config';
import { getBlockInfoAtPosition } from './parser'; // Import the new function
import { McpClientManager, McpServerConfig } from './mcpClient';
import { StatusManager } from './utils/statusManager';

// Map to keep track of active document listeners
const documentListeners = new Map<string, vscode.Disposable>();

// Map to keep track of document listener instances
// This allows access to listener methods like getActiveStreamer()
const documentListenerInstances = new Map<string, DocumentListener>();

// Output channel for logging
export const outputChannel = vscode.window.createOutputChannel('FileChat');

// Create MCP client manager
export const mcpClientManager = new McpClientManager();

// Status manager for handling status bar items
export const statusManager = StatusManager.getInstance();

// Helper function for logging
export function log(message: string): void {
  outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
  // Logging happens without showing the output channel automatically
}

/**
 * Updates the streaming status bar based on active document and streaming state
 */
export function updateStreamingStatusBar(): void {
  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor && activeEditor.document.fileName.endsWith('.chat.md')) {
    const streamer = getActiveStreamerForDocument(activeEditor.document);
    if (streamer && streamer.isActive) {
      statusManager.showStreamingStatus();
    } else {
      statusManager.hideStreamingStatus();
    }
  } else {
    // Still show idle status even when not in a chat document
    statusManager.hideStreamingStatus();
  }
}

/**
 * Activate the extension
 */
/**
 * Initialize MCP clients from configuration
 */
async function initializeMcpClients(): Promise<void> {
  try {
    const mcpServers = vscode.workspace.getConfiguration().get('filechat.mcpServers') as Record<string, McpServerConfig> || {};
    log(`Initializing ${Object.keys(mcpServers).length} MCP servers from configuration`);
    
    await mcpClientManager.initializeClients(mcpServers);
    log('MCP clients initialized successfully');
  } catch (error) {
    log(`Error initializing MCP clients: ${error}`);
    vscode.window.showErrorMessage(`Failed to initialize MCP servers: ${error}`);
  }
}

export function activate(context: vscode.ExtensionContext) {
  log('FileChat extension is now active');
  
  // Initialize MCP clients
  void initializeMcpClients();
  
  // Register status manager
  statusManager.register(context);
  
  // Register for .chat.md files
  const selector: vscode.DocumentSelector = { pattern: '**/*.chat.md' };
  
  // Set up listeners for currently open chat files
  for (const document of vscode.workspace.textDocuments) {
    setupDocumentListener(document, context);
  }
  
  // Register events for updating the status bar
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      updateStreamingStatusBar();
    })
  );
  
  // Update status bar initially
  updateStreamingStatusBar();
  
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
        documentListenerInstances.delete(key);
      }
    })
  );
  
  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('filechat.cancelStreaming', () => {
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor && activeEditor.document.fileName.endsWith('.chat.md')) {
        const streamer = getActiveStreamerForDocument(activeEditor.document);
        if (streamer && streamer.isActive && streamer.cancel) {
          streamer.cancel();
          vscode.window.showInformationMessage('FileChat streaming cancelled');
          updateStreamingStatusBar();
        }
      }
    }),
    
    vscode.commands.registerCommand('filechat.refreshMcpTools', async () => {
      await initializeMcpClients();
      vscode.window.showInformationMessage('MCP tools refreshed successfully');
    }),
    
    vscode.commands.registerCommand('filechat.newChat', async () => {
      // Create a new chat file
      const document = await vscode.workspace.openTextDocument({
        content: '# %% user\n',
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
      // Get current provider and key
      const currentProvider = getProvider();
      const currentKey = getApiKey() || (currentProvider === 'anthropic' ? getAnthropicApiKey() : undefined);
      
      // First, let user select the provider
      const providerOptions = ['anthropic', 'openai'];
      const selectedProvider = await vscode.window.showQuickPick(providerOptions, {
        placeHolder: 'Select AI provider',
        title: 'Configure Chat Markdown API',
        canPickMany: false,
        ignoreFocusOut: true
      });
      
      if (!selectedProvider) {
        return; // User cancelled
      }
      
      // Save provider setting
      await setProvider(selectedProvider);
      
      // Then get API key
      const message = currentKey 
        ? `Your ${selectedProvider} API key is configured. Enter a new key to update it.` 
        : `Enter your ${selectedProvider} API key:`;
      
      const apiKey = await vscode.window.showInputBox({
        prompt: message,
        password: true,
        value: currentKey
      });
      
      if (apiKey !== undefined) {  // Undefined means user cancelled
        await setApiKey(apiKey);
        
        // For backward compatibility, also set Anthropic key
        if (selectedProvider === 'anthropic') {
          await setAnthropicApiKey(apiKey);
        }
        
        vscode.window.showInformationMessage(
          apiKey ? `${selectedProvider} API key configured successfully` : `${selectedProvider} API key cleared`
        );
        
        // Listen for configuration changes
        context.subscriptions.push(
          vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('filechat.mcpServers')) {
              initializeMcpClients();
            }
          })
        );
      }
      
      /**
       * Initialize MCP clients from configuration
       */
      async function initializeMcpClients(): Promise<void> {
        try {
          const mcpServers = vscode.workspace.getConfiguration().get('filechat.mcpServers') as Record<string, McpServerConfig> || {};
          log(`Initializing ${Object.keys(mcpServers).length} MCP servers from configuration`);
          
          await mcpClientManager.initializeClients(mcpServers);
          log('MCP clients initialized successfully');
        } catch (error) {
          log(`Error initializing MCP clients: ${error}`);
          vscode.window.showErrorMessage(`Failed to initialize MCP servers: ${error}`);
        }
      }
    }),
    
    vscode.commands.registerCommand('filechat.configureModel', async () => {
      // Get current provider and model
      const provider = getProvider();
      const currentModel = getModelName();
      
      // Show different default suggestions based on provider
      let modelSuggestions: string[] = [];
      if (provider === 'anthropic') {
        modelSuggestions = [
          'claude-3-opus-20240229',
          'claude-3-sonnet-20240229',
          'claude-3-haiku-20240307',
          'claude-3-5-sonnet-20240620',
          'claude-3-5-haiku-latest'
        ];
      } else if (provider === 'openai') {
        modelSuggestions = [
          'gpt-4-turbo',
          'gpt-4-vision-preview',
          'gpt-4-32k',
          'gpt-4',
          'gpt-3.5-turbo'
        ];
      }
      
      // Allow custom input or selection from list
      const selectedModel = await vscode.window.showQuickPick(
        ['Custom...', ...modelSuggestions],
        {
          placeHolder: `Select or enter a model for ${provider} (current: ${currentModel || 'default'})`,
          title: 'Configure Chat Markdown Model',
          ignoreFocusOut: true
        }
      );
      
      if (!selectedModel) {
        return; // User cancelled
      }
      
      let modelName = selectedModel;
      
      // If custom option selected, prompt for model name
      if (selectedModel === 'Custom...') {
        modelName = await vscode.window.showInputBox({
          prompt: `Enter model name for ${provider}:`,
          value: currentModel || '',
          ignoreFocusOut: true
        }) || '';
        
        if (!modelName) {
          return; // User cancelled
        }
      }
      
      // Save model setting
      await setModelName(modelName);
      vscode.window.showInformationMessage(`${provider} model set to: ${modelName}`);
    }),
    
    vscode.commands.registerCommand('filechat.configureBaseUrl', async () => {
      // This command only makes sense for OpenAI provider
      const provider = getProvider();
      if (provider !== 'openai') {
        vscode.window.showInformationMessage('Base URL is only used with OpenAI provider. Please switch provider to OpenAI first.');
        return;
      }
      
      const currentBaseUrl = getBaseUrl() || '';
      
      // Provide some examples of compatible APIs
      const baseUrlSuggestions = [
        { label: 'Default OpenAI API', detail: 'https://api.openai.com/v1' },
        { label: 'Azure OpenAI API', detail: 'https://YOUR_RESOURCE_NAME.openai.azure.com/openai/deployments/YOUR_DEPLOYMENT_NAME' },
        { label: 'Google Gemini API', detail: 'https://generativelanguage.googleapis.com/v1beta/openai' },
        { label: 'Custom...', detail: 'Enter a custom base URL' }
      ];
      
      const selectedOption = await vscode.window.showQuickPick(baseUrlSuggestions, {
        placeHolder: 'Select or enter base URL for OpenAI-compatible API',
        title: 'Configure OpenAI-Compatible Base URL',
        ignoreFocusOut: true
      });
      
      if (!selectedOption) {
        return; // User cancelled
      }
      
      let baseUrl = selectedOption.detail;
      
      // If custom option selected, prompt for base URL
      if (selectedOption.label === 'Custom...') {
        baseUrl = await vscode.window.showInputBox({
          prompt: 'Enter base URL for OpenAI-compatible API:',
          value: currentBaseUrl,
          ignoreFocusOut: true
        }) || '';
        
        if (!baseUrl) {
          return; // User cancelled
        }
      }
      
      // If user selected default OpenAI API, clear the setting
      if (selectedOption.label === 'Default OpenAI API') {
        await setBaseUrl('');
        vscode.window.showInformationMessage('Using default OpenAI API URL');
      } else {
        // Save base URL setting
        await setBaseUrl(baseUrl);
        vscode.window.showInformationMessage(`OpenAI-compatible base URL set to: ${baseUrl}`);
      }
    }),

   // Register command for Shift+Enter handling
   context.subscriptions.push(
     vscode.commands.registerTextEditorCommand('filechat.insertNextBlock', (textEditor, edit) => {
     const document = textEditor.document;
     // Handle multiple selections, though primary focus is the active cursor
     textEditor.selections.forEach(selection => {
       const position = selection.active;
       log(`Shift+Enter pressed at Line: ${position.line}, Character: ${position.character}`);

       const blockInfo = getBlockInfoAtPosition(document, position);
       log(`Current block type: ${blockInfo.type || 'none'}`);

       let textToInsert = "";

       switch (blockInfo.type) {
         case 'user':
           textToInsert = "\n# %% assistant\n";
           break;
         case 'assistant':
           textToInsert = "\n# %% user\n";
           break;
         case 'tool_execute':
           textToInsert = "\n# %% assistant\n"; // As per requirement
           break;
         default: // No block found before cursor, or error
           textToInsert = "\n# %% user\n"; // As per requirement
           break;
       }

       log(`Inserting text: "${textToInsert.replace(/\n/g, '\\n')}"`);
       // Insert the text at the current cursor position
       edit.insert(position, textToInsert);
     });

     // Optional: Ensure the cursor moves to the end of the inserted text
     // This happens automatically with simple inserts usually, but can be forced if needed.
     // Example (might need adjustment based on exact behavior):
     // const newPosition = textEditor.document.positionAt(textEditor.document.offsetAt(position) + textToInsert.length);
     // textEditor.selection = new vscode.Selection(newPosition, newPosition);
     // textEditor.revealRange(new vscode.Range(newPosition, newPosition));
   }))
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
      documentListenerInstances.set(key, listener);
      
      // Add to context for cleanup
      context.subscriptions.push(disposable);
    }
  }
}

/**
 * Gets the active streamer for a document if it exists
 * @param document The document to get the streamer for
 * @returns The active streamer state if one exists, undefined otherwise
 */
export function getActiveStreamerForDocument(document: vscode.TextDocument): import('./types').StreamerState | undefined {
  const key = document.uri.toString();
  const listener = documentListenerInstances.get(key);
  if (listener) {
    return listener.getActiveStreamer();
  }
  return undefined;
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
  documentListenerInstances.clear();
  
  // Dispose of status manager
  statusManager.dispose();
}