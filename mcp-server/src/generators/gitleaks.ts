import type { RuleDecision } from "../types.js";

export interface GitleaksConfig {
  decisions: RuleDecision[];
  existingConfig?: string;
}

export interface GitleaksOutput {
  config: string;
  preCommitHook: string;
}

/**
 * Generate a .gitleaks.toml config and pre-commit hook snippet from rule decisions.
 *
 * - If no decision matches ruleId "R022" or ruleName "secret-detection", returns
 *   empty strings (or existing config as-is when provided).
 * - Otherwise generates a .gitleaks.toml with an allowlist for test files,
 *   node_modules, .git, and other common non-secret paths.
 * - Also generates a pre-commit hook snippet that runs `gitleaks protect --staged -v`
 *   before lint-staged.
 * - If existingConfig is provided, merges the generated allowlist into it.
 */
export function generateGitleaksConfig(config: GitleaksConfig): GitleaksOutput {
  const secretRule = config.decisions.find(
    (d) => d.ruleId === "R022" || d.ruleName === "secret-detection",
  );

  // No secret-detection rule: return empty or pass-through existing config
  if (!secretRule) {
    return {
      config: config.existingConfig ?? "",
      preCommitHook: "",
    };
  }

  // Build the generated TOML config
  const generatedToml = generateToml();

  // Merge with existing config if provided
  let mergedConfig: string;
  if (config.existingConfig) {
    mergedConfig = mergeConfigs(config.existingConfig, generatedToml);
  } else {
    mergedConfig = generatedToml;
  }

  const preCommitHook = generatePreCommitHook();

  return {
    config: mergedConfig,
    preCommitHook,
  };
}

/**
 * Generate the base .gitleaks.toml content with title and allowlist.
 */
function generateToml(): string {
  return `title = "Gitleaks Config"

[allowlist]
  description = "Allowlist for test files and common non-secret patterns"
  paths = [
    "**/test/**",
    "**/tests/**",
    "**/__tests__/**",
    "**/spec/**",
    "**/__mocks__/**",
    "**/mock*/**",
    "**/fixture*/**",
    "**/node_modules/**",
    "**/.git/**",
    "**/*.test.*",
    "**/*.spec.*",
    "**/*.snap",
  ]
`;
}

/**
 * Merge an existing TOML config string with the generated TOML content.
 *
 * Strategy:
 * - If the existing config already has an [allowlist] section, merge our paths
 *   into the existing paths array (avoiding duplicates).
 * - Otherwise, append the generated config to the existing one.
 */
function mergeConfigs(existing: string, generated: string): string {
  const existingHasAllowlist = /\[allowlist\]/i.test(existing);

  if (!existingHasAllowlist) {
    // No existing allowlist: append the generated config (which starts with title + allowlist)
    // But keep the existing title if present
    const existingHasTitle = /^title\s*=/m.test(existing);
    if (existingHasTitle) {
      // Remove the generated title line and append the rest
      const generatedWithoutTitle = generated.replace(/^title\s*=\s*[^\n]+\n/m, "").trimStart();
      return existing.trimEnd() + "\n\n" + generatedWithoutTitle + "\n";
    }
    return existing.trimEnd() + "\n\n" + generated.trim() + "\n";
  }

  // Existing config has an allowlist: extract generated paths and add to existing
  const generatedPaths = extractPaths(generated);
  const existingPaths = extractPaths(existing);

  const mergedPaths = [...existingPaths];
  for (const gp of generatedPaths) {
    if (!mergedPaths.includes(gp)) {
      mergedPaths.push(gp);
    }
  }

  // Replace the existing paths array with the merged array
  const pathsArrayStr = formatPathsArray(mergedPaths);
  const result = replacePathsInConfig(existing, pathsArrayStr);
  return result;
}

/**
 * Extract paths from a TOML paths array string.
 */
function extractPaths(toml: string): string[] {
  const paths: string[] = [];
  const pathMatch = toml.match(/paths\s*=\s*\[([\s\S]*?)\]/);
  if (!pathMatch) return paths;

  const pathContent = pathMatch[1];
  const pathRegex = /"([^"]+)"/g;
  let match;
  while ((match = pathRegex.exec(pathContent)) !== null) {
    paths.push(match[1]);
  }
  return paths;
}

/**
 * Format a paths array for TOML output.
 */
function formatPathsArray(paths: string[]): string {
  const lines = paths.map((p) => `    "${p}"`);
  return `paths = [\n${lines.join(",\n")},\n  ]`;
}

/**
 * Replace the paths array in a TOML config string.
 */
function replacePathsInConfig(toml: string, newPathsStr: string): string {
  return toml.replace(/paths\s*=\s*\[[\s\S]*?\]/, newPathsStr);
}

/**
 * Generate the pre-commit hook snippet.
 *
 * Runs gitleaks protect --staged -v before lint-staged.
 */
function generatePreCommitHook(): string {
  return `#!/bin/sh
# Harness-generated: gitleaks pre-commit hook
# Runs gitleaks protect --staged -v before lint-staged

echo "🔍 Running gitleaks scan on staged files..."
gitleaks protect --staged -v

if [ $? -ne 0 ]; then
  echo "❌ gitleaks detected secrets. Please remove them before committing."
  exit 1
fi

echo "✅ gitleaks scan passed."

# Continue to lint-staged
npx lint-staged`;
}
