import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateEslintConfig } from "./eslint.js";
import type { RuleDecision } from "../types.js";

let tmpDir: string;
let tmpDirEsm: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "harness-test-"));
  writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }));

  tmpDirEsm = mkdtempSync(join(tmpdir(), "harness-test-esm-"));
  writeFileSync(join(tmpDirEsm, "package.json"), JSON.stringify({ name: "test-esm", type: "module" }));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(tmpDirEsm, { recursive: true, force: true });
});

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

/** Parse flat config output: extract JSON array after require/import lines and module.exports / export default */
function parseFlatConfig(result: string): unknown[] {
  const match = result.match(/(?:module\.exports|export default)\s*=\s*(\[[\s\S]*\]);?\s*$/);
  if (!match) {
    throw new Error("Could not parse flat config JSON array from output");
  }
  // Replace unquoted variable references with placeholder strings for JSON parsing
  const json = match[1]
    .replace(/\btsparser\b/g, '"__PARSER_REF__"')
    .replace(/\btseslint\b/g, '"__PLUGIN_REF__"');
  return JSON.parse(json);
}

describe("generateEslintConfig", () => {
  it("returns framework config with empty rules when no linter decisions", () => {
    const result = generateEslintConfig({ decisions: [] });
    const parsed = parseFlatConfig(result);
    expect(Array.isArray(parsed)).toBe(true);
    const config = parsed[parsed.length - 1] as Record<string, unknown>;
    expect(config.files).toEqual(["**/*.{js,jsx,ts,tsx}"]);
    expect(config.languageOptions).toBeDefined();
    expect(config.plugins).toBeDefined();
    expect(config.rules).toEqual({});
  });

  it("produces flat config array with a single rule", () => {
    const result = generateEslintConfig({
      decisions: [linterDecision("no-console-log")],
    });
    const parsed = parseFlatConfig(result);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(1);
    const config = parsed[parsed.length - 1] as Record<string, unknown>;
    expect((config.rules as Record<string, unknown>)["no-console"]).toBeDefined();
    expect(config.files).toBeDefined();
    expect(config.languageOptions).toBeDefined();
    expect(config.plugins).toBeDefined();
  });

  it("includes all linter rules in output", () => {
    const decisions = [
      linterDecision("no-console-log"),
      linterDecision("no-debugger"),
      linterDecision("type-annotations"),
    ];
    const result = generateEslintConfig({ decisions });
    const parsed = parseFlatConfig(result);
    const config = parsed[parsed.length - 1] as Record<string, unknown>;
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
    // existing config is prepended, generated framework config is second (last)
    expect(parsed.length).toBe(2);
    const existing = parsed[0] as Record<string, unknown>;
    expect((existing.rules as Record<string, unknown>)["semi"]).toEqual(["error", "always"]);
    const generated = parsed[parsed.length - 1] as Record<string, unknown>;
    expect((generated.rules as Record<string, unknown>)["no-console"]).toBeDefined();
    expect(generated.files).toBeDefined();
  });

  it("generated config includes framework setup (files, languageOptions, plugins)", () => {
    const result = generateEslintConfig({
      decisions: [linterDecision("no-console-log")],
    });
    const parsed = parseFlatConfig(result);
    const config = parsed[parsed.length - 1] as Record<string, unknown>;
    expect(config.files).toEqual(["**/*.{js,jsx,ts,tsx}"]);
    const langOpts = config.languageOptions as Record<string, unknown>;
    expect(langOpts).toBeDefined();
    expect(langOpts.parserOptions).toEqual({ ecmaVersion: "latest", sourceType: "module" });
    const plugins = config.plugins as Record<string, unknown>;
    expect(plugins).toBeDefined();
    expect(plugins["@typescript-eslint"]).toBeDefined();
  });

  it("maps all known rule names to ESLint configs", () => {
    const ruleNames = [
      "no-console-log", "no-direct-fetch", "no-magic-numbers",
      "type-annotations", "consistent-naming", "no-debugger",
      "no-large-files",
    ];
    const decisions = ruleNames.map((name) => linterDecision(name));
    const result = generateEslintConfig({ decisions });

    const expectedEslintRules = [
      "no-console", "no-restricted-imports", "@typescript-eslint/no-magic-numbers",
      "@typescript-eslint/explicit-function-return-type",
      "@typescript-eslint/naming-convention", "no-debugger",
      "max-lines",
    ];
    const parsed = parseFlatConfig(result);
    const config = parsed[parsed.length - 1] as Record<string, unknown>;
    const rules = config.rules as Record<string, unknown>;
    for (const esRule of expectedEslintRules) {
      expect(rules[esRule]).toBeDefined();
    }
  });

  it("handles linter_error severity correctly", () => {
    const result = generateEslintConfig({
      decisions: [linterDecision("no-debugger", { recommendedMedium: "linter_error" })],
    });
    const parsed = parseFlatConfig(result);
    const config = parsed[parsed.length - 1] as Record<string, unknown>;
    const rules = config.rules as Record<string, unknown>;
    expect(rules["no-debugger"]).toEqual(["error"]);
  });

  it("outputs CommonJS format when no type field (default)", () => {
    const result = generateEslintConfig({
      decisions: [linterDecision("no-console-log")],
    });
    expect(result).toMatch(/const tseslint = require\(/);
    expect(result).toMatch(/module\.exports = /);
    expect(result).toMatch(/;\n$/);
  });

  it("outputs CJS format when project has no type: module", () => {
    const result = generateEslintConfig({
      decisions: [linterDecision("no-console-log")],
      projectDir: tmpDir,
    });
    // tmpDir package.json has no type: module, so defaults to CJS
    expect(result).toMatch(/const tseslint = require\(/);
    expect(result).toMatch(/module\.exports = /);
  });

  it("outputs ESM format when project has type: module", () => {
    const result = generateEslintConfig({
      decisions: [linterDecision("no-console-log")],
      projectDir: tmpDirEsm,
    });
    expect(result).toMatch(/import tseslint from/);
    expect(result).toMatch(/export default /);
  });

  it("outputs CJS format for nonexistent project dir", () => {
    // No package.json found, defaults to CJS
    const result = generateEslintConfig({
      decisions: [linterDecision("no-console-log")],
      projectDir: "/nonexistent",
    });
    expect(result).toMatch(/const tseslint = require\(/);
  });

  it("uses projectDir when provided for ESM detection", () => {
    const result = generateEslintConfig({
      decisions: [linterDecision("no-console-log")],
      projectDir: undefined,
    });
    // No projectDir, defaults to CJS
    expect(result).toMatch(/const tseslint = require\(/);
  });
});
