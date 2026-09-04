import { hashObject } from "../v2/fs.js";
import { assertHumanCandidateScope, loadHumanAuthorization, recordCandidateResult, recordCandidateResultLocked, recordWriteOutcome, recordWriteOutcomeLocked,
  reserveCandidateQuota, reserveCandidateQuotaLocked, reserveWriteAttempt, reserveWriteAttemptLocked, type HumanScopeBinding } from "../approval/human.js";
import type { MutationLock } from "../recovery/service.js";
import type { CoordinationClock } from "./clock.js";
import type { CoordinationCandidate, CoordinationCommitIntent, CoordinationTransport, CoordinationWriteResult, GitCoordinationStore } from "./store.js";
import type { CoordinationWriteIntent } from "./transport.js";
import { recoverSourceFixture, type SyntheticCandidate, type SyntheticWriteResult } from "./publication.js";
import { coordinationPushOutcome } from "./push_result.js";

/** Fixed human-authorized qualification/takeover paths, not a general production write permission. */
export function humanCoordinationGuards(commonDir: string, approvalRef: string, observeBinding: () => HumanScopeBinding, refreshClock: () => CoordinationClock,
  held?: MutationLock, assertCandidate?: (intent: CoordinationCommitIntent) => void, scopeKind: "qualification-run" | "takeover" | "production-enable" = "qualification-run") {
  // Explicit borrowing only: the enclosing handoff owns and releases this exact handle.
  const reserveCandidate = held ? reserveCandidateQuotaLocked.bind(null, held) : reserveCandidateQuota;
  const recordCandidate = held ? recordCandidateResultLocked.bind(null, held) : recordCandidateResult;
  const reserveAttempt = held ? reserveWriteAttemptLocked.bind(null, held) : reserveWriteAttempt;
  const recordOutcome = held ? recordWriteOutcomeLocked.bind(null, held) : recordWriteOutcome;
  let active: { candidate: SyntheticCandidate; attempted: boolean; attemptId?: string } | undefined;
  function authorization() {
    const state = loadHumanAuthorization(commonDir, approvalRef);
    if (state.approval.scope.kind !== scopeKind) throw new Error("COORDINATION_HUMAN_SCOPE_REQUIRED");
    return state;
  }
  function prepareWrite(candidate: SyntheticCandidate) {
    if (active) throw new Error("COORDINATION_WRITE_ALREADY_PREPARED");
    const state = authorization(); const intent = candidate.intent;
    const reserved = state.candidates.find((item) => item.result?.status === "created" && item.result.head === candidate.head &&
      item.transactionId === intent.transactionId && item.parentSha === intent.parentSha && item.treeSha === intent.treeSha &&
      hashObject(item.subject) === hashObject(intent.subject) && item.commitMetadataHash === intent.commitMetadataHash && item.objectDirectory === intent.objectDirectory);
    if (!reserved) throw new Error("HUMAN_CANDIDATE_UNPROVEN");
    assertCandidate?.(reserved); active = { candidate, attempted: false };
    return (result: CoordinationWriteResult | SyntheticWriteResult) => {
      const finished = active; if (result.applied || result.error) active = undefined;
      if (!finished?.attemptId) return; // A pre-dispatch gate is not a network outcome.
      const pushed = result.pushed ? coordinationPushOutcome(result.pushed, finished.candidate.head, finished.candidate.ref) : "unknown";
      const status = result.applied && pushed === "updated" ? "applied" : pushed === "rejected" || pushed === "not-performed" ? "rejected" : "unknown";
      const push = result.pushed ? { status: result.pushed.status, stdout: result.pushed.stdout, error: result.pushed.error } : undefined;
      recordOutcome(commonDir, approvalRef, { attemptId: finished.attemptId, status, push, evidenceHash: hashObject(result) });
    };
  }
  return {
    beforeCommit(intent: CoordinationCommitIntent) {
      authorization();
      assertCandidate?.(intent);
      const reserved = reserveCandidate(commonDir, approvalRef, observeBinding(), intent, refreshClock());
      return (head: string | null) => recordCandidate(commonDir, approvalRef, {
        candidateId: reserved.candidateId, status: head === null ? "unknown" : "created", head,
        evidenceHash: hashObject({ candidateId: reserved.candidateId, intent, head }),
      });
    },
    beforePush(candidate: CoordinationCandidate) {
      const state = authorization();
      const reserved = state.candidates.find((item) => item.result?.status === "created" && item.result.head === candidate.controlSha &&
        item.transactionId === candidate.record.transactionId && item.parentSha === candidate.expectedControlSha && item.treeSha === candidate.treeSha &&
        item.subject.kind === "coordination-record" && item.subject.workItem === candidate.record.workItem && item.subject.recordHash === candidate.record.recordHash && item.objectDirectory === candidate.objectDirectory);
      if (!reserved) throw new Error("HUMAN_CANDIDATE_UNPROVEN");
      return prepareWrite({ ref: candidate.controlRef, head: candidate.controlSha, expected: candidate.expectedControlSha, intent: reserved });
    },
    beforeSyntheticPush: prepareWrite,
    authorizeWrite(intent: CoordinationWriteIntent) {
      if (!active || active.attempted) throw new Error("COORDINATION_WRITE_NOT_PREPARED");
      const candidate = active.candidate; const observed = observeBinding();
      for (const field of ["repository", "repositoryId", "endpointHash", "credentialBindingHash", "credentialRef", "actor", "hostId"] as const) {
        if (intent[field] !== observed[field]) throw new Error("HUMAN_AUTHORIZATION_BINDING_MISMATCH");
      }
      if (intent.ref !== candidate.ref || intent.head !== candidate.head || intent.expected !== candidate.expected) throw new Error("HUMAN_WRITE_SCOPE_MISMATCH");
      assertCandidate?.(candidate.intent);
      // One callback invocation can authorize one dispatch. A restart recovers receipts, never this closure.
      active.attempted = true;
      const attempt = reserveAttempt(commonDir, approvalRef, observed, { transactionId: candidate.intent.transactionId,
        operation: intent.expected === null ? "create" : "cas", ref: intent.ref, head: intent.head, expected: intent.expected }, refreshClock());
      active.attemptId = attempt.attemptId;
      assertCandidate?.(candidate.intent);
    },
  };
}

/** Unknown writes are recovered from exact remote history, even after ticket expiry; never replayed. */
export function recoverHumanCoordinationWrite(commonDir: string, approvalRef: string, attemptId: string, store: GitCoordinationStore) {
  const state = loadHumanAuthorization(commonDir, approvalRef);
  if (!["qualification-run", "takeover"].includes(state.approval.scope.kind)) throw new Error("COORDINATION_HUMAN_SCOPE_REQUIRED");
  const attempt = state.attempts.find((item) => item.attemptId === attemptId);
  const candidate = state.candidates.find((item) => item.candidateId === attempt?.candidateId);
  if (!attempt || !candidate || candidate.subject.kind !== "coordination-record" || !attempt.head || candidate.result?.status !== "created" || candidate.result.head !== attempt.head || attempt.operation === "cleanup" || attempt.outcome?.status === "rejected") throw new Error("COORDINATION_RECOVERY_REQUIRED");
  const result = store.recoverRecordedCandidate({ controlSha: attempt.head, expectedControlSha: attempt.expected,
    treeSha: candidate.treeSha, recordHash: candidate.subject.recordHash, objectDirectory: candidate.objectDirectory });
  if (result.candidate.controlRef !== attempt.ref || result.candidate.record.repository !== state.approval.scope.binding.repository || result.candidate.record.repositoryId !== state.approval.scope.binding.repositoryId) throw new Error("COORDINATION_RECOVERY_REQUIRED");
  if (attempt.outcome?.status !== "applied") {
    if (!attempt.outcome?.push || coordinationPushOutcome(attempt.outcome.push, attempt.head, attempt.ref) !== "updated") throw new Error("COORDINATION_UPDATE_ATTRIBUTION_UNPROVEN");
    recordWriteOutcome(commonDir, approvalRef, { attemptId, status: "applied", push: attempt.outcome.push, evidenceHash: hashObject(result) });
  }
  return result;
}

/** Synthetic recovery consumes the original receipt and approved descriptor, never regenerates or pushes. */
export function recoverHumanSyntheticWrite(commonDir: string, approvalRef: string, attemptId: string, store: GitCoordinationStore,
  source: CoordinationTransport, held?: MutationLock) {
  const state = loadHumanAuthorization(commonDir, approvalRef); const scope = state.approval.scope;
  const attempt = state.attempts.find((value) => value.attemptId === attemptId);
  const intent = state.candidates.find((value) => value.candidateId === attempt?.candidateId);
  if (scope.kind === "takeover" || !attempt || !intent || intent.subject.kind === "coordination-record" || !attempt.head ||
      attempt.operation === "cleanup" || attempt.outcome?.status === "rejected" || intent.result?.status !== "created" || intent.result.head !== attempt.head ||
      source.repository !== scope.binding.repository || source.repositoryId !== scope.binding.repositoryId) throw new Error("COORDINATION_RECOVERY_REQUIRED");
  assertHumanCandidateScope(scope, intent);
  const candidate = { ref: attempt.ref, head: attempt.head, expected: attempt.expected, intent };
  const result = intent.subject.kind === "control-genesis" ? store.recoverBootstrap(candidate) :
    scope.kind === "qualification-run" && scope.synthetic ? recoverSourceFixture(source, scope.synthetic, candidate) : undefined;
  if (!result) throw new Error("COORDINATION_RECOVERY_REQUIRED");
  if (attempt.outcome?.status !== "applied") {
    if (!attempt.outcome?.push || coordinationPushOutcome(attempt.outcome.push, attempt.head, attempt.ref) !== "updated") return { ...result, status: "state-observed" as const };
    const record = held ? recordWriteOutcomeLocked.bind(null, held) : recordWriteOutcome;
    record(commonDir, approvalRef, { attemptId, status: "applied", push: attempt.outcome.push, evidenceHash: hashObject(result) });
  }
  return { ...result, status: "applied" as const };
}
