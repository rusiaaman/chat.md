import type { ApiConfig, ApiConfigs } from "./config";

export interface SubscriptionDefaults {
  configs: ApiConfigs;
  selectedConfig: string | undefined;
  configsChanged: boolean;
}

function availableName(configs: ApiConfigs, preferred: string): string {
  if (!(preferred in configs)) return preferred;
  let suffix = 2;
  while (`${preferred}-${suffix}` in configs) suffix += 1;
  return `${preferred}-${suffix}`;
}

function firstConfigOfType(
  configs: ApiConfigs,
  type: ApiConfig["type"],
): string | undefined {
  return Object.entries(configs).find(
    ([, config]) => config.type === type,
  )?.[0];
}

export function subscriptionDefaults(
  configs: ApiConfigs,
  selectedConfig: string | undefined,
  claudeAvailable: boolean,
  codexAvailable: boolean,
): SubscriptionDefaults {
  const nextConfigs = { ...configs };
  let configsChanged = false;

  if (claudeAvailable && !firstConfigOfType(nextConfigs, "claude-code")) {
    const name = availableName(nextConfigs, "claude-code-opus");
    nextConfigs[name] = {
      type: "claude-code",
      model_name: "claude-opus-5",
      reasoningEffort: "high",
      claudeCode: { permissionMode: "bypassPermissions" },
    };
    configsChanged = true;
  }

  if (codexAvailable && !firstConfigOfType(nextConfigs, "codex")) {
    const name = availableName(nextConfigs, "codex-sol");
    nextConfigs[name] = {
      type: "codex",
      model_name: "gpt-5.6-sol",
      reasoningEffort: "high",
      codex: {
        thread: {
          sandboxMode: "danger-full-access",
          approvalPolicy: "never",
        },
      },
    };
    configsChanged = true;
  }

  const validSelection =
    selectedConfig && selectedConfig in nextConfigs
      ? selectedConfig
      : undefined;
  const preferredSelection = claudeAvailable
    ? firstConfigOfType(nextConfigs, "claude-code")
    : undefined;
  const fallbackSelection = codexAvailable
    ? firstConfigOfType(nextConfigs, "codex")
    : undefined;

  return {
    configs: nextConfigs,
    selectedConfig: validSelection ?? preferredSelection ?? fallbackSelection,
    configsChanged,
  };
}
