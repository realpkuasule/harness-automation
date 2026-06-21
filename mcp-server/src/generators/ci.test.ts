import { describe, it, expect } from "vitest";
import { generateCiWorkflow } from "./ci.js";
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

describe("generateCiWorkflow", () => {
  it("includes test step when test-before-merge is present", () => {
    const result = generateCiWorkflow({
      decisions: [makeDecision({ ruleName: "test-before-merge" })],
      gitProvider: "github",
    });
    expect(result).toContain("Run tests");
    expect(result).toContain("npm test");
  });

  it("includes lock check when dependency-lock is present", () => {
    const result = generateCiWorkflow({
      decisions: [makeDecision({ ruleName: "dependency-lock" })],
      gitProvider: "github",
    });
    expect(result).toContain("Check dependency lock");
    expect(result).toContain("lockfile-lint");
  });

  it("omits test step when test-before-merge is absent", () => {
    const result = generateCiWorkflow({
      decisions: [makeDecision({ ruleName: "no-console-log", recommendedMedium: "linter" })],
      gitProvider: "github",
    });
    expect(result).not.toContain("Run tests");
  });

  it("returns empty string when no ci rules and no techStack", () => {
    const result = generateCiWorkflow({ decisions: [], gitProvider: "github" });
    expect(result).toBe("");
  });

  it("returns empty string for prototype phase with no ci rules", () => {
    const result = generateCiWorkflow({ decisions: [], projectPhase: "prototype", gitProvider: "github" });
    expect(result).toBe("");
  });

  it("generates CI for prototype when ci medium rules exist", () => {
    const result = generateCiWorkflow({
      decisions: [makeDecision({ ruleName: "test-before-merge" })],
      projectPhase: "prototype",
      gitProvider: "github",
    });
    expect(result).toContain("Run tests");
  });

  it("generates CI for non-prototype phase even without ci rules", () => {
    const result = generateCiWorkflow({
      decisions: [],
      projectPhase: "growth",
      techStack: "typescript",
      gitProvider: "github",
    });
    expect(result).toContain("Harness CI");
    expect(result).toContain("Build check");
  });

  // 23. nodeVersion 参数
  it("uses specified nodeVersion in matrix", () => {
    const result = generateCiWorkflow({
      decisions: [makeDecision({ ruleName: "test-before-merge" })],
      nodeVersion: "20",
      gitProvider: "github",
    });
    expect(result).toContain("node-version: [20]");
  });

  // P1-1: gitProvider tests
  it("returns empty string when gitProvider is gitlab", () => {
    const result = generateCiWorkflow({
      decisions: [makeDecision({ ruleName: "test-before-merge" })],
      gitProvider: "gitlab",
    });
    expect(result).toBe("");
  });

  it("generates CI with dual-remote note when gitProvider is both", () => {
    const result = generateCiWorkflow({
      decisions: [makeDecision({ ruleName: "test-before-merge" })],
      gitProvider: "both",
    });
    expect(result).toContain("# Note: GitLab CI (.gitlab-ci.yml) is the primary CI for team collaboration.");
    expect(result).toContain("# This GitHub Actions workflow is for the personal backup repository.");
    expect(result).toContain("Run tests");
  });

  it("generates normal CI when gitProvider is github (explicit)", () => {
    const result = generateCiWorkflow({
      decisions: [makeDecision({ ruleName: "test-before-merge" })],
      gitProvider: "github",
    });
    expect(result).toContain("Run tests");
    expect(result).toContain("npm test");
    expect(result).not.toContain("GitLab CI");
  });
});
