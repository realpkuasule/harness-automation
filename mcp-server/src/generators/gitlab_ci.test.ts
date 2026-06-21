import { describe, it, expect } from "vitest";
import { generateGitlabCiWorkflow } from "./gitlab_ci.js";
import type { RuleDecision } from "../types.js";

const baseDecision: RuleDecision = {
  ruleId: "R007",
  ruleName: "test-before-merge",
  recommendedMedium: "ci",
  alternativeMedia: ["hook", "claude.md"],
  confidence: 0.8,
  reasons: ["formalizable"],
  cognitiveLayerRequired: false,
  cognitiveSkillTriggers: [],
};

function makeDecision(overrides?: Partial<RuleDecision>): RuleDecision {
  return { ...baseDecision, ...overrides };
}

describe("generateGitlabCiWorkflow", () => {
  // ============================================================
  // Test 1: Full CI config with all stages
  // ============================================================
  it("generates all stages for full CI config (lint, test, security, ai-review, build)", () => {
    const result = generateGitlabCiWorkflow({
      decisions: [
        makeDecision({ ruleId: "R007", ruleName: "test-before-merge", recommendedMedium: "ci" }),
        makeDecision({ ruleId: "R021", ruleName: "ai-code-review", recommendedMedium: "ci" }),
        makeDecision({ ruleId: "R022", ruleName: "secret-detection", recommendedMedium: "ci" }),
        makeDecision({ ruleId: "R001", ruleName: "no-console-log", recommendedMedium: "linter_error" }),
      ],
      projectPhase: "growth",
    });

    expect(result).toContain("lint");
    expect(result).toContain("test");
    expect(result).toContain("security");
    expect(result).toContain("ai-review");
    expect(result).toContain("build");
    // Verify the stages array is declared in order
    const stagesMatch = result.match(/stages:\n((?:  - .+\n)+)/);
    expect(stagesMatch).not.toBeNull();
    if (stagesMatch) {
      const stages = stagesMatch[1];
      const stageOrder = stages.split("\n").filter((s) => s.trim()).map((s) => s.trim().replace("- ", ""));
      expect(stageOrder).toEqual(["lint", "test", "security", "ai-review", "build"]);
    }
  });

  // ============================================================
  // Test 2: Omits security stage when R022 is not present
  // ============================================================
  it("omits security stage when R022 is not present", () => {
    const result = generateGitlabCiWorkflow({
      decisions: [
        makeDecision({ ruleId: "R007", ruleName: "test-before-merge", recommendedMedium: "ci" }),
        makeDecision({ ruleId: "R021", ruleName: "ai-code-review", recommendedMedium: "ci" }),
        makeDecision({ ruleId: "R001", ruleName: "no-console-log", recommendedMedium: "linter_error" }),
      ],
      projectPhase: "growth",
    });

    expect(result).toContain("lint");
    expect(result).toContain("test");
    expect(result).toContain("ai-review");
    expect(result).toContain("build");
    expect(result).not.toContain("- Security/SAST");
    expect(result).not.toContain("- Security/Secret-Detection");
    expect(result).not.toContain("- Security/Dependency-Scanning");
    // Security should not appear in stages
    const stagesMatch = result.match(/stages:\n((?:  - .+\n)+)/);
    if (stagesMatch) {
      expect(stagesMatch[1]).not.toContain("security");
    }
  });

  // ============================================================
  // Test 3: Omits AI review stage when R021 is not present
  // ============================================================
  it("omits AI review stage when R021 is not present", () => {
    const result = generateGitlabCiWorkflow({
      decisions: [
        makeDecision({ ruleId: "R007", ruleName: "test-before-merge", recommendedMedium: "ci" }),
        makeDecision({ ruleId: "R022", ruleName: "secret-detection", recommendedMedium: "ci" }),
        makeDecision({ ruleId: "R001", ruleName: "no-console-log", recommendedMedium: "linter_error" }),
      ],
      projectPhase: "growth",
    });

    expect(result).toContain("lint");
    expect(result).toContain("test");
    expect(result).toContain("security");
    expect(result).toContain("build");
    expect(result).not.toContain("ai-review");
    // Verify ai-review not in stages
    const stagesMatch = result.match(/stages:\n((?:  - .+\n)+)/);
    if (stagesMatch) {
      expect(stagesMatch[1]).not.toContain("ai-review");
    }
  });

  // ============================================================
  // Test 4: Returns empty string for prototype phase with no CI rules
  // ============================================================
  it("returns empty string for prototype phase with no CI rules", () => {
    const result = generateGitlabCiWorkflow({
      decisions: [
        makeDecision({ ruleId: "R001", ruleName: "no-console-log", recommendedMedium: "linter_error" }),
      ],
      projectPhase: "prototype",
    });

    expect(result).toBe("");
  });

  // ============================================================
  // Test 5: Includes GitLab security templates when R022 is present
  // ============================================================
  it("includes GitLab security templates when R022 is present", () => {
    const result = generateGitlabCiWorkflow({
      decisions: [
        makeDecision({ ruleId: "R022", ruleName: "secret-detection", recommendedMedium: "ci" }),
      ],
      projectPhase: "growth",
    });

    expect(result).toContain("Security/SAST");
    expect(result).toContain("Security/Secret-Detection");
    expect(result).toContain("Security/Dependency-Scanning");
    expect(result).toContain("include:");
  });

  // ============================================================
  // Test 6: Includes merge request pipeline rules for ai-review
  // ============================================================
  it("includes merge request pipeline rules for ai-review", () => {
    const result = generateGitlabCiWorkflow({
      decisions: [
        makeDecision({ ruleId: "R021", ruleName: "ai-code-review", recommendedMedium: "ci" }),
      ],
      projectPhase: "growth",
    });

    expect(result).toContain("ai-review");
    expect(result).toContain("merge_request_event");
    expect(result).toContain("$CI_COMMIT_BRANCH");
  });
});
