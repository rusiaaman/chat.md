# Configuration Precedence in chat.md

This document explains the three-level configuration system for `reasoningEffort`, `maxTokens`, and `maxThinkingTokens` parameters.

## Configuration Levels (in order of precedence)

### 1. File-specific Configuration (Highest Priority)
Configuration defined at the beginning of a `.chat.md` file before any `# %%` blocks:

```
selectedConfig="my-provider"
reasoningEffort="high"
maxTokens=4000
maxThinkingTokens=20000

# %% system
Your system prompt here

# %% user  
Your message here
```

### 2. Provider-specific Configuration (Middle Priority)
Configuration defined in VS Code settings for a specific API provider:

```json
{
  "chatmd.apiConfigs": {
    "anthropic-high": {
      "type": "anthropic",
      "apiKey": "your-api-key",
      "model_name": "claude-3-5-haiku-latest",
      "reasoningEffort": "medium",
      "maxTokens": 6000,
      "maxThinkingTokens": 18000
    },
    "openai-reasoning": {
      "type": "openai", 
      "apiKey": "your-api-key",
      "model_name": "o1-preview",
      "base_url": "https://api.openai.com/v1/chat/completions",
      "reasoningEffort": "low",
      "maxTokens": 8000,
      "maxThinkingTokens": 16000
    }
  }
}
```

### 3. Global Configuration (Lowest Priority)
Global VS Code settings that apply when no file or provider-specific configuration is found:

```json
{
  "chatmd.reasoningEffort": "medium",
  "chatmd.maxTokens": 8000,
  "chatmd.maxThinkingTokens": 16000
}
```

## Parameter Descriptions

### reasoningEffort
Controls the reasoning effort level for LLM responses:
- `"minimal"`: Very minimal thinking
- `"low"`: Low reasoning effort  
- `"medium"`: Medium reasoning effort (default)
- `"high"`: High reasoning effort

**Usage by Provider:**
- **OpenAI**: Sets the `reasoning_effort` parameter directly
- **Anthropic**: Used to calculate thinking token budget if `maxThinkingTokens` is not explicitly set

### maxTokens  
Maximum number of tokens to generate in responses:
- **Anthropic**: Used as the `max_tokens` parameter
- **OpenAI**: Used as the `max_completion_tokens` parameter (includes both thinking and response tokens)

### maxThinkingTokens
Maximum number of thinking tokens for reasoning models:
- **Anthropic**: Sets `thinking.max_tokens` parameter if configured
- **OpenAI**: Currently used for internal token budget calculations

## Examples

### Example 1: File overrides provider config
```
selectedConfig="anthropic-default"
maxTokens=2000

# %% system
Be very concise.

# %% user
Explain quantum computing.
```
This will use `maxTokens=2000` from the file, even if "anthropic-default" provider has a different `maxTokens` value.

### Example 2: Provider config overrides global
If your global settings have `maxTokens=8000` but your provider config has `maxTokens=4000`, and no file-specific config exists, it will use `4000`.

### Example 3: Reasoning effort calculation
If you set `reasoningEffort="high"` but don't set `maxThinkingTokens`, Anthropic will automatically calculate thinking tokens as 80% of `maxTokens`.

## Allowed File-specific Keys
Only these keys are allowed in `.chat.md` file preambles:
- `selectedConfig` - Name of the provider configuration to use
- `reasoningEffort` - Reasoning effort level  
- `maxTokens` - Maximum response tokens
- `maxThinkingTokens` - Maximum thinking tokens

Forbidden keys (must be in global settings only):
- `type`, `apiKey`, `base_url`, `model_name`, `apiConfigs`
