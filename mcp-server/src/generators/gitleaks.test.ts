import { describe, it, expect } from "vitest";
import { generateGitleaksConfig } from "./gitleaks.js";
import type { RuleDecision } from "../types.js";

function secretDetectionDecision(overrides?: Partial<RuleDecision>): RuleDecision {
  return {
    ruleId: "R022",
    ruleName: "secret-detection",
    recommendedMedium: "hook",
    alternativeMedia: ["ci", "none"],
    confidence: 0.9,
    reasons: ["prevents credential leaks"],
    cognitiveLayerRequired: false,
    cognitiveSkillTriggers: [],
    ...overrides,
  };
}

describe("generateGitleaksConfig", () => {
  // Test 1: generates valid TOML config with title and allowlist
  it("generates valid TOML config with title and allowlist when R022 is present", () => {
    const result = generateGitleaksConfig({
      decisions: [secretDetectionDecision()],
    });

    expect(result.config).toBeDefined();
    expect(result.config.length).toBeGreaterThan(0);

    // Title
    expect(result.config).toContain('title = "Gitleaks Config"');

    // Allowlist section
    expect(result.config).toContain("[allowlist]");
    expect(result.config).toContain("test");
    expect(result.config).toContain("mock");
    expect(result.config).toContain("fixture");
    expect(result.config).toContain("node_modules");
    expect(result.config).toContain(".git");

    // It's valid TOML-like structure
    expect(result.config).toContain('description = "Allowlist for test files and common non-secret patterns"');
  });

  // Test 2: generates pre-commit hook snippet that runs gitleaks before lint-staged
  it("generates pre-commit hook snippet that runs gitleaks before lint-staged", () => {
    const result = generateGitleaksConfig({
      decisions: [secretDetectionDecision()],
    });

    expect(result.preCommitHook).toBeDefined();
    expect(result.preCommitHook.length).toBeGreaterThan(0);

    // Should run gitleaks protect --staged -v
    expect(result.preCommitHook).toContain("gitleaks protect --staged -v");

    // Should run before lint-staged
    expect(result.preCommitHook).toContain("lint-staged");
    expect(result.preCommitHook.indexOf("gitleaks")).toBeLessThan(result.preCommitHook.indexOf("lint-staged"));

    // Should be a shell script snippet
    expect(result.preCommitHook).toContain("#!/bin/sh");
  });

  // Test 3: returns empty strings when R022 is not present
  it("returns empty strings when R022/secret-detection decision is not present", () => {
    const result = generateGitleaksConfig({
      decisions: [],
    });

    expect(result.config).toBe("");
    expect(result.preCommitHook).toBe("");
  });

  it("returns empty strings when only unrelated decisions exist", () => {
    const result = generateGitleaksConfig({
      decisions: [
        {
          ruleId: "R001",
          ruleName: "no-console-log",
          recommendedMedium: "linter_warn",
          alternativeMedia: [],
          confidence: 0.85,
          reasons: [],
          cognitiveLayerRequired: false,
          cognitiveSkillTriggers: [],
        },
      ],
    });

    expect(result.config).toBe("");
    expect(result.preCommitHook).toBe("");
  });

  it("matches by ruleName when ruleId differs", () => {
    const result = generateGitleaksConfig({
      decisions: [
        {
          ruleId: "CUSTOM-001",
          ruleName: "secret-detection",
          recommendedMedium: "ci",
          alternativeMedia: [],
          confidence: 0.7,
          reasons: [],
          cognitiveLayerRequired: false,
          cognitiveSkillTriggers: [],
        },
      ],
    });

    expect(result.config).toContain("[allowlist]");
    expect(result.preCommitHook).toContain("gitleaks protect");
  });

  // Test 4: merges with existing config when provided
  it("merges with existing config when provided", () => {
    const existingConfig = `title = "Existing Gitleaks Config"

[extensions]
toml = "toml"

[rules]
[[rules]]
id = "custom-rule"
description = "a custom rule"
regex = "secret-[a-z]+"`;

    const result = generateGitleaksConfig({
      decisions: [secretDetectionDecision()],
      existingConfig,
    });

    // Should contain existing content
    expect(result.config).toContain('title = "Existing Gitleaks Config"');
    expect(result.config).toContain("[extensions]");
    expect(result.config).toContain("toml = \"toml\"");
    expect(result.config).toContain("id = \"custom-rule\"");

    // Should also contain generated allowlist
    expect(result.config).toContain("[allowlist]");
    expect(result.config).toContain("node_modules");
  });

  it("preserves existing allowlist entries when merging", () => {
    const existingConfig = `[allowlist]
description = "custom allowlist"
paths = [
  "custom/path",
]`;

    const result = generateGitleaksConfig({
      decisions: [secretDetectionDecision()],
      existingConfig,
    });

    expect(result.config).toContain("custom/path");
    expect(result.config).toContain("node_modules");
  });

  it("returns only existing config when no R022 decision but config provided", () => {
    const existingConfig = `[rules]
[[rules]]
id = "some-rule"`;

    const result = generateGitleaksConfig({
      decisions: [],
      existingConfig,
    });

    expect(result.config).toBe(existingConfig);
    expect(result.preCommitHook).toBe("");
  });
});
