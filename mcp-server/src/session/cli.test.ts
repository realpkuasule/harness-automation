import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "../..");
const cli = join(packageRoot, "src/cli.ts");
const projects: string[] = [];
const originalPath = process.env.PATH;
const originalMode = process.env.HARNESS_TEST_GH_MODE;

function write(root: string, relative: string, content: string): void {
  const target = join(root, relative);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, content, "utf8");
}

function git(root: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-session-cli-"));
  projects.push(root);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  write(root, "README.md", "# Fixture\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-q", "-m", "initial"]);
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
      project: { owner: "example", number: 2, statusField: "Status", doneValues: ["Done"] },
    },
  }, null, 2));
  const bin = join(root, "gh-bin");
  mkdirSync(bin, { recursive: true });
  const ghPath = join(bin, "gh");
  writeFileSync(ghPath, `#!/usr/bin/env node
const fs = require("node:fs");
const mode = process.env.HARNESS_TEST_GH_MODE;
const graphql = process.argv.includes("graphql");
if (!graphql) {
  const rest = process.argv.find((v) => v.includes("repos/example/project/issues/"));
  if (process.argv.includes("--method") && process.argv.includes("POST")) {
    process.stdout.write(JSON.stringify({ id: 99 })); process.exit(0);
  }
  if (rest) {
    if (mode === "fail-issue") { process.stderr.write("issue unavailable"); process.exit(1); }
    process.stdout.write(JSON.stringify({
      number: 24, state: "open", title: "实现登录",
      body: "## 验收标准\\n能登录\\n", html_url: "https://github.com/example/project/issues/24"
    }));
    process.exit(0);
  }
  process.exit(1);
}
const query = process.argv.find((v) => v.startsWith("query="))?.slice(6) ?? "";
if (query.includes("fieldValueByName")) {
  process.stdout.write(JSON.stringify({ data: { repository: { issue0: { projectItems: { nodes: [{
    project: { number: 2, owner: { __typename: "User", login: "example" } },
    configuredField: { __typename: "ProjectV2ItemFieldSingleSelectValue", name: "In Progress" }
  }], pageInfo: { hasNextPage: false } } } } } }));
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
process.stderr.write("unknown graphql query"); process.exit(1);`, "utf8");
  chmodSync(ghPath, 0o755);
  return root;
}

function run(root: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const bin = join(root, "gh-bin");
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", cli, ...args, "--project", root],
    {
      cwd: packageRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: join(root, ".test-home"),
        PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      },
      timeout: 30_000,
    },
  );
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function json(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

afterEach(() => {
  for (const project of projects.splice(0)) rmSync(project, { recursive: true, force: true });
  process.env.PATH = originalPath;
  if (originalMode === undefined) delete process.env.HARNESS_TEST_GH_MODE;
  else process.env.HARNESS_TEST_GH_MODE = originalMode;
});

describe("session CLI command group", () => {
  it("renders a seed prompt via `session seed`", () => {
    const root = fixture();
    const result = run(root, ["session", "seed", "--work-item", "github:example/project#24"]);
    expect(result.status).toBe(0);
    const output = json(result.stdout);
    expect(output.ok).toBe(true);
    expect(String(output.seed)).toContain("实现登录");
    expect(String(output.seed)).toContain("docs/HANDOFF-24.md");
  });

  it("dry-run handoff drafts without writing files", () => {
    const root = fixture();
    const result = run(root, ["session", "handoff", "--work-item", "github:example/project#24", "--session", "session-1", "--dry-run"]);
    expect(result.status).toBe(0);
    const output = json(result.stdout);
    expect(output).toMatchObject({ ok: true, phase: "draft", dryRun: true });
    expect(existsSync(join(root, "docs", "HANDOFF-24.md"))).toBe(false);
  });

  it("dry-run handoff previews a ready transition with a stable receipt id", () => {
    const root = fixture();
    write(root, ".git/harness/worktree-delivery/receipts/worktree-123.json",
      JSON.stringify({ id: "worktree-123" }));
    write(root, "docs/HANDOFF-24.md", `# HANDOFF 24 — 实现登录

## 目标与验收标准

实现登录

## 已完成（附 commit / 回执）

- abc1234 提交
回执: worktree-123

## 当前状态（跑通什么、依赖什么、密钥位置）

已跑通

## 已知问题与未决项

无

## 下一步建议（编号列表，供新会话认领）

1. 继续

## 引用文件（路径列表，新会话必须读）

README.md

## SEED（由 CLI 确定性生成，勿手改）

{{seed}}
`);
    const first = run(root, ["session", "handoff", "--work-item", "github:example/project#24", "--session", "session-1", "--dry-run"]);
    const second = run(root, ["session", "handoff", "--work-item", "github:example/project#24", "--session", "session-1", "--dry-run"]);
    expect(first.status).toBe(0);
    const output = json(first.stdout);
    expect(output).toMatchObject({ ok: true, phase: "ready", dryRun: true });
    expect((output.receipt as Record<string, unknown>).id).toMatch(/^handoff-24-[0-9a-f]{12}$/u);
    expect(first.stdout).toBe(second.stdout);
    expect(existsSync(join(root, ".git", "harness", "session-handoff", "receipts"))).toBe(false);
  });

  it("exits non-zero with a JSON error when the handoff doc lacks evidence", () => {
    const root = fixture();
    write(root, ".git/harness/worktree-delivery/receipts/worktree-123.json",
      JSON.stringify({ id: "worktree-123" }));
    write(root, "docs/HANDOFF-24.md", `# HANDOFF 24 — 实现登录

## 目标与验收标准

实现登录

## 已完成（附 commit / 回执）

- abc1234 提交
回执: nope-123

## 当前状态（跑通什么、依赖什么、密钥位置）

已跑通

## 已知问题与未决项

无

## 下一步建议（编号列表，供新会话认领）

1. 继续

## 引用文件（路径列表，新会话必须读）

README.md

## SEED（由 CLI 确定性生成，勿手改）

{{seed}}
`);
    const result = run(root, ["session", "handoff", "--work-item", "github:example/project#24", "--session", "session-1"]);
    expect(result.status).toBe(1);
    const error = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(error.ok).toBe(false);
    expect(String(error.error)).toContain("UNKNOWN_RECEIPT: nope-123");
  });

  it("exits non-zero with a JSON error when the issue is unreachable", () => {
    const root = fixture();
    process.env.HARNESS_TEST_GH_MODE = "fail-issue";
    const result = run(root, ["session", "seed", "--work-item", "github:example/project#24"]);
    expect(result.status).toBe(1);
    const error = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(String(error.error)).toContain("GITHUB_ISSUE_QUERY_FAILED");
  });

  it("reports work item state via `session status`", () => {
    const root = fixture();
    const result = run(root, ["session", "status", "--work-item", "github:example/project#24"]);
    expect(result.status).toBe(0);
    const output = json(result.stdout);
    expect(output.ok).toBe(true);
    expect(output.items).toBeInstanceOf(Array);
    expect((output.items as unknown[]).length).toBe(1);
    expect((output.items as Array<Record<string, unknown>>)[0].issue)
      .toMatchObject({ available: true, state: "OPEN" });
  });

  it("rejects unknown session subcommands", () => {
    const root = fixture();
    const result = run(root, ["session", "nope"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("SESSION_COMMAND_REQUIRED");
  });
});
