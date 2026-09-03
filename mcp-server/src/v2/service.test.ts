import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, parse } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverProject } from "./discovery.js";
import {
  applyPlan,
  checkProject,
  doctorProject,
  driftProject,
  intakeProject,
  planProject,
  planProjectUpdate,
  planProjectUpgrade,
  researchGitHub,
  rollbackChange,
  hasExecutableFileHeader,
  runTrustedChecks,
} from "./service.js";
import { planWorkspaceConfiguration } from "../worktree/service.js";
import { createRecoveryApproval, inspectRecoveryState, recordRecoveryApproval } from "../recovery/service.js";
import { resolveProjectContext } from "../repository/git.js";
import { fileHash, hashObject, sha256 } from "./fs.js";
import { readLatestLkgRecord, readReceiptChain } from "../receipt/service.js";
import { PYTHON_NAMING_CHECKER } from "./policy.js";

const roots: string[] = [];
const compilerVersion = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version as string;

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

function applyCurrentPolicy(root: string, options: Parameters<typeof planProject>[0] = { projectRoot: root }): void {
  intakeProject({ projectRoot: root, owner: "owner", approveSources: true, now: new Date("2026-01-01T00:00:00Z") });
  write(root, ".harness/discovery.json", `${JSON.stringify(discoverProject(root, new Date("2026-01-01T00:00:01Z")), null, 2)}\n`);
  const planned = planProject({ ...options, projectRoot: root, now: new Date("2026-01-01T00:00:02Z") });
  applyPlan({ projectRoot: root, planPath: planned.path, approval: planned.plan.planHash, now: new Date("2026-01-01T00:00:03Z") });
}

function rewriteAppliedPolicy(root: string, mutate: (policy: Record<string, unknown>) => void): string {
  const policyPath = join(root, ".harness/policy.yaml");
  const manifestPath = join(root, ".harness/manifest.json");
  const policy = JSON.parse(readFileSync(policyPath, "utf8")) as Record<string, unknown>;
  mutate(policy);
  const content = `${JSON.stringify(policy, null, 2)}\n`;
  write(root, ".harness/policy.yaml", content);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    compiler: unknown;
    policyDigest: string;
    outputs: Array<{ path: string; sha256: string }>;
  };
  manifest.compiler = "harness-automation@2";
  manifest.policyDigest = hashObject(policy);
  const output = manifest.outputs.find((item) => item.path === ".harness/policy.yaml");
  if (!output) throw new Error("test fixture manifest is missing policy output");
  output.sha256 = sha256(content);
  write(root, ".harness/manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  return content;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("generated Python naming checker", () => {
  it("accepts Python semantic exceptions while rejecting ordinary camelCase names", () => {
    const root = temporaryProject();
    const checker = join(root, ".harness/generated/check_python_naming.py");
    write(root, ".harness/generated/check_python_naming.py", PYTHON_NAMING_CHECKER);
    write(root, "legal.py", `
import typing
import typing_extensions
import unittest
from pathlib import Path
from typing import Any, Callable, Sequence, TypeAlias
from typing_extensions import TypeAlias as ExtensionsTypeAlias
from transformers import AutoProcessor, Qwen3VLForConditionalGeneration

StageAction: TypeAlias = str
OutputRetriever: ExtensionsTypeAlias = str
Embedder: typing.TypeAlias = str
CommandRunner: typing_extensions.TypeAlias = str
ImplicitStageAction = Callable[[StageContext], list[dict[str, Any]]]
ImplicitOutputRetriever = Callable[[str, str, Path], None]
ImplicitCommandRunner = Callable[[Sequence[str]], str]
ImplicitEmbedder = Callable[[str], np.ndarray]
_TEMPLATES = {}
_RUN_ID = "run"
_private_value = 1
replacement = None
AutoProcessor.from_pretrained = classmethod(replacement)
Qwen3VLForConditionalGeneration.from_pretrained = classmethod(replacement)
AutoProcessor["loader"] = replacement

class CheckerCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        pass

    @classmethod
    def tearDownClass(cls):
        pass

    def setUp(self):
        pass

    def tearDown(self):
        pass

    def test_placeholders(self):
        for _ in range(1):
            _ = None

def normal_function(normal_parameter):
    local_value = normal_parameter
    return local_value

def discard(_):
    return _
`);

    expect(spawnSync("python3", [checker, root], { encoding: "utf8" }).status).toBe(0);
    expect(spawnSync("python3", [checker, "--self-test"], { encoding: "utf8" }).status).toBe(1);

    write(root, "invalid.py", "UserName = \"value\"\ndef badFunction(badParameter):\n    badVariable = badParameter\n");
    const invalid = spawnSync("python3", [checker, root], { encoding: "utf8" });
    expect(invalid.status).toBe(1);
    expect(`${invalid.stderr}`).toContain("badFunction");
    expect(`${invalid.stderr}`).toContain("UserName");
  });
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

  it("reports naming adapter evidence through the project check gate", () => {
    const root = temporaryProject();
    fullTypeScriptProject(root);
    applyCurrentPolicy(root);

    expect(checkProject(root).stackAdapters).toEqual([
      expect.objectContaining({
        stack: "typescript",
        support: "deterministic",
        supported: true,
        enforced: true,
        passing: true,
        status: "verified",
        evidence: {
          adapterReachable: true,
          knownBadRejected: true,
          projectGateConnected: true,
        },
        evidenceGaps: [],
      }),
      expect.objectContaining({ stack: "postgresql", status: "guidance", supported: false, enforced: false }),
    ]);

    write(root, "src/invalid.ts", "export const invalid_name = 1;\n");
    expect(checkProject(root).stackAdapters).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stack: "typescript",
        supported: true,
        enforced: true,
        passing: false,
        status: "failing",
        evidenceGaps: [],
      }),
    ]));
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
  it("ratchets a rule-bound TypeScript naming baseline through intake and immutable plans", () => {
    const root = temporaryProject();
    fullTypeScriptProject(root);
    write(root, "src/userService.ts", "export const legacy_name = 1;\n");
    const discover = (): void => write(root, ".harness/discovery.json", `${JSON.stringify(discoverProject(root), null, 2)}\n`);
    intakeProject({ projectRoot: root, owner: "owner", approveSources: true, now: new Date("2026-01-01T00:00:00Z") });
    discover();

    const strict = planProject({ projectRoot: root });
    expect(() => applyPlan({
      projectRoot: root,
      planPath: strict.path,
      approval: strict.plan.planHash,
    })).toThrow(/TYPESCRIPT_NAMING_ADOPTION_DRIFT/u);

    expect(() => planProject({ projectRoot: root, adoptTypeScriptNaming: true }))
      .toThrow(/TYPESCRIPT_NAMING_ADOPTION_INTAKE_REQUIRED/u);
    write(root, "src/userService.ts", "const = ;\n");
    expect(() => intakeProject({
      projectRoot: root,
      owner: "owner",
      approveSources: true,
      approveTypeScriptNamingAdoption: true,
    }))
      .toThrow(/TYPESCRIPT_NAMING_ADOPTION_PARSE_ERROR/u);
    write(root, "src/userService.ts", "export const legacy_name = 1;\n");

    intakeProject({
      projectRoot: root,
      owner: "owner",
      approveSources: true,
      approveTypeScriptNamingAdoption: true,
      now: new Date("2026-01-01T00:00:01Z"),
    });
    discover();
    const adopted = planProject({ projectRoot: root, adoptTypeScriptNaming: true });
    expect(adopted.policy.typescriptNamingBaseline).toMatchObject({
      ruleId: "typescript-naming",
      fingerprints: [expect.stringMatching(/^[a-f0-9]{64}$/u)],
    });
    expect(adopted.plan.warnings).toContain("Owner-approved intake adopts 1 existing TypeScript naming violation(s) as a ratcheted baseline.");
    expect(() => applyPlan({
      projectRoot: root,
      planPath: adopted.path,
      approval: "0".repeat(64),
    })).toThrow(/APPROVAL_MISMATCH/u);
    applyPlan({ projectRoot: root, planPath: adopted.path, approval: adopted.plan.planHash });
    expect(checkProject(root).ok).toBe(true);

    write(root, "src/userService.ts", "\n\nexport const legacy_name = 1;\n");
    expect(checkProject(root).ok).toBe(true);
    write(root, "src/userService.ts", "export const changed_name = 1;\n");
    expect(checkProject(root)).toMatchObject({ ok: false, violations: [expect.stringContaining("changed_name")] });

    write(root, "src/userService.ts", "export const legacy_name = 1;\nexport const new_debt = 2;\n");
    expect(checkProject(root)).toMatchObject({
      ok: false,
      violations: [expect.stringContaining("new_debt")],
    });
    expect(() => planProject({ projectRoot: root, adoptTypeScriptNaming: true }))
      .toThrow(/TYPESCRIPT_NAMING_ADOPTION_DRIFT/u);

    intakeProject({
      projectRoot: root,
      owner: "owner",
      approveSources: true,
      now: new Date("2026-01-01T00:00:02Z"),
    });
    discover();
    expect(() => planProject({ projectRoot: root, adoptTypeScriptNaming: true }))
      .toThrow(/TYPESCRIPT_NAMING_ADOPTION_INTAKE_REQUIRED/u);

    intakeProject({
      projectRoot: root,
      owner: "owner",
      approveSources: true,
      approveTypeScriptNamingAdoption: true,
      now: new Date("2026-01-01T00:00:03Z"),
    });
    discover();
    const expanded = planProject({ projectRoot: root, adoptTypeScriptNaming: true });
    expect(expanded.policy.typescriptNamingBaseline?.fingerprints).toHaveLength(2);
    expect(() => applyPlan({ projectRoot: root, planPath: expanded.path, approval: "0".repeat(64) }))
      .toThrow(/APPROVAL_MISMATCH/u);
    write(root, "src/userService.ts", "export const legacy_name = 1;\n");
    expect(() => applyPlan({ projectRoot: root, planPath: expanded.path, approval: expanded.plan.planHash }))
      .toThrow(/TYPESCRIPT_NAMING_ADOPTION_DRIFT/u);
    write(root, "src/userService.ts", "export const legacy_name = 1;\nexport const new_debt = 2;\n");
    applyPlan({ projectRoot: root, planPath: expanded.path, approval: expanded.plan.planHash });
    expect(checkProject(root).ok).toBe(true);

    write(root, "src/userService.ts", "export const legacy_name = 1;\n");
    const partialShrink = planProject({ projectRoot: root });
    expect(partialShrink.policy.typescriptNamingBaseline?.fingerprints).toHaveLength(1);
    expect(partialShrink.plan.warnings).toContain("TypeScript naming baseline ratchets from 2 to 1 violation(s).");
    applyPlan({ projectRoot: root, planPath: partialShrink.path, approval: partialShrink.plan.planHash });
    write(root, "src/userService.ts", "export const legacy_name = 1;\nexport const new_debt = 2;\n");
    expect(() => planProject({ projectRoot: root, adoptTypeScriptNaming: true }))
      .toThrow(/TYPESCRIPT_NAMING_ADOPTION_FRESH_INTAKE_REQUIRED/u);

    write(root, "src/userService.ts", "export const userId = 1;\n");
    intakeProject({
      projectRoot: root,
      owner: "owner",
      approveSources: true,
      now: new Date("2026-01-01T00:00:04Z"),
    });
    discover();
    const shrunk = planProject({ projectRoot: root });
    expect(shrunk.policy.typescriptNamingBaseline?.fingerprints).toEqual([]);
    expect(shrunk.plan.warnings).toContain("TypeScript naming baseline ratchets from 1 to 0 violation(s).");
    applyPlan({ projectRoot: root, planPath: shrunk.path, approval: shrunk.plan.planHash });
    write(root, "src/userService.ts", "export const legacy_name = 1;\n");
    expect(checkProject(root)).toMatchObject({ ok: false, violations: [expect.stringContaining("legacy_name")] });
  });

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
    expect(first.policy.typescriptNamingBaseline?.fingerprints).toEqual([]);

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

  it("resumes one interrupted file apply only with persisted human recovery approval and compensates the whole plan", () => {
    const root = temporaryProject();
    fullTypeScriptProject(root);
    write(root, "AGENTS.md", "original instructions\n");
    intakeProject({ projectRoot: root, owner: "owner", approveSources: true });
    write(root, ".harness/discovery.json", `${JSON.stringify(discoverProject(root), null, 2)}\n`);
    const planned = planProject({ projectRoot: root });

    expect(() => applyPlan({
      projectRoot: root, planPath: planned.path, approval: planned.plan.planHash,
      testInterruptAfterWrites: 1,
    })).toThrow("TEST_FILE_APPLY_INTERRUPT");
    expect(() => applyPlan({ projectRoot: root, planPath: planned.path, approval: planned.plan.planHash }))
      .toThrow("RECOVERY_HUMAN_APPROVAL_REQUIRED");

    const recoveryContext = resolveProjectContext(root);
    const finding = inspectRecoveryState(recoveryContext).find((item) =>
      item.kind === "file-apply" && item.id === planned.plan.id)!;
    const approval = createRecoveryApproval({
      context: recoveryContext,
      finding,
      approvedBy: "owner",
      approvedAt: "2099-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:01:00.000Z",
    });
    recordRecoveryApproval(recoveryContext, approval);
    expect(() => applyPlan({
      projectRoot: root,
      planPath: planned.path,
      approval: planned.plan.planHash,
      recoveryApprovalRef: approval.id,
      now: new Date("2099-01-01T00:00:30.000Z"),
      testFailPostApply: true,
    })).toThrow("TEST_FILE_POST_APPLY_FAILURE");
    for (const operation of planned.plan.operations) {
      expect(fileHash(join(root, operation.path))).toBe(operation.beforeHash);
    }
    expect(inspectRecoveryState(recoveryContext)).toEqual([]);
    expect(applyPlan({ projectRoot: root, planPath: planned.path, approval: planned.plan.planHash }))
      .toMatchObject({ id: planned.plan.id });
  });

  it("treats an exact completed change receipt as authoritative after cleanup interruption", () => {
    const root = temporaryProject();
    fullTypeScriptProject(root);
    intakeProject({ projectRoot: root, owner: "owner", approveSources: true });
    write(root, ".harness/discovery.json", `${JSON.stringify(discoverProject(root), null, 2)}\n`);
    const planned = planProject({ projectRoot: root });
    expect(() => applyPlan({
      projectRoot: root, planPath: planned.path, approval: planned.plan.planHash,
      testInterruptAfterChangeReceipt: true,
    })).toThrow("TEST_FILE_CHANGE_RECEIPT_INTERRUPT");
    expect(inspectRecoveryState(resolveProjectContext(root))).toEqual([]);
    expect(applyPlan({ projectRoot: root, planPath: planned.path, approval: planned.plan.planHash }))
      .toMatchObject({ id: planned.plan.id, planHash: planned.plan.planHash });
  });

  it("resumes an interrupted rollback only with evidence-bound approval and keeps immutable receipts", () => {
    const root = temporaryProject();
    fullTypeScriptProject(root);
    write(root, "AGENTS.md", "original instructions\n");
    intakeProject({ projectRoot: root, owner: "owner", approveSources: true });
    write(root, ".harness/discovery.json", `${JSON.stringify(discoverProject(root), null, 2)}\n`);
    const planned = planProject({ projectRoot: root });
    const change = applyPlan({ projectRoot: root, planPath: planned.path, approval: planned.plan.planHash });

    expect(() => rollbackChange({ projectRoot: root, changeId: change.id, testInterruptAfterRestores: 1 }))
      .toThrow("TEST_FILE_ROLLBACK_INTERRUPT");
    expect(() => rollbackChange({ projectRoot: root, changeId: change.id }))
      .toThrow("RECOVERY_HUMAN_APPROVAL_REQUIRED");
    const recoveryContext = resolveProjectContext(root);
    const finding = inspectRecoveryState(recoveryContext).find((item) => item.kind === "file-rollback")!;
    expect(finding).toMatchObject({ id: change.id, action: "resume-rollback" });
    const approval = createRecoveryApproval({
      context: recoveryContext,
      finding,
      approvedBy: "owner",
      approvedAt: "2099-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:01:00.000Z",
    });
    recordRecoveryApproval(recoveryContext, approval);
    expect(rollbackChange({
      projectRoot: root,
      changeId: change.id,
      recoveryApprovalRef: approval.id,
      now: new Date("2099-01-01T00:00:30.000Z"),
    })).toMatchObject({ id: change.id, status: "rolled-back" });
    expect(inspectRecoveryState(recoveryContext)).toEqual([]);
    expect(readReceiptChain({ root, stateDirectory: ".harness", domain: "file-apply", transactionId: change.id })).toHaveLength(1);
    expect(readReceiptChain({ root, stateDirectory: ".harness", domain: "file-rollback", transactionId: change.id })).toHaveLength(1);
    expect(readLatestLkgRecord({ root, stateDirectory: ".harness", domain: "file-rollback" }))
      .toMatchObject({ transactionId: change.id, planHash: planned.plan.planHash });
  });

  it("does not overwrite post-apply drift during rollback and detects receipt projection tampering", () => {
    const root = temporaryProject();
    fullTypeScriptProject(root);
    intakeProject({ projectRoot: root, owner: "owner", approveSources: true });
    write(root, ".harness/discovery.json", `${JSON.stringify(discoverProject(root), null, 2)}\n`);
    const planned = planProject({ projectRoot: root });
    const change = applyPlan({ projectRoot: root, planPath: planned.path, approval: planned.plan.planHash });
    write(root, "AGENTS.md", "user edit after apply\n");
    expect(() => rollbackChange({ projectRoot: root, changeId: change.id })).toThrow("ROLLBACK_DRIFT: AGENTS.md");
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe("user edit after apply\n");

    const changePath = join(root, ".harness", "changes", change.id, "change.json");
    const tampered = JSON.parse(readFileSync(changePath, "utf8"));
    tampered.appliedAt = "2099-01-01T00:00:00.000Z";
    write(root, ".harness/changes/" + change.id + "/change.json", `${JSON.stringify(tampered, null, 2)}\n`);
    expect(() => applyPlan({ projectRoot: root, planPath: planned.path, approval: planned.plan.planHash }))
      .toThrow("RECEIPT_PROJECTION_DIVERGED");
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
    approvedSources(root);
    write(root, "manage.py", "#!/usr/bin/env python3\n");
    write(root, "requirements.txt", "Django\npydantic\ncelery\npsycopg\n");
    write(root, "frontend/package.json", JSON.stringify({ dependencies: { typescript: "1", react: "1" } }));
    write(root, "package-lock.json", "{}\n");
    write(root, "src/invalid.py", "badName = 1\n");
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

describe("v2 project governance upgrade", () => {
  it("requires an existing policy before planning an update", () => {
    const root = temporaryProject();
    expect(() => planProjectUpdate({ projectRoot: root })).toThrow(/HARNESS_INITIALIZATION_REQUIRED/u);
  });

  it("returns a zero-write current result and reports the exact compiler", () => {
    const root = temporaryProject();
    fullTypeScriptProject(root);
    applyCurrentPolicy(root);
    const planDirectory = join(root, ".harness/plans");
    const before = readdirSync(planDirectory).sort();

    const result = planProjectUpgrade({ projectRoot: root, now: new Date("2026-01-02T00:00:00Z") });

    expect(result).toMatchObject({ status: "current", planPath: null, planHash: null });
    expect(readdirSync(planDirectory).sort()).toEqual(before);
    expect((doctorProject(root) as { compiler: { status: string; current: { version: string } } }).compiler)
      .toMatchObject({ status: "current", current: { version: compilerVersion } });
  });

  it("reports all four offline compiler states", () => {
    const unconfigured = temporaryProject();
    expect((doctorProject(unconfigured) as { compiler: { status: string } }).compiler.status).toBe("unconfigured");

    const root = temporaryProject();
    fullTypeScriptProject(root);
    applyCurrentPolicy(root);
    expect((doctorProject(root) as { compiler: { status: string } }).compiler.status).toBe("current");
    rewriteAppliedPolicy(root, (policy) => { delete policy.compiler; });
    expect((doctorProject(root) as { compiler: { status: string } }).compiler.status).toBe("legacy-version-unknown");

    const stale = { package: "@realpkuasule/harness-automation", version: "0.0.1" };
    const policy = JSON.parse(readFileSync(join(root, ".harness/policy.yaml"), "utf8"));
    const manifest = JSON.parse(readFileSync(join(root, ".harness/manifest.json"), "utf8"));
    policy.compiler = stale;
    manifest.compiler = stale;
    write(root, ".harness/policy.yaml", `${JSON.stringify(policy, null, 2)}\n`);
    write(root, ".harness/manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
    expect((doctorProject(root) as { compiler: { status: string } }).compiler.status).toBe("stale");

    const policyCompiler = { package: "@realpkuasule/harness-automation", version: "2.8.0" };
    const manifestCompiler = { package: "@realpkuasule/harness-automation", version: "2.8.1" };
    rewriteAppliedPolicy(root, (value) => { value.compiler = policyCompiler; });
    const mismatchedManifest = JSON.parse(readFileSync(join(root, ".harness/manifest.json"), "utf8"));
    mismatchedManifest.compiler = manifestCompiler;
    write(root, ".harness/manifest.json", `${JSON.stringify(mismatchedManifest, null, 2)}\n`);
    expect(planProjectUpgrade({ projectRoot: root }).plan?.update?.from).toMatchObject({
      compiler: null,
      policyCompiler,
      manifestCompiler,
      compilerStatus: "stale",
    });

    rewriteAppliedPolicy(root, (value) => { value.compiler = policyCompiler; });
    expect(planProjectUpgrade({ projectRoot: root }).plan?.update?.from).toMatchObject({
      policyCompiler,
      manifestCompiler: null,
      compilerStatus: "legacy-version-unknown",
    });
    rewriteAppliedPolicy(root, (value) => { delete value.compiler; });
    const exactManifest = JSON.parse(readFileSync(join(root, ".harness/manifest.json"), "utf8"));
    exactManifest.compiler = manifestCompiler;
    write(root, ".harness/manifest.json", `${JSON.stringify(exactManifest, null, 2)}\n`);
    expect(planProjectUpgrade({ projectRoot: root }).plan?.update?.from).toMatchObject({
      policyCompiler: null,
      manifestCompiler,
      compilerStatus: "legacy-version-unknown",
    });
  });

  it("writes update metadata and still applies a legacy upgrade envelope", () => {
    const root = temporaryProject();
    fullTypeScriptProject(root);
    applyCurrentPolicy(root);
    rewriteAppliedPolicy(root, (policy) => { delete policy.compiler; });
    const planned = planProjectUpdate({ projectRoot: root, now: new Date("2026-01-02T00:00:00Z") });
    expect(planned.plan?.update).toBeDefined();
    expect(planned.plan?.upgrade).toBeUndefined();
    const legacy = JSON.parse(readFileSync(join(root, planned.planPath!), "utf8"));
    legacy.upgrade = legacy.update;
    delete legacy.update;
    const unsigned = { ...legacy };
    delete unsigned.planHash;
    legacy.planHash = hashObject(unsigned);
    const legacyPath = ".harness/plans/legacy-upgrade-envelope.json";
    write(root, legacyPath, `${JSON.stringify(legacy, null, 2)}\n`);

    applyPlan({ projectRoot: root, planPath: legacyPath, approval: legacy.planHash });

    expect(checkProject(root).ok).toBe(true);
  });

  it("deterministically upgrades a legacy compiler, inherits every profile, applies, and rolls back", () => {
    const root = temporaryProject();
    approvedSources(root);
    evaluationContract(root);
    write(root, "package.json", JSON.stringify({ dependencies: { typescript: "1" } }));
    write(root, "package-lock.json", "{}\n");
    write(root, "tsconfig.json", "{}\n");
    write(root, "src/service.ts", "export const userId = 1;\n");
    applyCurrentPolicy(root, {
      projectRoot: root,
      profile: "custom",
      stacks: ["typescript"],
      deliveryProfiles: ["worktree-delivery"],
      domainProfiles: ["game-development"],
      qualityProfiles: ["eval-driven-development"],
    });
    intakeProject({
      projectRoot: root,
      owner: "replacement-owner",
      approveSources: true,
      now: new Date("2026-01-01T00:00:03Z"),
    });
    write(root, ".harness/discovery.json", `${JSON.stringify(discoverProject(root, new Date("2026-01-01T00:00:04Z")), null, 2)}\n`);
    const originalPolicy = rewriteAppliedPolicy(root, (policy) => {
      delete policy.compiler;
      const project = policy.project as Record<string, unknown>;
      delete project.profile;
      project.phase = "maintenance";
      policy.policies = (policy.policies as Array<{ id: string }>).filter((rule) => rule.id !== "eval-judge-calibration");
    });
    const originalAgents = readFileSync(join(root, "AGENTS.md"), "utf8");
    const now = new Date("2026-01-02T00:00:00Z");

    const first = planProjectUpgrade({ projectRoot: root, now });
    const second = planProjectUpgrade({ projectRoot: root, now });

    expect(first.planHash).toBe(second.planHash);
    expect(first.plan?.update).toMatchObject({
      from: { compiler: null, compilerStatus: "legacy-version-unknown" },
      inherited: {
        profile: "custom",
        owner: "owner",
        stacks: ["typescript"],
        deliveryProfiles: ["worktree-delivery"],
        domainProfiles: ["game-development"],
        qualityProfiles: ["eval-driven-development"],
        phase: "maintenance",
      },
      rules: { added: ["eval-judge-calibration"] },
      adapterCoverage: {
        before: expect.any(Array),
        after: expect.any(Array),
        added: expect.any(Array),
        removed: expect.any(Array),
      },
      weakening: { detected: false, approved: true },
    });
    expect(first.policy.project.owner).toBe("owner");
    expect(first.policy.policies.every((rule) => rule.owner === "owner")).toBe(true);
    expect(() => applyPlan({ projectRoot: root, planPath: first.planPath!, approval: "0".repeat(64) }))
      .toThrow(/APPROVAL_MISMATCH/u);
    const tamperedPath = ".harness/plans/tampered-upgrade.json";
    const tampered = JSON.parse(readFileSync(join(root, first.planPath!), "utf8"));
    tampered.warnings.push("tampered");
    write(root, tamperedPath, `${JSON.stringify(tampered, null, 2)}\n`);
    expect(() => applyPlan({ projectRoot: root, planPath: tamperedPath, approval: first.planHash! }))
      .toThrow(/PLAN_TAMPERED/u);
    const falseMetadataPath = ".harness/plans/false-update-metadata.json";
    const falseMetadata = JSON.parse(readFileSync(join(root, first.planPath!), "utf8"));
    falseMetadata.update.from.policyDigest = "0".repeat(64);
    const unsigned = { ...falseMetadata };
    delete unsigned.planHash;
    falseMetadata.planHash = hashObject(unsigned);
    write(root, falseMetadataPath, `${JSON.stringify(falseMetadata, null, 2)}\n`);
    expect(() => applyPlan({ projectRoot: root, planPath: falseMetadataPath, approval: falseMetadata.planHash }))
      .toThrow(/UPDATE_METADATA_INVALID/u);
    for (const path of ["docs/PRD.md", ".harness/intake.json", ".harness/discovery.json"]) {
      const content = readFileSync(join(root, path), "utf8");
      write(root, path, `${content}\n`);
      expect(() => applyPlan({ projectRoot: root, planPath: first.planPath!, approval: first.planHash! }))
        .toThrow(/STALE_PRECONDITION/u);
      write(root, path, content);
      expect(readFileSync(join(root, ".harness/policy.yaml"), "utf8")).toBe(originalPolicy);
    }
    write(root, "AGENTS.md", "concurrent target edit\n");
    expect(() => applyPlan({ projectRoot: root, planPath: first.planPath!, approval: first.planHash! }))
      .toThrow(/STALE_PRECONDITION/u);
    write(root, "AGENTS.md", originalAgents);
    const change = applyPlan({ projectRoot: root, planPath: first.planPath!, approval: first.planHash! });
    expect(change.operations
      .filter((operation) => operation.beforeHash === operation.afterHash)
      .every((operation) => operation.backupPath === null)).toBe(true);
    expect(applyPlan({ projectRoot: root, planPath: first.planPath!, approval: first.planHash! })).toEqual(change);
    expect(checkProject(root).ok).toBe(true);
    expect(JSON.parse(readFileSync(join(root, ".harness/policy.yaml"), "utf8")).project).toMatchObject({
      profile: "custom",
      phase: "maintenance",
      deliveryProfiles: ["worktree-delivery"],
      domainProfiles: ["game-development"],
      qualityProfiles: ["eval-driven-development"],
    });
    rollbackChange({ projectRoot: root, changeId: change.id });
    expect(readFileSync(join(root, ".harness/policy.yaml"), "utf8")).toBe(originalPolicy);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(originalAgents);
  });

  it("blocks weakening until a fresh owner intake approves its digest and exact rule IDs", () => {
    const root = temporaryProject();
    fullTypeScriptProject(root);
    applyCurrentPolicy(root);
    rewriteAppliedPolicy(root, (policy) => {
      const template = (policy.policies as Array<Record<string, unknown>>)[0];
      template.formalization = "deterministic";
      template.scope = {
        ...(template.scope as Record<string, unknown>),
        include: ["**/*", "legacy/**/*"],
        exclude: [],
        boundaries: ["code", "api"],
      };
      template.targets = [
        ...(template.targets as unknown[]),
        { kind: "custom-command", adapter: "legacy", command: ["node", "legacy-check.mjs"] },
      ];
      template.verification = {
        ...(template.verification as Record<string, unknown>),
        commands: [
          ...((template.verification as { commands: string[][] }).commands),
          ["node", "legacy-check.mjs"],
        ],
      };
      (policy.policies as Array<Record<string, unknown>>).push({
        ...template,
        id: "legacy-extra-rule",
        title: "Legacy extra rule",
      });
    });
    const unapproved = planProjectUpgrade({ projectRoot: root, now: new Date("2026-01-02T00:00:00Z") });
    expect(unapproved.plan?.update?.weakening).toMatchObject({
      detected: true,
      approved: false,
      ruleIds: ["legacy-extra-rule", "single-implementation-owner"],
    });
    expect(unapproved.plan?.update?.rules.changed.find((change) => change.ruleId === "single-implementation-owner")?.fields.map((field) => field.field))
      .toEqual(expect.arrayContaining(["formalization", "scope.include", "scope.exclude", "scope.boundaries", "targets", "verification"]));
    expect(() => applyPlan({ projectRoot: root, planPath: unapproved.planPath!, approval: unapproved.planHash! }))
      .toThrow(/WEAKENING_APPROVAL_REQUIRED/u);

    const weakening = unapproved.plan!.update!.weakening;
    intakeProject({
      projectRoot: root,
      owner: "owner",
      approveSources: true,
      approveWeakening: weakening.digest,
      weakeningRuleIds: weakening.ruleIds,
      now: new Date("2026-01-02T00:00:01Z"),
    });
    write(root, ".harness/discovery.json", `${JSON.stringify(discoverProject(root, new Date("2026-01-02T00:00:02Z")), null, 2)}\n`);
    const approved = planProjectUpgrade({ projectRoot: root, now: new Date("2026-01-02T00:00:03Z") });
    expect(approved.plan?.update?.weakening.approved).toBe(true);
    applyPlan({ projectRoot: root, planPath: approved.planPath!, approval: approved.planHash! });
    expect(checkProject(root).ok).toBe(true);
  });

  it("treats lower eval thresholds and removed known-bad controls as weakening", () => {
    const root = temporaryProject();
    approvedSources(root);
    hardenedEvaluationContract(root);
    write(root, "package.json", JSON.stringify({ dependencies: { typescript: "1" } }));
    write(root, "package-lock.json", "{}\n");
    write(root, "tsconfig.json", "{}\n");
    write(root, "src/service.ts", "export const userId = 1;\n");
    applyCurrentPolicy(root, {
      projectRoot: root,
      profile: "custom",
      stacks: ["typescript"],
      qualityProfiles: ["eval-driven-development"],
    });
    const contract = JSON.parse(readFileSync(join(root, "evals/evals.json"), "utf8"));
    contract.schemaVersion = "1.0";
    contract.suites[0].target.threshold = 0.5;
    delete contract.suites[0].negativeControl;
    write(root, "evals/evals.json", `${JSON.stringify(contract, null, 2)}\n`);
    intakeProject({
      projectRoot: root,
      owner: "owner",
      approveSources: true,
      now: new Date("2026-01-02T00:00:00Z"),
    });
    write(root, ".harness/discovery.json", `${JSON.stringify(discoverProject(root, new Date("2026-01-02T00:00:01Z")), null, 2)}\n`);

    const result = planProjectUpdate({ projectRoot: root, now: new Date("2026-01-02T00:00:02Z") });

    expect(result.plan?.update?.evaluations.changed).toEqual([
      expect.objectContaining({ suiteId: "representative-quality" }),
    ]);
    expect(result.plan?.update?.weakening).toMatchObject({
      detected: true,
      approved: false,
      ruleIds: ["representative-quality-gate"],
      reasons: expect.arrayContaining([
        expect.stringContaining("target threshold"),
        expect.stringContaining("known-bad control removed"),
      ]),
    });
    expect(() => applyPlan({ projectRoot: root, planPath: result.planPath!, approval: result.planHash! }))
      .toThrow(/WEAKENING_APPROVAL_REQUIRED/u);
  });

  it("rejects an unprovable legacy eval history and a false manifest policy digest", () => {
    const legacy = temporaryProject();
    approvedSources(legacy);
    hardenedEvaluationContract(legacy);
    write(legacy, "package.json", JSON.stringify({ dependencies: { typescript: "1" } }));
    write(legacy, "package-lock.json", "{}\n");
    write(legacy, "tsconfig.json", "{}\n");
    write(legacy, "src/service.ts", "export const userId = 1;\n");
    applyCurrentPolicy(legacy, {
      projectRoot: legacy,
      profile: "custom",
      stacks: ["typescript"],
      qualityProfiles: ["eval-driven-development"],
    });
    rewriteAppliedPolicy(legacy, (policy) => { delete policy.evaluations; });
    const contract = JSON.parse(readFileSync(join(legacy, "evals/evals.json"), "utf8"));
    contract.suites[0].target.threshold = 0.5;
    write(legacy, "evals/evals.json", `${JSON.stringify(contract, null, 2)}\n`);
    intakeProject({ projectRoot: legacy, owner: "owner", approveSources: true, now: new Date("2026-01-02T00:00:00Z") });
    write(legacy, ".harness/discovery.json", `${JSON.stringify(discoverProject(legacy, new Date("2026-01-02T00:00:01Z")), null, 2)}\n`);
    expect(() => planProjectUpdate({ projectRoot: legacy })).toThrow(/EVAL_SEMANTICS_HISTORY_REQUIRED/u);

    const digest = temporaryProject();
    fullTypeScriptProject(digest);
    applyCurrentPolicy(digest);
    const manifest = JSON.parse(readFileSync(join(digest, ".harness/manifest.json"), "utf8"));
    manifest.policyDigest = "0".repeat(64);
    write(digest, ".harness/manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
    expect(() => planProjectUpdate({ projectRoot: digest })).toThrow(/MANIFEST_POLICY_DIGEST_MISMATCH/u);
  });

  it("adopts a legacy eval snapshot only through an exact-hash migration plan", () => {
    const root = temporaryProject();
    approvedSources(root);
    hardenedEvaluationContract(root);
    write(root, "package.json", JSON.stringify({ dependencies: { typescript: "1" } }));
    write(root, "package-lock.json", "{}\n");
    write(root, "tsconfig.json", "{}\n");
    write(root, "src/service.ts", "export const userId = 1;\n");
    applyCurrentPolicy(root, {
      projectRoot: root,
      profile: "custom",
      stacks: ["typescript"],
      qualityProfiles: ["eval-driven-development"],
    });
    rewriteAppliedPolicy(root, (policy) => { delete policy.evaluations; });
    const legacyPolicy = readFileSync(join(root, ".harness/policy.yaml"), "utf8");
    const contract = JSON.parse(readFileSync(join(root, "evals/evals.json"), "utf8"));
    contract.suites[0].target.threshold = 0.5;
    write(root, "evals/evals.json", `${JSON.stringify(contract, null, 2)}\n`);
    intakeProject({ projectRoot: root, owner: "owner", approveSources: true, now: new Date("2026-01-02T00:00:00Z") });
    write(root, ".harness/discovery.json", `${JSON.stringify(discoverProject(root, new Date("2026-01-02T00:00:01Z")), null, 2)}\n`);

    expect(() => planProjectUpdate({ projectRoot: root })).toThrow(/EVAL_SEMANTICS_HISTORY_REQUIRED/u);
    const planned = planProjectUpdate({
      projectRoot: root,
      migrateLegacyEvalSnapshot: true,
      now: new Date("2026-01-02T00:00:02Z"),
    });
    expect(planned.plan?.legacyEvalSnapshotMigration).toMatchObject({
      kind: "legacy-eval-snapshot-adoption",
      historicalContinuity: "unavailable",
      historicalEvalSources: expect.arrayContaining([expect.objectContaining({ path: "evals/evals.json" })]),
      currentApprovedEvalSources: expect.arrayContaining([expect.objectContaining({ path: "evals/evals.json" })]),
      candidateEvaluations: expect.objectContaining({ schemaVersion: "1.1" }),
      affectedSuites: [{ suiteId: "representative-quality", requirementIds: ["PRD-AI-004"], ruleIds: ["representative-quality-gate"] }],
    });
    expect(readFileSync(join(root, ".harness/policy.yaml"), "utf8")).toBe(legacyPolicy);
    expect(() => applyPlan({ projectRoot: root, planPath: planned.planPath!, approval: "0".repeat(64) }))
      .toThrow(/APPROVAL_MISMATCH/u);
    expect(readFileSync(join(root, ".harness/policy.yaml"), "utf8")).toBe(legacyPolicy);
    expect(existsSync(join(root, `.harness/changes/${planned.plan!.id}/change.json`))).toBe(false);
    const tampered = JSON.parse(readFileSync(join(root, planned.planPath!), "utf8"));
    tampered.legacyEvalSnapshotMigration.legacyPolicyDigest = "0".repeat(64);
    const unsigned = { ...tampered };
    delete unsigned.planHash;
    tampered.planHash = hashObject(unsigned);
    const tamperedPath = ".harness/plans/tampered-legacy-eval-migration.json";
    write(root, tamperedPath, `${JSON.stringify(tampered, null, 2)}\n`);
    expect(() => applyPlan({ projectRoot: root, planPath: tamperedPath, approval: tampered.planHash }))
      .toThrow(/LEGACY_EVAL_SNAPSHOT_MIGRATION_INVALID/u);
    expect(readFileSync(join(root, ".harness/policy.yaml"), "utf8")).toBe(legacyPolicy);
    const snapshotTampered = JSON.parse(readFileSync(join(root, planned.planPath!), "utf8"));
    const policyOperation = snapshotTampered.operations.find((operation: { path: string }) => operation.path === ".harness/policy.yaml");
    const candidatePolicy = JSON.parse(policyOperation.content);
    candidatePolicy.evaluations.suites[0].target.threshold = 0.25;
    policyOperation.content = `${JSON.stringify(candidatePolicy, null, 2)}\n`;
    policyOperation.afterHash = sha256(policyOperation.content);
    snapshotTampered.legacyEvalSnapshotMigration.candidateEvaluations = candidatePolicy.evaluations;
    const snapshotUnsigned = { ...snapshotTampered };
    delete snapshotUnsigned.planHash;
    snapshotTampered.planHash = hashObject(snapshotUnsigned);
    const snapshotTamperedPath = ".harness/plans/tampered-legacy-eval-snapshot.json";
    write(root, snapshotTamperedPath, `${JSON.stringify(snapshotTampered, null, 2)}\n`);
    expect(() => applyPlan({ projectRoot: root, planPath: snapshotTamperedPath, approval: snapshotTampered.planHash }))
      .toThrow(/LEGACY_EVAL_SNAPSHOT_MIGRATION_INVALID: candidate evaluations/u);
    expect(readFileSync(join(root, ".harness/policy.yaml"), "utf8")).toBe(legacyPolicy);

    applyPlan({
      projectRoot: root,
      planPath: planned.planPath!,
      approval: planned.planHash!,
      now: new Date("2026-01-02T00:00:02Z"),
    });
    const migratedPolicy = JSON.parse(readFileSync(join(root, ".harness/policy.yaml"), "utf8"));
    expect(migratedPolicy.evaluations).toMatchObject({ schemaVersion: "1.1" });
    const receipt = JSON.parse(readFileSync(join(root, `.harness/changes/${planned.plan!.id}/change.json`), "utf8"));
    expect(receipt).toMatchObject({
      appliedAt: "2026-01-02T00:00:02.000Z",
      planHash: planned.planHash,
      legacyEvalSnapshotMigration: {
        kind: "legacy-eval-snapshot-adoption",
        owner: "owner",
        before: {
          evaluationsSnapshot: "absent",
          policyDigest: planned.plan!.legacyEvalSnapshotMigration!.legacyPolicyDigest,
        },
        after: {
          policyDigest: hashObject(migratedPolicy),
          evaluationsSha256: hashObject(migratedPolicy.evaluations),
          approvedEvalSources: planned.plan!.legacyEvalSnapshotMigration!.currentApprovedEvalSources,
        },
      },
    });
    expect(() => planProjectUpdate({ projectRoot: root, migrateLegacyEvalSnapshot: true }))
      .toThrow(/LEGACY_EVAL_SNAPSHOT_MIGRATION_NOT_REQUIRED/u);

    contract.suites[0].target.threshold = 0.25;
    write(root, "evals/evals.json", `${JSON.stringify(contract, null, 2)}\n`);
    intakeProject({ projectRoot: root, owner: "owner", approveSources: true, now: new Date("2026-01-02T00:00:03Z") });
    write(root, ".harness/discovery.json", `${JSON.stringify(discoverProject(root, new Date("2026-01-02T00:00:04Z")), null, 2)}\n`);
    const subsequent = planProjectUpdate({ projectRoot: root, now: new Date("2026-01-02T00:00:05Z") });
    expect(subsequent.plan?.update?.evaluations.changed).toEqual([expect.objectContaining({ suiteId: "representative-quality" })]);
    expect(subsequent.plan?.update?.weakening.detected).toBe(true);

    rewriteAppliedPolicy(root, (policy) => {
      delete policy.evaluations;
      policy.sources = (policy.sources as Array<{ kind: string }>).filter((source) => source.kind !== "eval");
    });
    const noHistory = planProjectUpdate({ projectRoot: root, migrateLegacyEvalSnapshot: true, now: new Date("2026-01-02T00:00:06Z") });
    expect(noHistory.plan?.legacyEvalSnapshotMigration?.historicalEvalSources).toEqual([]);
  });

  it("stops before writing a plan when approved sources or discovery facts drift", () => {
    const sourceRoot = temporaryProject();
    fullTypeScriptProject(sourceRoot);
    applyCurrentPolicy(sourceRoot);
    const sourcePlans = readdirSync(join(sourceRoot, ".harness/plans")).sort();
    write(sourceRoot, "docs/PRD.md", "# drifted\n");
    expect(() => planProjectUpgrade({ projectRoot: sourceRoot })).toThrow(/SOURCE_DRIFT/u);
    expect(readdirSync(join(sourceRoot, ".harness/plans")).sort()).toEqual(sourcePlans);

    const discoveryRoot = temporaryProject();
    fullTypeScriptProject(discoveryRoot);
    applyCurrentPolicy(discoveryRoot);
    const discoveryPlans = readdirSync(join(discoveryRoot, ".harness/plans")).sort();
    const packageJson = JSON.parse(readFileSync(join(discoveryRoot, "package.json"), "utf8"));
    packageJson.scripts.build = "tsc";
    write(discoveryRoot, "package.json", JSON.stringify(packageJson));
    expect(() => planProjectUpgrade({ projectRoot: discoveryRoot })).toThrow(/DISCOVERY_DRIFT/u);
    expect(readdirSync(join(discoveryRoot, ".harness/plans")).sort()).toEqual(discoveryPlans);
  });

  it("never expands the TypeScript adoption baseline during an ordinary upgrade", () => {
    const root = temporaryProject();
    fullTypeScriptProject(root);
    write(root, "src/userService.ts", "export const legacy_name = 1;\n");
    intakeProject({
      projectRoot: root,
      owner: "owner",
      approveSources: true,
      approveTypeScriptNamingAdoption: true,
      now: new Date("2026-01-01T00:00:00Z"),
    });
    write(root, ".harness/discovery.json", `${JSON.stringify(discoverProject(root, new Date("2026-01-01T00:00:01Z")), null, 2)}\n`);
    const adopted = planProject({ projectRoot: root, adoptTypeScriptNaming: true, now: new Date("2026-01-01T00:00:02Z") });
    applyPlan({ projectRoot: root, planPath: adopted.path, approval: adopted.plan.planHash });
    write(root, "src/userService.ts", "export const userId = 1;\n");
    const shrink = planProjectUpgrade({ projectRoot: root, now: new Date("2026-01-02T00:00:00Z") });
    expect(shrink.plan?.update?.baseline).toMatchObject({ before: [expect.any(String)], after: [], added: [], removed: [expect.any(String)] });
    applyPlan({ projectRoot: root, planPath: shrink.planPath!, approval: shrink.planHash! });
    write(root, "src/userService.ts", "export const legacy_name = 1;\nexport const new_debt = 2;\n");

    const upgrade = planProjectUpgrade({ projectRoot: root, now: new Date("2026-01-03T00:00:00Z") });

    expect(upgrade).toMatchObject({ status: "current", plan: null, planPath: null });
    expect(upgrade.policy.typescriptNamingBaseline?.fingerprints).toEqual([]);
    expect(checkProject(root)).toMatchObject({ ok: false, violations: expect.arrayContaining([
      expect.stringContaining("legacy_name"),
      expect.stringContaining("new_debt"),
    ]) });
    expect(() => planProjectUpgrade({ projectRoot: root, adoptTypeScriptNaming: true }))
      .toThrow(/TYPESCRIPT_NAMING_ADOPTION_DRIFT/u);
  });

  it("preserves legacy worktree values in a separate plan and never changes the worktree set", () => {
    const root = realpathSync.native(temporaryProject());
    fullTypeScriptProject(root);
    execFileSync("git", ["init", "-b", "main"], { cwd: root });
    execFileSync("git", ["config", "user.email", "harness@example.test"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Harness Test"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-m", "test: initialize fixture"], { cwd: root });
    applyCurrentPolicy(root);
    const legacyConfig = {
      schemaVersion: "1.0",
      mode: "audit-only",
      managementBranch: "main",
      maxPersistentWorktrees: 7,
      leaseTtlHours: 101,
      reviewTtlMinutes: 17,
      remoteBranchRetentionDays: 9,
      remoteBranchDeletion: false,
      provider: { kind: "github", repository: "example/project" },
      allowedRoots: [join(root, "..")],
      protectedRoots: [root, join(root, ".git"), parse(root).root],
    };
    write(root, ".harness/worktree-delivery.json", `${JSON.stringify(legacyConfig, null, 2)}\n`);
    const leaseDir = join(root, ".git/harness/worktree-delivery/leases");
    mkdirSync(leaseDir, { recursive: true });
    write(root, ".git/harness/worktree-delivery/leases/issue-24.json", `${JSON.stringify({
      schemaVersion: "1.0",
      workItem: "github:example/project#24",
      branch: "main",
      path: root,
      owner: "owner",
      acceptedCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
      createdAt: "2026-01-01T00:00:00.000Z",
      heartbeatAt: "2026-01-01T00:00:00.000Z",
      status: "active",
    }, null, 2)}\n`);
    const marker = join(root, "network-command-called");
    for (const command of ["gh", "npm", "npx", "curl"]) {
      const executable = process.platform === "win32" ? `bin/${command}.cmd` : `bin/${command}`;
      write(root, executable, process.platform === "win32"
        ? "@echo called>>\"%HARNESS_NETWORK_MARKER%\"\r\n@exit /b 1\r\n"
        : "#!/bin/sh\nprintf called >> \"$HARNESS_NETWORK_MARKER\"\nexit 1\n");
      if (process.platform !== "win32") chmodSync(join(root, executable), 0o755);
    }
    const previousPath = process.env.PATH;
    const previousMarker = process.env.HARNESS_NETWORK_MARKER;
    process.env.PATH = `${join(root, "bin")}${delimiter}${previousPath ?? ""}`;
    process.env.HARNESS_NETWORK_MARKER = marker;
    const worktreesBefore = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: root, encoding: "utf8" });

    let upgrade: ReturnType<typeof planProjectUpgrade>;
    let workspacePlan: { planHash: string; operation: { content: string; hostBindingContent: string } };
    try {
      upgrade = planProjectUpgrade({ projectRoot: root, now: new Date("2026-01-02T00:00:00Z") });
      workspacePlan = JSON.parse(readFileSync(join(root, upgrade.worktree.configurationPlanPath!), "utf8"));
      applyPlan({
        projectRoot: root,
        planPath: upgrade.worktree.configurationPlanPath!,
        approval: workspacePlan.planHash,
      });
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousMarker === undefined) delete process.env.HARNESS_NETWORK_MARKER;
      else process.env.HARNESS_NETWORK_MARKER = previousMarker;
    }
    const portable = { ...legacyConfig } as Record<string, unknown>;
    delete portable.allowedRoots;
    delete portable.protectedRoots;
    expect(upgrade).toMatchObject({ status: "current", planPath: null, planHash: null });
    expect(upgrade.worktree).toMatchObject({ status: "configuration-plan-required", configurationPlanHash: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    expect(JSON.parse(workspacePlan.operation.content)).toEqual(portable);
    expect(JSON.parse(workspacePlan.operation.hostBindingContent)).toMatchObject({
      allowedRoots: legacyConfig.allowedRoots,
      protectedRoots: legacyConfig.protectedRoots,
      approval: { mode: "manual" },
    });
    expect(execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: root, encoding: "utf8" })).toBe(worktreesBefore);
  });

  it("reports an invalid worktree schema as blocked without writing either plan", () => {
    const root = temporaryProject();
    fullTypeScriptProject(root);
    execFileSync("git", ["init", "-b", "main"], { cwd: root });
    execFileSync("git", ["config", "user.email", "harness@example.test"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Harness Test"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-m", "test: initialize fixture"], { cwd: root });
    applyCurrentPolicy(root);
    write(root, ".harness/worktree-delivery.json", '{"schemaVersion":"unknown"}\n');
    const before = readdirSync(join(root, ".harness/plans")).sort();

    expect(() => planProjectUpdate({ projectRoot: root, now: new Date("2026-01-02T00:00:00Z") }))
      .toThrow(/WORKTREE_UPDATE_BLOCKED/u);
    expect(readdirSync(join(root, ".harness/plans")).sort()).toEqual(before);
  });

  it("reports a topology migration boundary without moving directories", () => {
    const root = temporaryProject();
    fullTypeScriptProject(root);
    execFileSync("git", ["init", "-b", "main"], { cwd: root });
    execFileSync("git", ["config", "user.email", "harness@example.test"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Harness Test"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-m", "test: initialize fixture"], { cwd: root });
    applyCurrentPolicy(root);
    const configuration = planWorkspaceConfiguration({ projectRoot: root, mode: "audit-only", managementBranch: "main", allowedRoots: [join(root, "..")] });
    applyPlan({ projectRoot: root, planPath: configuration.path, approval: configuration.plan.planHash });
    const container = temporaryProject();
    write(root, ".git/harness/worktree-delivery/host-binding.json", `${JSON.stringify({
      schemaVersion: "1.0",
      allowedRoots: [join(container, "worktrees")],
      protectedRoots: [join(container, "main"), join(container, "main/.git"), parse(container).root],
      topology: {
        kind: "container-v1",
        workspaceContainer: container,
        managementCheckout: join(container, "main"),
        persistentWorktreeRoot: join(container, "worktrees"),
      },
      approval: { mode: "manual" },
    }, null, 2)}\n`);
    const before = readdirSync(container).sort();
    const worktreesBefore = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: root, encoding: "utf8" });

    const upgrade = planProjectUpgrade({ projectRoot: root, now: new Date("2026-01-02T00:00:00Z") });

    expect(upgrade).toMatchObject({
      status: "current",
      planPath: null,
      planHash: null,
      worktree: {
        status: "migration-required",
        migrationCommand: ["harness-automation", "worktree", "migrate", "--workspace-container", "<absolute-path>", "--project", root],
      },
    });
    expect(readdirSync(container).sort()).toEqual(before);
    expect(execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: root, encoding: "utf8" })).toBe(worktreesBefore);
  });
});
