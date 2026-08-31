import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  authorizeDelivery,
  canRetryCi,
  classifyCiFailure,
  deliveryStatus,
} from "./service.js";

const roots: string[] = [];

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Harness Test",
      GIT_AUTHOR_EMAIL: "harness@example.test",
      GIT_COMMITTER_NAME: "Harness Test",
      GIT_COMMITTER_EMAIL: "harness@example.test",
    },
  }).trim();
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-delivery-"));
  roots.push(root);
  git(root, "init", "-b", "main");
  writeFileSync(join(root, "README.md"), "fixture\n", "utf8");
  git(root, "add", "README.md");
  git(root, "commit", "-m", "test: initialize");
  git(root, "remote", "add", "origin", "git@github.com:example/project.git");
  git(root, "switch", "-c", "codex/issue-24-delivery");
  return root;
}

function authorization(root: string) {
  return authorizeDelivery({
    projectRoot: root,
    workItem: "github:example/project#24",
    baseBranch: "main",
    allowedPaths: ["mcp-server/src/", "skill/", "docs/", "CHANGELOG.jsonl"],
    intent: "Implement and deliver Issue #24 through checks-green merge and exact cleanup.",
    approvalSource: "codex://threads/accepted-issue-24",
    capabilities: { mergeMode: "checks-green" },
    now: new Date("2026-08-31T00:00:00.000Z"),
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("delivery authorization", () => {
  it("persists one immutable authorization in the existing receipt library and recovers it", () => {
    const root = fixture();
    const result = authorization(root);

    expect(result.path).toContain("harness/worktree-delivery/receipts/delivery-authorization-");
    expect(existsSync(result.path)).toBe(true);
    expect(deliveryStatus(root, result.authorization.authorizationHash)).toMatchObject({
      currentHead: result.authorization.initialHead,
      phase: "executing",
      invalidation: undefined,
    });
  });

  it("accepts an authorized in-scope commit and fails closed on scope drift", () => {
    const root = fixture();
    const result = authorization(root);
    const target = join(root, "mcp-server", "src");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "change.ts"), "export const value = 1;\n", "utf8");
    git(root, "add", "mcp-server/src/change.ts");
    git(root, "commit", "-m", "feat: authorized delivery change");
    expect(deliveryStatus(root, result.authorization.authorizationHash).invalidation).toBeUndefined();

    writeFileSync(join(root, "outside.txt"), "not authorized\n", "utf8");
    git(root, "add", "outside.txt");
    git(root, "commit", "-m", "test: outside scope");
    expect(deliveryStatus(root, result.authorization.authorizationHash).invalidation)
      .toContain("DELIVERY_SCOPE_DRIFT: outside.txt");
  });

  it("invalidates on provider endpoint drift", () => {
    const root = fixture();
    const result = authorization(root);
    git(root, "remote", "set-url", "origin", "git@github.com:example/other.git");

    expect(deliveryStatus(root, result.authorization.authorizationHash).invalidation)
      .toBe("DELIVERY_REMOTE_ENDPOINT_DRIFT");
  });
});

describe("CI retry classification", () => {
  it("retries only a same-head transient infrastructure failure within its fixed budget", () => {
    const root = fixture();
    const result = authorization(root).authorization;
    const currentHead = git(root, "rev-parse", "HEAD");

    expect(classifyCiFailure("fatal: unable to access github.com: Failed to connect to github.com port 443", "checkout"))
      .toMatchObject({ kind: "infrastructure" });
    expect(canRetryCi({
      authorization: result,
      currentHead,
      runHead: currentHead,
      runId: "123",
      workflow: "CI",
      job: "windows",
      requiredCheck: "build-and-test (windows-x64)",
      step: "checkout",
      attempt: 1,
      failedLog: "fatal: unable to access github.com: Failed to connect to github.com port 443",
    }).retry).toBe(true);
    expect(canRetryCi({
      authorization: result,
      currentHead,
      runHead: currentHead,
      runId: "123",
      workflow: "CI",
      job: "windows",
      requiredCheck: "build-and-test (windows-x64)",
      step: "checkout",
      attempt: 3,
      failedLog: "fatal: unable to access github.com: Failed to connect to github.com port 443",
    }).reason).toBe("DELIVERY_CI_RETRY_EXHAUSTED");
  });

  it("never recasts quality, Windows permission, or toolchain errors as infrastructure", () => {
    for (const log of [
      "Coverage 79.64% < global threshold 80%",
      "EPERM: operation not permitted, symlink C:\\actions-runners",
      "GOCACHE is not writable",
      "[vitest-worker]: Timeout calling onTaskUpdate",
    ]) expect(classifyCiFailure(log, "checkout").kind).toBe("deterministic");
  });
});
