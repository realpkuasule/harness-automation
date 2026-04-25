import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeExtractor } from "./claude_extractor.js";

describe("ClaudeExtractor — parseContent", () => {
  const extractor = new ClaudeExtractor();

  it("extracts heading-style rules from markdown", () => {
    const content = [
      "# Project Rules",
      "",
      "## Code Style",
      "### no-console-log",
      "Avoid using console.log in production code",
      "- linter rule",
      "",
      "### prefer-early-return",
      "Use early returns to reduce nesting",
      "- claude.md rule",
    ].join("\n");

    const rules = extractor.parseContent(content, "CLAUDE.md");
    expect(rules.length).toBeGreaterThanOrEqual(2);
    expect(rules.some((r) => r.name === "no-console-log")).toBe(true);
    expect(rules.some((r) => r.name === "prefer-early-return")).toBe(true);
  });

  it("extracts bullet-style rules with bold names", () => {
    const content = [
      "- **no-console-log**: Avoid console.log in production",
      "- **prefer-early-return**: Use early returns",
    ].join("\n");

    const rules = extractor.parseContent(content, "CLAUDE.md");
    expect(rules.length).toBe(2);
    expect(rules[0].name).toBe("no-console-log");
    expect(rules[0].description).toContain("Avoid console.log");
  });

  it("returns empty array for empty content", () => {
    const rules = extractor.parseContent("", "CLAUDE.md");
    expect(rules).toEqual([]);
  });

  it("returns empty array for content with no rule-like patterns", () => {
    const content = [
      "# README",
      "This is a readme file with no rules.",
      "Just some documentation text.",
    ].join("\n");
    const rules = extractor.parseContent(content, "CLAUDE.md");
    expect(rules).toEqual([]);
  });

  it("avoids duplicates between heading and bullet extraction", () => {
    const content = [
      "### no-console-log",
      "Avoid using console.log",
      "",
      "- **no-console-log**: Avoid using console.log in production",
    ].join("\n");

    const rules = extractor.parseContent(content, "CLAUDE.md");
    const consoleRules = rules.filter((r) => r.name === "no-console-log");
    expect(consoleRules.length).toBe(1);
  });

  it("infers medium from keyword context", () => {
    const content = [
      "### eslint-check",
      "This rule should be enforced by eslint.",
      "It runs as a linter check in CI.",
    ].join("\n");
    const rules = extractor.parseContent(content, "CLAUDE.md");
    const r = rules.find((r) => r.name === "eslint-check");
    expect(r).toBeDefined();
    expect(r!.medium).toBe("linter");
  });

  it("infers hook medium from husky keywords", () => {
    const content = [
      "### commit-lint",
      "Enforced via husky pre-commit hook.",
    ].join("\n");
    const rules = extractor.parseContent(content, "CLAUDE.md");
    const r = rules.find((r) => r.name === "commit-lint");
    expect(r).toBeDefined();
    expect(r!.medium).toBe("hook");
  });

  it("infers ci medium from github actions keywords", () => {
    const content = [
      "### test-check",
      "Runs in GitHub Actions CI pipeline.",
    ].join("\n");
    const rules = extractor.parseContent(content, "CLAUDE.md");
    const r = rules.find((r) => r.name === "test-check");
    expect(r).toBeDefined();
    expect(r!.medium).toBe("ci");
  });

  it("infers settings.json medium from vscode keywords", () => {
    const content = [
      "### formatting",
      "Configured in VS Code settings.json.",
    ].join("\n");
    const rules = extractor.parseContent(content, "CLAUDE.md");
    const r = rules.find((r) => r.name === "formatting");
    expect(r).toBeDefined();
    expect(r!.medium).toBe("settings.json");
  });
});

describe("ClaudeExtractor — extractFromProject", () => {
  let tmpDir: string;
  let extractor: ClaudeExtractor;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ht-extract-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    extractor = new ClaudeExtractor();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("extracts rules from CLAUDE.md at project root", () => {
    const content = [
      "### no-console-log",
      "Avoid using console.log",
    ].join("\n");
    writeFileSync(join(tmpDir, "CLAUDE.md"), content, "utf-8");

    const result = extractor.extractFromProject(tmpDir);
    expect(result.sourceFiles.length).toBe(1);
    expect(result.sourceFiles[0]).toContain("CLAUDE.md");
    expect(result.extractedRules.length).toBe(1);
  });

  it("extracts rules from .claude/CLAUDE.md", () => {
    const claudeDir = join(tmpDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "CLAUDE.md"), "### my-rule\nA custom rule", "utf-8");

    const result = extractor.extractFromProject(tmpDir);
    expect(result.sourceFiles.length).toBe(1);
    expect(result.extractedRules.length).toBe(1);
  });

  it("returns empty result when no CLAUDE.md files exist", () => {
    const result = extractor.extractFromProject(tmpDir);
    expect(result.sourceFiles).toEqual([]);
    expect(result.extractedRules).toEqual([]);
  });

  it("discovers multiple CLAUDE.md files at different locations", () => {
    writeFileSync(join(tmpDir, "CLAUDE.md"), "### root-rule\nRoot level", "utf-8");
    const docsDir = join(tmpDir, "docs");
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, "CLAUDE.md"), "### docs-rule\nDocs level", "utf-8");

    const result = extractor.extractFromProject(tmpDir);
    expect(result.sourceFiles.length).toBe(2);
    expect(result.extractedRules.length).toBe(2);
  });
});

describe("ClaudeExtractor — toRuleDefinitions", () => {
  it("converts extracted rules to partial RuleDefinition format", () => {
    const extractor = new ClaudeExtractor();
    const extracted = [
      { name: "no-console-log", description: "Avoid console.log", medium: "linter", sourceFile: "CLAUDE.md" },
      { name: "custom-rule", description: "A custom rule", sourceFile: "CLAUDE.md" },
    ];

    const defs = extractor.toRuleDefinitions(extracted);
    expect(defs.length).toBe(2);

    const r1 = defs.find((d) => d.name === "no-console-log")!;
    expect(r1.formalizable).toBe(true); // has medium
    expect(r1.recommendedMedium).toBe("linter");
    expect(r1.techStack).toEqual(["generic"]);

    const r2 = defs.find((d) => d.name === "custom-rule")!;
    expect(r2.formalizable).toBe(false); // no medium
    expect(r2.recommendedMedium).toBe("claude.md");
  });
});
