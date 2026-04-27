import type { RuleDecision } from "../types.js";

export interface PackageJsonConfig {
  decisions: RuleDecision[];
  existingPackageJson?: Record<string, unknown>;
}

// Map rule decisions to required devDependencies
const RULE_DEPS: Record<string, string[]> = {
  "no-console-log": [],
  "no-direct-fetch": [],
  "commit-message-convention": ["@commitlint/cli", "@commitlint/config-conventional"],
  "lint-before-commit": ["husky", "lint-staged"],
  "test-before-merge": [],
  "no-magic-numbers": [],
  "consistent-naming": ["@typescript-eslint/eslint-plugin"],
  "type-annotations": ["@typescript-eslint/eslint-plugin"],
  "no-debugger": [],
  "error-handling": [],
  "no-large-files": [],
  "secure-env-vars": [],
  "no-duplicate-code": [],
  "code-review-required": [],
  "prefer-early-return": [],
  "dependency-lock": ["lockfile-lint"],
};

/**
 * Merge required devDependencies into an existing package.json.
 */
export function mergeDependencies(config: PackageJsonConfig): {
  merged: Record<string, string>;
  missing: string[];
  suggestedCommands: string[];
} {
  const existing: Record<string, string> = (config.existingPackageJson?.devDependencies as Record<string, string>) || {};

  const needed = new Set<string>();

  for (const decision of config.decisions) {
    const deps = RULE_DEPS[decision.ruleName] || [];
    for (const dep of deps) {
      needed.add(dep);
    }
  }

  const missing: string[] = [];
  const merged: Record<string, string> = { ...existing };

  for (const dep of needed) {
    if (!existing[dep]) {
      // We don't pin versions here; installer picks latest
      merged[dep] = "*";
      missing.push(dep);
    }
  }

  const suggestedCommands = missing.length > 0
    ? [`npm install --save-dev ${missing.join(" ")}`]
    : [];

  return { merged, missing, suggestedCommands };
}
