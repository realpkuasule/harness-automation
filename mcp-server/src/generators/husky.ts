import type { RuleDecision } from "../types.js";

export interface HuskyConfig {
  decisions: RuleDecision[];
  /** Existing husky config (pre-commit, commit-msg, etc.) */
  existingHooks?: Record<string, string>;
}

/**
 * Generate Husky hook scripts based on rule decisions.
 *
 * - pre-commit: lint-staged / eslint check
 * - commit-msg: commitlint validation
 */
export function generateHuskyConfig(config: HuskyConfig): Record<string, string> {
  const hooks: Record<string, string> = {
    ...config.existingHooks,
  };

  const hasLinterRules = config.decisions.some(
    (d) => d.recommendedMedium === "linter",
  );
  const hasHookRules = config.decisions.some(
    (d) => d.recommendedMedium === "hook",
  );

  if (!hasLinterRules && !hasHookRules) return hooks;

  // pre-commit hook: lint check
  if (!hooks["pre-commit"]) {
    const preCommitLines: string[] = [
      "#!/bin/sh",
      ". \"$(dirname \"$0\")/_/husky.sh\"",
      "",
    ];

    if (hasLinterRules) {
      preCommitLines.push("npx eslint . --max-warnings=0");
    }

    hooks["pre-commit"] = preCommitLines.join("\n");
  }

  // commit-msg hook: commitlint
  if (!hooks["commit-msg"]) {
    hooks["commit-msg"] = [
      "#!/bin/sh",
      ". \"$(dirname \"$0\")/_/husky.sh\"",
      "",
      "npx --no -- commitlint --edit $1",
    ].join("\n");
  }

  return hooks;
}

/**
 * Generate the .husky directory structure instructions.
 */
export function generateHuskySetupInstructions(): string {
  return [
    "# Husky Setup",
    "Run the following to enable git hooks:",
    "",
    "  npx husky init",
    "  chmod +x .husky/pre-commit .husky/commit-msg",
  ].join("\n");
}
