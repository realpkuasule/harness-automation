import type { AnalyticsData, RuleUsageRecord } from "../analytics/rule_analytics.js";
import type { RuleMedium } from "../types.js";

// ============================================================
// Types
// ============================================================

export type RecommendationAction = "upgrade" | "downgrade" | "keep";

export interface RuleRecommendation {
  ruleId: string;
  ruleName: string;
  currentMedium: RuleMedium;
  action: RecommendationAction;
  suggestedMedium?: RuleMedium;
  confidence: number;
  reasons: string[];
  expectedImpact?: string;
  fixRateChange?: number;
  bypassRateChange?: number;
  implementationCost?: number; // 1-5
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

const MEDIUM_STRICTNESS: RuleMedium[] = ["claude_md", "settings", "linter_warn", "linter_error", "hook", "linter+hook", "ci", "none"];

const MEDIUM_LABELS: Record<string, string> = {
  claude_md: "CLAUDE.md 认知引导",
  settings: "编辑器软提示",
  linter_warn: "ESLint 警告",
  linter_error: "ESLint 错误拦截",
  hook: "提交时自动检查",
  "linter+hook": "ESLint + Hook 双重检查",
  ci: "CI 流水线强制",
  none: "不约束",
};

const BYPASS_DOWNGRADE_THRESHOLD = 0.3;
const FIX_UPGRADE_THRESHOLD = 0.7;
const LOW_TRIGGER_KEEP_THRESHOLD = 3;

/** Estimate the impact of switching from one medium to another. */
function estimateImpact(
  current: RuleMedium,
  suggested: RuleMedium,
  stats: { fixRate: number; bypassRate: number },
): { expectedImpact: string; fixRateChange: number; bypassRateChange: number; implementationCost: number } {
  const currIdx = MEDIUM_STRICTNESS.indexOf(current);
  const suggIdx = MEDIUM_STRICTNESS.indexOf(suggested);

  if (suggIdx > currIdx) {
    // Upgrade: stricter enforcement
    const fixGain = Math.min(0.15, (1 - stats.fixRate) * 0.3);
    const bypassDrop = Math.min(0.2, stats.bypassRate * 0.5);
    const cost = Math.min(5, suggIdx - currIdx + 2);
    const impact = `从 ${MEDIUM_LABELS[current] ?? current} 升级到 ${MEDIUM_LABELS[suggested] ?? suggested}，预计修复率提升 ${(fixGain * 100).toFixed(0)}%，绕过率下降 ${(bypassDrop * 100).toFixed(0)}%`;
    return { expectedImpact: impact, fixRateChange: fixGain, bypassRateChange: -bypassDrop, implementationCost: cost };
  }

  // Downgrade: looser enforcement
  const fixDrop = Math.min(0.1, stats.fixRate * 0.2);
  const bypassRise = Math.min(0.15, (1 - stats.bypassRate) * 0.3);
  const cost = 1;
  const impact = `从 ${MEDIUM_LABELS[current] ?? current} 降级到 ${MEDIUM_LABELS[suggested] ?? suggested}，预计修复率下降 ${(fixDrop * 100).toFixed(0)}%，绕过率上升 ${(bypassRise * 100).toFixed(0)}%`;
  return { expectedImpact: impact, fixRateChange: -fixDrop, bypassRateChange: bypassRise, implementationCost: cost };
}

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
        continue;
      }

      const triggeredCount = usage.triggeredCount;
      const fixedCount = usage.fixedCount;
      const bypassedCount = usage.bypassedCount;
      const fixRate = triggeredCount > 0 ? fixedCount / triggeredCount : 0;
      const bypassRate = triggeredCount > 0 ? bypassedCount / triggeredCount : 0;

      const recommendation = this._evaluateRule(rule.medium as RuleMedium, rule.confidence, {
        triggeredCount,
        fixedCount,
        bypassedCount,
        fixRate,
        bypassRate,
      });

      if (recommendation.action !== "keep") {
        const impact = recommendation.suggestedMedium
          ? estimateImpact(rule.medium as RuleMedium, recommendation.suggestedMedium, { fixRate, bypassRate })
          : { expectedImpact: "", fixRateChange: 0, bypassRateChange: 0, implementationCost: 0 };

        recommendations.push({
          ruleId: rule.ruleId,
          ruleName: rule.ruleName,
          currentMedium: rule.medium as RuleMedium,
          action: recommendation.action,
          suggestedMedium: recommendation.suggestedMedium,
          confidence: recommendation.confidence,
          reasons: recommendation.reasons,
          expectedImpact: impact.expectedImpact,
          fixRateChange: impact.fixRateChange,
          bypassRateChange: impact.bypassRateChange,
          implementationCost: impact.implementationCost,
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
    currentMedium: RuleMedium,
    confidence: number,
    stats: { triggeredCount: number; fixedCount: number; bypassedCount: number; fixRate: number; bypassRate: number },
  ): { action: RecommendationAction; suggestedMedium?: RuleMedium; confidence: number; reasons: string[] } {
    const reasons: string[] = [];
    const currentIndex = MEDIUM_STRICTNESS.indexOf(currentMedium);

    if (currentIndex === -1) return { action: "keep", confidence: 0, reasons };

    // === Downgrade checks ===

    // High bypass rate → rule is too strict for the team
    if (stats.bypassRate >= BYPASS_DOWNGRADE_THRESHOLD && currentIndex > 0) {
      const target = MEDIUM_STRICTNESS[currentIndex - 1];
      reasons.push(`Bypass rate ${(stats.bypassRate * 100).toFixed(0)}% exceeds threshold ${BYPASS_DOWNGRADE_THRESHOLD * 100}%`);
      return {
        action: "downgrade",
        suggestedMedium: target,
        confidence: Math.min(0.9, stats.bypassRate),
        reasons,
      };
    }

    // Low confidence in a strict medium
    if (confidence < 0.5 && currentIndex >= MEDIUM_STRICTNESS.indexOf("linter_warn")) {
      const target = MEDIUM_STRICTNESS[currentIndex - 1];
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
      const target = MEDIUM_STRICTNESS[currentIndex + 1];
      reasons.push(`Fix rate ${(stats.fixRate * 100).toFixed(0)}% exceeds threshold ${FIX_UPGRADE_THRESHOLD * 100}% with ${stats.triggeredCount} triggers`);
      return {
        action: "upgrade",
        suggestedMedium: target,
        confidence: Math.min(0.85, stats.fixRate + 0.1),
        reasons,
      };
    }

    // High confidence in a soft medium with consistent triggering
    if (confidence >= 0.8 && currentIndex <= MEDIUM_STRICTNESS.indexOf("settings") && stats.triggeredCount >= LOW_TRIGGER_KEEP_THRESHOLD) {
      reasons.push(`High confidence (${confidence}) suitable for stricter medium`);
      return {
        action: "upgrade",
        suggestedMedium: "linter_warn",
        confidence: 0.7,
        reasons,
      };
    }

    return { action: "keep", confidence: 0, reasons };
  }
}
