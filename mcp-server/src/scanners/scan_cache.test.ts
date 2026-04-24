import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ScanCache } from "./scan_cache.js";
import type { CodeScanResult } from "./code_scanner.js";

describe("ScanCache", () => {
  let tmpDir: string;
  let cache: ScanCache;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `harness-cache-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    cache = new ScanCache(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSourceFile(name: string, content: string): string {
    const filePath = join(tmpDir, "src", name);
    writeFileSync(filePath, content, "utf-8");
    return filePath;
  }

  describe("load / empty", () => {
    it("returns empty cache when no cache file exists", () => {
      const data = cache.load();
      expect(data.version).toBe("1.0");
      expect(data.entries).toEqual({});
      expect(data.projectDir).toBe(tmpDir);
    });

    it("returns empty cache for corrupted file", () => {
      const dir = join(tmpDir, ".harness");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(tmpDir, ".harness", "scan-cache.json"), "invalid json", "utf-8");

      const data = cache.load();
      expect(data.entries).toEqual({});
    });
  });

  describe("save", () => {
    it("persists cache data to .harness/scan-cache.json", () => {
      const data = cache.load();
      data.entries["test.ts"] = {
        mtimeMs: 1000,
        size: 100,
        findings: [],
      };
      cache.save(data);

      const reloaded = cache.load();
      expect(reloaded.entries["test.ts"]).toBeDefined();
      expect(reloaded.entries["test.ts"].mtimeMs).toBe(1000);
    });
  });

  describe("getStaleFiles", () => {
    it("returns all files as stale when cache is empty", () => {
      const files = ["/tmp/a.ts", "/tmp/b.ts"];
      const cacheData = cache.load();
      const { stale, cachedFindings } = cache.getStaleFiles(files, cacheData);

      expect(stale).toEqual(files);
      expect(cachedFindings).toEqual([]);
    });

    it("identifies unchanged files from cache", () => {
      const filePath = writeSourceFile("test.ts", "const x = 1;\n");
      const stat = statSync(filePath);

      const cacheData = cache.load();
      cacheData.entries[filePath] = {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        findings: [{ ruleId: "test", file: filePath, line: 1, snippet: "const x = 1;", confidence: 0.5 }],
      };

      const { stale, cachedFindings } = cache.getStaleFiles([filePath], cacheData);
      expect(stale).toEqual([]);
      expect(cachedFindings.length).toBe(1);
    });

    it("detects modified files by changed mtime", async () => {
      const filePath = writeSourceFile("test.ts", "const x = 1;\n");
      const stat = statSync(filePath);

      const cacheData = cache.load();
      cacheData.entries[filePath] = {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        findings: [],
      };

      // Write different content to change mtime
      await new Promise((r) => setTimeout(r, 100)); // ensure mtime changes
      writeFileSync(filePath, "const y = 2;\n", "utf-8");

      const { stale } = cache.getStaleFiles([filePath], cacheData);
      expect(stale).toContain(filePath);
    });

    it("removes cache entries for deleted files", () => {
      const filePath = writeSourceFile("temp.ts", "delete me");
      const stat = statSync(filePath);

      const cacheData = cache.load();
      cacheData.entries[filePath] = {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        findings: [],
      };

      rmSync(filePath);

      // Deleted file shouldn't be in the existing files list; cache entry should be cleaned up
      const { stale } = cache.getStaleFiles([], cacheData);
      expect(stale).toEqual([]);
      expect(cacheData.entries[filePath]).toBeUndefined();
    });
  });

  describe("updateEntries", () => {
    it("updates cache entries with new findings", () => {
      const filePath = writeSourceFile("test.ts", 'console.log("hello");\n');
      const cacheData = cache.load();

      cache.updateEntries(cacheData, [filePath], [
        { ruleId: "no-console-log", file: filePath, line: 1, snippet: 'console.log("hello");', confidence: 0.95 },
      ]);

      const entry = cacheData.entries[filePath];
      expect(entry).toBeDefined();
      expect(entry.findings.length).toBe(1);
      expect(cacheData.lastScanned).toBeTruthy();
    });

    it("handles empty scanned files list", () => {
      const cacheData = cache.load();
      cache.updateEntries(cacheData, [], []);
      expect(cacheData.lastScanned).toBeTruthy();
    });
  });

  describe("mergeResults", () => {
    it("combines fresh and cached findings", () => {
      const freshResult: CodeScanResult = {
        scannedFiles: 1,
        totalLines: 10,
        findings: [{ ruleId: "R001", file: "a.ts", line: 1, snippet: "x", confidence: 0.9 }],
        suggestions: [],
        durationMs: 5,
      };

      const cachedFindings = [
        { ruleId: "R002", file: "b.ts", line: 2, snippet: "y", confidence: 0.8 },
      ];

      const merged = cache.mergeResults(freshResult, cachedFindings);
      expect(merged.findings.length).toBe(2);
    });

    it("aggregates suggestions from merged findings", () => {
      const freshResult: CodeScanResult = {
        scannedFiles: 1,
        totalLines: 5,
        findings: [
          { ruleId: "R001", file: "a.ts", line: 1, snippet: "x", confidence: 1.0 },
          { ruleId: "R001", file: "b.ts", line: 3, snippet: "y", confidence: 0.8 },
        ],
        suggestions: [],
        durationMs: 5,
      };

      const cachedFindings = [
        { ruleId: "R001", file: "c.ts", line: 5, snippet: "z", confidence: 0.9 },
      ];

      const merged = cache.mergeResults(freshResult, cachedFindings);
      expect(merged.findings.length).toBe(3);
      expect(merged.suggestions.length).toBe(1);
      expect(merged.suggestions[0].occurrences).toBe(3);
    });

    it("preserves durationMs from fresh result", () => {
      const freshResult: CodeScanResult = {
        scannedFiles: 0,
        totalLines: 0,
        findings: [],
        suggestions: [],
        durationMs: 42,
      };

      const merged = cache.mergeResults(freshResult, []);
      expect(merged.durationMs).toBe(42);
    });
  });
});
