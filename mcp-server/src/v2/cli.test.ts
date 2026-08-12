import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "../..");
const cli = join(packageRoot, "src/cli.ts");
const projects: string[] = [];

function write(root: string, path: string, content: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}

function run(root: string, args: string[]): Record<string, unknown> {
  const result = spawnSync(process.execPath, ["--import", "tsx", cli, ...args, "--project", root], {
    cwd: packageRoot,
    encoding: "utf8",
    env: { ...process.env, HOME: join(root, ".test-home") },
    timeout: 30_000,
  });
  if (result.status !== 0) throw new Error(`${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

afterEach(() => {
  for (const project of projects.splice(0)) rmSync(project, { recursive: true, force: true });
});
describe("v2 CLI forward flow", () => {
  it("keeps a conventional eval script advisory until EDD is explicitly selected", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-cli-unmanaged-eval-"));
    projects.push(root);
    write(root, "package.json", JSON.stringify({ scripts: {
      evals: "node evals/run.mjs",
      "test:evals": "node evals/run.mjs",
    } }));

    expect(existsSync(join(root, ".test-home"))).toBe(false);
    const doctor = run(root, ["doctor"]);
    expect(existsSync(join(root, ".test-home"))).toBe(false);
    expect(doctor.evaluations).toMatchObject({
      configured: false,
      valid: false,
      unmanagedCandidates: ["npm:.:evals", "npm:.:test:evals"],
    });
    expect(run(root, ["discover"]).evaluations).toMatchObject({
      unmanagedCandidates: ["npm:.:evals", "npm:.:test:evals"],
    });
  });

  it("runs the owner-approved workflow in a fresh process for every step", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-cli-v2-"));
    projects.push(root);
    write(root, "docs/PRD.md", "# Service\n");
    write(root, "docs/design/architecture.md", "# Architecture\n");
    write(root, "docs/research/github.md", "# Evidence\n");
    write(root, "package.json", JSON.stringify({ dependencies: {
      "@nestjs/core": "1", "@prisma/client": "1", "@trpc/server": "1", next: "1", typescript: "1",
    } }));
    write(root, "package-lock.json", "{}\n");
    write(root, "tsconfig.json", "{}\n");
    write(root, "prisma/schema.prisma", "datasource db { provider = \"postgresql\" }\n");
    write(root, "src/service.ts", "export const userId = 1;\n");

    expect(run(root, ["doctor"]).prd).toBe(true);
    run(root, ["intake", "--owner", "owner", "--approve-sources"]);
    expect(run(root, ["discover"]).profile).toBe("full-typescript");
    const planned = run(root, ["plan", "--profile", "full-typescript"]);
    const planPath = String(planned.planPath);
    const planHash = String(planned.planHash);
    const applied = run(root, ["apply", "--plan", planPath, "--approve", planHash]);
    expect(applied.planHash).toBe(planHash);
    expect(run(root, ["context", "--agent", "codex"]).agent).toBe("codex");
    const checked = run(root, ["check", "--mode", "session"]);
    expect(checked.ok).toBe(true);
    expect((run(root, ["explain", "typescript-naming"]).id)).toBe("typescript-naming");
    expect(run(root, ["drift"]).clean).toBe(true);
  }, 30_000);

  it("accepts repeated owner-selected stacks for a custom repository", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-cli-custom-"));
    projects.push(root);
    write(root, "docs/PRD.md", "# Studio\n");
    write(root, "docs/design/architecture.md", "# Vite and Electron\n");
    write(root, "docs/research/github.md", "# Evidence\n");
    write(root, "package.json", JSON.stringify({
      scripts: { build: "vite build" },
      dependencies: { react: "1" },
      devDependencies: { vite: "1" },
    }));
    write(root, "package-lock.json", "{}\n");

    run(root, ["intake", "--owner", "owner", "--approve-sources"]);
    expect(run(root, ["discover"]).profile).toBe("custom");
    const planned = run(root, ["plan", "--profile", "custom", "--stack", "typescript"]);
    expect(planned.stacks).toEqual(["typescript"]);
    const planPath = String(planned.planPath);
    run(root, ["apply", "--plan", planPath, "--approve", String(planned.planHash)]);

    const policy = JSON.parse(readFileSync(join(root, ".harness/policy.yaml"), "utf8")) as {
      project: { stacks: string[] };
      policies: Array<{ id: string }>;
    };
    expect(policy.project.stacks).toEqual(["typescript"]);
    expect(policy.policies.map((item) => item.id)).toContain("typescript-naming");
    expect(JSON.stringify(policy)).not.toMatch(/NestJS|Prisma|tRPC|PostgreSQL/iu);
  }, 30_000);

  it("keeps a C# and Godot repository in the Harness lifecycle", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-cli-csharp-"));
    projects.push(root);
    write(root, "docs/PRD.md", "# Game\n");
    write(root, "docs/design/architecture.md", "# C# deterministic simulation with Godot presentation\n");
    write(root, "docs/research/github.md", "# Evidence\n");
    write(root, "Game.sln", "\n");
    write(root, "src/Game/Game.csproj", "<Project Sdk=\"Microsoft.NET.Sdk\" />\n");
    write(root, "project.godot", "[application]\nconfig/name=\"Game\"\n");

    run(root, ["intake", "--owner", "owner", "--approve-sources"]);
    const discovery = run(root, ["discover"]);
    expect(discovery.stacks).toEqual(["csharp", "godot"]);
    const planned = run(root, [
      "plan",
      "--profile",
      "custom",
      "--stack",
      "csharp",
      "--stack",
      "godot",
    ]);
    expect(planned.stacks).toEqual(["csharp", "godot"]);
    run(root, [
      "apply",
      "--plan",
      String(planned.planPath),
      "--approve",
      String(planned.planHash),
    ]);

    const checked = run(root, ["check", "--mode", "session"]);
    expect(checked.ok).toBe(true);
    expect(checked.stackCoverageComplete).toBe(false);
    expect(checked.stackAdapters).toEqual([
      expect.objectContaining({ stack: "csharp", status: "blocked" }),
      expect.objectContaining({ stack: "godot", status: "blocked" }),
    ]);
  }, 30_000);

  it("runs portable worktree audit without PRD and applies exact-hash configuration", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-cli-worktree-"));
    projects.push(root);
    execFileSync("git", ["init", "-b", "main"], { cwd: root });
    execFileSync("git", ["config", "user.email", "harness@example.test"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Harness Test"], { cwd: root });
    write(root, "README.md", "# fixture\n");
    execFileSync("git", ["add", "README.md"], { cwd: root });
    execFileSync("git", ["commit", "-m", "test: initialize fixture"], { cwd: root });

    expect(run(root, ["worktree", "status"]).configured).toBe(false);
    expect(run(root, ["worktree", "audit"]).passing).toBe(true);
    const planned = run(root, [
      "worktree",
      "configure",
      "--mode",
      "enforced",
      "--management-branch",
      "main",
      "--allow-root",
      join(root, ".."),
    ]);
    expect(planned.operation).toBe("configure");
    run(root, [
      "apply",
      "--plan",
      String(planned.planPath),
      "--approve",
      String(planned.planHash),
    ]);
    expect(run(root, ["worktree", "status"])).toMatchObject({
      configured: true,
      config: { managementBranch: "main" },
    });
  }, 15_000);

  it("plans, applies, and rolls back a batch adoption from one strict manifest", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-cli-adopt-"));
    projects.push(root);
    execFileSync("git", ["init", "-b", "main"], { cwd: root });
    execFileSync("git", ["config", "user.email", "harness@example.test"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Harness Test"], { cwd: root });
    write(root, "README.md", "# fixture\n");
    execFileSync("git", ["add", "README.md"], { cwd: root });
    execFileSync("git", ["commit", "-m", "test: initialize fixture"], { cwd: root });
    const worktreePath = `${root}-legacy`;
    projects.push(worktreePath);
    execFileSync("git", ["worktree", "add", "-b", "issue-legacy", worktreePath, "HEAD"], {
      cwd: root,
    });
    const configured = run(root, [
      "worktree", "configure",
      "--mode", "enforced",
      "--management-branch", "main",
      "--max-persistent", "2",
      "--allow-root", join(root, ".."),
    ]);
    run(root, [
      "apply",
      "--plan", String(configured.planPath),
      "--approve", String(configured.planHash),
    ]);
    write(root, "adopt.json", JSON.stringify({
      schemaVersion: "worktree-adopt/1.0",
      items: [{
        workItem: "github:example/project#101",
        owner: "owner",
        thread: "thread-101",
        path: worktreePath,
        branch: "issue-legacy",
      }],
    }));

    const planned = run(root, ["worktree", "adopt", "--manifest", "adopt.json"]);
    expect(planned.operation).toBe("adopt");
    const applied = run(root, [
      "apply",
      "--plan", String(planned.planPath),
      "--approve", String(planned.planHash),
    ]);
    expect(applied).toMatchObject({ operation: "adopt", status: "applied" });
    expect((run(root, ["worktree", "status"]).leases as unknown[])).toHaveLength(1);
    expect(run(root, ["rollback", "--change", String(applied.id)])).toMatchObject({
      operation: "adopt",
      status: "rolled-back",
    });

    write(root, "invalid-adopt.json", JSON.stringify({
      schemaVersion: "worktree-adopt/1.0",
      items: [{
        workItem: "github:example/project#101",
        owner: "owner",
        path: worktreePath,
        branch: "issue-legacy",
        unexpected: true,
      }],
    }));
    expect(() => run(root, [
      "worktree", "adopt", "--manifest", "invalid-adopt.json",
    ])).toThrow(/WORKTREE_ADOPT_INPUT_INVALID/);
  }, 15_000);

  it("accepts the EDD quality profile and runs its eval only in CI mode", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-cli-eval-"));
    projects.push(root);
    write(root, "docs/PRD.md", "# AI feature\n");
    write(root, "docs/design/architecture.md", "# Architecture\n");
    write(root, "docs/research/github.md", "# Evidence\n");
    write(root, "evals/tasks.jsonl", "{}\n");
    write(root, "evals/baseline.json", "{}\n");
    write(root, "evals/fixtures/known-bad.json", "{}\n");
    write(root, "evals/runner-manifest.json", "{}\n");
    write(root, "evals/evals.json", JSON.stringify({
      schemaVersion: "1.1",
      suites: [{
        id: "cli-quality",
        kind: "regression",
        owner: "owner",
        description: "CLI quality regression.",
        command: ["node", "-e", "process.exit(0)"],
        runnerSources: ["evals/runner-manifest.json"],
        tasks: ["evals/tasks.jsonl"],
        traceability: [{ requirementId: "PRD-AI-004", ruleIds: ["cli-quality-gate"] }],
        baseline: { origin: "adoption", score: 1, trials: 1, evidence: "evals/baseline.json" },
        target: { metric: "pass-at-1", threshold: 1, trials: 1 },
        graders: [{ id: "tests", kind: "code", role: "gate" }],
        negativeControl: {
          command: ["node", "-e", "process.exit(1)"],
          fixture: "evals/fixtures/known-bad.json",
          expectedExitCode: 1,
        },
      }],
    }));

    run(root, ["intake", "--owner", "owner", "--approve-sources"]);
    run(root, ["discover"]);
    const planned = run(root, [
      "plan",
      "--profile", "custom",
      "--stack", "typescript",
      "--quality-profile", "eval-driven-development",
    ]);
    expect(planned.qualityProfiles).toEqual(["eval-driven-development"]);
    run(root, ["apply", "--plan", String(planned.planPath), "--approve", String(planned.planHash)]);

    expect(run(root, ["check", "--mode", "session"]).evaluations).toMatchObject({ status: "not-run" });
    expect(run(root, ["check", "--mode", "ci"]).evaluations).toMatchObject({ status: "verified" });
  });
});
