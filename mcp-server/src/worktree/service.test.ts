import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashObject, prettyJson, withoutHash } from "../v2/fs.js";
import {
  applyWorkspacePlan,
  auditWorkspace,
  parseWorktreePorcelain,
  planWorkspaceAllocation,
  planWorkspaceClose,
  planWorkspaceConfiguration,
  rollbackWorkspaceChange,
  reviewWorkspace,
  retentionAuditWorkspace,
  workspaceStatus,
} from "./service.js";

const repositories: string[] = [];

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

afterEach(() => {
  for (const root of repositories.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("portable worktree inventory", () => {
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
    writeFileSync(join(leaseDir, "a.json"), JSON.stringify({ ...base, path: "/tmp/one" }));
    writeFileSync(join(leaseDir, "b.json"), JSON.stringify({ ...base, path: "/tmp/two" }));

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
    })).toThrow(/WORKTREE_CONFIG_INVALID/);
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
      path: "/tmp/other",
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
    expect(workspaceStatus(root).configured).toBe(false);
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

describe("temporary review and retention", () => {
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
      path: "/tmp/already-cleaned",
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
  });
});
