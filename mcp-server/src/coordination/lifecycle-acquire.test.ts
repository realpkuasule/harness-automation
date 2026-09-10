import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitCoordinationStore } from "./store.js";
import { seedLocalGenesis, localTransport, localHistory } from "./__fixtures__/transport.js";
import { CoordinationClock } from "./clock.js";
import { nextLease } from "./leases.js";
import { createCoordinationRecord, expectedRecord } from "./record.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const ref = "refs/heads/contention-control";

describe("local-acquire-contention/1 (LOCAL native fixtures)", () => {
  it("two A workers competing for the same control ref produce one winner and one COORDINATION_CAS_CONFLICT loser", () => {
    const root = mkdtempSync(join(tmpdir(), "lac-"));
    roots.push(root);
    const remote = join(root, "remote.git");
    git(root, "init", "--bare", "--quiet", remote);
    const clock = new CoordinationClock(() => ({ monotonicMs: 0, wallMs: 0 }));
    clock.observe("Fri, 04 Sep 2026 04:00:00 GMT", clock.start());
    const genesis = seedLocalGenesis(remote, ref);
    const transport = localTransport(root, remote);
    const history = localHistory(root, ref, genesis, "42");
    const store = new GitCoordinationStore(ref, transport, () => {}, genesis, history, () => () => {});
    const baseArgs = { repository: "owner/repo", repositoryId: "R_1", branch: "codex/feature", sourceRepositoryId: "R_1",
      owner: "octo", controlEpochDigest: "a".repeat(64), ttlMs: 60_000 };

    // Pre-write a "preserved" record on a different workItem so the ref tree is non-empty.
    const otherNext = nextLease({ ...baseArgs, workItem: "github:owner/repo#2", branch: "codex/two", machine: "preserved", head: genesis.commitSha, transactionId: "preserved" }, clock);
    const preserved = store.compareAndSwap({ workItem: otherNext.workItem, expectedControlSha: genesis.commitSha, expected: {}, next: otherNext });
    const baseSha = preserved.candidate?.controlSha ?? preserved.controlSha;
    expect(preserved.disposition).toBe("current");

    // Two A workers contend for the same target workItem, both expecting baseSha.
    const a1Next = createCoordinationRecord({ ...nextLease({ ...baseArgs, workItem: "github:owner/repo#86", machine: "machine-a1", head: genesis.commitSha, transactionId: "contender-0" }, clock) });
    const a2Next = createCoordinationRecord({ ...nextLease({ ...baseArgs, workItem: "github:owner/repo#86", machine: "machine-a2", head: genesis.commitSha, transactionId: "contender-1" }, clock) });

    const a1Prepared = store.prepareCompareAndSwap({ workItem: "github:owner/repo#86", expectedControlSha: baseSha, expected: {}, next: a1Next });
    const a2Prepared = store.prepareCompareAndSwap({ workItem: "github:owner/repo#86", expectedControlSha: baseSha, expected: {}, next: a2Next });

    // A1 dispatches → wins, control ref advances.
    const a1Applied = store.dispatchPrepared(a1Prepared);
    expect(a1Applied.disposition).toBe("current");
    expect(a1Applied.candidate.controlSha).not.toBe(baseSha);

    // A2 dispatches with the same expected.controlSha (now stale) → COORDINATION_CAS_CONFLICT
    expect(() => store.dispatchPrepared(a2Prepared)).toThrow("COORDINATION_CAS_CONFLICT");
  });

  it("a stale tuple from a pre-winner A is rejected on rebind (COORDINATION_STALE_*)", () => {
    const root = mkdtempSync(join(tmpdir(), "lac-"));
    roots.push(root);
    const remote = join(root, "remote.git");
    git(root, "init", "--bare", "--quiet", remote);
    const clock = new CoordinationClock(() => ({ monotonicMs: 0, wallMs: 0 }));
    clock.observe("Fri, 04 Sep 2026 04:00:00 GMT", clock.start());
    const genesis = seedLocalGenesis(remote, ref);
    const transport = localTransport(root, remote);
    const history = localHistory(root, ref, genesis, "42");
    const store = new GitCoordinationStore(ref, transport, () => {}, genesis, history, () => () => {});

    // Bootstrap a "preserved" record on a different workItem.
    const preservedNext = nextLease({ repository: "owner/repo", repositoryId: "R_1", workItem: "github:owner/repo#2", branch: "codex/two", sourceRepositoryId: "R_1",
      owner: "octo", machine: "preserved", controlEpochDigest: "a".repeat(64), ttlMs: 60_000, head: genesis.commitSha, transactionId: "tx-preserved" }, clock);
    const preserved = store.compareAndSwap({ workItem: preservedNext.workItem, expectedControlSha: genesis.commitSha, expected: {}, next: preservedNext });
    const baseSha = preserved.candidate?.controlSha ?? preserved.controlSha;

    // A1 acquires the target workItem.
    const a1Next = nextLease({ repository: "owner/repo", repositoryId: "R_1", workItem: "github:owner/repo#86", branch: "codex/feature", sourceRepositoryId: "R_1",
      owner: "octo", machine: "machine-a1", controlEpochDigest: "a".repeat(64), ttlMs: 60_000, head: genesis.commitSha, transactionId: "tx-a1" }, clock);
    const a1Result = store.compareAndSwap({ workItem: "github:owner/repo#86", expectedControlSha: baseSha, expected: {}, next: a1Next });
    const a1Record = a1Result.candidate?.record;
    expect(a1Record).toBeDefined();
    expect(a1Record!.transactionId).toBe("tx-a1");

    // A2 tries to rebind with a stale tuple (B's recordHash as expected) → COORDINATION_STALE_*
    const a2Next = createCoordinationRecord({ ...nextLease({ repository: "owner/repo", repositoryId: "R_1", workItem: "github:owner/repo#86", branch: "codex/feature", sourceRepositoryId: "R_1",
      owner: "octo", machine: "machine-a2", controlEpochDigest: "a".repeat(64), ttlMs: 60_000, head: genesis.commitSha, transactionId: "tx-a2" }, clock) });
    // The stale expected tuple uses preserved.recordHash but A1 is now the actual record.
    const staleExpected = expectedRecord(preservedNext);
    expect(() => store.compareAndSwap({ workItem: "github:owner/repo#86", expectedControlSha: a1Result.candidate!.controlSha, expected: staleExpected, next: a2Next }))
      .toThrow(/^COORDINATION_STALE_/);
  });
});