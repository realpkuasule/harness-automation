import { mkdtempSync, rmSync } from "node:fs";
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
      "harness_worktree_review",
      "harness_worktree_close",
      "harness_worktree_retention_audit",
    ]));
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
      },
    });

    const projectDir = mkdtempSync(join(tmpdir(), "harness-mcp-v2-"));
    directories.push(projectDir);
    const result = await client.callTool({ name: "harness_doctor", arguments: { projectDir } });
    const content = result.content[0] as { type: "text"; text: string };
    expect(JSON.parse(content.text).projectDir).toBe(projectDir);
  });
});
