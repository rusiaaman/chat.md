# Global State Management Guidelines for chat.md Extension

This document provides guidelines for working with global state in the chat.md VS Code extension. It's intended for developers who want to contribute new components or features to the repository.

## 1. Global State Framework

The chat.md extension uses **VS Code's Configuration API** for persistent global state and **singleton patterns** with module-level variables for runtime state management. It does not use any external state management libraries like Redux, Zustand, or MobX.

**Relevant Versions:**
- VS Code API: ^1.60.0
- TypeScript: ^4.0.2
- No external state management libraries are used

## 2. Important Folders and Files for State Management

The following files and folders are critical for state management:

### Primary State Management Files:
- `src/config.ts`: Manages persistent configuration state
- `src/extension.ts`: Contains global singleton instances and runtime state
- `src/utils/statusManager.ts`: Manages UI state for status bar

### Relationship between components:
- **config.ts**: Provides getter/setter functions that interact with VS Code's Configuration API
- **extension.ts**: Initializes global singletons and maintains runtime state
- **listener.ts**: Maintains document-specific state through instances tracked in `extension.ts`

## 3. Types of State

The codebase manages several types of state:

### 3.1 Persistent Configuration State
Stored in VS Code's configuration system and accessed/modified through the functions in `config.ts`.

Examples:
- API configuration details (`chatmd.apiConfigs`)
- Selected API configuration (`chatmd.selectedConfig`)
- MCP server configurations (`chatmd.mcpServers`)

### 3.2 Runtime Global State
Managed through singleton instances and module-level variables.

Examples:
- `documentListeners` map in `extension.ts`
- `mcpClientManager` instance in `extension.ts`
- `statusManager` instance in `extension.ts`

### 3.3 Document-specific State
Tied to specific markdown documents through the `DocumentListener` class.

Example:
- Streaming state for a specific document

## 4. State Getters

The main state getters are defined in `config.ts` and provide access to the VS Code configuration:

### Configuration Getters

```typescript
// Get all API configurations
export function getApiConfigs(): ApiConfigs {
  return vscode.workspace.getConfiguration().get("chatmd.apiConfigs") || {};
}

// Get the currently selected configuration name
export function getSelectedConfigName(): string | undefined {
  return vscode.workspace.getConfiguration().get("chatmd.selectedConfig");
}

// Get the currently selected configuration
export function getSelectedConfig(): ApiConfig | undefined {
  const configName = getSelectedConfigName();
  if (!configName) {
    return undefined;
  }

  const configs = getApiConfigs();
  return configs[configName];
}
```

### Usage Example:

```typescript
import { getSelectedConfig, getApiKey } from "./config";

function yourFunction() {
  // Check if a configuration is selected
  const config = getSelectedConfig();
  if (!config) {
    vscode.window.showErrorMessage("No API configuration selected.");
    return;
  }
  
  // Use the API key from the selected configuration
  const apiKey = getApiKey();
  
  // Do something with the apiKey...
}
```

### Runtime State Access

Access to runtime global state is provided through exported variables or getter functions:

```typescript
// Example of accessing a global singleton instance
import { mcpClientManager } from "./extension";

function yourFunction() {
  const tools = mcpClientManager.getAllTools();
  // Use tools...
}
```

## 5. State Setters

### Configuration Setters

The main state setters are also defined in `config.ts`:

```typescript
// Set the selected configuration
export async function setSelectedConfig(configName: string): Promise<void> {
  await vscode.workspace
    .getConfiguration()
    .update(
      "chatmd.selectedConfig",
      configName,
      vscode.ConfigurationTarget.Global,
    );
}

// Add or update an API configuration
export async function setApiConfig(
  name: string,
  config: ApiConfig,
): Promise<void> {
  const configs = getApiConfigs();
  configs[name] = config;

  await vscode.workspace
    .getConfiguration()
    .update("chatmd.apiConfigs", configs, vscode.ConfigurationTarget.Global);
}
```

### Usage Example:

```typescript
import { setApiConfig, setSelectedConfig } from "./config";

async function addNewConfiguration() {
  // Create a new API configuration
  const newConfig = {
    type: "anthropic" as const,
    apiKey: "your-api-key",
    model_name: "claude-3-opus-20240229",
  };
  
  // Add the configuration
  await setApiConfig("My New Config", newConfig);
  
  // Set it as the selected configuration
  await setSelectedConfig("My New Config");
  
  // Update the UI
  statusManager.updateConfigName("My New Config");
  updateStreamingStatusBar();
}
```

### Runtime State Updates

Updates to runtime state typically happen through method calls on the singleton instances:

```typescript
// Example of updating a global runtime state
import { statusManager, updateStreamingStatusBar } from "./extension";

function updateUIState(configName: string) {
  // Update the displayed configuration name
  statusManager.updateConfigName(configName);
  
  // Refresh the status bar display
  updateStreamingStatusBar();
}
```

## 6. State Change Handling

The extension uses VS Code's event system to respond to state changes:

```typescript
// Example of setting up a configuration change handler
context.subscriptions.push(
  vscode.workspace.onDidChangeConfiguration(async (event) => {
    if (event.affectsConfiguration("chatmd.apiConfigs")) {
      // Handle API configuration changes
      const currentSelected = getSelectedConfigName();
      const allConfigs = getApiConfigs();
      
      // If selected config was removed, clear selection
      if (currentSelected && !allConfigs[currentSelected]) {
        await setSelectedConfig(undefined);
        statusManager.updateConfigName(undefined);
        updateStreamingStatusBar();
      }
    }
  })
);
```

## 7. Best Practices

When contributing to the chat.md extension, follow these best practices for state management:

1. **Use Existing Patterns**: Follow the singleton pattern and VS Code Configuration API as established in the codebase.

2. **Centralize Configuration Access**: All access to VS Code's configuration should go through functions in `config.ts`.

3. **Handle Events Properly**: Subscribe to relevant VS Code events to react to changes.

4. **Clean Up**: Ensure all event listeners are properly disposed through the `context.subscriptions` collection.

5. **Update UI on State Changes**: After modifying state, remember to update the UI to reflect the changes:
   ```typescript
   statusManager.updateConfigName(newConfigName);
   updateStreamingStatusBar();
   ```

6. **Document-Specific State**: For state that relates to a specific document, use the `DocumentListener` class and maintain the instances in the `documentListenerInstances` map.

## 8. Adding New State

If you need to add new state to the extension:

1. **For Configuration State**:
   - Add the property to the appropriate interface
   - Add getter/setter functions in `config.ts`
   - Register default values in package.json if necessary

2. **For Runtime State**:
   - Consider whether it belongs at the global level or document level
   - If global, add it to an existing singleton or create a new one
   - If document-specific, add it to the `DocumentListener` class

## Conclusion

The chat.md extension uses a combination of VS Code's Configuration API for persistent state and singleton patterns for runtime state. Understanding these patterns will help you contribute effectively to the extension's development.

For further questions or clarification, refer to the VS Code Extension API documentation or examine the existing code patterns in the repository.