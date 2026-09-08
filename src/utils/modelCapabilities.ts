/**
 * Model capability checks needed for reasoning support. Kept free of imports so it
 * can be tested outside VS Code.
 */

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "max";

/** Anthropic effort levels accepted by adaptive thinking */
export type AdaptiveEffort = "low" | "medium" | "high" | "max";

interface ClaudeVersion {
  family: string;
  major: number;
  minor: number;
}

function parseClaudeVersion(model: string): ClaudeVersion | undefined {
  const match = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:[-.](\d+))?/i.exec(
    model,
  );
  if (!match) {
    return undefined;
  }
  return {
    family: match[1].toLowerCase(),
    major: parseInt(match[2], 10),
    minor: match[3] ? parseInt(match[3], 10) : 0,
  };
}

/**
 * Models that take thinking: {type: "adaptive"} plus output_config.effort instead of
 * the older thinking: {type: "enabled", budget_tokens}. Claude 4.6 and everything
 * from 5 onwards.
 */
export function isAdaptiveThinkingModel(model: string): boolean {
  const version = parseClaudeVersion(model);
  if (!version) {
    return false;
  }
  if (version.family === "fable" || version.family === "mythos") {
    return true;
  }
  if (version.major >= 5) {
    return true;
  }
  return version.major === 4 && version.minor >= 6;
}

/**
 * Models that omit thinking content from responses unless display: "summarized" is
 * requested (Claude 4.7+, 5.x, Fable/Mythos).
 */
export function omitsThinkingByDefault(model: string): boolean {
  const version = parseClaudeVersion(model);
  if (!version) {
    return false;
  }
  if (version.family === "fable" || version.family === "mythos") {
    return true;
  }
  if (version.major >= 5) {
    return true;
  }
  return version.major === 4 && version.minor >= 7;
}

/**
 * Models where adaptive thinking is always on: sending a disabled thinking config
 * is rejected, so the param has to be omitted entirely.
 */
export function requiresAlwaysOnThinking(model: string): boolean {
  const version = parseClaudeVersion(model);
  return version?.family === "fable" && version.major === 5;
}

/**
 * Older Anthropic models that still need the interleaved thinking beta header to
 * think between tool calls. It is generally available from 4.6 onwards.
 */
export function needsInterleavedThinkingBeta(model: string): boolean {
  const version = parseClaudeVersion(model);
  if (!version) {
    return false;
  }
  if (version.major > 4) {
    return false;
  }
  return version.major === 4 && version.minor <= 5;
}

/** Map the configured reasoning effort onto Anthropic's adaptive effort levels */
export function toAdaptiveEffort(effort: ReasoningEffort): AdaptiveEffort {
  switch (effort) {
    case "minimal":
    case "low":
    case "none":
      return "low";
    case "medium":
      return "medium";
    case "max":
      return "max";
    default:
      return "high";
  }
}

/**
 * OpenAI models served by the Responses API rather than chat completions:
 * the gpt-* family and the o-series reasoning models.
 */
export function isResponsesApiModel(model: string): boolean {
  return /^(gpt-|o[1-9])/i.test(model.trim());
}

/**
 * True when a base URL points at OpenAI itself. Any other host (OpenRouter, local
 * servers, Azure gateways, ...) only speaks chat completions.
 */
export function isOpenAiBaseUrl(baseUrl?: string): boolean {
  if (!baseUrl || !baseUrl.trim()) {
    return true; // no override means api.openai.com
  }
  try {
    return new URL(baseUrl).hostname.endsWith("api.openai.com");
  } catch {
    return false;
  }
}
