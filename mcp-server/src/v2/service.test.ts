import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverProject } from "./discovery.js";
import {
  applyPlan,
  checkProject,
  doctorProject,
  driftProject,
  intakeProject,
  planProject,
  researchGitHub,
  rollbackChange,
  hasExecutableFileHeader,
  runTrustedChecks,
} from "./service.js";
import { planWorkspaceConfiguration } from "../worktree/service.js";

const roots: string[] = [];

function temporaryProject(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-v2-"));
  roots.push(root);
  return root;
}

function write(root: string, path: string, content: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}

function approvedSources(root: string): void {
  write(root, "docs/PRD.md", "# Product\n\nBuild a stable team service.\n");
  write(root, "docs/design/architecture.md", "# Architecture\n\nContracts are schema-first.\n");
  write(root, "docs/research/github.md", "# Research\n\nCandidate evidence.\n");
}

function fullTypeScriptProject(root: string): void {
  approvedSources(root);
  write(root, "package.json", JSON.stringify({
    scripts: { test: "vitest run" },
    dependencies: {
      "@nestjs/core": "1.0.0",
      "@prisma/client": "1.0.0",
      "@trpc/server": "1.0.0",
      next: "1.0.0",
      typescript: "1.0.0",
    },
  }));
  write(root, "package-lock.json", "{}\n");
  write(root, "tsconfig.json", "{}\n");
  write(root, "prisma/schema.prisma", "datasource db { provider = \"postgresql\" }\n");
  write(root, "src/userService.ts", "export const userId = 1;\nexport class UserService {}\n");
}

function evaluationContract(root: string, exitCode = 0): void {
  write(root, "evals/tasks.jsonl", "{\"id\":\"representative-task\"}\n");
  write(root, "evals/baselines/initial.json", "{\"score\":0}\n");
  write(root, "evals/evals.json", JSON.stringify({
    schemaVersion: "1.0",
    suites: [{
      id: "representative-quality",
      kind: "capability",
      owner: "owner",
      description: "Representative project behavior.",
      command: ["node", "-e", `process.exit(${exitCode})`],
      tasks: ["evals/tasks.jsonl"],
      baseline: { score: 0, trials: 1, evidence: "evals/baselines/initial.json" },
      target: { metric: "pass-at-1", threshold: 1, trials: 1 },
      graders: [{ id: "outcome-test", kind: "code", role: "gate" }],
    }],
  }));
}

function hardenedEvaluationContract(root: string, positiveExitCode = 0, negativeExitCode = 1): void {
  write(root, "evals/tasks.jsonl", "{\"id\":\"representative-task\"}\n");
  write(root, "evals/baselines/adoption.json", "{\"score\":0}\n");
  write(root, "evals/fixtures/known-bad.json", "{\"bad\":true}\n");
  write(root, "evals/runner-manifest.json", "{\"runner\":\"node\"}\n");
  write(root, "evals/evals.json", JSON.stringify({
    schemaVersion: "1.1",
    suites: [{
      id: "representative-quality",
      kind: "capability",
      owner: "owner",
      description: "Representative project behavior.",
      command: ["node", "-e", `process.exit(${positiveExitCode})`],
      runnerSources: ["evals/runner-manifest.json"],
      tasks: ["evals/tasks.jsonl"],
      traceability: [{ requirementId: "PRD-AI-004", ruleIds: ["representative-quality-gate"] }],
      baseline: { origin: "adoption", score: 0, trials: 1, evidence: "evals/baselines/adoption.json" },
      target: { metric: "pass-at-1", threshold: 1, trials: 1 },
      graders: [{ id: "outcome-test", kind: "code", role: "gate" }],
      negativeControl: {
        command: ["node", "-e", `process.exit(${negativeExitCode})`],
        fixture: "evals/fixtures/known-bad.json",
        expectedExitCode: 1,
      },
    }],
  }));
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("v2 stack discovery", () => {
  it("recognizes the three supported architecture profiles", () => {
    const ts = temporaryProject();
    fullTypeScriptProject(ts);
    expect(discoverProject(ts).profile).toBe("full-typescript");

    const python = temporaryProject();
    approvedSources(python);
    write(python, "manage.py", "#!/usr/bin/env python3\n");
    write(python, "requirements.txt", "Django\npydantic\ncelery\npsycopg\n");
    write(python, "frontend/package.json", JSON.stringify({ dependencies: { typescript: "1", react: "1" } }));
    write(python, "package-lock.json", "{}\n");
    expect(discoverProject(python).profile).toBe("python-data-ai");

    const go = temporaryProject();
    approvedSources(go);
    write(go, "go.mod", "module example.com/service\n\ngo 1.22\n");
    write(go, "sqlc.yaml", "version: '2'\n");
    write(go, "api/service.proto", "syntax = \"proto3\";\n");
    write(go, "web/package.json", JSON.stringify({ dependencies: { typescript: "1" } }));
    write(go, "package-lock.json", "{}\n");
    expect(discoverProject(go).profile).toBe("go-performance");
  });

  it("detects C# and Godot without pretending they have built-in adapters", () => {
    const root = temporaryProject();
    approvedSources(root);
    write(root, "Game.sln", "\n");
    write(root, "src/Game/Game.csproj", "<Project Sdk=\"Microsoft.NET.Sdk\" />\n");
    write(root, "project.godot", "[application]\nconfig/name=\"Game\"\n");

    const discovery = discoverProject(root);

    expect(discovery.profile).toBe("custom");
    expect(discovery.stacks).toEqual(["csharp", "godot"]);
    expect(discovery.manifests).toEqual(expect.arrayContaining([
      "Game.sln",
      "src/Game/Game.csproj",
      "project.godot",
    ]));
    expect(discovery.commands["dotnet:build"]).toEqual([
      "dotnet",
      "build",
      "Game.sln",
      "--no-restore",
    ]);
    expect(discovery.warnings.join("\n")).toMatch(/No built-in stack adapter for: csharp, godot/);
  });
});

describe("path command headers", () => {
  it.each([
    ["shebang", [0x23, 0x21, 0x2f, 0x62]],
    ["ELF", [0x7f, 0x45, 0x4c, 0x46]],
    ["Mach-O 32", [0xfe, 0xed, 0xfa, 0xce]],
    ["Mach-O 64", [0xcf, 0xfa, 0xed, 0xfe]],
    ["Mach-O fat", [0xca, 0xfe, 0xba, 0xbe]],
    ["PE", [0x4d, 0x5a, 0x90, 0x00]],
  ])("accepts a recognized %s header", (_name, bytes) => {
    expect(hasExecutableFileHeader(Uint8Array.from(bytes))).toBe(true);
  });

  it("rejects a non-executable text header", () => {
    expect(hasExecutableFileHeader(Uint8Array.from([0x6e, 0x6f, 0x70, 0x65]))).toBe(false);
  });
});

describe("v2 custom stack planning", () => {
  it("compiles only owner-selected stack rules without preset-only frameworks", () => {
    const root = temporaryProject();
    approvedSources(root);
    write(root, "package.json", JSON.stringify({
      scripts: { build: "vite build" },
      dependencies: { react: "1.0.0" },
      devDependencies: { vite: "1.0.0" },
    }));
    write(root, "package-lock.json", "{}\n");

    intakeProject({ projectRoot: root, owner: "owner", approveSources: true });
    const discovery = discoverProject(root);
    expect(discovery.profile).toBe("custom");
    expect(discovery.stacks).toEqual([]);
    write(root, ".harness/discovery.json", `${JSON.stringify(discovery, null, 2)}\n`);

    const { plan, policy } = planProject({
      projectRoot: root,
      profile: "custom",
      stacks: ["typescript"],
      now: new Date("2026-01-01T00:00:00Z"),
    });

    expect(policy.project.stacks).toEqual(["typescript"]);
    expect(policy.policies.map((item) => item.id)).toContain("typescript-naming");
    expect(policy.policies.map((item) => item.id)).not.toContain("typescript-boundary-naming");
    expect(JSON.stringify(policy)).not.toMatch(/NestJS|Prisma|tRPC|PostgreSQL/iu);
    expect(plan.commands.flat()).not.toContain("node_modules/.bin/prisma");
    expect(plan.warnings).toContain("Owner-selected stack not observed during discovery: typescript");
  });

  it("requires an explicit stack when a custom repository has no observed stack", () => {
    const root = temporaryProject();
    approvedSources(root);
    write(root, "package.json", JSON.stringify({ dependencies: { react: "1.0.0" } }));
    write(root, "package-lock.json", "{}\n");
    intakeProject({ projectRoot: root, owner: "owner", approveSources: true });
    const discovery = discoverProject(root);
    write(root, ".harness/discovery.json", `${JSON.stringify(discovery, null, 2)}\n`);

    expect(() => planProject({ projectRoot: root, profile: "custom" }))
      .toThrow(/STACK_SELECTION_REQUIRED/);
    expect(() => planProject({
      projectRoot: root,
      profile: "custom",
      stacks: ["C#"],
    })).toThrow(/INVALID_STACK/);
  });

  it("rejects stack overrides on complete presets", () => {
    const root = temporaryProject();
    fullTypeScriptProject(root);
    intakeProject({ projectRoot: root, owner: "owner", approveSources: true });
    const discovery = discoverProject(root);
    write(root, ".harness/discovery.json", `${JSON.stringify(discovery, null, 2)}\n`);

    expect(() => planProject({
      projectRoot: root,
      profile: "full-typescript",
      stacks: ["typescript"],
    })).toThrow(/STACK_OVERRIDE_REQUIRES_CUSTOM_PROFILE/);
  });

  it("keeps unsupported stacks inside the approved plan/apply/check lifecycle", () => {
    const root = temporaryProject();
    approvedSources(root);
    write(root, "package.json", JSON.stringify({
      scripts: {
        "governance:check": "node tools/verify-governance.mjs",
        "test:contracts": "node --test tools/tests/contracts.test.mjs",
        "verify:contracts": "node tools/verify-contracts.mjs",
      },
    }));

    intakeProject({ projectRoot: root, owner: "owner", approveSources: true });
    const discovery = discoverProject(root);
    expect(discovery.stacks).toEqual([]);
    write(root, ".harness/discovery.json", `${JSON.stringify(discovery, null, 2)}\n`);
    const { plan, path, policy } = planProject({
      projectRoot: root,
      profile: "custom",
      stacks: ["csharp", "godot"],
      now: new Date("2026-01-01T00:00:00Z"),
    });

    expect(policy.project.stacks).toEqual(["csharp", "godot"]);
    expect(policy.policies.map((item) => item.id)).toEqual([
      "single-implementation-owner",
      "contract-first-change",
      "generated-files-immutable",
    ]);
    expect(plan.warnings).toEqual(expect.arrayContaining([
      "Owner-selected stack not observed during discovery: csharp",
      "Owner-selected stack not observed during discovery: godot",
      "Stack-specific enforcement blocked for 'csharp': no built-in adapter; generic continuity policies will still be applied.",
      "Stack-specific enforcement blocked for 'godot': no built-in adapter; generic continuity policies will still be applied.",
    ]));
    expect(plan.commands).toEqual(expect.arrayContaining([
      ["npm", "run", "governance:check"],
      ["npm", "run", "test:contracts"],
      ["npm", "run", "verify:contracts"],
    ]));

    applyPlan({ projectRoot: root, planPath: path, approval: plan.planHash });
    const checked = checkProject(root);
    expect(checked.ok).toBe(true);
    expect(checked.stackCoverageComplete).toBe(false);
    expect(checked.stackAdapters).toEqual([
      expect.objectContaining({ stack: "csharp", support: "none", status: "blocked" }),
      expect.objectContaining({ stack: "godot", support: "none", status: "blocked" }),
    ]);
    expect(readFileSync(join(root, ".harness/generated/effective-policy.md"), "utf8"))
      .toContain("generic policies apply and stack-specific enforcement is blocked");
  });

  it("keeps delivery and domain profiles orthogonal to stack selection", () => {
    const root = temporaryProject();
    approvedSources(root);
    write(root, "package.json", JSON.stringify({ dependencies: { react: "1.0.0" } }));
    write(root, "package-lock.json", "{}\n");
    intakeProject({ projectRoot: root, owner: "owner", approveSources: true });
    const discovery = discoverProject(root);
    write(root, ".harness/discovery.json", `${JSON.stringify(discovery, null, 2)}\n`);

    const { policy } = planProject({
      projectRoot: root,
      profile: "custom",
      stacks: ["typescript"],
      deliveryProfiles: ["worktree-delivery"],
      domainProfiles: ["game-development"],
    });

    expect(policy.project.stacks).toEqual(["typescript"]);
    expect(policy.project.deliveryProfiles).toEqual(["worktree-delivery"]);
    expect(policy.project.domainProfiles).toEqual(["game-development"]);
    expect(policy.policies.map((item) => item.id)).toEqual(expect.arrayContaining([
      "worktree-delivery-gate",
      "game-deterministic-replay",
      "game-real-engine-smoke",
      "game-target-performance",
      "game-content-provenance",
    ]));
  });

  it("keeps the EDD quality profile orthogonal and requires an approved eval contract", () => {
    const missing = temporaryProject();
    approvedSources(missing);
    intakeProject({ projectRoot: missing, owner: "owner", approveSources: true });
    write(missing, ".harness/discovery.json", `${JSON.stringify(discoverProject(missing), null, 2)}\n`);
    expect(() => planProject({
      projectRoot: missing,
      profile: "custom",
      stacks: ["typescript"],
      qualityProfiles: ["eval-driven-development"],
    })).toThrow(/EVAL_CONTRACT_REQUIRED/);
    expect(() => planProject({
      projectRoot: missing,
      profile: "custom",
      stacks: ["typescript"],
      qualityProfiles: ["unknown" as "eval-driven-development"],
    })).toThrow(/INVALID_QUALITY_PROFILE/);

    const root = temporaryProject();
    approvedSources(root);
    evaluationContract(root);
    intakeProject({ projectRoot: root, owner: "owner", approveSources: true });
    const discovery = discoverProject(root);
    write(root, ".harness/discovery.json", `${JSON.stringify(discovery, null, 2)}\n`);

    const { path, plan, policy } = planProject({
      projectRoot: root,
      profile: "custom",
      stacks: ["typescript"],
      deliveryProfiles: ["worktree-delivery"],
      domainProfiles: ["game-development"],
      qualityProfiles: ["eval-driven-development"],
    });

    expect(policy.project).toMatchObject({
      stacks: ["typescript"],
      deliveryProfiles: ["worktree-delivery"],
      domainProfiles: ["game-development"],
      qualityProfiles: ["eval-driven-development"],
    });
    expect(policy.policies.map((item) => item.id)).toEqual(expect.arrayContaining([
      "eval-contract-before-implementation",
      "eval-regression-gate",
      "eval-evidence-provenance",
      "eval-judge-calibration",
    ]));
    expect(discovery.commands["eval:representative-quality"])
      .toEqual(["node", "-e", "process.exit(0)"]);

    write(root, "evals/tasks.jsonl", "{\"changed\":true}\n");
    expect(() => applyPlan({ projectRoot: root, planPath: path, approval: plan.planHash }))
      .toThrow(/STALE_PRECONDITION/);
  });
});

describe("v2 GitHub research evidence", () => {
  it("records deterministic queries and candidate metadata under docs/research", () => {
    const root = temporaryProject();
    write(root, "docs/PRD.md", "# Search\n");
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    write(root, "bin/gh", `#!/usr/bin/env sh
printf '%s' '{"items":[{"full_name":"example/wheel","html_url":"https://github.com/example/wheel","description":"candidate","license":{"spdx_id":"MIT"},"stargazers_count":42,"updated_at":"2026-01-01T00:00:00Z"}]}'
`);
    chmodSync(join(bin, "gh"), 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    try {
      const result = researchGitHub({ projectRoot: root, queries: ["schema library"], now: new Date("2026-01-02T00:00:00Z") });
      expect(result.candidates[0].fullName).toBe("example/wheel");
      expect(readFileSync(join(root, result.report), "utf8")).toContain("Stars (signal only)");
      expect(JSON.parse(readFileSync(join(root, result.index), "utf8")).queries).toEqual(["schema library"]);
    } finally {
      process.env.PATH = previousPath;
    }
  });
});

describe("v2 plan/apply/check/rollback", () => {
  it("is hash-approved, idempotent, preserves unmanaged content, and rolls back nested files byte-for-byte", () => {
    const root = temporaryProject();
    fullTypeScriptProject(root);
    write(root, "AGENTS.md", "# Existing project instructions\n\nKeep this paragraph.\n");
    write(root, ".harness/generated/effective-policy.md", "original nested content\n");

    intakeProject({ projectRoot: root, owner: "owner@example", approveSources: true, now: new Date("2026-01-01T00:00:00Z") });
    const discovery = discoverProject(root, new Date("2026-01-01T00:00:01Z"));
    write(root, ".harness/discovery.json", `${JSON.stringify(discovery, null, 2)}\n`);
    const first = planProject({ projectRoot: root, now: new Date("2026-01-01T00:00:02Z") });
    const second = planProject({ projectRoot: root, now: new Date("2026-01-01T00:00:02Z") });
    expect(second.plan.planHash).toBe(first.plan.planHash);

    const change = applyPlan({ projectRoot: root, planPath: first.path, approval: first.plan.planHash, now: new Date("2026-01-01T00:00:03Z") });
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain("Keep this paragraph.");
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain("harness-automation:v2:start");
    expect(driftProject(root).clean).toBe(true);
    expect(checkProject(root).ok).toBe(true);

    const reapplied = applyPlan({ projectRoot: root, planPath: first.path, approval: first.plan.planHash });
    expect(reapplied.id).toBe(change.id);

    rollbackChange({ projectRoot: root, changeId: change.id, now: new Date("2026-01-01T00:00:04Z") });
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe("# Existing project instructions\n\nKeep this paragraph.\n");
    expect(readFileSync(join(root, ".harness/generated/effective-policy.md"), "utf8")).toBe("original nested content\n");
  });

  it("rejects stale source and target preconditions", () => {
    const sourceRoot = temporaryProject();
    fullTypeScriptProject(sourceRoot);
    intakeProject({ projectRoot: sourceRoot, owner: "owner", approveSources: true });
    const sourceDiscovery = discoverProject(sourceRoot);
    write(sourceRoot, ".harness/discovery.json", `${JSON.stringify(sourceDiscovery, null, 2)}\n`);
    const sourcePlan = planProject({ projectRoot: sourceRoot });
    write(sourceRoot, "docs/PRD.md", "# Changed after approval\n");
    expect(() => applyPlan({ projectRoot: sourceRoot, planPath: sourcePlan.path, approval: sourcePlan.plan.planHash })).toThrow(/STALE_PRECONDITION/);

    const targetRoot = temporaryProject();
    fullTypeScriptProject(targetRoot);
    write(targetRoot, "AGENTS.md", "before\n");
    intakeProject({ projectRoot: targetRoot, owner: "owner", approveSources: true });
    const targetDiscovery = discoverProject(targetRoot);
    write(targetRoot, ".harness/discovery.json", `${JSON.stringify(targetDiscovery, null, 2)}\n`);
    const targetPlan = planProject({ projectRoot: targetRoot });
    write(targetRoot, "AGENTS.md", "changed by another session\n");
    expect(() => applyPlan({ projectRoot: targetRoot, planPath: targetPlan.path, approval: targetPlan.plan.planHash })).toThrow(/STALE_PRECONDITION/);
  });

  it("self-tests the Python and Go AST adapters during apply", () => {
    const python = temporaryProject();
    approvedSources(python);
    write(python, "manage.py", "#!/usr/bin/env python3\nfrom pathlib import Path\nBASE_DIR = Path(__file__).parent\n");
    write(python, "requirements.txt", "Django\npydantic\ncelery\npsycopg\n");
    write(python, "frontend/package.json", JSON.stringify({ dependencies: { typescript: "1", react: "1" } }));
    write(python, "package-lock.json", "{}\n");
    intakeProject({ projectRoot: python, owner: "owner", approveSources: true });
    const pythonDiscovery = discoverProject(python);
    write(python, ".harness/discovery.json", `${JSON.stringify(pythonDiscovery, null, 2)}\n`);
    const pythonPlan = planProject({ projectRoot: python });
    applyPlan({ projectRoot: python, planPath: pythonPlan.path, approval: pythonPlan.plan.planHash });
    expect(checkProject(python).results.find((item) => item.id === "python-naming")?.status).toBe("verified");

    const go = temporaryProject();
    approvedSources(go);
    write(go, "go.mod", "module example.com/service\n\ngo 1.22\n");
    write(go, "sqlc.yaml", "version: '2'\n");
    write(go, "api/service.proto", "syntax = \"proto3\";\n");
    write(go, "web/package.json", JSON.stringify({ dependencies: { typescript: "1" } }));
    write(go, "package-lock.json", "{}\n");
    write(go, "service.go", "package service\n\nvar userID string\n");
    intakeProject({ projectRoot: go, owner: "owner", approveSources: true });
    const goDiscovery = discoverProject(go);
    write(go, ".harness/discovery.json", `${JSON.stringify(goDiscovery, null, 2)}\n`);
    const goPlan = planProject({ projectRoot: go });
    applyPlan({ projectRoot: go, planPath: goPlan.path, approval: goPlan.plan.planHash });
    expect(checkProject(go).results.find((item) => item.id === "go-naming")?.status).toBe("verified");
  }, 30_000);

  it("restores every target when post-apply enforcement fails", () => {
    const root = temporaryProject();
    fullTypeScriptProject(root);
    write(root, "src/invalid.ts", "export const user_id = 1;\n");
    write(root, "AGENTS.md", "original instructions\n");
    intakeProject({ projectRoot: root, owner: "owner", approveSources: true });
    const discovery = discoverProject(root);
    write(root, ".harness/discovery.json", `${JSON.stringify(discovery, null, 2)}\n`);
    const planned = planProject({ projectRoot: root });
    expect(() => applyPlan({ projectRoot: root, planPath: planned.path, approval: planned.plan.planHash })).toThrow(/POST_APPLY_VERIFICATION_FAILED/);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe("original instructions\n");
    expect(() => readFileSync(join(root, ".harness/policy.yaml"), "utf8")).toThrow();
  });

  it("rejects symlinked write targets", () => {
    const root = temporaryProject();
    fullTypeScriptProject(root);
    write(root, "real-agents.md", "outside managed target\n");
    symlinkSync(join(root, "real-agents.md"), join(root, "AGENTS.md"));
    intakeProject({ projectRoot: root, owner: "owner", approveSources: true });
    const discovery = discoverProject(root);
    write(root, ".harness/discovery.json", `${JSON.stringify(discovery, null, 2)}\n`);
    expect(() => planProject({ projectRoot: root })).toThrow(/SYMLINK_TARGET_REJECTED/);
  });

  it("includes the local workspace gate in session checks and reports CI visibility honestly", () => {
    const root = temporaryProject();
    fullTypeScriptProject(root);
    execFileSync("git", ["init", "-b", "main"], { cwd: root });
    execFileSync("git", ["config", "user.email", "harness@example.test"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Harness Test"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-m", "test: initialize fixture"], { cwd: root });
    intakeProject({ projectRoot: root, owner: "owner", approveSources: true });
    const discovery = discoverProject(root);
    write(root, ".harness/discovery.json", `${JSON.stringify(discovery, null, 2)}\n`);
    const policyPlan = planProject({ projectRoot: root });
    applyPlan({
      projectRoot: root,
      planPath: policyPlan.path,
      approval: policyPlan.plan.planHash,
    });
    const workspacePlan = planWorkspaceConfiguration({
      projectRoot: root,
      mode: "enforced",
      managementBranch: "main",
      allowedRoots: [join(root, "..")],
    });
    applyPlan({
      projectRoot: root,
      planPath: workspacePlan.path,
      approval: workspacePlan.plan.planHash,
    });

    const previousCi = process.env.CI;
    try {
      delete process.env.CI;
      const local = runTrustedChecks({ projectRoot: root, mode: "session" });
      expect(local.ok).toBe(true);
      expect(local.workspace).toMatchObject({
        configured: true,
        available: true,
        status: "verified",
      });

      process.env.CI = "1";
      const ci = runTrustedChecks({ projectRoot: root, mode: "session" });
      expect(ci.ok).toBe(true);
      expect(ci.workspace).toMatchObject({
        configured: true,
        available: false,
        status: "blocked",
      });
    } finally {
      if (previousCi === undefined) delete process.env.CI;
      else process.env.CI = previousCi;
    }
  });

  it("runs approved eval suites only in CI mode and writes a hash-only receipt", () => {
    const root = temporaryProject();
    approvedSources(root);
    hardenedEvaluationContract(root);
    intakeProject({ projectRoot: root, owner: "owner", approveSources: true });
    write(root, ".harness/discovery.json", `${JSON.stringify(discoverProject(root), null, 2)}\n`);
    const planned = planProject({
      projectRoot: root,
      profile: "custom",
      stacks: ["typescript"],
      qualityProfiles: ["eval-driven-development"],
    });
    expect(planned.plan.commands).toEqual(expect.arrayContaining([
      ["node", "-e", "process.exit(0)"],
      ["node", "-e", "process.exit(1)"],
    ]));
    applyPlan({ projectRoot: root, planPath: planned.path, approval: planned.plan.planHash });

    expect(runTrustedChecks({ projectRoot: root, mode: "session" }).evaluations.status).toBe("not-run");
    expect(runTrustedChecks({ projectRoot: root, mode: "commit" }).commands)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "eval:representative-quality" })]));

    const ci = runTrustedChecks({
      projectRoot: root,
      mode: "ci",
      now: new Date("2026-08-09T00:00:00Z"),
    });
    expect(ci.ok).toBe(true);
    expect(ci.commands).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "eval:representative-quality" }),
      expect.objectContaining({ id: "eval-negative:representative-quality" }),
    ]));
    expect(ci.evaluations).toMatchObject({
      configured: true,
      loaded: true,
      enforced: true,
      passing: true,
      status: "verified",
      receiptPath: ".harness/eval-runs/2026-08-09T00-00-00-000Z.json",
    });
    const receipt = JSON.parse(readFileSync(join(root, String(ci.evaluations.receiptPath)), "utf8"));
    expect(receipt.receiptHash).toBe(ci.evaluations.receiptHash);
    expect(receipt.suites[0]).toMatchObject({
      baselineOrigin: "adoption",
      requirementIds: ["PRD-AI-004"],
      ruleIds: ["representative-quality-gate"],
      positive: { command: ["node", "-e", "process.exit(0)"], status: "passed", exitCode: 0 },
      negative: { command: ["node", "-e", "process.exit(1)"], status: "passed", exitCode: 1 },
    });
    expect(JSON.stringify(receipt)).not.toContain("stdout");
    expect(JSON.stringify(receipt)).not.toContain("stderr");
  });

  it("fails the CI gate and records evidence when an approved eval runner fails", () => {
    const root = temporaryProject();
    approvedSources(root);
    hardenedEvaluationContract(root, 7);
    intakeProject({ projectRoot: root, owner: "owner", approveSources: true });
    write(root, ".harness/discovery.json", `${JSON.stringify(discoverProject(root), null, 2)}\n`);
    const planned = planProject({
      projectRoot: root,
      profile: "custom",
      stacks: ["typescript"],
      qualityProfiles: ["eval-driven-development"],
    });
    applyPlan({ projectRoot: root, planPath: planned.path, approval: planned.plan.planHash });

    const ci = runTrustedChecks({ projectRoot: root, mode: "ci" });
    expect(ci.ok).toBe(false);
    expect(ci.evaluations.status).toBe("failing");
    expect(ci.evaluations).toMatchObject({ enforced: true, passing: false });
    expect(ci.policy.results.find((item) => item.id === "eval-regression-gate"))
      .toMatchObject({ status: "failing", enforced: true, passing: false });
    expect(ci.evaluations.receiptHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.each([
    [0, 1, "verified", true, true, true],
    [7, 1, "failing", true, false, false],
    [0, 0, "failing", false, true, false],
    [0, 7, "failing", false, true, false],
  ])("separates positive passing from negative enforcement (%i, %i)", (
    positiveExitCode,
    negativeExitCode,
    status,
    enforced,
    passing,
    ok,
  ) => {
    const root = temporaryProject();
    approvedSources(root);
    hardenedEvaluationContract(root, positiveExitCode, negativeExitCode);
    intakeProject({ projectRoot: root, owner: "owner", approveSources: true });
    write(root, ".harness/discovery.json", `${JSON.stringify(discoverProject(root), null, 2)}\n`);
    const planned = planProject({ projectRoot: root, profile: "custom", stacks: ["typescript"], qualityProfiles: ["eval-driven-development"] });
    applyPlan({ projectRoot: root, planPath: planned.path, approval: planned.plan.planHash });

    const ci = runTrustedChecks({ projectRoot: root, mode: "ci" });
    expect(ci.ok).toBe(ok);
    expect(ci.evaluations).toMatchObject({ status, enforced, passing });
    expect(ci.policy.results.find((item) => item.id === "eval-regression-gate"))
      .toMatchObject({ status, enforced, passing });
  });

  it.each([0, 7])("allows a legacy positive runner to run but never claim enforcement (exit %i)", (exitCode) => {
    const root = temporaryProject();
    approvedSources(root);
    evaluationContract(root, exitCode);
    const legacy = JSON.parse(readFileSync(join(root, "evals/evals.json"), "utf8"));
    legacy.suites[0].baseline.origin = "adoption";
    legacy.suites[0].runnerSources = ["package.json"];
    legacy.suites[0].traceability = [{ requirementId: "PRD-AI-004", ruleIds: ["representative-quality-gate"] }];
    legacy.suites[0].negativeControl = {
      command: ["node", "-e", "process.exit(1)"], fixture: "evals/fixtures/known-bad.json", expectedExitCode: 1,
    };
    write(root, "package.json", "{}\n");
    write(root, "evals/fixtures/known-bad.json", "{}\n");
    write(root, "evals/evals.json", JSON.stringify(legacy));
    intakeProject({ projectRoot: root, owner: "owner", approveSources: true });
    write(root, ".harness/discovery.json", `${JSON.stringify(discoverProject(root), null, 2)}\n`);
    const planned = planProject({ projectRoot: root, profile: "custom", stacks: ["typescript"], qualityProfiles: ["eval-driven-development"] });
    applyPlan({ projectRoot: root, planPath: planned.path, approval: planned.plan.planHash });

    const ci = runTrustedChecks({ projectRoot: root, mode: "ci" });
    expect(ci.ok).toBe(false);
    expect(ci.evaluations).toMatchObject({ status: "blocked", passing: exitCode === 0, enforced: false });
  });

  it.each([
    ["traceability", "evals/evals.json", "traceability"],
    ["adoption evidence", "evals/baselines/adoption.json", "changed"],
    ["negative fixture", "evals/fixtures/known-bad.json", "changed"],
    ["runner manifest", "evals/runner-manifest.json", "changed"],
  ])("blocks CI before executing evals when approved %s drift", (_name, path, changed) => {
    const root = temporaryProject();
    approvedSources(root);
    hardenedEvaluationContract(root);
    intakeProject({ projectRoot: root, owner: "owner", approveSources: true });
    write(root, ".harness/discovery.json", `${JSON.stringify(discoverProject(root), null, 2)}\n`);
    const planned = planProject({ projectRoot: root, profile: "custom", stacks: ["typescript"], qualityProfiles: ["eval-driven-development"] });
    applyPlan({ projectRoot: root, planPath: planned.path, approval: planned.plan.planHash });
    const original = readFileSync(join(root, path), "utf8");
    write(root, path, path.endsWith("evals.json") ? original.replace("PRD-AI-004", "PRD-AI-999") : changed);

    expect(() => applyPlan({ projectRoot: root, planPath: planned.path, approval: planned.plan.planHash }))
      .toThrow(/STALE_PRECONDITION/);
    const ci = runTrustedChecks({ projectRoot: root, mode: "ci" });
    expect(ci.evaluations).toMatchObject({ status: "blocked", receiptPath: null, receiptHash: null });
  });

  it("fails preflight before an unapproved eval can trigger an overlapping ordinary CI command", () => {
    const root = temporaryProject();
    approvedSources(root);
    write(root, "package.json", JSON.stringify({ scripts: {
      test: "node -e \"require('node:fs').appendFileSync('preflight-marker.txt', 'x')\"",
    } }));
    hardenedEvaluationContract(root);
    intakeProject({ projectRoot: root, owner: "owner", approveSources: true });
    write(root, ".harness/discovery.json", `${JSON.stringify(discoverProject(root), null, 2)}\n`);
    const planned = planProject({ projectRoot: root, profile: "custom", stacks: ["typescript"], qualityProfiles: ["eval-driven-development"] });
    applyPlan({ projectRoot: root, planPath: planned.path, approval: planned.plan.planHash });
    const contract = JSON.parse(readFileSync(join(root, "evals/evals.json"), "utf8"));
    contract.suites[0].command = ["npm", "run", "test"];
    write(root, "evals/evals.json", JSON.stringify(contract));

    const ci = runTrustedChecks({ projectRoot: root, mode: "ci" });
    expect(ci.commands).toEqual([]);
    expect(ci.evaluations).toMatchObject({ status: "blocked", available: false });
    expect(() => readFileSync(join(root, "preflight-marker.txt"), "utf8")).toThrow();
  });

  it("fails source-set preflight for a newly added eval file before ordinary CI commands run", () => {
    const root = temporaryProject();
    approvedSources(root);
    write(root, "package.json", JSON.stringify({ scripts: {
      test: "node -e \"require('node:fs').appendFileSync('source-set-marker.txt', 'x')\"",
    } }));
    hardenedEvaluationContract(root);
    intakeProject({ projectRoot: root, owner: "owner", approveSources: true });
    write(root, ".harness/discovery.json", `${JSON.stringify(discoverProject(root), null, 2)}\n`);
    const planned = planProject({ projectRoot: root, profile: "custom", stacks: ["typescript"], qualityProfiles: ["eval-driven-development"] });
    applyPlan({ projectRoot: root, planPath: planned.path, approval: planned.plan.planHash });
    write(root, "evals/unapproved-marker.mjs", "throw new Error('must not execute');\n");

    const ci = runTrustedChecks({ projectRoot: root, mode: "ci" });
    expect(ci.commands).toEqual([]);
    expect(ci.evaluations).toMatchObject({ status: "blocked", available: false });
    expect(() => readFileSync(join(root, "source-set-marker.txt"), "utf8")).toThrow();
  });

  it.each(["package.json", "scripts/external-eval-runner.mjs"])("blocks CI before execution when approved runner source %s drifts", (path) => {
    const root = temporaryProject();
    approvedSources(root);
    hardenedEvaluationContract(root);
    const contract = JSON.parse(readFileSync(join(root, "evals/evals.json"), "utf8"));
    contract.suites[0].runnerSources = [path];
    write(root, path, "initial\n");
    write(root, "evals/evals.json", JSON.stringify(contract));
    intakeProject({ projectRoot: root, owner: "owner", approveSources: true });
    write(root, ".harness/discovery.json", `${JSON.stringify(discoverProject(root), null, 2)}\n`);
    const planned = planProject({ projectRoot: root, profile: "custom", stacks: ["typescript"], qualityProfiles: ["eval-driven-development"] });
    applyPlan({ projectRoot: root, planPath: planned.path, approval: planned.plan.planHash });
    write(root, path, "changed\n");

    expect(() => applyPlan({ projectRoot: root, planPath: planned.path, approval: planned.plan.planHash }))
      .toThrow(/STALE_PRECONDITION/);
    expect(runTrustedChecks({ projectRoot: root, mode: "ci" }).evaluations)
      .toMatchObject({ status: "blocked", receiptPath: null, receiptHash: null });
  });

  it("runs an eval argv exactly once in CI while leaving session, commit, plan, and apply execution-free", () => {
    const root = temporaryProject();
    approvedSources(root);
    write(root, "package.json", JSON.stringify({ scripts: {
      test: "node -e \"require('node:fs').appendFileSync('eval-count.txt', 'x')\"",
    } }));
    write(root, "evals/tasks.jsonl", "{}\n");
    write(root, "evals/baselines/adoption.json", "{}\n");
    write(root, "evals/fixtures/known-bad.json", "{}\n");
    write(root, "evals/evals.json", JSON.stringify({ schemaVersion: "1.1", suites: [{
      id: "counted-quality", kind: "regression", owner: "owner", description: "Count specialized execution.",
      command: ["npm", "run", "test"], runnerSources: ["package.json"], tasks: ["evals/tasks.jsonl"],
      traceability: [{ requirementId: "PRD-AI-004", ruleIds: ["counted-quality-gate"] }],
      baseline: { origin: "adoption", score: 0, trials: 1, evidence: "evals/baselines/adoption.json" },
      target: { metric: "pass-at-1", threshold: 1, trials: 1 }, graders: [{ id: "tests", kind: "code", role: "gate" }],
      negativeControl: { command: ["node", "-e", "process.exit(1)"], fixture: "evals/fixtures/known-bad.json", expectedExitCode: 1 },
    }] }));
    intakeProject({ projectRoot: root, owner: "owner", approveSources: true });
    write(root, ".harness/discovery.json", `${JSON.stringify(discoverProject(root), null, 2)}\n`);
    const planned = planProject({ projectRoot: root, profile: "custom", stacks: ["typescript"], qualityProfiles: ["eval-driven-development"] });
    expect(planned.plan.commands).toEqual(expect.arrayContaining([["npm", "run", "test"], ["node", "-e", "process.exit(1)"]]));
    expect(() => readFileSync(join(root, "eval-count.txt"), "utf8")).toThrow();
    applyPlan({ projectRoot: root, planPath: planned.path, approval: planned.plan.planHash });
    expect(() => readFileSync(join(root, "eval-count.txt"), "utf8")).toThrow();
    runTrustedChecks({ projectRoot: root, mode: "session" });
    runTrustedChecks({ projectRoot: root, mode: "commit" });
    expect(() => readFileSync(join(root, "eval-count.txt"), "utf8")).toThrow();

    const ci = runTrustedChecks({ projectRoot: root, mode: "ci" });
    expect(readFileSync(join(root, "eval-count.txt"), "utf8")).toBe("x");
    expect(ci.commands).not.toEqual(expect.arrayContaining([expect.objectContaining({ command: ["npm", "run", "test"] })]));
  });

  it("keeps an equivalent ordinary command as a CI gate when EDD is disabled", () => {
    const root = temporaryProject();
    approvedSources(root);
    write(root, "package.json", JSON.stringify({ scripts: {
      test: "node -e \"require('node:fs').appendFileSync('ordinary-count.txt', 'x')\"",
    } }));
    intakeProject({ projectRoot: root, owner: "owner", approveSources: true });
    write(root, ".harness/discovery.json", `${JSON.stringify(discoverProject(root), null, 2)}\n`);
    const planned = planProject({ projectRoot: root, profile: "custom", stacks: ["typescript"] });
    applyPlan({ projectRoot: root, planPath: planned.path, approval: planned.plan.planHash });
    expect(runTrustedChecks({ projectRoot: root, mode: "ci" }).commands)
      .toEqual(expect.arrayContaining([expect.objectContaining({ command: ["npm", "run", "test"], status: "passed" })]));
    expect(readFileSync(join(root, "ordinary-count.txt"), "utf8")).toBe("x");
  });

  it("uses a PATH runner only for its approved argv, never a preflight --version probe", () => {
    const root = temporaryProject();
    approvedSources(root);
    hardenedEvaluationContract(root);
    const contract = JSON.parse(readFileSync(join(root, "evals/evals.json"), "utf8"));
    contract.suites[0].command = ["custom-eval-runner"];
    contract.suites[0].runnerSources = ["bin/custom-eval-runner"];
    write(root, "bin/custom-eval-runner", "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf version >> \"$MARKER_PATH\"; exit 0; fi\nprintf run >> \"$MARKER_PATH\"\n");
    chmodSync(join(root, "bin/custom-eval-runner"), 0o755);
    write(root, "evals/evals.json", JSON.stringify(contract));
    intakeProject({ projectRoot: root, owner: "owner", approveSources: true });
    write(root, ".harness/discovery.json", `${JSON.stringify(discoverProject(root), null, 2)}\n`);
    const planned = planProject({ projectRoot: root, profile: "custom", stacks: ["typescript"], qualityProfiles: ["eval-driven-development"] });
    applyPlan({ projectRoot: root, planPath: planned.path, approval: planned.plan.planHash });
    const previousPath = process.env.PATH;
    const previousMarker = process.env.MARKER_PATH;
    process.env.PATH = `${join(root, "bin")}${delimiter}${previousPath ?? ""}`;
    process.env.MARKER_PATH = join(root, "custom-runner-marker.txt");
    try {
      expect(runTrustedChecks({ projectRoot: root, mode: "ci" }).evaluations.status).toBe("verified");
      expect(readFileSync(String(process.env.MARKER_PATH), "utf8")).toBe("run");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousMarker === undefined) delete process.env.MARKER_PATH;
      else process.env.MARKER_PATH = previousMarker;
    }
  });

  it("runs a shebang path runner exactly once", () => {
    const root = temporaryProject();
    approvedSources(root);
    hardenedEvaluationContract(root);
    const contract = JSON.parse(readFileSync(join(root, "evals/evals.json"), "utf8"));
    contract.suites[0].command = ["bin/path-eval-runner"];
    contract.suites[0].runnerSources = ["bin/path-eval-runner"];
    write(root, "bin/path-eval-runner", "#!/bin/sh\nprintf run >> \"$MARKER_PATH\"\n");
    chmodSync(join(root, "bin/path-eval-runner"), 0o755);
    write(root, "evals/evals.json", JSON.stringify(contract));
    intakeProject({ projectRoot: root, owner: "owner", approveSources: true });
    write(root, ".harness/discovery.json", `${JSON.stringify(discoverProject(root), null, 2)}\n`);
    const planned = planProject({ projectRoot: root, profile: "custom", stacks: ["typescript"], qualityProfiles: ["eval-driven-development"] });
    applyPlan({ projectRoot: root, planPath: planned.path, approval: planned.plan.planHash });
    const previousMarker = process.env.MARKER_PATH;
    process.env.MARKER_PATH = join(root, "path-runner-marker.txt");
    try {
      expect(runTrustedChecks({ projectRoot: root, mode: "ci" }).evaluations.status).toBe("verified");
      expect(readFileSync(String(process.env.MARKER_PATH), "utf8")).toBe("run");
    } finally {
      if (previousMarker === undefined) delete process.env.MARKER_PATH;
      else process.env.MARKER_PATH = previousMarker;
    }
  });

  it.each([
    ["EACCES", 0o644],
    ["ENOEXEC", 0o755],
  ])("reports runner spawn error %s as unavailable and blocked", (_error, mode) => {
    const root = temporaryProject();
    approvedSources(root);
    hardenedEvaluationContract(root);
    const contract = JSON.parse(readFileSync(join(root, "evals/evals.json"), "utf8"));
    contract.suites[0].command = ["evals/not-executable"];
    contract.suites[0].runnerSources = ["evals/not-executable"];
    write(root, "evals/not-executable", "not an executable\n");
    chmodSync(join(root, "evals/not-executable"), mode);
    write(root, "evals/evals.json", JSON.stringify(contract));
    intakeProject({ projectRoot: root, owner: "owner", approveSources: true });
    write(root, ".harness/discovery.json", `${JSON.stringify(discoverProject(root), null, 2)}\n`);
    const planned = planProject({ projectRoot: root, profile: "custom", stacks: ["typescript"], qualityProfiles: ["eval-driven-development"] });
    applyPlan({ projectRoot: root, planPath: planned.path, approval: planned.plan.planHash });

    const ci = runTrustedChecks({ projectRoot: root, mode: "ci" });
    expect(ci.evaluations).toMatchObject({ available: false, status: "blocked", passing: false, enforced: true });
  });

  it("keeps passing true but enforcement false when the negative control cannot launch", () => {
    const root = temporaryProject();
    approvedSources(root);
    hardenedEvaluationContract(root);
    const contract = JSON.parse(readFileSync(join(root, "evals/evals.json"), "utf8"));
    contract.suites[0].negativeControl.command = ["evals/not-executable-negative"];
    write(root, "evals/not-executable-negative", "not executable\n");
    chmodSync(join(root, "evals/not-executable-negative"), 0o644);
    write(root, "evals/evals.json", JSON.stringify(contract));
    intakeProject({ projectRoot: root, owner: "owner", approveSources: true });
    write(root, ".harness/discovery.json", `${JSON.stringify(discoverProject(root), null, 2)}\n`);
    const planned = planProject({ projectRoot: root, profile: "custom", stacks: ["typescript"], qualityProfiles: ["eval-driven-development"] });
    applyPlan({ projectRoot: root, planPath: planned.path, approval: planned.plan.planHash });

    expect(runTrustedChecks({ projectRoot: root, mode: "ci" }).evaluations)
      .toMatchObject({ available: false, status: "blocked", passing: true, enforced: false });
  });

  it("treats a launched negative timeout as failing rather than unavailable", () => {
    const root = temporaryProject();
    approvedSources(root);
    hardenedEvaluationContract(root);
    const contract = JSON.parse(readFileSync(join(root, "evals/evals.json"), "utf8"));
    contract.suites[0].negativeControl.command = ["node", "-e", "setTimeout(() => process.exit(1), 1000)"];
    write(root, "evals/evals.json", JSON.stringify(contract));
    intakeProject({ projectRoot: root, owner: "owner", approveSources: true });
    write(root, ".harness/discovery.json", `${JSON.stringify(discoverProject(root), null, 2)}\n`);
    const planned = planProject({ projectRoot: root, profile: "custom", stacks: ["typescript"], qualityProfiles: ["eval-driven-development"] });
    applyPlan({ projectRoot: root, planPath: planned.path, approval: planned.plan.planHash });

    expect(runTrustedChecks({ projectRoot: root, mode: "ci", commandTimeoutMs: 250 }).evaluations)
      .toMatchObject({ available: true, status: "failing", passing: true, enforced: false });
  });

  it("hashes complete stdout and stderr even when diagnostics share a truncated suffix", () => {
    const run = (prefix: string): string => {
      const root = temporaryProject();
      approvedSources(root);
      hardenedEvaluationContract(root);
      const contract = JSON.parse(readFileSync(join(root, "evals/evals.json"), "utf8"));
      contract.suites[0].command = ["node", "-e", `process.stdout.write('${prefix}'.repeat(20001) + 'same-tail')`];
      write(root, "evals/evals.json", JSON.stringify(contract));
      intakeProject({ projectRoot: root, owner: "owner", approveSources: true });
      write(root, ".harness/discovery.json", `${JSON.stringify(discoverProject(root), null, 2)}\n`);
      const planned = planProject({ projectRoot: root, profile: "custom", stacks: ["typescript"], qualityProfiles: ["eval-driven-development"] });
      applyPlan({ projectRoot: root, planPath: planned.path, approval: planned.plan.planHash });
      const ci = runTrustedChecks({ projectRoot: root, mode: "ci" });
      const receipt = JSON.parse(readFileSync(join(root, String(ci.evaluations.receiptPath)), "utf8"));
      return receipt.suites[0].positive.outputSha256;
    };
    const first = run("A");
    const second = run("B");
    expect(first).not.toBe(second);
  });

  it("reports current, missing, stale, and symlinked Skill copies without writing", () => {
    const project = temporaryProject();
    const packageRoot = temporaryProject();
    const homeRoot = temporaryProject();
    for (const name of ["harness-automation", "manage-worktree-delivery"]) {
      write(packageRoot, `dist/${name === "harness-automation" ? "skill" : name}/SKILL.md`, `# ${name}\n`);
      write(packageRoot, `dist/${name === "harness-automation" ? "skill" : name}/references/rule.md`, "rule\n");
    }
    write(packageRoot, "package.json", JSON.stringify({ version: "9.9.9" }));
    write(homeRoot, ".claude/skills/harness-automation/SKILL.md", "# harness-automation\n");
    write(homeRoot, ".claude/skills/harness-automation/references/rule.md", "rule\n");
    write(homeRoot, ".codex/skills/harness-automation/SKILL.md", "stale\n");
    write(homeRoot, ".agents/skills/manage-worktree-delivery/SKILL.md", "# manage-worktree-delivery\n");
    write(homeRoot, ".agents/skills/manage-worktree-delivery/references/rule.md", "rule\n");
    const outside = temporaryProject();
    write(outside, "SKILL.md", "outside\n");
    mkdirSync(join(homeRoot, ".codex/skills"), { recursive: true });
    symlinkSync(outside, join(homeRoot, ".codex/skills/manage-worktree-delivery"));
    const before = JSON.stringify({
      source: readFileSync(join(packageRoot, "dist/skill/SKILL.md"), "utf8"),
      current: readFileSync(join(homeRoot, ".claude/skills/harness-automation/SKILL.md"), "utf8"),
      outside: readFileSync(join(outside, "SKILL.md"), "utf8"),
    });

    const result = doctorProject(project, { packagePath: packageRoot, homeDirectory: homeRoot }) as {
      skillInstallations: { package: { version: string }; skills: Array<{ name: string; inSync: boolean; targets: Array<{ status: string }> }> };
    };
    expect(result.skillInstallations.package.version).toBe("9.9.9");
    expect(result.skillInstallations.skills.find((item) => item.name === "harness-automation")).toMatchObject({
      inSync: false,
      targets: [{ status: "current" }, { status: "stale" }, { status: "missing" }],
    });
    expect(result.skillInstallations.skills.find((item) => item.name === "manage-worktree-delivery")).toMatchObject({
      inSync: false,
      targets: [{ status: "missing" }, { status: "blocked" }, { status: "current" }],
    });
    expect(JSON.stringify({
      source: readFileSync(join(packageRoot, "dist/skill/SKILL.md"), "utf8"),
      current: readFileSync(join(homeRoot, ".claude/skills/harness-automation/SKILL.md"), "utf8"),
      outside: readFileSync(join(outside, "SKILL.md"), "utf8"),
    })).toBe(before);
  });

  it("blocks an installed Skill reached through a symlinked home ancestor", () => {
    const project = temporaryProject();
    const packageRoot = temporaryProject();
    const homeRoot = temporaryProject();
    const redirectedHome = temporaryProject();
    write(packageRoot, "dist/skill/SKILL.md", "# harness-automation\n");
    write(packageRoot, "dist/manage-worktree-delivery/SKILL.md", "# manage-worktree-delivery\n");
    write(redirectedHome, "skills/harness-automation/SKILL.md", "# harness-automation\n");
    symlinkSync(redirectedHome, join(homeRoot, ".claude"));

    const result = doctorProject(project, { packagePath: packageRoot, homeDirectory: homeRoot }) as {
      skillInstallations: { skills: Array<{ name: string; targets: Array<{ status: string }> }> };
    };
    expect(result.skillInstallations.skills.find((skill) => skill.name === "harness-automation")?.targets[0].status)
      .toBe("blocked");
  });
});
