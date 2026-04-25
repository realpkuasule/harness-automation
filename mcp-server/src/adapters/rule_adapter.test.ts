import { describe, it, expect, beforeEach } from "vitest";
import { RuleAdapter } from "./rule_adapter.js";
import type { AnalyticsData, RuleUsageRecord } from "../analytics/rule_analytics.js";

function makeAnalytics(overrides?: Partial<AnalyticsData>): AnalyticsData {
  return {
    projectDir: "/tmp/test",
    collectedAt: "2026-01-01T00:00:00.000Z",
    summary: {
      totalRules: 2,
      byMedium: { linter_warn: 1, claude_md: 1 },
      averageConfidence: 0.78,
      cognitiveRequired: 1,
      highConfidence: 1,
    },
    rules: [
      {
        ruleId: "R001",
        ruleName: "no-console-log",
        medium: "linter_warn",
        confidence: 0.85,
        cognitiveRequired: false,
        category: "code-quality",
      },
      {
        ruleId: "R003",
        ruleName: "prefer-early-return",
        medium: "claude_md",
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
            medium: "linter_warn",
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
      expect(downgrades[0].suggestedMedium).toBe("settings");
    });

    it("recommends upgrade for high confidence in soft medium", () => {
      const analytics = makeAnalytics({
        rules: [
          {
            ruleId: "R013",
            ruleName: "code-review-required",
            medium: "claude_md",
            confidence: 0.85,
            cognitiveRequired: false,
            category: "process",
          },
        ],
      });
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
      expect(upgrades[0].suggestedMedium).toBe("linter_warn");
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
            medium: "linter_warn",
            confidence: 0.85,
            cognitiveRequired: false,
            category: "code-quality",
          },
        ],
      });
      const usage: RuleUsageRecord[] = [
        { ruleId: "R001", triggeredCount: 0, fixedCount: 0, bypassedCount: 0, lastTriggered: null },
      ];

      const result = adapter.analyze(analytics, usage);
      expect(result.summary.total).toBe(0);
    });
  });

  describe("bypass downgrade threshold boundaries", () => {
    it("keeps when bypass rate is just below threshold (0.29)", () => {
      const analytics = makeAnalytics({
        rules: [{ ruleId: "R001", ruleName: "no-console-log", medium: "linter_warn", confidence: 0.85, cognitiveRequired: false, category: "code-quality" }],
      });
      const usage: RuleUsageRecord[] = [
        { ruleId: "R001", triggeredCount: 100, fixedCount: 71, bypassedCount: 29, lastTriggered: "2026-01-01T00:00:00.000Z" },
      ];
      const result = adapter.analyze(analytics, usage);
      expect(result.recommendations.filter((r) => r.action === "downgrade").length).toBe(0);
    });

    it("keeps when bypass at claude_md (already at softest medium)", () => {
      const analytics = makeAnalytics({
        rules: [{ ruleId: "R003", ruleName: "prefer-early-return", medium: "claude_md", confidence: 0.7, cognitiveRequired: true, category: "code-style" }],
      });
      const usage: RuleUsageRecord[] = [
        { ruleId: "R003", triggeredCount: 10, fixedCount: 2, bypassedCount: 8, lastTriggered: "2026-01-01T00:00:00.000Z" },
      ];
      const result = adapter.analyze(analytics, usage);
      const downgrades = result.recommendations.filter((r) => r.action === "downgrade");
      expect(downgrades.length).toBe(0);
    });
  });

  describe("low confidence downgrade across media", () => {
    it("downgrades hook to linter_error when confidence is low", () => {
      const analytics = makeAnalytics({
        rules: [{ ruleId: "R004", ruleName: "commit-message-convention", medium: "hook", confidence: 0.3, cognitiveRequired: false, category: "process" }],
      });
      const usage: RuleUsageRecord[] = [
        { ruleId: "R004", triggeredCount: 5, fixedCount: 3, bypassedCount: 2, lastTriggered: "2026-01-01T00:00:00.000Z" },
      ];
      const result = adapter.analyze(analytics, usage);
      const downgrades = result.recommendations.filter((r) => r.action === "downgrade");
      expect(downgrades.length).toBe(1);
      expect(downgrades[0].suggestedMedium).toBe("linter_error");
    });

    it("keeps when low confidence at claude_md (cannot downgrade further)", () => {
      const analytics = makeAnalytics({
        rules: [{ ruleId: "R003", ruleName: "prefer-early-return", medium: "claude_md", confidence: 0.2, cognitiveRequired: true, category: "code-style" }],
      });
      const usage: RuleUsageRecord[] = [
        { ruleId: "R003", triggeredCount: 5, fixedCount: 3, bypassedCount: 2, lastTriggered: "2026-01-01T00:00:00.000Z" },
      ];
      const result = adapter.analyze(analytics, usage);
      expect(result.recommendations.filter((r) => r.action === "downgrade").length).toBe(0);
    });
  });

  describe("fix rate upgrade boundaries", () => {
    it("keeps when fix rate is below threshold", () => {
      const analytics = makeAnalytics({
        rules: [{ ruleId: "R003", ruleName: "prefer-early-return", medium: "claude_md", confidence: 0.7, cognitiveRequired: true, category: "code-style" }],
      });
      const usage: RuleUsageRecord[] = [
        { ruleId: "R003", triggeredCount: 10, fixedCount: 5, bypassedCount: 5, lastTriggered: "2026-01-01T00:00:00.000Z" },
      ];
      const result = adapter.analyze(analytics, usage);
      expect(result.recommendations.filter((r) => r.action === "upgrade").length).toBe(0);
    });

    it("upgrades from linter_warn to linter_error when fix rate is very high", () => {
      const analytics = makeAnalytics({
        rules: [{ ruleId: "R001", ruleName: "no-console-log", medium: "linter_warn", confidence: 0.85, cognitiveRequired: false, category: "code-quality" }],
      });
      const usage: RuleUsageRecord[] = [
        { ruleId: "R001", triggeredCount: 10, fixedCount: 9, bypassedCount: 1, lastTriggered: "2026-01-01T00:00:00.000Z" },
      ];
      const result = adapter.analyze(analytics, usage);
      const upgrades = result.recommendations.filter((r) => r.action === "upgrade");
      expect(upgrades.length).toBeGreaterThan(0);
      expect(upgrades[0].suggestedMedium).toBe("linter_error");
    });
  });

  describe("high confidence in non-linter soft media", () => {
    it("upgrades from settings to linter_warn with high confidence", () => {
      const analytics = makeAnalytics({
        rules: [{ ruleId: "R009", ruleName: "no-duplicate-code", medium: "settings", confidence: 0.9, cognitiveRequired: false, category: "code-quality" }],
      });
      const usage: RuleUsageRecord[] = [
        { ruleId: "R009", triggeredCount: 5, fixedCount: 3, bypassedCount: 0, lastTriggered: "2026-01-01T00:00:00.000Z" },
      ];
      const result = adapter.analyze(analytics, usage);
      const upgrades = result.recommendations.filter((r) => r.action === "upgrade");
      expect(upgrades.length).toBe(1);
      expect(upgrades[0].suggestedMedium).toBe("linter_warn");
    });
  });

  describe("none strictest medium", () => {
    it("cannot upgrade none (already strictest)", () => {
      const analytics = makeAnalytics({
        rules: [{ ruleId: "R007", ruleName: "test-before-merge", medium: "none", confidence: 0.9, cognitiveRequired: false, category: "process" }],
      });
      const usage: RuleUsageRecord[] = [
        { ruleId: "R007", triggeredCount: 10, fixedCount: 9, bypassedCount: 1, lastTriggered: "2026-01-01T00:00:00.000Z" },
      ];
      const result = adapter.analyze(analytics, usage);
      expect(result.recommendations.filter((r) => r.action === "upgrade").length).toBe(0);
    });
  });

  describe("mixed multi-rule scenarios", () => {
    it("produces correct summary with multiple rules of different outcomes", () => {
      const analytics = makeAnalytics({
        rules: [
          { ruleId: "R001", ruleName: "no-console-log", medium: "linter_warn", confidence: 0.85, cognitiveRequired: false, category: "code-quality" },
          { ruleId: "R003", ruleName: "prefer-early-return", medium: "claude_md", confidence: 0.7, cognitiveRequired: true, category: "code-style" },
          { ruleId: "R016", ruleName: "no-debugger", medium: "hook", confidence: 0.85, cognitiveRequired: false, category: "code-quality" },
        ],
      });
      const usage: RuleUsageRecord[] = [
        { ruleId: "R001", triggeredCount: 10, fixedCount: 2, bypassedCount: 8, lastTriggered: "2026-01-01T00:00:00.000Z" },
        { ruleId: "R003", triggeredCount: 0, fixedCount: 0, bypassedCount: 0, lastTriggered: null },
        { ruleId: "R016", triggeredCount: 10, fixedCount: 9, bypassedCount: 1, lastTriggered: "2026-01-01T00:00:00.000Z" },
      ];
      const result = adapter.analyze(analytics, usage);
      expect(result.recommendations.length).toBeGreaterThan(0);
      expect(result.summary.total).toBe(result.recommendations.length);
    });
  });
});
