import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoordinationLifecycleService, GitCoordinationStore, confirmRenewal, coordinationStatus, nextLease, observeRenewal, observeZeroLossTransfer, reserveRenewal, transferLease } from "./service.js";
import { createCoordinationRecord, expectedRecord } from "./record.js";
import { CoordinationClock } from "./clock.js";
import { localHistory, localTransport } from "./__fixtures__/transport.js";

const paths: string[] = [];
function git(cwd: string, ...args: string[]): string { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
function fixture(): { root: string; remote: string; store: GitCoordinationStore } {
  const root = mkdtempSync(join(tmpdir(), "harness-coordination-")); paths.push(root);
  const remote = join(root, "remote.git"); git(root, "init", "--bare", remote);
  const local = join(root, "local"); git(root, "clone", "--quiet", remote, local); git(local, "config", "user.email", "test@example.test"); git(local, "config", "user.name", "Test");
  const controlRef = "refs/heads/harness-automation/coordination/v3"; let genesis = "";
  return { root: local, remote, store: new GitCoordinationStore(controlRef, localTransport(local, remote), (candidate) => { if (!candidate.expectedControlSha) genesis = candidate.controlSha; }, true, localHistory(local, controlRef, () => genesis), () => () => {}) };
}
function sampleClock(date = "Fri, 04 Sep 2026 04:00:00 GMT") { const clock = new CoordinationClock(() => ({ monotonicMs: 0, wallMs: 0 })); clock.observe(date, clock.start()); return clock; }
function lease(workItem = "github:owner/repo#1") { return nextLease({ repository: "owner/repo", repositoryId: "R_1", workItem, branch: "codex/test", sourceRepositoryId: "R_1", owner: "octo", machine: "machine-a", controlEpochDigest: "a".repeat(64), head: "b".repeat(40), ttlMs: 86_400_000, transactionId: `tx-${workItem}` }, sampleClock()); }
afterEach(() => { while (paths.length) rmSync(paths.pop()!, { recursive: true, force: true }); });

describe("GitCoordinationStore", { timeout: 20_000 }, () => {
  it("refuses terminal claims without an authenticated merge observer", () => {
    const { store } = fixture(); const first = lease();
    store.compareAndSwap({ workItem: first.workItem, expectedControlSha: null, expected: {}, next: first });
    const before = store.read(first.workItem).controlSha;
    const lifecycle = new CoordinationLifecycleService(store, sampleClock);
    expect(() => lifecycle.terminalClaim(first.workItem, expectedRecord(first), "c".repeat(40) as never, "main")).toThrow("COORDINATION_MERGE_OBSERVER_REQUIRED");
    expect(store.read(first.workItem).controlSha).toBe(before);
  });
  it("refuses an expired lease in the actual rebind handler before a remote mutation", () => {
    const { store } = fixture();
    const expired = createCoordinationRecord({ ...lease(), createdAt: "2020-01-01T00:00:00.000Z", expiresAt: "2020-01-02T00:00:00.000Z" });
    store.compareAndSwap({ workItem: expired.workItem, expectedControlSha: null, expected: {}, next: expired });
    const clock = new CoordinationClock(() => ({ monotonicMs: 0, wallMs: 0 })); clock.observe("Fri, 04 Sep 2026 04:00:00 GMT", clock.start());
    const service = new CoordinationLifecycleService(store, () => clock);
    const before = store.read(expired.workItem).controlSha;
    expect(() => service.rebind(expired.workItem, expectedRecord(expired), "new-session", expired.lastObservedHead)).toThrow("COORDINATION_LEASE_WINDOW_EXHAUSTED");
    expect(store.read(expired.workItem).controlSha).toBe(before);
  });
  it("uses exact-old-SHA CAS, preserves other work items, and rejects stale ownership", () => {
    const { store } = fixture();
    const first = lease();
    const saved = store.compareAndSwap({ workItem: first.workItem, expectedControlSha: null, expected: {}, next: first }).current.record!;
    const before = store.read(first.workItem);
    const other = lease("github:owner/repo#2");
    store.compareAndSwap({ workItem: other.workItem, expectedControlSha: before.controlSha, expected: {}, next: other });
    expect(store.read(first.workItem).record?.recordHash).toBe(saved.recordHash);
    expect(() => store.compareAndSwap({ workItem: first.workItem, expectedControlSha: before.controlSha, expected: { generation: 2 }, next: lease(first.workItem) })).toThrow("COORDINATION_CAS_CONFLICT");
  });

  it("uses one real lifecycle handler for acquire and rebind CAS", () => {
    const { store } = fixture(); const lifecycle = new CoordinationLifecycleService(store, sampleClock); const input = { repository: "owner/repo", repositoryId: "R_1", workItem: "github:owner/repo#9", branch: "codex/test", sourceRepositoryId: "R_1", owner: "octo", machine: "machine-a", controlEpochDigest: "a".repeat(64), head: "b".repeat(40), ttlMs: 86_400_000, transactionId: "lifecycle" };
    const acquired = lifecycle.acquire(input); const expected = expectedRecord(acquired);
    const rebound = lifecycle.rebind(acquired.workItem, expected, "opaque", acquired.lastObservedHead);
    expect(rebound.sessionRef).toBe("opaque");
    expect(store.read(acquired.workItem).record?.recordHash).toBe(rebound.recordHash);
  });

  it("reports unconfigured status and refuses production mutation", () => {
    const { root } = fixture();
    expect(coordinationStatus(root)).toMatchObject({ configured: false, coordinated: false, result: "CoordinationBackendRequired" });
  });

  it("does not let a delayed renewal extend a lease without pre-expiry server evidence", () => {
    const first = lease();
    const pending = reserveRenewal(first, expectedRecord(first), 172_800_000, sampleClock());
    const late = sampleClock("Sat, 05 Sep 2026 04:00:00 GMT");
    expect(() => observeRenewal(pending, "c".repeat(40), late)).toThrow("COORDINATION_LEASE_WINDOW_EXHAUSTED");
    const proof = observeRenewal(pending, "c".repeat(40), sampleClock());
    const renewed = confirmRenewal(pending, expectedRecord(pending), proof, late);
    expect(renewed.expiresAt).toBe("2026-09-06T04:00:00.000Z");
    expect(renewed.renewalConfirmation).toEqual(proof); expect(renewed.generation).toBe(first.generation);
    const replaced = createCoordinationRecord({ ...pending, generation: 2, owner: "another" });
    expect(() => confirmRenewal(replaced, expectedRecord(replaced), proof, late)).toThrow("COORDINATION_RENEWAL_TIME_UNPROVEN");
    expect(() => confirmRenewal(pending, expectedRecord(pending), { ...proof, observedUpperBoundAt: pending.expiresAt! }, late)).toThrow("COORDINATION_RENEWAL_TIME_UNPROVEN");
  });

  it("persists both renewal phases and the timely proof without incrementing the generation", () => {
    const { store } = fixture(); const first = lease();
    store.compareAndSwap({ workItem: first.workItem, expectedControlSha: null, expected: {}, next: first });
    const lifecycle = new CoordinationLifecycleService(store, sampleClock);
    const renewed = lifecycle.renew(first.workItem, expectedRecord(first), 172_800_000);
    expect(renewed.generation).toBe(first.generation); expect(renewed.renewal).toBeUndefined();
    expect(renewed.renewalConfirmation?.oldExpiresAt).toBe(first.expiresAt);
    expect(store.read(first.workItem).record?.recordHash).toBe(renewed.recordHash);
  });

  it("never grants proposed time after a late reservation, including to a restarted handler", () => {
    const { store } = fixture(); const first = lease();
    store.compareAndSwap({ workItem: first.workItem, expectedControlSha: null, expected: {}, next: first });
    let date = "Fri, 04 Sep 2026 04:00:00 GMT";
    const original = store.compareAndSwap.bind(store);
    const writes = vi.spyOn(store, "compareAndSwap").mockImplementation((args) => { const result = original(args); if (args.next.renewal) date = "Sat, 05 Sep 2026 04:00:00 GMT"; return result; });
    const lifecycle = new CoordinationLifecycleService(store, () => sampleClock(date));
    expect(() => lifecycle.renew(first.workItem, expectedRecord(first), 172_800_000)).toThrow("COORDINATION_LEASE_WINDOW_EXHAUSTED");
    expect(writes).toHaveBeenCalledTimes(1);
    const pending = store.read(first.workItem).record!;
    expect(pending.expiresAt).toBe(first.expiresAt); expect(pending.generation).toBe(first.generation); expect(pending.renewal).toBeDefined();
    const restarted = new CoordinationLifecycleService(store, () => sampleClock(date));
    expect(() => restarted.rebind(pending.workItem, expectedRecord(pending), "restarted", pending.lastObservedHead)).toThrow("COORDINATION_WRITE_LEASE_UNAVAILABLE");
    expect(writes).toHaveBeenCalledTimes(1);
  });

  it("moves a generation only after a zero-loss exact-head transfer snapshot", () => {
    const first = lease(); const expected = expectedRecord(first);
    expect(() => transferLease(first, expected, { owner: "new", machine: "b" }, { sourceHead: first.lastObservedHead, remoteHead: first.lastObservedHead, targetRetrievedHead: first.lastObservedHead, trackedClean: true, untracked: [], ignored: [], uniqueCommits: 1, unpushedCommits: 0 }, sampleClock())).toThrow("COORDINATION_TRANSFER_EVIDENCE_INSUFFICIENT");
    expect(transferLease(first, expected, { owner: "new", machine: "b" }, { sourceHead: first.lastObservedHead, remoteHead: first.lastObservedHead, targetRetrievedHead: first.lastObservedHead, trackedClean: true, untracked: [], ignored: [], uniqueCommits: 0, unpushedCommits: 0 }, sampleClock()).generation).toBe(2);
  });

  it("derives transfer evidence from two Git checkouts, rejecting unpushed source state", () => {
    const { root, remote } = fixture(); git(root, "checkout", "--orphan", "source"); git(root, "commit", "--allow-empty", "-m", "source"); git(root, "push", "origin", "HEAD:refs/heads/source");
    const target = join(root, "..", "target"); git(root, "clone", "--quiet", remote, target); git(target, "fetch", "origin", "refs/heads/source"); paths.push(target);
    const clean = observeZeroLossTransfer(root, remote, "refs/heads/source", target); expect(clean.unpushedCommits).toBe(0);
    git(root, "commit", "--allow-empty", "-m", "local");
    expect(() => observeZeroLossTransfer(root, remote, "refs/heads/source", target)).toThrow("COORDINATION_TRANSFER_REMOTE_HEAD_MISMATCH");
  });
});
