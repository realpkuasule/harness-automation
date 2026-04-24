import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RuleAnalytics } from "./rule_analytics.js";
import type { HarnessState, RuleDecision } from "../types.js";

function makeState(overrides?: Partial<HarnessState>): HarnessState {
  return {
    status: "evaluated",
    projectDir: "/tmp/test",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: "1.0.0",
    engineInput: {
      projectDir: "/tmp/test",
      projectPhase: "growth",
      teamSize: "medium",
      techStack: ["typescript"],
    },
    engineOutput: {
      decisions: [
        {
          ruleId: "R001",
          ruleName: "no-console-log",
          recommendedMedium: "linter",
          alternativeMedia: ["hook", "claude.md"],
          confidence: 0.85,
          reasons: ["test"],
          cognitiveLayerRequired: false,
          cognitiveSkillTriggers: [],
        },
        {
          ruleId: "R003",
          ruleName: "prefer-early-return",
          recommendedMedium: "claude.md",
          alternativeMedia: ["linter", "settings.json"],
          confidence: 0.7,
          reasons: ["test"],
          cognitiveLayerRequired: true,
          cognitiveSkillTriggers: ["diagnostic", "educational"],
        },
      ],
      summary: {
        total: 2,
        byMedium: { linter: 1, "claude.md": 1, "settings.json": 0, hook: 0, ci: 0 },
        highConfidence: 1,
        cognitiveRequired: 1,
      },
    },
    ...overrides,
  };
}

describe("RuleAnalytics", () => {
  let tmpDir: string;
  let analytics: RuleAnalytics;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `harness-analytics-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    mkdirSync(join(tmpDir, ".harness"), { recursive: true });
    analytics = new RuleAnalytics(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("collect", () => {
    it("collects analytics from state with decisions", () => {
      const state = makeState();
      const data = analytics.collect(state);

      expect(data.projectDir).toBe(tmpDir);
      expect(data.summary.totalRules).toBe(2);
      expect(data.summary.byMedium.linter).toBe(1);
      expect(data.summary.byMedium["claude.md"]).toBe(1);
      expect(data.summary.averageConfidence).toBeGreaterThan(0);
      expect(data.rules.length).toBe(2);
    });

    it("persists analytics to .harness/analytics.json", () => {
      const state = makeState();
      analytics.collect(state);

      const filePath = join(tmpDir, ".harness", "analytics.json");
      expect(existsSync(filePath)).toBe(true);

      const saved = JSON.parse(readFileSync(filePath, "utf-8"));
      expect(saved.summary.totalRules).toBe(2);
    });

    it("returns empty summary for state without decisions", () => {
      const state = makeState({ engineOutput: undefined });
      const data = analytics.collect(state);

      expect(data.summary.totalRules).toBe(0);
      expect(data.summary.averageConfidence).toBe(0);
      expect(data.rules.length).toBe(0);
    });

    it("appends to history on each collect call", () => {
      const state = makeState();
      analytics.collect(state);
      analytics.collect(state);

      const data = analytics.getCurrent();
      expect(data!.history.length).toBe(2);
    });

    it("limits history to MAX_HISTORY entries", () => {
      const state = makeState();
      for (let i = 0; i < 25; i++) {
        analytics.collect(state);
      }

      const data = analytics.getCurrent();
      expect(data!.history.length).toBeLessThanOrEqual(20);
    });
  });

  describe("getCurrent", () => {
    it("returns null when no analytics file exists", () => {
      expect(analytics.getCurrent()).toBeNull();
    });

    it("returns cached data without re-collecting", () => {
      const state = makeState();
      analytics.collect(state);

      const cached = analytics.getCurrent();
      expect(cached).not.toBeNull();
      expect(cached!.summary.totalRules).toBe(2);
    });
  });

  describe("recordUsage", () => {
    it("records trigger/fix/bypass events", () => {
      analytics.recordUsage([
        { ruleId: "R001", event: "trigger" },
        { ruleId: "R001", event: "fix" },
        { ruleId: "R002", event: "trigger" },
        { ruleId: "R002", event: "bypass" },
      ]);

      const records = analytics.getUsageRecords();
      expect(records.length).toBe(2);

      const r1 = records.find((r) => r.ruleId === "R001")!;
      expect(r1.triggeredCount).toBe(1);
      expect(r1.fixedCount).toBe(1);

      const r2 = records.find((r) => r.ruleId === "R002")!;
      expect(r2.triggeredCount).toBe(1);
      expect(r2.bypassedCount).toBe(1);
    });

    it("increments existing usage records", () => {
      analytics.recordUsage([{ ruleId: "R001", event: "trigger" }]);
      analytics.recordUsage([{ ruleId: "R001", event: "trigger" }]);
      analytics.recordUsage([{ ruleId: "R001", event: "fix" }]);

      const records = analytics.getUsageRecords();
      const r1 = records.find((r) => r.ruleId === "R001")!;
      expect(r1.triggeredCount).toBe(2);
      expect(r1.fixedCount).toBe(1);
    });

    it("persists usage records to .harness/usage.json", () => {
      analytics.recordUsage([{ ruleId: "R001", event: "trigger" }]);

      const usagePath = join(tmpDir, ".harness", "usage.json");
      expect(existsSync(usagePath)).toBe(true);
    });

    it("sets lastTriggered on trigger events", () => {
      analytics.recordUsage([{ ruleId: "R001", event: "trigger" }]);

      const records = analytics.getUsageRecords();
      expect(records[0].lastTriggered).not.toBeNull();
    });
  });

  describe("getUsageRecords", () => {
    it("returns empty array when no records exist", () => {
      expect(analytics.getUsageRecords()).toEqual([]);
    });

    it("returns persisted records", () => {
      analytics.recordUsage([{ ruleId: "R001", event: "trigger" }]);
      const records = analytics.getUsageRecords();
      expect(records.length).toBe(1);
    });
  });
});
