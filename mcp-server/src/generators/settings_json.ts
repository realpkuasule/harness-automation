import type { RuleDecision } from "../types.js";

export interface SettingsJsonConfig {
  decisions: RuleDecision[];
}

/**
 * Generate VS Code settings.json content from rule decisions.
 * settings.json is the "harness-forced" medium — deterministic behavior.
 */
export function generateSettingsJson(config: SettingsJsonConfig): string {
  const settingsRules = config.decisions.filter(
    (d) => d.recommendedMedium === "settings" || d.recommendedMedium === "settings.json",
  );

  const settings: Record<string, unknown> = {
    "editor.formatOnSave": true,
    "editor.codeActionsOnSave": {
      "source.fixAll": "explicit",
    },
  };

  // Add rules that benefit from editor integration
  for (const rule of settingsRules) {
    switch (rule.ruleName) {
      case "consistent-naming":
        settings["typescript.preferences.quoteStyle"] = "single";
        break;
      case "no-console-log":
        settings["typescript.suggest.autoImports"] = true;
        break;
    }
  }

  return JSON.stringify(settings, null, 2);
}
