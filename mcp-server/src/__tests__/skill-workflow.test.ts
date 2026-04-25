import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../index.js";

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
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, tmpDir: mkdtempSync(join(tmpdir(), "ht-sw-")) };
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
 * Simulate client-side file writes from generated file data.
 */
function writeGeneratedFiles(
  data: { files: Array<{ path: string; content: string }> },
  dir: string,
): void {
  for (const f of data.files) {
    const filePath = join(dir, f.path);
    mkdirSync(join(filePath, ".."), { recursive: true });
    writeFileSync(filePath, f.content, "utf-8");
  }
}

// ============================================================
// Skill Workflow Tests
// ============================================================

describe("P13-6 Skill Workflow", () => {
  describe("Full workflow (assess → evaluate → confirm → generate → validate)", () => {
    let h: TestHarness;

    beforeEach(async () => { h = await createTestHarness(); });
    afterEach(() => { rmSync(h.tmpDir, { recursive: true, force: true }); });

    it("Step 0: assess_suitability returns assessment", async () => {
      const result = await callTool(h.client, "assess_suitability", {
        projectDir: h.tmpDir,
        analysisDepth: "quick",
      });
      const data = parseResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty("suitable");
      expect(data).toHaveProperty("score");
      expect(data).toHaveProperty("reason");
      expect(data).toHaveProperty("warnings");
      expect(data).toHaveProperty("recommendations");
    });

    it("Step 1: query_state returns null phase for new project", async () => {
      const result = await callTool(h.client, "query_state", {
        projectDir: h.tmpDir,
      });
      const data = parseResult(result) as Record<string, unknown>;
      expect(data.stateExists).toBe(false);
      expect(data.phase).toBeNull();
    });

    it("Step 3: evaluate_rules returns decisions", async () => {
      const result = await callTool(h.client, "evaluate_rules", {
        projectDir: h.tmpDir,
        techStack: ["typescript"],
        projectPhase: "early",
        teamSize: "small",
      });
      const data = parseResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty("decisions");
      expect(data).toHaveProperty("conflicts");
      expect(data).toHaveProperty("summary");
      const decisions = data.decisions as Array<Record<string, unknown>>;
      expect(decisions.length).toBeGreaterThan(0);
    });

    it("Step 6: confirm_decisions persists decisions and advances phase", async () => {
      // First evaluate
      const evalResult = await callTool(h.client, "evaluate_rules", {
        projectDir: h.tmpDir,
        techStack: ["typescript"],
        projectPhase: "early",
        teamSize: "small",
      });
      const evalData = parseResult(evalResult) as Record<string, unknown>;
      const decisions = (evalData.decisions as Array<Record<string, unknown>>).map((d) => ({
        ruleId: d.ruleId,
        recommendedMedium: d.recommendedMedium,
      }));

      // Confirm
      const confirmResult = await callTool(h.client, "confirm_decisions", {
        projectDir: h.tmpDir,
        decisions,
      });
      const confirmData = parseResult(confirmResult) as Record<string, unknown>;
      expect(confirmData.status).toBe("confirmed");

      // Verify phase advanced
      const stateResult = await callTool(h.client, "query_state", {
        projectDir: h.tmpDir,
      });
      const stateData = parseResult(stateResult) as Record<string, unknown>;
      expect(stateData.phase).toBe("confirmed");
    });

    it("Step 7: generate_config dry_run does NOT write files", async () => {
      // First evaluate
      const evalResult = await callTool(h.client, "evaluate_rules", {
        projectDir: h.tmpDir,
        techStack: ["typescript"],
        projectPhase: "early",
        teamSize: "small",
      });
      const evalData = parseResult(evalResult) as Record<string, unknown>;
      const decisions = (evalData.decisions as Array<Record<string, unknown>>).map((d) => ({
        ruleId: d.ruleId,
        recommendedMedium: d.recommendedMedium,
      }));

      // Dry-run generate
      const dryResult = await callTool(h.client, "generate_config", {
        projectDir: h.tmpDir,
        decisions,
        dryRun: true,
      });
      const dryData = parseResult(dryResult) as Record<string, unknown>;
      expect(dryData).toHaveProperty("files");

      // Verify no files were actually written
      expect(existsSync(join(h.tmpDir, "CLAUDE.md"))).toBe(false);
    });

    it("Step 7+8: generate_config then validate_setup after writing files", async () => {
      // Evaluate → confirm first
      const evalResult = await callTool(h.client, "evaluate_rules", {
        projectDir: h.tmpDir,
        techStack: ["typescript"],
        projectPhase: "early",
        teamSize: "small",
      });
      const evalData = parseResult(evalResult) as Record<string, unknown>;
      const decisions = (evalData.decisions as Array<Record<string, unknown>>).map((d) => ({
        ruleId: d.ruleId,
        recommendedMedium: d.recommendedMedium,
      }));

      // Generate (sets up state)
      const genResult = await callTool(h.client, "generate_config", {
        projectDir: h.tmpDir,
        decisions,
        dryRun: false,
      });
      const genData = parseResult(genResult) as Record<string, unknown>;

      // Write generated files to disk (simulating Claude Desktop client behavior)
      writeGeneratedFiles(genData as { files: Array<{ path: string; content: string }> }, h.tmpDir);

      // Validate
      const valResult = await callTool(h.client, "validate_setup", {
        projectDir: h.tmpDir,
      });
      const valData = parseResult(valResult) as Record<string, unknown>;
      const valSummary = valData.summary as Record<string, unknown>;
      expect(valSummary).toHaveProperty("status");
      expect(["pass", "warn", "fail"]).toContain(valSummary.status);
    });
  });

  describe("Breakpoint resume (query_state phase detection)", () => {
    let h: TestHarness;

    beforeEach(async () => { h = await createTestHarness(); });
    afterEach(() => { rmSync(h.tmpDir, { recursive: true, force: true }); });

    it("null phase — new project, no state", async () => {
      const result = await callTool(h.client, "query_state", {
        projectDir: h.tmpDir,
      });
      const data = parseResult(result) as Record<string, unknown>;
      expect(data.stateExists).toBe(false);
      expect(data.phase).toBeNull();
    });

    it("evaluated phase — after evaluate_rules", async () => {
      await callTool(h.client, "evaluate_rules", {
        projectDir: h.tmpDir,
        techStack: ["typescript"],
        projectPhase: "early",
        teamSize: "small",
      });

      const result = await callTool(h.client, "query_state", {
        projectDir: h.tmpDir,
      });
      const data = parseResult(result) as Record<string, unknown>;
      expect(data.phase).toBe("evaluated");
      expect(data.summary).toBeDefined();
    });

    it("confirmed phase — after confirm_decisions", async () => {
      const evalResult = await callTool(h.client, "evaluate_rules", {
        projectDir: h.tmpDir,
        techStack: ["typescript"],
        projectPhase: "early",
        teamSize: "small",
      });
      const evalData = parseResult(evalResult) as Record<string, unknown>;
      const decisions = (evalData.decisions as Array<Record<string, unknown>>).map((d) => ({
        ruleId: d.ruleId,
        recommendedMedium: d.recommendedMedium,
      }));

      await callTool(h.client, "confirm_decisions", {
        projectDir: h.tmpDir,
        decisions,
      });

      const result = await callTool(h.client, "query_state", {
        projectDir: h.tmpDir,
      });
      const data = parseResult(result) as Record<string, unknown>;
      expect(data.phase).toBe("confirmed");
      expect(data.confirmedAt).toBeDefined();
    });

    it("generated phase — after generate_config", async () => {
      const evalResult = await callTool(h.client, "evaluate_rules", {
        projectDir: h.tmpDir,
        techStack: ["typescript"],
        projectPhase: "early",
        teamSize: "small",
      });
      const evalData = parseResult(evalResult) as Record<string, unknown>;
      const decisions = (evalData.decisions as Array<Record<string, unknown>>).map((d) => ({
        ruleId: d.ruleId,
        recommendedMedium: d.recommendedMedium,
      }));

      await callTool(h.client, "confirm_decisions", {
        projectDir: h.tmpDir,
        decisions,
      });

      await callTool(h.client, "generate_config", {
        projectDir: h.tmpDir,
        decisions,
        dryRun: false,
      });

      const result = await callTool(h.client, "query_state", {
        projectDir: h.tmpDir,
      });
      const data = parseResult(result) as Record<string, unknown>;
      expect(data.phase).toBe("generated");
    });

    it("validated phase — after validate_setup", async () => {
      const evalResult = await callTool(h.client, "evaluate_rules", {
        projectDir: h.tmpDir,
        techStack: ["typescript"],
        projectPhase: "early",
        teamSize: "small",
      });
      const evalData = parseResult(evalResult) as Record<string, unknown>;
      const decisions = (evalData.decisions as Array<Record<string, unknown>>).map((d) => ({
        ruleId: d.ruleId,
        recommendedMedium: d.recommendedMedium,
      }));

      await callTool(h.client, "confirm_decisions", {
        projectDir: h.tmpDir,
        decisions,
      });

      const genResult = await callTool(h.client, "generate_config", {
        projectDir: h.tmpDir,
        decisions,
        dryRun: false,
      });
      const genParsed = parseResult(genResult); writeGeneratedFiles(genParsed as any, h.tmpDir);

      await callTool(h.client, "validate_setup", {
        projectDir: h.tmpDir,
      });

      const result = await callTool(h.client, "query_state", {
        projectDir: h.tmpDir,
      });
      const data = parseResult(result) as Record<string, unknown>;
      expect(data.phase).toBe("validated");
      expect(data.validation).toBeDefined();
    });
  });

  describe("shouldAutoTrigger integration", () => {
    let h: TestHarness;

    beforeEach(async () => { h = await createTestHarness(); });
    afterEach(() => { rmSync(h.tmpDir, { recursive: true, force: true }); });

    it("repeatedPattern not returned on first call", async () => {
      const result = await callTool(h.client, "optimize_error_message", {
        projectDir: h.tmpDir,
        ruleId: "no-console-log",
        ruleName: "No Console Log",
        rateAfter: false,
      });
      const data = parseResult(result) as Record<string, unknown>;
      expect(data).toHaveProperty("suggestions");
      expect(data.repeatedPattern).toBeUndefined();
    });

    it("repeatedPattern returned after multiple calls to same ruleId", async () => {
      // Call optimize_error_message twice with same ruleId
      for (let i = 0; i < 2; i++) {
        await callTool(h.client, "optimize_error_message", {
          projectDir: h.tmpDir,
          ruleId: "no-console-log",
          ruleName: "No Console Log",
          rateAfter: false,
        });
      }

      // Third call should trigger repeated pattern detection
      const result = await callTool(h.client, "optimize_error_message", {
        projectDir: h.tmpDir,
        ruleId: "no-console-log",
        ruleName: "No Console Log",
        rateAfter: false,
      });
      const data = parseResult(result) as Record<string, unknown>;
      expect(data.repeatedPattern).toBeDefined();
      expect((data.repeatedPattern as Record<string, unknown>).skillType).toBe("educational");
      expect((data.repeatedPattern as Record<string, unknown>).ruleId).toBe("no-console-log");
    });
  });

  describe("Step 9: rollback", () => {
    let h: TestHarness;

    beforeEach(async () => { h = await createTestHarness(); });
    afterEach(() => { rmSync(h.tmpDir, { recursive: true, force: true }); });

    it("lists available backups", async () => {
      const result = await callTool(h.client, "rollback", {
        projectDir: h.tmpDir,
        list: true,
      });
      const data = parseResult(result) as Record<string, unknown>;
      // No backups yet, so this returns an error
expect(data).toHaveProperty("code");
expect(data.code).toBe("ROLLBACK_FAILED");
    });
  });

  describe("Step 0: assess_suitability edge cases", () => {
    let h: TestHarness;

    beforeEach(async () => { h = await createTestHarness(); });
    afterEach(() => { rmSync(h.tmpDir, { recursive: true, force: true }); });

    it("returns suitable=false for empty directory", async () => {
      const result = await callTool(h.client, "assess_suitability", {
        projectDir: h.tmpDir,
      });
      const data = parseResult(result) as Record<string, unknown>;
      expect(data.suitable).toBe(false);
      expect(data.warnings).toBeDefined();
    });

    it("returns result for both quick and full analysis depth", async () => {
      const quick = await callTool(h.client, "assess_suitability", {
        projectDir: h.tmpDir,
        analysisDepth: "quick",
      });
      const quickData = parseResult(quick) as Record<string, unknown>;
      expect(quickData).toHaveProperty("score");

      const full = await callTool(h.client, "assess_suitability", {
        projectDir: h.tmpDir,
        analysisDepth: "full",
      });
      const fullData = parseResult(full) as Record<string, unknown>;
      expect(fullData).toHaveProperty("score");
    });
  });
});
