import * as vscode from 'vscode';

/**
 * Gets the configured Anthropic API key
 * Returns undefined if not configured
 */
export function getAnthropicApiKey(): string | undefined {
  return vscode.workspace.getConfiguration().get('filechat.anthropicApiKey');
}

/**
 * Sets the Anthropic API key in configuration
 */
export async function setAnthropicApiKey(apiKey: string): Promise<void> {
  await vscode.workspace.getConfiguration().update(
    'filechat.anthropicApiKey',
    apiKey,
    vscode.ConfigurationTarget.Global
  );
}