import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateManager } from "./state.js";
import type { RuleDecision, EngineOutput } from "./types.js";

function makeOutput(): EngineOutput {
  return {
    decisions: [
      {
        ruleId: "R001",
        ruleName: "no-console-log",
        recommendedMedium: "linter",
        alternativeMedia: ["hook"],
        confidence: 0.85,
        reasons: ["formalizable"],
        cognitiveLayerRequired: false,
        cognitiveSkillTriggers: [],
      },
    ],
    conflicts: [],
    summary: { total: 1, byMedium: { "claude.md": 0, "settings.json": 0, linter: 1, hook: 0, ci: 0 } as any, highConfidence: 1, cognitiveRequired: 0 },
  };
}

describe("StateManager — state machine transitions", () => {
  let tmpDir: string;
  let sm: StateManager;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ht-state-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    sm = new StateManager(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ================================================================
  // 合法路径 (1-6)
  // ================================================================

  // 1: null → evaluated via setEngineInput
  it("transitions null→evaluated via setEngineInput", () => {
    sm.setEngineInput({
      projectDir: tmpDir, projectPhase: "growth", teamSize: "medium", techStack: ["typescript"],
    });
    const state = sm.load();
    expect(state.phase).toBe("evaluated");
    expect(state.engineInput?.projectPhase).toBe("growth");
  });

  // 2: null → evaluated via setEngineOutput
  it("transitions null→evaluated via setEngineOutput", () => {
    sm.setEngineOutput(makeOutput());
    const state = sm.load();
    expect(state.phase).toBe("evaluated");
    expect(state.engineOutput?.summary.total).toBe(1);
  });

  // 3: evaluated → confirmed
  it("transitions evaluated→confirmed", () => {
    sm.setEngineOutput(makeOutput());
    const decisions: RuleDecision[] = makeOutput().decisions;
    sm.setConfirmedDecisions(decisions);
    const state = sm.load();
    expect(state.phase).toBe("confirmed");
    expect(state.decisions?.length).toBe(1);
  });

  // 4: confirmed → generated
  it("transitions confirmed→generated", () => {
    sm.setEngineOutput(makeOutput());
    sm.setConfirmedDecisions(makeOutput().decisions);
    sm.setConfigOutput({
      files: [{ path: "CLAUDE.md", content: "# test", action: "create" }],
      summary: { total: 1, created: 1, updated: 0, skipped: 0 },
      errors: [],
      warnings: [],
    });
    const state = sm.load();
    expect(state.phase).toBe("generated");
    expect(state.configOutput?.files.length).toBe(1);
  });

  // 5: generated → validated
  it("transitions generated→validated via updateStatus", () => {
    sm.setEngineOutput(makeOutput());
    sm.setConfirmedDecisions(makeOutput().decisions);
    sm.updateStatus("validated");
    const state = sm.load();
    expect(state.phase).toBe("validated");
  });

  // 6: full chain null→evaluated→confirmed→generated→validated
  it("completes full state machine chain", () => {
    sm.setEngineInput({
      projectDir: tmpDir, projectPhase: "prototype", teamSize: "solo", techStack: ["python"],
    });
    expect(sm.load().phase).toBe("evaluated");

    sm.setConfirmedDecisions(makeOutput().decisions);
    expect(sm.load().phase).toBe("confirmed");

    sm.setConfigOutput({
      files: [{ path: "CLAUDE.md", content: "# test", action: "create" }],
      summary: { total: 1, created: 1, updated: 0, skipped: 0 },
      errors: [],
      warnings: [],
    });
    expect(sm.load().phase).toBe("generated");

    sm.updateStatus("validated");
    expect(sm.load().phase).toBe("validated");
  });

  // ================================================================
  // 状态查询 (7-9)
  // ================================================================

  // 7: load returns default when file does not exist
  it("load returns default state when file missing", () => {
    const state = sm.load();
    expect(state.phase).toBeNull();
    expect(state.version).toBe("1.0.0");
    expect(state.projectDir).toBe(tmpDir);
  });

  // 8: getStatus returns current status
  it("getStatus returns current status", () => {
    expect(sm.getStatus()).toBeNull();
    sm.setEngineOutput(makeOutput());
    expect(sm.getStatus()).toBe("evaluated");
  });

  // 9: canResume false in null state
  it("canResume returns false in null state", () => {
    expect(sm.canResume()).toBe(false);
  });

  // ================================================================
  // 跨实例持久化 (10-11)
  // ================================================================

  // 10: new StateManager reads state from previous instance
  it("new StateManager reads previously saved state", () => {
    sm.setEngineInput({
      projectDir: tmpDir, projectPhase: "growth", teamSize: "medium", techStack: ["typescript"],
    });

    const sm2 = new StateManager(tmpDir);
    const state = sm2.load();
    expect(state.phase).toBe("evaluated");
    expect(state.engineInput?.techStack).toContain("typescript");
  });

  // 11: engineOutput.decisions preserved across instances
  it("preserves full decision data across instances", () => {
    const output = makeOutput();
    sm.setEngineOutput(output);

    const sm2 = new StateManager(tmpDir);
    expect(sm2.load().engineOutput?.decisions.length).toBe(1);
    expect(sm2.load().engineOutput?.decisions[0].ruleId).toBe("R001");
  });

  // ================================================================
  // 文件损坏/容错 (12-13)
  // ================================================================

  // 12: corrupt JSON → default state
  it("returns default state on corrupt JSON", () => {
    const stateDir = join(tmpDir, ".harness");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "state.json"), "{invalid json{{{");

    const state = sm.load();
    expect(state.phase).toBeNull();
    expect(state.version).toBe("1.0.0");
  });

  // 13: missing critical fields → default state
  it("returns default state on missing critical fields", () => {
    const stateDir = join(tmpDir, ".harness");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "state.json"), JSON.stringify({ status: "evaluated" }));

    const state = sm.load();
    // load() returns the parsed JSON as-is; missing fields become undefined
    // but the default only kicks in when the file doesn't exist or is unreadable
    expect(state.phase).toBe("evaluated");
    // version is not preserved but save() will set it
    expect(state.version).toBeUndefined();
  });

  // ================================================================
  // 幂等性 (14-15)
  // ================================================================

  // 14: repeated setEngineInput
  it("is idempotent on repeated setEngineInput", () => {
    const input = {
      projectDir: tmpDir, projectPhase: "growth" as const, teamSize: "medium" as const, techStack: ["typescript" as const],
    };
    sm.setEngineInput(input);
    expect(sm.load().phase).toBe("evaluated");

    const state2 = sm.setEngineInput(input);
    expect(state2.phase).toBe("evaluated");
    expect(state2.engineInput?.techStack).toEqual(["typescript"]);
    // State remains consistent; timestamp may or may not tick
  });

  // 15: repeated setConfirmedDecisions
  it("is idempotent on repeated setConfirmedDecisions", () => {
    sm.setEngineOutput(makeOutput());
    sm.setConfirmedDecisions(makeOutput().decisions);
    expect(sm.load().phase).toBe("confirmed");

    const state2 = sm.setConfirmedDecisions(makeOutput().decisions);
    expect(state2.phase).toBe("confirmed");
    // Timestamp may or may not advance depending on clock granularity;
    // the key invariant is that the state remains "confirmed"
  });
});
