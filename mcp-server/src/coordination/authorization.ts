import { hashObject } from "../v2/fs.js";
import { loadHumanAuthorization, recordCandidateResult, recordCandidateResultLocked, recordWriteOutcome, recordWriteOutcomeLocked,
  reserveCandidateQuota, reserveCandidateQuotaLocked, reserveWriteAttempt, reserveWriteAttemptLocked, type HumanScopeBinding } from "../approval/human.js";
import type { MutationLock } from "../recovery/service.js";
import type { CoordinationClock } from "./clock.js";
import type { CoordinationCandidate, CoordinationCommitIntent, CoordinationWriteResult, GitCoordinationStore } from "./store.js";
import type { CoordinationWriteIntent } from "./transport.js";

/** Fixed qualification composition, not production enablement. Observers are supplied by the native runner. */
export function qualificationGuards(commonDir: string, approvalRef: string, observeBinding: () => HumanScopeBinding, refreshClock: () => CoordinationClock, held?: MutationLock) {
  // Explicit borrowing only: the enclosing handoff owns and releases this exact handle.
  const reserveCandidate = held ? reserveCandidateQuotaLocked.bind(null, held) : reserveCandidateQuota;
  const recordCandidate = held ? recordCandidateResultLocked.bind(null, held) : recordCandidateResult;
  const reserveAttempt = held ? reserveWriteAttemptLocked.bind(null, held) : reserveWriteAttempt;
  const recordOutcome = held ? recordWriteOutcomeLocked.bind(null, held) : recordWriteOutcome;
  let active: { candidate: CoordinationCandidate; attempted: boolean; attemptId?: string } | undefined;
  function authorization() {
    const state = loadHumanAuthorization(commonDir, approvalRef);
    if (state.approval.scope.kind !== "qualification-run") throw new Error("COORDINATION_QUALIFICATION_SCOPE_REQUIRED");
    return state;
  }
  return {
    beforeCommit(intent: CoordinationCommitIntent) {
      authorization();
      const reserved = reserveCandidate(commonDir, approvalRef, observeBinding(), intent, refreshClock());
      return (head: string | null) => recordCandidate(commonDir, approvalRef, {
        candidateId: reserved.candidateId, status: head === null ? "unknown" : "created", head,
        evidenceHash: hashObject({ candidateId: reserved.candidateId, intent, head }),
      });
    },
    beforePush(candidate: CoordinationCandidate) {
      if (active) throw new Error("COORDINATION_WRITE_ALREADY_PREPARED");
      const state = authorization();
      const reserved = state.candidates.find((item) => item.result?.status === "created" && item.result.head === candidate.controlSha &&
        item.transactionId === candidate.record.transactionId && item.parentSha === candidate.expectedControlSha && item.treeSha === candidate.treeSha &&
        item.recordHash === candidate.record.recordHash && item.objectDirectory === candidate.objectDirectory);
      if (!reserved) throw new Error("HUMAN_CANDIDATE_UNPROVEN");
      active = { candidate, attempted: false };
      return (result: CoordinationWriteResult) => {
        const finished = active; active = undefined;
        if (!finished?.attemptId) return; // A pre-dispatch gate is not a network outcome.
        const status = result.applied ? "applied" : result.error === "COORDINATION_CAS_CONFLICT" && result.pushed?.status === 1 && !result.pushed.error ? "rejected" : "unknown";
        recordOutcome(commonDir, approvalRef, { attemptId: finished.attemptId, status, evidenceHash: hashObject(result) });
      };
    },
    authorizeWrite(intent: CoordinationWriteIntent) {
      if (!active || active.attempted) throw new Error("COORDINATION_WRITE_NOT_PREPARED");
      const candidate = active.candidate; const observed = observeBinding();
      for (const field of ["repository", "repositoryId", "endpointHash", "credentialBindingHash", "credentialRef", "actor", "hostId"] as const) {
        if (intent[field] !== observed[field]) throw new Error("HUMAN_AUTHORIZATION_BINDING_MISMATCH");
      }
      if (intent.ref !== candidate.controlRef || intent.head !== candidate.controlSha || intent.expected !== candidate.expectedControlSha) throw new Error("HUMAN_WRITE_SCOPE_MISMATCH");
      // One callback invocation can authorize one dispatch. A restart recovers receipts, never this closure.
      active.attempted = true;
      const attempt = reserveAttempt(commonDir, approvalRef, observed, { transactionId: candidate.record.transactionId,
        operation: intent.expected === null ? "create" : "cas", ref: intent.ref, head: intent.head, expected: intent.expected }, refreshClock());
      active.attemptId = attempt.attemptId;
    },
  };
}

/** Unknown writes are recovered from exact remote history, even after ticket expiry; never replayed. */
export function recoverQualificationWrite(commonDir: string, approvalRef: string, attemptId: string, store: GitCoordinationStore) {
  const state = loadHumanAuthorization(commonDir, approvalRef);
  if (state.approval.scope.kind !== "qualification-run") throw new Error("COORDINATION_QUALIFICATION_SCOPE_REQUIRED");
  const attempt = state.attempts.find((item) => item.attemptId === attemptId);
  const candidate = state.candidates.find((item) => item.candidateId === attempt?.candidateId);
  if (!attempt || !candidate || !attempt.head || candidate.result?.status !== "created" || candidate.result.head !== attempt.head || attempt.operation === "cleanup" || attempt.outcome?.status === "rejected") throw new Error("COORDINATION_RECOVERY_REQUIRED");
  const result = store.recoverRecordedCandidate({ controlSha: attempt.head, expectedControlSha: attempt.expected,
    treeSha: candidate.treeSha, recordHash: candidate.recordHash, objectDirectory: candidate.objectDirectory });
  if (result.candidate.controlRef !== attempt.ref || result.candidate.record.repository !== state.approval.scope.binding.repository || result.candidate.record.repositoryId !== state.approval.scope.binding.repositoryId) throw new Error("COORDINATION_RECOVERY_REQUIRED");
  if (attempt.outcome?.status !== "applied") recordWriteOutcome(commonDir, approvalRef, { attemptId, status: "applied", evidenceHash: hashObject(result) });
  return result;
}
