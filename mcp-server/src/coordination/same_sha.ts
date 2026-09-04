import { hashObject } from "../v2/fs.js";
import { collectClientEvidence, readVerifiedClientEvidence } from "./evidence.js";
import { loadQualificationManifest } from "./manifest.js";
import { coordinationPushOutcome } from "./push_result.js";
import { createQualificationRuntime } from "./runtime.js";

/** Actual local receipt facts, not an imported worker verdict. No case PASS or cleanup authority is issued here. */
export function sameShaClientFacts(projectRoot: string, approvalRef: string, phase: "prepared" | "updated" | "no-op") {
  const facts = readVerifiedClientEvidence(collectClientEvidence(projectRoot, approvalRef));
  const state = facts.chains[0].state; const scope = state.approval.scope;
  const manifest = loadQualificationManifest(scope.binding.commonDir, facts.manifestHash);
  const negative = manifest.sameShaPublicationNegativeControl;
  if (scope.kind !== "qualification-run" || manifest.execution?.kind !== "local-same-sha-publication/1" || !negative ||
      facts.chains.length !== 1 || state.candidates.length !== 1 || state.revoked) throw new Error("QUALIFICATION_SAME_SHA_EVIDENCE_INVALID");
  const publication = negative.publications.find((item) => item.clientId === facts.clientId);
  const plan = manifest.synthetic.objects[0]; const candidate = state.candidates[0];
  if (!publication || candidate.subject.kind !== "control-genesis" || candidate.subject.fixtureId !== negative.fixtureId ||
      candidate.subject.objectPlanHash !== plan.objectPlanHash || candidate.transactionId !== publication.transactionId ||
      candidate.parentSha !== null || candidate.treeSha !== plan.treeSha || candidate.commitMetadataHash !== plan.commitBytesSha256 ||
      candidate.result?.status !== "created" || candidate.result.head !== plan.commitSha) throw new Error("QUALIFICATION_SAME_SHA_EVIDENCE_INVALID");
  const attempt = state.attempts[0];
  if (phase === "prepared") {
    if (state.attempts.length || state.writesClosed) throw new Error("QUALIFICATION_SAME_SHA_EVIDENCE_INVALID");
  } else if (state.attempts.length !== 1 || !attempt || attempt.candidateId !== candidate.candidateId ||
      attempt.transactionId !== publication.transactionId || attempt.ref !== negative.ref || attempt.expected !== negative.expected ||
      attempt.head !== plan.commitSha || attempt.operation !== "create" || !attempt.outcome?.push ||
      attempt.outcome.status !== (phase === "updated" ? "applied" : "rejected") ||
      coordinationPushOutcome(attempt.outcome.push, plan.commitSha, negative.ref) !== (phase === "updated" ? "updated" : "not-performed")) throw new Error("QUALIFICATION_SAME_SHA_EVIDENCE_INVALID");
  return { manifestHash: manifest.manifestHash, clientId: facts.clientId, approvalRef, ref: negative.ref, head: plan.commitSha, expected: negative.expected,
    candidateId: candidate.candidateId, attemptId: attempt?.attemptId ?? null, push: attempt?.outcome?.push ?? null,
    writesClosed: state.writesClosed, heads: facts.heads };
}

/** Called only by the fixed read-only worker role. Rejected recovery must fail before any verdict/counter change. */
export function verifyRejectedRestart(projectRoot: string, approvalRef: string, attemptId: string) {
  const before = sameShaClientFacts(projectRoot, approvalRef, "no-op");
  if (!before.writesClosed || before.attemptId !== attemptId) throw new Error("QUALIFICATION_RESTART_EVIDENCE_INVALID");
  const runtime = createQualificationRuntime(projectRoot, approvalRef, before.ref);
  let rejected = false;
  try { runtime.recoverSynthetic(attemptId); }
  catch (error) { if (!(error instanceof Error) || error.message !== "COORDINATION_RECOVERY_REQUIRED") throw error; rejected = true; }
  const after = sameShaClientFacts(projectRoot, approvalRef, "no-op");
  if (!rejected || hashObject(before) !== hashObject(after)) throw new Error("QUALIFICATION_RESTART_EVIDENCE_INVALID");
  return { before, after, result: "rejected-unchanged" as const };
}
