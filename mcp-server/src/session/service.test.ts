import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { admitSession } from "./admission.js";
import { prepareDelivery } from "../delivery/prepare.js";
import { hashObject, sha256 } from "../v2/fs.js";
import { sessionHandoff, sessionSeed, sessionStatus } from "./service.js";
import { acquireMutationLock, releaseMutationLock } from "../recovery/service.js";

const directories: string[] = [];
const originalPath = process.env.PATH;
const originalMode = process.env.HARNESS_TEST_GH_MODE;
const originalLog = process.env.HARNESS_TEST_GH_LOG;

function directory(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-session-service-"));
  directories.push(root);
  return root;
}

function write(root: string, relative: string, content: string): void {
  const target = join(root, relative);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, content, "utf8");
}

function git(root: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function initRepo(root: string): void {
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  write(root, "README.md", "# Fixture\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-q", "-m", "initial"]);
}

function providerConfig(root: string, project: boolean): void {
  write(root, ".harness/worktree-delivery.json", JSON.stringify({
    schemaVersion: "1.0",
    mode: "enforced",
    maxPersistentWorktrees: 4,
    leaseTtlHours: 168,
    reviewTtlMinutes: 120,
    remoteBranchRetentionDays: 14,
    remoteBranchDeletion: false,
    provider: {
      kind: "github",
      repository: "example/project",
      ...(project ? {
        project: { owner: "example", number: 2, statusField: "Status", doneValues: ["Done"] },
      } : {}),
    },
  }, null, 2));
}

function installGh(root: string): void {
  const script = `const fs = require("node:fs");
const mode = process.env.HARNESS_TEST_GH_MODE;
const graphql = process.argv.includes("graphql");
const logFile = process.env.HARNESS_TEST_GH_LOG;
const bodyArg = process.argv.find((v) => v.startsWith("body="));
if (logFile) {
  const calls = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, "utf8")) : [];
  calls.push({ graphql, post: process.argv.includes("--method") && process.argv.includes("POST"), body: bodyArg ? bodyArg.slice(5) : null });
  fs.writeFileSync(logFile, JSON.stringify(calls));
}
if (!graphql) {
  const rest = process.argv.find((v) => v.includes("repos/example/project/issues/"));
  if (process.argv.includes("--method") && process.argv.includes("POST")) {
    process.stdout.write(JSON.stringify({ id: 99 }));
    process.exit(0);
  }
  if (rest) {
    if (mode === "fail-issue") { process.stderr.write("issue unavailable"); process.exit(1); }
    process.stdout.write(JSON.stringify({
      number: 24,
      state: "open",
      title: "实现登录",
      body: "## 验收标准\\n能登录\\n## 其他\\n",
      html_url: "https://github.com/example/project/issues/24"
    }));
    process.exit(0);
  }
  process.stderr.write("unknown rest call"); process.exit(1);
}
const query = process.argv.find((v) => v.startsWith("query="))?.slice(6) ?? "";
if (query.includes("fieldValueByName")) {
  const status = mode === "todo-status" ? "Todo" : "In Progress";
  const nodes = mode === "missing-item" ? [] : [{
    project: { number: 2, owner: { __typename: "User", login: "example" } },
    configuredField: { __typename: "ProjectV2ItemFieldSingleSelectValue", name: status }
  }];
  process.stdout.write(JSON.stringify({ data: { repository: { issue0: { projectItems: { nodes, pageInfo: { hasNextPage: false } } } } } }));
  process.exit(0);
}
if (query.includes("fieldValues(first: 20)")) {
  process.stdout.write(JSON.stringify({ data: { repository: { issue: { projectItems: { nodes: [{
    project: { number: 2, owner: { __typename: "User", login: "example" } },
    fieldValues: { nodes: [ { text: "验收标准文本", field: { name: "Acceptance Criteria" } } ] }
  }] } } } } }));
  process.exit(0);
}
if (query.includes("projectV2(number:")) {
  process.stdout.write(JSON.stringify({ data: { repository: {
    issue: { projectItems: { nodes: [
      { id: "PVTI_1", project: { number: 2, owner: { __typename: "User", login: "example" } } }
    ] } },
    projectV2: { id: "PVT_1", fields: { nodes: [
      { __typename: "ProjectV2SingleSelectField", id: "F_STATUS", name: "Status", options: [
        { id: "OPT_IN_PROGRESS", name: "In Progress" },
        { id: "OPT_READY", name: "Ready for Review" }
      ] },
      { __typename: "ProjectV2Field", id: "F_HANDOFF", name: "Handoff Doc" }
    ] } }
  } } }));
  process.exit(0);
}
if (query.includes("updateProjectV2ItemFieldValue")) {
  process.stdout.write(JSON.stringify({ data: { updateProjectV2ItemFieldValue: { clientMutationId: "1" } } }));
  process.exit(0);
}
process.stderr.write("unknown graphql query"); process.exit(1);`;
  const bin = join(root, "gh-bin");
  mkdirSync(bin, { recursive: true });
  const ghPath = join(bin, "gh");
  writeFileSync(ghPath, `#!/usr/bin/env node\n${script}`, "utf8");
  chmodSync(ghPath, 0o755);
  process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
}

function ghLog(root: string): Array<{ graphql: boolean; post: boolean; body: string | null }> {
  return JSON.parse(readFileSync(join(root, "gh-log.json"), "utf8"));
}

function receiptDir(root: string): string {
  return join(root, ".git", "harness", "session-handoff", "receipts");
}

function filledDoc(): string {
  return `# HANDOFF 24 — 实现登录

> Seed prompt 见文末；本文件由 harness CLI 校验，非自由文本。

## 目标与验收标准

实现登录

验收标准文本

## 已完成（附 commit / 回执）

- abc1234 完成登录接口
回执: worktree-123

## 当前状态（跑通什么、依赖什么、密钥位置）

接口已跑通，密钥在 .env

## 已知问题与未决项

无

## 下一步建议（编号列表，供新会话认领）

1. 接入前端

## 引用文件（路径列表，新会话必须读）

README.md

## SEED（由 CLI 确定性生成，勿手改）

{{seed}}
`;
}

function worktreeReceipt(root: string): void {
  write(root, ".git/harness/worktree-delivery/receipts/worktree-123.json",
    JSON.stringify({ id: "worktree-123", kind: "workspace-receipt" }));
}

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
  process.env.PATH = originalPath;
  if (originalMode === undefined) delete process.env.HARNESS_TEST_GH_MODE;
  else process.env.HARNESS_TEST_GH_MODE = originalMode;
  if (originalLog === undefined) delete process.env.HARNESS_TEST_GH_LOG;
  else process.env.HARNESS_TEST_GH_LOG = originalLog;
});

function fixture(project = true): string {
  const root = directory();
  initRepo(root);
  providerConfig(root, project);
  installGh(root);
  process.env.HARNESS_TEST_GH_LOG = join(root, "gh-log.json");
  return root;
}

const HANDOFF_ARGS = {
  projectRoot: "",
  workItem: "github:example/project#24",
  session: "session-1",
};

function readdirOrEmpty(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : [];
}

function runLocalHandoffProcess(projectRoot: string, workItem: string, session: string): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
}> {
  const source = `
    import { sessionHandoff } from ${JSON.stringify(join(process.cwd(), "src/session/service.ts"))};
    try {
      process.stdout.write(JSON.stringify(sessionHandoff(${JSON.stringify({ projectRoot, workItem, session })})));
    } catch (error) {
      process.stderr.write(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  `;
  return new Promise((resolveProcess) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--eval", source], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("close", (status) => resolveProcess({ status, stdout, stderr }));
  });
}

async function localFixture(): Promise<{
  root: string;
  target: string;
  receiptEventHash: string;
  transactionId: string;
  branch: string;
  workItem: string;
}> {
  const root = directory();
  const target = `${root}-delivery`;
  directories.push(target);
  initRepo(root);
  const branch = git(root, ["symbolic-ref", "--short", "HEAD"]);
  write(root, ".harness/policy.yaml", JSON.stringify({
    schemaVersion: "2.0",
    project: { owner: "local-owner" },
    policies: [],
  }, null, 2));
  write(root, ".harness/worktree-delivery.json", JSON.stringify({
    schemaVersion: "1.0",
    mode: "enforced",
    managementBranch: branch,
    maxPersistentWorktrees: 4,
    leaseTtlHours: 168,
    reviewTtlMinutes: 120,
    remoteBranchRetentionDays: 1,
    remoteBranchDeletion: true,
    provider: { kind: "none" },
  }, null, 2));
  const policy = JSON.parse(readFileSync(join(root, ".harness/policy.yaml"), "utf8")) as unknown;
  write(root, ".harness/sessions/context.json", JSON.stringify({
    schemaVersion: "2.0",
    startedAt: "2026-09-03T12:00:00.000Z",
    policyDigest: hashObject(policy),
    owner: "local-owner",
    agent: "codex",
  }, null, 2));
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "configure local delivery"]);
  const commonDir = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  write(commonDir, "harness/worktree-delivery/host-binding.json", JSON.stringify({
    schemaVersion: "1.0",
    allowedRoots: [tmpdir()],
    protectedRoots: [root, commonDir, "/"],
    approval: { mode: "manual" },
  }, null, 2));
  const now = new Date("2026-09-03T12:00:00.000Z");
  admitSession({ projectRoot: root, session: "local-prepare", intent: "new-code", contextReceipt: ".harness/sessions/context.json", now });
  const prepared = await prepareDelivery({
    projectRoot: root,
    session: "local-prepare",
    confirmation: "prepare local task and workspace",
    baseRef: `refs/heads/${branch}`,
    baseSha: git(root, ["rev-parse", "HEAD"]),
    localOnly: true,
    title: "Local export",
    description: "Export without a remote provider.",
    owner: "local-owner",
    path: target,
    now,
  });
  return {
    root,
    target,
    receiptEventHash: prepared.receiptEventHash,
    transactionId: prepared.transactionId,
    branch: prepared.branch!,
    workItem: prepared.workItem,
  };
}

function filledLocalDoc(receipt: string): string {
  return `# HANDOFF local:P0-1 — Local export

## 目标与验收标准

Local export

## 已完成（附 commit / 回执）

回执: ${receipt}

## 当前状态（跑通什么、依赖什么、密钥位置）

Prepared local workspace

## 已知问题与未决项

无

## 下一步建议（编号列表，供新会话认领）

1. Continue

## 引用文件（路径列表，新会话必须读）

README.md

## SEED（由 CLI 确定性生成，勿手改）

conflicting chat summary
`;
}

describe("session seed", () => {
  it("renders a deterministic seed prompt without writing anything", () => {
    const root = fixture();
    const first = sessionSeed({ ...HANDOFF_ARGS, projectRoot: root });
    const second = sessionSeed({ ...HANDOFF_ARGS, projectRoot: root });
    expect(first.ok).toBe(true);
    expect(first.seed).toBe(second.seed);
    expect(first.seed).toContain("实现登录");
    expect(first.seed).toContain("验收标准文本");
    expect(first.seed).toContain("docs/HANDOFF-24.md");
    expect(first.seed).not.toContain("{{");
    expect(existsSync(join(root, "docs", "HANDOFF-24.md"))).toBe(false);
  });

  it("falls back to the issue body acceptance section without a project mapping", () => {
    const root = directory();
    initRepo(root);
    providerConfig(root, false);
    installGh(root);
    const seed = sessionSeed({ ...HANDOFF_ARGS, projectRoot: root });
    expect(seed.seed).toContain("能登录");
  });
});

describe("session handoff", () => {
  it("creates a template draft when the handoff doc is missing and performs no issue writes", () => {
    const root = fixture();
    const result = sessionHandoff({ ...HANDOFF_ARGS, projectRoot: root });
    expect(result.phase).toBe("draft");
    const doc = readFileSync(join(root, "docs", "HANDOFF-24.md"), "utf8");
    for (const heading of [
      "## 目标与验收标准",
      "## 已完成（附 commit / 回执）",
      "## 当前状态（跑通什么、依赖什么、密钥位置）",
      "## 已知问题与未决项",
      "## 下一步建议（编号列表，供新会话认领）",
      "## 引用文件（路径列表，新会话必须读）",
      "## SEED（由 CLI 确定性生成，勿手改）",
    ]) expect(doc).toContain(heading);
    expect(doc).toContain("实现登录");
    expect(doc).not.toContain("{{seed}}");
    expect(doc).toContain("【第一步】");
    const log = ghLog(root);
    expect(log.some((call) => call.post)).toBe(false);
    expect(readdirOrEmpty(receiptDir(root))).toHaveLength(0);
  });

  it("validates, writes a receipt, posts receipts comment, and keeps development in progress", () => {
    const root = fixture();
    worktreeReceipt(root);
    write(root, "docs/HANDOFF-24.md", filledDoc());
    const result = sessionHandoff({ ...HANDOFF_ARGS, projectRoot: root });
    expect(result.phase).toBe("ready");
    expect(result.dryRun).toBe(false);
    const doc = readFileSync(join(root, "docs", "HANDOFF-24.md"), "utf8");
    expect(doc).not.toContain("{{seed}}");
    const id = result.receipt?.id;
    expect(id).toMatch(/^handoff-24-[0-9a-f]{12}$/u);
    const receiptPath = join(receiptDir(root), `${id}.json`);
    expect(existsSync(receiptPath)).toBe(true);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    expect(receipt).toMatchObject({
      schemaVersion: "session-handoff/1.0",
      kind: "session-handoff-receipt",
      workItem: "github:example/project#24",
      session: "session-1",
      handoffDocPath: "docs/HANDOFF-24.md",
      handoffDocHash: sha256(doc),
      receiptIds: ["worktree-123"],
      fromStatus: "in-progress",
      toStatus: "in-progress",
    });
    expect(receipt.commit).toMatch(/^[0-9a-f]{40}$/u);
    const log = ghLog(root);
    expect(log.some((call) => call.post && call.body === JSON.stringify([id, "worktree-123"]))).toBe(true);
    expect(log.filter((call) => call.graphql).length).toBeGreaterThanOrEqual(3);
  });

  it("moves to ready-for-review only when delivery review is explicit", () => {
    const root = fixture();
    worktreeReceipt(root);
    write(root, "docs/HANDOFF-24.md", filledDoc());
    const result = sessionHandoff({ ...HANDOFF_ARGS, projectRoot: root, toStatus: "ready-for-review" });
    expect(result.receipt?.toStatus).toBe("ready-for-review");
    expect(ghLog(root).filter((call) => call.graphql).length).toBeGreaterThanOrEqual(4);
  });

  it("is idempotent for an unchanged document", () => {
    const root = fixture();
    worktreeReceipt(root);
    write(root, "docs/HANDOFF-24.md", filledDoc());
    const first = sessionHandoff({ ...HANDOFF_ARGS, projectRoot: root });
    const second = sessionHandoff({ ...HANDOFF_ARGS, projectRoot: root });
    expect(second.receipt?.id).toBe(first.receipt?.id);
    expect(second.receipt?.handoffDocHash).toBe(first.receipt?.handoffDocHash);
    expect(readdirOrEmpty(receiptDir(root))).toHaveLength(1);
  });

  it("refuses when the issue is unreachable", () => {
    const root = fixture();
    write(root, "docs/HANDOFF-24.md", filledDoc());
    process.env.HARNESS_TEST_GH_MODE = "fail-issue";
    expect(() => sessionHandoff({ ...HANDOFF_ARGS, projectRoot: root }))
      .toThrow(/GITHUB_ISSUE_QUERY_FAILED/);
    expect(readdirOrEmpty(receiptDir(root))).toHaveLength(0);
    expect(ghLog(root).some((call) => call.post)).toBe(false);
  });

  it("refuses a doc with a missing section", () => {
    const root = fixture();
    worktreeReceipt(root);
    const doc = filledDoc().replace("## 引用文件（路径列表，新会话必须读）", "## 别的节");
    write(root, "docs/HANDOFF-24.md", doc);
    expect(() => sessionHandoff({ ...HANDOFF_ARGS, projectRoot: root }))
      .toThrow(/SESSION_HANDOFF_DOC_INVALID: .*MISSING_SECTION/);
    expect(readdirOrEmpty(receiptDir(root))).toHaveLength(0);
    expect(ghLog(root).some((call) => call.post)).toBe(false);
  });

  it("refuses a doc with unfilled placeholders outside the SEED section", () => {
    const root = fixture();
    worktreeReceipt(root);
    const doc = filledDoc().replace("接口已跑通，密钥在 .env", "{{currentState}}");
    write(root, "docs/HANDOFF-24.md", doc);
    expect(() => sessionHandoff({ ...HANDOFF_ARGS, projectRoot: root }))
      .toThrow(/SESSION_HANDOFF_DOC_INVALID/);
  });

  it("refuses a doc referencing an unknown receipt id (no evidence, no transition)", () => {
    const root = fixture();
    worktreeReceipt(root);
    const doc = filledDoc().replace("回执: worktree-123", "回执: nope-123");
    write(root, "docs/HANDOFF-24.md", doc);
    expect(() => sessionHandoff({ ...HANDOFF_ARGS, projectRoot: root }))
      .toThrow(/SESSION_HANDOFF_DOC_INVALID: .*UNKNOWN_RECEIPT: nope-123/);
    expect(readdirOrEmpty(receiptDir(root))).toHaveLength(0);
    expect(ghLog(root).some((call) => call.post)).toBe(false);
  });

  it("refuses a doc whose referenced files do not exist", () => {
    const root = fixture();
    worktreeReceipt(root);
    const doc = filledDoc().replace("README.md", "src/missing.ts");
    write(root, "docs/HANDOFF-24.md", doc);
    expect(() => sessionHandoff({ ...HANDOFF_ARGS, projectRoot: root }))
      .toThrow(/MISSING_REFERENCE_FILE: src\/missing\.ts/);
  });

  it("refuses the transition when the issue status is not in-progress", () => {
    const root = fixture();
    worktreeReceipt(root);
    write(root, "docs/HANDOFF-24.md", filledDoc());
    process.env.HARNESS_TEST_GH_MODE = "todo-status";
    expect(() => sessionHandoff({ ...HANDOFF_ARGS, projectRoot: root }))
      .toThrow(/SESSION_TRANSITION_REFUSED: expected status in-progress, found Todo/);
    expect(readdirOrEmpty(receiptDir(root))).toHaveLength(0);
    expect(ghLog(root).some((call) => call.post)).toBe(false);
  });

  it("refuses the transition when the issue is not on the configured project", () => {
    const root = fixture();
    worktreeReceipt(root);
    write(root, "docs/HANDOFF-24.md", filledDoc());
    process.env.HARNESS_TEST_GH_MODE = "missing-item";
    expect(() => sessionHandoff({ ...HANDOFF_ARGS, projectRoot: root }))
      .toThrow(/SESSION_TRANSITION_REFUSED/);
  });

  it("refuses when no provider project mapping is configured", () => {
    const root = directory();
    initRepo(root);
    providerConfig(root, false);
    installGh(root);
    expect(() => sessionHandoff({ ...HANDOFF_ARGS, projectRoot: root }))
      .toThrow(/SESSION_PROJECT_CONFIG_REQUIRED/);
  });

  it("refuses unsupported to-status values", () => {
    const root = fixture();
    expect(() => sessionHandoff({ ...HANDOFF_ARGS, projectRoot: root, toStatus: "done" }))
      .toThrow(/SESSION_TO_STATUS_UNSUPPORTED/);
  });

  it("requires a git repository", () => {
    const root = directory();
    providerConfig(root, true);
    installGh(root);
    expect(() => sessionHandoff({ ...HANDOFF_ARGS, projectRoot: root }))
      .toThrow(/GIT_REPOSITORY_REQUIRED/);
  });

  it("dry-run previews the handoff without writing anything", () => {
    const root = fixture();
    worktreeReceipt(root);
    const path = join(root, "docs", "HANDOFF-24.md");
    write(root, "docs/HANDOFF-24.md", filledDoc());
    const before = readFileSync(path, "utf8");
    const first = sessionHandoff({ ...HANDOFF_ARGS, projectRoot: root, dryRun: true });
    const second = sessionHandoff({ ...HANDOFF_ARGS, projectRoot: root, dryRun: true });
    expect(first.phase).toBe("ready");
    expect(first.dryRun).toBe(true);
    expect(first.receipt?.id).toBe(second.receipt?.id);
    expect(first.receipt?.fromStatus).toBe("in-progress");
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(readdirOrEmpty(receiptDir(root))).toHaveLength(0);
    expect(ghLog(root).some((call) => call.post)).toBe(false);
  });

  it("dry-run drafts without creating the doc", () => {
    const root = fixture();
    const result = sessionHandoff({ ...HANDOFF_ARGS, projectRoot: root, dryRun: true });
    expect(result.phase).toBe("draft");
    expect(existsSync(join(root, "docs", "HANDOFF-24.md"))).toBe(false);
  });
});

describe("session status", () => {
  it("reports issue, doc validation and receipts for a work item", () => {
    const root = fixture();
    worktreeReceipt(root);
    write(root, "docs/HANDOFF-24.md", filledDoc());
    sessionHandoff({ ...HANDOFF_ARGS, projectRoot: root });
    const status = sessionStatus({ projectRoot: root, workItem: "github:example/project#24" });
    expect(status.ok).toBe(true);
    expect(status.workflow.source).toBe("package-default");
    expect(status.items).toHaveLength(1);
    const item = status.items[0] as Record<string, unknown>;
    expect(item.workItem).toBe("github:example/project#24");
    expect(item.issue).toMatchObject({ available: true, state: "OPEN", projectStatus: "In Progress" });
    expect(item.handoffDoc).toMatchObject({ exists: true, valid: true });
    expect(item.lastReceipt).toMatchObject({
      id: expect.stringMatching(/^handoff-24-/u),
      handoffDocHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
  });

  it("scans docs/HANDOFF-*.md when no work item is given", () => {
    const root = fixture();
    write(root, "docs/HANDOFF-24.md", filledDoc());
    write(root, "docs/HANDOFF-42.md", "partial");
    const status = sessionStatus({ projectRoot: root });
    expect(status.items.map((item) => (item as Record<string, unknown>).workItem).sort())
      .toEqual(["github:example/project#24", "github:example/project#42"]);
  });

  it("reports unreachable issues inline without failing", () => {
    const root = fixture();
    process.env.HARNESS_TEST_GH_MODE = "fail-issue";
    const status = sessionStatus({ projectRoot: root, workItem: "github:example/project#24" });
    expect(status.ok).toBe(true);
    expect((status.items[0] as Record<string, unknown>).issue)
      .toMatchObject({ available: false, error: expect.stringContaining("GITHUB_ISSUE_QUERY_FAILED") });
  });

  it("restores Local-only status, seed, and handoff from TASK, lease, Prepare receipt, and LKG", async () => {
    const local = await localFixture();
    const status = sessionStatus({ projectRoot: local.target, workItem: local.workItem });
    expect(status.items[0]).toMatchObject({
      workItem: local.workItem,
      task: { available: true, title: "Local export" },
      workspace: { branch: local.branch, path: realpathSync.native(local.target) },
      prepare: { outcome: "PreparedNotOpened", receiptEventHash: local.receiptEventHash },
    });
    const seed = sessionSeed({ projectRoot: local.target, workItem: local.workItem }).seed;
    expect(seed).toContain("Local export");
    expect(seed).toContain(local.branch);
    expect(seed).toContain(local.receiptEventHash);

    const draft = sessionHandoff({ projectRoot: local.target, workItem: local.workItem, session: "local-next" });
    expect(draft.phase).toBe("draft");
    expect(draft).not.toHaveProperty("issueUpdates");
    write(local.target, "docs/HANDOFF-local-P0-1.md", filledLocalDoc("not-a-real-receipt"));
    expect(() => sessionHandoff({ projectRoot: local.target, workItem: local.workItem, session: "local-next" }))
      .toThrow(/UNKNOWN_RECEIPT/);

    write(local.target, "docs/HANDOFF-local-P0-1.md", filledLocalDoc(local.receiptEventHash));
    const ready = sessionHandoff({ projectRoot: local.target, workItem: local.workItem, session: "local-next" });
    expect(ready).toMatchObject({
      phase: "ready",
      dryRun: false,
      receipt: { fromStatus: "pending", toStatus: "in-progress" },
    });
    expect(ready).not.toHaveProperty("issueUpdates");
    expect(readFileSync(join(local.target, "docs/HANDOFF-local-P0-1.md"), "utf8")).not.toContain("conflicting chat summary");
    const commonDir = git(local.root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const board = JSON.parse(readFileSync(join(commonDir, "harness/local-tracking/TASK.json"), "utf8")) as {
      tasks: Array<{ id: string; status: string }>;
    };
    expect(board.tasks.find((task) => task.id === "P0-1")?.status).toBe("in_progress");
  });

  it("restores Local-only facts from the immutable Prepare receipt when its projection is absent", async () => {
    const local = await localFixture();
    const commonDir = git(local.root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    rmSync(join(commonDir, "harness/delivery-prepare/journals", `${local.transactionId}.json`));

    const status = sessionStatus({ projectRoot: local.target, workItem: local.workItem });
    expect(status.items[0]).toMatchObject({
      workItem: local.workItem,
      prepare: { transactionId: local.transactionId, receiptEventHash: local.receiptEventHash },
    });
    expect(sessionSeed({ projectRoot: local.target, workItem: local.workItem }).seed)
      .toContain(local.receiptEventHash);
  });

  it("does not write a Local-only handoff receipt when task status CAS loses", async () => {
    const local = await localFixture();
    sessionHandoff({ projectRoot: local.target, workItem: local.workItem, session: "local-cas" });
    write(local.target, "docs/HANDOFF-local-P0-1.md", filledLocalDoc(local.receiptEventHash));
    const commonDir = git(local.root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const boardPath = join(commonDir, "harness/local-tracking/TASK.json");
    const docPath = join(local.target, "docs/HANDOFF-local-P0-1.md");
    const docBefore = readFileSync(docPath, "utf8");

    expect(() => sessionHandoff({
      projectRoot: local.target,
      workItem: local.workItem,
      session: "local-cas",
      testBeforeLocalStatusCas: () => {
        const board = JSON.parse(readFileSync(boardPath, "utf8")) as {
          meta: { updated: string };
          tasks: Array<{ id: string; status: string }>;
        };
        board.tasks.find((task) => task.id === "P0-1")!.status = "completed";
        writeFileSync(boardPath, `${JSON.stringify(board, null, 2)}\n`, "utf8");
      },
    })).toThrow("LOCAL_TRACKING_STATUS_CAS_FAILED");
    expect(readFileSync(docPath, "utf8")).toBe(docBefore);
    expect(readdirOrEmpty(join(commonDir, "harness/session-handoff/receipts"))).toHaveLength(0);
  });

  it("rejects a completed Local-only task before changing TASK, document, or receipts", async () => {
    const local = await localFixture();
    sessionHandoff({ projectRoot: local.target, workItem: local.workItem, session: "local-completed" });
    write(local.target, "docs/HANDOFF-local-P0-1.md", filledLocalDoc(local.receiptEventHash));
    const commonDir = git(local.root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const boardPath = join(commonDir, "harness/local-tracking/TASK.json");
    const docPath = join(local.target, "docs/HANDOFF-local-P0-1.md");
    const board = JSON.parse(readFileSync(boardPath, "utf8")) as {
      tasks: Array<{ id: string; status: string }>;
    };
    board.tasks.find((task) => task.id === "P0-1")!.status = "completed";
    writeFileSync(boardPath, `${JSON.stringify(board, null, 2)}\n`, "utf8");
    const before = {
      board: readFileSync(boardPath, "utf8"),
      doc: readFileSync(docPath, "utf8"),
      receipts: readdirOrEmpty(join(commonDir, "harness/session-handoff/receipts")),
    };

    expect(() => sessionHandoff({
      projectRoot: local.target,
      workItem: local.workItem,
      session: "local-completed",
    })).toThrow("SESSION_LOCAL_TASK_STATUS_INVALID");
    expect(readFileSync(boardPath, "utf8")).toBe(before.board);
    expect(readFileSync(docPath, "utf8")).toBe(before.doc);
    expect(readdirOrEmpty(join(commonDir, "harness/session-handoff/receipts"))).toEqual(before.receipts);
  });

  it("returns the authoritative receipt for an identical Local-only handoff retry", async () => {
    const local = await localFixture();
    sessionHandoff({ projectRoot: local.target, workItem: local.workItem, session: "local-retry" });
    write(local.target, "docs/HANDOFF-local-P0-1.md", filledLocalDoc(local.receiptEventHash));
    const first = sessionHandoff({ projectRoot: local.target, workItem: local.workItem, session: "local-retry" });
    const commonDir = git(local.root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const receiptPath = join(commonDir, "harness/session-handoff/receipts", `${first.receipt!.id}.json`);
    const boardPath = join(commonDir, "harness/local-tracking/TASK.json");
    const stored = JSON.parse(readFileSync(receiptPath, "utf8")) as {
      id: string;
      handoffDocHash: string;
      commit: string;
      fromStatus: string;
      toStatus: string;
    };
    const boardBefore = readFileSync(boardPath, "utf8");

    const retried = sessionHandoff({ projectRoot: local.target, workItem: local.workItem, session: "local-retry" });
    expect(retried.receipt).toEqual({
      id: stored.id,
      handoffDocHash: stored.handoffDocHash,
      commit: stored.commit,
      fromStatus: stored.fromStatus,
      toStatus: stored.toStatus,
    });
    expect(readFileSync(boardPath, "utf8")).toBe(boardBefore);
  });

  it("does not rewrite an already in-progress Local-only task when committing its first handoff", async () => {
    const local = await localFixture();
    sessionHandoff({ projectRoot: local.target, workItem: local.workItem, session: "local-in-progress" });
    write(local.target, "docs/HANDOFF-local-P0-1.md", filledLocalDoc(local.receiptEventHash));
    const commonDir = git(local.root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const boardPath = join(commonDir, "harness/local-tracking/TASK.json");
    const board = JSON.parse(readFileSync(boardPath, "utf8")) as {
      tasks: Array<{ id: string; status: string; updatedBy: string }>;
    };
    const task = board.tasks.find((candidate) => candidate.id === "P0-1")!;
    task.status = "in_progress";
    task.updatedBy = "local-in-progress";
    writeFileSync(boardPath, `${JSON.stringify(board, null, 2)}\n`, "utf8");
    const boardBefore = readFileSync(boardPath, "utf8");

    const result = sessionHandoff({
      projectRoot: local.target,
      workItem: local.workItem,
      session: "local-in-progress",
    });
    expect(result.receipt?.fromStatus).toBe("in-progress");
    expect(readFileSync(boardPath, "utf8")).toBe(boardBefore);
  });

  it("serializes identical Local-only handoffs across independent processes", async () => {
    const local = await localFixture();
    sessionHandoff({ projectRoot: local.target, workItem: local.workItem, session: "local-concurrent" });
    write(local.target, "docs/HANDOFF-local-P0-1.md", filledLocalDoc(local.receiptEventHash));
    const commonDir = git(local.root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const lock = acquireMutationLock({ projectDir: commonDir, commonDir, repository: true });
    const first = runLocalHandoffProcess(local.target, local.workItem, "local-concurrent");
    const second = runLocalHandoffProcess(local.target, local.workItem, "local-concurrent");
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 200));
    releaseMutationLock(lock);
    const results = await Promise.all([first, second]);

    expect(results.map((result) => result.status)).toEqual([0, 0]);
    const receipts = results.map((result) => JSON.parse(result.stdout) as {
      receipt: { id: string };
    });
    expect(receipts[0].receipt.id).toBe(receipts[1].receipt.id);
    const board = JSON.parse(readFileSync(join(commonDir, "harness/local-tracking/TASK.json"), "utf8")) as {
      tasks: Array<{ id: string; status: string; updatedBy: string }>;
    };
    const task = board.tasks.find((candidate) => candidate.id === "P0-1")!;
    const stored = JSON.parse(readFileSync(join(
      commonDir,
      "harness/session-handoff/receipts",
      `${receipts[0].receipt.id}.json`,
    ), "utf8")) as { session: string };
    expect(task).toMatchObject({ status: "in_progress", updatedBy: "local-concurrent" });
    expect(stored.session).toBe(task.updatedBy);
  });

  it("recovers a Local-only handoff after TASK CAS succeeds but document commit fails", async () => {
    const local = await localFixture();
    sessionHandoff({ projectRoot: local.target, workItem: local.workItem, session: "local-recover" });
    write(local.target, "docs/HANDOFF-local-P0-1.md", filledLocalDoc(local.receiptEventHash));
    const commonDir = git(local.root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const boardPath = join(commonDir, "harness/local-tracking/TASK.json");
    const docPath = join(local.target, "docs/HANDOFF-local-P0-1.md");
    const docsDirectory = join(local.target, "docs");
    const docBefore = readFileSync(docPath, "utf8");

    let failure: unknown;
    try {
      sessionHandoff({
        projectRoot: local.target,
        workItem: local.workItem,
        session: "local-recover",
        testBeforeLocalStatusCas: () => chmodSync(docsDirectory, 0o555),
      });
    } catch (error) {
      failure = error;
    } finally {
      chmodSync(docsDirectory, 0o755);
    }
    expect(failure).toBeInstanceOf(Error);
    const boardAfterCrash = readFileSync(boardPath, "utf8");
    expect(JSON.parse(boardAfterCrash)).toMatchObject({
      tasks: [expect.objectContaining({ id: "P0-1", status: "in_progress", updatedBy: "local-recover" })],
    });
    expect(readFileSync(docPath, "utf8")).toBe(docBefore);
    expect(readdirOrEmpty(join(commonDir, "harness/session-handoff/receipts"))).toHaveLength(0);
    expect(readdirOrEmpty(join(commonDir, "harness/session-handoff/transactions"))).toHaveLength(1);

    const recovered = sessionHandoff({
      projectRoot: local.target,
      workItem: local.workItem,
      session: "local-recover",
    });
    expect(recovered.receipt?.id).toMatch(/^handoff-local-P0-1-/u);
    expect(readFileSync(boardPath, "utf8")).toBe(boardAfterCrash);
    expect(readdirOrEmpty(join(commonDir, "harness/session-handoff/receipts"))).toHaveLength(1);
  });

  it("rejects a same-document Local-only receipt owned by another session without writes", async () => {
    const local = await localFixture();
    sessionHandoff({ projectRoot: local.target, workItem: local.workItem, session: "local-owner" });
    write(local.target, "docs/HANDOFF-local-P0-1.md", filledLocalDoc(local.receiptEventHash));
    const first = sessionHandoff({ projectRoot: local.target, workItem: local.workItem, session: "local-owner" });
    const commonDir = git(local.root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const boardPath = join(commonDir, "harness/local-tracking/TASK.json");
    const docPath = join(local.target, "docs/HANDOFF-local-P0-1.md");
    const receiptPath = join(commonDir, "harness/session-handoff/receipts", `${first.receipt!.id}.json`);
    const before = {
      board: readFileSync(boardPath, "utf8"),
      doc: readFileSync(docPath, "utf8"),
      receipt: readFileSync(receiptPath, "utf8"),
    };

    expect(() => sessionHandoff({
      projectRoot: local.target,
      workItem: local.workItem,
      session: "local-other",
    })).toThrow("SESSION_LOCAL_HANDOFF_RECEIPT_CONFLICT");
    expect(readFileSync(boardPath, "utf8")).toBe(before.board);
    expect(readFileSync(docPath, "utf8")).toBe(before.doc);
    expect(readFileSync(receiptPath, "utf8")).toBe(before.receipt);
  });

  it("rejects a same-document Local-only receipt with a different commit without writes", async () => {
    const local = await localFixture();
    sessionHandoff({ projectRoot: local.target, workItem: local.workItem, session: "local-commit" });
    write(local.target, "docs/HANDOFF-local-P0-1.md", filledLocalDoc(local.receiptEventHash));
    const first = sessionHandoff({ projectRoot: local.target, workItem: local.workItem, session: "local-commit" });
    const commonDir = git(local.root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const boardPath = join(commonDir, "harness/local-tracking/TASK.json");
    const docPath = join(local.target, "docs/HANDOFF-local-P0-1.md");
    const receiptPath = join(commonDir, "harness/session-handoff/receipts", `${first.receipt!.id}.json`);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as { commit: string };
    receipt.commit = "0".repeat(40);
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    const before = {
      board: readFileSync(boardPath, "utf8"),
      doc: readFileSync(docPath, "utf8"),
      receipt: readFileSync(receiptPath, "utf8"),
    };

    expect(() => sessionHandoff({
      projectRoot: local.target,
      workItem: local.workItem,
      session: "local-commit",
    })).toThrow("SESSION_LOCAL_HANDOFF_RECEIPT_CONFLICT");
    expect(readFileSync(boardPath, "utf8")).toBe(before.board);
    expect(readFileSync(docPath, "utf8")).toBe(before.doc);
    expect(readFileSync(receiptPath, "utf8")).toBe(before.receipt);
  });

  it("rejects Local-only ready-for-review when the TASK status model has no mapping", async () => {
    const local = await localFixture();
    sessionHandoff({ projectRoot: local.target, workItem: local.workItem, session: "local-review" });
    write(local.target, "docs/HANDOFF-local-P0-1.md", filledLocalDoc(local.receiptEventHash));
    expect(() => sessionHandoff({
      projectRoot: local.target,
      workItem: local.workItem,
      session: "local-review",
      toStatus: "ready-for-review",
    })).toThrow("SESSION_LOCAL_STATUS_UNSUPPORTED");
  });
});
