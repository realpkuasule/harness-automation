import type { AnalyticsData, RuleUsageRecord } from "../analytics/rule_analytics.js";
import type { Medium } from "../types.js";

// ============================================================
// Types
// ============================================================

export type RecommendationAction = "upgrade" | "downgrade" | "keep";

export type UpgradeTarget = Extract<Medium, "linter" | "hook" | "ci">;
export type DowngradeTarget = Extract<Medium, "claude.md" | "settings.json" | "linter">;

export interface RuleRecommendation {
  ruleId: string;
  ruleName: string;
  currentMedium: Medium;
  action: RecommendationAction;
  suggestedMedium?: Medium;
  confidence: number;
  reasons: string[];
  dataSnapshot: {
    triggeredCount: number;
    fixedCount: number;
    bypassedCount: number;
    fixRate: number;
    bypassRate: number;
  };
}

export interface AdapterResult {
  projectDir: string;
  analyzedAt: string;
  summary: {
    total: number;
    upgrade: number;
    downgrade: number;
    keep: number;
  };
  recommendations: RuleRecommendation[];
}

// ============================================================
// Constants
// ============================================================

const MEDIUM_STRICTNESS: Medium[] = ["claude.md", "settings.json", "linter", "hook", "ci"];

const BYPASS_DOWNGRADE_THRESHOLD = 0.3;
const FIX_UPGRADE_THRESHOLD = 0.7;
const LOW_TRIGGER_KEEP_THRESHOLD = 3;

// ============================================================
// Adapter
// ============================================================

export class RuleAdapter {
  private projectDir: string;

  constructor(projectDir: string) {
    this.projectDir = projectDir;
  }

  analyze(analytics: AnalyticsData, usageRecords: RuleUsageRecord[]): AdapterResult {
    const recommendations: RuleRecommendation[] = [];

    for (const rule of analytics.rules) {
      const usage = usageRecords.find((u) => u.ruleId === rule.ruleId);
      if (!usage || usage.triggeredCount === 0) {
        // No usage data yet — cannot recommend changes
        continue;
      }

      const triggeredCount = usage.triggeredCount;
      const fixedCount = usage.fixedCount;
      const bypassedCount = usage.bypassedCount;
      const fixRate = triggeredCount > 0 ? fixedCount / triggeredCount : 0;
      const bypassRate = triggeredCount > 0 ? bypassedCount / triggeredCount : 0;

      const recommendation = this._evaluateRule(rule.medium, rule.confidence, {
        triggeredCount,
        fixedCount,
        bypassedCount,
        fixRate,
        bypassRate,
      });

      if (recommendation.action !== "keep") {
        recommendations.push({
          ruleId: rule.ruleId,
          ruleName: rule.ruleName,
          currentMedium: rule.medium,
          action: recommendation.action,
          suggestedMedium: recommendation.suggestedMedium,
          confidence: recommendation.confidence,
          reasons: recommendation.reasons,
          dataSnapshot: {
            triggeredCount,
            fixedCount,
            bypassedCount,
            fixRate,
            bypassRate,
          },
        });
      }
    }

    const upgrade = recommendations.filter((r) => r.action === "upgrade").length;
    const downgrade = recommendations.filter((r) => r.action === "downgrade").length;

    return {
      projectDir: this.projectDir,
      analyzedAt: new Date().toISOString(),
      summary: {
        total: recommendations.length,
        upgrade,
        downgrade,
        keep: recommendations.length - upgrade - downgrade,
      },
      recommendations,
    };
  }

  private _evaluateRule(
    currentMedium: Medium,
    confidence: number,
    stats: { triggeredCount: number; fixedCount: number; bypassedCount: number; fixRate: number; bypassRate: number },
  ): { action: RecommendationAction; suggestedMedium?: Medium; confidence: number; reasons: string[] } {
    const reasons: string[] = [];
    const currentIndex = MEDIUM_STRICTNESS.indexOf(currentMedium);

    // === Downgrade checks ===

    // High bypass rate → rule is too strict for the team
    if (stats.bypassRate >= BYPASS_DOWNGRADE_THRESHOLD && currentIndex > 0) {
      const target = MEDIUM_STRICTNESS[currentIndex - 1] as DowngradeTarget;
      reasons.push(`Bypass rate ${(stats.bypassRate * 100).toFixed(0)}% exceeds threshold ${BYPASS_DOWNGRADE_THRESHOLD * 100}%`);
      return {
        action: "downgrade",
        suggestedMedium: target,
        confidence: Math.min(0.9, stats.bypassRate),
        reasons,
      };
    }

    // Low confidence in a strict medium
    if (confidence < 0.5 && currentIndex >= MEDIUM_STRICTNESS.indexOf("linter")) {
      const target = MEDIUM_STRICTNESS[currentIndex - 1] as DowngradeTarget;
      reasons.push(`Low confidence (${confidence}) for strict medium "${currentMedium}"`);
      return {
        action: "downgrade",
        suggestedMedium: target,
        confidence: 0.6,
        reasons,
      };
    }

    // === Upgrade checks ===

    // High fix rate → team responds well, can be stricter
    if (stats.fixRate >= FIX_UPGRADE_THRESHOLD && currentIndex < MEDIUM_STRICTNESS.length - 1 && stats.triggeredCount >= LOW_TRIGGER_KEEP_THRESHOLD) {
      const target = MEDIUM_STRICTNESS[currentIndex + 1] as UpgradeTarget;
      reasons.push(`Fix rate ${(stats.fixRate * 100).toFixed(0)}% exceeds threshold ${FIX_UPGRADE_THRESHOLD * 100}% with ${stats.triggeredCount} triggers`);
      return {
        action: "upgrade",
        suggestedMedium: target,
        confidence: Math.min(0.85, stats.fixRate + 0.1),
        reasons,
      };
    }

    // High confidence in a soft medium with consistent triggering
    if (confidence >= 0.8 && currentIndex <= MEDIUM_STRICTNESS.indexOf("settings.json") && stats.triggeredCount >= LOW_TRIGGER_KEEP_THRESHOLD) {
      reasons.push(`High confidence (${confidence}) suitable for stricter medium`);
      return {
        action: "upgrade",
        suggestedMedium: "linter" as UpgradeTarget,
        confidence: 0.7,
        reasons,
      };
    }

    return { action: "keep", confidence: 0, reasons };
  }
}
