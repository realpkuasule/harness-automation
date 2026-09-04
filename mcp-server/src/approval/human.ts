import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { hashObject } from "../v2/fs.js";
import { acquireMutationLock, releaseMutationLock } from "../recovery/service.js";
import { appendLkgRecord, appendReceiptEvent, readLkgChain, readReceiptChain } from "../receipt/service.js";
import { validSemanticApprovalPacket, type SemanticApprovalPacket } from "./service.js";
import type { CoordinationClock } from "../coordination/clock.js";
import { harnessArtifactSchema } from "../repository/artifact.js";

const DOMAIN = "approval-human";
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const text = z.string().min(1).max(512).refine((value) => !/[\x00-\x1f\x7f]/u.test(value));
const timestamp = z.string().datetime();
const count = z.number().int().nonnegative().max(4096);
const ref = z.string().regex(/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u).refine((value) => !value.includes("..") && value.split("/").every((part) => part && !part.startsWith(".") && !part.endsWith(".") && !part.endsWith(".lock")));
const bindingSchema = z.object({
  commonDir: z.string().refine(isAbsolute),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u), repositoryId: text,
  endpointHash: digest, credentialBindingHash: digest, credentialRef: text, credentialPurpose: z.literal("git-transport"),
  actor: text, hostId: z.string().uuid(), configHash: digest,
  implementation: harnessArtifactSchema, runnerHash: digest,
}).strict();
const fields = { binding: bindingSchema, expiresAt: timestamp };
const expectation = z.object({ recordHash: digest, generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), owner: text, machine: text, lastObservedHead: sha, controlEpochDigest: digest }).strict();
export const humanScopeSchema = z.discriminatedUnion("kind", [
  z.object({ ...fields, kind: z.literal("qualification-run"), runId: text,
    refs: z.array(ref).min(1).max(32), operations: z.array(z.enum(["create", "cas"])).min(1).max(2),
    maxCommits: count, maxWriteAttempts: count, maxCleanupAttempts: count, cleanupExpiresAt: timestamp,
  }).strict(),
  z.object({ ...fields, kind: z.literal("production-enable"), configBeforeHash: digest.nullable(), configAfterHash: digest,
    controlRef: ref, genesisSha: sha, genesisTree: sha, qualificationEvidenceHash: digest, maxBootstrapAttempts: count,
  }).strict(),
  z.object({ ...fields, kind: z.literal("takeover"), workItem: z.string().regex(/^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9][0-9]*$/u), controlRef: ref, expectedControlSha: sha,
    expected: expectation, targetOwner: text, targetHostId: z.string().uuid(), newEpochDigest: digest,
    assetRiskHash: digest, transactionId: text, maxWriteAttempts: count,
  }).strict(),
]);
export type HumanScope = z.infer<typeof humanScopeSchema>;
export type HumanScopeBinding = z.infer<typeof bindingSchema>;
const approvalSchema = z.object({
  kind: z.literal("approved"), schemaVersion: z.literal("human-authorization/1.0"),
  packet: z.custom<SemanticApprovalPacket>(validSemanticApprovalPacket), scope: humanScopeSchema, scopeHash: digest,
  approvedBy: text, approvedAt: timestamp,
  source: z.object({ kind: z.literal("explicit-human"), messageHash: digest }).strict(),
}).strict();
const attemptSchema = z.object({
  attemptId: z.string().uuid(), transactionId: text, operation: z.enum(["create", "cas", "cleanup"]),
  candidateId: z.string().uuid().nullable(),
  ref, head: sha.nullable(), expected: sha.nullable(), reservedAt: timestamp,
}).strict();
const candidateSchema = z.object({
  candidateId: z.string().uuid(), transactionId: text, parentSha: sha.nullable(), treeSha: sha,
  recordHash: digest, commitMetadataHash: digest, objectDirectory: z.string().refine(isAbsolute), reservedAt: timestamp,
}).strict();
const candidateResultSchema = z.object({
  candidateId: z.string().uuid(), status: z.enum(["created", "failed", "unknown"]), head: sha.nullable(), evidenceHash: digest,
}).strict();
const outcomeSchema = z.object({
  attemptId: z.string().uuid(), status: z.enum(["applied", "rejected", "unknown"]), evidenceHash: digest,
}).strict();
const eventSchema = z.union([approvalSchema,
  z.object({ kind: z.literal("candidate-reserved"), candidate: candidateSchema }).strict(),
  z.object({ kind: z.literal("candidate-result"), result: candidateResultSchema }).strict(),
  z.object({ kind: z.literal("reserved"), attempt: attemptSchema }).strict(),
  z.object({ kind: z.literal("outcome"), outcome: outcomeSchema }).strict(),
  z.object({ kind: z.literal("revoked"), reason: text }).strict(),
]);
type Approval = z.infer<typeof approvalSchema>;
type Attempt = z.infer<typeof attemptSchema>;
type Outcome = z.infer<typeof outcomeSchema>;
type Candidate = z.infer<typeof candidateSchema>;
type CandidateResult = z.infer<typeof candidateResultSchema>;
type HumanEvent = z.infer<typeof eventSchema>;
export interface HumanAuthorization {
  approval: Approval; attempts: Array<Attempt & { outcome?: Outcome }>;
  candidates: Array<Candidate & { result?: CandidateResult }>; revoked: boolean;
}

function checkScope(scope: HumanScope): void {
  if (scope.kind === "qualification-run" && (new Set(scope.refs).size !== scope.refs.length || new Set(scope.operations).size !== scope.operations.length ||
      scope.maxWriteAttempts < 1 || scope.maxCommits < 1 || Date.parse(scope.cleanupExpiresAt) < Date.parse(scope.expiresAt))) throw new Error("HUMAN_SCOPE_INVALID");
  if (scope.kind === "takeover" && (!scope.workItem.startsWith(`github:${scope.binding.repository}#`) ||
      !Number.isSafeInteger(Number(scope.workItem.split("#")[1])) ||
      scope.targetOwner !== scope.binding.actor || scope.targetHostId !== scope.binding.hostId || scope.maxWriteAttempts < 1)) throw new Error("HUMAN_SCOPE_INVALID");
  if (scope.kind === "production-enable" && scope.configAfterHash !== scope.binding.configHash) throw new Error("HUMAN_SCOPE_INVALID");
}

function packetApprovesScope(approval: Approval): boolean {
  const action = approval.packet.actions[0];
  return approval.packet.risk === "protected" && approval.packet.actions.length === 1 && action.id === approval.scope.kind &&
    action.kind === "permission-change" && action.protected === true && approval.packet.inputHash === approval.scopeHash;
}

/** Read-only: an unindexed durable tail reports recovery, never silently grants or loses a write attempt. */
export function loadHumanAuthorization(commonDir: string, approvalRef: string): HumanAuthorization {
  return history(commonDir, approvalRef, false);
}
function history(commonDir: string, approvalRef: string, repairTail: boolean): HumanAuthorization {
  if (!digest.safeParse(approvalRef).success) throw new Error("HUMAN_APPROVAL_REQUIRED");
  const key = { root: commonDir, domain: DOMAIN, transactionId: approvalRef };
  const events = readReceiptChain(key);
  if (!events.length) throw new Error("HUMAN_APPROVAL_REQUIRED");
  let approval: Approval | undefined; const attempts: HumanAuthorization["attempts"] = []; const candidates: HumanAuthorization["candidates"] = []; let revoked = false;
  for (const item of events) {
    const parsed = eventSchema.safeParse(item.snapshot); if (!parsed.success) throw new Error("HUMAN_HISTORY_INVALID");
    const event = parsed.data;
    if (event.kind === "approved") {
      if (approval || item.sequence !== 1 || event.packet.packetHash !== approvalRef || event.scopeHash !== hashObject(event.scope) ||
          event.scope.binding.commonDir !== realpathSync(commonDir) ||
          !packetApprovesScope(event) || Date.parse(event.approvedAt) >= Date.parse(event.scope.expiresAt)) throw new Error("HUMAN_HISTORY_INVALID");
      checkScope(event.scope); approval = event;
    } else {
      if (!approval) throw new Error("HUMAN_HISTORY_INVALID");
      if (event.kind === "candidate-reserved") {
        if (revoked || candidates.some((candidate) => candidate.candidateId === event.candidate.candidateId)) throw new Error("HUMAN_HISTORY_INVALID");
        checkCandidateQuota(approval.scope, attempts, candidates); candidates.push(event.candidate);
      } else if (event.kind === "candidate-result") {
        const candidate = candidates.find((value) => value.candidateId === event.result.candidateId);
        if (!candidate || (candidate.result && candidate.result.status !== "unknown") || (event.result.status === "created") !== (event.result.head !== null)) throw new Error("HUMAN_HISTORY_INVALID");
        candidate.result = event.result;
      } else if (event.kind === "reserved") {
        if (revoked || attempts.some((attempt) => attempt.attemptId === event.attempt.attemptId)) throw new Error("HUMAN_HISTORY_INVALID");
        checkAttempt(approval.scope, attempts, candidates, event.attempt); attempts.push(event.attempt);
      } else if (event.kind === "outcome") {
        const attempt = attempts.find((value) => value.attemptId === event.outcome.attemptId);
        if (!attempt || (attempt.outcome && attempt.outcome.status !== "unknown")) throw new Error("HUMAN_HISTORY_INVALID");
        attempt.outcome = event.outcome;
      } else { if (revoked) throw new Error("HUMAN_HISTORY_INVALID"); revoked = true; }
    }
  }
  if (!approval) throw new Error("HUMAN_HISTORY_INVALID");
  const records = readLkgChain({ root: commonDir, domain: DOMAIN }).filter((record) => record.transactionId === approvalRef);
  if (records.length > events.length || records.some((record, index) => record.receiptEventHash !== events[index].eventHash || record.planHash !== approval!.packet.planHash || record.observedHash !== events[index].snapshotHash)) throw new Error("HUMAN_HISTORY_INVALID");
  if (records.length !== events.length) {
    if (!repairTail || records.length !== events.length - 1) throw new Error("HUMAN_AUTHORIZATION_RECOVERY_REQUIRED");
    const tail = events.at(-1)!;
    appendLkgRecord({ ...key, appliedReceiptEventHash: tail.eventHash, planHash: approval.packet.planHash, observedHash: tail.snapshotHash });
  }
  return { approval, attempts, candidates, revoked };
}
function append(commonDir: string, packet: SemanticApprovalPacket, snapshot: HumanEvent): void {
  const key = { root: commonDir, domain: DOMAIN, transactionId: packet.packetHash };
  const event = appendReceiptEvent({ ...key, snapshot });
  appendLkgRecord({ ...key, appliedReceiptEventHash: event.eventHash, planHash: packet.planHash, observedHash: event.snapshotHash });
}
function locked<T>(commonDir: string, operation: () => T): T {
  const lock = acquireMutationLock({ projectDir: commonDir, commonDir, repository: true });
  try { return operation(); } finally { releaseMutationLock(lock); }
}

/** Invoked by the explicit approval command; a Reviewer verdict or caller-created JSON is not an approvalRef. */
export function recordHumanApproval(commonDir: string, input: Omit<Approval, "kind" | "schemaVersion" | "scopeHash">, approvedPlanHash: string): string {
  const approval = approvalSchema.parse({ ...input, kind: "approved", schemaVersion: "human-authorization/1.0", scopeHash: hashObject(input.scope) });
  checkScope(approval.scope);
  if (approvedPlanHash !== approval.packet.planHash || !packetApprovesScope(approval) || approval.scope.binding.commonDir !== realpathSync(commonDir) || Date.parse(approval.approvedAt) >= Date.parse(approval.scope.expiresAt)) throw new Error("HUMAN_APPROVAL_REQUIRED");
  return locked(commonDir, () => {
    const existing = readReceiptChain({ root: commonDir, domain: DOMAIN, transactionId: approval.packet.packetHash });
    if (existing.length) {
      const current = history(commonDir, approval.packet.packetHash, true);
      if (hashObject(current.approval) !== hashObject(approval) || current.revoked) throw new Error("HUMAN_APPROVAL_ALREADY_RECORDED");
    } else append(commonDir, approval.packet, approval);
    return approval.packet.packetHash;
  });
}

function checkCandidateQuota(scope: HumanScope, attempts: HumanAuthorization["attempts"], candidates: HumanAuthorization["candidates"]): void {
  if (attempts.some((attempt) => !attempt.outcome || attempt.outcome.status === "unknown") || candidates.some((candidate) => !candidate.result || candidate.result.status === "unknown")) throw new Error("HUMAN_WRITE_OUTCOME_UNRESOLVED");
  const maximum = scope.kind === "qualification-run" ? scope.maxCommits : scope.kind === "production-enable" ? 1 : scope.maxWriteAttempts;
  if (candidates.length >= maximum) throw new Error("HUMAN_COMMIT_BUDGET_EXHAUSTED");
}

/** Must precede commit-tree, including candidates that lose a CAS or never get dispatched. */
export function reserveCandidateQuota(commonDir: string, approvalRef: string, observed: HumanScopeBinding,
  intent: Omit<Candidate, "candidateId" | "reservedAt">, clock: CoordinationClock): Candidate {
  return locked(commonDir, () => {
    const state = history(commonDir, approvalRef, true);
    if (state.revoked || hashObject(bindingSchema.parse(observed)) !== hashObject(state.approval.scope.binding)) throw new Error("HUMAN_AUTHORIZATION_BINDING_MISMATCH");
    checkCandidateQuota(state.approval.scope, state.attempts, state.candidates);
    const bounds = clock.requireBefore(state.approval.scope.expiresAt);
    const candidate = candidateSchema.parse({ ...intent, candidateId: randomUUID(), reservedAt: new Date(Math.floor(bounds.lowerMs)).toISOString() });
    append(commonDir, state.approval.packet, { kind: "candidate-reserved", candidate });
    clock.requireBefore(state.approval.scope.expiresAt); return candidate;
  });
}

export function recordCandidateResult(commonDir: string, approvalRef: string, input: CandidateResult): void {
  const result = candidateResultSchema.parse(input);
  if ((result.status === "created") !== (result.head !== null)) throw new Error("HUMAN_CANDIDATE_RESULT_INVALID");
  locked(commonDir, () => {
    const state = history(commonDir, approvalRef, true); const candidate = state.candidates.find((value) => value.candidateId === result.candidateId);
    if (!candidate) throw new Error("HUMAN_CANDIDATE_UNKNOWN");
    if (candidate.result && hashObject(candidate.result) === hashObject(result)) return;
    if (candidate.result && candidate.result.status !== "unknown") throw new Error("HUMAN_CANDIDATE_RESULT_FINAL");
    append(commonDir, state.approval.packet, { kind: "candidate-result", result });
  });
}

function checkAttempt(scope: HumanScope, attempts: HumanAuthorization["attempts"], candidates: HumanAuthorization["candidates"], request: Attempt): void {
  const cleanup = request.operation === "cleanup";
  if (cleanup ? request.head !== null || request.expected === null : request.head === null || (request.operation === "create" ? request.expected !== null : request.expected === null)) throw new Error("HUMAN_WRITE_SCOPE_MISMATCH");
  const unresolved = attempts.filter((attempt) => !attempt.outcome || attempt.outcome.status === "unknown");
  // ponytail: one in-flight attempt per authorization; parallel clients use separately bounded authorizations.
  if (unresolved.length) throw new Error("HUMAN_WRITE_OUTCOME_UNRESOLVED");
  if (candidates.some((candidate) => !candidate.result || candidate.result.status === "unknown")) throw new Error("HUMAN_WRITE_OUTCOME_UNRESOLVED");
  if (cleanup ? request.candidateId !== null : !candidates.some((candidate) => candidate.candidateId === request.candidateId && candidate.transactionId === request.transactionId && candidate.result?.status === "created" && candidate.result.head === request.head)) throw new Error("HUMAN_CANDIDATE_UNPROVEN");
  if (scope.kind === "qualification-run") {
    if (!scope.refs.includes(request.ref) || (!cleanup && !scope.operations.includes(request.operation as "create" | "cas"))) throw new Error("HUMAN_WRITE_SCOPE_MISMATCH");
    const used = attempts.filter((attempt) => (attempt.operation === "cleanup") === cleanup).length;
    if (used >= (cleanup ? scope.maxCleanupAttempts : scope.maxWriteAttempts)) throw new Error("HUMAN_WRITE_BUDGET_EXHAUSTED");
    if (cleanup) {
      const owned = attempts.filter((attempt) => attempt.ref === request.ref && attempt.outcome?.status === "applied").at(-1);
      if (!owned || owned.head !== request.expected) throw new Error("HUMAN_CLEANUP_OWNERSHIP_UNPROVEN");
    }
  } else if (scope.kind === "production-enable") {
    if (cleanup || request.operation !== "create" || request.ref !== scope.controlRef || request.head !== scope.genesisSha) throw new Error("HUMAN_WRITE_SCOPE_MISMATCH");
    if (attempts.length >= scope.maxBootstrapAttempts) throw new Error("HUMAN_WRITE_BUDGET_EXHAUSTED");
  } else {
    if (cleanup || request.operation !== "cas" || request.ref !== scope.controlRef || request.expected !== scope.expectedControlSha || request.transactionId !== scope.transactionId) throw new Error("HUMAN_WRITE_SCOPE_MISMATCH");
    if (attempts.length >= scope.maxWriteAttempts || attempts.some((attempt) => attempt.outcome?.status === "applied")) throw new Error("HUMAN_WRITE_BUDGET_EXHAUSTED");
  }
}

/** Each return permits one dispatch only; retries reserve a new ID, and crashes never refund a reservation. */
export function reserveWriteAttempt(commonDir: string, approvalRef: string, observed: HumanScopeBinding,
  request: Omit<Attempt, "attemptId" | "reservedAt" | "candidateId"> & { attemptId?: string; candidateId?: string | null }, clock: CoordinationClock): Attempt {
  return locked(commonDir, () => {
    const state = history(commonDir, approvalRef, true);
    if (state.revoked || hashObject(bindingSchema.parse(observed)) !== hashObject(state.approval.scope.binding)) throw new Error("HUMAN_AUTHORIZATION_BINDING_MISMATCH");
    const expiresAt = request.operation === "cleanup" && state.approval.scope.kind === "qualification-run" ? state.approval.scope.cleanupExpiresAt : state.approval.scope.expiresAt;
    const bounds = clock.requireBefore(expiresAt);
    const candidateId = request.candidateId ?? (request.operation === "cleanup" ? null : state.candidates.find((candidate) => candidate.result?.head === request.head && candidate.transactionId === request.transactionId)?.candidateId ?? null);
    const attempt = attemptSchema.parse({ ...request, candidateId, attemptId: request.attemptId ?? randomUUID(), reservedAt: new Date(Math.floor(bounds.lowerMs)).toISOString() });
    if (state.attempts.some((value) => value.attemptId === attempt.attemptId)) throw new Error("HUMAN_WRITE_ATTEMPT_ALREADY_RESERVED");
    checkAttempt(state.approval.scope, state.attempts, state.candidates, attempt);
    append(commonDir, state.approval.packet, { kind: "reserved", attempt });
    clock.requireBefore(expiresAt); return attempt;
  });
}

/** Evidence comes from the fixed operation/readback path; CLI never accepts a caller's Applied boolean. */
export function recordWriteOutcome(commonDir: string, approvalRef: string, input: Outcome): void {
  const outcome = outcomeSchema.parse(input);
  locked(commonDir, () => {
    const state = history(commonDir, approvalRef, true); const attempt = state.attempts.find((value) => value.attemptId === outcome.attemptId);
    if (!attempt) throw new Error("HUMAN_WRITE_ATTEMPT_UNKNOWN");
    if (attempt.outcome && hashObject(attempt.outcome) === hashObject(outcome)) return;
    if (attempt.outcome && attempt.outcome.status !== "unknown") throw new Error("HUMAN_WRITE_OUTCOME_FINAL");
    append(commonDir, state.approval.packet, { kind: "outcome", outcome });
  });
}

export function revokeHumanAuthorization(commonDir: string, approvalRef: string, reason: string): void {
  const event = eventSchema.parse({ kind: "revoked", reason });
  locked(commonDir, () => { const state = history(commonDir, approvalRef, true); if (!state.revoked) append(commonDir, state.approval.packet, event); });
}
