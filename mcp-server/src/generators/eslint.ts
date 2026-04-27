import type { RuleDecision } from "../types.js";

export interface EslintConfig {
  decisions: RuleDecision[];
  existingConfig?: Record<string, unknown>;
}

/**
 * Generate ESLint Flat Config from rule decisions.
 * Outputs CommonJS module.exports = [...] format for ESLint v9+ compatibility.
 * Handles merging with existing config.
 */
export function generateEslintConfig(config: EslintConfig): string {
  const linterRules = config.decisions.filter(
    (d) => d.recommendedMedium === "linter_warn" || d.recommendedMedium === "linter_error" || d.recommendedMedium === "linter",
  );

  if (linterRules.length === 0) {
    return "// No linter rules recommended";
  }

  // Build rules map from decisions
  const rules: Record<string, unknown> = {};

  for (const rule of linterRules) {
    const severity = rule.recommendedMedium === "linter_error" ? "error" : "warn";
    switch (rule.ruleName) {
      case "no-console-log":
        rules["no-console"] = [severity, { allow: ["warn", "error"] }];
        break;
      case "no-direct-fetch":
        rules["no-restricted-imports"] = [severity, { patterns: ["node-fetch"] }];
        break;
      case "no-magic-numbers":
        rules["no-magic-numbers"] = [severity, { ignore: [0, 1] }];
        break;
      case "type-annotations":
        rules["@typescript-eslint/explicit-function-return-type"] = [severity];
        break;
      case "consistent-naming":
        rules["@typescript-eslint/naming-convention"] = [severity];
        break;
      case "no-debugger":
        rules["no-debugger"] = ["error"]; // always error regardless of medium
        break;
      case "no-large-files":
        rules["max-lines"] = [severity, { max: 300 }];
        break;
      case "secure-env-vars":
        rules["no-process-env"] = [severity];
        break;
      default:
        break;
    }
  }

  // Flat config format: array of config objects
  const prepend: unknown[] = [];

  // If existingConfig provided, prepend its config objects
  const existing = config.existingConfig;
  if (existing) {
    if (Array.isArray(existing)) {
      prepend.push(...existing);
    } else {
      prepend.push(existing);
    }
  }

  const configArray = [...prepend, { rules }];
  return `module.exports = ${JSON.stringify(configArray, null, 2)};\n`;
}
