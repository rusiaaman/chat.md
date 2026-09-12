import { ApiConfig, getConfigByName, getSelectedConfig } from "./config";

const CLAUDE_NON_SUBSCRIPTION_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_ORGANIZATION_ID",
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_VERTEX",
] as const;

const CODEX_NON_SUBSCRIPTION_ENV = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_API_KEY",
] as const;

export function activeApiConfig(configName: string | undefined): ApiConfig {
  const config = configName ? getConfigByName(configName) : getSelectedConfig();
  if (!config) {
    throw new Error("The selected provider configuration does not exist.");
  }
  return config;
}

export function subscriptionEnvironment(
  provider: "claude-code" | "codex",
  configured: unknown,
): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  if (
    configured &&
    typeof configured === "object" &&
    !Array.isArray(configured)
  ) {
    for (const [name, value] of Object.entries(configured)) {
      if (typeof value === "string") environment[name] = value;
    }
  }
  const forbidden =
    provider === "claude-code"
      ? CLAUDE_NON_SUBSCRIPTION_ENV
      : CODEX_NON_SUBSCRIPTION_ENV;
  for (const name of forbidden) {
    delete environment[name];
  }
  return environment;
}

export function claudeMcpServers(
  urls: Record<string, string>,
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(urls).map(([name, url]) => [name, { type: "http", url }]),
  );
}

export function codexMcpServers(
  urls: Record<string, string>,
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(urls).map(([name, url]) => [
      name,
      { url, default_tools_approval_mode: "approve" },
    ]),
  );
}

export function allowAllCodexMcpTools(
  servers: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(servers).flatMap(([name, server]) =>
      server && typeof server === "object" && !Array.isArray(server)
        ? [
            [
              name,
              {
                ...(server as Record<string, unknown>),
                default_tools_approval_mode: "approve",
              },
            ],
          ]
        : [],
    ),
  );
}
