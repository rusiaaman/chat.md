import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { DocumentListener } from "./listener";
import { PromptHoverHandler } from "./prompts/promptHover";
import { insertPrompt } from "./prompts/promptExecutor";
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
  ApiConfig,
  getDefaultSystemPrompt,
} from "./config";
import { getBlockInfoAtPosition, parseDocument } from "./parser";
import { McpClientManager, McpServerConfig } from "./mcpClient";
import { StatusManager } from "./utils/statusManager";
import { cancelCurrentToolExecution } from "./tools/toolExecutor";
import { getNewChatPaths } from "./utils/chatDirUtils";
import {
  generateChatTemplate,
  getCurrentContext,
} from "./utils/contextTemplateUtils";

// Map to keep track of active document listeners
const documentListeners = new Map<string, vscode.Disposable>();

// Map to keep track of document listener instances
// This allows access to listener methods like getActiveStreamer()
const documentListenerInstances = new Map<string, DocumentListener>();

// Output channel for logging
export const outputChannel = vscode.window.createOutputChannel("chat.md");

// Create MCP client manager
export const mcpClientManager = new McpClientManager();

// Status manager for handling status bar items
export const statusManager = StatusManager.getInstance();

// Helper function for logging
export function log(message: string): void {
  outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
  // Logging happens without showing the output channel automatically
}

// --- Helper Function to Select Config by Index ---
/**
 * Selects and activates the API configuration at the specified index.
 * @param index The zero-based index of the configuration to select based on settings.json order.
 */
async function selectApiConfigByIndex(index: number): Promise<void> {
  log(`COMMAND TRIGGERED: selectApiConfigByIndex.${index}`);
  const configs = getApiConfigs();
  const configNames = Object.keys(configs); // Order should reflect settings.json

  if (index >= 0 && index < configNames.length) {
    const targetConfigName = configNames[index];
    try {
      await setSelectedConfig(targetConfigName);
      statusManager.updateConfigName(targetConfigName);
      updateStreamingStatusBar(); // Refresh the status bar display
      vscode.window.showInformationMessage(
        `Switched to API config: "${targetConfigName}"`, // Provide feedback
      );
      log(
        `Successfully switched to config index ${index}: "${targetConfigName}"`,
      );
    } catch (error) {
      log(
        `Error setting config index ${index} ("${targetConfigName}"): ${error}`,
      );
      vscode.window.showErrorMessage(
        `Failed to switch to API config "${targetConfigName}".`,
      );
    }
  } else {
    log(
      `No API configuration found at index ${index}. Total configs: ${configNames.length}`,
    );
    vscode.window.showWarningMessage(
      `No API configuration defined at position ${index + 1}.`,
    );
  }
}

/**
 * Updates the streaming status bar based on active document and streaming state
 */
export function updateStreamingStatusBar(): void {
  const activeEditor = vscode.window.activeTextEditor;

  // 0) Force reset status manager to clear any stale state
  statusManager.forceResetStatus();

  // 1) Compute total number of active streamers across all documents
  let totalAlive = 0;
  for (const listener of documentListenerInstances.values()) {
    try {
      totalAlive += listener.getActiveStreamerCount();
    } catch {
      // ignore
    }
  }
  statusManager.updateTotalStreamersAlive(totalAlive);

  // 2) Determine provider/config for the active .chat.md file (file-specific)
  let providerForFile: string | undefined;
  let configNameForFile: string | undefined;

  try {
    if (activeEditor && activeEditor.document.fileName.endsWith(".chat.md")) {
      const text = activeEditor.document.getText();
      const parsed = parseDocument(text, activeEditor.document);
      const perFileConfigName: string | undefined = (parsed as any).fileConfig?.selectedConfig;

      // Update config name in status bar to reflect per-file override or global
      const globalSelected = getSelectedConfigName();
      configNameForFile = perFileConfigName || globalSelected;
      statusManager.updateConfigName(configNameForFile);

      // Resolve provider using per-file override if present
      try {
        if (perFileConfigName) {
          providerForFile = require("./config").getProviderForConfig(perFileConfigName);
        } else {
          providerForFile = require("./config").getProvider();
        }
      } catch {
        providerForFile = undefined;
      }
    } else {
      // Non chat.md file - show global config info
      statusManager.updateConfigName(getSelectedConfigName());
      try {
        providerForFile = require("./config").getProvider();
      } catch {
        providerForFile = undefined;
      }
    }
  } catch {
    // Parsing might fail in intermediate edits; keep previous state
  }

  statusManager.updateProvider(providerForFile);

  // 3) Decide status per current chat (chat-specific)
  const activeEditorNow = vscode.window.activeTextEditor;
  let currentDocHasStreaming = false;
  let currentDocIsExecuting = false;
  let currentDocFileName = "none";

  if (activeEditorNow && activeEditorNow.document.fileName.endsWith(".chat.md")) {
    currentDocFileName = path.basename(activeEditorNow.document.fileName);
    const streamer = getActiveStreamerForDocument(activeEditorNow.document);
    currentDocHasStreaming = !!(streamer && streamer.isActive);

    const listener = getDocumentListenerForDocument(activeEditorNow.document);
    currentDocIsExecuting = !!(listener && listener.getIsExecuting && listener.getIsExecuting());
    
    log(`Status check for ${currentDocFileName}: streaming=${currentDocHasStreaming}, executing=${currentDocIsExecuting}, totalAlive=${totalAlive}`);
  } else {
    log(`Status check: not a chat file or no active editor. totalAlive=${totalAlive}`);
  }

  if (currentDocIsExecuting) {
    // Executing tool for this chat only
    log(`Showing tool execution status for ${currentDocFileName}`);
    statusManager.showToolExecutionStatus();
  } else if (currentDocHasStreaming) {
    // Streaming for this chat only (yellow)
    log(`Showing streaming status for ${currentDocFileName} (${totalAlive} total)`);
    statusManager.showStreamingStatus(totalAlive);
  } else if (totalAlive > 0) {
    // Other chats streaming elsewhere: show purple idle with (n)
    log(`Showing idle-with-alive for ${currentDocFileName} (${totalAlive} streaming elsewhere)`);
    statusManager.showIdleWithAlive(totalAlive);
  } else {
    // Pure idle
    log(`Showing pure idle for ${currentDocFileName}`);
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
    const mcpServers =
      (vscode.workspace.getConfiguration().get("chatmd.mcpServers") as Record<
        string,
        McpServerConfig
      >) || {};
    log(
      `Initializing ${
        Object.keys(mcpServers).length
      } MCP servers from configuration`,
    );

    for (const [serverId, config] of Object.entries(mcpServers)) {
      if (!config.command && !config.url) {
        log(
          `Warning: MCP server "${serverId}" is missing both 'command' and 'url' properties.`,
        );
      }
    }

    await mcpClientManager.initializeClients(mcpServers);
    log("MCP clients initialized successfully");
    
    // Update the prompt count and setup hover handler
    const promptCount = mcpClientManager.getAllPrompts().length;
    statusManager.setupPromptHover(promptCount);
    log(`Found ${promptCount} prompts available for hover display`);
    
    // Register the hover handler without immediately registering commands
    // Pass the context so PromptHoverHandler can register commands properly
    try {
      const hoverDisposables = PromptHoverHandler.register(context);
      for (const disposable of hoverDisposables) {
        context.subscriptions.push(disposable);
      }
    } catch (error) {
      log(`Error registering prompt hover handler: ${error}`);
    }
  } catch (error) {
    log(`Error initializing MCP clients: ${error}`);
    vscode.window.showErrorMessage(
      `Failed to initialize MCP servers: ${error}`,
    );
  }
}

/**
 * Handles configuration changes for MCP servers
 */
async function handleMcpConfigChange(
  event: vscode.ConfigurationChangeEvent,
): Promise<void> {
  if (event.affectsConfiguration("chatmd.mcpServers")) {
    log("MCP server configuration changed, updating servers");
    try {
      const newConfigs =
        (vscode.workspace.getConfiguration().get("chatmd.mcpServers") as Record<
          string,
          McpServerConfig
        >) || {};
      await mcpClientManager.checkConfigChanges(newConfigs);
      log("MCP servers updated after configuration change");
    } catch (error) {
      log(`Error updating MCP servers after configuration change: ${error}`);
      vscode.window.showErrorMessage(`Failed to update MCP servers: ${error}`);
    }
  }
}

/**
 * Helper function to get the document listener instance for a document
 */
function getDocumentListenerForDocument(document: vscode.TextDocument): DocumentListener | undefined {
  return documentListenerInstances.get(document.uri.toString());
}

/**
 * Helper function to check if text contains a tool call
 * @param text The text to check for tool calls
 * @returns True if a tool call is found, false otherwise
 */
function checkForToolCallInText(text: string): boolean {
  // Check for various tool call formats
  const properlyFencedToolCallRegex =
    /```(?:[a-zA-Z0-9_\-]*)?(?:\s*\n|\s+)(?:\s*)<tool_call>[\s\S]*?<\/tool_call>(?:\s*)\n\s*```/s;
  const partiallyFencedToolCallRegex =
    /```(?:[a-zA-Z0-9_\-]*)?(?:\s*\n|\s+)(?:\s*)<tool_call>[\s\S]*?<\/tool_call>(?!\s*\n\s*```)/s;
  const nonFencedToolCallRegex = /<tool_call>[\s\S]*?<\/tool_call>/s;

  return (
    properlyFencedToolCallRegex.test(text) ||
    partiallyFencedToolCallRegex.test(text) ||
    nonFencedToolCallRegex.test(text)
  );
}

// Declare context at module level to make it available in initializeMcpClients
let context: vscode.ExtensionContext;

export function activate(contextParam: vscode.ExtensionContext) {
  context = contextParam; // Store context globally
  log("chat.md extension is now active");
  console.log(">>> RUNNING MY LOCAL CODE - ", new Date());

  // Initialize MCP clients
  void initializeMcpClients();

  // Register status manager
  statusManager.register(context);

  // Check if an API configuration is selected, prompt to configure if not
  checkApiConfiguration();

  // Set initial config name in StatusManager
  const initialConfigName = getSelectedConfigName();
  statusManager.updateConfigName(initialConfigName);

  // Call the function that updates the status bar display
  updateStreamingStatusBar(); // Ensure this runs after setting the name

  // Register for .chat.md files
  const selector: vscode.DocumentSelector = { pattern: "**/*.chat.md" };

  // Set up listeners for currently open chat files
  for (const document of vscode.workspace.textDocuments) {
    setupDocumentListener(document, context);
  }

  // Register events for updating the status bar
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      log(`Active editor changed to: ${editor ? path.basename(editor.document.fileName) : 'none'}`);
      // Add a small delay to ensure the editor change is fully processed
      setTimeout(() => {
        updateStreamingStatusBar();
      }, 50);
    }),
  );

  // Update status bar initially
  updateStreamingStatusBar();

  // Listen for newly opened documents
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => {
      setupDocumentListener(document, context);
    }),
  );

  // --- Register API Config Switching Commands ---
  const maxIndexCommands = 5; // Match the number defined in package.json
  for (let i = 0; i < maxIndexCommands; i++) {
    context.subscriptions.push(
      vscode.commands.registerCommand(
        `filechat.selectApiConfigByIndex.${i}`,
        () => {
          // Pass the index 'i' to the helper function
          void selectApiConfigByIndex(i); // Use void as we don't need to wait here
        },
      ),
    );
  }

  // Listen for configuration changes to update MCP servers
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      // Make the handler async
      let configNameNeedsUpdate = false;
      let newConfigName: string | undefined;

      // 1. Check if the selected API configuration itself has changed
      if (event.affectsConfiguration("chatmd.selectedConfig")) {
        log("Configuration Change: Selected API config changed.");
        newConfigName = getSelectedConfigName(); // Assuming this function exists
        configNameNeedsUpdate = true;
      }

      // 2. Check if the list of API configurations changed (in case the active one was deleted)
      if (event.affectsConfiguration("chatmd.apiConfigs")) {
        log("Configuration Change: API config list changed.");
        const currentSelected = getSelectedConfigName(); // Assuming this function exists
        const allConfigs = getApiConfigs(); // Assuming this function exists

        // If a config was selected but it no longer exists in the list
        if (currentSelected && !allConfigs[currentSelected]) {
          log(
            `Configuration Change: Active API config "${currentSelected}" was removed.`,
          );
          // Clear the selection in settings
          await setSelectedConfig(""); // Use empty string instead of undefined
          newConfigName = undefined; // Update internal state
          configNameNeedsUpdate = true;
          vscode.window.showWarningMessage(
            `Active API configuration "${currentSelected}" was removed. Please select another.`,
          );
        }
      }

      // 3. If the config name needs updating, update the StatusManager and refresh the UI
      if (configNameNeedsUpdate) {
        // If newConfigName wasn't explicitly set above (only list changed, active one still exists),
        // fetch the current name again just in case. Usually not needed but safe.
        if (
          newConfigName === undefined &&
          !event.affectsConfiguration("chatmd.selectedConfig")
        ) {
          newConfigName = getSelectedConfigName();
        }
        statusManager.updateConfigName(newConfigName); // Assuming statusManager is accessible
        updateStreamingStatusBar(); // Assuming this function exists and updates the display
      }

      // 4. Handle MCP server configuration changes (keep existing logic)
      if (event.affectsConfiguration("chatmd.mcpServers")) {
        log("Configuration Change: MCP server config changed.");
        // Using void to explicitly ignore the promise here if not needed
        void handleMcpConfigChange(event).catch((error) => {
          // Assuming this function exists
          log(`Error handling MCP configuration change: ${error}`);
        }).then(() => {
          // After updating servers, refresh the status bar to show new server list
          const promptCount = mcpClientManager.getAllPrompts().length;
          statusManager.setupPromptHover(promptCount);
          log("Refreshed status bar after MCP server configuration change");
        });
      }
    }),
  );

  // Listen for document closes to clean up listeners
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((document) => {
      const key = document.uri.toString();
      if (documentListeners.has(key)) {
        documentListeners.get(key)!.dispose();
        documentListeners.delete(key);
        documentListenerInstances.delete(key);
      }
    }),
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand("filechat.insertPrompt", async (args) => {
      log(`COMMAND TRIGGERED: filechat.insertPrompt with args: ${JSON.stringify(args)}`);
      if (args && args.promptId) {
        const promptId = args.promptId;
        const [serverId, promptName] = promptId.split('.');
        const groupedPrompts = mcpClientManager.getGroupedPrompts();
        const serverPrompts = groupedPrompts.get(serverId);
        
        if (serverPrompts) {
          const prompt = serverPrompts.get(promptName);
          if (prompt) {
            await insertPrompt(promptId, prompt);
          } else {
            vscode.window.showErrorMessage(`Prompt ${promptName} not found on server ${serverId}`);
          }
        } else {
          vscode.window.showErrorMessage(`Server ${serverId} not found`);
        }
      } else {
        vscode.window.showErrorMessage("No prompt specified");
      }
    }),
    
    vscode.commands.registerCommand("filechat.cancelStreaming", () => {
      log("COMMAND TRIGGERED: filechat.cancelStreaming"); // <-- ADD THIS

      // Get current status to determine what to cancel
      const currentStatus = statusManager.getCurrentStatus();

      // Cancel based on status
      if (currentStatus === "executing" || currentStatus === "cancelling") {
        // Try to cancel tool execution
        const toolCancelled = cancelCurrentToolExecution();

        if (toolCancelled) {
          log("Tool execution cancellation requested via command");
          vscode.window.showInformationMessage(
            "Cancelled tool execution, but it may still have gone through successfully",
          );
          return;
        }
      }

      // Otherwise, try to cancel streaming if it's happening
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor && activeEditor.document.fileName.endsWith(".chat.md")) {
        const streamer = getActiveStreamerForDocument(activeEditor.document);
        if (streamer && streamer.isActive && streamer.cancel) {
          streamer.cancel();
          vscode.window.showInformationMessage("chat.md streaming cancelled");
          updateStreamingStatusBar();
        }
      }
    }),

    vscode.commands.registerCommand("filechat.resumeStreaming", async () => {
      log("COMMAND TRIGGERED: filechat.resumeStreaming");
      
      const activeEditor = vscode.window.activeTextEditor;
      if (!activeEditor) {
        vscode.window.showWarningMessage("No active editor found");
        return;
      }
      
      if (!activeEditor.document.fileName.endsWith(".chat.md")) {
        vscode.window.showWarningMessage("Resume streaming is only available for .chat.md files");
        return;
      }
      
      // Check if streaming is already active
      const activeStreamer = getActiveStreamerForDocument(activeEditor.document);
      if (activeStreamer && activeStreamer.isActive) {
        vscode.window.showWarningMessage("Streaming is already active for this document");
        return;
      }
      
      // Get the document listener and call resumeStreaming
      const documentListener = getDocumentListenerForDocument(activeEditor.document);
      if (!documentListener) {
        vscode.window.showErrorMessage("Document listener not found - try reopening the file");
        return;
      }
      
      try {
        await documentListener.resumeStreaming();
      } catch (error) {
        log(`Error resuming streaming: ${error}`);
        vscode.window.showErrorMessage(`Failed to resume streaming: ${error}`);
      }
    }),

    vscode.commands.registerCommand("filechat.refreshMcpTools", async () => {
      await initializeMcpClients();
      vscode.window.showInformationMessage("MCP tools refreshed successfully");
    }),

    vscode.commands.registerCommand("filechat.mcpDiagnostics", async () => {
      // Create diagnostics report
      const report = await mcpClientManager.generateDiagnosticsReport();

      // Show in output channel
      outputChannel.clear();
      outputChannel.appendLine("=== MCP Diagnostics Report ===");
      outputChannel.appendLine(report);
      outputChannel.show();
    }),

    vscode.commands.registerCommand("filechat.testSseConnection", async () => {
      // Get all SSE server configurations
      const mcpServers =
        (vscode.workspace.getConfiguration().get("chatmd.mcpServers") as Record<
          string,
          McpServerConfig
        >) || {};
      const sseServers = Object.entries(mcpServers).filter(
        ([_, config]) => config.url,
      );

      if (sseServers.length === 0) {
        vscode.window.showInformationMessage(
          'No SSE servers configured. Configure one using the "chat.md: Configure MCP Server" command.',
        );
        return;
      }

      // Ask which server to test
      const serverItems = sseServers.map(([id, config]) => ({
        label: id,
        description: config.url || "No URL specified",
      }));

      const selected = await vscode.window.showQuickPick(serverItems, {
        placeHolder: "Select an SSE server to test",
      });

      if (!selected) {
        return; // User cancelled
      }

      // Start the test
      outputChannel.clear();
      outputChannel.appendLine(
        `=== Testing SSE Connection to ${selected.label} ===`,
      );
      outputChannel.appendLine(`URL: ${selected.description}`);
      outputChannel.appendLine("");
      outputChannel.appendLine("Attempting to connect...");
      outputChannel.show();

      try {
        // Test basic HTTP connectivity first
        const url = new URL(selected.description);

        outputChannel.appendLine(
          `Testing basic HTTP connectivity to ${url.origin}...`,
        );
        try {
          // Fetch with a timeout
          const abortController = new AbortController();
          const timeoutId = setTimeout(() => abortController.abort(), 5000);

          const response = await fetch(url.origin, {
            method: "HEAD",
            signal: abortController.signal,
          });

          clearTimeout(timeoutId);

          outputChannel.appendLine(
            `HTTP connection successful: ${response.status} ${response.statusText}`,
          );
        } catch (error) {
          outputChannel.appendLine(`HTTP connection failed: ${error instanceof Error ? error.message : String(error)}`);
          outputChannel.appendLine(
            "This indicates the server might not be running or not accessible.",
          );
          outputChannel.appendLine("");
          throw new Error(`Cannot connect to ${url.origin}`);
        }

        // Now try to connect via SSE
        outputChannel.appendLine(`Testing SSE endpoint specifically...`);

        // Use the EventSource directly for testing (bypassing the MCP protocol)
        const EventSourceModule = (await import("eventsource"));
        const EventSource = EventSourceModule.default || EventSourceModule;
        const eventSource = new (EventSource as any)(url.href);

        // Set up a timeout
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => {
            eventSource.close();
            reject(new Error("Connection timeout (10s)"));
          }, 10000);
        });

        // Set up event handlers
        const connectionPromise = new Promise((resolve, reject) => {
          eventSource.onopen = (event: any) => {
            outputChannel.appendLine("SSE connection opened successfully!");
            resolve("Connection successful");
          };

          eventSource.onerror = (event: any) => {
            const errorMsg = event.message || "Unknown error";
            outputChannel.appendLine(`SSE connection error: ${errorMsg}`);
            reject(new Error(`SSE Error: ${errorMsg}`));
          };

          eventSource.onmessage = (event: any) => {
            outputChannel.appendLine(
              `Received message from SSE server: ${event.data}`,
            );
          };
        });

        // Wait for connection or timeout
        try {
          await Promise.race([connectionPromise, timeoutPromise]);
          outputChannel.appendLine("");
          outputChannel.appendLine(
            "The SSE server appears to be working correctly.",
          );
          outputChannel.appendLine(
            "If you still have issues with MCP, check that the server implements the MCP protocol correctly.",
          );

          // Close the connection after successful test
          eventSource.close();
        } catch (error) {
          outputChannel.appendLine("");
          outputChannel.appendLine(
            `SSE connection test failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          outputChannel.appendLine("Troubleshooting tips:");
          outputChannel.appendLine(
            "1. Ensure the server is running and accessible",
          );
          outputChannel.appendLine(
            "2. Check that the server supports SSE (not all HTTP servers do)",
          );
          outputChannel.appendLine(
            "3. Verify the URL is correct and includes http:// or https://",
          );
          outputChannel.appendLine(
            "4. Check for CORS issues if connecting to a different domain",
          );
          outputChannel.appendLine(
            '5. Ensure the server sends the correct "Content-Type: text/event-stream" header',
          );
        }
      } catch (error) {
        outputChannel.appendLine(
          `Error during connection test: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      outputChannel.appendLine("");
      outputChannel.appendLine("=== Test complete ===");
    }),

    vscode.commands.registerCommand("filechat.configureMcpServer", async () => {
      // Get server type first
      const serverType = await vscode.window.showQuickPick(
        [
          { label: "stdio", description: "Local process using stdio" },
          {
            label: "sse",
            description: "Remote server using Server-Sent Events (SSE)",
          },
        ],
        {
          placeHolder: "Select MCP server type",
          title: "Configure MCP Server",
        },
      );

      if (!serverType) return; // User cancelled

      // Get server ID
      const serverId = await vscode.window.showInputBox({
        prompt: "Enter an identifier for this MCP server",
        placeHolder: "e.g., local-tools, github-tools, database-tools",
      });

      if (!serverId) return; // User cancelled

      // Get existing config or create new one
      const mcpServers =
        (vscode.workspace.getConfiguration().get("chatmd.mcpServers") as Record<
          string,
          McpServerConfig
        >) || {};
      const existingConfig = mcpServers[serverId] || {};

      let config: McpServerConfig;

      if (serverType.label === "stdio") {
        // Configure stdio transport
        const command = await vscode.window.showInputBox({
          prompt: "Enter the command to start the MCP server",
          value: existingConfig.command || "",
          placeHolder: "e.g., python, node, ./my-server",
        });

        if (!command) return; // User cancelled

        const argsStr = await vscode.window.showInputBox({
          prompt: "Enter command arguments (space-separated)",
          value: existingConfig.args?.join(" ") || "",
          placeHolder: "e.g., -m mcp_server.py --port 8080",
        });

        const args = argsStr
          ? argsStr.split(" ").filter((arg) => arg.trim() !== "")
          : [];

        config = {
          command,
          args,
          env: existingConfig.env || {},
        };
      } else {
        // Configure SSE transport
        const url = await vscode.window.showInputBox({
          prompt: "Enter the SSE endpoint URL",
          value: existingConfig.url || "",
          placeHolder: "e.g., http://localhost:3000/sse",
        });

        if (!url) return; // User cancelled

        config = {
          url,
          env: existingConfig.env || {},
        };
      }

      // Ask to configure environment variables
      const configureEnv = await vscode.window.showQuickPick(["Yes", "No"], {
        placeHolder: "Configure environment variables?",
      });

      if (configureEnv === "Yes") {
        let configureMoreEnv = true;
        let env: Record<string, string> = existingConfig.env || {};

        while (configureMoreEnv) {
          const envName = await vscode.window.showInputBox({
            prompt: "Enter environment variable name",
            placeHolder: "e.g., API_KEY",
          });

          if (!envName) break;

          const envValue = await vscode.window.showInputBox({
            prompt: `Enter value for ${envName}`,
            placeHolder: "e.g., your-api-key-here",
          });

          if (envValue) {
            env[envName] = envValue;
          }

          const addAnother = await vscode.window.showQuickPick(["Yes", "No"], {
            placeHolder: "Add another environment variable?",
          });

          configureMoreEnv = addAnother === "Yes";
        }

        config.env = env;
      }

      // Save the configuration
      mcpServers[serverId] = config;
      await vscode.workspace
        .getConfiguration()
        .update(
          "chatmd.mcpServers",
          mcpServers,
          vscode.ConfigurationTarget.Global,
        );

      // Ask to refresh MCP tools
      const refreshNow = await vscode.window.showInformationMessage(
        `MCP server "${serverId}" configured. Refresh MCP tools now?`,
        "Yes",
        "No",
      );

      if (refreshNow === "Yes") {
        await vscode.commands.executeCommand("filechat.refreshMcpTools");
      }
    }),
    vscode.commands.registerCommand("filechat.newContextChat", async () => {
      const activeEditor = vscode.window.activeTextEditor;
      let streamerCancelled = false;

      // Check if active editor is a chat file and if streaming is active
      if (activeEditor && activeEditor.document.fileName.endsWith(".chat.md")) {
        const streamer = getActiveStreamerForDocument(activeEditor.document);
        if (streamer && streamer.isActive && streamer.cancel) {
          log(
            "newContextChat shortcut used while streaming: Cancelling stream.",
          );
          streamer.cancel();
          vscode.window.showInformationMessage("chat.md streaming cancelled");
          updateStreamingStatusBar(); // Update status bar after cancelling
          streamerCancelled = true;
        }
      }

      // If streaming was not cancelled, proceed with creating a new chat
      if (!streamerCancelled) {
        log("newContextChat shortcut used: Creating new context chat.");
        try {
          // Get current context (workspace, file, selection)
          const context = getCurrentContext();

          // Generate chat template with context
          const template = generateChatTemplate(
            context.workspacePath,
            context.filePath,
            context.selectedText,
          );

          // Get paths for new chat (including workspace-specific and chat-specific folders)
          const chatPaths = getNewChatPaths(context.workspacePath);

          // Create the file in its dedicated folder
          fs.writeFileSync(chatPaths.chatFilePath, template, "utf8");

          // Open the file in editor
          const uri = vscode.Uri.file(chatPaths.chatFilePath);
          const doc = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(doc);

          log(`Created new context chat at: ${chatPaths.chatFilePath}`);
          log(`Chat folder: ${chatPaths.chatFolderPath}`);
          log(`Workspace folder: ${chatPaths.chatDir}`);
          vscode.window.setStatusBarMessage("Created new context chat", 3000);
        } catch (error) {
          log(`Error creating context chat: ${error}`);
          vscode.window.showErrorMessage(
            `Failed to create context chat: ${error}`,
          );
        }
      } // This brace closes the if (!streamerCancelled) block
    }), // This closes the registerCommand call

    vscode.commands.registerCommand("filechat.newChat", async () => {
      // Create a new chat file
      const document = await vscode.workspace.openTextDocument({
        content: "# %% user\n",
        language: "markdown",
      });

      await vscode.window.showTextDocument(document);

      // Save the file with .chat.md extension
      const defaultPath = path.join(
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "~",
        "new.chat.md",
      );

      const saveUri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(defaultPath),
        filters: { "chat.md": ["chat.md"] },
      });

      if (saveUri) {
        await vscode.workspace.fs.writeFile(
          saveUri,
          Buffer.from(document.getText()),
        );
        const savedDoc = await vscode.workspace.openTextDocument(saveUri);
        await vscode.window.showTextDocument(savedDoc);
      }
    }),

    vscode.commands.registerCommand("filechat.addApiConfig", async () => {
      // Get a name for the configuration
      const configName = await vscode.window.showInputBox({
        placeHolder: "Enter a name for this configuration",
        prompt: 'Configuration name (e.g., "gemini-openai", "claude-pro")',
        validateInput: (value) => {
          return value && value.trim() !== ""
            ? null
            : "Configuration name cannot be empty";
        },
      });

      if (!configName) {
        return; // User cancelled
      }

      // Check if config already exists
      const configs = getApiConfigs();
      const existingConfig = configs[configName];

      // Get provider type
      const providerOptions = ["anthropic", "openai"];
      const selectedProvider = await vscode.window.showQuickPick(
        providerOptions,
        {
          placeHolder: "Select AI provider",
          title: "Configure API Type",
          canPickMany: false,
        },
      );

      if (!selectedProvider) {
        return; // User cancelled
      }

      // Get API key
      const apiKey = await vscode.window.showInputBox({
        prompt: `Enter your ${selectedProvider} API key:`,
        password: true,
        value: existingConfig?.apiKey || "",
        validateInput: (value) => {
          return value && value.trim() !== ""
            ? null
            : "API key cannot be empty";
        },
      });

      if (!apiKey) {
        return; // User cancelled
      }

      // Get model name (optional)
      let modelSuggestions: string[] = [];
      if (selectedProvider === "anthropic") {
        modelSuggestions = [
          "claude-3-opus-20240229",
          "claude-3-sonnet-20240229",
          "claude-3-haiku-20240307",
          "claude-3-5-sonnet-20240620",
          "claude-3-5-haiku-latest",
        ];
      } else if (selectedProvider === "openai") {
        modelSuggestions = [
          "gpt-4-turbo",
          "gpt-4-vision-preview",
          "gpt-4-32k",
          "gpt-4",
          "gpt-3.5-turbo",
          "gemini-2.5-pro-exp-03-25",
        ];
      }

      const selectedModel = await vscode.window.showQuickPick(
        ["Custom...", ...modelSuggestions],
        {
          placeHolder: "Select or enter a model name",
          title: "Configure Model",
        },
      );

      if (!selectedModel) {
        return; // User cancelled
      }

      let modelName = selectedModel;

      // If custom option selected, prompt for model name
      if (selectedModel === "Custom...") {
        modelName =
          (await vscode.window.showInputBox({
            prompt: "Enter custom model name:",
            value: existingConfig?.model_name || "",
          })) || "";

        if (!modelName) {
          return; // User cancelled
        }
      }

      // Get base URL (only if OpenAI or custom option selected)
      let baseUrl = "";

      if (selectedProvider === "openai") {
        const baseUrlSuggestions = [
          { label: "Default OpenAI API", detail: "" },
          {
            label: "Azure OpenAI API",
            detail:
              "https://YOUR_RESOURCE_NAME.openai.azure.com/openai/deployments/YOUR_DEPLOYMENT_NAME/chat/completions?api-version=2024-06-01",
          },
          {
            label: "Google Gemini API",
            detail: "https://generativelanguage.googleapis.com/v1beta/openai/",
          },
          { label: "Custom...", detail: "Enter a custom base URL" },
        ];

        const selectedOption = await vscode.window.showQuickPick(
          baseUrlSuggestions,
          {
            placeHolder: "Select or enter base URL for OpenAI-compatible API",
            title: "Configure Base URL",
          },
        );

        if (!selectedOption) {
          return; // User cancelled
        }

        if (selectedOption.label === "Custom...") {
          baseUrl =
            (await vscode.window.showInputBox({
              prompt: "Enter base URL for OpenAI-compatible API:",
              value: existingConfig?.base_url || "",
            })) || "";

          if (baseUrl === undefined) {
            return; // User cancelled
          }
        } else {
          baseUrl = selectedOption.detail;
        }
      }

      // Create and save the configuration
      const config: ApiConfig = {
        type: selectedProvider as "anthropic" | "openai",
        apiKey,
        model_name: modelName || undefined,
        base_url: baseUrl || undefined,
      };

      await setApiConfig(configName, config);

      // Ask if user wants to make this the active configuration
      const makeActive = await vscode.window.showQuickPick(["Yes", "No"], {
        placeHolder: "Make this the active configuration?",
        title: "Set Active Configuration",
      });

      if (makeActive === "Yes") {
        await setSelectedConfig(configName);
        vscode.window.showInformationMessage(
          `Configuration "${configName}" is now active`,
        );
      } else {
        vscode.window.showInformationMessage(
          `Configuration "${configName}" saved`,
        );
      }
    }),

    vscode.commands.registerCommand("filechat.selectApiConfig", async () => {
      log("COMMAND TRIGGERED: filechat.selectApiConfig");

      const configs = getApiConfigs();
      const configNames = Object.keys(configs);

      if (configNames.length === 0) {
        const createNew = await vscode.window.showInformationMessage(
          "No API configurations found. Would you like to create one now?",
          "Yes",
          "No",
        );

        if (createNew === "Yes") {
          await vscode.commands.executeCommand("filechat.addApiConfig");
        }
        return;
      }

      // Build items with description of each config
      const configItems = configNames.map((name) => {
        const config = configs[name];
        return {
          label: name,
          description: `${config.type} - ${config.model_name || "default model"}`,
          detail: config.base_url ? `Base URL: ${config.base_url}` : undefined,
        };
      });

      const selectedItem = await vscode.window.showQuickPick(configItems, {
        placeHolder: "Select API configuration",
        title: "Select Active Configuration",
      });

      if (!selectedItem) return; // User cancelled

      // Update global selected config
      await setSelectedConfig(selectedItem.label);
      statusManager.updateConfigName(selectedItem.label);
      vscode.window.showInformationMessage(
        `Configuration "${selectedItem.label}" is now active`,
      );

      // Also update the currently open .chat.md file's configuration preamble
      try {
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor && activeEditor.document.fileName.endsWith(".chat.md")) {
          const doc = activeEditor.document;
          const text = doc.getText();

          // Find start of first block marker
          const firstMarkerRegex = /^# %% (user|assistant|system|tool_execute|settings)\s*$/im;
          const markerMatch = firstMarkerRegex.exec(text);
          const preambleEnd = markerMatch ? markerMatch.index : 0;

          const preamble = text.slice(0, preambleEnd);
          let newPreamble = preamble;

          if (preamble.trim().length === 0) {
            // No preamble - insert selectedConfig at the top
            newPreamble = `selectedConfig="${selectedItem.label}"\n\n`;
          } else {
            // Replace existing selectedConfig=... if present, else prepend
            if (/^selectedConfig\s*=.*$/m.test(preamble)) {
              newPreamble = preamble.replace(
                /^selectedConfig\s*=.*$/m,
                `selectedConfig="${selectedItem.label}"`
              );
              // Ensure a trailing blank line between preamble and first block
              if (!newPreamble.endsWith("\n\n")) {
                newPreamble = newPreamble.replace(/\n*$/,"") + "\n\n";
              }
            } else {
              newPreamble = `selectedConfig="${selectedItem.label}"\n` + (preamble.endsWith("\n") ? "" : "\n");
            }
          }

          // Apply edit to replace preamble
          const edit = new vscode.WorkspaceEdit();
          const startPos = new vscode.Position(0, 0);
          const endPos = doc.positionAt(preambleEnd);
          edit.replace(doc.uri, new vscode.Range(startPos, endPos), newPreamble);

          const applied = await vscode.workspace.applyEdit(edit);
          if (!applied) {
            log("Failed to update chat file preamble with selectedConfig");
          } else {
            log(`Updated chat file preamble with selectedConfig="${selectedItem.label}"`);
          }
        }
      } catch (e) {
        log(`Error updating .chat.md preamble after config selection: ${e}`);
      }

      updateStreamingStatusBar(); // Refresh status bar (provider/config now file-specific)
    }),

    vscode.commands.registerCommand("filechat.removeApiConfig", async () => {
      const configs = getApiConfigs();
      const configNames = Object.keys(configs);

      if (configNames.length === 0) {
        vscode.window.showInformationMessage("No API configurations found.");
        return;
      }

      // Get the selected config name for highlighting
      const selectedConfigName = getSelectedConfigName();

      // Build items with description of each config
      const configItems = configNames.map((name) => {
        const config = configs[name];
        const isSelected = name === selectedConfigName;

        return {
          label: name,
          description: `${config.type} - ${
            config.model_name || "default model"
          }${isSelected ? " (active)" : ""}`,
          detail: config.base_url ? `Base URL: ${config.base_url}` : undefined,
        };
      });

      const selectedItem = await vscode.window.showQuickPick(configItems, {
        placeHolder: "Select API configuration to remove",
        title: "Remove Configuration",
      });

      if (!selectedItem) {
        return; // User cancelled
      }

      // Ask for confirmation
      const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to remove configuration "${selectedItem.label}"?`,
        "Yes",
        "No",
      );

      if (confirm !== "Yes") {
        return;
      }

      const removed = await removeApiConfig(selectedItem.label);

      if (removed) {
        vscode.window.showInformationMessage(
          `Configuration "${selectedItem.label}" has been removed.`,
        );

        // If it was the active config, suggest selecting another one
        if (
          selectedItem.label === selectedConfigName &&
          configNames.length > 1
        ) {
          const selectAnother = await vscode.window.showInformationMessage(
            "The active configuration was removed. Would you like to select another one?",
            "Yes",
            "No",
          );

          if (selectAnother === "Yes") {
            await vscode.commands.executeCommand("filechat.selectApiConfig");
          }
        }
      } else {
        vscode.window.showErrorMessage(
          `Failed to remove configuration "${selectedItem.label}".`,
        );
      }
    }),

    // Register command for Shift+Enter handling
    vscode.commands.registerTextEditorCommand(
      "filechat.insertNextBlock",
      async (textEditor, edit) => {
          const document = textEditor.document;

          // Handle multiple selections, though primary focus is the active cursor
          for (const selection of textEditor.selections) {
            const position = selection.active;
            log(
              `Shift+Enter pressed at Line: ${position.line}, Character: ${position.character}`,
            );

            const blockInfo = getBlockInfoAtPosition(document, position);
            log(`Current block type: ${blockInfo.type || "none"}`);

            // Special case: If we're in an assistant block and it contains a tool call, add tool_execute
            if (blockInfo.type === "assistant") {
              // Check if the current assistant block contains a tool call
              const text = document.getText();

              // Find the full content of the current assistant block
              const blockStart = blockInfo.blockStartPosition?.line ?? 0;
              let blockEndLine = position.line; // Default to current position

              // Look ahead for the next block marker or end of file
              for (let i = blockStart + 1; i < document.lineCount; i++) {
                const line = document.lineAt(i).text;
                if (
                  line.match(/^# %% (user|assistant|system|tool_execute)\s*$/i)
                ) {
                  blockEndLine = i - 1; // End of block is line before next marker
                  break;
                }
              }

              // Get the content of the assistant block
              const blockContent = document.getText(
                new vscode.Range(
                  new vscode.Position(blockStart + 1, 0), // Start after the marker line
                  new vscode.Position(blockEndLine + 1, 0), // Include the full last line
                ),
              );

              // Check for tool call patterns
              const hasToolCall = checkForToolCallInText(blockContent);

              if (hasToolCall) {
                log(
                  `Detected tool call in current assistant block, inserting tool_execute block`,
                );
                edit.insert(position, "\n# %% tool_execute\n");
                continue; // Skip to next selection
              }
            }

            // Default behavior (no tool call detected)
            let textToInsert = "";

            switch (blockInfo.type) {
              case "user":
                textToInsert = "\n# %% assistant\n";
                break;
              case "assistant":
                textToInsert = "\n# %% user\n";
                break;
              case "tool_execute":
                textToInsert = "\n# %% assistant\n"; // As per requirement
                break;
              default: // No block found before cursor, or error
                textToInsert = "\n# %% user\n"; // As per requirement
                break;
            }

            log(`Inserting text: "${textToInsert.replace(/\n/g, "\\n")}"`);
            // Insert the text at the current cursor position
            edit.insert(position, textToInsert);
          }
        },
    ),
  );
}

/**
 * Sets up a document listener for a specific document
 */
function setupDocumentListener(
  document: vscode.TextDocument,
  context: vscode.ExtensionContext,
) {
  if (document.fileName.endsWith(".chat.md")) {
    const key = document.uri.toString();

    // Don't set up duplicates
    if (!documentListeners.has(key)) {
      // Make sure the document is shown in an editor
      // This helps ensure document edits can be applied
      vscode.window.showTextDocument(document, { preview: false }).then(
        () => {
          log(`Document shown in editor: ${document.fileName}`);
        },
        (err: Error) => {
          log(`Error showing document: ${err}`);
        },
      );

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
export function getActiveStreamerForDocument(
  document: vscode.TextDocument,
): import("./types").StreamerState | undefined {
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
        "Yes",
        "Later",
      );

      if (selectNow === "Yes") {
        await vscode.commands.executeCommand("filechat.selectApiConfig");
      }
    }
    // If we have no configs at all, prompt to create one
    else if (configCount === 0) {
      const createNow = await vscode.window.showInformationMessage(
        "No API configurations found. Would you like to add one now?",
        "Yes",
        "Later",
      );

      if (createNow === "Yes") {
        await vscode.commands.executeCommand("filechat.addApiConfig");
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
  documentListeners.forEach((disposable) => {
    disposable.dispose();
  });
  documentListeners.clear();
  documentListenerInstances.clear();

  // Clean up MCP client connections
  mcpClientManager.cleanup().catch((error) => {
    log(`Error during MCP client cleanup: ${error}`);
  });

  // Dispose of status manager
  statusManager.dispose();
}
