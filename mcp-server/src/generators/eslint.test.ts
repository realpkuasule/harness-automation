import { describe, it, expect } from "vitest";
import { generateEslintConfig } from "./eslint.js";
import type { RuleDecision } from "../types.js";

function linterDecision(name: string, overrides?: Partial<RuleDecision>): RuleDecision {
  return {
    ruleId: "R001",
    ruleName: name,
    recommendedMedium: "linter_warn",
    alternativeMedia: [],
    confidence: 0.85,
    reasons: [],
    cognitiveLayerRequired: false,
    cognitiveSkillTriggers: [],
    ...overrides,
  };
}

describe("generateEslintConfig", () => {
  // 6. 无 linter 决策
  it("returns comment when no linter decisions", () => {
    const result = generateEslintConfig({ decisions: [] });
    expect(result).toBe("// No linter rules recommended");
  });

  // 7. 单个 linter rule
  it("produces valid JSON with a single rule", () => {
    const result = generateEslintConfig({
      decisions: [linterDecision("no-console-log")],
    });
    const parsed = JSON.parse(result);
    expect(parsed.rules["no-console"]).toBeDefined();
    expect(parsed.rules["no-console"][0]).toBe("warn");
  });

  // 8. 多个 linter rules
  it("includes all linter rules in output", () => {
    const decisions = [
      linterDecision("no-console-log"),
      linterDecision("no-debugger"),
      linterDecision("type-annotations"),
    ];
    const result = generateEslintConfig({ decisions });
    const parsed = JSON.parse(result);
    expect(Object.keys(parsed.rules).length).toBe(3);
    expect(parsed.rules["no-debugger"][0]).toBe("error");
  });

  // 9. 合并 existingConfig
  it("merges with existing config", () => {
    const result = generateEslintConfig({
      decisions: [linterDecision("no-console-log")],
      existingConfig: {
        rules: { semi: ["error", "always"] },
      },
    });
    const parsed = JSON.parse(result);
    expect(parsed.rules.semi).toEqual(["error", "always"]);
    expect(parsed.rules["no-console"]).toBeDefined();
  });

  // ESLint rule mapping coverage
  it("maps all known rule names to ESLint configs", () => {
    const ruleNames = [
      "no-console-log", "no-direct-fetch", "no-magic-numbers",
      "type-annotations", "consistent-naming", "no-debugger",
      "no-large-files", "secure-env-vars",
    ];
    const decisions = ruleNames.map((name) => linterDecision(name));
    const result = generateEslintConfig({ decisions });

    // These rules now map to ESLint rule names (not harness rule names)
    const expectedEslintRules = [
      "no-console", "no-restricted-imports", "no-magic-numbers",
      "typescript-eslint/explicit-function-return-type",
      "typescript-eslint/naming-convention", "no-debugger",
      "max-lines", "no-process-env",
    ];
    const parsed = JSON.parse(result);
    for (const esRule of expectedEslintRules) {
      expect(parsed.rules[esRule]).toBeDefined();
    }
  });
});
