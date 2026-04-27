import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "./index.js";
import type { RuleDecision, Medium } from "./types.js";

// ============================================================
// Test Harness
// ============================================================

interface TestHarness {
  client: Client;
  tmpDir: string;
}

async function createTestHarness(): Promise<TestHarness> {
  const server = await createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities: {} },
  );
  // Server must connect before client (client sends initialize on connect)
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, tmpDir: mkdtempSync(join(tmpdir(), "ht-")) };
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "ht-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function parseResult(result: { content: Array<{ type: string; text: string }> }): unknown {
  return JSON.parse(result.content[0].text);
}

// Shortcut to call a tool and parse JSON response
async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  return await client.callTool({ name, arguments: args }) as any;
}

// ============================================================
// Test Suite
// ============================================================

describe("MCP Server — evaluate_rules", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestHarness();
  });

  afterEach(() => {
    rmSync(harness.tmpDir, { recursive: true, force: true });
  });

  // 1.1 基本正常调用 + TS
  it("returns decisions for TypeScript growth/medium project", async () => {
    const result = await callTool(harness.client, "evaluate_rules", {
      projectDir: harness.tmpDir,
      projectPhase: "growth",
      teamSize: "medium",
      techStack: ["typescript"],
    });
    const data = parseResult(result) as any;
    expect(data.decisions.length).toBeGreaterThan(0);
    expect(data.summary.total).toBe(data.decisions.length);
    expect(data.summary.byMedium).toBeDefined();
  });

  // 1.2 空 techStack
  it("handles empty tech stack gracefully", async () => {
    const result = await callTool(harness.client, "evaluate_rules", {
      projectDir: harness.tmpDir,
      projectPhase: "early",
      teamSize: "solo",
      techStack: [],
    });
    const data = parseResult(result) as any;
    expect(data.decisions).toEqual([]);
    expect(data.summary.total).toBe(0);
  });

  // 1.3 prototype 阶段
  it("adjusts confidence down for prototype phase", async () => {
    const [protoResult, growthResult] = await Promise.all([
      callTool(harness.client, "evaluate_rules", {
        projectDir: harness.tmpDir,
        projectPhase: "prototype",
        teamSize: "medium",
        techStack: ["typescript"],
      }),
      callTool(harness.client, "evaluate_rules", {
        projectDir: harness.tmpDir,
        projectPhase: "growth",
        teamSize: "medium",
        techStack: ["typescript"],
      }),
    ]);
    const proto = parseResult(protoResult) as any;
    const growth = parseResult(growthResult) as any;
    const protoAvg = proto.decisions.reduce((s: number, d: any) => s + d.confidence, 0) / proto.decisions.length;
    const growthAvg = growth.decisions.reduce((s: number, d: any) => s + d.confidence, 0) / growth.decisions.length;
    expect(protoAvg).toBeLessThan(growthAvg);
  });

  // 1.4 large team
  it("produces hook/ci decisions for large team", async () => {
    const result = await callTool(harness.client, "evaluate_rules", {
      projectDir: harness.tmpDir,
      projectPhase: "growth",
      teamSize: "large",
      techStack: ["typescript"],
    });
    const data = parseResult(result) as any;
    const strictMedia = ["hook", "ci"];
    const strictDecisions = data.decisions.filter((d: any) => strictMedia.includes(d.recommendedMedium));
    expect(strictDecisions.length).toBeGreaterThan(0);
  });

  // 1.5 dryRun
  it("does not persist state when dryRun is true", async () => {
    await callTool(harness.client, "evaluate_rules", {
      projectDir: harness.tmpDir,
      projectPhase: "growth",
      teamSize: "medium",
      techStack: ["typescript"],
      dryRun: true,
    });
    const stateResult = await callTool(harness.client, "query_state", {
      projectDir: harness.tmpDir,
    });
    const state = parseResult(stateResult) as any;
    expect(state.phase).toBeNull();
  });

  // 1.6 缺失必填参数
  it("throws on missing required parameters", async () => {
    await expect(
      callTool(harness.client, "evaluate_rules", {}),
    ).rejects.toThrow();
  });
});

describe("MCP Server — generate_config", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestHarness();
  });

  afterEach(() => {
    rmSync(harness.tmpDir, { recursive: true, force: true });
  });

  // 2.1 已 evaluate + confirmed 状态
  it("generates config after evaluate and confirm", async () => {
    // Evaluate
    const evalResult = await callTool(harness.client, "evaluate_rules", {
      projectDir: harness.tmpDir,
      projectPhase: "growth",
      teamSize: "medium",
      techStack: ["typescript"],
    });
    const evalData = parseResult(evalResult) as any;

    // Confirm
    await callTool(harness.client, "confirm_decisions", {
      projectDir: harness.tmpDir,
      decisions: evalData.decisions,
    });

    // Generate
    const genResult = await callTool(harness.client, "generate_config", {
      projectDir: harness.tmpDir,
      decisions: evalData.decisions.map((d: any) => ({
        ruleId: d.ruleId,
        recommendedMedium: d.recommendedMedium,
      })),
    });
    const genData = parseResult(genResult) as any;
    expect(genData.files.length).toBeGreaterThan(0);
    expect(genData.summary.total).toBeGreaterThan(0);
  });

  // 2.2 未 evaluate 直接 generate
  it("returns error when no decisions available", async () => {
    const genResult = await callTool(harness.client, "generate_config", {
      projectDir: harness.tmpDir,
      decisions: [],
    });
    expect(genResult.isError).toBe(true);
    const genData = parseResult(genResult) as any;
    expect(genData.message).toContain("No decisions available");
  });

  // 2.3 dryRun
  it("does not persist state on dryRun", async () => {
    const evalResult = await callTool(harness.client, "evaluate_rules", {
      projectDir: harness.tmpDir,
      projectPhase: "growth",
      teamSize: "medium",
      techStack: ["typescript"],
    });
    const evalData = parseResult(evalResult) as any;

    await callTool(harness.client, "generate_config", {
      projectDir: harness.tmpDir,
      decisions: evalData.decisions.map((d: any) => ({
        ruleId: d.ruleId,
        recommendedMedium: d.recommendedMedium,
      })),
      dryRun: true,
    });

    const stateResult = await callTool(harness.client, "query_state", {
      projectDir: harness.tmpDir,
    });
    const state = parseResult(stateResult) as any;
    // State should have been updated by evaluate but NOT by generate_config (dryRun)
    expect(state.phase).toBe("evaluated");
  });

  // 2.4 自定义 decisions
  it("uses provided decisions over state decisions", async () => {
    // First evaluate as TS
    await callTool(harness.client, "evaluate_rules", {
      projectDir: harness.tmpDir,
      projectPhase: "growth",
      teamSize: "medium",
      techStack: ["typescript"],
    });

    // Generate with custom decisions (all as claude.md)
    const genResult = await callTool(harness.client, "generate_config", {
      projectDir: harness.tmpDir,
      decisions: [{ ruleId: "R001", recommendedMedium: "claude.md" }],
    });
    const genData = parseResult(genResult) as any;
    expect(genData.files.length).toBeGreaterThan(0);
  });

  // 2.5 所有 5 种 medium（medium 分布触发不同的生成器）
  it("generates files for different medium types", async () => {
    // Use valid rule IDs that correspond to existing rules in rules.json
    const decisions = [
      { ruleId: "R003", recommendedMedium: "claude.md" as Medium },   // non-formalizable → claude.md
      { ruleId: "R011", recommendedMedium: "settings.json" as Medium }, // config
      { ruleId: "R001", recommendedMedium: "linter" as Medium },       // formalizable → linter
      { ruleId: "R004", recommendedMedium: "hook" as Medium },         // process → hook
      { ruleId: "R007", recommendedMedium: "ci" as Medium },           // process → ci
    ];

    const genResult = await callTool(harness.client, "generate_config", {
      projectDir: harness.tmpDir,
      decisions,
    });
    const genData = parseResult(genResult) as any;
    // generateProjectFiles produces up to 4 files:
    // CLAUDE.md (always) + settings.json (always) + .gitignore (always) + eslint.json (if linter exists)
    expect(genData.files.length).toBeGreaterThanOrEqual(3);
    const filePaths = genData.files.map((f: any) => f.path);
    expect(filePaths).toContain("CLAUDE.md");
    expect(filePaths).toContain(".claude/settings.json");
    expect(filePaths).toContain("eslint.config.js");
  });
});

describe("MCP Server — init_harness", () => {
  // 3.1 完整流程 TS（MCP Server 返回文件内容，不直接写入磁盘）
  it("generates all config for TypeScript project", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test" }));

      const harness = await createTestHarness();
      const result = await callTool(harness.client, "init_harness", {
        projectDir: dir,
        projectPhase: "growth",
        teamSize: "medium",
        techStack: ["typescript"],
      });
      const data = parseResult(result) as any;
      expect(data.files.length).toBeGreaterThan(0);
      expect(data.summary.files.total).toBeGreaterThan(0);

      const paths = data.files.map((f: any) => f.path);
      expect(paths).toContain("CLAUDE.md");
      expect(paths).toContain(".claude/settings.json");
    });
  });

  // 3.2 dryRun 返回预览但不写状态
  it("returns preview on dryRun", async () => {
    await withTempDir(async (dir) => {
      const harness = await createTestHarness();
      const result = await callTool(harness.client, "init_harness", {
        projectDir: dir,
        projectPhase: "growth",
        teamSize: "medium",
        techStack: ["typescript"],
        dryRun: true,
      });
      const data = parseResult(result) as any;
      // dryRun returns {files, summary, validation} with empty files array
      expect(Array.isArray(data.files)).toBe(true);
      expect(data.files.length).toBe(0);
      expect(data.summary.files.total).toBe(0);
      expect(data.summary.decisions).toBeGreaterThan(0);
      expect(data.validation).toBeUndefined();
    });
  });

  // 3.3 Python 项目
  it("generates config for Python project", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test" }));

      const harness = await createTestHarness();
      const result = await callTool(harness.client, "init_harness", {
        projectDir: dir,
        projectPhase: "growth",
        teamSize: "small",
        techStack: ["python"],
      });
      const data = parseResult(result) as any;
      expect(data.summary.files.total).toBeGreaterThan(0);
    });
  });

  // 3.4 prototype 轻量
  it("generates minimal config for prototype", async () => {
    await withTempDir(async (dir) => {
      const harness = await createTestHarness();
      const result = await callTool(harness.client, "init_harness", {
        projectDir: dir,
        projectPhase: "prototype",
        teamSize: "solo",
        techStack: ["typescript"],
      });
      const data = parseResult(result) as any;
      expect(data.summary.files.total).toBeGreaterThan(0);
    });
  });

  // 3.5 备份已存在文件
  it("creates backup when files already exist", async () => {
    await withTempDir(async (dir) => {
      mkdirSync(join(dir, ".claude"), { recursive: true });
      writeFileSync(join(dir, "CLAUDE.md"), "# Existing");
      writeFileSync(join(dir, ".claude", "settings.json"), "{}");

      const harness = await createTestHarness();
      const result = await callTool(harness.client, "init_harness", {
        projectDir: dir,
        projectPhase: "growth",
        teamSize: "medium",
        techStack: ["typescript"],
      });
      const data = parseResult(result) as any;
      expect(data.summary.backupDir).toBeDefined();
    });
  });
});

describe("MCP Server — query_state / reset_state", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestHarness();
  });

  afterEach(() => {
    rmSync(harness.tmpDir, { recursive: true, force: true });
  });

  // 4.1 evaluate 后 query
  it("returns evaluated status after evaluate", async () => {
    await callTool(harness.client, "evaluate_rules", {
      projectDir: harness.tmpDir,
      projectPhase: "growth",
      teamSize: "medium",
      techStack: ["typescript"],
    });

    const result = await callTool(harness.client, "query_state", {
      projectDir: harness.tmpDir,
    });
    const state = parseResult(result) as any;
    expect(state.phase).toBe("evaluated");
  });

  // 4.2 reset 后 query
  it("returns null status after reset", async () => {
    await callTool(harness.client, "evaluate_rules", {
      projectDir: harness.tmpDir,
      projectPhase: "growth",
      teamSize: "medium",
      techStack: ["typescript"],
    });
    await callTool(harness.client, "reset_state", {
      projectDir: harness.tmpDir,
    });

    const result = await callTool(harness.client, "query_state", {
      projectDir: harness.tmpDir,
    });
    const state = parseResult(result) as any;
    expect(state.phase).toBeNull();
  });

  // 4.3 从未 init 的目录 query
  it("returns null status for never-init directory", async () => {
    const result = await callTool(harness.client, "query_state", {
      projectDir: harness.tmpDir,
    });
    const state = parseResult(result) as any;
    expect(state.phase).toBeNull();
  });
});

describe("MCP Server — confirm_decisions", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestHarness();
  });

  afterEach(() => {
    rmSync(harness.tmpDir, { recursive: true, force: true });
  });

  // 5.1 evaluated → confirmed
  it("advances to confirmed status", async () => {
    const evalResult = await callTool(harness.client, "evaluate_rules", {
      projectDir: harness.tmpDir,
      projectPhase: "growth",
      teamSize: "medium",
      techStack: ["typescript"],
    });
    const evalData = parseResult(evalResult) as any;
    const decisions: RuleDecision[] = evalData.decisions;

    const result = await callTool(harness.client, "confirm_decisions", {
      projectDir: harness.tmpDir,
      decisions,
    });
    const data = parseResult(result) as any;
    expect(data.status).toBe("confirmed");
    expect(data.summary.totalRules).toBe(decisions.length);
  });

  // 5.2 在 null 状态 confirm
  it("errors when confirming without prior evaluate", async () => {
    const decisions: RuleDecision[] = [{
      ruleId: "R001",
      ruleName: "no-console-log",
      recommendedMedium: "linter",
      alternativeMedia: ["hook"],
      confidence: 0.8,
      reasons: ["test"],
      cognitiveLayerRequired: false,
      cognitiveSkillTriggers: [],
    }];

    const result = await callTool(harness.client, "confirm_decisions", {
      projectDir: harness.tmpDir,
      decisions,
    });
    expect(result.isError).toBe(true);
    const data = parseResult(result) as any;
    expect(data.message).toContain("Cannot confirm decisions");
  });

  // 5.4 confirm 后重试（幂等）
  it("allows re-confirming", async () => {
    const evalResult = await callTool(harness.client, "evaluate_rules", {
      projectDir: harness.tmpDir,
      projectPhase: "growth",
      teamSize: "medium",
      techStack: ["typescript"],
    });
    const evalData = parseResult(evalResult) as any;
    const decisions: RuleDecision[] = evalData.decisions;

    await callTool(harness.client, "confirm_decisions", {
      projectDir: harness.tmpDir,
      decisions,
    });

    // Re-confirm
    const result = await callTool(harness.client, "confirm_decisions", {
      projectDir: harness.tmpDir,
      decisions,
    });
    const data = parseResult(result) as any;
    expect(data.status).toBe("confirmed");
  });
});

describe("MCP Server — rollback", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestHarness();
  });

  afterEach(() => {
    rmSync(harness.tmpDir, { recursive: true, force: true });
  });

  // 6.1 无备份时 list（backup dir 不存在 → isError）
  it("errors when no backup directory exists", async () => {
    const result = await callTool(harness.client, "rollback", {
      projectDir: harness.tmpDir,
      list: true,
    });
    expect(result.isError).toBe(true);
    const data = parseResult(result) as any;
    expect(data.message).toContain("No backups");
  });

  // 6.2 无备份时 restore
  it("errors when restoring without backups", async () => {
    const result = await callTool(harness.client, "rollback", {
      projectDir: harness.tmpDir,
    });
    expect(result.isError).toBe(true);
    const data = parseResult(result) as any;
    expect(data.message).toContain("No backups");
  });

  // 6.3 + 6.4 有备份时的 list 和 restore
  it("lists and restores backups", async () => {
    // Create a backup manually
    const backupDir = join(harness.tmpDir, ".harness", "backups", "test-backup");
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(backupDir, "CLAUDE.md"), "# Backup content");

    // List
    const listResult = await callTool(harness.client, "rollback", {
      projectDir: harness.tmpDir,
      list: true,
    });
    const listData = parseResult(listResult) as any;
    expect(listData.backups.length).toBeGreaterThan(0);

    // Restore
    const rstResult = await callTool(harness.client, "rollback", {
      projectDir: harness.tmpDir,
      backupId: "test-backup",
    });
    const rstData = parseResult(rstResult) as any;
    expect(rstData.restored).toContain("CLAUDE.md");
  });
});

describe("MCP Server — validate_setup", () => {
  // 7.1 完整生成后 validate（手动写入文件后验证）
  it("passes validation when all files are present", async () => {
    await withTempDir(async (dir) => {
      mkdirSync(join(dir, ".claude"), { recursive: true });
      mkdirSync(join(dir, ".harness"), { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test", devDependencies: { eslint: "^8.0.0" } }));
      writeFileSync(join(dir, "CLAUDE.md"), "# Project — Harness Rules\n\n<!-- Auto-generated by Harness Automation System -->\n## Harness Section\n");
      writeFileSync(join(dir, ".claude/settings.json"), JSON.stringify({ "editor.formatOnSave": true }));
      writeFileSync(join(dir, ".harness/state.json"), JSON.stringify({ status: "generated", version: "1.0.0" }));
      writeFileSync(join(dir, ".gitignore"), ".harness/state.json\n.harness/backups/\n");

      const harness = await createTestHarness();
      const result = await callTool(harness.client, "validate_setup", {
        projectDir: dir,
        checkFiles: ["CLAUDE.md", ".claude/settings.json", ".gitignore", "package.json", ".harness/state.json"],
      });
      const data = parseResult(result) as any;
      expect(data.summary.passed).toBe(true);
    });
  });

  // 7.2 缺文件
  it("fails validation when files missing", async () => {
    await withTempDir(async (dir) => {
      const harness = await createTestHarness();
      const result = await callTool(harness.client, "validate_setup", {
        projectDir: dir,
        checkFiles: ["CLAUDE.md", ".claude/settings.json"],
      });
      const data = parseResult(result) as any;
      expect(data.summary.passed).toBe(false);
      expect(data.findings.length).toBeGreaterThan(0);
    });
  });
});

describe("MCP Server — get_rule_stats / analyze_rule_adjustments", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestHarness();
  });

  afterEach(() => {
    rmSync(harness.tmpDir, { recursive: true, force: true });
  });

  // 8.1 未 evaluate 时 collect
  it("errors when collecting stats without prior evaluate", async () => {
    const result = await callTool(harness.client, "get_rule_stats", {
      projectDir: harness.tmpDir,
      collect: true,
    });
    expect(result.isError).toBe(true);
    const data = parseResult(result) as any;
    expect(data.message).toContain("No engine output");
  });

  // 8.2 evaluate 后 collect
  it("returns stats after evaluate", async () => {
    await callTool(harness.client, "evaluate_rules", {
      projectDir: harness.tmpDir,
      projectPhase: "growth",
      teamSize: "medium",
      techStack: ["typescript"],
    });

    const result = await callTool(harness.client, "get_rule_stats", {
      projectDir: harness.tmpDir,
      collect: true,
    });
    const data = parseResult(result) as any;
    expect(data.summary.totalRules).toBeGreaterThan(0);
  });

  // 8.4 无数据时 analyze
  it("errors when analyzing without prior data", async () => {
    const result = await callTool(harness.client, "analyze_rule_adjustments", {
      projectDir: harness.tmpDir,
    });
    expect(result.isError).toBe(true);
    const data = parseResult(result) as any;
    expect(data.message).toContain("No analytics data");
  });
});

describe("MCP Server — export_rules / import_rules", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestHarness();
  });

  afterEach(() => {
    rmSync(harness.tmpDir, { recursive: true, force: true });
  });

  // 9.1 直接 export
  it("exports decisions as portable JSON", async () => {
    await callTool(harness.client, "evaluate_rules", {
      projectDir: harness.tmpDir,
      projectPhase: "growth",
      teamSize: "medium",
      techStack: ["typescript"],
    });

    const result = await callTool(harness.client, "export_rules", {
      projectDir: harness.tmpDir,
    });
    const data = parseResult(result) as any;
    expect(data.export.rules.length).toBeGreaterThan(0);
    expect(data.export.source).toBeDefined();
  });

  // 9.2 saveToFile
  it("saves export to file", async () => {
    await callTool(harness.client, "evaluate_rules", {
      projectDir: harness.tmpDir,
      projectPhase: "growth",
      teamSize: "medium",
      techStack: ["typescript"],
    });

    const result = await callTool(harness.client, "export_rules", {
      projectDir: harness.tmpDir,
      saveToFile: true,
    });
    const data = parseResult(result) as any;
    expect(data.savedPath).toBeTruthy();
    expect(existsSync(data.savedPath)).toBe(true);
  });

  // 9.3 import exportJson
  it("imports from export JSON string", async () => {
    await callTool(harness.client, "evaluate_rules", {
      projectDir: harness.tmpDir,
      projectPhase: "growth",
      teamSize: "medium",
      techStack: ["typescript"],
    });

    const exportResult = await callTool(harness.client, "export_rules", {
      projectDir: harness.tmpDir,
    });
    const exportData = parseResult(exportResult) as any;
    const exportJson = JSON.stringify(exportData.export);

    const importResult = await callTool(harness.client, "import_rules", {
      projectDir: harness.tmpDir,
      exportJson,
    });
    const importData = parseResult(importResult) as any;
    expect(importData.total).toBeGreaterThan(0);
  });

  // 9.4 import presetId
  it("loads preset by ID", async () => {
    const result = await callTool(harness.client, "import_rules", {
      projectDir: harness.tmpDir,
      presetId: "web-app-ts",
    });
    const data = parseResult(result) as any;
    expect(data.preset).toBe("web-app-ts");
    expect(data.total).toBeGreaterThan(0);
  });

  // 9.5 import 不存在的 preset
  it("errors for unknown preset", async () => {
    const result = await callTool(harness.client, "import_rules", {
      projectDir: harness.tmpDir,
      presetId: "non-existent",
    });
    expect(result.isError).toBe(true);
    const data = parseResult(result) as any;
    expect(data.message).toContain("not found");
  });
});

describe("MCP Server — list_rule_presets / list_rule_exports", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestHarness();
  });

  afterEach(() => {
    rmSync(harness.tmpDir, { recursive: true, force: true });
  });

  // 10.1 全部 presets
  it("lists all presets", async () => {
    const result = await callTool(harness.client, "list_rule_presets", {});
    const data = parseResult(result) as any;
    expect(data.presets.length).toBe(5);
  });

  // 10.2 按 techStack 过滤
  it("filters presets by tech stack", async () => {
    const result = await callTool(harness.client, "list_rule_presets", {
      techStack: ["python"],
    });
    const data = parseResult(result) as any;
    data.presets.forEach((p: any) => {
      expect(p.techStack).toContain("python");
    });
  });

  // 10.3 无 exports 时 list
  it("lists exports as empty when none exist", async () => {
    const result = await callTool(harness.client, "list_rule_exports", {
      projectDir: harness.tmpDir,
    });
    const data = parseResult(result) as any;
    expect(data.exports).toEqual([]);
  });
});

describe("MCP Server — unknown tool", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestHarness();
  });

  afterEach(() => {
    rmSync(harness.tmpDir, { recursive: true, force: true });
  });

  it("returns structured UNKNOWN_TOOL error for nonexistent tool", async () => {
    const result = await callTool(harness.client, "nonexistent_tool_xyz", {});
    expect(result.isError).toBe(true);
    const data = parseResult(result) as any;
    expect(data.code).toBe("UNKNOWN_TOOL");
    expect(data.message).toContain("Unknown tool");
    expect(data.recoverable).toBe(false);
  });
});
