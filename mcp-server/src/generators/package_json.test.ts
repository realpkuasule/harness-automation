import { describe, it, expect } from "vitest";
import { mergeDependencies } from "./package_json.js";
import type { RuleDecision } from "../types.js";

function decision(ruleName: string): RuleDecision {
  return {
    ruleId: "R000",
    ruleName,
    recommendedMedium: "linter",
    alternativeMedia: [],
    confidence: 0.8,
    reasons: [],
    cognitiveLayerRequired: false,
    cognitiveSkillTriggers: [],
  };
}

describe("mergeDependencies", () => {
  // 27. 空 decisions
  it("returns empty missing when no decisions", () => {
    const result = mergeDependencies({ decisions: [] });
    expect(result.missing).toEqual([]);
    expect(result.suggestedCommands).toEqual([]);
    expect(result.merged).toEqual({});
  });

  // 28. commit-message-convention
  it("requires @commitlint deps for commit-message-convention", () => {
    const result = mergeDependencies({
      decisions: [decision("commit-message-convention")],
    });
    expect(result.missing).toContain("@commitlint/cli");
    expect(result.missing).toContain("@commitlint/config-conventional");
    expect(result.suggestedCommands.length).toBe(1);
    expect(result.suggestedCommands[0]).toContain("npm install --save-dev");
  });

  // 29. lint-before-commit
  it("requires husky and lint-staged for lint-before-commit", () => {
    const result = mergeDependencies({
      decisions: [decision("lint-before-commit")],
    });
    expect(result.missing).toContain("husky");
    expect(result.missing).toContain("lint-staged");
  });

  // 30. existing deps satisfied
  it("returns no missing deps when all are already present", () => {
    const result = mergeDependencies({
      decisions: [decision("commit-message-convention")],
      existingPackageJson: {
        devDependencies: {
          "@commitlint/cli": "^19.0.0",
          "@commitlint/config-conventional": "^19.0.0",
        },
      },
    });
    expect(result.missing).toEqual([]);
    expect(result.merged["@commitlint/cli"]).toBe("^19.0.0");
  });
});
