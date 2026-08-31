import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  authorizeDelivery,
  canRetryCi,
  classifyCiFailure,
  deliveryStatus,
  latestDeliveryAuthorization,
  loadDeliveryAuthorization,
  mergeDelivery,
  pushDelivery,
  upsertDeliveryPullRequest,
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

function fakeCommands(root: string): () => void {
  const bin = mkdtempSync(join(tmpdir(), "harness-delivery-bin-"));
  roots.push(bin);
  writeFileSync(join(bin, "git"), `#!/bin/sh
if [ "$1" = "ls-remote" ]; then
  if [ -f "$HARNESS_FAKE_REMOTE" ]; then
    printf '%s\\t%s\\n' "$(cat "$HARNESS_FAKE_REMOTE")" "$4"
  fi
  exit 0
fi
if [ "$1" = "push" ]; then
  /usr/bin/git rev-parse HEAD > "$HARNESS_FAKE_REMOTE"
  exit 0
fi
exec /usr/bin/git "$@"
`, "utf8");
  writeFileSync(join(bin, "gh"), `#!/bin/sh
case "$*" in
  *"pulls?"*)
    if [ "$HARNESS_FAKE_NO_PULL" = 1 ]; then printf '[]'; else printf '[{"number":24}]'; fi
    ;;
  *"pulls/24/merge"*) touch "$HARNESS_FAKE_MERGED"; printf '{"merged":true}' ;;
  *"pulls/24"*)
    state=open; merged=false
    if [ -f "$HARNESS_FAKE_MERGED" ]; then state=closed; merged=true; fi
    printf '{"number":24,"html_url":"https://github.com/example/project/pull/24","state":"%s","merged":%s,"mergeable":%s,"head":{"ref":"codex/issue-24-delivery","sha":"%s","repo":{"full_name":"example/project"}},"base":{"ref":"main","repo":{"full_name":"example/project"}}}' "$state" "$merged" "\${HARNESS_FAKE_MERGEABLE:-true}" "$HARNESS_FAKE_HEAD"
    ;;
  *"pr checks"*)
    if [ "$HARNESS_FAKE_EMPTY_CHECKS" = 1 ]; then printf '[]'; else printf '[{"name":"CI","state":"%s"}]' "\${HARNESS_FAKE_CHECK:-SUCCESS}"; fi
    ;;
  *) printf '{"number":24}' ;;
esac
`, "utf8");
  chmodSync(join(bin, "git"), 0o755);
  chmodSync(join(bin, "gh"), 0o755);
  const saved = {
    path: process.env.PATH,
    remote: process.env.HARNESS_FAKE_REMOTE,
    merged: process.env.HARNESS_FAKE_MERGED,
    head: process.env.HARNESS_FAKE_HEAD,
    noPull: process.env.HARNESS_FAKE_NO_PULL,
    check: process.env.HARNESS_FAKE_CHECK,
    emptyChecks: process.env.HARNESS_FAKE_EMPTY_CHECKS,
    mergeable: process.env.HARNESS_FAKE_MERGEABLE,
  };
  process.env.PATH = `${bin}:${saved.path ?? ""}`;
  process.env.HARNESS_FAKE_REMOTE = join(bin, "remote-head");
  process.env.HARNESS_FAKE_MERGED = join(bin, "merged");
  process.env.HARNESS_FAKE_HEAD = git(root, "rev-parse", "HEAD");
  return () => {
    process.env.PATH = saved.path;
    for (const [key, value] of Object.entries({
      HARNESS_FAKE_REMOTE: saved.remote,
      HARNESS_FAKE_MERGED: saved.merged,
      HARNESS_FAKE_HEAD: saved.head,
      HARNESS_FAKE_NO_PULL: saved.noPull,
      HARNESS_FAKE_CHECK: saved.check,
      HARNESS_FAKE_EMPTY_CHECKS: saved.emptyChecks,
      HARNESS_FAKE_MERGEABLE: saved.mergeable,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
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

  it("rejects authorization facts that cannot be safely bound", () => {
    const root = fixture();
    const base = {
      projectRoot: root,
      workItem: "github:example/project#24",
      baseBranch: "main",
      allowedPaths: ["mcp-server/src/"],
      intent: "Deliver Issue #24.",
      approvalSource: "codex://accepted",
    };
    for (const [change, error] of [
      [{ repository: "example/other" }, "DELIVERY_REMOTE_REPOSITORY_MISMATCH"],
      [{ workItem: "github:example/other#24" }, "DELIVERY_WORK_ITEM_REPOSITORY_MISMATCH"],
      [{ featureBranch: "main" }, "DELIVERY_BRANCH_INVALID"],
      [{ featureBranch: "other" }, "DELIVERY_FEATURE_BRANCH_NOT_CHECKED_OUT"],
      [{ intent: " " }, "DELIVERY_INTENT_REQUIRED"],
      [{ approvalSource: " " }, "DELIVERY_APPROVAL_SOURCE_REQUIRED"],
      [{ supersedes: "not-a-hash" }, "DELIVERY_SUPERSEDES_HASH_INVALID"],
      [{ allowedPaths: ["../outside"] }, "DELIVERY_ALLOWED_PATH_INVALID"],
    ] as const) {
      expect(() => authorizeDelivery({ ...base, ...change })).toThrow(error);
    }
  });

  it("selects only a single live superseding authorization", () => {
    const root = fixture();
    expect(latestDeliveryAuthorization(root, "github:example/project#24")).toBeNull();
    const first = authorization(root).authorization;
    const second = authorizeDelivery({
      projectRoot: root,
      workItem: first.workItem,
      baseBranch: "main",
      allowedPaths: first.allowedPaths,
      intent: first.intent,
      approvalSource: first.approval.source,
      supersedes: first.authorizationHash,
      now: new Date("2026-08-31T00:01:00.000Z"),
    }).authorization;
    expect(latestDeliveryAuthorization(root, first.workItem)?.authorizationHash).toBe(second.authorizationHash);
  });

  it("rejects missing receipt authorization and ambiguous live authorizations", () => {
    const root = fixture();
    expect(() => loadDeliveryAuthorization(root, "not-a-hash")).toThrow("DELIVERY_AUTHORIZATION_HASH_INVALID");
    expect(() => loadDeliveryAuthorization(root, "0".repeat(64))).toThrow("DELIVERY_AUTHORIZATION_NOT_FOUND");
    const options = {
      projectRoot: root,
      workItem: "github:example/project#24",
      baseBranch: "main",
      allowedPaths: ["mcp-server/src/"],
      intent: "Deliver Issue #24.",
      approvalSource: "codex://accepted",
    };
    authorizeDelivery({ ...options, now: new Date("2026-08-31T00:00:00.000Z") });
    authorizeDelivery({ ...options, now: new Date("2026-08-31T00:01:00.000Z") });
    expect(() => latestDeliveryAuthorization(root, options.workItem)).toThrow("DELIVERY_AUTHORIZATION_AMBIGUOUS");
  });

  it("keeps an authorization valid across in-scope commits and records one evidence chain", () => {
    const root = fixture();
    const result = authorization(root);
    const restore = fakeCommands(root);
    try {
      const firstPush = pushDelivery({ projectRoot: root, authorizationHash: result.authorization.authorizationHash });
      expect(firstPush.sequence).toBe(1);

      const target = join(root, "mcp-server", "src");
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, "next.ts"), "export const next = true;\n", "utf8");
      git(root, "add", "mcp-server/src/next.ts");
      git(root, "commit", "-m", "feat: continue authorized delivery");
      process.env.HARNESS_FAKE_HEAD = git(root, "rev-parse", "HEAD");

      expect(pushDelivery({ projectRoot: root, authorizationHash: result.authorization.authorizationHash })).toMatchObject({
        action: "push", sequence: 2,
      });
    } finally {
      restore();
    }
  }, 15_000);

  it("uses exact PR and required-check evidence before squash merge", () => {
    const root = fixture();
    const result = authorization(root);
    const restore = fakeCommands(root);
    try {
      const push = pushDelivery({ projectRoot: root, authorizationHash: result.authorization.authorizationHash });
      const pull = upsertDeliveryPullRequest({
        projectRoot: root,
        authorizationHash: result.authorization.authorizationHash,
        title: "Issue #24",
      });
      const merge = mergeDelivery({ projectRoot: root, authorizationHash: result.authorization.authorizationHash, pullRequest: 24 });

      expect([push.action, pull.action, merge.action]).toEqual(["push", "pull-request", "merge"]);
      expect(deliveryStatus(root, result.authorization.authorizationHash).phase).toBe("closing");
    } finally {
      restore();
    }
  }, 15_000);

  it("creates a missing exact PR but never merges a failed required check", () => {
    const root = fixture();
    const result = authorization(root);
    const restore = fakeCommands(root);
    try {
      pushDelivery({ projectRoot: root, authorizationHash: result.authorization.authorizationHash });
      process.env.HARNESS_FAKE_NO_PULL = "1";
      expect(upsertDeliveryPullRequest({
        projectRoot: root,
        authorizationHash: result.authorization.authorizationHash,
        title: "Issue #24",
      }).action).toBe("pull-request");
      process.env.HARNESS_FAKE_NO_PULL = undefined;
      process.env.HARNESS_FAKE_CHECK = "FAILURE";
      expect(() => mergeDelivery({ projectRoot: root, authorizationHash: result.authorization.authorizationHash, pullRequest: 24 }))
        .toThrow("DELIVERY_REQUIRED_CHECKS_NOT_GREEN");
    } finally {
      restore();
    }
  }, 15_000);

  it("blocks remote drift, missing check evidence, and an unapproved merge mode", () => {
    const root = fixture();
    const result = authorization(root);
    const restore = fakeCommands(root);
    try {
      writeFileSync(process.env.HARNESS_FAKE_REMOTE!, "0".repeat(40), "utf8");
      expect(() => pushDelivery({ projectRoot: root, authorizationHash: result.authorization.authorizationHash }))
        .toThrow("DELIVERY_REMOTE_BRANCH_DRIFT");

      rmSync(process.env.HARNESS_FAKE_REMOTE!, { force: true });
      pushDelivery({ projectRoot: root, authorizationHash: result.authorization.authorizationHash });
      upsertDeliveryPullRequest({ projectRoot: root, authorizationHash: result.authorization.authorizationHash, title: "Issue #24" });
      process.env.HARNESS_FAKE_EMPTY_CHECKS = "1";
      expect(() => mergeDelivery({ projectRoot: root, authorizationHash: result.authorization.authorizationHash, pullRequest: 24 }))
        .toThrow("DELIVERY_REQUIRED_CHECK_EVIDENCE_UNAVAILABLE");

      const manual = authorizeDelivery({
        projectRoot: root,
        workItem: "github:example/project#25",
        baseBranch: "main",
        allowedPaths: ["mcp-server/src/"],
        intent: "Deliver Issue #25.",
        approvalSource: "codex://accepted",
        now: new Date("2026-08-31T00:01:00.000Z"),
      });
      expect(() => mergeDelivery({ projectRoot: root, authorizationHash: manual.authorization.authorizationHash, pullRequest: 24 }))
        .toThrow("DELIVERY_MERGE_REQUIRES_HUMAN_GATE");
    } finally {
      restore();
    }
  }, 15_000);

  it("enforces per-action capability, cleanliness, title, and mergeability guards", () => {
    const root = fixture();
    const restore = fakeCommands(root);
    try {
      const noPush = authorizeDelivery({
        projectRoot: root, workItem: "github:example/project#26", baseBranch: "main", allowedPaths: ["mcp-server/src/"],
        intent: "Deliver Issue #26.", approvalSource: "codex://accepted", capabilities: { pushOwnBranch: false },
      });
      expect(() => pushDelivery({ projectRoot: root, authorizationHash: noPush.authorization.authorizationHash }))
        .toThrow("DELIVERY_PUSH_NOT_AUTHORIZED");

      const noPr = authorizeDelivery({
        projectRoot: root, workItem: "github:example/project#27", baseBranch: "main", allowedPaths: ["mcp-server/src/"],
        intent: "Deliver Issue #27.", approvalSource: "codex://accepted", capabilities: { upsertPullRequest: false },
      });
      expect(() => upsertDeliveryPullRequest({ projectRoot: root, authorizationHash: noPr.authorization.authorizationHash, title: "Issue #27" }))
        .toThrow("DELIVERY_PULL_REQUEST_NOT_AUTHORIZED");

      const normal = authorization(root);
      writeFileSync(join(root, "scratch.txt"), "dirty\n", "utf8");
      expect(() => pushDelivery({ projectRoot: root, authorizationHash: normal.authorization.authorizationHash }))
        .toThrow("DELIVERY_WORKTREE_DIRTY");
      rmSync(join(root, "scratch.txt"));
      pushDelivery({ projectRoot: root, authorizationHash: normal.authorization.authorizationHash });
      process.env.HARNESS_FAKE_NO_PULL = "1";
      expect(() => upsertDeliveryPullRequest({ projectRoot: root, authorizationHash: normal.authorization.authorizationHash, title: " " }))
        .toThrow("DELIVERY_PULL_REQUEST_TITLE_REQUIRED");
      process.env.HARNESS_FAKE_NO_PULL = undefined;
      upsertDeliveryPullRequest({ projectRoot: root, authorizationHash: normal.authorization.authorizationHash, title: "Issue #24" });
      process.env.HARNESS_FAKE_MERGEABLE = "false";
      expect(() => mergeDelivery({ projectRoot: root, authorizationHash: normal.authorization.authorizationHash, pullRequest: 24 }))
        .toThrow("DELIVERY_PULL_REQUEST_NOT_MERGEABLE");
    } finally {
      restore();
    }
  }, 15_000);
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

  it("fails closed for missing evidence, head drift, disabled authority, and unclassified failures", () => {
    const root = fixture();
    const deliveryAuthorization = authorization(root).authorization;
    const head = git(root, "rev-parse", "HEAD");
    const base = {
      authorization: deliveryAuthorization,
      currentHead: head,
      runHead: head,
      runId: "123",
      workflow: "CI",
      job: "linux",
      requiredCheck: "build-and-test (linux-x64)",
      step: "checkout" as const,
      attempt: 1,
      failedLog: "fatal: unable to access github.com: Failed to connect to github.com port 443",
    };
    expect(canRetryCi({ ...base, workflow: "" }).reason).toBe("DELIVERY_CI_EVIDENCE_INCOMPLETE");
    expect(canRetryCi({ ...base, runHead: "0".repeat(40) }).reason).toBe("DELIVERY_CI_HEAD_DRIFT");
    expect(canRetryCi({ ...base, authorization: { ...deliveryAuthorization, capabilities: { ...deliveryAuthorization.capabilities, retryInfrastructureCi: false } } }).reason)
      .toBe("DELIVERY_CI_RETRY_NOT_AUTHORIZED");
    expect(canRetryCi({ ...base, failedLog: "Coverage 79% < 80%" }).reason).toBe("DELIVERY_CI_DETERMINISTIC");
    expect(canRetryCi({ ...base, failedLog: "unclassified", step: "runner" }).reason).toBe("DELIVERY_CI_UNKNOWN");
    expect(classifyCiFailure("cache download timeout", "cache").kind).toBe("infrastructure");
    expect(classifyCiFailure("cache restore reset", "cache").kind).toBe("infrastructure");
    expect(classifyCiFailure("runner offline", "runner").kind).toBe("infrastructure");
    expect(classifyCiFailure("GitHub 503", "runner").kind).toBe("infrastructure");
    expect(classifyCiFailure("connection reset", "checkout").kind).toBe("infrastructure");
    expect(classifyCiFailure("network is unreachable", "checkout").kind).toBe("infrastructure");
    expect(classifyCiFailure("runner lost", "runner").kind).toBe("infrastructure");
    expect(classifyCiFailure("unclassified", "unknown").kind).toBe("unknown");
  });
});
