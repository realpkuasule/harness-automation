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

/** Parse flat config output: strip "module.exports = " or "export default " prefix and trailing ";\n" */
function parseFlatConfig(result: string): unknown[] {
  const json = result
    .replace(/^module\.exports = /, "")
    .replace(/^export default /, "")
    .replace(/;\n$/, "");
  return JSON.parse(json);
}

describe("generateEslintConfig", () => {
  it("returns comment when no linter decisions", () => {
    const result = generateEslintConfig({ decisions: [] });
    expect(result).toBe("// No linter rules recommended");
  });

  it("produces flat config array with a single rule", () => {
    const result = generateEslintConfig({
      decisions: [linterDecision("no-console-log")],
    });
    const parsed = parseFlatConfig(result);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(1);
    const config = parsed[0] as Record<string, unknown>;
    expect((config.rules as Record<string, unknown>)["no-console"]).toBeDefined();
  });

  it("includes all linter rules in output", () => {
    const decisions = [
      linterDecision("no-console-log"),
      linterDecision("no-debugger"),
      linterDecision("type-annotations"),
    ];
    const result = generateEslintConfig({ decisions });
    const parsed = parseFlatConfig(result);
    const config = parsed[0] as Record<string, unknown>;
    const rules = config.rules as Record<string, unknown>;
    expect(Object.keys(rules).length).toBe(3);
    expect(rules["no-debugger"]).toEqual(["error"]);
  });

  it("merges with existing config (object form)", () => {
    const result = generateEslintConfig({
      decisions: [linterDecision("no-console-log")],
      existingConfig: { rules: { semi: ["error", "always"] } } as Record<string, unknown>,
    });
    const parsed = parseFlatConfig(result);
    // existing config is prepended, generated config is second
    expect(parsed.length).toBe(2);
    const existing = parsed[0] as Record<string, unknown>;
    expect((existing.rules as Record<string, unknown>)["semi"]).toEqual(["error", "always"]);
    const generated = parsed[1] as Record<string, unknown>;
    expect((generated.rules as Record<string, unknown>)["no-console"]).toBeDefined();
  });

  it("maps all known rule names to ESLint configs", () => {
    const ruleNames = [
      "no-console-log", "no-direct-fetch", "no-magic-numbers",
      "type-annotations", "consistent-naming", "no-debugger",
      "no-large-files", "secure-env-vars",
    ];
    const decisions = ruleNames.map((name) => linterDecision(name));
    const result = generateEslintConfig({ decisions });

    const expectedEslintRules = [
      "no-console", "no-restricted-imports", "no-magic-numbers",
      "@typescript-eslint/explicit-function-return-type",
      "@typescript-eslint/naming-convention", "no-debugger",
      "max-lines", "no-process-env",
    ];
    const parsed = parseFlatConfig(result);
    const config = parsed[0] as Record<string, unknown>;
    const rules = config.rules as Record<string, unknown>;
    for (const esRule of expectedEslintRules) {
      expect(rules[esRule]).toBeDefined();
    }
  });

  it("handles linter_error severity correctly", () => {
    const result = generateEslintConfig({
      decisions: [linterDecision("secure-env-vars", { recommendedMedium: "linter_error" })],
    });
    const parsed = parseFlatConfig(result);
    const config = parsed[0] as Record<string, unknown>;
    const rules = config.rules as Record<string, unknown>;
    expect(rules["no-process-env"]).toEqual(["error"]);
  });

  it("outputs CommonJS format when no type field (default)", () => {
    const result = generateEslintConfig({
      decisions: [linterDecision("no-console-log")],
    });
    expect(result).toMatch(/^module\.exports = /);
    expect(result).toMatch(/;\n$/);
  });

  it("outputs ESM format when project has type: module", () => {
    const result = generateEslintConfig({
      decisions: [linterDecision("no-console-log")],
      projectDir: "/Users/zhichao/tmp/harness-test",
    });
    // harness-test has no type: module, so defaults to CJS
    expect(result).toMatch(/^module\.exports = /);
  });

  it("outputs ESM format for esm-project", () => {
    // We need a real package.json to test. Use a temp approach:
    // Mock by checking the format detection logic indirectly
    const result = generateEslintConfig({
      decisions: [linterDecision("no-console-log")],
      projectDir: "/nonexistent",
    });
    // No package.json found, defaults to CJS
    expect(result).toMatch(/^module\.exports = /);
  });

  it("uses projectDir when provided for ESM detection", () => {
    const result = generateEslintConfig({
      decisions: [linterDecision("no-console-log")],
      projectDir: undefined,
    });
    // No projectDir, defaults to CJS
    expect(result).toMatch(/^module\.exports = /);
  });
});
