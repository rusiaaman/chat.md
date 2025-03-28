import * as vscode from 'vscode';

/**
 * Gets the configured provider (anthropic or openai)
 * Returns 'anthropic' as default if not configured
 */
export function getProvider(): string {
  return vscode.workspace.getConfiguration().get('filechat.provider') || 'anthropic';
}

/**
 * Gets the configured model name for the current provider
 * Returns undefined to use the default model for each provider
 */
export function getModelName(): string | undefined {
  return vscode.workspace.getConfiguration().get('filechat.model_name');
}

/**
 * Gets the configured base URL for the OpenAI API
 * Returns undefined to use the default OpenAI base URL
 * This is only used when provider is 'openai'
 */
export function getBaseUrl(): string | undefined {
  return vscode.workspace.getConfiguration().get('filechat.base_url');
}

/**
 * Sets the base URL in configuration
 */
export async function setBaseUrl(baseUrl: string): Promise<void> {
  await vscode.workspace.getConfiguration().update(
    'filechat.base_url',
    baseUrl,
    vscode.ConfigurationTarget.Global
  );
}

/**
 * Sets the model name in configuration
 */
export async function setModelName(modelName: string): Promise<void> {
  await vscode.workspace.getConfiguration().update(
    'filechat.model_name',
    modelName,
    vscode.ConfigurationTarget.Global
  );
}

/**
 * Sets the provider in configuration
 */
export async function setProvider(provider: string): Promise<void> {
  await vscode.workspace.getConfiguration().update(
    'filechat.provider',
    provider,
    vscode.ConfigurationTarget.Global
  );
}

/**
 * Gets the configured API key for the current provider
 * Returns undefined if not configured
 */
export function getApiKey(): string | undefined {
  return vscode.workspace.getConfiguration().get('filechat.apiKey');
}

/**
 * Sets the API key in configuration
 */
export async function setApiKey(apiKey: string): Promise<void> {
  await vscode.workspace.getConfiguration().update(
    'filechat.apiKey',
    apiKey,
    vscode.ConfigurationTarget.Global
  );
}

/**
 * Gets the configured Anthropic API key (legacy)
 * Returns undefined if not configured
 */
export function getAnthropicApiKey(): string | undefined {
  // Try the new unified API key first if provider is anthropic
  if (getProvider() === 'anthropic') {
    const apiKey = getApiKey();
    if (apiKey) {
      return apiKey;
    }
  }
  
  // Fall back to legacy anthropic-specific key
  return vscode.workspace.getConfiguration().get('filechat.anthropicApiKey');
}

/**
 * Sets the Anthropic API key (legacy)
 */
export async function setAnthropicApiKey(apiKey: string): Promise<void> {
  // If we're using anthropic as provider, set the unified key too
  if (getProvider() === 'anthropic') {
    await setApiKey(apiKey);
  }
  
  // Also set the legacy key for backward compatibility
  await vscode.workspace.getConfiguration().update(
    'filechat.anthropicApiKey',
    apiKey,
    vscode.ConfigurationTarget.Global
  );
}