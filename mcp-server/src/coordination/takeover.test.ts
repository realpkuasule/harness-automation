import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadHumanAuthorization, recordHumanApproval, type HumanScope } from "../approval/human.js";
import { createSemanticApprovalPacket } from "../approval/service.js";
import { acquireMutationLock, releaseMutationLock, type MutationLock } from "../recovery/service.js";
import { resolveRepositoryContext } from "../repository/git.js";
import { hashObject } from "../v2/fs.js";
import { controlEpochDigest, observeQualificationEpoch } from "./authority.js";
import { humanCoordinationGuards, recoverHumanCoordinationWrite } from "./authorization.js";
import { CoordinationClock } from "./clock.js";
import { requireWriteLease } from "./leases.js";
import { createCoordinationRecord, expectedRecord, validRecord } from "./record.js";
import { GitCoordinationStore } from "./store.js";
import { observeTakeoverRisk, prepareTakeover } from "./takeover.js";
import { localHistory, localTransport } from "./__fixtures__/transport.js";

const roots: string[] = []; const digest = "a".repeat(64); const workItem = "github:owner/repo#86";
const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture(state: "Admitted" | "Active" | "Ready" | "MergeArmed" | "Prepared" | "Draft" | "Abandoned" = "Admitted", advance = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "takeover-fixture-"))); roots.push(root);
  const target = join(root, "target"); mkdirSync(target); git(target, "init", "--quiet"); git(target, "checkout", "-b", "codex/fixture");
  git(target, "config", "user.name", "Fixture"); git(target, "config", "user.email", "fixture@example.test");
  writeFileSync(join(target, "tracked"), "original\n"); writeFileSync(join(target, ".gitignore"), "ignored\n"); git(target, "add", "."); git(target, "commit", "-qm", "source");
  const remote = join(root, "remote.git"); git(root, "init", "--bare", "--quiet", remote); git(target, "push", remote, "HEAD:refs/heads/codex/fixture");
  const context = resolveRepositoryContext(target); const head = git(target, "rev-parse", "HEAD");
  if (advance) git(target, "commit", "--allow-empty", "-qm", "target-only");
  const binding = { commonDir: context.commonDir, repository: "owner/repo", repositoryId: "R_1", endpointHash: digest, credentialBindingHash: digest,
    credentialRef: "fixture-git", credentialPurpose: "git-transport" as const, actor: "target", hostId: "841ba5a8-40e2-4848-b5a4-082f4f2145a9",
    configHash: digest, controlEpoch: observeQualificationEpoch(target, digest), implementation: { kind: "package" as const, artifactDigest: digest }, runnerHash: digest };
  const controlRef = "refs/heads/fixture-control"; const source = localTransport(target, remote); let genesis = "";
  const initial = createCoordinationRecord({ repository: binding.repository, repositoryId: binding.repositoryId, workItem, branch: "codex/fixture", sourceRepositoryId: binding.repositoryId,
    owner: "old", machine: "old-machine", generation: 1, controlEpochDigest: "b".repeat(64), lastObservedHead: head,
    lifecycleState: state, createdAt: "2026-09-04T03:00:00.000Z", expiresAt: state === "Abandoned" ? null : "2026-09-04T03:01:00.000Z",
    closeOwnerGeneration: state === "Abandoned" ? 1 : undefined, transactionId: "frozen-old",
    handoff: state === "Abandoned" ? undefined : { transferId: "frozen-old", target: { owner: "unavailable-target", machine: "unknown-target" },
      source: { owner: "old", machine: "old-machine", generation: 1, epoch: "b".repeat(64), head, expiresAt: "2026-09-04T03:01:00.000Z" } } });
  // LOCAL setup only: these synthetic ancestors are not counted or reported as a qualified native run.
  const history = localHistory(context.commonDir, controlRef, () => genesis);
  const seeded = new GitCoordinationStore(controlRef, source, (candidate) => { genesis = candidate.controlSha; }, true, history, () => () => {});
  const oldSha = seeded.compareAndSwap({ workItem, expectedControlSha: null, expected: {}, next: initial }).candidate.controlSha;
  let date = "Fri, 04 Sep 2026 04:00:00 GMT"; let late = false; let pushes = 0;
  const clock = () => { const c = new CoordinationClock(() => ({ monotonicMs: 0, wallMs: 0 })); c.observe(date, c.start()); return c; };
  function approve(scope: HumanScope) {
    const inputHash = hashObject(scope); const planHash = hashObject({ inputHash });
    const packet = createSemanticApprovalPacket({ planHash, inputHash, producerIdentity: "controlled-local-takeover-fixture",
      binding: { planHash, inputDigest: inputHash, contextDigest: digest, policyDigest: digest, observedHash: inputHash },
      actions: [{ id: scope.kind, kind: "permission-change", protected: true, summary: "Synthetic fixture only", before: null, after: inputHash, reversible: false, recovery: "Retain assets; read back without replay" }] });
    return recordHumanApproval(context.commonDir, { packet, scope, approvedBy: "fixture-human", approvedAt: "2026-09-04T03:30:00.000Z",
      source: { kind: "explicit-human", messageHash: digest } }, planHash, clock());
  }
  const run: HumanScope = { kind: "qualification-run", binding, runId: "fixture-run", refs: [controlRef, "refs/heads/codex/fixture"], operations: ["create", "cas"],
    maxCommits: 3, maxWriteAttempts: 3, maxCleanupAttempts: 1, expiresAt: "2026-09-04T05:00:00.000Z", cleanupExpiresAt: "2026-09-04T06:00:00.000Z",
    takeoverAllocations: [{ allocationId: "takeover", workItem, controlRef, sourceRef: "refs/heads/codex/fixture", genesisSha: genesis, maxCommits: 2, maxWriteAttempts: 2 }] };
  const parentApprovalRef = approve(run);
  const locked = <T>(operation: (held: MutationLock) => T) => { const held = acquireMutationLock(context); try { return operation(held); } finally { releaseMutationLock(held); } };
  function scope(): Extract<HumanScope, { kind: "takeover" }> {
    const assetRisk = locked((held) => observeTakeoverRisk(context, held, initial, source, binding));
    return { kind: "takeover", binding, expiresAt: run.expiresAt, workItem, controlRef, expectedControlSha: oldSha,
      expected: expectedRecord(initial) as Extract<HumanScope, { kind: "takeover" }>["expected"], targetOwner: binding.actor, targetHostId: binding.hostId,
      targetWorkspace: target, targetBranch: initial.branch, targetHead: git(target, "rev-parse", "HEAD"), sourceRepositoryId: source.repositoryId,
      newEpochDigest: controlEpochDigest(binding.controlEpoch), newLease: { ttlMs: 120_000, notAfter: "2026-09-04T04:01:30.000Z" },
      assetRisk, assetRiskHash: hashObject(assetRisk), transactionId: "takeover-once", maxCommits: 2, maxWriteAttempts: 2,
      qualification: { parentApprovalRef, runId: run.runId, allocationId: "takeover", genesisSha: genesis } };
  }
  function runtime(approvalRef: string, held: MutationLock) {
    let prepared: ReturnType<typeof prepareTakeover> | undefined;
    const guards = humanCoordinationGuards(context.commonDir, approvalRef, () => binding, clock, held, (intent) => {
      if (!prepared) throw new Error("COORDINATION_OPERATION_AUTHORITY_REQUIRED"); prepared.assertCandidate(intent);
    }, "takeover");
    const store = new GitCoordinationStore(controlRef, { ...source, push(directory, sha, ref, expected) {
      guards.authorizeWrite({ ...binding, ref, head: sha, expected }); pushes++;
      const result = source.push(directory, sha, ref, expected); if (late) date = "Fri, 04 Sep 2026 04:02:00 GMT"; return result;
    } }, guards.beforePush, false, history, guards.beforeCommit);
    return { store, takeover() { prepared = prepareTakeover(context, held, approvalRef, store, source, () => binding, clock); return prepared.apply(); } };
  }
  return { root, target, context, initial, oldSha, binding, seeded, source, controlRef, clock, scope, approve, locked, runtime,
    pushes: () => pushes, late: () => { late = true; }, expire: () => { date = "Fri, 04 Sep 2026 06:01:00 GMT"; } };
}

describe("exact human takeover through actual LOCAL Git/receipt handlers, not LIVE", { timeout: 30_000 }, () => {
  it("accepts approved unknown-source risk and a new Head/epoch without deleting assets or inheriting Ready", () => {
    const f = fixture("Ready", true); writeFileSync(join(f.target, "tracked"), "retained dirty\n"); writeFileSync(join(f.target, "ignored"), "retained ignored\n");
    const scope = f.scope(); expect(scope.assetRisk.source.kind).toBe("not-observed"); expect(scope.assetRisk.target.unpushedCommits).toBe(1);
    const approvalRef = f.approve(scope); const next = f.locked((held) => f.runtime(approvalRef, held).takeover());
    expect(next).toMatchObject({ generation: 2, owner: "target", lifecycleState: "Active", createdAt: "2026-09-04T04:00:00.000Z", expiresAt: scope.newLease.notAfter,
      lastObservedHead: scope.targetHead, controlEpochDigest: scope.newEpochDigest });
    expect(validRecord(next)).toBe(true); expect(next.handoff).toBeUndefined(); expect(next.renewal).toBeUndefined(); expect(f.pushes()).toBe(1);
    expect(readFileSync(join(f.target, "tracked"), "utf8")).toBe("retained dirty\n"); expect(readFileSync(join(f.target, "ignored"), "utf8")).toBe("retained ignored\n");
    expect(() => f.locked((held) => f.runtime(approvalRef, held).takeover())).toThrow("COORDINATION_CAS_CONFLICT");
    expect(loadHumanAuthorization(f.context.commonDir, approvalRef).attempts[0].outcome?.status).toBe("applied");
  });

  it("rejects same-path asset changes and forged Head/epoch/expected without creating candidates", () => {
    const f = fixture(); writeFileSync(join(f.target, "tracked"), "before\n"); const scope = f.scope();
    expect(() => f.approve({ ...scope, newEpochDigest: "c".repeat(64) })).toThrow("HUMAN_SCOPE_INVALID");
    const approvalRef = f.approve(scope); writeFileSync(join(f.target, "tracked"), "after\n");
    expect(() => f.locked((held) => f.runtime(approvalRef, held).takeover())).toThrow("COORDINATION_TAKEOVER_ASSET_DRIFT");
    expect(loadHumanAuthorization(f.context.commonDir, approvalRef).candidates).toEqual([]); expect(f.pushes()).toBe(0);
    const g = fixture(); const wrong = g.scope(); wrong.expected.generation++;
    const ref = g.approve(wrong); expect(() => g.locked((held) => g.runtime(ref, held).takeover())).toThrow("COORDINATION_STALE_GENERATION");
    expect(g.pushes()).toBe(0);
  });

  it.each(["MergeArmed", "Prepared", "Draft", "Abandoned"] as const)("does not invent delivery/disarming authority for %s", (state) => {
    const f = fixture(state); const ref = f.approve(f.scope());
    expect(() => f.locked((held) => f.runtime(ref, held).takeover())).toThrow(/COORDINATION_(DISARM_REQUIRED|DELIVERY_MAPPING_OBSERVER_REQUIRED|TAKEOVER_TERMINAL_OR_ABSENT)/u);
    expect(f.pushes()).toBe(0);
  });

  it("recovers an unknown applied transaction after expiry without replay, new generation or a new deadline", () => {
    const f = fixture(); const scope = f.scope(); const ref = f.approve(scope);
    f.locked((held) => { const runtime = f.runtime(ref, held); vi.spyOn(runtime.store, "recover").mockImplementationOnce(() => { throw new Error("READBACK_FAILED"); });
      expect(() => runtime.takeover()).toThrow("READBACK_FAILED"); });
    const pending = loadHumanAuthorization(f.context.commonDir, ref); roots.push(pending.candidates[0].objectDirectory);
    expect(pending.attempts[0].outcome?.status).toBe("unknown"); f.expire();
    const recovered = recoverHumanCoordinationWrite(f.context.commonDir, ref, pending.attempts[0].attemptId, f.seeded);
    expect(recovered.candidate.record).toMatchObject({ generation: 2, expiresAt: scope.newLease.notAfter });
    expect(() => requireWriteLease(recovered.candidate.record, expectedRecord(recovered.candidate.record), f.clock())).toThrow("COORDINATION_LEASE_WINDOW_EXHAUSTED");
    expect(f.pushes()).toBe(1); expect(loadHumanAuthorization(f.context.commonDir, ref).attempts[0].outcome?.status).toBe("applied");
  });

  it("denies a late CAS readback a write token while preserving the exact applied candidate", () => {
    const f = fixture(); const scope = f.scope(); const ref = f.approve(scope); f.late();
    expect(() => f.locked((held) => f.runtime(ref, held).takeover())).toThrow("COORDINATION_LEASE_WINDOW_EXHAUSTED");
    expect(f.seeded.read(workItem).record).toMatchObject({ generation: 2, expiresAt: scope.newLease.notAfter });
    expect(f.pushes()).toBe(1);
  });
});
