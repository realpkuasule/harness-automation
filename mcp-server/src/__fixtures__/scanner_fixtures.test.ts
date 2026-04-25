import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { CodeScanner } from "../scanners/code_scanner.js";
import { DecisionEngine } from "../engine.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "..", "__fixtures__");

function fixturePath(...parts: string[]): string {
  return join(FIXTURES, ...parts);
}

function readFixture(...parts: string[]): string {
  return readFileSync(fixturePath(...parts), "utf-8");
}

describe("Scanner fixtures — real file scanning", () => {
  const scanner = new CodeScanner();

  // 1. console-logs.ts
  it("detects console.log in typescript fixture", () => {
    const content = readFixture("typescript", "console-logs.ts");
    const findings = scanner.scanContent(content, "console-logs.ts");
    const consoleFindings = findings.filter((f) => f.ruleId === "no-console-log");
    expect(consoleFindings.length).toBeGreaterThanOrEqual(1);
  });

  // 2. debugger-statement.ts
  it("detects debugger in typescript fixture", () => {
    const content = readFixture("typescript", "debugger-statement.ts");
    const findings = scanner.scanContent(content, "debugger-statement.ts");
    const debuggerFindings = findings.filter((f) => f.ruleId === "no-debugger");
    expect(debuggerFindings.length).toBeGreaterThanOrEqual(1);
  });

  // 3. magic-numbers.ts
  it("detects magic numbers in typescript fixture", () => {
    const content = readFixture("typescript", "magic-numbers.ts");
    const findings = scanner.scanContent(content, "magic-numbers.ts");
    const magicFindings = findings.filter((f) => f.ruleId === "no-magic-numbers");
    expect(magicFindings.length).toBeGreaterThanOrEqual(1);
  });

  // 4. good.ts — clean code (no console.log, debugger, magic numbers, etc.)
  it("finds no violations in good.ts for most rule categories", () => {
    const content = readFixture("typescript", "good.ts");
    const findings = scanner.scanContent(content, "good.ts");
    const debuggerFindings = findings.filter((f) => f.ruleId === "no-debugger");
    const magicFindings = findings.filter((f) => f.ruleId === "no-magic-numbers");
    expect(debuggerFindings.length).toBe(0);
    expect(magicFindings.length).toBe(0);
  });

  // 6. python/console-logs.py — scanner is TS-focused, so no specific findings
  it("python fixture has scan-compatible findings", () => {
    const content = readFixture("python", "console-logs.py");
    const findings = scanner.scanContent(content, "console-logs.py");
    expect(Array.isArray(findings)).toBe(true);
  });
});

describe("Scanner fixtures — scanDir integration", () => {
  let tmpDir: string;
  let scanner: CodeScanner;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ht-fixture-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    scanner = new CodeScanner();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // 7. scanDir on typescript/ directory
  it("scans all typescript fixture files", async () => {
    const result = await scanner.scanDir(fixturePath("typescript"));
    expect(result.scannedFiles).toBeGreaterThanOrEqual(4);
    expect(result.findings.length).toBeGreaterThan(0);
  });

  // 8. scanDir on mixed/ directory
  it("scans mixed ts/py project", async () => {
    const result = await scanner.scanDir(fixturePath("mixed"));
    expect(result.scannedFiles).toBeGreaterThanOrEqual(1);
  });

  // 9. scanDir on non-existent directory
  it("returns empty result for non-existent directory", async () => {
    const result = await scanner.scanDir(join(tmpDir, "nonexistent"));
    expect(result.scannedFiles).toBe(0);
    expect(result.suggestions).toEqual([]);
  });
});

describe("Scanner — mixed/ project integration", () => {
  // 13. scan + engine evaluate
  it("scanAndEvaluate returns decisions and scan summary", async () => {
    const engine = new DecisionEngine();
    const scanner = new CodeScanner();
    const scanResult = await scanner.scanDir(fixturePath("mixed"));
    const output = engine.evaluate({
      projectDir: fixturePath("mixed"),
      projectPhase: "growth",
      teamSize: "medium",
      techStack: ["typescript", "python"],
    });

    expect(output.decisions.length).toBeGreaterThan(0);
    expect(scanResult.scannedFiles).toBeGreaterThan(0);
  });

  // 14. useCache = true
  it("cached scan returns valid results", async () => {
    const scanner = new CodeScanner();
    const result = await scanner.scanDirCached(fixturePath("mixed"));
    expect(result.scannedFiles).toBeGreaterThan(0);
    // Second call uses cache
    const result2 = await scanner.scanDirCached(fixturePath("mixed"));
    expect(result2.scannedFiles).toBeGreaterThan(0);
  });

  // 15. console.log in project
  it("mixed/ project has console.log findings", async () => {
    const scanner = new CodeScanner();
    const result = await scanner.scanDir(fixturePath("mixed"));
    const consoleFindings = result.findings.filter((f) => f.ruleId === "no-console-log");
    expect(consoleFindings.length).toBeGreaterThan(0);
  });
});

describe("Scanner — scan cache", () => {
  let tmpDir: string;
  let scanner: CodeScanner;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ht-cache-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    scanner = new CodeScanner();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // 10. first scan (no cache)
  it("first scan with no cache scans all files", async () => {
    writeFileSync(join(tmpDir, "src", "test.ts"), 'console.log("hello");\n', "utf-8");
    const result = await scanner.scanDirCached(tmpDir);
    expect(result.scannedFiles).toBe(1);
    expect(result.findings.length).toBe(1);
  });

  // 11. cached second scan
  it("cached second scan returns same findings", async () => {
    writeFileSync(join(tmpDir, "src", "test.ts"), 'console.log("hello");\n', "utf-8");
    const result1 = await scanner.scanDirCached(tmpDir);
    const result2 = await scanner.scanDirCached(tmpDir);
    expect(result2.scannedFiles).toBe(1);
    expect(result2.findings.length).toBe(result1.findings.length);
  });

  // 12. after clearing .harness cache, rescans all files
  it("clearing cache forces full rescan", async () => {
    writeFileSync(join(tmpDir, "src", "test.ts"), 'console.log("hello");\n', "utf-8");
    await scanner.scanDirCached(tmpDir);
    rmSync(join(tmpDir, ".harness"), { recursive: true, force: true });
    const result = await scanner.scanDirCached(tmpDir);
    expect(result.scannedFiles).toBe(1);
    expect(result.findings.length).toBe(1);
  });
});
