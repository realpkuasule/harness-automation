import type { RuleDecision } from "../types.js";

export interface EslintConfig {
  decisions: RuleDecision[];
  existingConfig?: Record<string, unknown>;
}

/**
 * Generate ESLint configuration from rule decisions.
 * Handles merging with existing config.
 */
export function generateEslintConfig(config: EslintConfig): string {
  const linterRules = config.decisions.filter(
    (d) => d.recommendedMedium === "linter_warn" || d.recommendedMedium === "linter_error" || d.recommendedMedium === "linter",
  );

  if (linterRules.length === 0) {
    return "// No linter rules recommended";
  }

  const existing = config.existingConfig || {};
  const mergedRules = { ...((existing.rules as Record<string, unknown>) || {}) };

  // Map rule decisions to ESLint rules with severity based on medium
  for (const rule of linterRules) {
    const severity = rule.recommendedMedium === "linter_error" ? "error" : "warn";
    switch (rule.ruleName) {
      case "no-console-log":
        mergedRules["no-console"] = [severity, { allow: ["warn", "error"] }];
        break;
      case "no-direct-fetch":
        mergedRules["no-restricted-imports"] = [severity, { patterns: ["node-fetch"] }];
        break;
      case "no-magic-numbers":
        mergedRules["no-magic-numbers"] = [severity, { ignore: [0, 1] }];
        break;
      case "type-annotations":
        mergedRules["typescript-eslint/explicit-function-return-type"] = [severity];
        break;
      case "consistent-naming":
        mergedRules["typescript-eslint/naming-convention"] = [severity];
        break;
      case "no-debugger":
        mergedRules["no-debugger"] = ["error"]; // always error regardless of medium
        break;
      case "no-large-files":
        mergedRules["max-lines"] = [severity, { max: 300 }];
        break;
      case "secure-env-vars":
        mergedRules["no-process-env"] = [severity];
        break;
      default:
        break;
    }
  }

  const configObj = {
    ...existing,
    rules: mergedRules,
  };

  return JSON.stringify(configObj, null, 2);
}
