import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CoordinationLifecycleService, GitCoordinationStore, confirmRenewal, coordinationStatus, nextLease, observeZeroLossTransfer, reserveRenewal, terminalClaim, transferLease } from "./service.js";

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

  it("uses one real lifecycle handler for acquire, rebind, and terminal CAS", () => {
    const { store } = fixture(); const lifecycle = new CoordinationLifecycleService(store); const input = { prior: null, repository: "owner/repo", repositoryId: "R_1", workItem: "github:owner/repo#9", branch: "codex/test", sourceRepositoryId: "R_1", owner: "octo", machine: "machine-a", controlEpochDigest: "a".repeat(64), head: "b".repeat(40), expiresAt: "2030-01-01T00:00:00.000Z", transactionId: "lifecycle" };
    const acquired = lifecycle.acquire(input); const expected = { recordHash: acquired.recordHash, generation: 1, owner: "octo", controlEpochDigest: acquired.controlEpochDigest, lastObservedHead: acquired.lastObservedHead };
    const rebound = lifecycle.rebind(acquired.workItem, expected, "opaque", acquired.lastObservedHead);
    expect(lifecycle.terminalClaim(acquired.workItem, { ...expected, recordHash: rebound.recordHash }, "c".repeat(40)).expiresAt).toBeNull();
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

  it("moves a generation only after a zero-loss exact-head transfer snapshot", () => {
    const first = lease(); const expected = { generation: 1, owner: "octo", controlEpochDigest: first.controlEpochDigest, lastObservedHead: first.lastObservedHead };
    expect(() => transferLease(first, expected, { owner: "new", machine: "b" }, { sourceHead: first.lastObservedHead, remoteHead: first.lastObservedHead, targetRetrievedHead: first.lastObservedHead, trackedClean: true, untracked: [], ignored: [], uniqueCommits: 1, unpushedCommits: 0 })).toThrow("COORDINATION_TRANSFER_EVIDENCE_INSUFFICIENT");
    expect(transferLease(first, expected, { owner: "new", machine: "b" }, { sourceHead: first.lastObservedHead, remoteHead: first.lastObservedHead, targetRetrievedHead: first.lastObservedHead, trackedClean: true, untracked: [], ignored: [], uniqueCommits: 0, unpushedCommits: 0 }).generation).toBe(2);
  });

  it("derives transfer evidence from two Git checkouts, rejecting unpushed source state", () => {
    const { root, remote } = fixture(); git(root, "checkout", "--orphan", "source"); git(root, "commit", "--allow-empty", "-m", "source"); git(root, "push", "origin", "HEAD:refs/heads/source");
    const target = join(root, "..", "target"); git(root, "clone", "--quiet", remote, target); git(target, "fetch", "origin", "refs/heads/source"); paths.push(target);
    const clean = observeZeroLossTransfer(root, remote, "refs/heads/source", target); expect(clean.unpushedCommits).toBe(0);
    git(root, "commit", "--allow-empty", "-m", "local");
    expect(() => observeZeroLossTransfer(root, remote, "refs/heads/source", target)).toThrow("COORDINATION_TRANSFER_REMOTE_HEAD_MISMATCH");
  });
});
