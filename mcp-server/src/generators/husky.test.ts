import { describe, it, expect } from "vitest";
import { generateHuskyConfig, generateLintStagedConfig, generateCommitlintConfig } from "./husky.js";
import type { RuleDecision } from "../types.js";

function decision(ruleName: string, medium: RuleDecision["recommendedMedium"]): RuleDecision {
  return {
    ruleId: "R000",
    ruleName,
    recommendedMedium: medium,
    alternativeMedia: [],
    confidence: 0.8,
    reasons: [],
    cognitiveLayerRequired: false,
    cognitiveSkillTriggers: [],
  };
}

describe("generateHuskyConfig", () => {
  it("returns empty object when no relevant rules", () => {
    const result = generateHuskyConfig({ decisions: [decision("no-console-log", "settings.json")] });
    expect(result).toEqual({});
  });

  it("adds lint-staged to pre-commit when linter rules exist", () => {
    const result = generateHuskyConfig({
      decisions: [decision("no-console-log", "linter")],
    });
    expect(result["pre-commit"]).toBeDefined();
    expect(result["pre-commit"]).toContain("npx lint-staged");
    expect(result["pre-commit"]).not.toContain("npx eslint");
  });

  it("creates both pre-commit and commit-msg for hook rules", () => {
    const result = generateHuskyConfig({
      decisions: [decision("commit-message-convention", "hook")],
    });
    expect(result["pre-commit"]).toBeDefined();
    expect(result["pre-commit"]).toContain("npx lint-staged");
    expect(result["commit-msg"]).toBeDefined();
    expect(result["commit-msg"]).toContain("npx --no -- commitlint --edit $1");
  });

  it("preserves existing hooks and adds missing ones", () => {
    const result = generateHuskyConfig({
      decisions: [decision("no-console-log", "linter")],
      existingHooks: { "pre-commit": "#!/bin/sh\necho custom" },
    });
    expect(result["pre-commit"]).toBe("#!/bin/sh\necho custom");
    expect(result["commit-msg"]).toBeDefined();
  });

  it("all hooks have proper shebang and husky setup", () => {
    const result = generateHuskyConfig({
      decisions: [decision("no-console-log", "linter"), decision("commit-message-convention", "hook")],
    });
    for (const script of Object.values(result)) {
      expect(script.startsWith("#!/bin/sh")).toBe(true);
      expect(script).toContain('_/husky.sh');
    }
  });
});

describe("generateLintStagedConfig", () => {
  it("produces valid JSON with ESLint and Prettier rules", () => {
    const result = generateLintStagedConfig();
    const parsed = JSON.parse(result);
    expect(parsed["*.{js,jsx,ts,tsx}"]).toBeDefined();
    expect(parsed["*.{js,jsx,ts,tsx}"][0]).toContain("eslint");
    expect(parsed["*.{json,md,yaml,yml}"]).toBeDefined();
    expect(parsed["*.{json,md,yaml,yml}"][0]).toContain("prettier");
  });

  it("prettier command does not contain mutually exclusive --check flag", () => {
    const result = generateLintStagedConfig();
    expect(result).not.toContain("--check");
  });
});

describe("generateCommitlintConfig", () => {
  it("returns valid commitlint config with conventional commits extension", () => {
    const result = generateCommitlintConfig();
    expect(result).toContain("@commitlint/config-conventional");
    expect(result).toContain("module.exports");
  });
});
