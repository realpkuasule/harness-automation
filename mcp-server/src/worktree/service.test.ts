import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashObject, prettyJson, sha256, withoutHash } from "../v2/fs.js";
import type { WorktreeApprovalPolicy, WorktreeDelegatableOperation } from "./types.js";
import {
  applyWorkspacePlan,
  applyWorkspaceMigration,
  auditWorkspace,
  parseWorkspaceAdoptionManifest,
  parseWorktreePorcelain,
  planWorkspaceAdoption,
  planWorkspaceAllocation,
  planWorkspaceClose,
  planWorkspaceConfiguration,
  planWorkspaceMigration,
  planWorkspaceRebind,
  planWorkspaceRecover,
  planWorkspaceRenew,
  reviewAndApplyWorkspacePlan,
  rollbackWorkspaceChange,
  reviewWorkspace,
  retentionAuditWorkspace,
  workspaceStatus,
} from "./service.js";

const repositories: string[] = [];
const originalPath = process.env.PATH;

function installAdoptionGh(): void {
  const bin = mkdtempSync(join(tmpdir(), "harness-adopt-gh-"));
  repositories.push(bin);
  const script = `const fs = require("node:fs");
const graphql = process.argv.includes("graphql");
if (process.env.HARNESS_TEST_GH_COUNT_FILE) {
  const file = process.env.HARNESS_TEST_GH_COUNT_FILE;
  const count = fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) + 1 : 1;
  fs.writeFileSync(file, String(count));
  if (count > Number(process.env.HARNESS_TEST_GH_FAIL_AFTER || "Infinity")) process.exit(3);
}

const status = process.env.HARNESS_TEST_GH_STATUS || "In Progress";
if (graphql) {
  process.stdout.write(JSON.stringify({ data: { repository: {
    issue0: { projectItems: {
      pageInfo: { hasNextPage: false },
      nodes: process.env.HARNESS_TEST_GH_PROJECT_MISSING ? [] : [{
      project: { number: 2, owner: { __typename: "User", login: "example" } },
      configuredField: { __typename: "ProjectV2ItemFieldSingleSelectValue", name: status }
    }] } }
  } } }));
} else if (process.argv.some((value) => value.includes("repos/example/project/issues/301"))) {
  process.stdout.write(JSON.stringify({
    number: 301,
    state: (process.env.HARNESS_TEST_GH_ISSUE_STATE || "OPEN").toLowerCase(),
    title: "Adopt fixture",
    html_url: "https://github.com/example/project/issues/301"
  }));
} else {
  process.exit(2);
}
`;
  if (process.platform === "win32") {
    writeFileSync(join(bin, "gh.js"), script, "utf8");
    writeFileSync(join(bin, "gh.cmd"), "@node \"%~dp0gh.js\" %*\r\n", "utf8");
  } else {
    const executable = join(bin, "gh");
    writeFileSync(executable, `#!/usr/bin/env node\n${script}`, "utf8");
    chmodSync(executable, 0o755);
  }
  process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
}

function installAiReviewer(): void {
  const bin = mkdtempSync(join(tmpdir(), "harness-ai-reviewer-"));
  repositories.push(bin);
  const script = `const fs = require("node:fs");
const input = fs.readFileSync(0, "utf8");
if (process.env.HARNESS_TEST_AI_INPUT_FILE) fs.writeFileSync(process.env.HARNESS_TEST_AI_INPUT_FILE, input);
if (process.env.HARNESS_TEST_AI_DRIFT_PATH) fs.writeFileSync(process.env.HARNESS_TEST_AI_DRIFT_PATH, "reviewer drift\\n");
if (process.env.HARNESS_TEST_AI_INVALID) process.stdout.write("not-json");
else process.stdout.write(JSON.stringify({ structured_output: {
  verdict: process.env.HARNESS_TEST_AI_VERDICT || "approve",
  reasonCodes: [process.env.HARNESS_TEST_AI_REASON || "INTENT_MATCH"],
  summary: process.env.HARNESS_TEST_AI_SUMMARY || "The exact plan matches the delegated intent."
} }));
`;
  if (process.platform === "win32") {
    writeFileSync(join(bin, "claude.js"), script, "utf8");
    writeFileSync(join(bin, "claude.cmd"), "@node \"%~dp0claude.js\" %*\r\n", "utf8");
  } else {
    const executable = join(bin, "claude");
    writeFileSync(executable, `#!/usr/bin/env node\n${script}`, "utf8");
    chmodSync(executable, 0o755);
  }
  process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-worktree-"));
  repositories.push(root);
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "harness@example.test");
  git(root, "config", "user.name", "Harness Test");
  writeFileSync(join(root, "README.md"), "# fixture\n", "utf8");
  git(root, "add", "README.md");
  git(root, "commit", "-m", "test: initialize fixture");
  return root;
}

function repositoryWithRemote(): string {
  const root = repository();
  const remote = mkdtempSync(join(tmpdir(), "harness-worktree-remote-"));
  repositories.push(remote);
  git(remote, "init", "--bare");
  git(root, "remote", "add", "origin", remote);
  git(root, "push", "-u", "origin", "main");
  return root;
}

function containerRepository(): { container: string; main: string; worktrees: string } {
  const container = mkdtempSync(join(tmpdir(), "harness-container-"));
  repositories.push(container);
  const main = join(container, "main");
  mkdirSync(main);
  git(main, "init", "-b", "main");
  git(main, "config", "user.email", "harness@example.test");
  git(main, "config", "user.name", "Harness Test");
  writeFileSync(join(main, "README.md"), "# fixture\n", "utf8");
  git(main, "add", "README.md");
  git(main, "commit", "-m", "test: initialize container fixture");
  const canonicalContainer = realpathSync.native(container);
  return {
    container: canonicalContainer,
    main: join(canonicalContainer, "main"),
    worktrees: join(canonicalContainer, "worktrees"),
  };
}

function worktreeCount(root: string): number {
  return git(root, "worktree", "list", "--porcelain")
    .split(/\n\n/u)
    .filter(Boolean)
    .length;
}

function configure(
  root: string,
  overrides: Omit<
    Parameters<typeof planWorkspaceConfiguration>[0],
    "projectRoot"
  > = {},
) {
  const planned = planWorkspaceConfiguration({
    projectRoot: root,
    mode: "enforced",
    allowedRoots: [join(root, "..")],
    ...overrides,
  });
  return applyWorkspacePlan({
    projectRoot: root,
    planPath: planned.path,
    approval: planned.plan.planHash,
  });
}

function delegatedApproval(
  allowedOperations: WorktreeDelegatableOperation[],
  planTtlSeconds = 600,
): Extract<WorktreeApprovalPolicy, { mode: "delegated-ai" }> {
  return {
    mode: "delegated-ai",
    reviewer: { kind: "claude", model: "test-reviewer" },
    allowedOperations,
    planTtlSeconds,
    reviewerTimeoutSeconds: 30,
  };
}

afterEach(() => {
  process.env.PATH = originalPath;
  delete process.env.HARNESS_TEST_GH_STATUS;
  delete process.env.HARNESS_TEST_GH_PROJECT_MISSING;
  delete process.env.HARNESS_TEST_GH_ISSUE_STATE;
  delete process.env.HARNESS_TEST_GH_COUNT_FILE;
  delete process.env.HARNESS_TEST_GH_FAIL_AFTER;
  delete process.env.HARNESS_TEST_AI_INPUT_FILE;
  delete process.env.HARNESS_TEST_AI_DRIFT_PATH;
  delete process.env.HARNESS_TEST_AI_INVALID;
  delete process.env.HARNESS_TEST_AI_VERDICT;
  delete process.env.HARNESS_TEST_AI_REASON;
  delete process.env.HARNESS_TEST_AI_SUMMARY;
  for (const root of repositories.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("portable worktree inventory", () => {
  it("keeps the adoption manifest schema aligned with trimmed runtime fields", () => {
    const schema = JSON.parse(readFileSync(
      new URL("../../../docs/api/worktree-adopt-v1.schema.json", import.meta.url),
      "utf8",
    ));
    for (const field of ["workItem", "owner", "thread", "branch"]) {
      expect(schema.$defs.item.properties[field].pattern).toContain("\\S");
    }
    expect(() => parseWorkspaceAdoptionManifest({
      schemaVersion: "worktree-adopt/1.0",
      items: [{ workItem: "   ", owner: "owner", path: "/tmp/w", branch: "branch" }],
    })).toThrow(/WORKTREE_ADOPT_INPUT_INVALID/);
  });

  it("parses NUL-delimited porcelain including Windows-style paths", () => {
    expect(parseWorktreePorcelain(
      "worktree C:/code/project\0HEAD abc123\0branch refs/heads/main\0\0",
    )).toEqual([{
      path: "C:/code/project",
      head: "abc123",
      branch: "main",
      bare: false,
      detached: false,
      locked: false,
      prunable: false,
    }]);
  });

  it("parses all porcelain states and rejects a field before a worktree", () => {
    expect(parseWorktreePorcelain(
      "worktree /tmp/bare\0bare\0\0" +
      "worktree /tmp/detached\0HEAD def456\0detached\0locked reason\0prunable gitdir\0",
    )).toEqual([
      expect.objectContaining({ path: "/tmp/bare", bare: true }),
      expect.objectContaining({
        path: "/tmp/detached",
        head: "def456",
        detached: true,
        locked: true,
        prunable: true,
      }),
    ]);
    expect(() => parseWorktreePorcelain("HEAD orphan\0")).toThrow(
      /WORKTREE_PORCELAIN_INVALID/,
    );
  });

  it("runs status and audit without PRD, provider, config, or new worktrees", () => {
    const root = repository();
    const before = worktreeCount(root);

    const status = workspaceStatus(root);
    const audit = auditWorkspace(root);

    expect(status.configured).toBe(false);
    expect(status.loaded).toBe(true);
    expect(status.worktrees).toHaveLength(1);
    expect(audit.passing).toBe(true);
    expect(worktreeCount(root)).toBe(before);
    expect(existsSync(join(root, ".harness"))).toBe(false);
  });

  it("preserves v2.1.3 aggregate untracked observation outside adoption", () => {
    const root = repository();
    const worktreePath = `${root}-legacy-observation`;
    repositories.push(worktreePath);
    git(root, "worktree", "add", "-b", "legacy-observation", worktreePath, "HEAD");
    mkdirSync(join(worktreePath, "nested"));
    writeFileSync(join(worktreePath, "nested", "valuable.txt"), "valuable\n", "utf8");

    const legacy = workspaceStatus(root).worktrees.find((item) => item.path === worktreePath);
    expect(legacy?.dirtyEvidence?.map((item) => item.path) ?? [])
      .not.toContain("nested/valuable.txt");
  });

  it("keeps the configured management checkout out of detached Review orphan findings", () => {
    const root = repository();
    configure(root, { managementBranch: "main" });
    git(root, "add", ".harness/worktree-delivery.json");
    git(root, "commit", "-m", "test: configure management checkout");
    const reviewPath = `${root}-review`;
    repositories.push(reviewPath);
    git(root, "worktree", "add", "--detach", reviewPath, "HEAD");

    const audit = auditWorkspace(reviewPath);

    expect(audit.passing).toBe(true);
    expect(audit.policies.find(
      (policy) => policy.id === "workspace.mapping-consistency",
    )?.evidence).toEqual([]);
    git(root, "worktree", "remove", reviewPath);
  });

  it("fails closed when the configured management branch has no checkout", () => {
    const root = repository();
    configure(root, { managementBranch: "trunk" });

    const mapping = auditWorkspace(root).policies.find(
      (policy) => policy.id === "workspace.mapping-consistency",
    );

    expect(mapping).toMatchObject({ passing: false, status: "failing" });
    expect(mapping?.evidence).toEqual([
      "management checkout not found for branch: trunk",
    ]);
  });

  it("fails closed when multiple checkouts claim the management branch", () => {
    const root = repository();
    configure(root, { managementBranch: "main" });
    const duplicatePath = `${root}-duplicate-main`;
    repositories.push(duplicatePath);
    git(root, "worktree", "add", "--detach", duplicatePath, "HEAD");
    git(duplicatePath, "symbolic-ref", "HEAD", "refs/heads/main");

    const mapping = auditWorkspace(root).policies.find(
      (policy) => policy.id === "workspace.mapping-consistency",
    );

    expect(mapping).toMatchObject({ passing: false, status: "failing" });
    expect(mapping?.evidence).toEqual([
      "multiple management checkouts found for branch: main",
    ]);
    git(root, "worktree", "remove", duplicatePath);
  });

  it("reports duplicate persistent leases for one work item", () => {
    const root = repository();
    const commonDir = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
    const leaseDir = join(commonDir, "harness", "worktree-delivery", "leases");
    mkdirSync(leaseDir, { recursive: true });
    const base = {
      schemaVersion: "1.0",
      workItem: "github:example/project#24",
      branch: "issue-24",
      owner: "owner",
      acceptedCommit: "abc123",
      createdAt: "2026-01-01T00:00:00.000Z",
      heartbeatAt: "2026-01-01T00:00:00.000Z",
      status: "active",
    };
    writeFileSync(join(leaseDir, "a.json"), JSON.stringify({
      ...base,
      path: join(root, "..", "one"),
    }));
    writeFileSync(join(leaseDir, "b.json"), JSON.stringify({
      ...base,
      path: join(root, "..", "two"),
    }));

    const audit = auditWorkspace(root);
    const result = audit.policies.find(
      (policy) => policy.id === "workspace.issue-single-persistent-lease",
    );

    expect(audit.passing).toBe(false);
    expect(result).toMatchObject({ enforced: true, passing: false, status: "failing" });
    expect(result?.evidence).toEqual(expect.arrayContaining([
      expect.stringContaining("github:example/project#24"),
    ]));
  });

  it("fails closed on malformed worktree configuration fields", () => {
    const root = repository();
    const configDirectory = join(root, ".harness");
    const configPath = join(configDirectory, "worktree-delivery.json");
    mkdirSync(configDirectory, { recursive: true });
    const base = {
      ...workspaceStatus(root).config,
      allowedRoots: [join(root, "..")],
    };
    const invalid: Array<[string, Record<string, unknown>]> = [
      ["schemaVersion", { schemaVersion: "2.0" }],
      ["mode", { mode: "maybe" }],
      ["managementBranch", { managementBranch: "" }],
      ["maxPersistentWorktrees", { maxPersistentWorktrees: 0 }],
      ["leaseTtlHours", { leaseTtlHours: 0 }],
      ["reviewTtlMinutes", { reviewTtlMinutes: 0 }],
      ["remoteBranchRetentionDays", { remoteBranchRetentionDays: 0 }],
      ["allowedRoots", { allowedRoots: "not-an-array" }],
      ["protectedRoots", { protectedRoots: [1] }],
      ["remoteBranchDeletion", { remoteBranchDeletion: true }],
      ["provider", { provider: undefined }],
      ["provider.kind", { provider: { kind: "unknown" } }],
    ];

    for (const [name, patch] of invalid) {
      writeFileSync(configPath, JSON.stringify({ ...base, ...patch }));
      expect(
        () => workspaceStatus(root),
        `configuration field ${name} should be rejected`,
      ).toThrow(/WORKTREE_CONFIG_INVALID/);
    }
    rmSync(configPath);
    expect(() => planWorkspaceConfiguration({
      projectRoot: root,
      reviewTtlMinutes: 0,
    })).toThrow(/WORKTREE_CONFIG_INVALID/);
    expect(() => planWorkspaceConfiguration({
      projectRoot: root,
      allowedRoots: [],
    })).toThrow(/WORKTREE_HOST_BINDING_INVALID/);
    expect(() => planWorkspaceConfiguration({
      projectRoot: root,
      provider: { kind: "github" },
    })).toThrow(/WORKTREE_CONFIG_INVALID/);
  });

  it("reports mapping, protected-root, capacity, dirty, and unique-commit findings", () => {
    const root = repository();
    configure(root, { maxPersistentWorktrees: 1 });
    const unmanagedPath = `${root}-unmanaged`;
    repositories.push(unmanagedPath);
    git(root, "worktree", "add", "--detach", unmanagedPath, "HEAD");
    writeFileSync(join(root, "committed.txt"), "unique\n");
    git(root, "add", "committed.txt");
    git(root, "commit", "-m", "test: unique local commit");
    writeFileSync(join(root, "dirty.txt"), "valuable\n");

    const commonDir = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
    const leaseDir = join(commonDir, "harness", "worktree-delivery", "leases");
    mkdirSync(leaseDir, { recursive: true });
    const timestamp = "2026-01-01T00:00:00.000Z";
    writeFileSync(join(leaseDir, "done.json"), JSON.stringify({
      schemaVersion: "1.0",
      workItem: "github:example/project#done",
      branch: "main",
      path: root,
      owner: "owner",
      acceptedCommit: git(root, "rev-parse", "HEAD"),
      createdAt: timestamp,
      heartbeatAt: timestamp,
      status: "done",
    }));
    writeFileSync(join(leaseDir, "orphan.json"), JSON.stringify({
      schemaVersion: "1.0",
      workItem: "github:example/project#orphan",
      branch: "orphan",
      path: `${root}-missing`,
      owner: "owner",
      acceptedCommit: git(root, "rev-parse", "HEAD"),
      createdAt: timestamp,
      heartbeatAt: timestamp,
      status: "active",
    }));

    const audit = auditWorkspace(root);
    expect(audit.policies.filter((policy) => !policy.passing).map((policy) => policy.id))
      .toEqual(expect.arrayContaining([
      "workspace.mapping-consistency",
      "workspace.root-denylist",
      "workspace.capacity-budget",
      "workspace.lease-ttl",
      "workspace.clean-before-close",
      "workspace.unique-commits-protected",
      "workspace.done-no-persistent-worktree",
      ]));
  });
});

describe("hash-approved worktree lifecycle", () => {
  it("separates portable policy from the host-local path binding", () => {
    const root = repository();
    const allowedRoot = join(root, "..");
    const configured = planWorkspaceConfiguration({
      projectRoot: root,
      mode: "enforced",
      allowedRoots: [allowedRoot],
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    const otherHost = planWorkspaceConfiguration({
      projectRoot: root,
      mode: "enforced",
      allowedRoots: [join(allowedRoot, "other-host")],
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(otherHost.plan.planHash).not.toBe(configured.plan.planHash);
    expect(configured.plan.operation.kind).toBe("configure");
    if (configured.plan.operation.kind !== "configure") return;

    const repositoryPolicy = JSON.parse(configured.plan.operation.content) as Record<string, unknown>;
    expect(repositoryPolicy).not.toHaveProperty("allowedRoots");
    expect(repositoryPolicy).not.toHaveProperty("protectedRoots");
    expect(configured.plan.operation).toHaveProperty(
      "hostBindingPath",
      "harness/worktree-delivery/host-binding.json",
    );

    applyWorkspacePlan({
      projectRoot: root,
      planPath: configured.path,
      approval: configured.plan.planHash,
    });
    const commonDir = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
    const bindingPath = join(commonDir, "harness", "worktree-delivery", "host-binding.json");
    expect(JSON.parse(readFileSync(bindingPath, "utf8"))).toMatchObject({
      allowedRoots: [realpathSync.native(allowedRoot)],
    });
    expect(workspaceStatus(root)).toMatchObject({
      hostBinding: { configured: true, source: "host-local" },
    });
  });

  it("configures a parameterized container topology without plan-time filesystem changes", () => {
    const { container, main, worktrees } = containerRepository();
    const refsBefore = git(main, "for-each-ref", "--format=%(refname)%00%(objectname)");
    const registrationsBefore = git(main, "worktree", "list", "--porcelain");
    const planned = planWorkspaceConfiguration({
      projectRoot: main,
      mode: "enforced",
      managementBranch: "main",
      topology: "container-v1",
      workspaceContainer: container,
    });
    expect(existsSync(worktrees)).toBe(false);
    expect(git(main, "for-each-ref", "--format=%(refname)%00%(objectname)")).toBe(refsBefore);
    expect(git(main, "worktree", "list", "--porcelain")).toBe(registrationsBefore);
    expect(planned.plan.operation).toMatchObject({
      kind: "configure",
      topology: {
        kind: "container-v1",
        workspaceContainer: realpathSync.native(container),
        managementCheckout: realpathSync.native(main),
        persistentWorktreeRoot: worktrees,
      },
      allowedRoot: { path: worktrees, before: "absent" },
    });
    if (planned.plan.operation.kind !== "configure") throw new Error("expected configure plan");
    expect(() => applyWorkspacePlan({
      projectRoot: main,
      planPath: planned.path,
      approval: "0".repeat(64),
    })).toThrow(/APPROVAL_MISMATCH/);
    expect(existsSync(worktrees)).toBe(false);

    const receipt = applyWorkspacePlan({
      projectRoot: main,
      planPath: planned.path,
      approval: planned.plan.planHash,
    });
    expect(receipt.createdDirectories).toEqual([worktrees]);
    expect(receipt.steps).toContainEqual({
      id: "create-allowed-root",
      status: "applied",
      detail: worktrees,
    });
    expect(existsSync(worktrees)).toBe(true);
    expect(readFileSync(join(main, ".harness", "worktree-delivery.json"), "utf8")).toContain("main");
    expect(workspaceStatus(main)).toMatchObject({
      topology: {
        kind: "container-v1",
        workspaceContainer: realpathSync.native(container),
        managementCheckout: realpathSync.native(main),
        persistentWorktreeRoot: worktrees,
        allowedRoots: [worktrees],
      },
      capacity: { used: 0, available: 4 },
    });
    expect(auditWorkspace(main)).toMatchObject({
      topology: { kind: "container-v1", persistentWorktreeRoot: worktrees },
      capacity: { used: 0 },
    });
  });

  it("allocates only from the configured container root and preserves plan-time zero side effects", () => {
    const { container, main, worktrees } = containerRepository();
    const configured = planWorkspaceConfiguration({
      projectRoot: main,
      mode: "enforced",
      managementBranch: "main",
      topology: "container-v1",
      workspaceContainer: container,
    });
    applyWorkspacePlan({ projectRoot: main, planPath: configured.path, approval: configured.plan.planHash });
    const target = join(worktrees, "42");
    const refsBefore = git(main, "for-each-ref", "--format=%(refname)%00%(objectname)");
    const planned = planWorkspaceAllocation({
      projectRoot: main,
      workItem: "github:example/project#42",
      branch: "issue-42",
      path: target,
      owner: "owner",
    });
    expect(existsSync(target)).toBe(false);
    expect(workspaceStatus(main).leases).toHaveLength(0);
    expect(git(main, "for-each-ref", "--format=%(refname)%00%(objectname)")).toBe(refsBefore);
    const receipt = applyWorkspacePlan({
      projectRoot: main,
      planPath: planned.path,
      approval: planned.plan.planHash,
    });
    expect(receipt.status).toBe("applied");
    expect(git(target, "rev-parse", "--show-toplevel")).toBe(target);
    expect(workspaceStatus(main)).toMatchObject({
      capacity: { used: 1, available: 3 },
      leases: [expect.objectContaining({ path: target, branch: "issue-42" })],
      worktrees: expect.arrayContaining([expect.objectContaining({
        path: target,
        gitTopLevel: target,
      })]),
    });
  });

  it("rejects nested, traversing, symlinked, and existing container targets", () => {
    const { container, main, worktrees } = containerRepository();
    const configured = planWorkspaceConfiguration({
      projectRoot: main,
      mode: "enforced",
      managementBranch: "main",
      topology: "container-v1",
      workspaceContainer: container,
    });
    applyWorkspacePlan({ projectRoot: main, planPath: configured.path, approval: configured.plan.planHash });
    const allocate = (path: string) => planWorkspaceAllocation({
      projectRoot: main,
      workItem: `github:example/project#${randomBytes(4).toString("hex")}`,
      branch: `issue-${randomBytes(4).toString("hex")}`,
      path,
      owner: "owner",
    });
    expect(() => allocate(worktrees)).toThrow(/WORKTREE_TOPOLOGY_TARGET_INVALID/);
    expect(() => allocate(join(main, ".worktrees", "1"))).toThrow(/WORKTREE_(PROTECTED_PATH|PATH_NOT_ALLOWED)/);
    expect(() => allocate(`${worktrees}/../escape`)).toThrow(/WORKTREE_PATH_TRAVERSAL/);
    const nonEmpty = join(worktrees, "non-empty");
    mkdirSync(nonEmpty);
    writeFileSync(join(nonEmpty, "keep"), "x", "utf8");
    expect(() => allocate(nonEmpty)).toThrow(/WORKTREE_PATH_EXISTS/);
    const escaped = join(worktrees, "escaped");
    symlinkSync(dirname(worktrees), escaped);
    expect(() => allocate(escaped)).toThrow(/WORKTREE_PATH_NOT_ALLOWED/);
  });

  it("keeps legacy flat checkouts unchanged and emits a plan-only migration preflight", () => {
    const root = repository();
    configure(root, { managementBranch: "main" });
    const targetContainer = join(dirname(root), `harness-migration-${randomBytes(4).toString("hex")}`);
    const canonicalTargetContainer = join(realpathSync.native(dirname(root)), basename(targetContainer));
    const registrationsBefore = git(root, "worktree", "list", "--porcelain");
    const refsBefore = git(root, "for-each-ref", "--format=%(refname)%00%(objectname)");
    const migration = planWorkspaceMigration({ projectRoot: root, workspaceContainer: targetContainer });
    expect(migration.plan.operation).toMatchObject({
      kind: "migrate",
      topology: {
        workspaceContainer: canonicalTargetContainer,
        managementCheckout: join(canonicalTargetContainer, "main"),
        persistentWorktreeRoot: join(canonicalTargetContainer, "worktrees"),
      },
      preflight: {
        managementCheckout: realpathSync.native(root),
        hostBindingHash: expect.any(String),
        referencePaths: expect.arrayContaining([realpathSync.native(root)]),
      },
    });
    expect(existsSync(targetContainer)).toBe(false);
    expect(git(root, "worktree", "list", "--porcelain")).toBe(registrationsBefore);
    expect(git(root, "for-each-ref", "--format=%(refname)%00%(objectname)")).toBe(refsBefore);
    expect(() => applyWorkspacePlan({
      projectRoot: root,
      planPath: migration.path,
      approval: migration.plan.planHash,
    })).toThrow(/WORKTREE_MIGRATION_APPLY_UNSUPPORTED/);
    expect(existsSync(targetContainer)).toBe(false);
  });

  it("moves one exactly approved legacy management checkout into a container topology", () => {
    const root = repository();
    configure(root, { managementBranch: "main" });
    const targetContainer = join(dirname(root), `harness-migration-apply-${randomBytes(4).toString("hex")}`);
    repositories.push(targetContainer);
    const planned = planWorkspaceMigration({ projectRoot: root, workspaceContainer: targetContainer });
    const receipt = applyWorkspaceMigration({
      projectRoot: root,
      planPath: planned.path,
      approval: planned.plan.planHash,
    });
    if (planned.plan.operation.kind !== "migrate") throw new Error("expected migration plan");
    const topology = planned.plan.operation.topology;
    expect(receipt).toMatchObject({
      operation: "migrate",
      status: "applied",
      beforeObservedHash: planned.plan.observedHash,
    });
    expect(existsSync(root)).toBe(false);
    expect(git(topology.managementCheckout, "rev-parse", "--show-toplevel")).toBe(topology.managementCheckout);
    expect(existsSync(topology.persistentWorktreeRoot!)).toBe(true);
    expect(readdirSync(topology.persistentWorktreeRoot!)).toEqual([]);
    expect(workspaceStatus(topology.managementCheckout)).toMatchObject({
      topology: {
        kind: "container-v1",
        workspaceContainer: topology.workspaceContainer,
        managementCheckout: topology.managementCheckout,
        persistentWorktreeRoot: topology.persistentWorktreeRoot,
      },
      capacity: { used: 0, available: 4 },
      leases: [],
      worktrees: [expect.objectContaining({
        path: topology.managementCheckout,
        gitTopLevel: topology.managementCheckout,
        branch: "main",
      })],
    });
    expect(applyWorkspaceMigration({
      projectRoot: topology.managementCheckout,
      planPath: planned.path,
      approval: planned.plan.planHash,
    })).toMatchObject({ status: "applied", operation: "migrate" });
    expect(() => rollbackWorkspaceChange({
      projectRoot: topology.managementCheckout,
      changeId: planned.plan.id,
    })).toThrow(/WORKTREE_MIGRATION_ROLLBACK_UNSUPPORTED/);
  });

  it("rejects migration hash and observed-state drift without creating the target", () => {
    const prepare = () => {
      const root = repository();
      configure(root, { managementBranch: "main" });
      const target = join(dirname(root), `harness-migration-drift-${randomBytes(4).toString("hex")}`);
      return { root, target, planned: planWorkspaceMigration({ projectRoot: root, workspaceContainer: target }) };
    };
    const wrongHash = prepare();
    expect(() => applyWorkspaceMigration({
      projectRoot: wrongHash.root,
      planPath: wrongHash.planned.path,
      approval: "0".repeat(64),
    })).toThrow(/APPROVAL_MISMATCH/);
    expect(existsSync(wrongHash.target)).toBe(false);

    const binding = prepare();
    writeFileSync(workspaceStatus(binding.root).hostBinding.path, "{}", "utf8");
    expect(() => applyWorkspaceMigration({
      projectRoot: binding.root,
      planPath: binding.planned.path,
      approval: binding.planned.plan.planHash,
    })).toThrow(/WORKSPACE_DRIFT|WORKTREE_HOST_BINDING_INVALID/);
    expect(existsSync(binding.target)).toBe(false);

    const dirty = prepare();
    writeFileSync(join(dirty.root, "README.md"), "drift\n", "utf8");
    expect(() => applyWorkspaceMigration({
      projectRoot: dirty.root,
      planPath: dirty.planned.path,
      approval: dirty.planned.plan.planHash,
    })).toThrow(/WORKSPACE_DRIFT/);
    expect(existsSync(dirty.target)).toBe(false);

    const refs = prepare();
    git(refs.root, "commit", "--allow-empty", "-m", "test: ref drift");
    expect(() => applyWorkspaceMigration({
      projectRoot: refs.root,
      planPath: refs.planned.path,
      approval: refs.planned.plan.planHash,
    })).toThrow(/WORKSPACE_DRIFT/);
    expect(existsSync(refs.target)).toBe(false);

    const registration = prepare();
    const extra = `${registration.root}-registered`;
    repositories.push(extra);
    git(registration.root, "worktree", "add", "--detach", extra, "HEAD");
    expect(() => applyWorkspaceMigration({
      projectRoot: registration.root,
      planPath: registration.planned.path,
      approval: registration.planned.plan.planHash,
    })).toThrow(/WORKSPACE_DRIFT/);
    expect(existsSync(registration.target)).toBe(false);
  });

  it("rejects legacy migration targets and persistent lease or worktree drift", () => {
    const root = repository();
    configure(root, { managementBranch: "main" });
    const nonEmpty = mkdtempSync(join(dirname(root), "harness-migration-non-empty-"));
    repositories.push(nonEmpty);
    writeFileSync(join(nonEmpty, "keep"), "x", "utf8");
    expect(() => planWorkspaceMigration({ projectRoot: root, workspaceContainer: nonEmpty }))
      .toThrow(/WORKTREE_MIGRATION_CONTAINER_INVALID/);
    const gitContainer = mkdtempSync(join(dirname(root), "harness-migration-git-"));
    repositories.push(gitContainer);
    git(gitContainer, "init");
    expect(() => planWorkspaceMigration({ projectRoot: root, workspaceContainer: gitContainer }))
      .toThrow(/WORKTREE_MIGRATION_CONTAINER_INVALID/);
    expect(() => planWorkspaceMigration({ projectRoot: root, workspaceContainer: join(root, "inside") }))
      .toThrow(/WORKTREE_MIGRATION_CONTAINER_INVALID/);
    const link = `${root}-migration-link`;
    repositories.push(link);
    symlinkSync(dirname(root), link);
    expect(() => planWorkspaceMigration({ projectRoot: root, workspaceContainer: link }))
      .toThrow(/WORKTREE_MIGRATION_CONTAINER_INVALID/);

    const target = join(dirname(root), `harness-migration-lease-${randomBytes(4).toString("hex")}`);
    const planned = planWorkspaceMigration({ projectRoot: root, workspaceContainer: target });
    const state = join(workspaceStatus(root).commonDir, "harness", "worktree-delivery", "leases");
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "drift.json"), "{}", "utf8");
    expect(() => applyWorkspaceMigration({
      projectRoot: root,
      planPath: planned.path,
      approval: planned.plan.planHash,
    })).toThrow(/WORKSPACE_DRIFT|WORKTREE_MIGRATION_V1_PRECONDITION_FAILED/);
    expect(existsSync(target)).toBe(false);
  });

  it("keeps a durable failed receipt after an interrupted migration without rollback", () => {
    const root = repository();
    configure(root, { managementBranch: "main" });
    const target = join(dirname(root), `harness-migration-failure-${randomBytes(4).toString("hex")}`);
    repositories.push(target);
    const planned = planWorkspaceMigration({ projectRoot: root, workspaceContainer: target });
    if (planned.plan.operation.kind !== "migrate") throw new Error("expected migration plan");
    expect(() => applyWorkspaceMigration({
      projectRoot: root,
      planPath: planned.path,
      approval: planned.plan.planHash,
      testFailAfterMove: true,
    })).toThrow(/TEST_MIGRATION_AFTER_MOVE_FAILURE/);
    const targetRoot = planned.plan.operation.topology.managementCheckout;
    const receiptPath = join(
      planned.plan.operation.topology.commonDir,
      "harness",
      "worktree-delivery",
      "receipts",
      `${planned.plan.id}.json`,
    );
    expect(existsSync(root)).toBe(false);
    expect(existsSync(targetRoot)).toBe(true);
    expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toMatchObject({
      status: "failed",
      operation: "migrate",
      error: "TEST_MIGRATION_AFTER_MOVE_FAILURE",
    });
    expect(auditWorkspace(targetRoot).policies.find((policy) => policy.id === "workspace.cleanup-receipt"))
      .toMatchObject({ passing: false, evidence: [expect.stringContaining(planned.plan.id)] });
    expect(applyWorkspaceMigration({
      projectRoot: targetRoot,
      planPath: planned.path,
      approval: planned.plan.planHash,
    })).toMatchObject({ status: "applied", operation: "migrate" });
    expect(() => rollbackWorkspaceChange({ projectRoot: targetRoot, changeId: planned.plan.id }))
      .toThrow(/WORKTREE_MIGRATION_ROLLBACK_UNSUPPORTED/);
  });

  it("detects host-binding drift before applying an allocation", () => {
    const root = repository();
    const configured = planWorkspaceConfiguration({
      projectRoot: root,
      mode: "enforced",
      allowedRoots: [join(root, "..")],
    });
    applyWorkspacePlan({
      projectRoot: root,
      planPath: configured.path,
      approval: configured.plan.planHash,
    });
    const allocation = planWorkspaceAllocation({
      projectRoot: root,
      workItem: "github:example/project#binding-drift",
      branch: "binding-drift",
      path: `${root}-binding-drift`,
      owner: "owner",
    });
    const bindingPath = workspaceStatus(root).hostBinding.path;
    const binding = JSON.parse(readFileSync(bindingPath, "utf8")) as Record<string, unknown>;
    writeFileSync(bindingPath, JSON.stringify({ ...binding, allowedRoots: [root] }));

    expect(() => applyWorkspacePlan({
      projectRoot: root,
      planPath: allocation.path,
      approval: allocation.plan.planHash,
    })).toThrow(/WORKSPACE_DRIFT/);
  });

  it("delegates an allocation to an isolated AI reviewer and records its authorization", () => {
    installAiReviewer();
    const root = repository();
    const worktreePath = `${root}-ai-allocation`;
    repositories.push(worktreePath);
    configure(root, { approval: delegatedApproval(["allocate", "renew"]) });
    const planned = planWorkspaceAllocation({
      projectRoot: root,
      workItem: "github:example/project#ai-allocation",
      branch: "issue-ai-allocation",
      path: worktreePath,
      owner: "PM",
    });
    expect(() => applyWorkspacePlan({
      projectRoot: root,
      planPath: planned.path,
      approval: planned.plan.planHash,
    })).toThrow(/WORKSPACE_AI_AUTHORIZATION_REQUIRED/);

    const inputFile = join(root, "reviewer-input.txt");
    process.env.HARNESS_TEST_AI_INPUT_FILE = inputFile;
    const result = reviewAndApplyWorkspacePlan({
      projectRoot: root,
      planPath: planned.path,
      intent: "Create one isolated workspace for Issue ai-allocation without changing main or remotes.",
    });

    expect(result.decision).toMatchObject({
      verdict: "approve",
      planHash: planned.plan.planHash,
      operation: "allocate",
      reviewer: { kind: "claude", model: "test-reviewer" },
    });
    expect(result.decision.decisionHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.parse(readFileSync(result.decisionPath, "utf8"))).toEqual(result.decision);
    expect(result.receipt).toMatchObject({
      status: "applied",
      authorizationMode: "delegated-ai",
      authorizationDecisionHash: result.decision.decisionHash,
      authorizationPolicyHash: result.decision.policyHash,
    });
    expect(readFileSync(inputFile, "utf8")).toContain(planned.plan.planHash);
    expect(worktreeCount(root)).toBe(2);
    expect(workspaceStatus(root).leases).toEqual([
      expect.objectContaining({ workItem: "github:example/project#ai-allocation" }),
    ]);
    const renewal = planWorkspaceRenew({
      projectRoot: root,
      workItem: "github:example/project#ai-allocation",
    });
    expect(() => applyWorkspacePlan({
      projectRoot: root,
      planPath: renewal.path,
      approval: renewal.plan.planHash,
      authorization: { ...result.decision, planHash: renewal.plan.planHash, operation: "renew" },
    })).toThrow(/WORKSPACE_AI_AUTHORIZATION_INVALID/);
  });

  it("fails closed for denied, expired, malformed, and out-of-scope AI reviews", () => {
    installAiReviewer();
    const root = repository();
    configure(root, { approval: delegatedApproval(["renew"], 60) });
    const allocation = planWorkspaceAllocation({
      projectRoot: root,
      workItem: "github:example/project#ai-denied",
      branch: "issue-ai-denied",
      path: `${root}-ai-denied`,
      owner: "PM",
      now: new Date("2030-01-01T00:00:00.000Z"),
    });

    const outOfScope = reviewAndApplyWorkspacePlan({
      projectRoot: root,
      planPath: allocation.path,
      intent: "Allocate the requested worktree.",
      now: new Date("2030-01-01T00:00:01.000Z"),
    });
    expect(outOfScope).toMatchObject({
      decision: { verdict: "deny", reasonCodes: ["OPERATION_NOT_DELEGATED"] },
    });
    expect(outOfScope.receipt).toBeUndefined();
    expect(worktreeCount(root)).toBe(1);

    configure(root, { approval: delegatedApproval(["allocate"], 60) });
    const expired = planWorkspaceAllocation({
      projectRoot: root,
      workItem: "github:example/project#ai-expired",
      branch: "issue-ai-expired",
      path: `${root}-ai-expired`,
      owner: "PM",
      now: new Date("2030-01-01T00:00:00.000Z"),
    });
    const expiredReview = reviewAndApplyWorkspacePlan({
      projectRoot: root,
      planPath: expired.path,
      intent: "Allocate the requested worktree.",
      now: new Date("2030-01-01T00:02:00.000Z"),
    });
    expect(expiredReview).toMatchObject({
      decision: { verdict: "abstain", reasonCodes: ["PLAN_EXPIRED"] },
    });
    expect(expiredReview.receipt).toBeUndefined();

    const malformed = planWorkspaceAllocation({
      projectRoot: root,
      workItem: "github:example/project#ai-malformed",
      branch: "issue-ai-malformed",
      path: `${root}-ai-malformed`,
      owner: "PM",
    });
    process.env.HARNESS_TEST_AI_INVALID = "1";
    const malformedReview = reviewAndApplyWorkspacePlan({
      projectRoot: root,
      planPath: malformed.path,
      intent: "Allocate the requested worktree.",
    });
    expect(malformedReview).toMatchObject({
      decision: { verdict: "abstain", reasonCodes: ["REVIEWER_INVALID"] },
    });
    expect(malformedReview.receipt).toBeUndefined();
    expect(worktreeCount(root)).toBe(1);
    expect(workspaceStatus(root).leases).toHaveLength(0);
  });

  it("rechecks workspace drift after AI approval before applying", () => {
    installAiReviewer();
    const root = repository();
    const worktreePath = `${root}-ai-renew`;
    repositories.push(worktreePath);
    configure(root, { approval: delegatedApproval(["allocate", "renew"]) });
    const allocation = planWorkspaceAllocation({
      projectRoot: root,
      workItem: "github:example/project#ai-renew",
      branch: "issue-ai-renew",
      path: worktreePath,
      owner: "PM",
    });
    reviewAndApplyWorkspacePlan({
      projectRoot: root,
      planPath: allocation.path,
      intent: "Create the isolated Issue workspace.",
    });
    const renewal = planWorkspaceRenew({
      projectRoot: root,
      workItem: "github:example/project#ai-renew",
    });
    process.env.HARNESS_TEST_AI_DRIFT_PATH = join(worktreePath, "reviewer-drift.txt");

    expect(() => reviewAndApplyWorkspacePlan({
      projectRoot: root,
      planPath: renewal.path,
      intent: "Renew only the active lease heartbeat.",
    })).toThrow(/WORKSPACE_DRIFT/);
    expect(workspaceStatus(root).leases[0].heartbeatAt)
      .toBe((allocation.plan.operation as { lease: { heartbeatAt: string } }).lease.heartbeatAt);
  });

  it("denies destructive AI recovery when ignored or unreachable content exists", () => {
    installAiReviewer();
    const root = repository();
    configure(root, { approval: delegatedApproval(["recover"]) });
    const ignoredPath = `${root}-ai-recover-ignored`;
    repositories.push(ignoredPath);
    git(root, "worktree", "add", "--detach", ignoredPath, "HEAD");
    writeFileSync(join(root, ".git", "info", "exclude"), "ignored.bin\n", "utf8");
    writeFileSync(join(ignoredPath, "ignored.bin"), "valuable ignored content\n", "utf8");
    const ignoredPlan = planWorkspaceRecover({ projectRoot: root, path: ignoredPath });
    const ignoredReview = reviewAndApplyWorkspacePlan({
      projectRoot: root,
      planPath: ignoredPlan.path,
      intent: "Remove the clean detached residual worktree.",
    });
    expect(ignoredReview.decision).toMatchObject({
      verdict: "deny",
      reasonCodes: ["DESTRUCTIVE_EVIDENCE_UNSAFE"],
    });
    expect(existsSync(ignoredPath)).toBe(true);

    const uniquePath = `${root}-ai-recover-unique`;
    repositories.push(uniquePath);
    git(root, "worktree", "add", "--detach", uniquePath, "HEAD");
    writeFileSync(join(uniquePath, "unique.txt"), "unique commit\n", "utf8");
    git(uniquePath, "add", "unique.txt");
    git(uniquePath, "commit", "-m", "test: unique detached work");
    const uniquePlan = planWorkspaceRecover({ projectRoot: root, path: uniquePath });
    const uniqueReview = reviewAndApplyWorkspacePlan({
      projectRoot: root,
      planPath: uniquePlan.path,
      intent: "Remove the clean detached residual worktree.",
    });
    expect(uniqueReview.decision).toMatchObject({
      verdict: "deny",
      reasonCodes: ["DESTRUCTIVE_EVIDENCE_UNSAFE"],
    });
    expect(existsSync(uniquePath)).toBe(true);
  });

  it("fails closed when enforced policy has no host-local path binding", () => {
    const root = repository();
    const configured = planWorkspaceConfiguration({
      projectRoot: root,
      mode: "enforced",
      allowedRoots: [join(root, "..")],
    });
    applyWorkspacePlan({
      projectRoot: root,
      planPath: configured.path,
      approval: configured.plan.planHash,
    });
    const commonDir = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
    rmSync(join(commonDir, "harness", "worktree-delivery", "host-binding.json"), { force: true });

    expect(workspaceStatus(root)).toMatchObject({
      enforced: false,
      passing: false,
      hostBinding: { configured: false },
      errors: expect.arrayContaining(["WORKTREE_HOST_BINDING_REQUIRED"]),
    });
    expect(() => planWorkspaceAllocation({
      projectRoot: root,
      workItem: "github:example/project#missing-binding",
      branch: "missing-binding",
      path: `${root}-missing-binding`,
      owner: "owner",
    })).toThrow(/WORKTREE_HOST_BINDING_REQUIRED/);
  });

  it("requires an approved configure plan to migrate legacy embedded roots", () => {
    const root = repository();
    const configDirectory = join(root, ".harness");
    mkdirSync(configDirectory, { recursive: true });
    writeFileSync(join(configDirectory, "worktree-delivery.json"), JSON.stringify({
      schemaVersion: "1.0",
      mode: "enforced",
      maxPersistentWorktrees: 4,
      leaseTtlHours: 168,
      reviewTtlMinutes: 120,
      remoteBranchRetentionDays: 14,
      allowedRoots: [join(root, "..")],
      protectedRoots: [root, resolve("/")],
      remoteBranchDeletion: false,
      provider: { kind: "none" },
    }));

    expect(workspaceStatus(root)).toMatchObject({
      enforced: false,
      hostBinding: { configured: false, source: "legacy-config" },
      errors: expect.arrayContaining(["WORKTREE_HOST_BINDING_MIGRATION_REQUIRED"]),
    });
    expect(() => planWorkspaceAllocation({
      projectRoot: root,
      workItem: "github:example/project#legacy",
      branch: "legacy",
      path: `${root}-legacy`,
      owner: "owner",
    })).toThrow(/WORKTREE_HOST_BINDING_MIGRATION_REQUIRED/);

    const migration = planWorkspaceConfiguration({ projectRoot: root });
    applyWorkspacePlan({
      projectRoot: root,
      planPath: migration.path,
      approval: migration.plan.planHash,
    });
    const portable = JSON.parse(
      readFileSync(join(configDirectory, "worktree-delivery.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(portable).not.toHaveProperty("allowedRoots");
    expect(workspaceStatus(root).hostBinding).toMatchObject({
      configured: true,
      source: "host-local",
    });
  });

  it("configures, allocates, closes, rolls back, and reapplies idempotently", () => {
    const root = repositoryWithRemote();
    const worktreePath = `${root}-issue-24`;
    repositories.push(worktreePath);
    const parent = join(root, "..");

    const configured = planWorkspaceConfiguration({
      projectRoot: root,
      mode: "enforced",
      allowedRoots: [parent],
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(() => applyWorkspacePlan({
      projectRoot: root,
      planPath: configured.path,
      approval: "0".repeat(64),
    })).toThrow(/APPROVAL_MISMATCH/);
    const configReceipt = applyWorkspacePlan({
      projectRoot: root,
      planPath: configured.path,
      approval: configured.plan.planHash,
    });
    expect(configReceipt.status).toBe("applied");
    expect(workspaceStatus(root).configured).toBe(true);

    const allocated = planWorkspaceAllocation({
      projectRoot: root,
      workItem: "github:example/project#24",
      branch: "issue-24",
      path: worktreePath,
      owner: "owner",
      startPoint: "HEAD",
      now: new Date("2026-01-01T00:01:00.000Z"),
    });
    expect(worktreeCount(root)).toBe(1);
    const allocationReceipt = applyWorkspacePlan({
      projectRoot: root,
      planPath: allocated.path,
      approval: allocated.plan.planHash,
    });
    expect(allocationReceipt.status).toBe("applied");
    expect(worktreeCount(root)).toBe(2);
    expect(workspaceStatus(root).leases).toHaveLength(1);
    expect(applyWorkspacePlan({
      projectRoot: root,
      planPath: allocated.path,
      approval: allocated.plan.planHash,
    })).toEqual(allocationReceipt);

    git(worktreePath, "push", "-u", "origin", "issue-24");
    const head = git(worktreePath, "rev-parse", "HEAD");
    const closed = planWorkspaceClose({
      projectRoot: root,
      workItem: "github:example/project#24",
      acceptedCommit: head,
      now: new Date("2026-01-01T00:02:00.000Z"),
    });
    const closeReceipt = applyWorkspacePlan({
      projectRoot: root,
      planPath: closed.path,
      approval: closed.plan.planHash,
    });
    expect(closeReceipt.status).toBe("applied");
    expect(worktreeCount(root)).toBe(1);
    expect(workspaceStatus(root).leases).toHaveLength(0);

    const rolledBack = rollbackWorkspaceChange({
      projectRoot: root,
      changeId: closeReceipt.id,
    });
    expect(rolledBack.status).toBe("rolled-back");
    expect(worktreeCount(root)).toBe(2);
    expect(workspaceStatus(root).leases).toHaveLength(1);
    expect(rollbackWorkspaceChange({
      projectRoot: root,
      changeId: closeReceipt.id,
    })).toEqual(rolledBack);

    git(root, "worktree", "remove", worktreePath);
  });

  it("rebinds a planned lease to its observed branch without touching the worktree", () => {
    const root = repository();
    const worktreePath = `${root}-rebind`;
    repositories.push(worktreePath);
    configure(root, { managementBranch: "main", maxPersistentWorktrees: 2 });
    const allocated = planWorkspaceAllocation({
      projectRoot: root,
      workItem: "github:example/project#rebind",
      branch: "issue-rebind-old",
      path: worktreePath,
      owner: "owner",
    });
    applyWorkspacePlan({
      projectRoot: root,
      planPath: allocated.path,
      approval: allocated.plan.planHash,
    });
    git(worktreePath, "checkout", "-b", "issue-rebind-new");

    const planned = planWorkspaceRebind({
      projectRoot: root,
      workItem: "github:example/project#rebind",
      branch: "issue-rebind-new",
      now: new Date("2026-01-01T00:03:00.000Z"),
    });
    expect(planned.plan.operation.kind).toBe("rebind");
    const receipt = applyWorkspacePlan({
      projectRoot: root,
      planPath: planned.path,
      approval: planned.plan.planHash,
    });
    expect(receipt.status).toBe("applied");
    expect(receipt.steps).toContainEqual({
      id: "rebind-lease",
      status: "applied",
      detail: "github:example/project#rebind",
    });
    expect(workspaceStatus(root).leases).toEqual([
      expect.objectContaining({
        workItem: "github:example/project#rebind",
        branch: "issue-rebind-new",
      }),
    ]);
    expect(workspaceStatus(root).worktrees.some((worktree) =>
      worktree.path === git(worktreePath, "rev-parse", "--show-toplevel"))).toBe(true);
    expect(applyWorkspacePlan({
      projectRoot: root,
      planPath: planned.path,
      approval: planned.plan.planHash,
    })).toEqual(receipt);
    expect(() => planWorkspaceRebind({
      projectRoot: root,
      workItem: "github:example/project#rebind",
      branch: "issue-rebind-new",
    })).toThrow(/WORKTREE_REBIND_NOOP/);

    git(root, "worktree", "remove", worktreePath);
  });

  it("renews an expired lease on its current branch without changing the worktree", () => {
    const root = repository();
    const worktreePath = `${root}-renew`;
    repositories.push(worktreePath);
    configure(root, { managementBranch: "main", maxPersistentWorktrees: 2 });
    const allocated = planWorkspaceAllocation({
      projectRoot: root,
      workItem: "github:example/project#renew",
      branch: "issue-renew",
      path: worktreePath,
      owner: "owner",
      now: new Date("2020-01-01T00:00:00.000Z"),
    });
    applyWorkspacePlan({
      projectRoot: root,
      planPath: allocated.path,
      approval: allocated.plan.planHash,
    });
    expect(auditWorkspace(root).policies.find((policy) => policy.id === "workspace.lease-ttl"))
      .toMatchObject({ passing: false });
    const worktreesBefore = git(root, "worktree", "list", "--porcelain");
    const refsBefore = git(root, "for-each-ref", "--format=%(refname)%00%(objectname)");
    const headBefore = git(worktreePath, "rev-parse", "HEAD");

    const planned = planWorkspaceRenew({
      projectRoot: root,
      workItem: "github:example/project#renew",
      now: new Date("2030-01-02T00:00:00.000Z"),
    });
    if (planned.plan.operation.kind !== "renew") throw new Error("expected renew plan");
    expect(planned.plan.operation.replacementLease).toMatchObject({
      branch: "issue-renew",
      heartbeatAt: "2030-01-02T00:00:00.000Z",
    });
    expect(() => applyWorkspacePlan({
      projectRoot: root,
      planPath: planned.path,
      approval: "0".repeat(64),
    })).toThrow(/APPROVAL_MISMATCH/);
    const receipt = applyWorkspacePlan({
      projectRoot: root,
      planPath: planned.path,
      approval: planned.plan.planHash,
    });
    expect(receipt).toMatchObject({ operation: "renew", status: "applied" });
    expect(receipt.steps).toContainEqual({
      id: "renew-lease",
      status: "applied",
      detail: "github:example/project#renew",
    });
    expect(workspaceStatus(root).leases).toEqual([
      expect.objectContaining({ heartbeatAt: "2030-01-02T00:00:00.000Z" }),
    ]);
    expect(auditWorkspace(root).policies.find((policy) => policy.id === "workspace.lease-ttl"))
      .toMatchObject({ passing: true });
    expect(git(root, "worktree", "list", "--porcelain")).toBe(worktreesBefore);
    expect(git(root, "for-each-ref", "--format=%(refname)%00%(objectname)")).toBe(refsBefore);
    expect(git(worktreePath, "rev-parse", "HEAD")).toBe(headBefore);
    expect(rollbackWorkspaceChange({ projectRoot: root, changeId: receipt.id }).status)
      .toBe("rolled-back");
    expect(workspaceStatus(root).leases).toEqual([
      expect.objectContaining({ heartbeatAt: "2020-01-01T00:00:00.000Z" }),
    ]);
  });

  it("rejects missing and drifted renewal plans", () => {
    const root = repository();
    configure(root, { managementBranch: "main", maxPersistentWorktrees: 2 });
    expect(() => planWorkspaceRenew({
      projectRoot: root,
      workItem: "github:example/project#missing",
    })).toThrow(/WORKTREE_LEASE_NOT_FOUND/);

    const worktreePath = `${root}-renew-drift`;
    repositories.push(worktreePath);
    const allocated = planWorkspaceAllocation({
      projectRoot: root,
      workItem: "github:example/project#renew-drift",
      branch: "issue-renew-drift",
      path: worktreePath,
      owner: "owner",
    });
    applyWorkspacePlan({
      projectRoot: root,
      planPath: allocated.path,
      approval: allocated.plan.planHash,
    });
    const planned = planWorkspaceRenew({
      projectRoot: root,
      workItem: "github:example/project#renew-drift",
      now: new Date("2030-01-03T00:00:00.000Z"),
    });
    writeFileSync(join(worktreePath, "README.md"), "drift\n", "utf8");
    expect(() => applyWorkspacePlan({
      projectRoot: root,
      planPath: planned.path,
      approval: planned.plan.planHash,
    })).toThrow(/WORKSPACE_DRIFT/);
    rmSync(join(worktreePath, "README.md"));
  });

  it("recovers a clean detached unleased worktree through an approved plan", () => {
    const root = repository();
    configure(root, { managementBranch: "main", maxPersistentWorktrees: 2 });
    const worktreePath = `${root}-recover`;
    repositories.push(worktreePath);
    git(root, "worktree", "add", "--detach", worktreePath, "HEAD");
    const refsBefore = git(root, "for-each-ref", "--format=%(refname)%00%(objectname)");

    const planned = planWorkspaceRecover({ projectRoot: root, path: worktreePath });
    if (planned.plan.operation.kind !== "recover") throw new Error("expected recover plan");
    expect(planned.plan.operation).toMatchObject({
      path: realpathSync(worktreePath),
      removePath: realpathSync(worktreePath),
      expectedHead: git(worktreePath, "rev-parse", "HEAD"),
      dirtyEvidence: [],
      dirtyPatch: { size: 0, sha256: sha256("") },
    });
    expect(() => applyWorkspacePlan({
      projectRoot: root,
      planPath: planned.path,
      approval: "0".repeat(64),
    })).toThrow(/APPROVAL_MISMATCH/);
    const receipt = applyWorkspacePlan({
      projectRoot: root,
      planPath: planned.path,
      approval: planned.plan.planHash,
    });
    expect(receipt).toMatchObject({ operation: "recover", status: "applied" });
    expect(existsSync(worktreePath)).toBe(false);
    expect(git(root, "for-each-ref", "--format=%(refname)%00%(objectname)")).toBe(refsBefore);
    expect(rollbackWorkspaceChange({ projectRoot: root, changeId: receipt.id }).status)
      .toBe("rolled-back");
    expect(git(worktreePath, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
  });

  it("rejects unsafe recovery plans", () => {
    const root = repository();
    configure(root, { managementBranch: "main", maxPersistentWorktrees: 3 });
    expect(() => planWorkspaceRecover({ projectRoot: root, path: root }))
      .toThrow(/PROTECTED_WORKTREE_PATH/);

    const dirtyPath = `${root}-recover-dirty`;
    repositories.push(dirtyPath);
    git(root, "worktree", "add", "--detach", dirtyPath, "HEAD");
    writeFileSync(join(dirtyPath, "dirty.txt"), "keep\n", "utf8");
    expect(() => planWorkspaceRecover({ projectRoot: root, path: dirtyPath }))
      .toThrow(/WORKTREE_DIRTY/);

    const attachedPath = `${root}-recover-attached`;
    repositories.push(attachedPath);
    git(root, "worktree", "add", "-b", "issue-recover-attached", attachedPath, "HEAD");
    expect(() => planWorkspaceRecover({ projectRoot: root, path: attachedPath }))
      .toThrow(/WORKTREE_RECOVER_PRECONDITION_FAILED/);

    const leasedPath = `${root}-recover-leased`;
    repositories.push(leasedPath);
    const allocated = planWorkspaceAllocation({
      projectRoot: root,
      workItem: "github:example/project#recover-leased",
      branch: "issue-recover-leased",
      path: leasedPath,
      owner: "owner",
    });
    applyWorkspacePlan({
      projectRoot: root,
      planPath: allocated.path,
      approval: allocated.plan.planHash,
    });
    git(leasedPath, "checkout", "--detach");
    expect(() => planWorkspaceRecover({ projectRoot: root, path: leasedPath }))
      .toThrow(/WORKTREE_RECOVER_LEASED/);

    const driftPath = `${root}-recover-drift`;
    repositories.push(driftPath);
    git(root, "worktree", "add", "--detach", driftPath, "HEAD");
    const planned = planWorkspaceRecover({ projectRoot: root, path: driftPath });
    writeFileSync(join(driftPath, "drift.txt"), "keep\n", "utf8");
    expect(() => applyWorkspacePlan({
      projectRoot: root,
      planPath: planned.path,
      approval: planned.plan.planHash,
    })).toThrow(/WORKSPACE_DRIFT/);
  });

  it("rejects lifecycle drift and unsafe close preconditions", () => {
    const root = repositoryWithRemote();
    const worktreePath = `${root}-issue-25`;
    repositories.push(worktreePath);
    const configured = planWorkspaceConfiguration({
      projectRoot: root,
      mode: "enforced",
      allowedRoots: [join(root, "..")],
    });
    applyWorkspacePlan({
      projectRoot: root,
      planPath: configured.path,
      approval: configured.plan.planHash,
    });

    const stale = planWorkspaceAllocation({
      projectRoot: root,
      workItem: "github:example/project#stale",
      branch: "issue-stale",
      path: `${root}-stale`,
      owner: "owner",
    });
    const commonDir = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
    const leaseDir = join(commonDir, "harness", "worktree-delivery", "leases");
    mkdirSync(leaseDir, { recursive: true });
    writeFileSync(join(leaseDir, "drift.json"), JSON.stringify({
      schemaVersion: "1.0",
      workItem: "github:example/project#other",
      branch: "other",
      path: join(root, "..", "other"),
      owner: "owner",
      acceptedCommit: "abc123",
      createdAt: "2026-01-01T00:00:00.000Z",
      heartbeatAt: "2026-01-01T00:00:00.000Z",
      status: "active",
    }));
    expect(() => applyWorkspacePlan({
      projectRoot: root,
      planPath: stale.path,
      approval: stale.plan.planHash,
    })).toThrow(/WORKSPACE_DRIFT/);
    rmSync(join(leaseDir, "drift.json"));

    const allocated = planWorkspaceAllocation({
      projectRoot: root,
      workItem: "github:example/project#25",
      branch: "issue-25",
      path: worktreePath,
      owner: "owner",
    });
    applyWorkspacePlan({
      projectRoot: root,
      planPath: allocated.path,
      approval: allocated.plan.planHash,
    });
    writeFileSync(join(worktreePath, "dirty.txt"), "valuable work\n");
    expect(workspaceStatus(root).worktrees.find(
      (worktree) => worktree.path === git(worktreePath, "rev-parse", "--show-toplevel"),
    )?.dirtyEvidence).toEqual([
      expect.objectContaining({
        path: "dirty.txt",
        size: 14,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    ]);
    expect(() => planWorkspaceClose({
      projectRoot: root,
      workItem: "github:example/project#25",
      acceptedCommit: git(worktreePath, "rev-parse", "HEAD"),
    })).toThrow(/WORKTREE_DIRTY/);
    rmSync(join(worktreePath, "dirty.txt"));

    writeFileSync(join(worktreePath, "change.txt"), "committed work\n");
    git(worktreePath, "add", "change.txt");
    git(worktreePath, "commit", "-m", "feat: unique work");
    expect(() => planWorkspaceClose({
      projectRoot: root,
      workItem: "github:example/project#25",
      acceptedCommit: git(root, "rev-parse", "main"),
    })).toThrow(/ACCEPTED_COMMIT_MISMATCH/);
    expect(() => planWorkspaceClose({
      projectRoot: root,
      workItem: "github:example/project#25",
      acceptedCommit: git(worktreePath, "rev-parse", "HEAD"),
    })).toThrow(/UNPUSHED_COMMIT/);

    git(worktreePath, "push", "-u", "origin", "issue-25");
    expect(planWorkspaceClose({
      projectRoot: root,
      workItem: "github:example/project#25",
      acceptedCommit: git(worktreePath, "rev-parse", "HEAD"),
    }).plan.operation.kind).toBe("close");

    git(root, "worktree", "remove", worktreePath);
  });

  it("fails closed while another lifecycle apply holds the repository lock", () => {
    const root = repositoryWithRemote();
    const configured = planWorkspaceConfiguration({
      projectRoot: root,
      mode: "enforced",
      allowedRoots: [join(root, "..")],
    });
    const commonDir = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
    const lock = join(commonDir, "harness", "worktree-delivery", "apply.lock");
    mkdirSync(lock, { recursive: true });

    expect(() => applyWorkspacePlan({
      projectRoot: root,
      planPath: configured.path,
      approval: configured.plan.planHash,
    })).toThrow(/WORKSPACE_LOCKED/);

    rmdirSync(lock);
    expect(applyWorkspacePlan({
      projectRoot: root,
      planPath: configured.path,
      approval: configured.plan.planHash,
    }).status).toBe("applied");
  });

  it("rejects unsafe allocation inputs before creating a worktree", () => {
    const root = repository();
    const target = `${root}-guarded`;
    repositories.push(target);
    const allocation = {
      projectRoot: root,
      workItem: "github:example/project#guarded",
      branch: "issue-guarded",
      path: target,
      owner: "owner",
    };

    expect(() => planWorkspaceAllocation(allocation)).toThrow(
      /WORKTREE_CONFIGURATION_REQUIRED/,
    );
    configure(root, { mode: "audit-only" });
    expect(() => planWorkspaceAllocation(allocation)).toThrow(
      /WORKTREE_ENFORCEMENT_NOT_ENABLED/,
    );
    configure(root);

    expect(() => planWorkspaceAllocation({ ...allocation, workItem: " " }))
      .toThrow(/WORK_ITEM_REQUIRED/);
    expect(() => planWorkspaceAllocation({ ...allocation, owner: " " }))
      .toThrow(/OWNER_REQUIRED/);
    expect(() => planWorkspaceAllocation({ ...allocation, branch: "-unsafe" }))
      .toThrow(/WORKTREE_BRANCH_INVALID/);
    expect(() => planWorkspaceAllocation({ ...allocation, path: "relative" }))
      .toThrow(/WORKTREE_PATH_MUST_BE_ABSOLUTE/);
    expect(() => planWorkspaceAllocation({ ...allocation, path: root }))
      .toThrow(/WORKTREE_PROTECTED_PATH/);
    expect(() => planWorkspaceAllocation({
      ...allocation,
      path: join(root, "..", "..", "outside-harness"),
    })).toThrow(/WORKTREE_PATH_NOT_ALLOWED/);

    mkdirSync(target);
    expect(() => planWorkspaceAllocation(allocation)).toThrow(/WORKTREE_PATH_EXISTS/);
    rmdirSync(target);
    expect(() => planWorkspaceAllocation({ ...allocation, branch: "main" }))
      .toThrow(/BRANCH_ALREADY_CHECKED_OUT/);

    const commonDir = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
    const leaseDir = join(commonDir, "harness", "worktree-delivery", "leases");
    mkdirSync(leaseDir, { recursive: true });
    const leasePath = `${root}-leased`;
    writeFileSync(join(leaseDir, "guard.json"), JSON.stringify({
      schemaVersion: "1.0",
      workItem: allocation.workItem,
      branch: "leased",
      path: leasePath,
      owner: "owner",
      acceptedCommit: git(root, "rev-parse", "HEAD"),
      createdAt: "2026-01-01T00:00:00.000Z",
      heartbeatAt: "2026-01-01T00:00:00.000Z",
      status: "active",
    }));
    expect(() => planWorkspaceAllocation(allocation)).toThrow(/DUPLICATE_WORK_ITEM_LEASE/);
    expect(() => planWorkspaceAllocation({
      ...allocation,
      workItem: "github:example/project#other",
      path: leasePath,
    })).toThrow(/DUPLICATE_WORKTREE_PATH/);

    configure(root, { maxPersistentWorktrees: 1 });
    expect(() => planWorkspaceAllocation({
      ...allocation,
      workItem: "github:example/project#capacity",
    })).toThrow(/WORKTREE_CAPACITY_EXCEEDED/);
    rmSync(join(leaseDir, "guard.json"));

    configure(root, {
      provider: { kind: "gitlab", repository: "example/project" },
      maxPersistentWorktrees: 4,
    });
    expect(() => planWorkspaceAllocation(allocation)).toThrow(/PROVIDER_UNAVAILABLE/);
  });

  it("queries the pending allocation once and requires its Project mapping", () => {
    if (process.platform === "win32") return;
    const root = repository();
    installAdoptionGh();
    configure(root, {
      provider: {
        kind: "github",
        repository: "example/project",
        project: {
          owner: "example",
          number: 2,
          statusField: "Status",
          doneValues: ["Done"],
        },
      },
    });
    const calls = join(root, "provider-count");
    process.env.HARNESS_TEST_GH_COUNT_FILE = calls;
    const allocationPath = `${root}-issue-301`;
    repositories.push(allocationPath);
    const planned = planWorkspaceAllocation({
      projectRoot: root,
      workItem: "github:example/project#301",
      branch: "issue-301",
      path: allocationPath,
      owner: "owner",
    });
    expect(planned.plan.operation).toMatchObject({
      kind: "allocate",
      providerObservationBound: true,
    });
    expect(readFileSync(calls, "utf8")).toBe("2");

    process.env.HARNESS_TEST_GH_PROJECT_MISSING = "1";
    expect(() => planWorkspaceAllocation({
      projectRoot: root,
      workItem: "github:example/project#301",
      branch: "issue-301",
      path: `${root}-issue-301`,
      owner: "owner",
    })).toThrow(/PROVIDER_PROJECT_ITEM_REQUIRED/);

    delete process.env.HARNESS_TEST_GH_PROJECT_MISSING;
    writeFileSync(calls, "0");
    const receipt = applyWorkspacePlan({
      projectRoot: root,
      planPath: planned.path,
      approval: planned.plan.planHash,
    });
    expect(readFileSync(calls, "utf8")).toBe("2");
    process.env.HARNESS_TEST_GH_FAIL_AFTER = "2";
    expect(applyWorkspacePlan({
      projectRoot: root,
      planPath: planned.path,
      approval: planned.plan.planHash,
    })).toEqual(receipt);
    expect(readFileSync(calls, "utf8")).toBe("2");
  });

  it("requires configured-Project legacy allocation plans to be regenerated", () => {
    if (process.platform === "win32") return;
    const root = repository();
    installAdoptionGh();
    configure(root, {
      provider: {
        kind: "github",
        repository: "example/project",
        project: {
          owner: "example",
          number: 2,
          statusField: "Status",
          doneValues: ["Done"],
        },
      },
    });
    const planned = planWorkspaceAllocation({
      projectRoot: root,
      workItem: "github:example/project#301",
      branch: "issue-301",
      path: `${root}-issue-301`,
      owner: "owner",
    });
    if (planned.plan.operation.kind !== "allocate") throw new Error("expected allocate plan");
    delete planned.plan.operation.providerObservationBound;
    planned.plan.planHash = hashObject(withoutHash(planned.plan));
    writeFileSync(join(root, planned.path), prettyJson(planned.plan));

    expect(() => applyWorkspacePlan({
      projectRoot: root,
      planPath: planned.path,
      approval: planned.plan.planHash,
    })).toThrow(/WORKSPACE_PLAN_REPLAN_REQUIRED/);
    expect(worktreeCount(root)).toBe(1);
  });

  it("rejects malformed, tampered, mismatched, and unsafe rollback requests", () => {
    const root = repositoryWithRemote();
    const configured = planWorkspaceConfiguration({
      projectRoot: root,
      mode: "enforced",
      allowedRoots: [join(root, "..")],
    });
    const planFile = join(root, configured.path);
    const original = configured.plan;

    writeFileSync(join(root, ".harness", "plans", "invalid.json"), "{}");
    expect(() => applyWorkspacePlan({
      projectRoot: root,
      planPath: ".harness/plans/invalid.json",
      approval: "",
    })).toThrow(/WORKSPACE_PLAN_INVALID/);

    writeFileSync(planFile, prettyJson({
      ...original,
      warnings: ["tampered"],
    }));
    expect(() => applyWorkspacePlan({
      projectRoot: root,
      planPath: configured.path,
      approval: original.planHash,
    })).toThrow(/PLAN_TAMPERED/);

    const mismatched = { ...original, projectDir: `${root}-other` };
    mismatched.planHash = hashObject(withoutHash(mismatched));
    writeFileSync(planFile, prettyJson(mismatched));
    expect(() => applyWorkspacePlan({
      projectRoot: root,
      planPath: configured.path,
      approval: mismatched.planHash,
    })).toThrow(/PROJECT_MISMATCH/);

    writeFileSync(planFile, prettyJson(original));
    const configReceipt = applyWorkspacePlan({
      projectRoot: root,
      planPath: configured.path,
      approval: original.planHash,
    });
    expect(rollbackWorkspaceChange({
      projectRoot: root,
      changeId: configReceipt.id,
    }).status).toBe("rolled-back");
    expect(workspaceStatus(root)).toMatchObject({
      configured: false,
      hostBinding: { configured: false },
    });
    expect(() => rollbackWorkspaceChange({
      projectRoot: root,
      changeId: "missing",
    })).toThrow(/WORKSPACE_RECEIPT_NOT_FOUND/);

    configure(root);
    const worktreePath = `${root}-rollback-guard`;
    repositories.push(worktreePath);
    const allocated = planWorkspaceAllocation({
      projectRoot: root,
      workItem: "github:example/project#rollback",
      branch: "issue-rollback",
      path: worktreePath,
      owner: "owner",
    });
    const allocationReceipt = applyWorkspacePlan({
      projectRoot: root,
      planPath: allocated.path,
      approval: allocated.plan.planHash,
    });
    expect(() => rollbackWorkspaceChange({
      projectRoot: root,
      changeId: allocationReceipt.id,
    })).toThrow(/WORKSPACE_ROLLBACK_REQUIRES_CLOSE_PLAN/);
    git(root, "worktree", "remove", worktreePath);
  });
});

describe("hash-approved worktree adoption", () => {
  it("plans and atomically adopts a clean batch without changing existing worktrees", () => {
    const root = repository();
    configure(root, { managementBranch: "main", maxPersistentWorktrees: 3 });
    const firstPath = `${root}-adopt-101`;
    const secondPath = `${root}-adopt-102`;
    repositories.push(firstPath, secondPath);
    git(root, "worktree", "add", "-b", "issue-101", firstPath, "HEAD");
    git(root, "worktree", "add", "-b", "issue-102", secondPath, "HEAD");
    const porcelainBefore = git(root, "worktree", "list", "--porcelain");
    const refsBefore = git(root, "for-each-ref", "--format=%(refname)%00%(objectname)");
    const contentBefore = readFileSync(join(firstPath, "README.md"), "utf8");

    const planned = planWorkspaceAdoption({
      projectRoot: root,
      items: [
        {
          workItem: "github:example/project#102",
          owner: "bob",
          path: secondPath,
          branch: "issue-102",
        },
        {
          workItem: "github:example/project#101",
          owner: "alice",
          thread: "thread-101",
          path: firstPath,
          branch: "issue-101",
        },
      ],
      now: new Date("2026-01-01T00:03:00.000Z"),
    });

    expect(planned.plan.operation.kind).toBe("adopt");
    if (planned.plan.operation.kind !== "adopt") throw new Error("expected adopt plan");
    expect(planned.plan.operation.items.map((item) => item.lease.workItem)).toEqual([
      "github:example/project#101",
      "github:example/project#102",
    ]);
    expect(planned.plan.operation.capacity).toEqual({
      limit: 3,
      before: 0,
      adopting: 2,
      after: 2,
    });
    expect(planned.plan.operation).toMatchObject({
      configHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      hostBindingHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      refsHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      worktreeRegistrationHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      providerHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(planned.plan.operation.items[0]).toMatchObject({
      beforeLeaseHash: null,
      afterLeaseHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      snapshot: {
        dirty: false,
        dirtyEvidence: [],
        dirtyPatch: { size: 0, sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) },
      },
    });
    expect(workspaceStatus(root).leases).toHaveLength(0);
    expect(git(root, "worktree", "list", "--porcelain")).toBe(porcelainBefore);
    expect(git(root, "for-each-ref", "--format=%(refname)%00%(objectname)")).toBe(refsBefore);

    expect(() => applyWorkspacePlan({
      projectRoot: root,
      planPath: planned.path,
      approval: "0".repeat(64),
    })).toThrow(/APPROVAL_MISMATCH/);
    expect(workspaceStatus(root).leases).toHaveLength(0);

    const receipt = applyWorkspacePlan({
      projectRoot: root,
      planPath: planned.path,
      approval: planned.plan.planHash,
    });
    expect(receipt).toMatchObject({
      operation: "adopt",
      status: "applied",
      beforeObservedHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      afterObservedHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      compensationStatus: "not-required",
      leaseChanges: [
        expect.objectContaining({ action: "create", workItem: "github:example/project#101" }),
        expect.objectContaining({ action: "create", workItem: "github:example/project#102" }),
      ],
    });
    expect(workspaceStatus(root).leases).toHaveLength(2);
    expect(git(root, "worktree", "list", "--porcelain")).toBe(porcelainBefore);
    expect(git(root, "for-each-ref", "--format=%(refname)%00%(objectname)")).toBe(refsBefore);
    expect(readFileSync(join(firstPath, "README.md"), "utf8")).toBe(contentBefore);

    const rolledBack = rollbackWorkspaceChange({
      projectRoot: root,
      changeId: receipt.id,
    });
    expect(rolledBack).toMatchObject({
      status: "rolled-back",
      rollbackObservedHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(workspaceStatus(root).leases).toHaveLength(0);
    expect(git(root, "worktree", "list", "--porcelain")).toBe(porcelainBefore);
    expect(git(root, "for-each-ref", "--format=%(refname)%00%(objectname)")).toBe(refsBefore);
  });

  it("hash-binds dirty tracked and nested untracked content and rejects drift with zero leases", () => {
    const root = repository();
    configure(root, { managementBranch: "main", maxPersistentWorktrees: 2 });
    const worktreePath = `${root}-adopt-dirty`;
    repositories.push(worktreePath);
    git(root, "worktree", "add", "-b", "issue-dirty", worktreePath, "HEAD");
    writeFileSync(join(worktreePath, "README.md"), "# dirty fixture\n", "utf8");
    mkdirSync(join(worktreePath, "nested"));
    writeFileSync(join(worktreePath, "nested", "valuable.txt"), "valuable v1\n", "utf8");

    const planned = planWorkspaceAdoption({
      projectRoot: root,
      items: [{
        workItem: "github:example/project#103",
        owner: "alice",
        path: worktreePath,
        branch: "issue-dirty",
      }],
      now: new Date("2026-01-01T00:04:00.000Z"),
    });
    if (planned.plan.operation.kind !== "adopt") throw new Error("expected adopt plan");
    expect(planned.plan.operation.items[0].snapshot).toMatchObject({
      dirty: true,
      indexHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      dirtyPatch: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) },
      dirtyEvidence: expect.arrayContaining([
        expect.objectContaining({ path: "README.md" }),
        expect.objectContaining({ path: "nested/valuable.txt" }),
      ]),
    });

    writeFileSync(join(worktreePath, "nested", "valuable.txt"), "valuable v2\n", "utf8");
    expect(() => applyWorkspacePlan({
      projectRoot: root,
      planPath: planned.path,
      approval: planned.plan.planHash,
    })).toThrow(/WORKSPACE_DRIFT/);
    expect(workspaceStatus(root).leases).toHaveLength(0);
    expect(readFileSync(join(worktreePath, "nested", "valuable.txt"), "utf8"))
      .toBe("valuable v2\n");
  });

  it("streams large dirty binary patch evidence without lifecycle writes", () => {
    const root = repository();
    const worktreePath = `${root}-large-dirty`;
    repositories.push(worktreePath);
    git(root, "worktree", "add", "-b", "large-dirty", worktreePath, "HEAD");
    writeFileSync(join(worktreePath, "payload.bin"), randomBytes(11 * 1024 * 1024));
    git(worktreePath, "add", "payload.bin");
    git(worktreePath, "commit", "-m", "test: add binary payload");
    writeFileSync(join(worktreePath, "payload.bin"), randomBytes(11 * 1024 * 1024));
    const worktreesBefore = git(root, "worktree", "list", "--porcelain");
    const refsBefore = git(root, "for-each-ref", "--format=%(refname)%00%(objectname)");

    const status = workspaceStatus(root);
    const audit = auditWorkspace(root);
    const retention = retentionAuditWorkspace({ projectRoot: root });
    const dirty = status.worktrees.find((item) => item.branch === "large-dirty");

    expect(dirty?.dirtyPatch).toMatchObject({
      size: expect.any(Number),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(dirty?.dirtyPatch?.size).toBeGreaterThan(10 * 1024 * 1024);
    expect(audit.observedHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(retention.projectDir).toBe(realpathSync(root));
    expect(worktreeCount(root)).toBe(2);
    expect(workspaceStatus(root).leases).toEqual([]);
    expect(git(root, "worktree", "list", "--porcelain")).toBe(worktreesBefore);
    expect(git(root, "for-each-ref", "--format=%(refname)%00%(objectname)")).toBe(refsBefore);
  });

  it("never executes a configured textconv command while observing adoption", () => {
    const root = repository();
    const marker = join(root, "textconv-marker");
    const textconv = join(root, "textconv.cjs");
    writeFileSync(join(root, ".gitattributes"), "*.bin diff=sideeffect\n", "utf8");
    writeFileSync(join(root, "payload.bin"), "version one\n", "utf8");
    writeFileSync(textconv, `const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(marker)}, "executed");
process.stdout.write(fs.readFileSync(process.argv[2]));
`, "utf8");
    git(root, "add", ".gitattributes", "payload.bin", "textconv.cjs");
    git(root, "commit", "-m", "test: add textconv fixture");
    git(root, "config", "diff.sideeffect.textconv",
      `${JSON.stringify(process.execPath)} ${JSON.stringify(textconv)}`);
    configure(root, { managementBranch: "main", maxPersistentWorktrees: 2 });
    const worktreePath = `${root}-adopt-textconv`;
    repositories.push(worktreePath);
    git(root, "worktree", "add", "-b", "issue-textconv", worktreePath, "HEAD");
    writeFileSync(join(worktreePath, "payload.bin"), "version two\n", "utf8");

    const planned = planWorkspaceAdoption({
      projectRoot: root,
      items: [{
        workItem: "github:example/project#textconv",
        owner: "owner",
        path: worktreePath,
        branch: "issue-textconv",
      }],
    });
    expect(existsSync(marker)).toBe(false);
    applyWorkspacePlan({
      projectRoot: root,
      planPath: planned.path,
      approval: planned.plan.planHash,
    });
    expect(existsSync(marker)).toBe(false);
  });

  it("retains legacy textconv observation while adoption uses no-textconv", () => {
    const root = repository();
    const marker = join(root, "legacy-textconv-marker");
    const textconv = join(root, "legacy-textconv.cjs");
    writeFileSync(join(root, ".gitattributes"), "*.bin diff=legacy\n", "utf8");
    writeFileSync(join(root, "payload.bin"), "version one\n", "utf8");
    writeFileSync(textconv, `const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(marker)}, "executed");
process.stdout.write(fs.readFileSync(process.argv[2]));
`, "utf8");
    git(root, "add", ".gitattributes", "payload.bin", "legacy-textconv.cjs");
    git(root, "commit", "-m", "test: add legacy textconv fixture");
    git(root, "config", "diff.legacy.textconv",
      `${JSON.stringify(process.execPath)} ${JSON.stringify(textconv)}`);
    const worktreePath = `${root}-legacy-textconv`;
    repositories.push(worktreePath);
    git(root, "worktree", "add", "-b", "legacy-textconv", worktreePath, "HEAD");
    writeFileSync(join(worktreePath, "payload.bin"), "version two\n", "utf8");

    const legacy = workspaceStatus(root).worktrees.find((item) =>
      item.branch === "legacy-textconv");
    expect(legacy?.dirty).toBe(true);
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    const adoption = workspaceStatus(root, { adoptionSafe: true }).worktrees.find((item) =>
      item.branch === "legacy-textconv");
    expect(adoption?.dirty).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it("retains the v2.1.3 rename-token canonicalization outside adoption", () => {
    const root = repository();
    const worktreePath = `${root}-legacy-rename-token`;
    repositories.push(worktreePath);
    git(root, "worktree", "add", "-b", "legacy-rename-token", worktreePath, "HEAD");
    git(worktreePath, "mv", "README.md", "renamed.md");
    git(worktreePath, "reset", "HEAD", "--", "README.md", "renamed.md");

    const legacy = workspaceStatus(root).worktrees.find((item) =>
      item.branch === "legacy-rename-token");
    const adoption = workspaceStatus(root, { adoptionSafe: true }).worktrees.find((item) =>
      item.branch === "legacy-rename-token");
    expect(legacy?.dirty).toBe(true);
    expect(adoption?.dirty).toBe(true);
  });

  it("rejects index-only drift before writing an adoption lease", () => {
    const root = repository();
    configure(root, { managementBranch: "main", maxPersistentWorktrees: 2 });
    const worktreePath = `${root}-adopt-index-drift`;
    repositories.push(worktreePath);
    git(root, "worktree", "add", "-b", "issue-index-drift", worktreePath, "HEAD");
    const planned = planWorkspaceAdoption({
      projectRoot: root,
      items: [{
        workItem: "github:example/project#index-drift",
        owner: "owner",
        path: worktreePath,
        branch: "issue-index-drift",
      }],
    });
    git(worktreePath, "update-index", "--assume-unchanged", "README.md");

    expect(() => applyWorkspacePlan({
      projectRoot: root,
      planPath: planned.path,
      approval: planned.plan.planHash,
    })).toThrow(/WORKSPACE_DRIFT/);
    expect(workspaceStatus(root).leases).toHaveLength(0);
  });

  it("fails closed on symlinked lease state and index files", () => {
    if (process.platform === "win32") return;
    const root = repository();
    configure(root, { managementBranch: "main", maxPersistentWorktrees: 2 });
    const commonDir = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
    const external = join(root, "external-lease.json");
    writeFileSync(external, "{}\n", "utf8");
    const leaseDirectory = join(commonDir, "harness", "worktree-delivery", "leases");
    mkdirSync(leaseDirectory, { recursive: true });
    symlinkSync(external, join(leaseDirectory, `${sha256("external")}.json`));
    expect(workspaceStatus(root).errors).toEqual([
      expect.stringContaining("SYMLINK_TARGET_REJECTED"),
    ]);
    rmSync(leaseDirectory, { recursive: true, force: true });

    const worktreePath = `${root}-adopt-index-link`;
    repositories.push(worktreePath);
    git(root, "worktree", "add", "-b", "issue-index-link", worktreePath, "HEAD");
    const indexPath = join(git(root, "-C", worktreePath, "rev-parse", "--absolute-git-dir"), "index");
    const realIndex = `${indexPath}.real`;
    renameSync(indexPath, realIndex);
    symlinkSync(realIndex, indexPath);
    expect(() => planWorkspaceAdoption({
      projectRoot: root,
      items: [{
        workItem: "github:example/project#index-link",
        owner: "owner",
        path: worktreePath,
        branch: "issue-index-link",
      }],
    })).toThrow(/SYMLINK_TARGET_REJECTED/);
  });

  it("rejects unsupported dirty filesystem object types", () => {
    if (process.platform === "win32") return;
    const root = repository();
    configure(root, { managementBranch: "main", maxPersistentWorktrees: 2 });
    const worktreePath = `${root}-adopt-special-file`;
    repositories.push(worktreePath);
    git(root, "worktree", "add", "-b", "issue-special-file", worktreePath, "HEAD");
    rmSync(join(worktreePath, "README.md"));
    execFileSync("mkfifo", [join(worktreePath, "README.md")]);

    expect(() => planWorkspaceAdoption({
      projectRoot: root,
      items: [{
        workItem: "github:example/project#special-file",
        owner: "owner",
        path: worktreePath,
        branch: "issue-special-file",
      }],
    })).toThrow(/DIRTY_FILE_TYPE_UNSUPPORTED/);
  });

  it("rejects unsafe or ambiguous legacy targets before writing a lease", () => {
    const root = repository();
    configure(root, { managementBranch: "main", maxPersistentWorktrees: 6 });
    const attachedPath = `${root}-adopt-guarded`;
    const detachedPath = `${root}-adopt-detached`;
    const lockedPath = `${root}-adopt-locked`;
    const prunablePath = `${root}-adopt-prunable`;
    repositories.push(attachedPath, detachedPath, lockedPath, prunablePath);
    git(root, "worktree", "add", "-b", "issue-guarded", attachedPath, "HEAD");
    git(root, "worktree", "add", "--detach", detachedPath, "HEAD");
    git(root, "worktree", "add", "-b", "issue-locked", lockedPath, "HEAD");
    git(root, "worktree", "lock", lockedPath);
    git(root, "worktree", "add", "-b", "issue-prunable", prunablePath, "HEAD");
    rmSync(prunablePath, { recursive: true, force: true });
    const base = {
      projectRoot: root,
      items: [{
        workItem: "github:example/project#guarded",
        owner: "owner",
        path: attachedPath,
        branch: "issue-guarded",
      }],
    };

    expect(() => planWorkspaceAdoption({ ...base, items: [] }))
      .toThrow(/WORKTREE_ADOPT_BATCH_EMPTY/);
    expect(() => planWorkspaceAdoption({
      ...base,
      items: [{ ...base.items[0], path: "relative" }],
    })).toThrow(/WORKTREE_PATH_MUST_BE_ABSOLUTE/);
    expect(() => planWorkspaceAdoption({
      ...base,
      items: [base.items[0], { ...base.items[0], owner: "other" }],
    })).toThrow(/DUPLICATE_ADOPT_WORK_ITEM/);
    expect(() => planWorkspaceAdoption({
      ...base,
      items: [base.items[0], {
        ...base.items[0],
        workItem: "github:example/project#other",
      }],
    })).toThrow(/DUPLICATE_ADOPT_PATH/);
    expect(() => planWorkspaceAdoption({
      ...base,
      items: [base.items[0], {
        workItem: "github:example/project#branch-duplicate",
        owner: "owner",
        path: lockedPath,
        branch: "issue-guarded",
      }],
    })).toThrow(/DUPLICATE_ADOPT_BRANCH/);
    expect(() => planWorkspaceAdoption({
      ...base,
      items: [{ ...base.items[0], branch: "other" }],
    })).toThrow(/WORKTREE_BRANCH_MISMATCH/);
    expect(() => planWorkspaceAdoption({
      ...base,
      items: [{ ...base.items[0], path: detachedPath, branch: "detached" }],
    })).toThrow(/WORKTREE_DETACHED/);
    expect(() => planWorkspaceAdoption({
      ...base,
      items: [{ ...base.items[0], path: lockedPath, branch: "issue-locked" }],
    })).toThrow(/WORKTREE_LOCKED/);
    expect(() => planWorkspaceAdoption({
      ...base,
      items: [{ ...base.items[0], path: prunablePath, branch: "issue-prunable" }],
    })).toThrow(/WORKTREE_PRUNABLE/);
    expect(() => planWorkspaceAdoption({
      ...base,
      items: [{ ...base.items[0], path: root, branch: "main" }],
    })).toThrow(/WORKTREE_MANAGEMENT_CHECKOUT/);
    expect(() => planWorkspaceAdoption({
      ...base,
      items: [{ ...base.items[0], path: resolve(root, "../../outside"), branch: "outside" }],
    })).toThrow(/WORKTREE_PATH_NOT_ALLOWED/);
    configure(root, { managementBranch: "main", maxPersistentWorktrees: 1 });
    expect(() => planWorkspaceAdoption({
      ...base,
      items: [base.items[0], {
        workItem: "github:example/project#detached",
        owner: "owner",
        path: detachedPath,
        branch: "detached",
      }],
    })).toThrow(/WORKTREE_CAPACITY_EXCEEDED/);
    expect(workspaceStatus(root).leases).toHaveLength(0);
  });

  it("rejects a branch checked out by more than one legacy worktree", () => {
    const root = repository();
    configure(root, { managementBranch: "main", maxPersistentWorktrees: 3 });
    const firstPath = `${root}-adopt-duplicate-branch-1`;
    const secondPath = `${root}-adopt-duplicate-branch-2`;
    repositories.push(firstPath, secondPath);
    git(root, "worktree", "add", "-b", "issue-duplicate-branch", firstPath, "HEAD");
    git(root, "worktree", "add", "--detach", secondPath, "HEAD");
    git(secondPath, "checkout", "--ignore-other-worktrees", "issue-duplicate-branch");

    expect(() => planWorkspaceAdoption({
      projectRoot: root,
      items: [{
        workItem: "github:example/project#duplicate-branch",
        owner: "owner",
        path: firstPath,
        branch: "issue-duplicate-branch",
      }],
    })).toThrow(/DUPLICATE_WORKTREE_BRANCH/);
    expect(workspaceStatus(root).leases).toHaveLength(0);
  });

  it("compensates only leases written by a failed batch apply", () => {
    const root = repository();
    configure(root, { managementBranch: "main", maxPersistentWorktrees: 3 });
    const firstPath = `${root}-adopt-fail-1`;
    const secondPath = `${root}-adopt-fail-2`;
    repositories.push(firstPath, secondPath);
    git(root, "worktree", "add", "-b", "issue-fail-1", firstPath, "HEAD");
    git(root, "worktree", "add", "-b", "issue-fail-2", secondPath, "HEAD");
    const planned = planWorkspaceAdoption({
      projectRoot: root,
      items: [
        { workItem: "github:example/project#201", owner: "owner", path: firstPath, branch: "issue-fail-1" },
        { workItem: "github:example/project#202", owner: "owner", path: secondPath, branch: "issue-fail-2" },
      ],
    });
    const applying = {
      projectRoot: root,
      planPath: planned.path,
      approval: planned.plan.planHash,
      testFailAfterLeaseWrites: 1,
    };

    expect(() => applyWorkspacePlan(applying)).toThrow(/TEST_ADOPT_WRITE_FAILURE/);
    expect(workspaceStatus(root).leases).toHaveLength(0);
    expect(worktreeCount(root)).toBe(3);
    const failedReceipt = JSON.parse(readFileSync(join(
      git(root, "rev-parse", "--path-format=absolute", "--git-common-dir"),
      "harness", "worktree-delivery", "receipts", `${planned.plan.id}.json`,
    ), "utf8"));
    expect(failedReceipt).toMatchObject({
      status: "failed",
      compensationStatus: "completed",
      leaseChanges: [expect.objectContaining({ action: "create" })],
      steps: expect.arrayContaining([
        expect.objectContaining({ id: "remove-adopted-lease", status: "compensated" }),
      ]),
    });
  });

  it("hash-binds and preserves the complete pre-existing lease set", () => {
    const root = repository();
    configure(root, { managementBranch: "main", maxPersistentWorktrees: 3 });
    const allocatedPath = `${root}-allocated-before-adopt`;
    const allocated = planWorkspaceAllocation({
      projectRoot: root,
      workItem: "github:example/project#already-leased",
      owner: "owner",
      path: allocatedPath,
      branch: "issue-already-leased",
    });
    applyWorkspacePlan({
      projectRoot: root,
      planPath: allocated.path,
      approval: allocated.plan.planHash,
    });
    repositories.push(allocatedPath);
    const commonDir = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
    const existingLeasePath = join(
      commonDir,
      "harness", "worktree-delivery", "leases",
      `${sha256("github:example/project#already-leased")}.json`,
    );
    const existingBytes = readFileSync(existingLeasePath, "utf8");
    const adoptPath = `${root}-adopt-after-lease`;
    repositories.push(adoptPath);
    git(root, "worktree", "add", "-b", "issue-adopt-after-lease", adoptPath, "HEAD");
    const planned = planWorkspaceAdoption({
      projectRoot: root,
      items: [{
        workItem: "github:example/project#adopt-after-lease",
        owner: "owner",
        path: adoptPath,
        branch: "issue-adopt-after-lease",
      }],
    });
    if (planned.plan.operation.kind !== "adopt") throw new Error("expected adopt plan");
    expect(planned.plan.operation.existingLeases).toEqual([{
      leasePath: expect.stringMatching(/leases\/[a-f0-9]{64}\.json$/u),
      sha256: sha256(existingBytes),
    }]);
    applyWorkspacePlan({
      projectRoot: root,
      planPath: planned.path,
      approval: planned.plan.planHash,
    });
    expect(readFileSync(existingLeasePath, "utf8")).toBe(existingBytes);
  });

  it("produces deterministic plans whose hash changes with approved metadata or dirty bytes", () => {
    const root = repository();
    configure(root, { managementBranch: "main", maxPersistentWorktrees: 3 });
    const firstPath = `${root}-adopt-hash-1`;
    const secondPath = `${root}-adopt-hash-2`;
    repositories.push(firstPath, secondPath);
    git(root, "worktree", "add", "-b", "issue-hash-1", firstPath, "HEAD");
    git(root, "worktree", "add", "-b", "issue-hash-2", secondPath, "HEAD");
    const first = {
      workItem: "github:example/project#211",
      owner: "owner",
      thread: "thread",
      path: firstPath,
      branch: "issue-hash-1",
    };
    const second = {
      workItem: "github:example/project#212",
      owner: "owner",
      path: secondPath,
      branch: "issue-hash-2",
    };
    const now = new Date("2026-01-01T00:05:00.000Z");
    const forward = planWorkspaceAdoption({ projectRoot: root, items: [first, second], now });
    const reversed = planWorkspaceAdoption({ projectRoot: root, items: [second, first], now });
    expect(reversed.plan.planHash).toBe(forward.plan.planHash);

    const ownerChanged = planWorkspaceAdoption({
      projectRoot: root,
      items: [{ ...first, owner: "other" }, second],
      now,
    });
    expect(ownerChanged.plan.planHash).not.toBe(forward.plan.planHash);
    writeFileSync(join(firstPath, "valuable.txt"), "dirty\n", "utf8");
    const dirtyChanged = planWorkspaceAdoption({ projectRoot: root, items: [first, second], now });
    expect(dirtyChanged.plan.planHash).not.toBe(forward.plan.planHash);
  });

  it("creates no receipt or planned lease when config or lease absence drifts", () => {
    const root = repository();
    configure(root, { managementBranch: "main", maxPersistentWorktrees: 2 });
    const worktreePath = `${root}-adopt-preflight`;
    repositories.push(worktreePath);
    git(root, "worktree", "add", "-b", "issue-preflight", worktreePath, "HEAD");
    const planned = planWorkspaceAdoption({
      projectRoot: root,
      items: [{
        workItem: "github:example/project#213",
        owner: "owner",
        path: worktreePath,
        branch: "issue-preflight",
      }],
    });
    if (planned.plan.operation.kind !== "adopt") throw new Error("expected adopt plan");
    const commonDir = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
    const receiptPath = join(
      commonDir,
      "harness", "worktree-delivery", "receipts", `${planned.plan.id}.json`,
    );
    const configPath = join(root, ".harness", "worktree-delivery.json");
    const config = readFileSync(configPath, "utf8");
    writeFileSync(configPath, `${config.trim()}\n\n`, "utf8");
    expect(() => applyWorkspacePlan({
      projectRoot: root,
      planPath: planned.path,
      approval: planned.plan.planHash,
    })).toThrow(/WORKSPACE_DRIFT/);
    expect(existsSync(receiptPath)).toBe(false);
    writeFileSync(configPath, config, "utf8");

    const item = planned.plan.operation.items[0];
    const leasePath = join(commonDir, item.leasePath);
    mkdirSync(resolve(leasePath, ".."), { recursive: true });
    writeFileSync(leasePath, prettyJson(item.lease), "utf8");
    expect(() => applyWorkspacePlan({
      projectRoot: root,
      planPath: planned.path,
      approval: planned.plan.planHash,
    })).toThrow(/WORKSPACE_DRIFT/);
    expect(existsSync(receiptPath)).toBe(false);
    expect(workspaceStatus(root).leases).toHaveLength(1);
  });

  it("refuses adoption rollback after a later close lifecycle used its lease", () => {
    const root = repositoryWithRemote();
    configure(root, { managementBranch: "main", maxPersistentWorktrees: 2 });
    const worktreePath = `${root}-adopt-used`;
    repositories.push(worktreePath);
    git(root, "worktree", "add", "-b", "issue-used", worktreePath, "HEAD");
    git(worktreePath, "push", "-u", "origin", "issue-used");
    const planned = planWorkspaceAdoption({
      projectRoot: root,
      items: [{
        workItem: "github:example/project#203",
        owner: "owner",
        path: worktreePath,
        branch: "issue-used",
      }],
    });
    const adopted = applyWorkspacePlan({
      projectRoot: root,
      planPath: planned.path,
      approval: planned.plan.planHash,
    });
    const closed = planWorkspaceClose({
      projectRoot: root,
      workItem: "github:example/project#203",
      acceptedCommit: git(worktreePath, "rev-parse", "HEAD"),
    });
    const closeReceipt = applyWorkspacePlan({
      projectRoot: root,
      planPath: closed.path,
      approval: closed.plan.planHash,
    });
    rollbackWorkspaceChange({ projectRoot: root, changeId: closeReceipt.id });

    expect(() => rollbackWorkspaceChange({
      projectRoot: root,
      changeId: adopted.id,
    })).toThrow(/WORKSPACE_ROLLBACK_LATER_LIFECYCLE_USE/);
    expect(workspaceStatus(root).leases).toHaveLength(1);
  });

  it("retains failed close lease-use evidence and blocks adoption rollback", () => {
    const root = repositoryWithRemote();
    configure(root, { managementBranch: "main", maxPersistentWorktrees: 2 });
    const worktreePath = `${root}-adopt-failed-close`;
    repositories.push(worktreePath);
    git(root, "worktree", "add", "-b", "issue-failed-close", worktreePath, "HEAD");
    git(worktreePath, "push", "-u", "origin", "issue-failed-close");
    const planned = planWorkspaceAdoption({
      projectRoot: root,
      items: [{
        workItem: "github:example/project#failed-close",
        owner: "owner",
        path: worktreePath,
        branch: "issue-failed-close",
      }],
    });
    const adopted = applyWorkspacePlan({
      projectRoot: root,
      planPath: planned.path,
      approval: planned.plan.planHash,
    });
    const closed = planWorkspaceClose({
      projectRoot: root,
      workItem: "github:example/project#failed-close",
      acceptedCommit: git(worktreePath, "rev-parse", "HEAD"),
    });
    expect(() => applyWorkspacePlan({
      projectRoot: root,
      planPath: closed.path,
      approval: closed.plan.planHash,
      testFailCloseAfterWorktreeRemove: true,
    })).toThrow(/TEST_CLOSE_AFTER_WORKTREE_REMOVE_FAILURE/);
    expect(workspaceStatus(root).leases).toHaveLength(1);
    expect(workspaceStatus(root).worktrees.some((item) =>
      item.branch === "issue-failed-close")).toBe(true);

    expect(() => rollbackWorkspaceChange({
      projectRoot: root,
      changeId: adopted.id,
    })).toThrow(/WORKSPACE_ROLLBACK_LATER_LIFECYCLE_USE/);
    expect(workspaceStatus(root).leases).toHaveLength(1);
  });

  it("rejects tampered and symlinked receipts without removing an adopted lease", () => {
    if (process.platform === "win32") return;
    const root = repository();
    configure(root, { managementBranch: "main", maxPersistentWorktrees: 2 });
    const worktreePath = `${root}-adopt-receipt-guard`;
    repositories.push(worktreePath);
    git(root, "worktree", "add", "-b", "issue-receipt-guard", worktreePath, "HEAD");
    const planned = planWorkspaceAdoption({
      projectRoot: root,
      items: [{
        workItem: "github:example/project#receipt-guard",
        owner: "owner",
        path: worktreePath,
        branch: "issue-receipt-guard",
      }],
    });
    const receipt = applyWorkspacePlan({
      projectRoot: root,
      planPath: planned.path,
      approval: planned.plan.planHash,
    });
    const commonDir = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
    const receiptDirectory = join(commonDir, "harness", "worktree-delivery", "receipts");
    const receiptPath = join(receiptDirectory, `${receipt.id}.json`);
    const original = readFileSync(receiptPath, "utf8");
    const tampered = JSON.parse(original);
    tampered.leaseChanges[0].afterHash = "0".repeat(64);
    writeFileSync(receiptPath, prettyJson(tampered), "utf8");
    expect(() => rollbackWorkspaceChange({
      projectRoot: root,
      changeId: receipt.id,
    })).toThrow(/WORKSPACE_RECEIPT_INVALID/);
    expect(workspaceStatus(root).leases).toHaveLength(1);

    writeFileSync(receiptPath, original, "utf8");
    const external = join(root, "external-receipt.json");
    writeFileSync(external, "{}\n", "utf8");
    symlinkSync(external, join(receiptDirectory, "external.json"));
    expect(() => rollbackWorkspaceChange({
      projectRoot: root,
      changeId: receipt.id,
    })).toThrow(/SYMLINK_TARGET_REJECTED/);
    expect(workspaceStatus(root).leases).toHaveLength(1);
  });

  it("reuses the rollback preflight provider snapshot after removing leases", () => {
    if (process.platform === "win32") return;
    const root = repository();
    installAdoptionGh();
    configure(root, {
      managementBranch: "main",
      maxPersistentWorktrees: 2,
      provider: {
        kind: "github",
        repository: "example/project",
        project: {
          owner: "example",
          number: 2,
          statusField: "Status",
          doneValues: ["Done"],
        },
      },
    });
    const worktreePath = `${root}-adopt-rollback-compensation`;
    repositories.push(worktreePath);
    git(root, "worktree", "add", "-b", "issue-rollback-compensation", worktreePath, "HEAD");
    const planned = planWorkspaceAdoption({
      projectRoot: root,
      items: [{
        workItem: "github:example/project#301",
        owner: "owner",
        path: worktreePath,
        branch: "issue-rollback-compensation",
      }],
    });
    const receipt = applyWorkspacePlan({
      projectRoot: root,
      planPath: planned.path,
      approval: planned.plan.planHash,
    });
    const providerCount = join(root, "provider-count");
    process.env.HARNESS_TEST_GH_COUNT_FILE = providerCount;
    process.env.HARNESS_TEST_GH_FAIL_AFTER = "2";

    expect(rollbackWorkspaceChange({
      projectRoot: root,
      changeId: receipt.id,
    })).toMatchObject({ status: "rolled-back" });
    expect(readFileSync(providerCount, "utf8")).toBe("2");
  });

  it("binds configured GitHub Issue and Project state and fails closed on provider drift", () => {
    if (process.platform === "win32") return;
    const root = repository();
    installAdoptionGh();
    configure(root, {
      managementBranch: "main",
      maxPersistentWorktrees: 2,
      provider: {
        kind: "github",
        repository: "example/project",
        project: {
          owner: "example",
          number: 2,
          statusField: "Status",
          doneValues: ["Done"],
        },
      },
    });
    const worktreePath = `${root}-adopt-provider`;
    repositories.push(worktreePath);
    git(root, "worktree", "add", "-b", "issue-provider", worktreePath, "HEAD");
    const planned = planWorkspaceAdoption({
      projectRoot: root,
      items: [{
        workItem: "github:example/project#301",
        owner: "owner",
        path: worktreePath,
        branch: "issue-provider",
      }],
    });
    if (planned.plan.operation.kind !== "adopt") throw new Error("expected adopt plan");
    expect(planned.plan.operation.items[0].providerItem).toMatchObject({
      state: "OPEN",
      projectItemPresent: true,
      projectStatus: "In Progress",
    });

    process.env.HARNESS_TEST_GH_STATUS = "Done";
    expect(() => applyWorkspacePlan({
      projectRoot: root,
      planPath: planned.path,
      approval: planned.plan.planHash,
    })).toThrow(/WORKSPACE_DRIFT/);
    expect(workspaceStatus(root).leases).toHaveLength(0);

    const completed = planWorkspaceAdoption({
      projectRoot: root,
      items: [{
        workItem: "github:example/project#301",
        owner: "owner",
        path: worktreePath,
        branch: "issue-provider",
      }],
    });
    expect(completed.plan.warnings).toEqual([
      expect.stringContaining("adopt it first, then close it"),
    ]);

    delete process.env.HARNESS_TEST_GH_STATUS;
    expect(() => planWorkspaceAdoption({
      projectRoot: root,
      items: [{
        workItem: "github:other/project#301",
        owner: "owner",
        path: worktreePath,
        branch: "issue-provider",
      }],
    })).toThrow(/PROVIDER_WORK_ITEM_INVALID/);
    process.env.HARNESS_TEST_GH_PROJECT_MISSING = "1";
    expect(() => planWorkspaceAdoption({
      projectRoot: root,
      items: [{
        workItem: "github:example/project#301",
        owner: "owner",
        path: worktreePath,
        branch: "issue-provider",
      }],
    })).toThrow(/PROVIDER_PROJECT_ITEM_REQUIRED/);
  });

  it("observes the provider once before adopt mutation and reuses that snapshot", () => {
    if (process.platform === "win32") return;
    const root = repository();
    installAdoptionGh();
    configure(root, {
      maxPersistentWorktrees: 2,
      provider: {
        kind: "github",
        repository: "example/project",
        project: {
          owner: "example",
          number: 2,
          statusField: "Status",
          doneValues: ["Done"],
        },
      },
    });
    const worktreePath = `${root}-adopt-provider-once`;
    repositories.push(worktreePath);
    git(root, "worktree", "add", "-b", "issue-provider-once", worktreePath, "HEAD");
    const calls = join(root, "provider-count");
    process.env.HARNESS_TEST_GH_COUNT_FILE = calls;
    const planned = planWorkspaceAdoption({
      projectRoot: root,
      items: [{
        workItem: "github:example/project#301",
        owner: "owner",
        path: worktreePath,
        branch: "issue-provider-once",
      }],
    });
    expect(readFileSync(calls, "utf8")).toBe("2");
    const receipt = applyWorkspacePlan({
      projectRoot: root,
      planPath: planned.path,
      approval: planned.plan.planHash,
    });
    expect(readFileSync(calls, "utf8")).toBe("4");

    process.env.HARNESS_TEST_GH_FAIL_AFTER = "4";
    expect(applyWorkspacePlan({
      projectRoot: root,
      planPath: planned.path,
      approval: planned.plan.planHash,
    })).toEqual(receipt);
    expect(readFileSync(calls, "utf8")).toBe("4");
  });

  it("applies and rolls back a legacy adopt plan with one pre-mutation observation", () => {
    if (process.platform === "win32") return;
    const root = repository();
    installAdoptionGh();
    configure(root, {
      maxPersistentWorktrees: 2,
      provider: {
        kind: "github",
        repository: "example/project",
        project: {
          owner: "example",
          number: 2,
          statusField: "Status",
          doneValues: ["Done"],
        },
      },
    });
    const worktreePath = `${root}-adopt-provider-legacy`;
    repositories.push(worktreePath);
    git(root, "worktree", "add", "-b", "issue-provider-legacy", worktreePath, "HEAD");
    const planned = planWorkspaceAdoption({
      projectRoot: root,
      items: [{
        workItem: "github:example/project#301",
        owner: "owner",
        path: worktreePath,
        branch: "issue-provider-legacy",
      }],
    });
    const legacyStatus = workspaceStatus(root, { adoptionSafe: true });
    if (planned.plan.operation.kind !== "adopt") throw new Error("expected adopt plan");
    delete planned.plan.operation.providerObservationBound;
    planned.plan.observedHash = legacyStatus.observedHash;
    planned.plan.planHash = hashObject(withoutHash(planned.plan));
    writeFileSync(join(root, planned.path), prettyJson(planned.plan));

    const receipt = applyWorkspacePlan({
      projectRoot: root,
      planPath: planned.path,
      approval: planned.plan.planHash,
    });
    expect(receipt.status).toBe("applied");
    const calls = join(root, "provider-count");
    process.env.HARNESS_TEST_GH_COUNT_FILE = calls;
    process.env.HARNESS_TEST_GH_FAIL_AFTER = "2";
    expect(rollbackWorkspaceChange({
      projectRoot: root,
      changeId: receipt.id,
    })).toMatchObject({ status: "rolled-back" });
    expect(readFileSync(calls, "utf8")).toBe("2");
  });
});

describe("temporary review and retention", () => {
  it("does not query the configured provider", () => {
    if (process.platform === "win32") return;
    const root = repository();
    installAdoptionGh();
    configure(root, {
      provider: {
        kind: "github",
        repository: "example/project",
        project: {
          owner: "example",
          number: 2,
          statusField: "Status",
          doneValues: ["Done"],
        },
      },
    });
    const calls = join(root, "provider-count");
    process.env.HARNESS_TEST_GH_COUNT_FILE = calls;
    const hostStateRoot = mkdtempSync(join(tmpdir(), "harness-host-state-"));
    repositories.push(hostStateRoot);

    reviewWorkspace({
      projectRoot: root,
      commit: "HEAD",
      command: ["git", "status", "--short"],
      hostStateRoot,
    });
    retentionAuditWorkspace({ projectRoot: root, hostStateRoot });
    expect(existsSync(calls)).toBe(false);
  });

  it("uses a detached temporary worktree and leaves zero worktrees after a clean review", () => {
    const root = repository();
    const hostStateRoot = mkdtempSync(join(tmpdir(), "harness-host-state-"));
    repositories.push(hostStateRoot);
    const before = worktreeCount(root);

    const receipt = reviewWorkspace({
      projectRoot: root,
      commit: "HEAD",
      command: ["git", "status", "--short"],
      hostStateRoot,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(receipt).toMatchObject({
      detached: true,
      dirty: false,
      exitCode: 0,
      status: "cleaned",
    });
    expect(worktreeCount(root)).toBe(before);
    expect(existsSync(receipt.path)).toBe(false);
    expect(JSON.parse(readFileSync(receipt.receiptPath, "utf8")).status).toBe("cleaned");
  });

  it("rejects an empty review command and records clean command failures", () => {
    const root = repository();
    const hostStateRoot = mkdtempSync(join(tmpdir(), "harness-host-state-"));
    repositories.push(hostStateRoot);

    expect(() => reviewWorkspace({
      projectRoot: root,
      commit: "HEAD",
      command: [],
      hostStateRoot,
    })).toThrow(/REVIEW_COMMAND_REQUIRED/);

    const nonzero = reviewWorkspace({
      projectRoot: root,
      commit: "HEAD",
      command: [process.execPath, "-e", "process.exit(7)"],
      hostStateRoot,
    });
    expect(nonzero).toMatchObject({ status: "failed", dirty: false, exitCode: 7 });
    expect(existsSync(nonzero.path)).toBe(false);

    const missing = reviewWorkspace({
      projectRoot: root,
      commit: "HEAD",
      command: ["harness-command-that-does-not-exist"],
      hostStateRoot,
    });
    expect(missing).toMatchObject({ status: "failed", dirty: false, exitCode: null });
    expect(missing.error).toContain("ENOENT");
  });

  it("preserves a dirty review checkout and reports it as a stale TTL candidate", () => {
    const root = repository();
    const hostStateRoot = mkdtempSync(join(tmpdir(), "harness-host-state-"));
    repositories.push(hostStateRoot);
    const receipt = reviewWorkspace({
      projectRoot: root,
      commit: "HEAD",
      command: [
        process.execPath,
        "-e",
        "require('node:fs').writeFileSync('valuable.txt', 'keep me\\n')",
      ],
      hostStateRoot,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(receipt).toMatchObject({ status: "blocked", detached: true, dirty: true });
    expect(receipt.dirtyEvidence).toEqual([
      expect.objectContaining({
        path: "valuable.txt",
        size: 8,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    ]);
    expect(existsSync(join(receipt.path, "valuable.txt"))).toBe(true);
    const audit = retentionAuditWorkspace({
      projectRoot: root,
      hostStateRoot,
      now: new Date("2026-01-01T03:00:01.000Z"),
    });
    expect(audit.staleReviews).toEqual([
      expect.objectContaining({ id: receipt.id, path: receipt.path, status: "blocked" }),
    ]);
    expect(audit.remoteDeletionEnabled).toBe(false);

    rmSync(join(receipt.path, "valuable.txt"));
    git(root, "worktree", "remove", receipt.path);
    rmdirSync(join(receipt.path, ".."));
  });

  it("audits malformed receipts and expired lifecycle locks without mutating them", () => {
    const root = repository();
    configure(root, { leaseTtlHours: 1, reviewTtlMinutes: 1 });
    const hostStateRoot = mkdtempSync(join(tmpdir(), "harness-host-state-"));
    repositories.push(hostStateRoot);
    const reviewDirectory = join(hostStateRoot, "reviews");
    mkdirSync(reviewDirectory, { recursive: true });
    writeFileSync(join(reviewDirectory, "invalid.json"), JSON.stringify({ kind: "other" }));
    writeFileSync(join(reviewDirectory, "complete.json"), JSON.stringify({
      schemaVersion: "worktree-delivery/1.0",
      kind: "review-receipt",
      id: "complete",
      projectDir: root,
      commonDir: git(root, "rev-parse", "--path-format=absolute", "--git-common-dir"),
      commit: git(root, "rev-parse", "HEAD"),
      path: join(root, "..", "already-cleaned"),
      receiptPath: join(reviewDirectory, "complete.json"),
      command: ["true"],
      createdAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z",
      status: "cleaned",
      detached: true,
      dirty: false,
      exitCode: 0,
      output: "",
    }));
    const commonDir = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
    const stateDirectory = join(commonDir, "harness", "worktree-delivery");
    const applyLock = join(stateDirectory, "apply.lock");
    const reviewLock = join(stateDirectory, "review.lock");
    mkdirSync(applyLock, { recursive: true });
    mkdirSync(reviewLock, { recursive: true });
    const old = new Date("2026-01-01T00:00:00.000Z");
    utimesSync(applyLock, old, old);
    utimesSync(reviewLock, old, old);

    const audit = retentionAuditWorkspace({
      projectRoot: root,
      hostStateRoot,
      now: new Date("2026-01-02T00:00:00.000Z"),
    });
    expect(audit.errors).toEqual([expect.stringContaining("not a review receipt")]);
    expect(audit.staleReviews).toEqual([]);
    expect(audit.staleLocks).toHaveLength(2);
    expect(existsSync(applyLock)).toBe(true);
    expect(existsSync(reviewLock)).toBe(true);
  });

  it("reports an unavailable configured provider as blocked", () => {
    const root = repository();
    const configured = planWorkspaceConfiguration({
      projectRoot: root,
      mode: "enforced",
      allowedRoots: [join(root, "..")],
      provider: { kind: "gitlab", repository: "example/project" },
    });
    applyWorkspacePlan({
      projectRoot: root,
      planPath: configured.path,
      approval: configured.plan.planHash,
    });

    const audit = auditWorkspace(root);
    const mapping = audit.policies.find(
      (policy) => policy.id === "workspace.mapping-consistency",
    );
    expect(audit.passing).toBe(false);
    expect(mapping).toMatchObject({
      configured: true,
      enforced: false,
      passing: false,
      status: "blocked",
    });
    for (const id of [
      "workspace.clean-before-close",
      "workspace.unique-commits-protected",
      "workspace.done-no-persistent-worktree",
    ]) {
      expect(audit.policies.find((policy) => policy.id === id)).toMatchObject({
        status: "blocked",
        passing: false,
      });
    }
  });
});
