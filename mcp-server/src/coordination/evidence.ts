import { loadHumanAuthorizationFamily } from "../approval/human.js";
import { readLkgChain, readReceiptChain } from "../receipt/service.js";
import { acquireMutationLock, assertMutationLock, releaseMutationLock, type MutationLock } from "../recovery/service.js";
import { resolveRepositoryContext } from "../repository/git.js";
import { hashObject } from "../v2/fs.js";
import { observeCoordinationBinding } from "./runtime.js";
import { loadCoordinationConfig } from "./service.js";
import { loadQualificationManifest, validateQualificationManifest, type QualificationManifest } from "./manifest.js";
import { coordinationDeleteOutcome, coordinationPushOutcome } from "./push_result.js";
import { requiredQualificationCases } from "./qualification_cases.js";

function readFamily(commonDir: string, approvalRef: string) {
  const family = loadHumanAuthorizationFamily(commonDir, approvalRef);
  const authorizations = [{ approvalRef, state: family.parent }, ...family.children];
  const lkg = readLkgChain({ root: commonDir, domain: "approval-human" });
  const chains = authorizations.map((item) => ({ ...item,
    receipts: readReceiptChain({ root: commonDir, domain: "approval-human", transactionId: item.approvalRef }),
  }));
  return { chains, lkg, heads: { lkg: lkg.at(-1)?.recordHash ?? null,
    receipts: Object.fromEntries(chains.map((item) => [item.approvalRef, item.receipts.at(-1)!.eventHash])) } };
}
type ClientFacts = ReturnType<typeof readFamily> & {
  projectRoot: string; approvalRef: string; manifestHash: string; clientId: string; observedAt: string;
  origin: { kind: "native-local-loader"; pid: number; platform: string; arch: string; node: string; hostId: string };
};
export type VerifiedClientEvidence = Readonly<{ kind: "native-local-client-evidence" }>;
export type EvidenceLock = { clientId: string; lock: MutationLock };
const verified = new WeakMap<VerifiedClientEvidence, ClientFacts>();

/** Actual native binding and full local receipt/LKG validation. This does not attest process drain or GitHub qualification. */
export function collectClientEvidence(projectRoot: string, approvalRef: string, held?: MutationLock): VerifiedClientEvidence {
  const context = resolveRepositoryContext(projectRoot); const lock = held ?? acquireMutationLock(context);
  try {
    assertMutationLock(context, lock);
    const facts = readFamily(context.commonDir, approvalRef); const scope = facts.chains[0].state.approval.scope;
    if (scope.kind !== "qualification-run" || !scope.manifest) throw new Error("QUALIFICATION_MANIFEST_REQUIRED");
    const remote = loadCoordinationConfig(context.projectDir)?.remote ?? "origin";
    const observe = () => observeCoordinationBinding(context.projectDir, remote, scope.binding.repositoryId, scope.binding.credentialRef);
    const actual = observe();
    if (hashObject(actual) !== hashObject(scope.binding)) throw new Error("HUMAN_AUTHORIZATION_BINDING_MISMATCH");
    loadQualificationManifest(context.commonDir, scope.manifest.manifestHash);
    if (hashObject(readFamily(context.commonDir, approvalRef)) !== hashObject(facts) || hashObject(observe()) !== hashObject(actual)) throw new Error("QUALIFICATION_EVIDENCE_DRIFT");
    assertMutationLock(context, lock);
    const handle: VerifiedClientEvidence = Object.freeze({ kind: "native-local-client-evidence" });
    verified.set(handle, { ...facts, projectRoot: context.projectDir, approvalRef, ...scope.manifest, observedAt: new Date().toISOString(),
      origin: { kind: "native-local-loader", pid: process.pid, platform: process.platform, arch: process.arch, node: process.version, hostId: actual.hostId } });
    return handle;
  } finally { if (!held) releaseMutationLock(lock); }
}

/** A serialized projection is useful evidence, but cannot be imported as a verified handle. */
export function readVerifiedClientEvidence(handle: VerifiedClientEvidence): ClientFacts {
  const facts = verified.get(handle);
  if (!facts || facts.origin.pid !== process.pid) throw new Error("QUALIFICATION_EVIDENCE_ORIGIN_UNPROVEN");
  return structuredClone(facts);
}

/** Re-observe under the existing lock before consuming previously collected facts. No tail repair or new authority. */
export function recheckClientEvidence(handle: VerifiedClientEvidence, held?: MutationLock): void {
  const before = readVerifiedClientEvidence(handle);
  const after = readVerifiedClientEvidence(collectClientEvidence(before.projectRoot, before.approvalRef, held));
  if (before.manifestHash !== after.manifestHash || before.clientId !== after.clientId || hashObject(before.heads) !== hashObject(after.heads)) throw new Error("QUALIFICATION_EVIDENCE_DRIFT");
}

/** Aggregates observed facts only; absent clients and missing execution evidence are never normalized to zero/PASS. */
export function evaluateQualificationRun(input: QualificationManifest, evidence: VerifiedClientEvidence[], held?: EvidenceLock) {
  const manifest = validateQualificationManifest(input); const clients = evidence.map(readVerifiedClientEvidence);
  if (clients.some((client) => client.manifestHash !== manifest.manifestHash || !manifest.clients.some((item) => item.clientId === client.clientId)) ||
      new Set(clients.map((client) => client.clientId)).size !== clients.length) throw new Error("QUALIFICATION_CLIENT_EVIDENCE_MISMATCH");
  evidence.forEach((handle) => recheckClientEvidence(handle, readVerifiedClientEvidence(handle).clientId === held?.clientId ? held.lock : undefined));
  const blockers: Array<{ code: string; clientId?: string; approvalRef?: string; attemptId?: string; candidateId?: string }> = [];
  for (const client of manifest.clients) if (!clients.some((item) => item.clientId === client.clientId)) blockers.push({ code: "QUALIFICATION_CLIENT_MISSING", clientId: client.clientId });
  let commits = 0; let writeAttempts = 0; let cleanupAttempts = 0;
  for (const client of clients) {
    if (!client.chains[0].state.writesClosed) blockers.push({ code: "HUMAN_QUALIFICATION_WRITES_OPEN", clientId: client.clientId });
    for (const { approvalRef, state } of client.chains) {
      commits += state.candidates.length;
      for (const candidate of state.candidates) if (!candidate.result || candidate.result.status === "unknown") blockers.push({ code: "HUMAN_CANDIDATE_UNRESOLVED", clientId: client.clientId, approvalRef, candidateId: candidate.candidateId });
      for (const attempt of state.attempts) {
        if (attempt.operation === "cleanup") cleanupAttempts++; else writeAttempts++;
        if (!attempt.outcome || attempt.outcome.status === "unknown") blockers.push({ code: "HUMAN_WRITE_OUTCOME_UNRESOLVED", clientId: client.clientId, approvalRef, attemptId: attempt.attemptId });
        else if (attempt.operation !== "cleanup" && attempt.outcome.status === "applied" &&
            (!attempt.outcome.push || !attempt.head || coordinationPushOutcome(attempt.outcome.push, attempt.head, attempt.ref) !== "updated")) {
          blockers.push({ code: "COORDINATION_UPDATE_ATTRIBUTION_UNPROVEN", clientId: client.clientId, approvalRef, attemptId: attempt.attemptId });
        }
        else if (attempt.operation === "cleanup" && attempt.outcome.status === "applied" &&
            (!attempt.outcome.push || coordinationDeleteOutcome(attempt.outcome.push, attempt.ref) !== "deleted")) {
          blockers.push({ code: "COORDINATION_DELETE_ATTRIBUTION_UNPROVEN", clientId: client.clientId, approvalRef, attemptId: attempt.attemptId });
        }
      }
    }
  }
  if (commits > manifest.maxCommits || writeAttempts > manifest.maxWriteAttempts || cleanupAttempts > manifest.maxCleanupAttempts) throw new Error("QUALIFICATION_GLOBAL_BUDGET_EXCEEDED");
  // Receipt validity is not process supervision, authenticated remote history or execution of a case's sub-assertions.
  blockers.push({ code: "QUALIFICATION_RUNNER_DRAIN_UNPROVEN" }, { code: "QUALIFICATION_REMOTE_HISTORY_UNPROVEN" });
  return { manifestHash: manifest.manifestHash, status: "incomplete" as const, qualified: false, topology: "LOCAL" as const,
    observedClients: clients.map((client) => client.clientId), counts: { commits, writeAttempts, cleanupAttempts },
    countsComplete: clients.length === manifest.clients.length, requiredCases: requiredQualificationCases(manifest.requiredCases), blockers };
}
