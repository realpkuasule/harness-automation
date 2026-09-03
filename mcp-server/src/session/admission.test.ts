import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { readReceiptChain } from "../receipt/service.js";
import { hashObject, sha256 } from "../v2/fs.js";
import { admitSession } from "./admission.js";
import { SESSION_INTENTS, sessionAdmissionRecordSchema } from "./types.js";

const fixtures: string[] = [];
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(packageRoot, "src/cli.ts");
const originalPath = process.env.PATH;

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
  receipt: string;
}

function policy(owner = "fixture-owner"): Record<string, unknown> {
  return { schemaVersion: "2.0", project: { owner }, policies: [] };
}

function deliveryConfig(): Record<string, unknown> {
  return {
    schemaVersion: "1.0",
    mode: "audit-only",
    managementBranch: "main",
    maxPersistentWorktrees: 4,
    leaseTtlHours: 168,
    reviewTtlMinutes: 120,
    remoteBranchRetentionDays: 14,
    remoteBranchDeletion: false,
    provider: { kind: "none" },
  };
}

function contextReceipt(root: string, name = "context", at = "2026-09-03T00:00:00.000Z"): string {
  const relativePath = `.harness/sessions/${name}.json`;
  const currentPolicy = JSON.parse(readFileSync(join(root, ".harness/policy.yaml"), "utf8")) as unknown;
  write(root, relativePath, {
    schemaVersion: "2.0",
    startedAt: at,
    policyDigest: hashObject(currentPolicy),
    owner: "fixture-owner",
    agent: "codex",
  });
  return relativePath;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "harness-session-admission-"));
  fixtures.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "harness@example.test");
  git(root, "config", "user.name", "Harness Test");
  write(root, "README.md", "# fixture\n");
  write(root, ".harness/policy.yaml", policy());
  write(root, ".harness/worktree-delivery.json", deliveryConfig());
  git(root, "add", "README.md", ".harness/policy.yaml", ".harness/worktree-delivery.json");
  git(root, "commit", "-q", "-m", "initial");
  return { root, receipt: contextReceipt(root) };
}

function deliveryFixture(workItem = "local:42"): Fixture & { management: string; branch: string; workItem: string } {
  const management = fixture().root;
  const root = `${management}-delivery`;
  fixtures.push(root);
  const branch = "feature/42";
  write(management, ".harness/worktree-delivery.json", { ...deliveryConfig(), mode: "enforced" });
  git(management, "add", ".harness/worktree-delivery.json");
  git(management, "commit", "-q", "-m", "enable worktree enforcement");
  git(management, "worktree", "add", "-q", "-b", branch, root, "main");
  const receipt = contextReceipt(root);
  const commonDir = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const now = "2026-09-03T00:00:00.000Z";
  write(commonDir, "harness/worktree-delivery/host-binding.json", {
    schemaVersion: "1.0",
    allowedRoots: [dirname(management)],
    protectedRoots: [management, commonDir, "/"],
    approval: { mode: "manual" },
  });
  write(commonDir, `harness/worktree-delivery/leases/${sha256(workItem)}.json`, {
    schemaVersion: "1.0",
    workItem,
    branch,
    path: root,
    owner: "fixture-owner",
    acceptedCommit: git(root, "rev-parse", "HEAD"),
    createdAt: now,
    heartbeatAt: now,
    status: "active",
  });
  return { management, root, receipt, branch, workItem };
}

afterEach(() => {
  process.env.PATH = originalPath;
  for (const path of fixtures.splice(0).reverse()) {
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  }
});

describe("session admission", () => {
  it.each([
    ["read-only", "read-only"],
    ["new-code", "prepare-required"],
    ["unclear", "unclear"],
  ] as const)("records the %s intent without guessing prose", (selectedIntent, decision) => {
    const { root, receipt } = fixture();
    const result = admitSession({ projectRoot: root, session: `session-${selectedIntent}`, intent: selectedIntent, contextReceipt: receipt });

    expect(SESSION_INTENTS).toEqual(["read-only", "continue", "new-code", "unclear"]);
    expect(result).toMatchObject({
      schemaVersion: "session-admission/1.0",
      intent: selectedIntent,
      decision,
      enforcement: "managed-commands-only",
      managedWriteAllowed: false,
      receiptSequence: 1,
      reused: false,
    });
    expect(sessionAdmissionRecordSchema.safeParse(result).success).toBe(false);
  });

  it("allows continue only for the exact active work item, lease, worktree, and branch", () => {
    const item = deliveryFixture();
    const admitted = admitSession({
      projectRoot: item.root,
      session: "session-continue",
      intent: "continue",
      contextReceipt: item.receipt,
      workItem: item.workItem,
      managedWrite: true,
    });
    expect(admitted).toMatchObject({ decision: "continue", managedWriteAllowed: true });
    expect(admitted.facts).toMatchObject({ branch: item.branch, workItem: item.workItem, leaseWorkItem: item.workItem });

    expect(() => admitSession({
      projectRoot: item.root,
      session: "session-mismatch",
      intent: "continue",
      contextReceipt: item.receipt,
      workItem: "local:other",
    })).toThrow("SESSION_ADMISSION_CONTINUE_MISMATCH");
  });

  it("does not authorize managed writes while workspace governance is audit-only", () => {
    const item = deliveryFixture();
    write(item.root, ".harness/worktree-delivery.json", deliveryConfig());

    expect(() => admitSession({
      projectRoot: item.root,
      session: "session-audit-only",
      intent: "continue",
      contextReceipt: item.receipt,
      workItem: item.workItem,
      managedWrite: true,
    })).toThrow("SESSION_ADMISSION_DELIVERY_FACTS_INVALID");
  });

  it("reuses an unchanged old session without requiring intent again", () => {
    const { root, receipt } = fixture();
    const first = admitSession({ projectRoot: root, session: "session-reuse", intent: "read-only", contextReceipt: receipt });
    const second = admitSession({ projectRoot: root, session: "session-reuse" });
    const commonDir = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");

    expect(second).toMatchObject({ reused: true, receiptSequence: 1, recordedAt: first.recordedAt });
    expect(readReceiptChain({ root: commonDir, domain: "session-admission", transactionId: "session-reuse" })).toHaveLength(1);
  });

  it("requires a current context receipt and explicit intent only on first admission", () => {
    const { root, receipt } = fixture();
    expect(() => admitSession({ projectRoot: root, session: "session-context", intent: "read-only" }))
      .toThrow("SESSION_ADMISSION_CONTEXT_REQUIRED");
    expect(() => admitSession({ projectRoot: root, session: "session-context", contextReceipt: receipt }))
      .toThrow("SESSION_ADMISSION_INTENT_REQUIRED");
  });

  it("requires explicit reclassification when intent changes", () => {
    const { root, receipt } = fixture();
    admitSession({ projectRoot: root, session: "session-intent", intent: "read-only", contextReceipt: receipt });
    expect(() => admitSession({ projectRoot: root, session: "session-intent", intent: "new-code" }))
      .toThrow("SESSION_ADMISSION_RECLASSIFICATION_REQUIRED");
    expect(admitSession({ projectRoot: root, session: "session-intent", intent: "new-code", reclassify: true }))
      .toMatchObject({ decision: "prepare-required", receiptSequence: 2 });
  });

  it("deterministically revalidates the prior intent after HEAD changes", () => {
    const { root, receipt } = fixture();
    admitSession({ projectRoot: root, session: "session-head", intent: "read-only", contextReceipt: receipt });
    write(root, "README.md", "# changed\n");
    git(root, "add", "README.md");
    git(root, "commit", "-q", "-m", "change head");

    expect(admitSession({ projectRoot: root, session: "session-head" }))
      .toMatchObject({ reused: false, receiptSequence: 2 });
  });

  it("revalidates branch, path, and config drift but requires reclassification for a changed work item", () => {
    const { root, receipt } = fixture();
    admitSession({ projectRoot: root, session: "session-branch", intent: "read-only", contextReceipt: receipt });
    git(root, "switch", "-q", "-c", "other");
    expect(admitSession({ projectRoot: root, session: "session-branch" }))
      .toMatchObject({ reused: false, receiptSequence: 2, intent: "read-only" });

    const pathItem = deliveryFixture();
    admitSession({ projectRoot: pathItem.management, session: "session-path", intent: "read-only", contextReceipt: ".harness/sessions/context.json" });
    expect(admitSession({ projectRoot: pathItem.root, session: "session-path", contextReceipt: pathItem.receipt }))
      .toMatchObject({ reused: false, receiptSequence: 2, intent: "read-only" });

    const item = fixture();
    admitSession({ projectRoot: item.root, session: "session-item", intent: "read-only", contextReceipt: item.receipt, workItem: "local:1" });
    expect(() => admitSession({ projectRoot: item.root, session: "session-item", workItem: "local:2" }))
      .toThrow("SESSION_ADMISSION_RECLASSIFICATION_REQUIRED");
    expect(admitSession({ projectRoot: item.root, session: "session-item", workItem: "local:2", reclassify: true }))
      .toMatchObject({ reused: false, receiptSequence: 2, facts: { workItem: "local:2" } });

    const configured = fixture();
    admitSession({ projectRoot: configured.root, session: "session-config", intent: "read-only", contextReceipt: configured.receipt });
    write(configured.root, ".harness/worktree-delivery.json", { ...deliveryConfig(), leaseTtlHours: 72 });
    expect(admitSession({ projectRoot: configured.root, session: "session-config" }))
      .toMatchObject({ reused: false, receiptSequence: 2, intent: "read-only" });
  });

  it("requires a fresh policy-bound context receipt before policy reclassification", () => {
    const { root, receipt } = fixture();
    admitSession({ projectRoot: root, session: "session-policy", intent: "read-only", contextReceipt: receipt });
    write(root, ".harness/policy.yaml", { ...policy(), revision: 2 });

    expect(() => admitSession({ projectRoot: root, session: "session-policy" }))
      .toThrow("SESSION_ADMISSION_CONTEXT_REQUIRED");
    const currentReceipt = contextReceipt(root, "context-new", "2026-09-03T00:01:00.000Z");
    expect(admitSession({
      projectRoot: root,
      session: "session-policy",
      contextReceipt: currentReceipt,
    })).toMatchObject({ reused: false, receiptSequence: 2 });
  });

  it("revalidates benign lease drift and rejects a stale lease HEAD", () => {
    const item = deliveryFixture();
    admitSession({
      projectRoot: item.root,
      session: "session-lease",
      intent: "continue",
      contextReceipt: item.receipt,
      workItem: item.workItem,
    });
    const commonDir = git(item.root, "rev-parse", "--path-format=absolute", "--git-common-dir");
    const leasePath = join(commonDir, "harness/worktree-delivery/leases", `${sha256(item.workItem)}.json`);
    const lease = JSON.parse(readFileSync(leasePath, "utf8")) as Record<string, unknown>;
    writeFileSync(leasePath, `${JSON.stringify({ ...lease, heartbeatAt: "2026-09-03T01:00:00.000Z" }, null, 2)}\n`, "utf8");

    expect(admitSession({ projectRoot: item.root, session: "session-lease", managedWrite: true }))
      .toMatchObject({ reused: false, receiptSequence: 2, managedWriteAllowed: true });
    writeFileSync(leasePath, `${JSON.stringify({ ...lease, acceptedCommit: "0".repeat(40) }, null, 2)}\n`, "utf8");
    expect(() => admitSession({
      projectRoot: item.root,
      session: "session-stale-head",
      intent: "continue",
      contextReceipt: item.receipt,
      workItem: item.workItem,
    })).toThrow("SESSION_ADMISSION_CONTINUE_MISMATCH");
  });

  it("blocks GitHub continuation until the approved remote coordination contract exists", () => {
    const item = deliveryFixture("github:example/project#42");
    const githubConfig = { ...deliveryConfig(), provider: { kind: "github", repository: "example/project" } };
    write(item.management, ".harness/worktree-delivery.json", githubConfig);
    write(item.root, ".harness/worktree-delivery.json", githubConfig);
    const bin = join(item.management, "test-bin");
    mkdirSync(bin);
    const gh = join(bin, "gh");
    writeFileSync(gh, "#!/bin/sh\nprintf '%s' '{\"state\":\"open\",\"html_url\":\"https://example.test/42\"}'\n", "utf8");
    chmodSync(gh, 0o755);
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;

    const result = admitSession({
      projectRoot: item.root,
      session: "session-github",
      intent: "continue",
      contextReceipt: item.receipt,
      workItem: item.workItem,
    });
    expect(result).toMatchObject({
      decision: "continue",
      managedWriteAllowed: false,
      reasonCodes: ["COORDINATION_BACKEND_REQUIRED"],
    });
    expect(() => admitSession({ projectRoot: item.root, session: "session-github", managedWrite: true }))
      .toThrow("COORDINATION_BACKEND_REQUIRED");
  });

  it("returns prepare-required and blocks managed writes in the management checkout", () => {
    const { root, receipt } = fixture();
    const result = admitSession({ projectRoot: root, session: "session-prepare", intent: "new-code", contextReceipt: receipt });
    expect(result).toMatchObject({ decision: "prepare-required", managedWriteAllowed: false });
    expect(result.facts.managementCheckout).toBe(true);

    expect(() => admitSession({ projectRoot: root, session: "session-prepare", managedWrite: true }))
      .toThrow("SESSION_MANAGEMENT_CHECKOUT_WRITE_FORBIDDEN");
  });

  it("detects a tampered durable admission receipt", () => {
    const { root, receipt } = fixture();
    admitSession({ projectRoot: root, session: "session-tamper", intent: "read-only", contextReceipt: receipt });
    const commonDir = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
    const eventPath = join(commonDir, "harness/receipts/session-admission/session-tamper/events/000000000001.json");
    const event = JSON.parse(readFileSync(eventPath, "utf8")) as Record<string, unknown>;
    writeFileSync(eventPath, `${JSON.stringify({ ...event, sequence: 2 }, null, 2)}\n`, "utf8");

    expect(() => admitSession({ projectRoot: root, session: "session-tamper" })).toThrow("RECEIPT_CHAIN_TAMPERED");
  });

  it("requires the host to pass a session id explicitly through the CLI", () => {
    const { root, receipt } = fixture();
    const missing = spawnSync(process.execPath, ["--import", "tsx", cli, "session", "admit", "--intent", "read-only", "--context-receipt", receipt, "--project", root], {
      cwd: packageRoot,
      encoding: "utf8",
    });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("ARGUMENT_REQUIRED: --session");
  });
});
