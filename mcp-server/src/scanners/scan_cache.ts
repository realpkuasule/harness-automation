import { existsSync, readFileSync, writeFileSync, statSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ScanFinding, CodeScanResult } from "./code_scanner.js";

// ============================================================
// Types
// ============================================================

const CACHE_VERSION = "1.0";

export interface ScanCacheEntry {
  mtimeMs: number;
  size: number;
  findings: ScanFinding[];
}

export interface ScanCacheData {
  version: string;
  projectDir: string;
  lastScanned: string;
  entries: Record<string, ScanCacheEntry>;
}

// ============================================================
// Cache Manager
// ============================================================

const CACHE_FILE = ".harness/scan-cache.json";

export class ScanCache {
  private projectDir: string;

  constructor(projectDir: string) {
    this.projectDir = projectDir;
  }

  /**
   * Load existing cache.
   */
  load(): ScanCacheData {
    const path = join(this.projectDir, CACHE_FILE);
    try {
      if (!existsSync(path)) return this._empty();
      return JSON.parse(readFileSync(path, "utf-8")) as ScanCacheData;
    } catch {
      return this._empty();
    }
  }

  /**
   * Save cache.
   */
  save(data: ScanCacheData): void {
    const path = join(this.projectDir, CACHE_FILE);
    const dir = join(this.projectDir, ".harness");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
  }

  /**
   * Determine which files need scanning by comparing mtime/size against cache.
   * Returns files that are new or changed.
   */
  getStaleFiles(files: string[], cache: ScanCacheData): { stale: string[]; cachedFindings: ScanFinding[] } {
    const stale: string[] = [];
    const cachedFindings: ScanFinding[] = [];

    for (const file of files) {
      try {
        const stat = statSync(file);
        const cached = cache.entries[file];

        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
          // File unchanged — reuse cached findings
          cachedFindings.push(...cached.findings);
        } else {
          stale.push(file);
        }
      } catch {
        // File might have been deleted between listing and stat — treat as stale
        stale.push(file);
      }
    }

    // Remove entries for files that no longer exist
    const staleSet = new Set(stale);
    const existingFiles = new Set(files);
    for (const key of Object.keys(cache.entries)) {
      if (!existingFiles.has(key)) {
        delete cache.entries[key];
      }
    }

    return { stale, cachedFindings };
  }

  /**
   * Update cache entries for freshly scanned files.
   */
  updateEntries(
    cache: ScanCacheData,
    scannedFiles: string[],
    findings: ScanFinding[],
  ): void {
    // Group findings by file
    const findingsByFile = new Map<string, ScanFinding[]>();
    for (const f of findings) {
      const list = findingsByFile.get(f.file) || [];
      list.push(f);
      findingsByFile.set(f.file, list);
    }

    for (const file of scannedFiles) {
      try {
        const stat = statSync(file);
        cache.entries[file] = {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          findings: findingsByFile.get(file) || [],
        };
      } catch {
        // File removed during scan — skip
      }
    }

    cache.lastScanned = new Date().toISOString();
  }

  /**
   * Merge cached and fresh results into a single CodeScanResult.
   */
  mergeResults(
    freshResult: CodeScanResult,
    cachedFindings: ScanFinding[],
  ): CodeScanResult {
    const allFindings = [...freshResult.findings, ...cachedFindings];

    // Re-aggregate suggestions
    const grouped = new Map<string, ScanFinding[]>();
    for (const f of allFindings) {
      const list = grouped.get(f.ruleId) || [];
      list.push(f);
      grouped.set(f.ruleId, list);
    }

    const suggestions = Array.from(grouped.entries()).map(([ruleId, hits]) => {
      const avgConf = hits.reduce((s, h) => s + h.confidence, 0) / hits.length;
      const severity: "low" | "medium" | "high" =
        hits.length > 20 ? "high" : hits.length > 5 ? "medium" : "low";
      return {
        ruleId,
        description: `${ruleId} — found ${hits.length} occurrence(s)`,
        occurrences: hits.length,
        confidence: Math.round(avgConf * 100) / 100,
        severity,
      };
    });

    return {
      scannedFiles: freshResult.scannedFiles + cachedFindings.length, // approximate
      totalLines: freshResult.totalLines,  // cached lines not re-counted
      findings: allFindings,
      suggestions,
      durationMs: freshResult.durationMs,
    };
  }

  private _empty(): ScanCacheData {
    return {
      version: CACHE_VERSION,
      projectDir: this.projectDir,
      lastScanned: "",
      entries: {},
    };
  }
}
