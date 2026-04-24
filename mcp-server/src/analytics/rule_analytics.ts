import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { HarnessState, Medium, RuleDecision } from "../types.js";

// ============================================================
// Types
// ============================================================

export interface RuleStats {
  ruleId: string;
  ruleName: string;
  medium: Medium;
  confidence: number;
  cognitiveRequired: boolean;
  category?: string;
}

export interface AnalyticsData {
  projectDir: string;
  collectedAt: string;
  summary: {
    totalRules: number;
    byMedium: Record<string, number>;
    averageConfidence: number;
    cognitiveRequired: number;
    highConfidence: number;
  };
  rules: RuleStats[];
  history: Array<{
    timestamp: string;
    totalRules: number;
    byMedium: Record<string, number>;
  }>;
}

export interface RuleUsageRecord {
  ruleId: string;
  triggeredCount: number;
  fixedCount: number;
  bypassedCount: number;
  lastTriggered: string | null;
}

const ANALYTICS_FILE = ".harness/analytics.json";
const MAX_HISTORY = 20;

// ============================================================
// Rule Analytics
// ============================================================

export class RuleAnalytics {
  private projectDir: string;

  constructor(projectDir: string) {
    this.projectDir = projectDir;
  }

  /**
   * Collect analytics from the current state.
   */
  collect(state: HarnessState): AnalyticsData {
    const rules: RuleStats[] = (state.engineOutput?.decisions ?? []).map((d: RuleDecision) => ({
      ruleId: d.ruleId,
      ruleName: d.ruleName,
      medium: d.recommendedMedium,
      confidence: d.confidence,
      cognitiveRequired: d.cognitiveLayerRequired,
      category: this._inferCategory(d.ruleId),
    }));

    const byMedium: Record<string, number> = {};
    let totalConfidence = 0;
    let cognitiveRequired = 0;
    let highConfidence = 0;

    for (const r of rules) {
      byMedium[r.medium] = (byMedium[r.medium] || 0) + 1;
      totalConfidence += r.confidence;
      if (r.cognitiveRequired) cognitiveRequired++;
      if (r.confidence >= 0.7) highConfidence++;
    }

    // Load and append to history
    const history = this._loadHistory();
    history.push({
      timestamp: new Date().toISOString(),
      totalRules: rules.length,
      byMedium: { ...byMedium },
    });

    // Trim history
    while (history.length > MAX_HISTORY) {
      history.shift();
    }

    const data: AnalyticsData = {
      projectDir: this.projectDir,
      collectedAt: new Date().toISOString(),
      summary: {
        totalRules: rules.length,
        byMedium,
        averageConfidence: rules.length > 0
          ? Math.round((totalConfidence / rules.length) * 100) / 100
          : 0,
        cognitiveRequired,
        highConfidence,
      },
      rules,
      history,
    };

    this._persist(data, history);

    return data;
  }

  /**
   * Get current analytics data (without re-collecting).
   */
  getCurrent(): AnalyticsData | null {
    const path = join(this.projectDir, ANALYTICS_FILE);
    try {
      if (!existsSync(path)) return null;
      return JSON.parse(readFileSync(path, "utf-8")) as AnalyticsData;
    } catch {
      return null;
    }
  }

  /**
   * Record rule usage events.
   */
  recordUsage(events: Array<{ ruleId: string; event: "trigger" | "fix" | "bypass" }>): void {
    const records = this._loadUsageRecords();
    const now = new Date().toISOString();

    for (const ev of events) {
      let record = records.find((r) => r.ruleId === ev.ruleId);
      if (!record) {
        record = { ruleId: ev.ruleId, triggeredCount: 0, fixedCount: 0, bypassedCount: 0, lastTriggered: null };
        records.push(record);
      }

      switch (ev.event) {
        case "trigger":
          record.triggeredCount++;
          record.lastTriggered = now;
          break;
        case "fix":
          record.fixedCount++;
          break;
        case "bypass":
          record.bypassedCount++;
          break;
      }
    }

    this._persistUsageRecords(records);
  }

  /**
   * Get rule usage records.
   */
  getUsageRecords(): RuleUsageRecord[] {
    return this._loadUsageRecords();
  }

  // ---- Private ----

  private _inferCategory(ruleId: string): string {
    const categoryMap: Record<string, string> = {
      "no-console-log": "code-quality",
      "no-debugger": "code-quality",
      "no-direct-fetch": "architecture",
      "no-magic-numbers": "code-quality",
      "consistent-naming": "code-style",
      "type-annotations": "code-style",
      "error-handling": "code-quality",
      "no-large-files": "architecture",
      "secure-env-vars": "security",
      "no-duplicate-code": "code-quality",
      "prefer-early-return": "code-quality",
      "code-review-required": "process",
      "commit-message-convention": "process",
      "lint-before-commit": "process",
      "test-before-merge": "process",
      "dependency-lock": "process",
    };
    return categoryMap[ruleId] ?? "unknown";
  }

  private _loadHistory(): AnalyticsData["history"] {
    const current = this.getCurrent();
    if (current?.history) return current.history;

    // Try to reconstruct from state backups
    const backupDir = join(this.projectDir, ".harness", "backups");
    if (!existsSync(backupDir)) return [];

    try {
      const backups = readdirSync(backupDir).sort();
      const history: AnalyticsData["history"] = [];
      for (const backup of backups.slice(-MAX_HISTORY)) {
        const statePath = join(backupDir, backup, ".harness", "state.json");
        if (existsSync(statePath)) {
          try {
            const state = JSON.parse(readFileSync(statePath, "utf-8")) as HarnessState;
            if (state.engineOutput?.decisions) {
              const byMedium: Record<string, number> = {};
              for (const d of state.engineOutput.decisions) {
                byMedium[d.recommendedMedium] = (byMedium[d.recommendedMedium] || 0) + 1;
              }
              history.push({
                timestamp: state.updatedAt ?? backup,
                totalRules: state.engineOutput.decisions.length,
                byMedium,
              });
            }
          } catch {
            // skip corrupt backups
          }
        }
      }
      return history;
    } catch {
      return [];
    }
  }

  private _persist(data: AnalyticsData, history: AnalyticsData["history"]): void {
    const dir = join(this.projectDir, ".harness");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    writeFileSync(
      join(this.projectDir, ANALYTICS_FILE),
      JSON.stringify({ ...data, history }, null, 2),
      "utf-8",
    );
  }

  private _loadUsageRecords(): RuleUsageRecord[] {
    const path = join(this.projectDir, ".harness", "usage.json");
    try {
      if (!existsSync(path)) return [];
      return JSON.parse(readFileSync(path, "utf-8")) as RuleUsageRecord[];
    } catch {
      return [];
    }
  }

  private _persistUsageRecords(records: RuleUsageRecord[]): void {
    writeFileSync(
      join(this.projectDir, ".harness", "usage.json"),
      JSON.stringify(records, null, 2),
      "utf-8",
    );
  }
}
