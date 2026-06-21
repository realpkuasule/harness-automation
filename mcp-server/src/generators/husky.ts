import type { RuleDecision } from "../types.js";

export interface HuskyConfig {
  decisions: RuleDecision[];
  /** Existing husky config (pre-commit, commit-msg, etc.) */
  existingHooks?: Record<string, string>;
  /** Prepend gitleaks secret scan to pre-commit hook */
  includeGitleaks?: boolean;
  /** Append branch naming convention check to pre-commit hook */
  includeBranchCheck?: boolean;
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

  const hasPreCommitFeatures = config.includeGitleaks || config.includeBranchCheck;

  if (!hasRelevantRules && !hasPreCommitFeatures) return hooks;

  // pre-commit hook: run lint-staged on staged files
  // Husky v9+ hooks are plain shell scripts — no _/husky.sh sourcing needed.
  if (!hooks["pre-commit"]) {
    const lines: string[] = ["#!/bin/sh", ""];

    if (config.includeGitleaks) {
      lines.push(
        "# Gitleaks secret scan (fast-fail)",
        "if command -v gitleaks &> /dev/null; then",
        "  gitleaks protect --staged -v || exit 1",
        "fi",
        "",
      );
    }

    lines.push("npx lint-staged");

    if (config.includeBranchCheck) {
      lines.push(
        "",
        "# Branch naming check",
        'BRANCH=$(git rev-parse --abbrev-ref HEAD)',
        "if ! echo \"$BRANCH\" | grep -qE '^(feature|bugfix|hotfix|release)/'; then",
        '  echo "⚠️  Branch name does not follow convention: feature|bugfix|hotfix|release/<desc>"',
        '  echo "   Current branch: $BRANCH"',
        "  exit 1",
        "fi",
      );
    }

    hooks["pre-commit"] = lines.join("\n");
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
