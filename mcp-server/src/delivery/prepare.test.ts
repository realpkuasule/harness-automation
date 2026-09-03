import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { appendReceiptEvent, readLkgChain, readReceiptChain } from "../receipt/service.js";
import { admitSession } from "../session/admission.js";
import { hashObject, sha256, withoutHash } from "../v2/fs.js";
import { workspaceStatus } from "../worktree/service.js";
import { authorizeDelivery, deliveryStatus, pushDelivery } from "./service.js";
import {
  deliveryPrepareJournalSchema,
  deliveryPreparePlanSchema,
  prepareDelivery,
  type DeliveryPrepareJournal,
  type DeliveryPrepareOptions,
} from "./prepare.js";

const fixtures: string[] = [];
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const repositoryRoot = join(packageRoot, "..");
const fixedNow = new Date("2026-09-03T12:00:00.000Z");

function write(root: string, relativePath: string, value: unknown): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: "harness@example.test",
      GIT_AUTHOR_NAME: "Harness Test",
      GIT_COMMITTER_EMAIL: "harness@example.test",
      GIT_COMMITTER_NAME: "Harness Test",
    },
  }).trim();
}

interface Fixture {
  root: string;
  target: string;
  commonDir: string;
  session: string;
  options: DeliveryPrepareOptions;
}

function fixture(provider: "none" | "github" = "none", suffix = "base"): Fixture {
  const root = mkdtempSync(join(tmpdir(), `harness-delivery-prepare-${suffix}-`));
  const target = `${root}-delivery`;
  fixtures.push(root, target);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "harness@example.test");
  git(root, "config", "user.name", "Harness Test");
  write(root, "README.md", "# fixture\n");
  write(root, ".harness/policy.yaml", { schemaVersion: "2.0", project: { owner: "fixture-owner" }, policies: [] });
  write(root, ".harness/worktree-delivery.json", {
    schemaVersion: "1.0",
    mode: "enforced",
    managementBranch: "main",
    maxPersistentWorktrees: 4,
    leaseTtlHours: 168,
    reviewTtlMinutes: 120,
    remoteBranchRetentionDays: 1,
    remoteBranchDeletion: true,
    provider: provider === "none" ? { kind: "none" } : { kind: "github", repository: "example/project" },
  });
  mkdirSync(join(root, "scripts"), { recursive: true });
  cpSync(join(repositoryRoot, "scripts/task.py"), join(root, "scripts/task.py"));
  cpSync(join(repositoryRoot, "scripts/local_tracking.py"), join(root, "scripts/local_tracking.py"));
  if (provider === "github") {
    write(root, ".github/project-workflow.json", {
      repo: "example/project",
      workflow: { sourceOfTruth: "github-issues-project" },
    });
    git(root, "remote", "add", "origin", "https://github.com/example/project.git");
  }
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "initial");
  const commonDir = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
  write(commonDir, "harness/worktree-delivery/host-binding.json", {
    schemaVersion: "1.0",
    allowedRoots: [dirname(root)],
    protectedRoots: [root, commonDir, "/"],
    approval: { mode: "manual" },
  });
  const contextReceipt = ".harness/sessions/context.json";
  const policy = JSON.parse(readFileSync(join(root, ".harness/policy.yaml"), "utf8")) as unknown;
  write(root, contextReceipt, {
    schemaVersion: "2.0",
    startedAt: fixedNow.toISOString(),
    policyDigest: hashObject(policy),
    owner: "fixture-owner",
    agent: "codex",
  });
  const session = `prepare-${suffix}`;
  admitSession({
    projectRoot: root,
    session,
    intent: "new-code",
    contextReceipt,
    now: fixedNow,
  });
  return {
    root,
    target,
    commonDir,
    session,
    options: {
      projectRoot: root,
      session,
      confirmation: "创建导出功能的独立交付工作区",
      baseRef: "refs/heads/main",
      baseSha: git(root, "rev-parse", "HEAD"),
      localOnly: provider === "none",
      title: "Export data",
      description: "Add deterministic export support.",
      owner: "fixture-owner",
      path: target,
      now: fixedNow,
    },
  };
}

function managementEvidence(root: string): Record<string, string> {
  return {
    branch: git(root, "symbolic-ref", "--short", "HEAD"),
    head: git(root, "rev-parse", "HEAD"),
    index: git(root, "write-tree"),
    status: git(root, "status", "--porcelain=v1", "--untracked-files=all"),
  };
}

function board(item: Fixture): Record<string, unknown> {
  return JSON.parse(readFileSync(join(item.commonDir, "harness/local-tracking/TASK.json"), "utf8")) as Record<string, unknown>;
}

function prepareTransaction(item: Fixture): string {
  return `prepare-${sha256(item.session).slice(0, 24)}`;
}

function runPrepareProcess(item: Fixture): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const serialized = {
    ...item.options,
    now: fixedNow.toISOString(),
    testPauseDuringWorkItemAdmissionMs: 400,
  };
  const script = `
import { prepareDelivery } from ${JSON.stringify(join(packageRoot, "src/delivery/prepare.ts"))};
const options = ${JSON.stringify(serialized)};
options.now = new Date(options.now);
const result = await prepareDelivery(options);
process.stdout.write(JSON.stringify(result));
`;
  return new Promise((resolveProcess) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: packageRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("close", (status) => resolveProcess({ status, stdout, stderr }));
  });
}

async function preparedGitHubIdentityFixture(suffix: string): Promise<{
  item: Fixture;
  branch: string;
  authorizationHash: string;
  transactionId: string;
}> {
  const item = fixture("github", suffix);
  const branch = `codex/7-${suffix}`;
  git(item.root, "worktree", "add", "-q", "-b", branch, item.target, item.options.baseSha);
  const authorization = authorizeDelivery({
    projectRoot: item.target,
    workItem: "github:example/project#7",
    baseBranch: "main",
    featureBranch: branch,
    allowedPaths: ["README.md"],
    intent: "Legacy delivery before v3 Prepare",
    approvalSource: "test-before-prepare",
    now: fixedNow,
  }).authorization;
  const result = await prepareDelivery({
    ...item.options,
    workItem: "github:example/project#7",
    githubRequest: (_root, args) => args.includes("GET")
      ? { ok: true, value: {
          number: 7,
          node_id: "ISSUE_7",
          state: "open",
          title: "Export data",
          body: "",
          html_url: "https://github.com/example/project/issues/7",
          updated_at: fixedNow.toISOString(),
        } }
      : { ok: false, error: "unexpected request" },
  });
  const chain = readReceiptChain<DeliveryPrepareJournal>({
    root: item.commonDir,
    domain: "delivery-prepare",
    transactionId: result.transactionId,
  });
  const prepared: DeliveryPrepareJournal = {
    ...chain.at(-1)!.snapshot,
    phase: "prepared",
    state: "Prepared",
    outcome: "PreparedNotOpened",
    blocked: false,
    branch,
    path: realpathSync.native(item.target),
    updatedAt: new Date(fixedNow.getTime() + 1_000).toISOString(),
    journalHash: "",
  };
  const unhashed = { ...prepared };
  delete (unhashed as Partial<DeliveryPrepareJournal>).journalHash;
  prepared.journalHash = hashObject(unhashed);
  appendReceiptEvent({
    root: item.commonDir,
    domain: "delivery-prepare",
    transactionId: result.transactionId,
    snapshot: deliveryPrepareJournalSchema.parse(prepared),
    projection: {
      root: item.commonDir,
      path: `harness/delivery-prepare/journals/${result.transactionId}.json`,
    },
  });
  return { item, branch, authorizationHash: authorization.authorizationHash, transactionId: result.transactionId };
}

afterEach(() => {
  for (const path of fixtures.splice(0).reverse()) {
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  }
});

describe("delivery prepare", () => {
  it("prepares one Local-only task, branch, worktree, lease, and binding without changing management", async () => {
    const item = fixture("none", "happy");
    const before = managementEvidence(item.root);
    const result = await prepareDelivery(item.options);

    expect(result).toMatchObject({
      schemaVersion: "delivery-prepare/1.0",
      kind: "delivery-prepare-receipt",
      mode: "local-only",
      phase: "prepared",
      state: "Prepared",
      outcome: "PreparedNotOpened",
      attachments: [],
      workItem: "local:P0-1",
      path: realpathSync.native(item.target),
      reused: false,
    });
    expect(result.branch).toBe("codex/P0-1-export-data");
    expect(managementEvidence(item.root)).toEqual(before);
    const status = workspaceStatus(item.root);
    expect(status.leases).toEqual(expect.arrayContaining([
      expect.objectContaining({
        workItem: "local:P0-1",
        branch: result.branch,
        path: realpathSync.native(item.target),
        thread: item.session,
      }),
    ]));
    expect(status.worktrees).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: realpathSync.native(item.target), branch: result.branch, head: result.baseSha, dirty: false }),
    ]));
    expect((board(item).tasks as unknown[])).toHaveLength(1);

    const chain = readReceiptChain({ root: item.commonDir, domain: "delivery-prepare", transactionId: result.transactionId });
    expect(new Set(chain.map((event) => (event.snapshot as { phase: string }).phase))).toEqual(new Set([
      "planned", "work-item-admitted", "claim-acquired", "workspace-established", "binding-seeded", "prepared",
    ]));
    expect(chain.every((event) => deliveryPrepareJournalSchema.safeParse(event.snapshot).success)).toBe(true);
    expect(readLkgChain({ root: item.commonDir, domain: "delivery-prepare" })).toHaveLength(1);
    expect(existsSync(join(item.root, ".harness/plans", `${result.workspaceReceiptId}.json`))).toBe(false);

    const repeated = await prepareDelivery(item.options);
    expect(repeated).toMatchObject({ ...result, reused: true });
    expect((board(item).tasks as unknown[])).toHaveLength(1);
    expect(readLkgChain({ root: item.commonDir, domain: "delivery-prepare" })).toHaveLength(1);
  });

  it("exposes the same one-confirmation Local-only flow through the session CLI", () => {
    const item = fixture("none", "cli");
    const result = spawnSync(process.execPath, [
      "--import", "tsx", join(packageRoot, "src/cli.ts"),
      "session", "prepare",
      "--project", item.root,
      "--session", item.session,
      "--confirm", item.options.confirmation,
      "--base", item.options.baseRef,
      "--base-sha", item.options.baseSha,
      "--local-only",
      "--title", item.options.title!,
      "--description", item.options.description!,
      "--owner", item.options.owner,
      "--path", item.target,
    ], { cwd: packageRoot, encoding: "utf8", timeout: 30_000 });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "local-only",
      outcome: "PreparedNotOpened",
      workItem: "local:P0-1",
    });
  });

  it("reuses one explicitly selected Local-only work item without creating another", async () => {
    const item = fixture("none", "existing-task");
    execFileSync(process.env.PYTHON?.trim() || "python3", [
      join(item.root, "scripts/task.py"), "--local-only", "add", "0", "Existing task", "Already admitted", "--by", "fixture-owner",
    ], {
      cwd: item.root,
      env: { ...process.env, HARNESS_REPO_ROOT: item.root, PYTHONDONTWRITEBYTECODE: "1" },
    });

    const result = await prepareDelivery({ ...item.options, workItem: "local:P0-1" });
    expect(result).toMatchObject({ workItem: "local:P0-1", state: "Prepared", outcome: "PreparedNotOpened" });
    expect((board(item).tasks as unknown[])).toHaveLength(1);
  });

  it("recovers the exact transaction-owned workspace plan after a pre-journal process crash", async () => {
    const item = fixture("none", "orphan-plan");
    await expect(prepareDelivery({ ...item.options, testCrashAfterWorkspacePlan: true }))
      .rejects.toThrow("TEST_DELIVERY_PREPARE_AFTER_WORKSPACE_PLAN");
    expect(readdirSync(join(item.root, ".harness/plans")).filter((name) => name.endsWith(".json"))).toHaveLength(1);

    const result = await prepareDelivery(item.options);
    expect(result).toMatchObject({ state: "Prepared", outcome: "PreparedNotOpened", path: realpathSync.native(item.target) });
    expect(readdirSync(join(item.root, ".harness/plans")).filter((name) => name.endsWith(".json"))).toHaveLength(0);
  });

  it("single-flights concurrent retries of the same transaction", async () => {
    const item = fixture("none", "concurrent");
    const [first, second] = await Promise.all([
      prepareDelivery(item.options),
      prepareDelivery(item.options),
    ]);

    expect(first.transactionId).toBe(second.transactionId);
    expect(first.planHash).toBe(second.planHash);
    expect(first.receiptEventHash).toBe(second.receiptEventHash);
    expect(first.lkgRecordHash).toBe(second.lkgRecordHash);
    expect((board(item).tasks as unknown[])).toHaveLength(1);
    const status = workspaceStatus(item.root);
    expect(status.leases.filter((lease) => lease.workItem === first.workItem)).toHaveLength(1);
    expect(status.worktrees.filter((worktree) => worktree.path === realpathSync.native(item.target))).toHaveLength(1);
    const chain = readReceiptChain({ root: item.commonDir, domain: "delivery-prepare", transactionId: first.transactionId });
    const semanticPhases = chain.map((event) => (event.snapshot as { phase: string }).phase)
      .filter((phase, index, phases) => index === 0 || phase !== phases[index - 1]);
    expect(semanticPhases).toEqual([
      "planned", "work-item-admitted", "claim-acquired", "workspace-established", "binding-seeded", "prepared",
    ]);
    expect(readLkgChain({ root: item.commonDir, domain: "delivery-prepare" })).toHaveLength(1);
  });

  it("single-flights the same transaction across independent Node processes", async () => {
    const item = fixture("none", "concurrent-processes");
    const [first, second] = await Promise.all([runPrepareProcess(item), runPrepareProcess(item)]);

    expect([first.status, second.status]).toEqual([0, 0]);
    const receipts = [first, second].map((result) => JSON.parse(result.stdout) as {
      transactionId: string;
      receiptEventHash: string;
      lkgRecordHash: string;
      workItem: string;
    });
    expect(receipts[0].transactionId).toBe(receipts[1].transactionId);
    expect(receipts[0].receiptEventHash).toBe(receipts[1].receiptEventHash);
    expect(receipts[0].lkgRecordHash).toBe(receipts[1].lkgRecordHash);
    expect((board(item).tasks as unknown[])).toHaveLength(1);
    const status = workspaceStatus(item.root);
    expect(status.leases.filter((lease) => lease.workItem === receipts[0].workItem)).toHaveLength(1);
    expect(status.worktrees.filter((worktree) => worktree.path === realpathSync.native(item.target))).toHaveLength(1);
    const chain = readReceiptChain({
      root: item.commonDir,
      domain: "delivery-prepare",
      transactionId: receipts[0].transactionId,
    });
    const semanticPhases = chain.map((event) => (event.snapshot as { phase: string }).phase)
      .filter((phase, index, phases) => index === 0 || phase !== phases[index - 1]);
    expect(semanticPhases).toEqual([
      "planned", "work-item-admitted", "claim-acquired", "workspace-established", "binding-seeded", "prepared",
    ]);
    expect(readLkgChain({ root: item.commonDir, domain: "delivery-prepare" })).toHaveLength(1);
  });

  it.each(["working-tree", "index", "head", "plan"] as const)(
    "does not hide %s drift behind an orphan workspace plan",
    async (drift) => {
      const item = fixture("none", `orphan-${drift}`);
      await expect(prepareDelivery({ ...item.options, testCrashAfterWorkspacePlan: true }))
        .rejects.toThrow("TEST_DELIVERY_PREPARE_AFTER_WORKSPACE_PLAN");
      if (drift === "plan") {
        const [name] = readdirSync(join(item.root, ".harness/plans")).filter((entry) => entry.endsWith(".json"));
        const path = join(item.root, ".harness/plans", name);
        const workspacePlan = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        workspacePlan.warnings = ["tampered after crash"];
        workspacePlan.planHash = hashObject(withoutHash(workspacePlan));
        writeFileSync(path, `${JSON.stringify(workspacePlan, null, 2)}\n`, "utf8");
      } else {
        write(item.root, "unrelated.txt", `${drift}\n`);
        if (drift === "index" || drift === "head") git(item.root, "add", "unrelated.txt");
        if (drift === "head") git(item.root, "commit", "-q", "-m", "unrelated drift");
      }

      await expect(prepareDelivery(item.options)).rejects.toThrow(
        drift === "head" ? "DELIVERY_PREPARE_ADMISSION_DRIFT" : "DELIVERY_PREPARE_RECOVERY_REQUIRED",
      );
      expect(existsSync(item.target)).toBe(false);
      expect(workspaceStatus(item.root).leases).toHaveLength(0);
    },
  );

  it.each(["management-bytes", "host-binding"] as const)(
    "revalidates %s after a workspace plan is journal-bound and immediately before apply",
    async (drift) => {
      const item = fixture("none", `bound-${drift}`);
      await expect(prepareDelivery({ ...item.options, testCrashAfterWorkspacePlanBound: true }))
        .rejects.toThrow("TEST_DELIVERY_PREPARE_AFTER_WORKSPACE_PLAN_BOUND");

      await expect(prepareDelivery({
        ...item.options,
        testBeforeWorkspaceApplyValidation: () => {
          if (drift === "management-bytes") {
            write(item.root, "late-drift.txt", "changed after entry validation\n");
          } else {
            const path = join(item.commonDir, "harness/worktree-delivery/host-binding.json");
            const binding = JSON.parse(readFileSync(path, "utf8")) as { allowedRoots: string[] };
            binding.allowedRoots.push(join(tmpdir(), "late-binding-drift"));
            writeFileSync(path, `${JSON.stringify(binding, null, 2)}\n`, "utf8");
          }
        },
      })).rejects.toThrow(drift === "management-bytes"
        ? "DELIVERY_PREPARE_MANAGEMENT_CHECKOUT_DRIFT"
        : "DELIVERY_PREPARE_ADMISSION_DRIFT");
      expect(existsSync(item.target)).toBe(false);
      expect(workspaceStatus(item.root).leases).toHaveLength(0);
    },
  );

  it("revalidates an adopted exact HEAD after its workspace plan is journal-bound", async () => {
    const item = fixture("none", "bound-adopted-head");
    execFileSync("python3", [
      join(repositoryRoot, "scripts/task.py"), "--local-only", "add", "0", "Existing task", "Already admitted", "--by", "fixture-owner",
    ], {
      cwd: item.root,
      env: { PATH: process.env.PATH, LANG: process.env.LANG ?? "C.UTF-8", HARNESS_REPO_ROOT: item.root, PYTHONDONTWRITEBYTECODE: "1" },
    });
    const branch = "codex/P0-1-bound-adopt";
    git(item.root, "worktree", "add", "-q", "-b", branch, item.target, item.options.baseSha);
    const options = { ...item.options, workItem: "local:P0-1", branch, path: item.target };
    await expect(prepareDelivery({ ...options, testCrashAfterWorkspacePlanBound: true }))
      .rejects.toThrow("TEST_DELIVERY_PREPARE_AFTER_WORKSPACE_PLAN_BOUND");

    await expect(prepareDelivery({
      ...options,
      testBeforeWorkspaceApplyValidation: () => {
        write(item.target, "late-head.txt", "advance adopted worktree\n");
        git(item.target, "add", "late-head.txt");
        git(item.target, "commit", "-q", "-m", "late adopted drift");
      },
    })).rejects.toThrow("DELIVERY_PREPARE_ADOPTION_HEAD_DRIFT");
    expect(existsSync(item.target)).toBe(true);
    expect(workspaceStatus(item.root).leases).toHaveLength(0);
  });

  it("executes only the bundled Local-only tracker with a minimal child environment", async () => {
    const item = fixture("none", "bundled-script");
    const marker = join(item.root, "project-script-ran");
    writeFileSync(join(item.root, "scripts/task.py"), [
      "import os",
      `open(${JSON.stringify(marker)}, 'w').write(os.environ.get('GH_TOKEN', 'missing'))`,
    ].join("\n"), "utf8");
    const previous = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "secret-canary";
    try {
      const result = await prepareDelivery(item.options);
      expect(result.workItem).toBe("local:P0-1");
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = previous;
    }
  });

  it("adopts one explicitly confirmed clean Worktree without rewriting it", async () => {
    const item = fixture("none", "adopt");
    execFileSync("python3", [
      join(repositoryRoot, "scripts/task.py"), "--local-only", "add", "0", "Existing task", "Already admitted", "--by", "fixture-owner",
    ], {
      cwd: item.root,
      env: { PATH: process.env.PATH, LANG: process.env.LANG ?? "C.UTF-8", HARNESS_REPO_ROOT: item.root, PYTHONDONTWRITEBYTECODE: "1" },
    });
    const branch = "codex/P0-1-adopt";
    git(item.root, "worktree", "add", "-q", "-b", branch, item.target, item.options.baseSha);
    const before = managementEvidence(item.root);

    const result = await prepareDelivery({
      ...item.options,
      workItem: "local:P0-1",
      branch,
      path: item.target,
    });

    expect(result).toMatchObject({
      state: "Prepared",
      workItem: "local:P0-1",
      branch,
      path: realpathSync.native(item.target),
    });
    expect(managementEvidence(item.root)).toEqual(before);
    expect(workspaceStatus(item.root).leases).toEqual(expect.arrayContaining([
      expect.objectContaining({ workItem: "local:P0-1", branch, path: realpathSync.native(item.target) }),
    ]));
  });

  it("adopts a clean committed Worktree ahead of management without rewriting it", async () => {
    const item = fixture("none", "adopt-ahead");
    execFileSync("python3", [
      join(repositoryRoot, "scripts/task.py"), "--local-only", "add", "0", "Existing task", "Already admitted", "--by", "fixture-owner",
    ], {
      cwd: item.root,
      env: { PATH: process.env.PATH, LANG: process.env.LANG ?? "C.UTF-8", HARNESS_REPO_ROOT: item.root, PYTHONDONTWRITEBYTECODE: "1" },
    });
    const branch = "codex/P0-1-adopt-ahead";
    git(item.root, "worktree", "add", "-q", "-b", branch, item.target, item.options.baseSha);
    write(item.target, "ahead.txt", "committed ahead\n");
    git(item.target, "add", "ahead.txt");
    git(item.target, "commit", "-q", "-m", "feat: ahead worktree commit");
    const adoptedHead = git(item.target, "rev-parse", "HEAD");
    const before = managementEvidence(item.root);

    const result = await prepareDelivery({ ...item.options, workItem: "local:P0-1", branch, path: item.target });

    expect(result).toMatchObject({ state: "Prepared", branch, path: realpathSync.native(item.target) });
    expect(git(item.target, "rev-parse", "HEAD")).toBe(adoptedHead);
    expect(git(item.target, "symbolic-ref", "--short", "HEAD")).toBe(branch);
    expect(managementEvidence(item.root)).toEqual(before);
    expect(workspaceStatus(item.root).leases).toEqual(expect.arrayContaining([
      expect.objectContaining({ workItem: "local:P0-1", branch, acceptedCommit: adoptedHead }),
    ]));
  });

  it("recovers an exact transaction-owned adoption plan after a pre-journal process crash", async () => {
    const item = fixture("none", "adopt-orphan");
    execFileSync("python3", [
      join(repositoryRoot, "scripts/task.py"), "--local-only", "add", "0", "Existing task", "Already admitted", "--by", "fixture-owner",
    ], {
      cwd: item.root,
      env: { PATH: process.env.PATH, LANG: process.env.LANG ?? "C.UTF-8", HARNESS_REPO_ROOT: item.root, PYTHONDONTWRITEBYTECODE: "1" },
    });
    const branch = "codex/P0-1-adopt-orphan";
    git(item.root, "worktree", "add", "-q", "-b", branch, item.target, item.options.baseSha);
    const options = { ...item.options, workItem: "local:P0-1", branch, path: item.target };

    await expect(prepareDelivery({ ...options, testCrashAfterWorkspacePlan: true }))
      .rejects.toThrow("TEST_DELIVERY_PREPARE_AFTER_WORKSPACE_PLAN");
    const result = await prepareDelivery(options);
    expect(result).toMatchObject({ state: "Prepared", branch, path: realpathSync.native(item.target) });
    expect(workspaceStatus(item.root).leases).toEqual(expect.arrayContaining([
      expect.objectContaining({ workItem: "local:P0-1", branch, path: realpathSync.native(item.target) }),
    ]));
  });

  it.each(["planned", "work-item-admitted", "claim-acquired", "workspace-established", "binding-seeded", "prepared"] as const)(
    "resumes once after an injected failure following %s without duplicating objects",
    async (phase) => {
      const item = fixture("none", `resume-${phase}`);
      await expect(prepareDelivery({ ...item.options, testFailAfter: phase })).rejects.toThrow("DELIVERY_PREPARE_RECOVERY_REQUIRED");
      const result = await prepareDelivery(item.options);
      expect(result).toMatchObject({ outcome: "PreparedNotOpened", state: "Prepared", path: realpathSync.native(item.target) });
      expect((board(item).tasks as unknown[])).toHaveLength(1);
      expect(workspaceStatus(item.root).leases.filter((lease) => lease.workItem === result.workItem)).toHaveLength(1);
    },
  );

  it.each(["dirty", "head"] as const)("preserves a prepared asset when its %s drifts during recovery", async (drift) => {
    const item = fixture("none", `drift-${drift}`);
    await expect(prepareDelivery({ ...item.options, testFailAfter: "workspace-established" }))
      .rejects.toThrow("DELIVERY_PREPARE_RECOVERY_REQUIRED");
    write(item.target, "changed.txt", `${drift}\n`);
    if (drift === "head") {
      git(item.target, "add", "changed.txt");
      git(item.target, "commit", "-q", "-m", "drift");
    }

    await expect(prepareDelivery(item.options)).rejects.toThrow("DELIVERY_PREPARE_RECOVERY_REQUIRED");
    expect(existsSync(item.target)).toBe(true);
    expect(git(item.target, "symbolic-ref", "--short", "HEAD")).toBe("codex/P0-1-export-data");
    expect(workspaceStatus(item.root).leases).toEqual(expect.arrayContaining([
      expect.objectContaining({ workItem: "local:P0-1", path: realpathSync.native(item.target) }),
    ]));
  });

  it("rejects management HEAD drift before creating a Work Item or workspace", async () => {
    const item = fixture("none", "pre-mutation-drift");
    await expect(prepareDelivery({ ...item.options, testFailAfter: "planned" }))
      .rejects.toThrow("DELIVERY_PREPARE_RECOVERY_REQUIRED");
    write(item.root, "README.md", "# changed\n");
    git(item.root, "add", "README.md");
    git(item.root, "commit", "-q", "-m", "advance management");

    await expect(prepareDelivery(item.options)).rejects.toThrow("DELIVERY_PREPARE_ADMISSION_DRIFT");
    expect(existsSync(join(item.commonDir, "harness/local-tracking/TASK.json"))).toBe(false);
    expect(existsSync(item.target)).toBe(false);
    expect(workspaceStatus(item.root).leases).toHaveLength(0);
  });

  it("revalidates admission host binding before resuming any mutation", async () => {
    const item = fixture("none", "admission-drift");
    await expect(prepareDelivery({ ...item.options, testFailAfter: "planned" }))
      .rejects.toThrow("DELIVERY_PREPARE_RECOVERY_REQUIRED");
    const bindingPath = join(item.commonDir, "harness/worktree-delivery/host-binding.json");
    const binding = JSON.parse(readFileSync(bindingPath, "utf8")) as { allowedRoots: string[] };
    binding.allowedRoots.push(join(tmpdir(), "another-root"));
    writeFileSync(bindingPath, `${JSON.stringify(binding, null, 2)}\n`, "utf8");

    await expect(prepareDelivery(item.options)).rejects.toThrow(/DELIVERY_PREPARE_ADMISSION_DRIFT|DELIVERY_PREPARE_RECOVERY_REQUIRED/);
    expect(existsSync(join(item.commonDir, "harness/local-tracking/TASK.json"))).toBe(false);
    expect(existsSync(item.target)).toBe(false);
  });

  it("binds dirty and untracked bytes rather than only porcelain path names", async () => {
    const item = fixture("none", "dirty-bytes");
    write(item.root, "scratch.txt", "first bytes\n");
    await expect(prepareDelivery({ ...item.options, testFailAfter: "planned" }))
      .rejects.toThrow("DELIVERY_PREPARE_RECOVERY_REQUIRED");
    write(item.root, "scratch.txt", "other bytes\n");

    await expect(prepareDelivery(item.options)).rejects.toThrow("DELIVERY_PREPARE_MANAGEMENT_CHECKOUT_DRIFT");
    expect(existsSync(join(item.commonDir, "harness/local-tracking/TASK.json"))).toBe(false);
    expect(existsSync(item.target)).toBe(false);
  });

  it("creates and verifies a GitHub Issue, then fails closed before branch or worktree creation", async () => {
    const item = fixture("github", "github");
    let issueBody = "";
    let issueCreates = 0;
    const request = (_root: string, args: string[]): { ok: boolean; value?: unknown; error?: string } => {
      if (args.includes("graphql")) {
        return {
          ok: true,
          value: { data: { repository: {
            id: "REPO_1", nameWithOwner: "example/project",
            issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          } } },
        };
      }
      if (args.includes("POST")) {
        issueCreates += 1;
        issueBody = args.find((argument) => argument.startsWith("body="))?.slice(5) ?? "";
        return { ok: true, value: { number: 7, node_id: "ISSUE_7" } };
      }
      if (args.includes("GET")) {
        return { ok: true, value: {
          number: 7,
          node_id: "ISSUE_7",
          state: "open",
          title: "Export data",
          body: issueBody,
          html_url: "https://github.com/example/project/issues/7",
          updated_at: fixedNow.toISOString(),
        } };
      }
      return { ok: false, error: "unexpected request" };
    };

    const result = await prepareDelivery({ ...item.options, githubRequest: request });
    expect(result).toMatchObject({
      mode: "github",
      state: "Admitted",
      outcome: "CoordinationBackendRequired",
      attachments: ["Blocked"],
      workItem: "github:example/project#7",
      branch: null,
      path: null,
    });
    expect(issueCreates).toBe(1);
    expect(workspaceStatus(item.root).worktrees).toHaveLength(1);
    expect(workspaceStatus(item.root).leases).toHaveLength(0);
    expect(existsSync(join(item.commonDir, "harness/local-tracking/TASK.json"))).toBe(false);
    expect(readLkgChain({ root: item.commonDir, domain: "delivery-prepare" })).toHaveLength(0);
    expect((await prepareDelivery({ ...item.options, githubRequest: request }))).toMatchObject({ reused: true });
    expect(issueCreates).toBe(1);
  });

  it("blocks legacy authorize and push after Prepare records CoordinationBackendRequired", async () => {
    const item = fixture("github", "github-bypass");
    const branch = "codex/7-manual";
    git(item.root, "worktree", "add", "-q", "-b", branch, item.target, item.options.baseSha);
    const authorization = authorizeDelivery({
      projectRoot: item.target,
      workItem: "github:example/project#7",
      baseBranch: "main",
      featureBranch: branch,
      allowedPaths: ["README.md"],
      intent: "Deliver manually created worktree",
      approvalSource: "test-before-prepare",
      now: fixedNow,
    }).authorization;
    const request = (_root: string, args: string[]): { ok: boolean; value?: unknown; error?: string } => {
      if (!args.includes("GET")) return { ok: false, error: "unexpected request" };
      return { ok: true, value: {
        number: 7,
        node_id: "ISSUE_7",
        state: "open",
        title: "Export data",
        body: "",
        html_url: "https://github.com/example/project/issues/7",
        updated_at: fixedNow.toISOString(),
      } };
    };
    const blocked = await prepareDelivery({ ...item.options, workItem: "github:example/project#7", githubRequest: request });
    expect(blocked.outcome).toBe("CoordinationBackendRequired");

    const fakeBin = mkdtempSync(join(tmpdir(), "harness-prepare-push-"));
    fixtures.push(fakeBin);
    const pushed = join(fakeBin, "pushed");
    writeFileSync(join(fakeBin, "git"), `#!/bin/sh
if [ "$1" = "ls-remote" ]; then exit 0; fi
if [ "$1" = "push" ]; then touch ${JSON.stringify(pushed)}; exit 0; fi
exec /usr/bin/git "$@"
`, "utf8");
    chmodSync(join(fakeBin, "git"), 0o755);
    const savedPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${savedPath ?? ""}`;
    try {
      expect(() => pushDelivery({ projectRoot: item.target, authorizationHash: authorization.authorizationHash }))
        .toThrow("CoordinationBackendRequired");
      expect(existsSync(pushed)).toBe(false);
    } finally {
      process.env.PATH = savedPath;
    }

    const receiptDirectory = join(item.commonDir, "harness/worktree-delivery/receipts");
    const beforeAuthorizations = readdirSync(receiptDirectory).filter((name) => name.startsWith("delivery-authorization-")).length;
    expect(() => authorizeDelivery({
      projectRoot: item.target,
      workItem: blocked.workItem,
      baseBranch: "main",
      featureBranch: branch,
      allowedPaths: ["README.md"],
      intent: "Retry legacy authorization",
      approvalSource: "test-after-prepare",
    })).toThrow("CoordinationBackendRequired");
    expect(readdirSync(receiptDirectory).filter((name) => name.startsWith("delivery-authorization-"))).toHaveLength(beforeAuthorizations);
  });

  it("permanently suspends legacy delivery for a Prepared v3 identity", async () => {
    const prepared = await preparedGitHubIdentityFixture("prepared-identity");
    expect(deliveryStatus(prepared.item.target, prepared.authorizationHash).invalidation)
      .toBe("CoordinationBackendRequired");
  });

  it("uses immutable Prepare receipts when the mutable projection is absent", async () => {
    const prepared = await preparedGitHubIdentityFixture("receipt-first");
    rmSync(join(
      prepared.item.commonDir,
      "harness/delivery-prepare/journals",
      `${prepared.transactionId}.json`,
    ));
    expect(deliveryStatus(prepared.item.target, prepared.authorizationHash).invalidation)
      .toBe("CoordinationBackendRequired");
  });

  it("canonicalizes repository case and decimal issue aliases before the v3 legacy fence", async () => {
    const prepared = await preparedGitHubIdentityFixture("canonical-identity");
    expect(() => authorizeDelivery({
      projectRoot: prepared.item.target,
      workItem: "github:Example/Project#007",
      repository: "example/project",
      baseBranch: "main",
      featureBranch: prepared.branch,
      allowedPaths: ["README.md"],
      intent: "Alias must not bypass v3 coordination",
      approvalSource: "test-alias",
    })).toThrow("CoordinationBackendRequired");
  });

  it("does not switch a GitHub project to Local-only when the network is unavailable", async () => {
    const item = fixture("github", "network");
    await expect(prepareDelivery({
      ...item.options,
      githubRequest: () => ({ ok: false, error: "network unavailable" }),
    })).rejects.toThrow("DELIVERY_PREPARE_RECOVERY_REQUIRED");
    expect(existsSync(join(item.commonDir, "harness/local-tracking/TASK.json"))).toBe(false);
    expect(workspaceStatus(item.root).leases).toHaveLength(0);
    expect(workspaceStatus(item.root).worktrees).toHaveLength(1);
  });

  it("does not use ambient gh authentication for GitHub Prepare", async () => {
    const item = fixture("github", "credential");
    await expect(prepareDelivery(item.options)).rejects.toThrow("DELIVERY_PREPARE_GITHUB_CREDENTIAL_REQUIRED");
    expect(workspaceStatus(item.root).leases).toHaveLength(0);
    expect(workspaceStatus(item.root).worktrees).toHaveLength(1);
  });

  it("keeps Admission and existing-worktree facts on the credential-free local observation path", async () => {
    const item = fixture("github", "credential-local-facts");
    const leasedTarget = `${item.root}-leased`;
    fixtures.push(leasedTarget);
    const leasedBranch = "codex/99-existing";
    git(item.root, "worktree", "add", "-q", "-b", leasedBranch, leasedTarget, item.options.baseSha);
    write(item.commonDir, `harness/worktree-delivery/leases/${sha256("github:example/project#99")}.json`, {
      schemaVersion: "1.0",
      workItem: "github:example/project#99",
      branch: leasedBranch,
      path: realpathSync.native(leasedTarget),
      owner: "fixture-owner",
      acceptedCommit: item.options.baseSha,
      createdAt: fixedNow.toISOString(),
      heartbeatAt: fixedNow.toISOString(),
      status: "active",
    });
    const requestedBranch = "codex/7-existing";
    git(item.root, "worktree", "add", "-q", "-b", requestedBranch, item.target, item.options.baseSha);
    const fakeBin = mkdtempSync(join(tmpdir(), "harness-prepare-gh-canary-"));
    fixtures.push(fakeBin);
    const called = join(fakeBin, "ambient-gh-called");
    writeFileSync(join(fakeBin, "gh"), `#!/bin/sh\ntouch ${JSON.stringify(called)}\nprintf '{}'\n`, "utf8");
    chmodSync(join(fakeBin, "gh"), 0o755);
    const savedPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${savedPath ?? ""}`;
    try {
      const result = await prepareDelivery({
        ...item.options,
        workItem: "github:example/project#7",
        branch: requestedBranch,
        path: item.target,
        githubRequest: (_root, args) => args.includes("GET")
          ? { ok: true, value: {
              number: 7,
              node_id: "ISSUE_7",
              state: "open",
              title: "Export data",
              body: "",
              html_url: "https://github.com/example/project/issues/7",
              updated_at: fixedNow.toISOString(),
            } }
          : { ok: false, error: "unexpected request" },
      });
      expect(result.outcome).toBe("CoordinationBackendRequired");
      expect(existsSync(called)).toBe(false);
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it("does not silently adopt a branch that predates the Prepare transaction", async () => {
    const item = fixture("none", "legacy-branch");
    git(item.root, "branch", "codex/P0-1-export-data", "main");

    await expect(prepareDelivery(item.options)).rejects.toThrow("DELIVERY_PREPARE_EXISTING_ASSET_REQUIRES_ADOPTION");
    expect(existsSync(item.target)).toBe(false);
    expect(workspaceStatus(item.root).leases).toHaveLength(0);
    expect(git(item.root, "rev-parse", "codex/P0-1-export-data")).toBe(git(item.root, "rev-parse", "main"));
  });

  it("rejects tampered Prepare plans and journal projections", async () => {
    const planItem = fixture("none", "plan-tamper");
    await expect(prepareDelivery({ ...planItem.options, testFailAfter: "planned" }))
      .rejects.toThrow("DELIVERY_PREPARE_RECOVERY_REQUIRED");
    const planPath = join(planItem.commonDir, "harness/delivery-prepare/plans", `${prepareTransaction(planItem)}.json`);
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as Record<string, unknown>;
    writeFileSync(planPath, `${JSON.stringify({ ...plan, owner: "attacker" }, null, 2)}\n`, "utf8");
    expect(() => deliveryPreparePlanSchema.parse(JSON.parse(readFileSync(planPath, "utf8")))).not.toThrow();
    await expect(prepareDelivery(planItem.options)).rejects.toThrow("DELIVERY_PREPARE_PLAN_TAMPERED");

    const journalItem = fixture("none", "journal-tamper");
    await expect(prepareDelivery({ ...journalItem.options, testFailAfter: "planned" }))
      .rejects.toThrow("DELIVERY_PREPARE_RECOVERY_REQUIRED");
    const projection = join(journalItem.commonDir, "harness/delivery-prepare/journals", `${prepareTransaction(journalItem)}.json`);
    const journal = JSON.parse(readFileSync(projection, "utf8")) as Record<string, unknown>;
    writeFileSync(projection, `${JSON.stringify({ ...journal, state: "Prepared" }, null, 2)}\n`, "utf8");
    await expect(prepareDelivery(journalItem.options)).rejects.toThrow("DELIVERY_PREPARE_JOURNAL_TAMPERED");
  });
});
