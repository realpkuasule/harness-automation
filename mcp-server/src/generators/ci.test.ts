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
    });
    expect(result).toContain("Run tests");
    expect(result).toContain("npm test");
  });

  it("includes lock check when dependency-lock is present", () => {
    const result = generateCiWorkflow({
      decisions: [makeDecision({ ruleName: "dependency-lock" })],
    });
    expect(result).toContain("Check dependency lock");
    expect(result).toContain("lockfile-lint");
  });

  it("omits test step when test-before-merge is absent", () => {
    const result = generateCiWorkflow({
      decisions: [makeDecision({ ruleName: "no-console-log", recommendedMedium: "linter" })],
    });
    expect(result).not.toContain("Run tests");
  });

  it("returns empty string when no ci rules and no techStack", () => {
    const result = generateCiWorkflow({ decisions: [] });
    expect(result).toBe("");
  });

  it("returns empty string for prototype phase with no ci rules", () => {
    const result = generateCiWorkflow({ decisions: [], projectPhase: "prototype" });
    expect(result).toBe("");
  });

  it("generates CI for prototype when ci medium rules exist", () => {
    const result = generateCiWorkflow({
      decisions: [makeDecision({ ruleName: "test-before-merge" })],
      projectPhase: "prototype",
    });
    expect(result).toContain("Run tests");
  });

  it("generates CI for non-prototype phase even without ci rules", () => {
    const result = generateCiWorkflow({
      decisions: [],
      projectPhase: "growth",
      techStack: "typescript",
    });
    expect(result).toContain("Harness CI");
    expect(result).toContain("Build check");
  });

  // 23. nodeVersion 参数
  it("uses specified nodeVersion in matrix", () => {
    const result = generateCiWorkflow({
      decisions: [makeDecision({ ruleName: "test-before-merge" })],
      nodeVersion: "20",
    });
    expect(result).toContain("node-version: [20]");
  });
});
