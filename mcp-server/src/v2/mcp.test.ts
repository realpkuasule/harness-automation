import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../index.js";

const directories: string[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
describe("v2 MCP transport", () => {
  it("exposes the safe service-layer tools and returns doctor JSON", async () => {
    const server = await createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "v2-test", version: "1.0.0" }, { capabilities: {} });
    clients.push(client);
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "harness_intake",
      "harness_discover",
      "harness_plan",
      "harness_apply",
      "harness_check",
      "harness_rollback",
      "harness_worktree_status",
      "harness_worktree_audit",
      "harness_worktree_configure",
      "harness_worktree_allocate",
      "harness_worktree_adopt",
      "harness_worktree_review",
      "harness_worktree_close",
      "harness_worktree_retention_audit",
      "harness_worktree_integration_check",
    ]));
    expect(tools.tools.find((tool) => tool.name === "harness_intake")?.inputSchema).toMatchObject({
      properties: { approveTypeScriptNamingAdoption: { type: "boolean" } },
    });
    const adoptTool = tools.tools.find((tool) => tool.name === "harness_worktree_adopt");
    expect(adoptTool?.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ["projectDir", "items"],
      properties: {
        items: {
          type: "array",
          minItems: 1,
          items: {
            additionalProperties: false,
            required: ["workItem", "owner", "path", "branch"],
          },
        },
      },
    });
    expect(tools.tools.find((tool) => tool.name === "harness_worktree_integration_check")?.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ["projectDir", "workItem"],
      properties: { target: { type: "string" } },
    });
    const planTool = tools.tools.find((tool) => tool.name === "harness_plan");
    expect(planTool?.inputSchema).toMatchObject({
      properties: {
        profile: { enum: ["full-typescript", "python-data-ai", "go-performance", "custom"] },
        stacks: {
          type: "array",
          maxItems: 16,
          items: {
            type: "string",
            pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
          },
        },
        qualityProfiles: {
          type: "array",
          items: { enum: ["eval-driven-development"] },
        },
        adoptTypeScriptNaming: { type: "boolean" },
      },
    });

    const projectDir = mkdtempSync(join(tmpdir(), "harness-mcp-v2-"));
    directories.push(projectDir);
    const legacy = await client.callTool({
      name: "init_harness",
      arguments: {
        projectDir,
        projectPhase: "early",
        teamSize: "solo",
        techStack: ["typescript"],
        dryRun: true,
      },
    });
    expect(legacy.isError).toBe(true);
    expect((legacy.content[0] as { type: "text"; text: string }).text).toContain("LEGACY_V1_DISABLED");
    const result = await client.callTool({ name: "harness_doctor", arguments: { projectDir } });
    const content = result.content[0] as { type: "text"; text: string };
    expect(JSON.parse(content.text).projectDir).toBe(projectDir);

    execFileSync("git", ["init", "-b", "main"], { cwd: projectDir });
    execFileSync("git", ["config", "user.email", "harness@example.test"], { cwd: projectDir });
    execFileSync("git", ["config", "user.name", "Harness Test"], { cwd: projectDir });
    writeFileSync(join(projectDir, "README.md"), "# fixture\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: projectDir });
    execFileSync("git", ["commit", "-m", "test: initialize fixture"], { cwd: projectDir });
    const configuredResult = await client.callTool({
      name: "harness_worktree_configure",
      arguments: {
        projectDir,
        mode: "enforced",
        managementBranch: "main",
        maxPersistentWorktrees: 2,
        allowedRoots: [tmpdir()],
      },
    });
    const configured = JSON.parse(
      (configuredResult.content[0] as { type: "text"; text: string }).text,
    ) as { planPath: string; planHash: string };
    await client.callTool({
      name: "harness_apply",
      arguments: { projectDir, planPath: configured.planPath, approval: configured.planHash },
    });
    const statusResult = await client.callTool({
      name: "harness_worktree_status",
      arguments: { projectDir },
    });
    expect(JSON.parse(
      (statusResult.content[0] as { type: "text"; text: string }).text,
    )).toMatchObject({ configured: true, config: { mode: "enforced", managementBranch: "main" } });
    const worktreePath = `${projectDir}-mcp-adopt`;
    directories.push(worktreePath);
    execFileSync("git", ["worktree", "add", "-b", "issue-mcp", worktreePath, "HEAD"], {
      cwd: projectDir,
    });
    const adoptedResult = await client.callTool({
      name: "harness_worktree_adopt",
      arguments: {
        projectDir,
        items: [{
          workItem: "github:example/project#401",
          owner: "owner",
          path: worktreePath,
          branch: "issue-mcp",
        }],
      },
    });
    expect(JSON.parse(
      (adoptedResult.content[0] as { type: "text"; text: string }).text,
    )).toMatchObject({ operation: "adopt", planHash: expect.stringMatching(/^[a-f0-9]{64}$/u) });
  });
});
