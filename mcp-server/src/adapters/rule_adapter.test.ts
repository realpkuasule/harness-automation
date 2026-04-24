import { describe, it, expect, beforeEach } from "vitest";
import { RuleAdapter } from "./rule_adapter.js";
import type { AnalyticsData, RuleUsageRecord } from "../analytics/rule_analytics.js";

function makeAnalytics(overrides?: Partial<AnalyticsData>): AnalyticsData {
  return {
    projectDir: "/tmp/test",
    collectedAt: "2026-01-01T00:00:00.000Z",
    summary: {
      totalRules: 2,
      byMedium: { linter: 1, "claude.md": 1 },
      averageConfidence: 0.78,
      cognitiveRequired: 1,
      highConfidence: 1,
    },
    rules: [
      {
        ruleId: "R001",
        ruleName: "no-console-log",
        medium: "linter",
        confidence: 0.85,
        cognitiveRequired: false,
        category: "code-quality",
      },
      {
        ruleId: "R003",
        ruleName: "prefer-early-return",
        medium: "claude.md",
        confidence: 0.7,
        cognitiveRequired: true,
        category: "code-style",
      },
    ],
    history: [],
    ...overrides,
  };
}

describe("RuleAdapter", () => {
  let adapter: RuleAdapter;

  beforeEach(() => {
    adapter = new RuleAdapter("/tmp/test");
  });

  describe("analyze", () => {
    it("returns no recommendations when no usage data exists", () => {
      const analytics = makeAnalytics();
      const result = adapter.analyze(analytics, []);
      expect(result.summary.total).toBe(0);
      expect(result.recommendations.length).toBe(0);
    });

    it("recommends downgrade when bypass rate exceeds threshold", () => {
      const analytics = makeAnalytics();
      const usage: RuleUsageRecord[] = [
        {
          ruleId: "R001",
          triggeredCount: 10,
          fixedCount: 2,
          bypassedCount: 8,
          lastTriggered: "2026-01-01T00:00:00.000Z",
        },
      ];

      const result = adapter.analyze(analytics, usage);
      const downgrades = result.recommendations.filter((r) => r.action === "downgrade");
      expect(downgrades.length).toBeGreaterThan(0);
      expect(downgrades[0].dataSnapshot.bypassRate).toBeGreaterThanOrEqual(0.3);
    });

    it("recommends upgrade when fix rate exceeds threshold with enough triggers", () => {
      const analytics = makeAnalytics();
      const usage: RuleUsageRecord[] = [
        {
          ruleId: "R003",
          triggeredCount: 10,
          fixedCount: 9,
          bypassedCount: 1,
          lastTriggered: "2026-01-01T00:00:00.000Z",
        },
      ];

      const result = adapter.analyze(analytics, usage);
      const upgrades = result.recommendations.filter((r) => r.action === "upgrade");
      expect(upgrades.length).toBeGreaterThan(0);
      expect(upgrades[0].dataSnapshot.fixRate).toBeGreaterThanOrEqual(0.7);
    });

    it("does not upgrade when trigger count is below threshold", () => {
      const analytics = makeAnalytics();
      const usage: RuleUsageRecord[] = [
        {
          ruleId: "R003",
          triggeredCount: 2,
          fixedCount: 2,
          bypassedCount: 0,
          lastTriggered: "2026-01-01T00:00:00.000Z",
        },
      ];

      const result = adapter.analyze(analytics, usage);
      const upgrades = result.recommendations.filter((r) => r.action === "upgrade");
      expect(upgrades.length).toBe(0);
    });

    it("recommends downgrade for low confidence in strict medium", () => {
      const analytics = makeAnalytics({
        rules: [
          {
            ruleId: "R016",
            ruleName: "no-debugger",
            medium: "linter",
            confidence: 0.4,
            cognitiveRequired: false,
            category: "code-quality",
          },
        ],
      });
      const usage: RuleUsageRecord[] = [
        {
          ruleId: "R016",
          triggeredCount: 5,
          fixedCount: 3,
          bypassedCount: 2,
          lastTriggered: "2026-01-01T00:00:00.000Z",
        },
      ];

      const result = adapter.analyze(analytics, usage);
      const downgrades = result.recommendations.filter((r) => r.action === "downgrade");
      expect(downgrades.length).toBe(1);
      expect(downgrades[0].suggestedMedium).toBe("settings.json");
    });

    it("recommends upgrade for high confidence in soft medium", () => {
      const analytics = makeAnalytics({
        rules: [
          {
            ruleId: "R013",
            ruleName: "code-review-required",
            medium: "claude.md",
            confidence: 0.85,
            cognitiveRequired: false,
            category: "process",
          },
        ],
      });
      // fixRate (0.3) below FIX_UPGRADE_THRESHOLD, but confidence (0.85) >= 0.8
      const usage: RuleUsageRecord[] = [
        {
          ruleId: "R013",
          triggeredCount: 10,
          fixedCount: 3,
          bypassedCount: 2,
          lastTriggered: "2026-01-01T00:00:00.000Z",
        },
      ];

      const result = adapter.analyze(analytics, usage);
      const upgrades = result.recommendations.filter((r) => r.action === "upgrade");
      expect(upgrades.length).toBeGreaterThan(0);
      expect(upgrades[0].suggestedMedium).toBe("linter");
    });

    it("populates summary counts correctly", () => {
      const analytics = makeAnalytics();
      const usage: RuleUsageRecord[] = [
        { ruleId: "R001", triggeredCount: 10, fixedCount: 2, bypassedCount: 8, lastTriggered: "2026-01-01T00:00:00.000Z" },
        { ruleId: "R003", triggeredCount: 10, fixedCount: 9, bypassedCount: 1, lastTriggered: "2026-01-01T00:00:00.000Z" },
      ];

      const result = adapter.analyze(analytics, usage);
      expect(result.summary.total).toBeGreaterThan(0);
      expect(result.summary.downgrade + result.summary.upgrade + result.summary.keep).toBe(result.summary.total);
    });

    it("handles mixed usage data correctly", () => {
      const analytics = makeAnalytics({
        rules: [
          {
            ruleId: "R001",
            ruleName: "no-console-log",
            medium: "linter",
            confidence: 0.85,
            cognitiveRequired: false,
            category: "code-quality",
          },
        ],
      });
      // Usage with triggeredCount=0 should be skipped
      const usage: RuleUsageRecord[] = [
        { ruleId: "R001", triggeredCount: 0, fixedCount: 0, bypassedCount: 0, lastTriggered: null },
      ];

      const result = adapter.analyze(analytics, usage);
      expect(result.summary.total).toBe(0);
    });
  });
});
