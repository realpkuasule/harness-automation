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
    (d) => d.recommendedMedium === "linter",
  );

  if (linterRules.length === 0) {
    return "// No linter rules recommended";
  }

  const existing = config.existingConfig || {};
  const mergedRules = { ...((existing.rules as Record<string, unknown>) || {}) };

  // Map rule decisions to ESLint rules
  const ruleMap: Record<string, [string, ...unknown[]]> = {
    "no-console-log": ["warn", { allow: ["warn", "error"] }],
    "no-direct-fetch": ["warn"],
    "no-magic-numbers": ["warn", { ignore: [0, 1] }],
    "type-annotations": ["warn"],
    "consistent-naming": ["warn"],
    "no-debugger": ["error"],
    "no-large-files": ["warn", { max: 300 }],
    "secure-env-vars": ["error"],
  };

  for (const rule of linterRules) {
    const esRule = ruleMap[rule.ruleName];
    if (esRule) {
      mergedRules[rule.ruleName] = esRule;
    }
  }

  const configObj = {
    ...existing,
    rules: mergedRules,
  };

  return JSON.stringify(configObj, null, 2);
}
