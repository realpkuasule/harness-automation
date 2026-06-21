import { describe, it, expect } from "vitest";
import { generateTeamOnboarding } from "./team_onboarding.js";
import type { RuleDecision } from "../types.js";

function makeDecision(overrides: Partial<RuleDecision> = {}): RuleDecision {
  return {
    ruleId: "R001",
    ruleName: "Test Rule",
    recommendedMedium: "claude_md",
    alternativeMedia: [],
    confidence: 0.9,
    reasons: [],
    cognitiveLayerRequired: false,
    cognitiveSkillTriggers: [],
    ...overrides,
  };
}

describe("generateTeamOnboarding", () => {
  // ============================================================
  // Test 1: script has set -euo pipefail
  // ============================================================
  it("includes set -euo pipefail at the top of the script", () => {
    const result = generateTeamOnboarding({
      decisions: [makeDecision()],
    });

    // Should be one of the first lines (after optional comment lines)
    const lines = result.split("\n");
    const firstNonCommentIndex = lines.findIndex(
      (line) => line.trim() !== "" && !line.trim().startsWith("#"),
    );
    expect(firstNonCommentIndex).toBeGreaterThan(-1);
    const firstLine = lines[firstNonCommentIndex].trim();
    expect(firstLine).toBe("set -euo pipefail");
  });

  // ============================================================
  // Test 2: includes prerequisite checks
  // ============================================================
  it("includes prerequisite checks for node, npm, and git", () => {
    const result = generateTeamOnboarding({
      decisions: [makeDecision()],
    });

    expect(result).toContain("Checking prerequisites");
    expect(result).toContain("command -v node");
    expect(result).toContain("command -v npm");
    expect(result).toContain("command -v git");
  });

  // ============================================================
  // Test 3: includes husky setup
  // ============================================================
  it("includes husky setup section", () => {
    const result = generateTeamOnboarding({
      decisions: [makeDecision()],
    });

    expect(result).toContain("Setting up Git hooks");
    expect(result).toContain("husky");
  });

  // ============================================================
  // Test 4: includes gitleaks when R022 is active
  // ============================================================
  it("includes gitleaks installation check when R022 (secret-detection) is in decisions", () => {
    const r022: RuleDecision = {
      ruleId: "R022",
      ruleName: "secret-detection",
      recommendedMedium: "hook",
      alternativeMedia: ["ci", "none"],
      confidence: 0.95,
      reasons: ["Prevent secret leaks"],
      cognitiveLayerRequired: false,
      cognitiveSkillTriggers: [],
    };

    const result = generateTeamOnboarding({
      decisions: [makeDecision(), r022],
    });

    expect(result).toContain("Installing Gitleaks");
    expect(result).toContain("gitleaks");
  });

  it("does NOT include gitleaks section when R022 is absent", () => {
    const result = generateTeamOnboarding({
      decisions: [makeDecision({ ruleId: "R001" })],
    });

    expect(result).not.toContain("Installing Gitleaks");
  });

  // ============================================================
  // Test 5: dual remote configuration when gitProvider is "both"
  // ============================================================
  it("includes dual remote configuration when gitProvider is both", () => {
    const result = generateTeamOnboarding({
      decisions: [makeDecision()],
      gitProvider: "both",
    });

    expect(result).toContain("Configuring dual remote");
    expect(result).toContain("github");
    expect(result).toContain("gitlab");
  });

  it("does NOT include dual remote when gitProvider is not both", () => {
    const result = generateTeamOnboarding({
      decisions: [makeDecision()],
      gitProvider: "github",
    });

    expect(result).not.toContain("Configuring dual remote");
  });

  // ============================================================
  // Test 6: script is idempotent (uses checks before actions)
  // ============================================================
  it("is idempotent — uses conditional checks before destructive actions", () => {
    const result = generateTeamOnboarding({
      decisions: [makeDecision()],
      gitProvider: "both",
    });

    // The script should use if/check patterns, not blind actions
    // Check for common sh idempotency patterns
    const checks = [
      "if !",           // guard clauses
      "if [",           // test conditions
      "if [[",          // bash test conditions
    ];

    const hasAtLeastOneCheck = checks.some((pattern) => result.includes(pattern));
    expect(hasAtLeastOneCheck).toBe(true);
  });

  it("npm install is guarded by node_modules check", () => {
    const result = generateTeamOnboarding({
      decisions: [makeDecision()],
    });

    // npm install should only run if node_modules doesn't exist
    // Either directly guarded or part of the install section
    expect(result).toContain("npm install");
    // Check that node_modules is mentioned near npm install
    const installIdx = result.indexOf("npm install");
    const nodeModulesIdx = result.indexOf("node_modules");
    expect(nodeModulesIdx).toBeGreaterThan(-1);
    // node_modules should appear relatively close to npm install
    expect(Math.abs(installIdx - nodeModulesIdx)).toBeLessThan(1000);
  });

  // ============================================================
  // Additional: script structure completeness
  // ============================================================
  it("includes verification and onboarding complete sections", () => {
    const result = generateTeamOnboarding({
      decisions: [makeDecision()],
    });

    expect(result).toContain("Verifying setup");
    expect(result).toContain("Onboarding complete");
  });

  it("returns a string (shell script content)", () => {
    const result = generateTeamOnboarding({
      decisions: [makeDecision()],
    });

    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(100);
    expect(result).toContain("#!/");
  });
});
