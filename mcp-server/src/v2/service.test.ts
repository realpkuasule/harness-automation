import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverProject } from "./discovery.js";
import {
  applyPlan,
  checkProject,
  driftProject,
  intakeProject,
  planProject,
  researchGitHub,
  rollbackChange,
} from "./service.js";

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
});
