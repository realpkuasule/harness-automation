import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitCoordinationStore, confirmRenewal, coordinationStatus, nextLease, reserveRenewal, terminalClaim } from "./service.js";

const paths: string[] = [];
function git(cwd: string, ...args: string[]): string { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
function fixture(): { root: string; remote: string; store: GitCoordinationStore } {
  const root = mkdtempSync(join(tmpdir(), "harness-coordination-")); paths.push(root);
  const remote = join(root, "remote.git"); git(root, "init", "--bare", remote);
  const local = join(root, "local"); git(root, "clone", "--quiet", remote, local); git(local, "config", "user.email", "test@example.test"); git(local, "config", "user.name", "Test");
  return { root: local, remote, store: new GitCoordinationStore(local, "origin", "refs/harness/coordination/v3") };
}
function lease(workItem = "github:owner/repo#1", prior = null) { return nextLease({ prior, repository: "owner/repo", repositoryId: "R_1", workItem, branch: "codex/test", sourceRepositoryId: "R_1", owner: "octo", machine: "machine-a", controlEpochDigest: "a".repeat(64), head: "b".repeat(40), expiresAt: "2030-01-01T00:00:00.000Z", transactionId: `tx-${workItem}` }); }
afterEach(() => { while (paths.length) rmSync(paths.pop()!, { recursive: true, force: true }); });

describe("GitCoordinationStore", () => {
  it("uses exact-old-SHA CAS, preserves other work items, and rejects stale ownership", () => {
    const { store } = fixture();
    const first = lease();
    const saved = store.compareAndSwap({ workItem: first.workItem, expectedControlSha: null, expected: {}, next: first });
    const before = store.read(first.workItem);
    const other = lease("github:owner/repo#2");
    store.compareAndSwap({ workItem: other.workItem, expectedControlSha: before.controlSha, expected: {}, next: other });
    expect(store.read(first.workItem).record?.recordHash).toBe(saved.recordHash);
    expect(() => store.compareAndSwap({ workItem: first.workItem, expectedControlSha: before.controlSha, expected: { generation: 2 }, next: lease(first.workItem, saved) })).toThrow("COORDINATION_CAS_CONFLICT");
  });

  it("reports unconfigured status and refuses production mutation", () => {
    const { root } = fixture();
    expect(coordinationStatus(root)).toMatchObject({ configured: false, coordinated: false, result: "CoordinationBackendRequired" });
  });

  it("does not let a delayed renewal extend a lease without pre-expiry server evidence", () => {
    const first = lease();
    const pending = reserveRenewal(first, { generation: 1, owner: "octo", controlEpochDigest: first.controlEpochDigest, lastObservedHead: first.lastObservedHead }, "2031-01-01T00:00:00.000Z");
    expect(() => confirmRenewal(pending, { recordHash: pending.recordHash }, "2030-01-01T00:00:00.000Z")).toThrow("COORDINATION_RENEWAL_TIME_UNPROVEN");
    const renewed = confirmRenewal(pending, { recordHash: pending.recordHash }, "2029-12-31T23:59:59.000Z");
    expect(renewed.expiresAt).toBe("2031-01-01T00:00:00.000Z");
    expect(terminalClaim(renewed, { generation: 1, controlEpochDigest: renewed.controlEpochDigest, lastObservedHead: renewed.lastObservedHead }, "c".repeat(40)).expiresAt).toBeNull();
  });
});
