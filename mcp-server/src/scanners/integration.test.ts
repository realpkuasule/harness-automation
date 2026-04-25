import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanAndEvaluate, adjustDecisionsByScan } from "./integration.js";
import type { RuleDecision } from "../types.js";
import type { ScanSuggestion } from "./code_scanner.js";

function makeDecision(overrides?: Partial<RuleDecision>): RuleDecision {
  return {
    ruleId: "R001",
    ruleName: "no-console-log",
    recommendedMedium: "linter",
    alternativeMedia: [],
    confidence: 0.7,
    reasons: ["formalizable"],
    cognitiveLayerRequired: false,
    cognitiveSkillTriggers: [],
    ...overrides,
  };
}

function makeSuggestion(overrides?: Partial<ScanSuggestion>): ScanSuggestion {
  return {
    ruleId: "R001",
    description: "no-console-log — found 5 occurrence(s)",
    occurrences: 5,
    confidence: 0.95,
    severity: "medium",
    ...overrides,
  };
}

describe("adjustDecisionsByScan", () => {
  it("boosts confidence when scan suggestion matches", () => {
    const decisions = [makeDecision({ confidence: 0.7 })];
    const suggestions = [makeSuggestion({ occurrences: 5 })];

    const adjusted = adjustDecisionsByScan(decisions, suggestions);
    expect(adjusted[0].confidence).toBeGreaterThan(0.7);
    expect(adjusted[0].reasons).toContain("代码扫描发现 5 处匹配");
  });

  it("does not change confidence when no suggestion matches", () => {
    const decisions = [makeDecision({ ruleId: "R002", confidence: 0.8 })];
    const suggestions = [makeSuggestion({ ruleId: "R001" })];

    const adjusted = adjustDecisionsByScan(decisions, suggestions);
    expect(adjusted[0].confidence).toBe(0.8);
    expect(adjusted[0].reasons).not.toContain("代码扫描发现");
  });

  it("caps confidence boost to 1.0", () => {
    const decisions = [makeDecision({ confidence: 0.95 })];
    const suggestions = [makeSuggestion({ occurrences: 10 })];

    const adjusted = adjustDecisionsByScan(decisions, suggestions);
    expect(adjusted[0].confidence).toBeLessThanOrEqual(1);
  });

  it("handles empty decisions array", () => {
    const result = adjustDecisionsByScan([], []);
    expect(result).toEqual([]);
  });

  it("adjusts multiple decisions independently", () => {
    const decisions = [
      makeDecision({ ruleId: "R001", confidence: 0.7 }),
      makeDecision({ ruleId: "R002", confidence: 0.8 }),
      makeDecision({ ruleId: "R003", confidence: 0.9 }),
    ];
    const suggestions = [
      makeSuggestion({ ruleId: "R001", occurrences: 5 }),
      makeSuggestion({ ruleId: "R003", occurrences: 3 }),
    ];

    const adjusted = adjustDecisionsByScan(decisions, suggestions);
    expect(adjusted[0].confidence).toBeGreaterThan(0.7); // boosted
    expect(adjusted[1].confidence).toBe(0.8); // unchanged
    expect(adjusted[2].confidence).toBeGreaterThan(0.9); // boosted
  });
});

describe("scanAndEvaluate", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ht-scan-eval-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    mkdirSync(join(tmpDir, "src"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns integrated result with scan findings and decisions", async () => {
    writeFileSync(join(tmpDir, "src", "index.ts"), 'console.log("hello");\n', "utf-8");

    const result = await scanAndEvaluate({
      projectDir: tmpDir,
      projectPhase: "growth",
      teamSize: "medium",
      techStack: ["typescript"],
    });

    expect(result.scanSummary.filesScanned).toBeGreaterThan(0);
    expect(result.decisions.length).toBeGreaterThan(0);
    expect(result.extractedRules).toBe(0);
  });

  it("accepts useCache option", async () => {
    writeFileSync(join(tmpDir, "src", "index.ts"), 'console.log("hello");\n', "utf-8");

    const result = await scanAndEvaluate(
      {
        projectDir: tmpDir,
        projectPhase: "growth",
        teamSize: "medium",
        techStack: ["typescript"],
      },
      { useCache: true },
    );

    expect(result.scanSummary.filesScanned).toBeGreaterThan(0);
    expect(result.decisions.length).toBeGreaterThan(0);
  });

  it("extracts custom rules from existing CLAUDE.md", async () => {
    writeFileSync(join(tmpDir, "CLAUDE.md"), "### custom-rule\nA custom project rule", "utf-8");
    writeFileSync(join(tmpDir, "src", "index.ts"), 'const x = 1;\n', "utf-8");

    const result = await scanAndEvaluate({
      projectDir: tmpDir,
      projectPhase: "growth",
      teamSize: "medium",
      techStack: ["typescript"],
    });

    expect(result.extractedRules).toBeGreaterThan(0);
    expect(result.decisions.some((d) => d.ruleName === "custom-rule")).toBe(true);
  });

  it("returns zero filesScanned for empty project", async () => {
    const result = await scanAndEvaluate({
      projectDir: tmpDir,
      projectPhase: "prototype",
      teamSize: "solo",
      techStack: ["typescript"],
    });

    expect(result.scanSummary.filesScanned).toBe(0);
    expect(result.decisions.length).toBeGreaterThan(0);
  });
});
