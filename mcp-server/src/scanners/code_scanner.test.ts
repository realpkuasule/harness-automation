import { describe, it, expect } from "vitest";
import { CodeScanner } from "./code_scanner.js";

describe("CodeScanner", () => {
  const scanner = new CodeScanner();

  describe("scanContent", () => {
    it("detects console.log calls", () => {
      const findings = scanner.scanContent('console.log("hello");\nconst x = 1;\n', "test.ts");
      const consoleFindings = findings.filter((f) => f.ruleId === "no-console-log");
      expect(consoleFindings.length).toBe(1);
      expect(consoleFindings[0].confidence).toBe(0.95);
    });

    it("detects multiple console methods", () => {
      const code = `
        console.debug("debug");
        console.warn("warn");
        console.error("err");
      `;
      const findings = scanner.scanContent(code, "test.ts");
      expect(findings.filter((f) => f.ruleId === "no-console-log").length).toBe(3);
    });

    it("detects debugger statements", () => {
      const findings = scanner.scanContent("function foo() {\n  debugger;\n  return 1;\n}", "test.ts");
      const debuggerFindings = findings.filter((f) => f.ruleId === "no-debugger");
      expect(debuggerFindings.length).toBe(1);
      expect(debuggerFindings[0].confidence).toBe(0.99);
    });

    it("detects direct fetch calls", () => {
      const findings = scanner.scanContent('fetch("/api/data").then(r => r.json());', "test.ts");
      const fetchFindings = findings.filter((f) => f.ruleId === "no-direct-fetch");
      expect(fetchFindings.length).toBe(1);
    });

    it("does not flag method calls named fetch", () => {
      const findings = scanner.scanContent('this.fetch("/api");', "test.ts");
      const fetchFindings = findings.filter((f) => f.ruleId === "no-direct-fetch");
      // `this.fetch` is already preceded by `.`, the regex (?<![.\w]) should exclude it
      expect(fetchFindings.length).toBe(0);
    });

    it("detects magic numbers", () => {
      // Not a named constant — plain numeric literal
      const findings = scanner.scanContent("if (x > 30000) { return; }", "test.ts");
      const magicFindings = findings.filter((f) => f.ruleId === "no-magic-numbers");
      expect(magicFindings.length).toBe(1);
    });

    it("does not flag 0 or 1 as magic numbers", () => {
      const findings = scanner.scanContent("const x = 0;\nconst y = 1;", "test.ts");
      const magicFindings = findings.filter((f) => f.ruleId === "no-magic-numbers");
      expect(magicFindings.length).toBe(0);
    });

    it("does not flag named constants", () => {
      const findings = scanner.scanContent("const TIMEOUT_MS = 30000;", "test.ts");
      const magicFindings = findings.filter((f) => f.ruleId === "no-magic-numbers");
      // The regex should skip const declarations
      expect(magicFindings.length).toBe(0);
    });

    it("detects untyped any", () => {
      const findings = scanner.scanContent("function foo(x: any): void {}", "test.ts");
      const anyFindings = findings.filter((f) => f.ruleId === "type-annotations");
      expect(anyFindings.length).toBe(1);
    });

    it("does not flag 'any' in comments", () => {
      const code = [
        '// This function accepts param: any type',
        'function foo(x: string): void {}',
      ].join("\n");
      const findings = scanner.scanContent(code, "test.ts");
      const anyFindings = findings.filter((f) => f.ruleId === "type-annotations");
      expect(anyFindings.length).toBe(0);
    });

    it("does not flag 'any' in string literals", () => {
      const code = [
        'const msg = "Error: param: any type";',
        "const key = 'value: any key';",
        "function foo(x: string): void {}",
      ].join("\n");
      const findings = scanner.scanContent(code, "test.ts");
      const anyFindings = findings.filter((f) => f.ruleId === "type-annotations");
      expect(anyFindings.length).toBe(0);
    });

    it("detects real any annotation mixed with comments on preceding line", () => {
      const code = [
        "// TODO: fix this type later",
        "function foo(x: any): void {}",
      ].join("\n");
      const findings = scanner.scanContent(code, "test.ts");
      const anyFindings = findings.filter((f) => f.ruleId === "type-annotations");
      expect(anyFindings.length).toBe(1);
    });

    it("does not flag well-typed code", () => {
      const code = [
        "function add(a: number, b: number): number {",
        '  const msg = "return type: any value here";',
        "  return a + b;",
        "}",
      ].join("\n");
      const findings = scanner.scanContent(code, "test.ts");
      const anyFindings = findings.filter((f) => f.ruleId === "type-annotations");
      expect(anyFindings.length).toBe(0);
    });

    it("detects async functions without try-catch", () => {
      const findings = scanner.scanContent(
        'async function fetchData() {\n  const r = await fetch("/api");\n  return r.json();\n}',
        "test.ts",
      );
      const asyncFindings = findings.filter((f) => f.ruleId === "error-handling");
      expect(asyncFindings.length).toBe(1);
    });

    it("does not flag async functions with try-catch", () => {
      const findings = scanner.scanContent(
        'async function fetchData() {\n  try {\n    const r = await fetch("/api");\n    return r.json();\n  } catch (e) {\n    console.error(e);\n  }\n}',
        "test.ts",
      );
      const asyncFindings = findings.filter((f) => f.ruleId === "error-handling");
      expect(asyncFindings.length).toBe(0);
    });

    it("returns empty findings for clean code", () => {
      const code = `const x = 1;\nconst y = 2;\nfunction add(a: number, b: number): number {\n  return a + b;\n}`;
      const findings = scanner.scanContent(code, "clean.ts");
      expect(findings.length).toBe(0);
    });

    it("attaches correct file path to findings", () => {
      const findings = scanner.scanContent('console.log("test");', "src/app.ts");
      for (const f of findings) {
        expect(f.file).toBe("src/app.ts");
      }
    });
  });
});
