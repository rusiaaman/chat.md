#%% user
Here are important files in my repo.

- [/Users/arusia/repos/filechat/package.json](/Users/arusia/repos/filechat/package.json)
- [/Users/arusia/repos/filechat/src/extension.ts](/Users/arusia/repos/filechat/src/extension.ts)
- [/Users/arusia/repos/filechat/src/listener.ts](/Users/arusia/repos/filechat/src/listener.ts)
- [/Users/arusia/repos/filechat/src/streamer.ts](/Users/arusia/repos/filechat/src/streamer.ts)
- [/Users/arusia/repos/filechat/src/parser.ts](/Users/arusia/repos/filechat/src/parser.ts)
- [/Users/arusia/repos/filechat/src/config.ts](/Users/arusia/repos/filechat/src/config.ts)
- [/Users/arusia/repos/filechat/src/tools/toolExecutor.ts](/Users/arusia/repos/filechat/src/tools/toolExecutor.ts)
- [/Users/arusia/repos/filechat/sample.chat.md](/Users/arusia/repos/filechat/sample.chat.md)
- [/Users/arusia/repos/filechat/tool-calling-example.chat.md](/Users/arusia/repos/filechat/tool-calling-example.chat.md)
- [/Users/arusia/repos/filechat/sample-config.jsonc](/Users/arusia/repos/filechat/sample-config.jsonc)
- [/Users/arusia/repos/filechat/CLAUDE.md](/Users/arusia/repos/filechat/CLAUDE.md)
- [/Users/arusia/repos/filechat/setup.sh](/Users/arusia/repos/filechat/setup.sh)

Your task is to add a status indicator in my vscode extension.

Currently there's no sidebar panel for my extension. Add it.

Then in that add an indicator that says if streamer is running and for what file path it is running. Make it visually obvious.

Add a red button that enables when streaming is running and that should cancel the streaming.


#%% assistant
Okay, let's plan the implementation for adding a status indicator sidebar panel with a cancel button to your `filechat` VSCode extension.

**Core Idea:**

1.  **Sidebar View:** Create a new view in the VSCode Activity Bar (or Explorer).
2.  **View Provider:** Implement a `TreeDataProvider` that displays the status of active streaming operations.
3.  **State Management:** Maintain a central list of active streamers (mapping document URIs to their corresponding `DocumentListener` or `StreamerState`).
4.  **Status Update:** When a stream starts or stops, update the central state and trigger a refresh of the sidebar view.
5.  **Cancel Button:** Display a "Cancel" button (as a `TreeItem` with a command) next to each active stream in the sidebar.
6.  **Cancel Command:** Register a command that, when triggered by the button, finds the relevant streamer/listener and signals it to stop.

**Implementation Plan:**

**1. `package.json` - Declare the View:**

Add entries to the `contributes` section to define the new view container and view.

```json
{
  "name": "filechat",
  // ... other properties ...
  "contributes": {
    "commands": [
      // ... existing commands ...
      {
        "command": "filechat.cancelStream",
        "title": "Cancel Chat Markdown Stream",
        "category": "Chat Markdown"
      }
    ],
    "viewsContainers": {
      "activitybar": [
        {
          "id": "filechat-activitybar",
          "title": "Chat Markdown",
          "icon": "$(comment-discussion)" // Choose an appropriate icon
        }
      ]
    },
    "views": {
      "filechat-activitybar": [
        {
          "id": "filechat.statusView",
          "name": "Streaming Status",
          "icon": "$(sync~spin)", // Initial icon, can be dynamic
          "contextualTitle": "Chat Markdown Status"
        }
      ]
    },
    "configuration": {
      // ... existing configuration ...
    }
    // ... other contributions ...
  }
  // ... rest of package.json ...
}
```

*   We add a new `viewsContainers` for the activity bar.
*   We add a new `views` entry linking our view (`filechat.statusView`) to the container.
*   We add a new command `filechat.cancelStream`.

**2. New File: `src/streamerStatusManager.ts` - Central State:**

Create a simple manager to track active streams.

```typescript
import * as vscode from 'vscode';
import { DocumentListener } from './listener'; // Assuming DocumentListener holds streamer state

export interface ActiveStreamInfo {
    uri: string;
    listener: DocumentListener; // Store the listener to call cancel on it
    startTime: number;
}

export class StreamerStatusManager {
    private activeStreams: Map<string, ActiveStreamInfo> = new Map();
    private _onDidChangeStatus = new vscode.EventEmitter<void>();
    readonly onDidChangeStatus: vscode.Event<void> = this._onDidChangeStatus.event;

    registerActiveStream(uri: string, listener: DocumentListener): void {
        if (!this.activeStreams.has(uri)) {
            this.activeStreams.set(uri, { uri, listener, startTime: Date.now() });
            this._onDidChangeStatus.fire();
            console.log(`Stream registered for: ${uri}`);
        }
    }

    unregisterActiveStream(uri: string): void {
        if (this.activeStreams.has(uri)) {
            this.activeStreams.delete(uri);
            this._onDidChangeStatus.fire();
            console.log(`Stream unregistered for: ${uri}`);
        }
    }

    getActiveStreams(): ReadonlyMap<string, ActiveStreamInfo> {
        return this.activeStreams;
    }

    dispose() {
        this._onDidChangeStatus.dispose();
        this.activeStreams.clear();
    }
}

// Optional: Export a singleton instance if preferred for simplicity
// export const streamerStatusManager = new StreamerStatusManager();
```

**3. New File: `src/statusBarViewProvider.ts` - The Sidebar UI:**

Implement the `TreeDataProvider` to render the status.

```typescript
import * as vscode from 'vscode';
import * as path from 'path';
import { StreamerStatusManager, ActiveStreamInfo } from './streamerStatusManager';

// Define the types of items in our tree
type StatusTreeItem = StatusMessageItem | ActiveStreamItem | CancelStreamItem;

export class StatusBarViewProvider implements vscode.TreeDataProvider<StatusTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<StatusTreeItem | undefined | null | void> = new vscode.EventEmitter<StatusTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<StatusTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor(private statusManager: StreamerStatusManager) {
        // Listen for status changes to refresh the view
        this.statusManager.onDidChangeStatus(() => {
            this.refresh();
        });
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: StatusTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: StatusTreeItem): vscode.ProviderResult<StatusTreeItem[]> {
        if (!element) {
            // Root level: Show general status or active streams
            const activeStreams = this.statusManager.getActiveStreams();
            if (activeStreams.size === 0) {
                return [new StatusMessageItem("No active streams.")];
            } else {
                const items: ActiveStreamItem[] = [];
                activeStreams.forEach(info => {
                    items.push(new ActiveStreamItem(info));
                });
                return items;
            }
        } else if (element instanceof ActiveStreamItem) {
            // Children of an active stream: Show the Cancel button
            return [new CancelStreamItem(element.streamInfo.uri)];
        }
        // No other children
        return [];
    }
}

// --- Tree Item Classes ---

class StatusMessageItem extends vscode.TreeItem {
    constructor(message: string) {
        super(message, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon('info');
    }
}

class ActiveStreamItem extends vscode.TreeItem {
    constructor(public readonly streamInfo: ActiveStreamInfo) {
        const fileName = path.basename(vscode.Uri.parse(streamInfo.uri).fsPath);
        super(fileName, vscode.TreeItemCollapsibleState.Collapsed); // Collapsed shows arrow for children
        this.description = "Streaming..."; // Additional info next to the label
        this.tooltip = `Streaming to ${streamInfo.uri}\nStarted: ${new Date(streamInfo.startTime).toLocaleTimeString()}`;
        this.iconPath = new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.blue')); // Spinning icon, maybe blue color
        this.contextValue = 'activeStream'; // For potential future actions
    }
}

class CancelStreamItem extends vscode.TreeItem {
    constructor(public readonly targetUri: string) {
        super("Cancel Stream", vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon('stop-circle', new vscode.ThemeColor('errorForeground')); // Red stop icon
        this.tooltip = `Cancel streaming for ${path.basename(vscode.Uri.parse(targetUri).fsPath)}`;
        this.command = {
            command: 'filechat.cancelStream',
            title: 'Cancel Stream',
            arguments: [this.targetUri] // Pass the URI to the command handler
        };
    }
}
```

**4. `src/extension.ts` - Wiring Everything Together:**

*   Instantiate managers and providers.
*   Register the provider and the cancel command.
*   Pass the `StreamerStatusManager` to `DocumentListener`.

#%% assistant
