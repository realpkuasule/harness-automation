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
  // Husky v9+ hooks are plain shell scripts — no _/husky.sh sourcing needed.
  if (!hooks["pre-commit"]) {
    hooks["pre-commit"] = [
      "#!/bin/sh",
      "",
      "npx lint-staged",
    ].join("\n");
  }

  // commit-msg hook: commitlint
  // Husky v9+ hooks are plain shell scripts — no _/husky.sh sourcing needed.
  if (!hooks["commit-msg"]) {
    hooks["commit-msg"] = [
      "#!/bin/sh",
      "",
      "npx --no -- commitlint --edit $1",
    ].join("\n");
  }

  return hooks;
}

/**
 * Generate lint-staged configuration content (used in package.json "lint-staged" field).
 * Configures lint-staged to run ESLint on staged JS/TS files.
 */
export function generateLintStagedConfig(): string {
  const config = {
    "*.{js,jsx,ts,tsx}": ["eslint --fix --max-warnings=0"],
    "*.{json,md,yaml,yml}": ["prettier --write"],
  };
  return JSON.stringify(config, null, 2);
}

/**
 * Generate commitlint.config.js content.
 * Uses @commitlint/config-conventional for conventional commit messages.
 */
export function generateCommitlintConfig(): string {
  return `module.exports = {
  extends: ["@commitlint/config-conventional"],
};
`;
}

/**
 * Generate the .husky directory structure instructions.
 *
 * Husky v9+ does not require `npx husky init` — hooks are plain shell scripts.
 * `npx husky init` would overwrite harness-generated hooks with stub content,
 * so we use `npx husky` (which just sets core.hooksPath) instead.
 */
export function generateHuskySetupInstructions(): string {
  return [
    "# Husky Setup",
    "Hooks have been created under .husky/. To activate them:",
    "",
    "  npx husky",
    "  chmod +x .husky/pre-commit .husky/commit-msg",
    "",
    "Do NOT run `npx husky init` — it would overwrite harness-generated hooks.",
  ].join("\n");
}
