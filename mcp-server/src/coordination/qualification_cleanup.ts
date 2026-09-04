import { loadHumanAuthorization, recordWriteOutcomeLocked, reserveWriteAttemptLocked } from "../approval/human.js";
import { assertMutationLock, withMutationLock } from "../recovery/service.js";
import { resolveRepositoryContext, type GitCommandResult } from "../repository/git.js";
import { hashObject } from "../v2/fs.js";
import { collectClientEvidence, readVerifiedClientEvidence, recheckClientEvidence } from "./evidence.js";
import { coordinationDeleteOutcome } from "./push_result.js";
import { observeQualificationRemote, readQualificationRemote, type QualificationRemoteEvidence } from "./qualification_remote.js";
import { nativeCoordinationObservers } from "./runtime.js";
import { loadQualificationManifest } from "./manifest.js";
import { GitHubCoordinationTransport } from "./transport.js";

export type QualificationCleanup = Readonly<{ kind: "native-qualification-cleanup" }>;
type Plan = { remote: QualificationRemoteEvidence; ref: string; expected: string | null; evidenceHash: string; consumed: boolean };
const plans = new WeakMap<QualificationCleanup, Plan>();

/** A finite intention, not a new approval. Serialized hashes cannot be turned back into this native handle. */
export function planQualificationCleanup(remote: QualificationRemoteEvidence, ref: string): QualificationCleanup {
  const facts = readQualificationRemote(remote); const observation = facts.observations.find((item) => item.ref === ref);
  if (!observation || !facts.manifest.clients.find((item) => item.clientId === facts.manifest.cleanupClientId)?.scope.refs.includes(ref)) throw new Error("HUMAN_WRITE_SCOPE_MISMATCH");
  const handle: QualificationCleanup = Object.freeze({ kind: "native-qualification-cleanup" });
  plans.set(handle, { remote, ref, expected: observation.head, evidenceHash: facts.evidenceHash, consumed: false }); return handle;
}

/** One exact-ref dispatch, using the original cleanup ticket and ledger. Unknown attempts are never replayed here. */
export async function applyQualificationCleanup(handle: QualificationCleanup) {
  const plan = plans.get(handle); if (!plan || plan.consumed) throw new Error("QUALIFICATION_CLEANUP_ORIGIN_UNPROVEN");
  plan.consumed = true;
  const original = readQualificationRemote(plan.remote); const clientId = original.manifest.cleanupClientId;
  const initial = readVerifiedClientEvidence(original.evidence.find((item) => readVerifiedClientEvidence(item).clientId === clientId)!);
  const context = resolveRepositoryContext(initial.projectRoot);
  return withMutationLock(context, (lock) => {
    const current = readQualificationRemote(observeQualificationRemote(original.settled, { clientId, lock }));
    if (current.evidenceHash !== plan.evidenceHash) throw new Error("QUALIFICATION_CLEANUP_PLAN_STALE");
    if (plan.expected === null) return { status: "observed-absent" as const, ref: plan.ref, attemptId: null };
    const expected = plan.expected;
    const cleaner = readVerifiedClientEvidence(current.evidence.find((item) => readVerifiedClientEvidence(item).clientId === clientId)!);
    const state = cleaner.chains[0].state; const scope = state.approval.scope;
    if (scope.kind !== "qualification-run" || scope.manifest?.clientId !== clientId) throw new Error("QUALIFICATION_CLIENT_SCOPE_MISMATCH");
    const { observeBinding, provider, remote } = nativeCoordinationObservers(context, scope.binding);
    const cleanupEvidenceHash = hashObject({ manifestHash: current.manifest.manifestHash, evidenceHash: current.evidenceHash, ref: plan.ref, expected });
    let attemptId: string | undefined; let dispatchUsed = false;
    const transport = new GitHubCoordinationTransport(context.projectDir, remote, scope.binding.repositoryId, scope.binding.credentialRef, undefined, (intent) => {
      if (plans.get(handle) !== plan || !plan.consumed || dispatchUsed) throw new Error("QUALIFICATION_CLEANUP_ORIGIN_UNPROVEN");
      dispatchUsed = true; assertMutationLock(context, lock);
      const observed = observeBinding();
      for (const field of ["repository", "repositoryId", "endpointHash", "credentialBindingHash", "credentialRef", "actor", "hostId"] as const) {
        if (intent[field] !== observed[field]) throw new Error("HUMAN_AUTHORIZATION_BINDING_MISMATCH");
      }
      if (intent.ref !== plan.ref || intent.expected !== expected) throw new Error("HUMAN_WRITE_SCOPE_MISMATCH");
      current.evidence.forEach((evidence) => recheckClientEvidence(evidence, readVerifiedClientEvidence(evidence).clientId === clientId ? lock : undefined));
      if (transport.readRef(plan.ref) !== expected) throw new Error("QUALIFICATION_REMOTE_REF_DRIFT");
      const clock = provider.serverClock();
      const attempt = reserveWriteAttemptLocked(lock, context.commonDir, cleaner.approvalRef, observed, {
        transactionId: `cleanup-${current.manifest.runId}`, operation: "cleanup", ref: plan.ref, head: null, expected, candidateId: null,
        cleanupEvidenceHash, cleanupManifest: scope.manifest,
      }, clock); attemptId = attempt.attemptId;
      // The one just-reserved pending attempt is expected, not a reason to self-lock or accept any other new tail.
      const after = readVerifiedClientEvidence(collectClientEvidence(context.projectDir, cleaner.approvalRef, lock));
      const beforeChain = cleaner.chains[0]; const afterChain = after.chains[0];
      if (after.chains.length !== cleaner.chains.length || afterChain.receipts.length !== beforeChain.receipts.length + 1 ||
          hashObject(afterChain.receipts.slice(0, -1)) !== hashObject(beforeChain.receipts) ||
          hashObject(afterChain.receipts.at(-1)!.snapshot) !== hashObject({ kind: "reserved", attempt }) ||
          after.lkg.length !== cleaner.lkg.length + 1 || hashObject(after.lkg.slice(0, -1)) !== hashObject(cleaner.lkg)) throw new Error("QUALIFICATION_EVIDENCE_DRIFT");
      for (const evidence of current.evidence) if (readVerifiedClientEvidence(evidence).clientId !== clientId) recheckClientEvidence(evidence);
      assertMutationLock(context, lock); clock.requireBefore(scope.cleanupExpiresAt);
    });
    let pushed: GitCommandResult | undefined; let final = false;
    const record = (status: "applied" | "rejected" | "unknown", observation?: string | null, error?: string) => {
      if (!attemptId) return;
      recordWriteOutcomeLocked(lock, context.commonDir, cleaner.approvalRef, { attemptId, status,
        push: pushed ? { status: pushed.status, stdout: pushed.stdout, error: pushed.error } : undefined,
        evidenceHash: hashObject({ cleanupEvidenceHash, pushed, observation, error }) });
      final = status !== "unknown";
    };
    try {
      pushed = transport.deleteRef(plan.ref, expected);
      const outcome = coordinationDeleteOutcome(pushed, plan.ref);
      if (outcome === "rejected") { record("rejected"); throw new Error("COORDINATION_CAS_CONFLICT"); }
      record("unknown"); // Positive deletion evidence is durable before its separate absent readback.
      if (outcome !== "deleted") throw new Error("COORDINATION_WRITE_OUTCOME_UNKNOWN");
      const actual = transport.readRef(plan.ref);
      if (actual !== null) throw new Error("QUALIFICATION_CLEANUP_READBACK_FAILED");
      record("applied", actual); return { status: "deleted" as const, ref: plan.ref, attemptId: attemptId! };
    } catch (error) {
      if (!final) {
        try { record("unknown", undefined, error instanceof Error ? error.message.split(":")[0] : "COORDINATION_WRITE_OUTCOME_UNKNOWN"); }
        catch (recordError) { throw new AggregateError([error, recordError], "QUALIFICATION_CLEANUP_AND_RECORD_FAILED"); }
      }
      throw error;
    }
  });
}

/** Read-only remote recovery may append a proven result, but never reconstructs a deletion handle or dispatches again. */
export async function recoverQualificationCleanup(projectRoot: string, approvalRef: string, attemptId: string) {
  const context = resolveRepositoryContext(projectRoot);
  return withMutationLock(context, (lock) => {
    const state = loadHumanAuthorization(context.commonDir, approvalRef); const scope = state.approval.scope;
    const attempt = state.attempts.find((item) => item.attemptId === attemptId);
    if (scope.kind !== "qualification-run" || !scope.manifest || !state.writesClosed || !attempt || attempt.operation !== "cleanup" ||
        !attempt.cleanupEvidenceHash || attempt.outcome?.status === "rejected" ||
        loadQualificationManifest(context.commonDir, scope.manifest.manifestHash).cleanupClientId !== scope.manifest.clientId) throw new Error("COORDINATION_RECOVERY_REQUIRED");
    const { remote } = nativeCoordinationObservers(context, scope.binding);
    const transport = new GitHubCoordinationTransport(context.projectDir, remote, scope.binding.repositoryId, scope.binding.credentialRef);
    const observed = transport.readRef(attempt.ref); const push = attempt.outcome?.push;
    if (observed !== null || !push || coordinationDeleteOutcome(push, attempt.ref) !== "deleted") {
      return { status: "state-observed" as const, ref: attempt.ref, observed, attemptId };
    }
    if (attempt.outcome?.status !== "applied") recordWriteOutcomeLocked(lock, context.commonDir, approvalRef, { attemptId, status: "applied", push,
      evidenceHash: hashObject({ manifest: scope.manifest, cleanupEvidenceHash: attempt.cleanupEvidenceHash, ref: attempt.ref, expected: attempt.expected, observed }) });
    return { status: "applied" as const, ref: attempt.ref, observed, attemptId };
  });
}
