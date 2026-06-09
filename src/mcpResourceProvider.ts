import * as vscode from "vscode";
import { mcpClientManager } from "./mcpClientManager";
import { formatReadResourceResult } from "./utils/mcpResultFormatter";

/**
 * TextDocumentContentProvider for custom `mcp-resource` URI scheme.
 * Resolves URIs in the format: mcp-resource://${serverId}/${encodeURIComponent(originalUri)}
 */
export class McpResourceDocumentProvider implements vscode.TextDocumentContentProvider {
  public static readonly scheme = "mcp-resource";

  private onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  public readonly onDidChange = this.onDidChangeEmitter.event;

  /**
   * Encodes server ID and original resource URI into an mcp-resource URI
   */
  public static encodeUri(serverId: string, originalUri: string): vscode.Uri {
    return vscode.Uri.parse(
      `${McpResourceDocumentProvider.scheme}://${serverId}/${encodeURIComponent(originalUri)}`,
    );
  }

  /**
   * Decodes an mcp-resource URI back to server ID and original resource URI
   */
  public static decodeUri(uri: vscode.Uri): { serverId: string; originalUri: string } {
    return {
      serverId: uri.authority,
      originalUri: decodeURIComponent(uri.path.substring(1)),
    };
  }

  public update(uri: vscode.Uri): void {
    this.onDidChangeEmitter.fire(uri);
  }

  public async provideTextDocumentContent(
    uri: vscode.Uri,
    token: vscode.CancellationToken,
  ): Promise<string> {
    const decodedUri = McpResourceDocumentProvider.decodeUri(uri);

    if (token.isCancellationRequested) {
      return "";
    }

    try {
      const result = await mcpClientManager.readResource(
        decodedUri.serverId,
        decodedUri.originalUri,
      );

      if (token.isCancellationRequested) {
        return "";
      }

      return formatReadResourceResult(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Error reading resource from server "${decodedUri.serverId}":\n${message}`;
    }
  }
}
