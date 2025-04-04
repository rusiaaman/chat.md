import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { DocumentListener } from './listener';
import {
  getApiKey,
  getProvider,
  getModelName,
  getBaseUrl,
  getApiConfigs,
  getSelectedConfig,
  getSelectedConfigName,
  setSelectedConfig,
  setApiConfig,
  removeApiConfig,
  ApiConfig
} from './config';
import { getBlockInfoAtPosition } from './parser';
import { McpClientManager, McpServerConfig } from './mcpClient';
import { StatusManager } from './utils/statusManager';
import { getNewChatFilePath } from './utils/chatDirUtils';
import { generateChatTemplate, getCurrentContext } from './utils/contextTemplateUtils';

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
  
  // Check if an API configuration is selected, prompt to configure if not
  checkApiConfiguration();
  
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
    
    vscode.commands.registerCommand('filechat.newContextChat', async () => {
      try {
        // Get current context (workspace, file, selection)
        const context = getCurrentContext();
        
        // Generate chat template with context
        const template = generateChatTemplate(
          context.workspacePath,
          context.filePath,
          context.selectedText
        );
        
        // Get file path in XDG directory
        const chatFilePath = getNewChatFilePath();
        
        // Create the file
        fs.writeFileSync(chatFilePath, template, 'utf8');
        
        // Open the file in editor
        const uri = vscode.Uri.file(chatFilePath);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc);
        
        log(`Created new context chat at: ${chatFilePath}`);
        vscode.window.setStatusBarMessage('Created new context chat', 3000);
      } catch (error) {
        log(`Error creating context chat: ${error}`);
        vscode.window.showErrorMessage(`Failed to create context chat: ${error}`);
      }
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
    
    vscode.commands.registerCommand('filechat.addApiConfig', async () => {
      // Get a name for the configuration
      const configName = await vscode.window.showInputBox({
        placeHolder: 'Enter a name for this configuration',
        prompt: 'Configuration name (e.g., "gemini-openai", "claude-pro")',
        validateInput: value => {
          return value && value.trim() !== '' ? null : 'Configuration name cannot be empty';
        }
      });
      
      if (!configName) {
        return; // User cancelled
      }
      
      // Check if config already exists
      const configs = getApiConfigs();
      const existingConfig = configs[configName];
      
      // Get provider type
      const providerOptions = ['anthropic', 'openai'];
      const selectedProvider = await vscode.window.showQuickPick(providerOptions, {
        placeHolder: 'Select AI provider',
        title: 'Configure API Type',
        canPickMany: false,
        ignoreFocusOut: true
      });
      
      if (!selectedProvider) {
        return; // User cancelled
      }
      
      // Get API key
      const apiKey = await vscode.window.showInputBox({
        prompt: `Enter your ${selectedProvider} API key:`,
        password: true,
        value: existingConfig?.apiKey || '',
        validateInput: value => {
          return value && value.trim() !== '' ? null : 'API key cannot be empty';
        }
      });
      
      if (!apiKey) {
        return; // User cancelled
      }
      
      // Get model name (optional)
      let modelSuggestions: string[] = [];
      if (selectedProvider === 'anthropic') {
        modelSuggestions = [
          'claude-3-opus-20240229',
          'claude-3-sonnet-20240229',
          'claude-3-haiku-20240307',
          'claude-3-5-sonnet-20240620',
          'claude-3-5-haiku-latest'
        ];
      } else if (selectedProvider === 'openai') {
        modelSuggestions = [
          'gpt-4-turbo',
          'gpt-4-vision-preview',
          'gpt-4-32k',
          'gpt-4',
          'gpt-3.5-turbo',
          'gemini-2.5-pro-exp-03-25'
        ];
      }
      
      const selectedModel = await vscode.window.showQuickPick(
        ['Custom...', ...modelSuggestions],
        {
          placeHolder: 'Select or enter a model name',
          title: 'Configure Model',
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
          prompt: 'Enter custom model name:',
          value: existingConfig?.model_name || '',
        }) || '';
        
        if (!modelName) {
          return; // User cancelled
        }
      }
      
      // Get base URL (only if OpenAI or custom option selected)
      let baseUrl = '';
      
      if (selectedProvider === 'openai') {
        const baseUrlSuggestions = [
          { label: 'Default OpenAI API', detail: '' },
          { label: 'Azure OpenAI API', detail: 'https://YOUR_RESOURCE_NAME.openai.azure.com/openai/deployments/YOUR_DEPLOYMENT_NAME' },
          { label: 'Google Gemini API', detail: 'https://generativelanguage.googleapis.com/v1beta/openai/' },
          { label: 'Custom...', detail: 'Enter a custom base URL' }
        ];
        
        const selectedOption = await vscode.window.showQuickPick(baseUrlSuggestions, {
          placeHolder: 'Select or enter base URL for OpenAI-compatible API',
          title: 'Configure Base URL',
          ignoreFocusOut: true
        });
        
        if (!selectedOption) {
          return; // User cancelled
        }
        
        if (selectedOption.label === 'Custom...') {
          baseUrl = await vscode.window.showInputBox({
            prompt: 'Enter base URL for OpenAI-compatible API:',
            value: existingConfig?.base_url || '',
          }) || '';
          
          if (baseUrl === undefined) {
            return; // User cancelled
          }
        } else {
          baseUrl = selectedOption.detail;
        }
      }
      
      // Create and save the configuration
      const config: ApiConfig = {
        type: selectedProvider as 'anthropic' | 'openai',
        apiKey,
        model_name: modelName || undefined,
        base_url: baseUrl || undefined
      };
      
      await setApiConfig(configName, config);
      
      // Ask if user wants to make this the active configuration
      const makeActive = await vscode.window.showQuickPick(
        ['Yes', 'No'],
        {
          placeHolder: 'Make this the active configuration?',
          title: 'Set Active Configuration',
          ignoreFocusOut: true
        }
      );
      
      if (makeActive === 'Yes') {
        await setSelectedConfig(configName);
        vscode.window.showInformationMessage(`Configuration "${configName}" is now active`);
      } else {
        vscode.window.showInformationMessage(`Configuration "${configName}" saved`);
      }
    }),
    
    vscode.commands.registerCommand('filechat.selectApiConfig', async () => {
      const configs = getApiConfigs();
      const configNames = Object.keys(configs);
      
      if (configNames.length === 0) {
        const createNew = await vscode.window.showInformationMessage(
          'No API configurations found. Would you like to create one now?',
          'Yes', 'No'
        );
        
        if (createNew === 'Yes') {
          await vscode.commands.executeCommand('filechat.addApiConfig');
        }
        return;
      }
      
      // Build items with description of each config
      const configItems = configNames.map(name => {
        const config = configs[name];
        return {
          label: name,
          description: `${config.type} - ${config.model_name || 'default model'}`,
          detail: config.base_url ? `Base URL: ${config.base_url}` : undefined
        };
      });
      
      const selectedItem = await vscode.window.showQuickPick(
        configItems,
        {
          placeHolder: 'Select API configuration',
          title: 'Select Active Configuration',
          ignoreFocusOut: true
        }
      );
      
      if (!selectedItem) {
        return; // User cancelled
      }
      
      await setSelectedConfig(selectedItem.label);
      vscode.window.showInformationMessage(`Configuration "${selectedItem.label}" is now active`);
    }),
    
    vscode.commands.registerCommand('filechat.removeApiConfig', async () => {
      const configs = getApiConfigs();
      const configNames = Object.keys(configs);
      
      if (configNames.length === 0) {
        vscode.window.showInformationMessage('No API configurations found.');
        return;
      }
      
      // Get the selected config name for highlighting
      const selectedConfigName = getSelectedConfigName();
      
      // Build items with description of each config
      const configItems = configNames.map(name => {
        const config = configs[name];
        const isSelected = name === selectedConfigName;
        
        return {
          label: name,
          description: `${config.type} - ${config.model_name || 'default model'}${isSelected ? ' (active)' : ''}`,
          detail: config.base_url ? `Base URL: ${config.base_url}` : undefined
        };
      });
      
      const selectedItem = await vscode.window.showQuickPick(
        configItems,
        {
          placeHolder: 'Select API configuration to remove',
          title: 'Remove Configuration',
          ignoreFocusOut: true
        }
      );
      
      if (!selectedItem) {
        return; // User cancelled
      }
      
      // Ask for confirmation
      const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to remove configuration "${selectedItem.label}"?`,
        'Yes', 'No'
      );
      
      if (confirm !== 'Yes') {
        return;
      }
      
      const removed = await removeApiConfig(selectedItem.label);
      
      if (removed) {
        vscode.window.showInformationMessage(`Configuration "${selectedItem.label}" has been removed.`);
        
        // If it was the active config, suggest selecting another one
        if (selectedItem.label === selectedConfigName && configNames.length > 1) {
          const selectAnother = await vscode.window.showInformationMessage(
            'The active configuration was removed. Would you like to select another one?',
            'Yes', 'No'
          );
          
          if (selectAnother === 'Yes') {
            await vscode.commands.executeCommand('filechat.selectApiConfig');
          }
        }
      } else {
        vscode.window.showErrorMessage(`Failed to remove configuration "${selectedItem.label}".`);
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
 * Checks if an API configuration is selected and properly configured
 * If not, prompts the user to configure one
 */
async function checkApiConfiguration(): Promise<void> {
  try {
    const selectedConfig = getSelectedConfig();
    const apiConfigs = getApiConfigs();
    const configCount = Object.keys(apiConfigs).length;
    
    // If we have configs but none selected, prompt to select one
    if (configCount > 0 && !selectedConfig) {
      const selectNow = await vscode.window.showInformationMessage(
        `You have ${configCount} API configurations but none is selected. Would you like to select one now?`,
        'Yes', 'Later'
      );
      
      if (selectNow === 'Yes') {
        await vscode.commands.executeCommand('filechat.selectApiConfig');
      }
    } 
    // If we have no configs at all, prompt to create one
    else if (configCount === 0) {
      const createNow = await vscode.window.showInformationMessage(
        'No API configurations found. Would you like to add one now?',
        'Yes', 'Later'
      );
      
      if (createNow === 'Yes') {
        await vscode.commands.executeCommand('filechat.addApiConfig');
      }
    }
  } catch (error) {
    log(`Error checking API configuration: ${error}`);
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
  documentListenerInstances.clear();
  
  // Dispose of status manager
  statusManager.dispose();
}