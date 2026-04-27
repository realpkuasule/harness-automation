import type { RuleDecision } from "../types.js";

export interface HuskyConfig {
  decisions: RuleDecision[];
  /** Existing husky config (pre-commit, commit-msg, etc.) */
  existingHooks?: Record<string, string>;
}

/**
 * Generate Husky hook scripts based on rule decisions.
 *
 * - pre-commit: lint-staged (runs eslint, prettier, etc. on staged files)
 * - commit-msg: commitlint validation
 */
export function generateHuskyConfig(config: HuskyConfig): Record<string, string> {
  const hooks: Record<string, string> = {
    ...config.existingHooks,
  };

  const hasRelevantRules = config.decisions.some(
    (d) =>
      d.recommendedMedium === "linter_warn" ||
      d.recommendedMedium === "linter_error" ||
      d.recommendedMedium === "linter" ||
      d.recommendedMedium === "hook",
  );

  if (!hasRelevantRules) return hooks;

  // pre-commit hook: run lint-staged on staged files
  if (!hooks["pre-commit"]) {
    hooks["pre-commit"] = [
      "#!/bin/sh",
      ". \"$(dirname \"$0\")/_/husky.sh\"",
      "",
      "npx lint-staged",
    ].join("\n");
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
 * Generate .lintstagedrc.json content.
 * Configures lint-staged to run ESLint on staged JS/TS files.
 */
export function generateLintStagedConfig(): string {
  const config = {
    "*.{js,jsx,ts,tsx}": ["eslint --fix --max-warnings=0"],
    "*.{json,md,yaml,yml}": ["prettier --write --check"],
  };
  return JSON.stringify(config, null, 2);
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
