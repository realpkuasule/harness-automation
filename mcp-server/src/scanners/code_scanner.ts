import { readFileSync, existsSync } from "node:fs";
import { stat, readdir } from "node:fs/promises";
import { join, extname } from "node:path";
import { parse } from "@typescript-eslint/parser";
import { ScanCache } from "./scan_cache.js";

// ============================================================
// Types
// ============================================================

export interface ScanFinding {
  ruleId: string;
  file: string;
  line: number;
  snippet: string;
  confidence: number; // 0-1
}

export interface ScanSuggestion {
  ruleId: string;
  description: string;
  occurrences: number;
  confidence: number;
  severity: "low" | "medium" | "high";
}

export interface CodeScanResult {
  scannedFiles: number;
  totalLines: number;
  findings: ScanFinding[];
  suggestions: ScanSuggestion[];
  durationMs: number;
}

// ============================================================
// Helpers
// ============================================================

const TS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

function isSourceFile(name: string): boolean {
  return TS_EXTENSIONS.has(extname(name));
}

function lineColFromIndex(text: string, index: number): { line: number; col: number } {
  const before = text.slice(0, index);
  const lines = before.split("\n");
  return { line: lines.length, col: lines[lines.length - 1].length + 1 };
}

function getSnippet(text: string, line: number, context = 1): string {
  const lines = text.split("\n");
  const start = Math.max(0, line - 1 - context);
  const end = Math.min(lines.length, line + context);
  return lines.slice(start, end).join("\n");
}

// ============================================================
// Pattern Checkers
// ============================================================

interface PatternMatch {
  line: number;
  snippet: string;
}

function findConsoleCalls(text: string): PatternMatch[] {
  const matches: PatternMatch[] = [];
  const regex = /\bconsole\.(log|debug|info|warn|error)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    const { line } = lineColFromIndex(text, m.index);
    matches.push({ line, snippet: getSnippet(text, line, 0) });
  }
  return matches;
}

function findDebuggerStatements(text: string): PatternMatch[] {
  const matches: PatternMatch[] = [];
  const regex = /\bdebugger\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    const { line } = lineColFromIndex(text, m.index);
    matches.push({ line, snippet: getSnippet(text, line, 0) });
  }
  return matches;
}

function findDirectFetch(text: string): PatternMatch[] {
  const matches: PatternMatch[] = [];
  // Match fetch() that isn't preceded by a wrapper function/object
  const regex = /(?<![.\w])fetch\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    const { line } = lineColFromIndex(text, m.index);
    matches.push({ line, snippet: getSnippet(text, line, 0) });
  }
  return matches;
}

function findMagicNumbers(text: string): PatternMatch[] {
  const matches: PatternMatch[] = [];
  // Match numeric literals that look like magic numbers (not 0, 1, -1, 100, etc.)
  const regex = /(?<!\w)(?:[2-9]\d|[1-9]\d{2,})(?!\.\d)/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    const before = text.slice(Math.max(0, m.index - 30), m.index);
    // Skip if it's a const/let/var declaration (named constant)
    if (/\b(const|let|var)\s+\w+\s*=\s*$/.test(before)) continue;
    // Skip if it's an array index or type annotation
    if (text[m.index - 1] === "[" || text[m.index - 1] === "|") continue;
    const { line } = lineColFromIndex(text, m.index);
    matches.push({ line, snippet: getSnippet(text, line, 0) });
  }
  return matches;
}

function findUntypedAny(text: string): PatternMatch[] {
  const matches: PatternMatch[] = [];
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip comment-only lines
    if (line.trim().startsWith("//")) continue;

    const regex = /:\s*any\b(?!\s*\[)/g;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(line)) !== null) {
      // Skip matches inside string literals (simple heuristic: odd number of unescaped quotes before match)
      const before = line.slice(0, m.index);
      const doubleQuotes = before.replace(/\\"/g, "").split('"').length - 1;
      const singleQuotes = before.replace(/\\'/g, "").split("'").length - 1;
      const backticks = before.replace(/\\`/g, "").split("`").length - 1;
      if (doubleQuotes % 2 === 1 || singleQuotes % 2 === 1 || backticks % 2 === 1) continue;

      matches.push({ line: i + 1, snippet: getSnippet(text, i + 1, 0) });
    }
  }
  return matches;
}

function findAsyncWithoutTryCatch(text: string): PatternMatch[] {
  const matches: PatternMatch[] = [];
  // Detect async functions without try-catch
  const asyncRegex = /\basync\s+function\b|\basync\s+\(|\basync\s+\w+\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = asyncRegex.exec(text)) !== null) {
    const chunk = text.slice(m.index, m.index + 500);
    if (!/\btry\b/.test(chunk) && !/\.catch\s*\(/.test(chunk)) {
      const { line } = lineColFromIndex(text, m.index);
      matches.push({ line, snippet: getSnippet(text, line, 0) });
    }
  }
  return matches;
}

// ============================================================
// Scanner
// ============================================================

export class CodeScanner {
  private excludeDirs = new Set([
    "node_modules", "dist", "build", ".git", ".next",
    "coverage", ".harness", "vendor", ".cache",
  ]);

  /** Collect all source files recursively. */
  private async collectFiles(dir: string): Promise<string[]> {
    const files: string[] = [];

    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!this.excludeDirs.has(entry.name)) {
            files.push(...(await this.collectFiles(join(dir, entry.name))));
          }
        } else if (isSourceFile(entry.name)) {
          files.push(join(dir, entry.name));
        }
      }
    } catch {
      // Permission denied or missing dir — skip
    }

    return files;
  }

  /** Scan a project directory for rule violations with incremental caching. */
  async scanDirCached(projectDir: string): Promise<CodeScanResult> {
    const start = performance.now();
    const files = await this.collectFiles(projectDir);

    const cache = new ScanCache(projectDir);
    const cacheData = cache.load();
    const { stale, cachedFindings } = cache.getStaleFiles(files, cacheData);

    if (stale.length === 0) {
      // Everything cached — just merge
      const allFindings = cachedFindings;
      const suggestions = this._aggregate(allFindings);
      return {
        scannedFiles: files.length,
        totalLines: 0, // not tracked in cache; approximate
        findings: allFindings,
        suggestions,
        durationMs: Math.round(performance.now() - start),
      };
    }

    // Only scan stale files
    const freshFindings: ScanFinding[] = [];
    let totalLines = 0;

    for (const file of stale) {
      try {
        const content = readFileSync(file, "utf-8");
        totalLines += content.split("\n").length;
        const findings = this.scanContent(content, file);
        freshFindings.push(...findings);
      } catch {
        // Skip unreadable files
      }
    }

    // Update cache with fresh results
    cache.updateEntries(cacheData, stale, freshFindings);
    cache.save(cacheData);

    // Merge cached + fresh
    const allFindings = [...freshFindings, ...cachedFindings];
    const suggestions = this._aggregate(allFindings);

    return {
      scannedFiles: files.length,
      totalLines,
      findings: allFindings,
      suggestions,
      durationMs: Math.round(performance.now() - start),
    };
  }

  /** Scan a project directory for rule violations. */
  async scanDir(projectDir: string): Promise<CodeScanResult> {
    const start = performance.now();
    const files = await this.collectFiles(projectDir);

    const allFindings: ScanFinding[] = [];
    let totalLines = 0;

    for (const file of files) {
      try {
        const content = readFileSync(file, "utf-8");
        const lineCount = content.split("\n").length;
        totalLines += lineCount;

        const findings = this.scanContent(content, file);
        allFindings.push(...findings);
      } catch {
        // Skip unreadable files
      }
    }

    // Aggregate findings into suggestions
    const suggestions = this._aggregate(allFindings);

    const durationMs = Math.round(performance.now() - start);

    return {
      scannedFiles: files.length,
      totalLines,
      findings: allFindings,
      suggestions,
      durationMs,
    };
  }

  /** Scan a single file's content. */
  scanContent(content: string, filePath: string): ScanFinding[] {
    const findings: ScanFinding[] = [];

    // 1. console.log calls
    for (const m of findConsoleCalls(content)) {
      findings.push({
        ruleId: "no-console-log",
        file: filePath,
        line: m.line,
        snippet: m.snippet,
        confidence: 0.95,
      });
    }

    // 2. debugger statements
    for (const m of findDebuggerStatements(content)) {
      findings.push({
        ruleId: "no-debugger",
        file: filePath,
        line: m.line,
        snippet: m.snippet,
        confidence: 0.99,
      });
    }

    // 3. Direct fetch calls
    for (const m of findDirectFetch(content)) {
      findings.push({
        ruleId: "no-direct-fetch",
        file: filePath,
        line: m.line,
        snippet: m.snippet,
        confidence: 0.8,
      });
    }

    // 4. Magic numbers
    for (const m of findMagicNumbers(content)) {
      findings.push({
        ruleId: "no-magic-numbers",
        file: filePath,
        line: m.line,
        snippet: m.snippet,
        confidence: 0.6,
      });
    }

    // 5. Untyped `any`
    for (const m of findUntypedAny(content)) {
      findings.push({
        ruleId: "type-annotations",
        file: filePath,
        line: m.line,
        snippet: m.snippet,
        confidence: 0.85,
      });
    }

    // 6. Async without error handling
    for (const m of findAsyncWithoutTryCatch(content)) {
      findings.push({
        ruleId: "error-handling",
        file: filePath,
        line: m.line,
        snippet: m.snippet,
        confidence: 0.5,
      });
    }

    return findings;
  }

  /** Aggregate raw findings into actionable suggestions. */
  private _aggregate(findings: ScanFinding[]): ScanSuggestion[] {
    const grouped = new Map<string, ScanFinding[]>();

    for (const f of findings) {
      const existing = grouped.get(f.ruleId) || [];
      existing.push(f);
      grouped.set(f.ruleId, existing);
    }

    const suggestions: ScanSuggestion[] = [];

    for (const [ruleId, hits] of grouped) {
      const avgConf =
        hits.reduce((s, h) => s + h.confidence, 0) / hits.length;
      const severity: "low" | "medium" | "high" =
        hits.length > 20 ? "high" : hits.length > 5 ? "medium" : "low";
      suggestions.push({
        ruleId,
        description: `${ruleId} — found ${hits.length} occurrence(s)`,
        occurrences: hits.length,
        confidence: Math.round(avgConf * 100) / 100,
        severity,
      });
    }

    return suggestions;
  }
}
