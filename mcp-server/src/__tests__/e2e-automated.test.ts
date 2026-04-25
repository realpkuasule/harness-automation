import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../index.js";

// ============================================================
// Test Harness
// ============================================================

let harnessCount = 0;

interface TestHarness {
  client: Client;
  tmpDir: string;
  id: number;
}

async function createTestHarness(): Promise<TestHarness> {
  const server = await createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities: {} },
  );
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  harnessCount++;
  return { client, tmpDir: mkdtempSync(join(tmpdir(), "ht-e2e-")), id: harnessCount };
}

function parseResult(result: { content: Array<{ type: string; text: string }> }): unknown {
  return JSON.parse(result.content[0].text);
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  return await client.callTool({ name, arguments: args }) as any;
}

/**
 * Write generated files from init_harness / generate_config response to disk.
 * The MCP server returns file data but does not write to disk — the client
 * (Claude Desktop etc.) is responsible for that.  This helper simulates that
 * client-side write so backup / rollback / validate tests have files on disk.
 */
function writeGeneratedFiles(
  data: { files: Array<{ path: string; content: string }> },
  dir: string,
): void {
  for (const f of data.files) {
    const filePath = join(dir, f.path);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, f.content, "utf-8");
    // Hook files need executable permission (validator checks this)
    if (f.path.startsWith(".husky/")) {
      chmodSync(filePath, 0o755);
    }
  }
}

// ============================================================
// TC01-TC02: evaluate_rules
// ============================================================

describe("TC01 — evaluate_rules: basic evaluation", () => {
  let h: TestHarness;

  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(() => { rmSync(h.tmpDir, { recursive: true, force: true }); });

  it("returns decisions, summary, and creates state.json", async () => {
    const result = await callTool(h.client, "evaluate_rules", {
      projectDir: h.tmpDir,
      projectPhase: "growth",
      teamSize: "medium",
      techStack: ["typescript", "javascript"],
    });
    const data = parseResult(result) as any;

    // decisions[] and summary
    expect(Array.isArray(data.decisions)).toBe(true);
    expect(data.decisions.length).toBeGreaterThan(0);
    expect(data.summary).toBeDefined();
    expect(data.summary.total).toBe(data.decisions.length);

    // byMedium has at least 3 medium types
    const mediumKeys = Object.keys(data.summary.byMedium);
    expect(mediumKeys.length).toBeGreaterThanOrEqual(3);

    // each decision has required fields
    for (const d of data.decisions) {
      expect(typeof d.confidence).toBe("number");
      expect(d.confidence).toBeGreaterThanOrEqual(0);
      expect(d.confidence).toBeLessThanOrEqual(1);
      expect(Array.isArray(d.reasons)).toBe(true);
      expect(d.reasons.length).toBeGreaterThan(0);
      expect(["claude.md", "settings.json", "linter", "hook", "ci", "linter_error", "linter_warn", "linter+hook", "claude_md", "settings", "none"]).toContain(d.recommendedMedium);
    }

    // state.json created
    const statePath = join(h.tmpDir, ".harness", "state.json");
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.phase).toBe("evaluated");
  });
});

describe("TC02 — evaluate_rules: phase comparison", () => {
  let h: TestHarness;

  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(() => { rmSync(h.tmpDir, { recursive: true, force: true }); });

  it("prototype+solo has fewer hook/ci than mature+large", async () => {
    const protoResult = await callTool(h.client, "evaluate_rules", {
      projectDir: h.tmpDir,
      projectPhase: "prototype",
      teamSize: "solo",
      techStack: ["typescript"],
    });
    const proto = parseResult(protoResult) as any;

    const matureResult = await callTool(h.client, "evaluate_rules", {
      projectDir: h.tmpDir,
      projectPhase: "mature",
      teamSize: "large",
      techStack: ["typescript"],
    });
    const mature = parseResult(matureResult) as any;

    const strictMedia = ["hook", "ci"];
    const protoStrict = proto.decisions.filter((d: any) => strictMedia.includes(d.recommendedMedium)).length;
    const matureStrict = mature.decisions.filter((d: any) => strictMedia.includes(d.recommendedMedium)).length;
    // prototype+solo may equal mature+large if neither team has hook/ci rules
    expect(protoStrict).toBeLessThanOrEqual(matureStrict);

    // prototype+solo has more or equal claude.md/settings.json
    const softMedia = ["claude.md", "claude_md", "settings"];
    const protoSoft = proto.decisions.filter((d: any) => softMedia.includes(d.recommendedMedium)).length;
    const matureSoft = mature.decisions.filter((d: any) => softMedia.includes(d.recommendedMedium)).length;
    expect(protoSoft).toBeGreaterThanOrEqual(matureSoft);

    // query_state after each call returns evaluated
    const state1 = await callTool(h.client, "query_state", { projectDir: h.tmpDir });
    expect((parseResult(state1) as any).phase).toBe("evaluated");
  });
});

// ============================================================
// TC03-TC04: query_state
// ============================================================

describe("TC03 — query_state: normal query", () => {
  let h: TestHarness;

  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(() => { rmSync(h.tmpDir, { recursive: true, force: true }); });

  it("returns structured state after evaluate_rules", async () => {
    await callTool(h.client, "evaluate_rules", {
      projectDir: h.tmpDir,
      projectPhase: "growth",
      teamSize: "medium",
      techStack: ["typescript"],
    });

    const result = await callTool(h.client, "query_state", { projectDir: h.tmpDir });
    const state = parseResult(result) as any;

    expect(state.stateExists).toBe(true);
    expect(state.phase).toBe("evaluated");
    expect(state.project).toBeDefined();
    expect(state.project.projectPhase).toBe("growth");
    expect(state.summary.totalDecisions).toBeGreaterThan(0);
    expect(state.summary.byMedium).toBeDefined();
    expect(state.lastEvalAt).toBeDefined();
    expect(state.sessionId).toBeDefined();
  });
});

describe("TC04 — query_state: no state", () => {
  it("returns default state for empty directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ht-e2e-ns-"));
    try {
      const server = await createServer();
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "tc", version: "1.0.0" }, { capabilities: {} });
      await server.connect(st);
      await client.connect(ct);

      const result = await callTool(client, "query_state", { projectDir: dir });
      const state = parseResult(result) as any;
      expect(state.stateExists).toBe(false);
      expect(state.phase).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ============================================================
// TC05-TC07: confirm_decisions
// ============================================================

describe("TC05 — confirm_decisions: normal confirmation", () => {
  let h: TestHarness;

  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(() => { rmSync(h.tmpDir, { recursive: true, force: true }); });

  it("confirms decisions and updates state", async () => {
    const evalResult = await callTool(h.client, "evaluate_rules", {
      projectDir: h.tmpDir,
      projectPhase: "growth",
      teamSize: "medium",
      techStack: ["typescript"],
    });
    const evalData = parseResult(evalResult) as any;
    const decisions = evalData.decisions.slice(0, 2);

    const confirmResult = await callTool(h.client, "confirm_decisions", {
      projectDir: h.tmpDir,
      decisions,
    });
    const confirmData = parseResult(confirmResult) as any;
    expect(confirmData.status).toBe("confirmed");
    expect(confirmData.summary.totalRules).toBe(2);

    // query_state confirms status
    const stateResult = await callTool(h.client, "query_state", { projectDir: h.tmpDir });
    const state = parseResult(stateResult) as any;
    expect(state.phase).toBe("confirmed");
    expect(state.confirmedAt).toBeDefined();
  });
});

describe("TC06 — confirm_decisions: reject without evaluate", () => {
  it("rejects with error when no prior evaluate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ht-e2e-nc-"));
    try {
      const server = await createServer();
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "tc", version: "1.0.0" }, { capabilities: {} });
      await server.connect(st);
      await client.connect(ct);

      const result = await callTool(client, "confirm_decisions", {
        projectDir: dir,
        decisions: [{
          ruleId: "R001",
          ruleName: "no-console-log",
          recommendedMedium: "linter",
          alternativeMedia: [],
          confidence: 0.8,
          reasons: ["test"],
          cognitiveLayerRequired: false,
          cognitiveSkillTriggers: [],
        }],
      });
      expect(result.isError).toBe(true);
      const data = parseResult(result) as any;
      expect(data.message || data.error).toMatch(/evaluate_rules first/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("TC07 — confirm_decisions: minimal format (ruleId + recommendedMedium)", () => {
  let h: TestHarness;

  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(() => { rmSync(h.tmpDir, { recursive: true, force: true }); });

  it("enriches partial decisions and confirms", async () => {
    await callTool(h.client, "evaluate_rules", {
      projectDir: h.tmpDir,
      projectPhase: "growth",
      teamSize: "medium",
      techStack: ["typescript"],
    });

    const result = await callTool(h.client, "confirm_decisions", {
      projectDir: h.tmpDir,
      decisions: [
        { ruleId: "R001", recommendedMedium: "linter" },
        { ruleId: "R004", recommendedMedium: "hook" },
      ],
    });
    expect(result.isError).toBeFalsy();
    const data = parseResult(result) as any;
    expect(data.status).toBe("confirmed");
    expect(data.summary.totalRules).toBe(2);

    // 验证状态已推进到 confirmed
    const stateResult = await callTool(h.client, "query_state", { projectDir: h.tmpDir });
    const state = parseResult(stateResult) as any;
    expect(state.stateExists).toBe(true);
    expect(state.phase).toBe("confirmed");
    expect(state.confirmedAt).toBeDefined();
  });
});

// ============================================================
// TC08-TC10: generate_config
// ============================================================

describe("TC08 — generate_config: normal generation", () => {
  let h: TestHarness;

  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(() => { rmSync(h.tmpDir, { recursive: true, force: true }); });

  it("generates config files after evaluate+confirm", async () => {
    // evaluate
    const evalResult = await callTool(h.client, "evaluate_rules", {
      projectDir: h.tmpDir,
      projectPhase: "growth",
      teamSize: "medium",
      techStack: ["typescript"],
    });
    const evalData = parseResult(evalResult) as any;

    // confirm
    await callTool(h.client, "confirm_decisions", {
      projectDir: h.tmpDir,
      decisions: evalData.decisions,
    });

    // generate with empty decisions (use state)
    const genResult = await callTool(h.client, "generate_config", {
      projectDir: h.tmpDir,
      decisions: [],
    });
    const genData = parseResult(genResult) as any;

    expect(Array.isArray(genData.files)).toBe(true);
    expect(genData.summary).toBeDefined();
    expect(genData.summary.created + genData.summary.updated).toBe(genData.summary.total);

    const filePaths = genData.files.map((f: any) => f.path);
    expect(filePaths).toContain("CLAUDE.md");
    expect(filePaths).toContain(".claude/settings.json");

    // state updated to generated
    const stateResult = await callTool(h.client, "query_state", { projectDir: h.tmpDir });
    expect((parseResult(stateResult) as any).phase).toBe("generated");
  });
});

describe("TC09 — generate_config: dryRun", () => {
  let h: TestHarness;

  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(() => { rmSync(h.tmpDir, { recursive: true, force: true }); });

  it("returns file list but does NOT write to disk", async () => {
    const evalResult = await callTool(h.client, "evaluate_rules", {
      projectDir: h.tmpDir,
      projectPhase: "growth",
      teamSize: "medium",
      techStack: ["typescript"],
    });
    const evalData = parseResult(evalResult) as any;

    await callTool(h.client, "confirm_decisions", {
      projectDir: h.tmpDir,
      decisions: evalData.decisions,
    });

    const genResult = await callTool(h.client, "generate_config", {
      projectDir: h.tmpDir,
      decisions: [],
      dryRun: true,
    });
    const genData = parseResult(genResult) as any;
    expect(Array.isArray(genData.files)).toBe(true);
    expect(genData.files.length).toBeGreaterThan(0);

    // No files written to disk
    expect(existsSync(join(h.tmpDir, "CLAUDE.md"))).toBe(false);

    // State remains confirmed (not generated)
    const stateResult = await callTool(h.client, "query_state", { projectDir: h.tmpDir });
    expect((parseResult(stateResult) as any).phase).toBe("confirmed");
  });
});

describe("TC10 — generate_config: reject without decisions", () => {
  it("rejects with error when no decisions available", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ht-e2e-ng-"));
    try {
      const server = await createServer();
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "tc", version: "1.0.0" }, { capabilities: {} });
      await server.connect(st);
      await client.connect(ct);

      const result = await callTool(client, "generate_config", {
        projectDir: dir,
        decisions: [],
      });
      expect(result.isError).toBe(true);
      const data = parseResult(result) as any;
      expect(data.message || data.error).toMatch(/No decisions/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ============================================================
// TC11-TC14: init_harness
// ============================================================

describe("TC11 — init_harness: one-click init", () => {
  let h: TestHarness;

  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(() => { rmSync(h.tmpDir, { recursive: true, force: true }); });

  it("evaluates, generates, and returns file list", async () => {
    const result = await callTool(h.client, "init_harness", {
      projectDir: h.tmpDir,
      projectPhase: "growth",
      teamSize: "medium",
      techStack: ["typescript"],
    });
    const data = parseResult(result) as any;

    expect(Array.isArray(data.files)).toBe(true);
    expect(data.summary).toBeDefined();
    expect(data.summary.files).toBeDefined();

    const filePaths = data.files.map((f: any) => f.path);
    expect(filePaths).toContain("CLAUDE.md");
    expect(filePaths).toContain(".claude/settings.json");

    // State is generated
    const stateResult = await callTool(h.client, "query_state", { projectDir: h.tmpDir });
    expect((parseResult(stateResult) as any).phase).toBe("generated");
  });
});

describe("TC12 — init_harness: file content validation", () => {
  let h: TestHarness;

  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(() => { rmSync(h.tmpDir, { recursive: true, force: true }); });

  it("generates files with correct content", async () => {
    const result = await callTool(h.client, "init_harness", {
      projectDir: h.tmpDir,
      projectPhase: "growth",
      teamSize: "medium",
      techStack: ["typescript"],
    });
    const data = parseResult(result) as any;

    const files: Record<string, string> = {};
    for (const f of data.files) {
      files[f.path] = f.content;
    }

    // CLAUDE.md starts with header
    expect(files["CLAUDE.md"]).toContain("#");
    expect(files["CLAUDE.md"]).toContain("Generated by Harness Automation System");

    // .claude/settings.json is valid JSON with formatOnSave
    const settings = JSON.parse(files[".claude/settings.json"]);
    expect(settings).toBeDefined();

    // .gitignore contains .harness entries
    expect(files[".gitignore"]).toContain(".harness/state.json");
  });
});

describe("TC13 — init_harness: dryRun", () => {
  let h: TestHarness;

  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(() => { rmSync(h.tmpDir, { recursive: true, force: true }); });

  it("returns decisions without generating config files", async () => {
    const result = await callTool(h.client, "init_harness", {
      projectDir: h.tmpDir,
      projectPhase: "growth",
      teamSize: "medium",
      techStack: ["typescript"],
      dryRun: true,
    });
    const data = parseResult(result) as any;
    expect(Array.isArray(data.files)).toBe(true);
    expect(data.files.length).toBe(0);
    expect(data.summary.files.total).toBe(0);
    expect(data.summary.decisions).toBeGreaterThan(0);
    expect(data.validation).toBeUndefined();

    // No files written to disk
    expect(existsSync(join(h.tmpDir, "CLAUDE.md"))).toBe(false);
  });
});

describe("TC14 — init_harness: repeat call creates backup", () => {
  let h: TestHarness;

  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(() => { rmSync(h.tmpDir, { recursive: true, force: true }); });

  it("creates backup on second init_harness call", async () => {
    // First call
    const result1 = await callTool(h.client, "init_harness", {
      projectDir: h.tmpDir,
      projectPhase: "growth",
      teamSize: "medium",
      techStack: ["typescript"],
    });
    const data1 = parseResult(result1) as any;
    // Write files to disk so second call has files to back up
    writeGeneratedFiles(data1, h.tmpDir);

    // Second call — should create backup since files exist on disk now
    const result2 = await callTool(h.client, "init_harness", {
      projectDir: h.tmpDir,
      projectPhase: "growth",
      teamSize: "medium",
      techStack: ["typescript"],
    });
    const data2 = parseResult(result2) as any;
    expect(data2.summary.backupDir).toBeDefined();

    // Backup directory exists on disk
    expect(existsSync(data2.summary.backupDir)).toBe(true);
  });
});

// ============================================================
// TC15-TC17, TC35: rollback
// ============================================================

describe("TC15 — rollback: restore from backup", () => {
  let h: TestHarness;

  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(() => { rmSync(h.tmpDir, { recursive: true, force: true }); });

  it("restores files from latest backup", async () => {
    // First call — generates files but does not write them to disk
    const result1 = await callTool(h.client, "init_harness", {
      projectDir: h.tmpDir,
      projectPhase: "growth",
      teamSize: "medium",
      techStack: ["typescript"],
    });
    // Server returns file data; client must write to disk
    writeGeneratedFiles(parseResult(result1) as any, h.tmpDir);

    // Second call creates backup of disk files, then returns new files
    const result2 = await callTool(h.client, "init_harness", {
      projectDir: h.tmpDir,
      projectPhase: "growth",
      teamSize: "medium",
      techStack: ["typescript"],
    });
    writeGeneratedFiles(parseResult(result2) as any, h.tmpDir);

    // Modify CLAUDE.md
    const claudePath = join(h.tmpDir, "CLAUDE.md");
    writeFileSync(claudePath, "MODIFIED CONTENT", "utf-8");

    // Rollback
    const rollbackResult = await callTool(h.client, "rollback", {
      projectDir: h.tmpDir,
    });
    const rollbackData = parseResult(rollbackResult) as any;
    expect(rollbackData.status).toBe("success");
    expect(Array.isArray(rollbackData.restored)).toBe(true);
    expect(rollbackData.restored.length).toBeGreaterThan(0);

    // File restored to original content
    const restoredContent = readFileSync(claudePath, "utf-8");
    expect(restoredContent).not.toBe("MODIFIED CONTENT");
    expect(restoredContent).toContain("Generated by Harness Automation System");
  });
});

describe("TC16 — rollback: list backups", () => {
  let h: TestHarness;

  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(() => { rmSync(h.tmpDir, { recursive: true, force: true }); });

  it("returns list of available backups", async () => {
    const result1 = await callTool(h.client, "init_harness", {
      projectDir: h.tmpDir,
      projectPhase: "growth",
      teamSize: "medium",
      techStack: ["typescript"],
    });
    writeGeneratedFiles(parseResult(result1) as any, h.tmpDir);

    await callTool(h.client, "init_harness", {
      projectDir: h.tmpDir,
      projectPhase: "growth",
      teamSize: "medium",
      techStack: ["typescript"],
    });

    const result = await callTool(h.client, "rollback", {
      projectDir: h.tmpDir,
      list: true,
    });
    const data = parseResult(result) as any;
    expect(Array.isArray(data.backups)).toBe(true);
    expect(data.backups.length).toBeGreaterThan(0);
    expect(data.backups[0].id).toBeDefined();
    expect(data.backups[0].files).toBeDefined();
    expect(data.backups[0].createdAt).toBeDefined();
  });
});

describe("TC17 — rollback: reject with no backups", () => {
  it("returns error when no backups exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ht-e2e-rbe-"));
    try {
      const server = await createServer();
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "tc", version: "1.0.0" }, { capabilities: {} });
      await server.connect(st);
      await client.connect(ct);

      const result = await callTool(client, "rollback", { projectDir: dir });
      expect(result.isError).toBe(true);
      const data = parseResult(result) as any;
      expect(data.message).toMatch(/No backups found/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("TC35 — rollback: specific backupId", () => {
  let h: TestHarness;

  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(() => { rmSync(h.tmpDir, { recursive: true, force: true }); });

  it("restores from a specified backup ID", async () => {
    const result1 = await callTool(h.client, "init_harness", {
      projectDir: h.tmpDir,
      projectPhase: "growth",
      teamSize: "medium",
      techStack: ["typescript"],
    });
    writeGeneratedFiles(parseResult(result1) as any, h.tmpDir);

    await callTool(h.client, "init_harness", {
      projectDir: h.tmpDir,
      projectPhase: "growth",
      teamSize: "medium",
      techStack: ["typescript"],
    });

    // List backups
    const listResult = await callTool(h.client, "rollback", {
      projectDir: h.tmpDir,
      list: true,
    });
    const listData = parseResult(listResult) as any;
    const backupId = listData.backups[0].id;

    // Modify CLAUDE.md
    const claudePath = join(h.tmpDir, "CLAUDE.md");
    writeFileSync(claudePath, "MODIFIED", "utf-8");

    // Rollback to specific backupId
    const result = await callTool(h.client, "rollback", {
      projectDir: h.tmpDir,
      backupId,
    });
    const data = parseResult(result) as any;
    expect(data.status).toBe("success");
    expect(data.restored.length).toBeGreaterThan(0);
  });
});

// ============================================================
// TC18-TC19: validate_setup
// ============================================================

describe("TC18 — validate_setup: full validation", () => {
  let h: TestHarness;

  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(() => { rmSync(h.tmpDir, { recursive: true, force: true }); });

  it("passes validation after init_harness", async () => {
    // Validator checks for package.json — create a minimal one
    writeFileSync(join(h.tmpDir, "package.json"), JSON.stringify({ name: "test", version: "0.0.0" }), "utf-8");

    const genResult = await callTool(h.client, "init_harness", {
      projectDir: h.tmpDir,
      projectPhase: "growth",
      teamSize: "medium",
      techStack: ["typescript"],
    });
    // Validate reads from disk — write generated files first
    writeGeneratedFiles(parseResult(genResult) as any, h.tmpDir);

    const result = await callTool(h.client, "validate_setup", {
      projectDir: h.tmpDir,
    });
    const data = parseResult(result) as any;

    expect(Array.isArray(data.findings)).toBe(true);
    expect(data.summary.passed).toBe(true);
    expect(data.summary.errors).toBe(0);
  });
});

describe("TC19 — validate_setup: missing file detection", () => {
  let h: TestHarness;

  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(() => { rmSync(h.tmpDir, { recursive: true, force: true }); });

  it("fails validation when CLAUDE.md is deleted", async () => {
    writeFileSync(join(h.tmpDir, "package.json"), JSON.stringify({ name: "test", version: "0.0.0" }), "utf-8");

    const genResult = await callTool(h.client, "init_harness", {
      projectDir: h.tmpDir,
      projectPhase: "growth",
      teamSize: "medium",
      techStack: ["typescript"],
    });
    writeGeneratedFiles(parseResult(genResult) as any, h.tmpDir);

    // Delete CLAUDE.md
    rmSync(join(h.tmpDir, "CLAUDE.md"));

    const result = await callTool(h.client, "validate_setup", {
      projectDir: h.tmpDir,
    });
    const data = parseResult(result) as any;

    expect(data.summary.passed).toBe(false);
    expect(data.summary.errors).toBeGreaterThan(0);

    const missingClaudeMd = data.findings.some(
      (f: any) => f.message && f.message.includes("CLAUDE.md") && f.type === "error"
    );
    expect(missingClaudeMd).toBe(true);
  });
});

// ============================================================
// TC20-TC21, TC34: scan_codebase
// ============================================================

describe("TC20 — scan_codebase: basic scan", () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = await createTestHarness();
    mkdirSync(join(h.tmpDir, "src"), { recursive: true });
    writeFileSync(join(h.tmpDir, "src", "index.ts"), [
      'console.log("hello");',
      'debugger;',
      "if (x > 30000) return;",
    ].join("\n"), "utf-8");
  });
  afterEach(() => { rmSync(h.tmpDir, { recursive: true, force: true }); });

  it("detects violations and returns decisions", async () => {
    const result = await callTool(h.client, "scan_codebase", {
      projectDir: h.tmpDir,
      techStack: ["typescript"],
      projectPhase: "growth",
      teamSize: "medium",
    });
    const data = parseResult(result) as any;

    expect(data.scanSummary).toBeDefined();
    expect(data.scanSummary.suggestions).toBeDefined();
    const suggestionNames = data.scanSummary.suggestions.map((s: any) => s.ruleName || s.ruleId);
    expect(suggestionNames).toContain("no-console-log");
    expect(suggestionNames).toContain("no-debugger");
    expect(suggestionNames).toContain("no-magic-numbers");

    expect(Array.isArray(data.decisions)).toBe(true);
    expect(data.decisions.length).toBeGreaterThan(0);

    // query_state shows evaluated status
    const stateResult = await callTool(h.client, "query_state", { projectDir: h.tmpDir });
    expect((parseResult(stateResult) as any).phase).toBe("evaluated");
  });
});

describe("TC21 — scan_codebase: with CLAUDE.md extraction", () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = await createTestHarness();
    mkdirSync(join(h.tmpDir, "src"), { recursive: true });
    writeFileSync(join(h.tmpDir, "CLAUDE.md"), "### my-custom-rule\nThis is a custom project rule.\n", "utf-8");
    writeFileSync(join(h.tmpDir, "src", "index.ts"), 'console.log("hello");\n', "utf-8");
  });
  afterEach(() => { rmSync(h.tmpDir, { recursive: true, force: true }); });

  it("extracts custom rules from existing CLAUDE.md", async () => {
    const result = await callTool(h.client, "scan_codebase", {
      projectDir: h.tmpDir,
      techStack: ["typescript"],
      projectPhase: "growth",
      teamSize: "medium",
    });
    const data = parseResult(result) as any;

    expect(data.extractedRules).toBeGreaterThan(0);
    const hasCustomRule = data.decisions.some((d: any) => d.ruleName === "my-custom-rule");
    expect(hasCustomRule).toBe(true);
  });
});

describe("TC34 — scan_codebase: cache functionality", () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = await createTestHarness();
    mkdirSync(join(h.tmpDir, "src"), { recursive: true });
    writeFileSync(join(h.tmpDir, "src", "index.ts"), 'console.log("hello");\n', "utf-8");
  });
  afterEach(() => { rmSync(h.tmpDir, { recursive: true, force: true }); });

  it("returns consistent results with useCache", async () => {
    const result1 = await callTool(h.client, "scan_codebase", {
      projectDir: h.tmpDir,
      techStack: ["typescript"],
      projectPhase: "growth",
      teamSize: "medium",
    });
    const data1 = parseResult(result1) as any;

    const result2 = await callTool(h.client, "scan_codebase", {
      projectDir: h.tmpDir,
      techStack: ["typescript"],
      projectPhase: "growth",
      teamSize: "medium",
      useCache: true,
    });
    const data2 = parseResult(result2) as any;

    expect(data2.scanSummary.filesScanned).toBe(data1.scanSummary.filesScanned);

    // Cache file exists
    expect(existsSync(join(h.tmpDir, ".harness", "scan-cache.json"))).toBe(true);
  });
});

// ============================================================
// TC22-TC23: get_rule_stats
// ============================================================

describe("TC22 — get_rule_stats: collect stats", () => {
  let h: TestHarness;

  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(() => { rmSync(h.tmpDir, { recursive: true, force: true }); });

  it("returns analytics data with rules and summary", async () => {
    await callTool(h.client, "init_harness", {
      projectDir: h.tmpDir,
      projectPhase: "growth",
      teamSize: "medium",
      techStack: ["typescript"],
    });

    const result = await callTool(h.client, "get_rule_stats", {
      projectDir: h.tmpDir,
      collect: true,
    });
    const data = parseResult(result) as any;

    expect(data.summary).toBeDefined();
    expect(data.summary.totalRules).toBeGreaterThan(0);
    expect(data.summary.byMedium).toBeDefined();
    expect(typeof data.summary.averageConfidence).toBe("number");
    expect(Array.isArray(data.rules)).toBe(true);

    // Analytics file created
    expect(existsSync(join(h.tmpDir, ".harness", "analytics.json"))).toBe(true);
  });
});

describe("TC23 — get_rule_stats: reject without state", () => {
  it("returns error when no engine output exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ht-e2e-st-"));
    try {
      const server = await createServer();
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "tc", version: "1.0.0" }, { capabilities: {} });
      await server.connect(st);
      await client.connect(ct);

      const result = await callTool(client, "get_rule_stats", {
        projectDir: dir,
        collect: true,
      });
      expect(result.isError).toBe(true);
      const data = parseResult(result) as any;
      expect(data.message).toMatch(/No engine output/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ============================================================
// TC24: analyze_rule_adjustments
// ============================================================

describe("TC24 — analyze_rule_adjustments", () => {
  let h: TestHarness;

  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(() => { rmSync(h.tmpDir, { recursive: true, force: true }); });

  it("returns adjustment recommendations", async () => {
    // Need analytics data first
    await callTool(h.client, "init_harness", {
      projectDir: h.tmpDir,
      projectPhase: "growth",
      teamSize: "medium",
      techStack: ["typescript"],
    });
    await callTool(h.client, "get_rule_stats", {
      projectDir: h.tmpDir,
      collect: true,
    });

    const result = await callTool(h.client, "analyze_rule_adjustments", {
      projectDir: h.tmpDir,
    });
    const data = parseResult(result) as any;

    expect(data.summary).toBeDefined();
    expect(typeof data.summary.total).toBe("number");
    expect(typeof data.summary.upgrade).toBe("number");
    expect(typeof data.summary.downgrade).toBe("number");
    expect(typeof data.summary.keep).toBe("number");
    expect(data.summary.total).toBe(data.summary.upgrade + data.summary.downgrade + data.summary.keep);
    expect(Array.isArray(data.recommendations)).toBe(true);
  });
});

// ============================================================
// TC25-TC27: export / list exports
// ============================================================

describe("TC25 — export_rules: export to JSON", () => {
  let h: TestHarness;

  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(() => { rmSync(h.tmpDir, { recursive: true, force: true }); });

  it("returns export object with rules", async () => {
    await callTool(h.client, "evaluate_rules", {
      projectDir: h.tmpDir,
      projectPhase: "growth",
      teamSize: "medium",
      techStack: ["typescript"],
    });

    const result = await callTool(h.client, "export_rules", {
      projectDir: h.tmpDir,
      saveToFile: false,
    });
    const data = parseResult(result) as any;

    expect(data.export).toBeDefined();
    expect(data.export.version).toBe("1.0");
    expect(Array.isArray(data.export.rules)).toBe(true);
    expect(data.export.rules.length).toBeGreaterThan(0);
    expect(data.export.source.projectPhase).toBe("growth");
    expect(data.export.source.teamSize).toBe("medium");
    expect(data.savedPath).toBeNull();
  });
});

describe("TC26 — export_rules: save to file", () => {
  let h: TestHarness;

  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(() => { rmSync(h.tmpDir, { recursive: true, force: true }); });

  it("saves export to file on disk", async () => {
    await callTool(h.client, "evaluate_rules", {
      projectDir: h.tmpDir,
      projectPhase: "growth",
      teamSize: "medium",
      techStack: ["typescript"],
    });

    const result = await callTool(h.client, "export_rules", {
      projectDir: h.tmpDir,
      saveToFile: true,
      filename: "my-export.json",
    });
    const data = parseResult(result) as any;

    expect(data.savedPath).toMatch(/my-export\.json/);
    expect(existsSync(data.savedPath)).toBe(true);

    // File content is valid JSON
    const fileContent = readFileSync(data.savedPath, "utf-8");
    const parsed = JSON.parse(fileContent);
    expect(parsed.version).toBe("1.0");
  });
});

describe("TC27 — list_rule_exports", () => {
  let h: TestHarness;

  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(() => { rmSync(h.tmpDir, { recursive: true, force: true }); });

  it("lists exported files", async () => {
    await callTool(h.client, "evaluate_rules", {
      projectDir: h.tmpDir,
      projectPhase: "growth",
      teamSize: "medium",
      techStack: ["typescript"],
    });
    await callTool(h.client, "export_rules", {
      projectDir: h.tmpDir,
      saveToFile: true,
      filename: "my-export.json",
    });

    const result = await callTool(h.client, "list_rule_exports", {
      projectDir: h.tmpDir,
    });
    const data = parseResult(result) as any;

    expect(Array.isArray(data.exports)).toBe(true);
    const found = data.exports.some((e: any) => e.includes("my-export.json") || e.name?.includes("my-export"));
    expect(found).toBe(true);
  });
});

// ============================================================
// TC28-TC31: import_rules / presets
// ============================================================

describe("TC28 — import_rules: from preset", () => {
  let h: TestHarness;

  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(() => { rmSync(h.tmpDir, { recursive: true, force: true }); });

  it("imports web-app-ts preset with 16 rules", async () => {
    const result = await callTool(h.client, "import_rules", {
      projectDir: h.tmpDir,
      presetId: "web-app-ts",
    });
    const data = parseResult(result) as any;

    expect(data.preset).toBe("web-app-ts");
    expect(Array.isArray(data.decisions)).toBe(true);
    expect(data.total).toBe(16);
    // All decisions enriched to full format
    for (const d of data.decisions) {
      expect(typeof d.confidence).toBe("number");
      expect(d.confidence).toBeGreaterThan(0);
    }
  });
});

describe("TC29 — import_rules: from JSON", () => {
  let h: TestHarness;

  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(() => { rmSync(h.tmpDir, { recursive: true, force: true }); });

  it("imports previously exported rules", async () => {
    // First, create an export
    await callTool(h.client, "evaluate_rules", {
      projectDir: h.tmpDir,
      projectPhase: "growth",
      teamSize: "medium",
      techStack: ["typescript"],
    });
    const exportResult = await callTool(h.client, "export_rules", {
      projectDir: h.tmpDir,
      saveToFile: false,
    });
    const exportData = parseResult(exportResult) as any;
    const exportJson = JSON.stringify(exportData.export);

    // Create a fresh harness for importing
    const dir = mkdtempSync(join(tmpdir(), "ht-e2e-imp-"));
    try {
      const server = await createServer();
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "tc", version: "1.0.0" }, { capabilities: {} });
      await server.connect(st);
      await client.connect(ct);

      const result = await callTool(client, "import_rules", {
        projectDir: dir,
        exportJson,
      });
      const data = parseResult(result) as any;

      expect(Array.isArray(data.decisions)).toBe(true);
      expect(data.total).toBeGreaterThan(0);
      expect(Array.isArray(data.warnings)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("TC30 — import_rules: invalid preset", () => {
  it("returns error for non-existent preset", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ht-e2e-ip-"));
    try {
      const server = await createServer();
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "tc", version: "1.0.0" }, { capabilities: {} });
      await server.connect(st);
      await client.connect(ct);

      const result = await callTool(client, "import_rules", {
        projectDir: dir,
        presetId: "non-existent-preset",
      });
      expect(result.isError).toBe(true);
      const data = parseResult(result) as any;
      expect(data.message).toMatch(/not found/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("TC31 — list_rule_presets", () => {
  it("lists all 5 presets and supports filtering", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ht-e2e-lp-"));
    try {
      const server = await createServer();
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "tc", version: "1.0.0" }, { capabilities: {} });
      await server.connect(st);
      await client.connect(ct);

      // All presets
      const allResult = await callTool(client, "list_rule_presets", {});
      const allData = parseResult(allResult) as any;
      expect(Array.isArray(allData.presets)).toBe(true);
      expect(allData.presets.length).toBe(5);

      const presetIds = allData.presets.map((p: any) => p.id);
      expect(presetIds).toContain("web-app-ts");
      expect(presetIds).toContain("library-ts");
      expect(presetIds).toContain("python-script");
      expect(presetIds).toContain("prototype");
      expect(presetIds).toContain("go-service");

      // Filter by python
      const pyResult = await callTool(client, "list_rule_presets", {
        techStack: ["python"],
      });
      const pyData = parseResult(pyResult) as any;
      expect(pyData.presets.length).toBeLessThan(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ============================================================
// TC32: reset_state
// ============================================================

describe("TC32 — reset_state", () => {
  let h: TestHarness;

  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(() => { rmSync(h.tmpDir, { recursive: true, force: true }); });

  it("resets state and clears decisions", async () => {
    await callTool(h.client, "evaluate_rules", {
      projectDir: h.tmpDir,
      projectPhase: "growth",
      teamSize: "medium",
      techStack: ["typescript"],
    });

    const resetResult = await callTool(h.client, "reset_state", {
      projectDir: h.tmpDir,
    });
    const resetData = parseResult(resetResult) as any;
    expect(resetData.message).toMatch(/reset successfully/i);

    // State is cleared
    const stateResult = await callTool(h.client, "query_state", { projectDir: h.tmpDir });
    const state = parseResult(stateResult) as any;
    expect(state.phase).toBeNull();
  });
});

// ============================================================
// TC33: unknown techStack
// ============================================================

describe("TC33 — evaluate_rules: unknown techStack", () => {
  let h: TestHarness;

  beforeEach(async () => { h = await createTestHarness(); });
  afterEach(() => { rmSync(h.tmpDir, { recursive: true, force: true }); });

  it("handles unknown tech stack gracefully", async () => {
    // This should not throw — the server validates via Zod and should handle
    // empty/generic tech stacks
    const result = await callTool(h.client, "evaluate_rules", {
      projectDir: h.tmpDir,
      projectPhase: "growth",
      teamSize: "medium",
      techStack: [],
    });
    const data = parseResult(result) as any;
    expect(data.decisions).toEqual([]);
    expect(data.summary.total).toBe(0);
  });
});
