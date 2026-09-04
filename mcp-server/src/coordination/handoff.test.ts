import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireMutationLock, assertMutationLock, releaseMutationLock } from "../recovery/service.js";
import { resolveRepositoryContext } from "../repository/git.js";
import { hashObject } from "../v2/fs.js";
import { controlEpochDigest, observeQualificationEpoch, qualificationOperationAuthority } from "./authority.js";
import { CoordinationClock } from "./clock.js";
import { handoffObservers } from "./handoff.js";
import { requireWriteLease } from "./leases.js";
import { expectedRecord } from "./record.js";
import { CoordinationLifecycleService } from "./service.js";
import { GitCoordinationStore, type CoordinationCommitIntent } from "./store.js";
import { localHistory, localTransport } from "./__fixtures__/transport.js";
import { assertManagedWriteAllowedLocked, runManagedWrite } from "./writer.js";

const roots: string[] = []; const digest = "a".repeat(64); const workItem = "github:owner/repo#86";
const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture(sourceRepositoryId = "R_1") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "handoff-fixture-"))); roots.push(root);
  const remote = join(root, "remote.git"); git(root, "init", "--bare", "--quiet", remote);
  const sourceRoot = join(root, "source"); const targetRoot = join(root, "target");
  git(root, "clone", "--quiet", remote, sourceRoot); git(sourceRoot, "checkout", "-b", "codex/fixture");
  git(sourceRoot, "config", "user.name", "Fixture"); git(sourceRoot, "config", "user.email", "fixture@example.test");
  writeFileSync(join(sourceRoot, "tracked.txt"), "source\n"); writeFileSync(join(sourceRoot, ".gitignore"), "ignored.log\n");
  git(sourceRoot, "add", "."); git(sourceRoot, "commit", "-m", "source"); git(sourceRoot, "push", "origin", "HEAD:refs/heads/codex/fixture");
  git(root, "clone", "--quiet", "--branch", "codex/fixture", remote, targetRoot);
  const source = resolveRepositoryContext(sourceRoot); const target = resolveRepositoryContext(targetRoot);
  const binding = (side: "source" | "target") => ({ commonDir: (side === "source" ? source : target).commonDir,
    repository: "owner/repo", repositoryId: "R_1", endpointHash: digest, credentialBindingHash: digest, credentialRef: "fixture-git",
    credentialPurpose: "git-transport" as const, actor: side, hostId: side === "source" ? "741ba5a8-40e2-4848-b5a4-082f4f2145a9" : "841ba5a8-40e2-4848-b5a4-082f4f2145a9",
    configHash: digest, controlEpoch: observeQualificationEpoch(side === "source" ? sourceRoot : targetRoot, digest),
    implementation: { kind: "package" as const, artifactDigest: digest }, runnerHash: digest });
  const controlRef = "refs/heads/coordination-fixture"; let genesis = ""; let date = "Fri, 04 Sep 2026 04:00:00 GMT";
  let writes = 0; let activeWriters = 0; let lateTarget = false; let retrieved = 0;
  const clock = () => { const c = new CoordinationClock(() => ({ monotonicMs: 0, wallMs: 0 })); c.observe(date, c.start()); return c; };
  function run<T>(side: "source" | "target", action: (service: CoordinationLifecycleService, store: GitCoordinationStore) => T, covered = true) {
    const context = side === "source" ? source : target; const held = acquireMutationLock(context);
    try {
      const bound = binding(side); const authority = qualificationOperationAuthority(context.projectDir, bound, () => binding(side), clock);
      const local = localTransport(context.projectDir, remote); let intent: CoordinationCommitIntent | undefined;
      const store = new GitCoordinationStore(controlRef, { ...local, push(directory, head, ref, expected) {
        assertMutationLock(context, held); authority.assertCandidate(intent!); writes++;
        const result = local.push(directory, head, ref, expected); if (side === "target" && lateTarget) date = "Fri, 04 Sep 2026 04:02:00 GMT";
        return result;
      } }, (candidate) => { if (!candidate.expectedControlSha) genesis = candidate.controlSha; }, true,
      localHistory(context.commonDir, controlRef, () => genesis), (candidate) => { authority.assertCandidate(candidate); intent = candidate; return () => {}; });
      const observers = handoffObservers(context, held, { ...local, fetch(directory, head) { retrieved++; local.fetch(directory, head); } }, () => binding(side), clock,
        covered ? (record, lock) => {
          assertMutationLock(context, lock); if (activeWriters) throw new Error("COORDINATION_SOURCE_WRITERS_UNRESOLVED");
          return { kind: "isolated-qualification", observerId: "controlled-local-fixture/1", entrypoints: ["fixture.run"],
            quiescenceHash: hashObject({ record: record.recordHash, commonDir: context.commonDir, activeWriters }) };
        } : undefined);
      return action(new CoordinationLifecycleService(store, clock, undefined, authority.prepare, observers), store);
    } finally { releaseMutationLock(held); }
  }
  const initial = run("source", (service) => service.acquire({ repository: "owner/repo", repositoryId: "R_1", workItem,
    branch: "codex/fixture", sourceRepositoryId, owner: "source", machine: binding("source").hostId,
    controlEpochDigest: controlEpochDigest(binding("source").controlEpoch), head: git(sourceRoot, "rev-parse", "HEAD"), ttlMs: 60_000, transactionId: "acquire" }));
  const targetIdentity = { owner: "target", machine: binding("target").hostId };
  const freeze = () => run("source", (service, store) => { const current = store.read(workItem); return service.freezeTransfer(workItem, current.controlSha!, expectedRecord(current.record!), targetIdentity, "transfer-1"); });
  const publish = (covered = true) => run("source", (service, store) => { const current = store.read(workItem); return service.publishSourceProof(workItem, current.controlSha!, expectedRecord(current.record!), "transfer-1"); }, covered);
  const accept = () => run("target", (service, store) => { const current = store.read(workItem); return service.acceptTransfer(workItem, current.controlSha!, expectedRecord(current.record!), "transfer-1", "target-session"); });
  return { root, sourceRoot, targetRoot, source, target, initial, run, freeze, publish, accept, clock,
    writer: () => run("source", (_, store) => ({ context: source, store, observeAuthority: () => binding("source"), refreshClock: clock })),
    writes: () => writes, retrieved: () => retrieved, busy: () => { activeWriters = 1; }, expire: () => { date = "Fri, 04 Sep 2026 04:02:00 GMT"; }, late: () => { lateTarget = true; } };
}

describe("three-phase transfer through actual LOCAL Git handlers (not GitHub LIVE)", { timeout: 30_000 }, () => {
  it("holds the shared lock through a real awaited write and rechecks freeze before a queued writer can edit", async () => {
    const f = fixture(); const ctx = f.writer(); const current = ctx.store.read(workItem);
    let finish!: () => void; const pending = new Promise<void>((resolve) => { finish = resolve; }); let edits = 0;
    const write = runManagedWrite(ctx, workItem, current.controlSha!, expectedRecord(current.record!), async (held) => {
      assertManagedWriteAllowedLocked(ctx, held, workItem, current.controlSha!, expectedRecord(current.record!));
      await pending; writeFileSync(join(f.sourceRoot, "tracked.txt"), "managed edit\n"); edits++;
    });
    expect(() => f.freeze()).toThrow("WORKSPACE_LOCKED"); finish(); await write; expect(edits).toBe(1);
    const frozen = f.freeze(); const observed = ctx.store.read(workItem);
    await expect(runManagedWrite(ctx, workItem, observed.controlSha!, expectedRecord(frozen), () => { edits++; }))
      .rejects.toThrow("COORDINATION_WRITE_LEASE_UNAVAILABLE");
    expect(edits).toBe(1);
  });

  it("freezes writes and transfers only after source proof and the target's own retrieval, preserving the original TTL", () => {
    const f = fixture(); const frozen = f.freeze();
    expect(frozen.lifecycleState).toBe("Admitted"); expect(frozen.generation).toBe(1);
    f.run("source", (service) => {
      expect(() => service.rebind(workItem, expectedRecord(frozen), "other", frozen.lastObservedHead)).toThrow("COORDINATION_WRITE_LEASE_UNAVAILABLE");
      expect(() => service.renew(workItem, expectedRecord(frozen), 120_000)).toThrow("COORDINATION_WRITE_LEASE_UNAVAILABLE");
    });
    const published = f.publish(); expect(published.handoff?.sourceProof?.freezeRecordHash).toBe(frozen.recordHash);
    renameSync(f.sourceRoot, join(f.root, "source-offline")); // Acceptance must not open the source path stored in its proof.
    const accepted = f.accept(); expect(f.retrieved()).toBe(2);
    expect(accepted).toMatchObject({ owner: "target", generation: 2, expiresAt: f.initial.expiresAt, sessionRef: "target-session" });
    expect(accepted.handoff?.targetAcceptance?.retrievedHead).toBe(f.initial.lastObservedHead);
    expect(accepted.handoff?.sourceProof?.facts.workspace).toBe(f.sourceRoot);
    expect(() => requireWriteLease(accepted, expectedRecord(frozen), f.clock())).toThrow("COORDINATION_STALE_RECORDHASH");
    expect(f.writes()).toBe(4);
  });

  it.each(["tracked", "untracked", "ignored", "hidden-index", "unpublished"])("retains frozen %s assets instead of publishing a zero-loss proof", (kind) => {
    const f = fixture();
    if (kind === "unpublished") {
      git(f.sourceRoot, "commit", "--allow-empty", "-m", "unpublished");
      f.run("source", (service) => service.rebind(workItem, expectedRecord(f.initial), undefined, git(f.sourceRoot, "rev-parse", "HEAD")));
    }
    const frozen = f.freeze(); const before = f.writes();
    if (kind === "tracked") writeFileSync(join(f.sourceRoot, "tracked.txt"), "changed\n");
    if (kind === "untracked") writeFileSync(join(f.sourceRoot, "untracked.txt"), "keep\n");
    if (kind === "ignored") writeFileSync(join(f.sourceRoot, "ignored.log"), "keep\n");
    if (kind === "hidden-index") { git(f.sourceRoot, "update-index", "--assume-unchanged", "tracked.txt"); writeFileSync(join(f.sourceRoot, "tracked.txt"), "hidden\n"); }
    expect(() => f.publish()).toThrow(/COORDINATION_TRANSFER_(?:EVIDENCE_INSUFFICIENT|ASSETS_UNSUPPORTED|REMOTE_HEAD_MISMATCH)/u);
    expect(f.writes()).toBe(before);
    f.run("source", (_, store) => expect(store.read(workItem).record?.recordHash).toBe(frozen.recordHash));
  });

  it("does not confuse acquiring the lock with proven coverage or settled writers", () => {
    const f = fixture(); const frozen = f.freeze();
    expect(() => f.publish(false)).toThrow("COORDINATION_SOURCE_WRITER_COVERAGE_REQUIRED");
    f.busy(); expect(() => f.publish()).toThrow("COORDINATION_SOURCE_WRITERS_UNRESOLVED");
    expect(f.writes()).toBe(2); expect(f.retrieved()).toBe(0);
    f.run("source", (_, store) => expect(store.read(workItem).record?.recordHash).toBe(frozen.recordHash));
  });

  it("rejects unbound fork sources before freeze and stale expectations without a new write", () => {
    const f = fixture("fork-repository"); expect(() => f.freeze()).toThrow("COORDINATION_SOURCE_REPOSITORY_BINDING_REQUIRED"); expect(f.writes()).toBe(1);
    const g = fixture(); const frozen = g.freeze();
    g.run("source", (service, store) => expect(() => service.publishSourceProof(workItem, store.read(workItem).controlSha!, expectedRecord(frozen), "wrong-transfer"))
      .toThrow("COORDINATION_TRANSFER_NOT_FROZEN"));
    expect(g.writes()).toBe(2);
  });

  it("denies a late acceptance token even if its CAS was applied, and never extends the old deadline", () => {
    const f = fixture(); f.freeze(); f.publish(); f.late();
    expect(() => f.accept()).toThrow("COORDINATION_LEASE_WINDOW_EXHAUSTED");
    f.run("target", (_, store) => {
      const record = store.read(workItem).record!; expect(record.generation).toBe(2); expect(record.expiresAt).toBe(f.initial.expiresAt);
      expect(() => requireWriteLease(record, expectedRecord(record), f.clock())).toThrow("COORDINATION_LEASE_WINDOW_EXHAUSTED");
    });
    expect(f.writes()).toBe(4);
  });
});
