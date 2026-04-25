import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DecisionEngine } from "./engine.js";
import { CodeScanner } from "./scanners/code_scanner.js";
import { generateClaudeMd } from "./generators/claude_md.js";
import { generateCiWorkflow } from "./generators/ci.js";
import type { RuleDecision } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "__fixtures__", "mixed");

describe("Performance baselines", () => {
  // 1. DecisionEngine construction (rules.json load)
  it("loads rules within 50ms", () => {
    const start = performance.now();
    const engine = new DecisionEngine();
    const duration = performance.now() - start;
    expect(duration).toBeLessThan(50);
    expect(engine).toBeDefined();
  });

  // 2. 100 consecutive evaluate calls
  it("evaluate averages under 10ms per call", () => {
    const engine = new DecisionEngine();
    const input = {
      projectDir: "/test",
      projectPhase: "growth" as const,
      teamSize: "medium" as const,
      techStack: ["typescript" as const],
    };

    const start = performance.now();
    const iterations = 100;
    for (let i = 0; i < iterations; i++) {
      engine.evaluate(input);
    }
    const avg = (performance.now() - start) / iterations;
    expect(avg).toBeLessThan(10);
  });

  // 3. scanDir first scan
  it("scans mixed/ fixture under 500ms", async () => {
    const scanner = new CodeScanner();
    const start = performance.now();
    const result = await scanner.scanDir(FIXTURES);
    const duration = performance.now() - start;
    expect(duration).toBeLessThan(500);
    expect(result.scannedFiles).toBeGreaterThan(0);
  });

  // 4. scanDirCached second scan
  it("cached scan under 50ms", async () => {
    const scanner = new CodeScanner();
    // Warm cache
    await scanner.scanDirCached(FIXTURES);
    const start = performance.now();
    const result = await scanner.scanDirCached(FIXTURES);
    const duration = performance.now() - start;
    expect(duration).toBeLessThan(50);
    expect(result.scannedFiles).toBeGreaterThan(0);
  });

  // 5. scanAndEvaluate full flow
  it("scan + evaluate full flow under 1000ms", async () => {
    const scanner = new CodeScanner();
    const engine = new DecisionEngine();
    const start = performance.now();
    const scanResult = await scanner.scanDir(FIXTURES);
    const output = engine.evaluate({
      projectDir: FIXTURES,
      projectPhase: "growth",
      teamSize: "medium",
      techStack: ["typescript", "python"],
    });
    const duration = performance.now() - start;
    expect(duration).toBeLessThan(1000);
    expect(scanResult.scannedFiles).toBeGreaterThan(0);
    expect(output.decisions.length).toBeGreaterThan(0);
  });

  // 6. generateClaudeMd with 50 decisions
  it("generates CLAUDE.md for 50 decisions under 10ms", () => {
    const decisions: RuleDecision[] = Array.from({ length: 50 }, (_, i) => ({
      ruleId: `R${String(i).padStart(3, "0")}`,
      ruleName: `rule-${i}`,
      recommendedMedium: (i % 5 === 0 ? "linter" : i % 5 === 1 ? "hook" : i % 5 === 2 ? "ci" : i % 5 === 3 ? "claude.md" : "settings.json") as RuleDecision["recommendedMedium"],
      alternativeMedia: [],
      confidence: 0.5 + (i % 5) * 0.1,
      reasons: ["test"],
      cognitiveLayerRequired: i % 3 === 0,
      cognitiveSkillTriggers: i % 3 === 0 ? ["diagnostic"] : [],
    }));
    const start = performance.now();
    const result = generateClaudeMd({ decisions, projectName: "PerfTest" });
    const duration = performance.now() - start;
    expect(duration).toBeLessThan(10);
    expect(result.length).toBeGreaterThan(0);
  });

  // 7. generateCiWorkflow with 50 decisions
  it("generates CI workflow for 50 decisions under 10ms", () => {
    const decisions: RuleDecision[] = Array.from({ length: 50 }, (_, i) => ({
      ruleId: `R${String(i).padStart(3, "0")}`,
      ruleName: "test-before-merge",
      recommendedMedium: "ci",
      alternativeMedia: [],
      confidence: 0.8,
      reasons: ["formalizable"],
      cognitiveLayerRequired: false,
      cognitiveSkillTriggers: [],
    }));
    const start = performance.now();
    const result = generateCiWorkflow({ decisions, techStack: "typescript", nodeVersion: "20" });
    const duration = performance.now() - start;
    expect(duration).toBeLessThan(10);
    expect(result).toContain("Run tests");
  });
});
