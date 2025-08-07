# Chat.md - Frontend Development Guidelines

## 1. Basics

### 1.1 Frontend Framework & Version
This project is a VS Code extension rather than a traditional frontend application. It uses:
- **Node.js** with TypeScript as its development environment
- **VS Code Extension API** (version requires VS Code ^1.60.0 as specified in package.json)

### 1.2 Key Features
- **TypeScript**: The project is written entirely in TypeScript with strict type checking
- **VS Code Extension API**: Using VS Code's extension capabilities including:
  - Commands registration
  - Status bar management
  - WebView panels
  - Document editing
  - File system operations
- **Markdown-based**: The primary feature is handling .chat.md files

### 1.3 External Libraries
- **@modelcontextprotocol/sdk** (v1.8.0): For handling MCP (Model Context Protocol) client operations
- **eventsource** (v3.0.6): For Server-Sent Events (SSE) connections
- **zod** (v3.24.2): For runtime type validation

## 2. Project Structure

### 2.1 Folder Overview
- **src/**: Main source code directory
  - **prompts/**: Handles MCP prompts display and execution
  - **utils/**: Utility functions for files, chat templates, status management, etc.
  - **types/**: TypeScript type definitions and interfaces
  - **tools/**: Tool execution functionality
- **images/**: Extension icons and graphics
- **samples/**: Example .chat.md files
- **patches/**: Contains patches for external libraries
- **docs/**: Documentation files

### 2.2 File Samples per Folder
- **src/**
  - `extension.ts`: Main extension entry point
  - `config.ts`: Configuration handling
  - `parser.ts`: Parses .chat.md files
  - `mcpClient.ts`: MCP client manager
  - `types.ts`: Core type definitions
- **src/prompts/**
  - `promptHover.ts`: Handles hover display for prompts
  - `promptExecutor.ts`: Executes prompt insertion
- **src/utils/**
  - `fileUtils.ts`: File handling utilities
  - `statusManager.ts`: Manages status bar
  - `contextTemplateUtils.ts`: Generates chat templates
- **src/types/**
  - `mcp-fix.d.ts`: Type fixes for MCP SDK

### 2.3 Folder Relationships
- **src/** contains the main extension code
- **src/prompts/** depends on **src/utils/** for file operations
- **src/utils/** provides functionality used throughout the codebase
- **src/types/** defines types used across the project
- **samples/** demonstrates .chat.md usage patterns

### 2.4 When to Use What Folder
- Place core extension functionality in **src/**
- Utility functions should go in **src/utils/**
- Any prompt-related code belongs in **src/prompts/**
- Type definitions should be in **src/types/**
- Tool-related code should go in **src/tools/**

New folders can be created in the **src/** directory for new functional areas. Keep folder nesting to a maximum of 2-3 levels for maintainability.

## 3. Content Specific

### 3.1 Imports
Imports are organized in the following order:
1. Node.js built-ins
2. VS Code API
3. External dependencies
4. Internal modules

File extensions are omitted except for .tsx files in some cases. Imports are not strictly alphabetized.

Example from `promptExecutor.ts`:
```typescript
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { log } from "../extension";
import { mcpClientManager } from "../extension";
import { ensureDirectoryExists, writeFile } from "../utils/fileUtils";
```

### 3.2 Naming (Components or Pages)
- **File Names**: Uses camelCase for utility files (e.g., `fileUtils.ts`), and often descriptive names indicating purpose
- **Classes**: Use PascalCase (e.g., `StatusManager`, `PromptHoverHandler`)
- **Component Props**: Usually defined as interfaces with a descriptive name

### 3.3 Naming (Non-Component)
- **Utility Functions**: Use camelCase with descriptive names (e.g., `resolveFilePath`, `ensureDirectoryExists`) 
- **Constants**: Use UPPER_SNAKE_CASE for constants within classes
- **Interfaces**: Use PascalCase with descriptive names (e.g., `MessageParam`, `StreamerState`)
- **Types**: Use PascalCase and often descriptive names (e.g., `ContentType`, `Role`)

### 3.4 Code Organization
The codebase follows clear patterns:
- Classes use private fields and static methods when appropriate
- Exported functions have JSDoc documentation
- Functions are grouped by related functionality
- Interface and type definitions are at the top of files

Example from `statusManager.ts`:
```typescript
export class StatusManager {
  private static instance: StatusManager;
  private streamingStatusItem: vscode.StatusBarItem;
  private streamingDots: string = "";
  private animationInterval: NodeJS.Timeout | undefined;
  
  // Methods follow...
}
```

### 3.5 Linting
The project uses ESLint with Prettier integration. Key rules include:

- No unused variables, except those prefixed with underscore
```typescript
// This would generate a warning:
const unusedVar = "something";

// This is allowed:
const _unusedVar = "something";
```

- Prettier formatting is set to:
  - Double quotes for strings (not single quotes)
  - Semicolons required
  - 80 character line length limit
  - 2 space indentation
  - Trailing commas
  - Arrow function parentheses are always required

### 3.6 TypeScript
The project uses strict TypeScript with comprehensive typing.

- **Type Assertions**: Used sparingly, primarily with non-null assertions (`!`)
- **Any**: Avoided when possible, usually only in arguments passed to external libraries
- **Type Definitions**: Comprehensive interfaces and types in `types.ts`

The project uses explicit return types for functions:

```typescript
export function getCurrentContext(): {
  workspacePath: string | null;
  filePath: string | null;
  selectedText: string;
} {
  // Implementation...
}
```

Nullability is explicitly handled:
```typescript
const workspacePath = workspaceFolder ? workspaceFolder.uri.fsPath : null;
```

### 3.7 Logging
The project uses a custom logging function that writes to a VS Code output channel.

```typescript
// Initialization in extension.ts
export const outputChannel = vscode.window.createOutputChannel("chat.md");

export function log(message: string): void {
  outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
}
```

To use logging in a new component:
```typescript
import { log } from "./extension";

// Then in your code:
log(`Processing request with parameters: ${JSON.stringify(params)}`);
```

## 4. Components or Pages

### 4.1 Folder and File Structure
The project doesn't use a component-based architecture like React. Instead:
- Classes and their functionality are defined in dedicated files
- Related functionality is grouped in directories (`prompts/`, `utils/`)
- No barrel files are used for re-exporting

### 4.2 File Content
Each file typically contains one main class or a group of related functions. Classes and functions use named exports rather than default exports.

```typescript
// Named export of a class
export class StatusManager {
  // Class implementation
}

// Named export of functions
export function getCurrentContext() { /* ... */ }
export function generateChatTemplate() { /* ... */ }
```

### 4.3 Configuration
Configuration is centralized in the `config.ts` file which defines and manages extension settings. Individual components access configuration via functions exported from this file.

```typescript
// From config.ts
export function getApiKey(): string | undefined {
  const selectedConfig = getSelectedConfig();
  return selectedConfig?.apiKey;
}

// Usage in other files
import { getApiKey } from "./config";
const apiKey = getApiKey();
```

To add new configuration in your own code:
1. Extend the appropriate interface in `config.ts` 
2. Add getter/setter functions in `config.ts`
3. Register configuration properties in `package.json` under `contributes.configuration.properties`

### 4.4 Types
Types and interfaces are defined in several places:
- Core types in `src/types.ts`
- Local interfaces in the files where they're used

Both interfaces and type aliases are used, with interfaces preferred for object shapes and type aliases for unions or complex types.

```typescript
// Interface for object shapes
export interface MessageParam {
  role: Role;
  content: Content[];
}

// Type alias for unions
export type Role = "user" | "assistant";
```

### 4.5 Styling Approach
As a VS Code extension, this project doesn't use traditional frontend styling. Instead:
- VS Code's built-in styling is used via ThemeColor
- CSS is only used in WebViews (like in the prompts hover panel)

Example of using VS Code ThemeColor:
```typescript
this.streamingStatusItem.backgroundColor = new vscode.ThemeColor(
  "statusBarItem.warningBackground"
);
```

For WebViews, inline CSS is used in the HTML string:
```typescript
`<style>
  body {
    font-family: var(--vscode-font-family);
    background-color: var(--vscode-editorHoverWidget-background);
    color: var(--vscode-editorHoverWidget-foreground);
  }
</style>`
```

### 4.6 Styling Location
Styles are co-located with the functionality they relate to:
- WebView styles are defined inline in the HTML strings
- VS Code theme colors are specified directly in the component

For a new component using a WebView, add styling like this:
```typescript
const webviewContent = `
  <!DOCTYPE html>
  <html>
  <head>
    <style>
      body {
        font-family: var(--vscode-font-family);
        background-color: var(--vscode-editorHoverWidget-background);
        color: var(--vscode-editorHoverWidget-foreground);
      }
      .my-component {
        padding: 10px;
        border-radius: 3px;
      }
    </style>
  </head>
  <body>
    <div class="my-component">
      <!-- Component content -->
    </div>
  </body>
  </html>
`;
```

### 4.7 Other File Relationships
The project has a few key relationships between files:
- `extension.ts` initializes and manages the lifecycle of various services
- `mcpClientManager.ts` is a central service used by many components
- `parser.ts` provides parsing functionality used throughout the codebase
- Utility functions in `utils/` are imported across multiple files

## 5. Coding Patterns

### 5.1 Code Splitting
The project doesn't use dynamic imports or code splitting for lazy loading. All code is loaded upfront when the extension activates.

### 5.2 JSX Prop Passing
This project doesn't use JSX or React components.

### 5.3 JSX Conditions and Looping
This project doesn't use JSX, but TypeScript conditional and looping patterns include:

Conditional execution:
```typescript
if (document) {
  // Get directory of the current document and create cmdassets within it
  const docDir = path.dirname(document.uri.fsPath);
  assetsDir = path.join(docDir, "cmdassets");
  relativePath = "cmdassets"; // Relative to the chat document
  log(`Using document-relative assets directory: ${assetsDir}`);
} else {
  // Fallback to extension root if no document provided
  const rootDir = path.resolve(__dirname, "..", "..");
  assetsDir = path.join(rootDir, "samples", "cmdassets");
  relativePath = path.join("samples", "cmdassets");
  log(`No document provided, using extension root assets directory: ${assetsDir}`);
}
```

Ternary operators:
```typescript
const workspacePath = workspaceFolder ? workspaceFolder.uri.fsPath : null;
```

### 5.4 Custom Hooks vs Render Props
This project doesn't use React hooks or render props.

### 5.5 Data Updates
The project handles data changes with a combination of approaches:

- **VS Code Document Events**: Listening for text changes with `onDidChangeTextDocument`
- **Direct Document Edits**: Using VS Code's `TextEditor.edit()` API
- **Command Registration**: Creating VS Code commands that update state

Error handling is typically presented inline with error messages shown via VS Code's built-in message APIs:

```typescript
vscode.window.showErrorMessage(`Failed to connect to MCP server: ${error}`);
```

### 5.6 Data Fetching
Data fetching is primarily done for:
- MCP tool execution
- API calls to LLM providers (OpenAI, Anthropic)

Error handling includes retry mechanisms for network failures:
```typescript
// Example from mcpClient.ts for SSE reconnection
private attemptReconnect(serverId: string, config: McpServerConfig): void {
  // Clear existing retry interval
  if (this.sseRetryIntervals.has(serverId)) {
    clearInterval(this.sseRetryIntervals.get(serverId)!);
    this.sseRetryIntervals.delete(serverId);
  }

  // Check retry count
  const retryCount = this.sseRetryCount.get(serverId) || 0;
  if (retryCount >= this.sseMaxRetries) {
    log(`Exceeded maximum retry attempts (${this.sseMaxRetries}) for SSE server ${serverId}`);
    this.sseRetryCount.delete(serverId);
    return;
  }

  // Increment retry count and set up exponential backoff
  this.sseRetryCount.set(serverId, retryCount + 1);
  const backoffTime = Math.min(30000, 1000 * Math.pow(2, retryCount));
  
  // Schedule reconnection attempt
  const interval = setInterval(async () => {
    clearInterval(interval);
    this.sseRetryIntervals.delete(serverId);
    try {
      await this.connectServer(serverId, config);
      this.sseRetryCount.delete(serverId);
    } catch (error) {
      this.attemptReconnect(serverId, config);
    }
  }, backoffTime);

  this.sseRetryIntervals.set(serverId, interval);
}
```

### 5.7 Loading States
The project doesn't use React Suspense, but it does handle loading states through:
- The StatusManager class which manages status bar indicators
- Animation for long-running operations

```typescript
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

  this.animationInterval = setInterval(() => {
    this.updateStreamingAnimation();
  }, 500);
}
```

### 5.8 Error Handling
Error handling in the project is mostly isolated (per-operation) rather than using global error boundaries. Error handling patterns include:

- Try/catch blocks around async operations
- Logging errors to the output channel
- Displaying error messages to the user via VS Code's UI

Example of comprehensive error handling:
```typescript
try {
  await client.connect(transport);
  log(`Successfully connected to MCP server ${serverId}`);
  // Success path...
} catch (error) {
  log(`Error connecting to MCP server ${serverId}: ${error}`);
  
  // Enhanced error logging
  if (error instanceof Error) {
    log(`Error type: ${error.name}`);
    log(`Error message: ${error.message}`);
    if (error.stack) {
      log(`Error stack: ${error.stack}`);
    }
    
    // Check for specific error types
    if (error.message.includes("ECONNREFUSED")) {
      log(`Connection refused: The SSE server at ${config.url} is not running or not accessible`);
    }
  }
  
  throw error; // Re-throw for handling upstream
}
```

For new components, follow this pattern:
1. Wrap operations in try/catch blocks
2. Log detailed error information
3. Show user-friendly error messages via VS Code UI
4. Handle specific error types when appropriate

### 5.9 Data Rendering
The project doesn't handle large lists or use virtualization techniques.

## 6. Internationalization

### 6.1 Translation Library
The project doesn't use internationalization, with all UI strings hardcoded in English.

## 7. Form State Management and Form Patterns

### 7.1 Form Libraries
The project doesn't use traditional form libraries. Instead, it uses VS Code's input APIs:

```typescript
const value = await vscode.window.showInputBox({
  prompt: arg.description || `Enter value for ${arg.name}`,
  placeHolder: arg.name,
  title: `Prompt Argument for ${promptName}`,
  ignoreFocusOut: true, // Keep the input box open if focus is lost
  validateInput: (value) => {
    if (arg.required && !value) {
      return "This argument is required";
    }
    return null; // Validation passes
  }
});
```

### 7.2 Validation
Input validation is handled using the `validateInput` callback in VS Code's input APIs. This approach provides immediate feedback to users:

```typescript
validateInput: (value) => {
  if (arg.required && !value) {
    return "This argument is required";
  }
  return null; // Validation passes
}
```

### 7.3 Form Submission
The project primarily uses VS Code's Quick Pick and Input Box APIs for user input, which handle their own submission flow.

## 8. Layouting Patterns

### 8.1 Layout Components
As a VS Code extension, the project doesn't use traditional layout components. When creating WebViews, the layout is defined in HTML strings:

```typescript
`<div class="section-title">Connected MCP Servers</div>
<div class="server-list">
  ${connectedServers.length > 0 
    ? connectedServers.map(id => `<div class="server-item">${id}</div>`).join('')
    : `<div class="no-servers">No servers currently connected</div>`
  }
</div>`
```

### 8.2 Flexbox vs Grid
When creating WebViews, the project primarily uses CSS Flexbox:

```css
.server-list {
  display: flex;
  flex-wrap: wrap;
}

.server-item {
  padding: 3px 5px;
  margin-right: 5px;
  margin-bottom: 5px;
}
```

### 8.3 Spacing System
The project doesn't use a formal spacing system or spacing scale. In WebViews, spacing is defined with hardcoded CSS values:

```css
.prompt-item {
  padding: 5px;
  margin-bottom: 5px;
  cursor: pointer;
  border-radius: 3px;
}
```

### 8.4 Container Patterns
The project doesn't use sophisticated container patterns. WebViews typically have simple width and height constraints:

```css
body {
  max-height: 400px;
  max-width: 400px;
  overflow-y: auto;
}
```

### 8.5 Z-Index Management
The project doesn't use complex z-index management, relying instead on VS Code's handling of UI layers.

## 9. Links

### 9.1 Link Components
The project doesn't use traditional link components, but in WebViews it creates clickable elements:

```typescript
// In the HTML template
`<div class="prompt-item" data-id="${serverId}.${promptName}">
  <div class="prompt-name">${promptName} ${argsInfo}</div>
  <div class="prompt-desc">${prompt.description || ''}</div>
</div>`

// In the JavaScript part of the WebView
document.querySelectorAll('.prompt-item').forEach(item => {
  item.addEventListener('click', () => {
    const promptId = item.getAttribute('data-id');
    vscode.postMessage({
      command: 'insertPrompt',
      promptId: promptId
    });
  });
});
```

### 9.2 Link Styling
Links in WebViews have hover states defined using CSS:

```css
.prompt-item:hover {
  background-color: var(--vscode-list-hoverBackground);
}
```

### 9.3 Link Behavior
Links in WebViews use VS Code's messaging API to communicate between the WebView and extension:

```typescript
// In the WebView
vscode.postMessage({
  command: 'insertPrompt',
  promptId: promptId
});

// In the extension
this.hoverPanel.webview.onDidReceiveMessage(
  async (message) => {
    switch (message.command) {
      case 'insertPrompt':
        // Handle the command
        break;
    }
  }
);
```

## 10. Responsive Design Patterns

### 10.1 Breakpoint System & Media Queries
The project doesn't use media queries or a breakpoint system, as VS Code handles most of the UI layout.

### 10.2 Responsive Components & Layout
VS Code WebViews generally don't need media queries as they adapt to the available space automatically.

## 11. Document Editing

### 11.1 VS Code TextEditor Usage
The project uses VS Code's `TextEditor.edit()` API to modify documents:

```typescript
await editor.edit((editBuilder) => {
  for (const selection of editor.selections) {
    editBuilder.insert(selection.active, textToInsert);
  }
});
```

### 11.2 Position Handling
The project handles cursor positions and selections carefully:

```typescript
// Get the current cursor position
const position = selection.active;

// Get information about the block at the cursor position
const blockInfo = getBlockInfoAtPosition(document, position);

// Insert text at the cursor position
edit.insert(position, textToInsert);
```

## 12. VS Code Extension Integration

### 12.1 Command Registration
Commands are registered during activation:

```typescript
context.subscriptions.push(
  vscode.commands.registerCommand("filechat.insertPrompt", async (args) => {
    // Command implementation
  })
);
```

### 12.2 Event Handling
VS Code events are used extensively:

```typescript
context.subscriptions.push(
  vscode.workspace.onDidOpenTextDocument((document) => {
    setupDocumentListener(document, context);
  })
);
```

### 12.3 WebViews
The project uses WebViews for complex UI like the prompts panel:

```typescript
this.hoverPanel = vscode.window.createWebviewPanel(
  'promptHover',
  'MCP Servers and Prompts',
  {
    viewColumn: vscode.ViewColumn.Active,
    preserveFocus: true,
  },
  {
    enableScripts: true,
    retainContextWhenHidden: false
  }
);

this.hoverPanel.webview.html = this.getPromptsHtml(groupedPrompts);
```

### 12.4 Status Bar Items
Status bar items display the extension state:

```typescript
this.streamingStatusItem = vscode.window.createStatusBarItem(
  vscode.StatusBarAlignment.Right,
  10
);
this.streamingStatusItem.text = `$(check) chat.md: Idle (${configText})`;
this.streamingStatusItem.tooltip = this.IDLE_TOOLTIP;
this.streamingStatusItem.command = "filechat.selectApiConfig";
this.streamingStatusItem.show();
```

## 13. File System Operations

### 13.1 File Path Resolution
The project handles relative and absolute paths:

```typescript
export function resolveFilePath(
  filePath: string,
  document: vscode.TextDocument,
): string {
  // If path starts with ~ replace with home dir
  if (filePath.startsWith("~")) {
    return filePath.replace(/^~/, process.env.HOME || "");
  }

  // If it's an absolute path, return as is
  if (path.isAbsolute(filePath)) {
    return filePath;
  }

  // Try to resolve relative to the document
  const documentDir = path.dirname(document.uri.fsPath);
  const resolvedPath = path.resolve(documentDir, filePath);

  return resolvedPath;
}
```

### 13.2 File Reading and Writing
The project has utility functions for file operations:

```typescript
export function readFileAsText(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    console.error(`Error reading file ${filePath}:`, error);
    return undefined;
  }
}

export function writeFile(filePath: string, content: string): void {
  try {
    fs.writeFileSync(filePath, content, "utf8");
  } catch (error) {
    console.error(`Error writing file ${filePath}:`, error);
    throw error; // Re-throw the error
  }
}
```

### 13.3 Directory Creation
The project ensures directories exist before writing files:

```typescript
export function ensureDirectoryExists(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    try {
      fs.mkdirSync(dirPath, { recursive: true });
    } catch (error) {
      console.error(`Error creating directory ${dirPath}:`, error);
      throw error; // Re-throw the error to indicate failure
    }
  } else if (!fs.statSync(dirPath).isDirectory()) {
    throw new Error(`Path exists but is not a directory: ${dirPath}`);
  }
}
```

## 14. Testing Considerations

### 14.1 Testing Approach
The project doesn't have a comprehensive testing strategy visible in the examined files. When implementing new features, consider adding tests to ensure reliability.

## 15. VS Code Extension Best Practices

### 15.1 Extension Lifecycle
The project follows VS Code extension lifecycle:

```typescript
export function activate(context: vscode.ExtensionContext) {
  // Initialize extension
  log("chat.md extension is now active");
  
  // Register commands, events, etc.
  
  // Initialize services
}

export function deactivate() {
  // Clean up resources
  documentListeners.forEach((disposable) => {
    disposable.dispose();
  });
  documentListeners.clear();
  
  // Clean up MCP client connections
  mcpClientManager.cleanup().catch((error) => {
    log(`Error during MCP client cleanup: ${error}`);
  });
  
  // Dispose of status manager
  statusManager.dispose();
}
```

### 15.2 Disposable Resources
The project properly manages disposable resources:

```typescript
context.subscriptions.push(
  vscode.commands.registerCommand("filechat.newChat", async () => {
    // Command implementation
  })
);
```

### 15.3 Commands and Menus
Commands are registered in both `package.json` and in the extension code:

```typescript
// In package.json
"commands": [
  {
    "command": "filechat.newChat",
    "title": "chat.md: New chat.md"
  }
]

// In extension.ts
vscode.commands.registerCommand("filechat.newChat", async () => {
  // Implementation
})
```

## 16. Singleton Pattern Usage

### 16.1 Singleton Implementations
The project uses the Singleton pattern for manager classes:

```typescript
export class StatusManager {
  private static instance: StatusManager;
  
  private constructor() {
    // Initialize
  }
  
  public static getInstance(): StatusManager {
    if (!StatusManager.instance) {
      StatusManager.instance = new StatusManager();
    }
    return StatusManager.instance;
  }
  
  // Methods...
}
```

### 16.2 Service Access
Singleton services are accessed via static methods or exported instances:

```typescript
// Exported instance
export const mcpClientManager = new McpClientManager();

// Usage elsewhere
import { mcpClientManager } from "./extension";
```

## 17. Error Handling Patterns

### 17.1 Comprehensive Error Logging
The project logs detailed error information:

```typescript
try {
  // Operation
} catch (error) {
  log(`Error connecting to MCP server ${serverId}: ${error}`);
  
  if (error instanceof Error) {
    log(`Error type: ${error.name}`);
    log(`Error message: ${error.message}`);
    if (error.stack) {
      log(`Error stack: ${error.stack}`);
    }
    
    // Specific error type handling
    if (error.message.includes("ECONNREFUSED")) {
      log(`Connection refused: The server is not accessible`);
    }
  }
  
  throw error;
}
```

### 17.2 User-Facing Error Messages
The project shows user-friendly error messages:

```typescript
vscode.window.showErrorMessage(`Failed to connect to MCP server: ${error}`);
```