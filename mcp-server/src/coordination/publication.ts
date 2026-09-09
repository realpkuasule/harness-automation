import { rmSync } from "node:fs";
import type { GitCommandResult } from "../repository/git.js";
import { objectDirectory, objectGit, validateSyntheticObject } from "./objects.js";
import { approvedSyntheticPublication, syntheticObjectSchema, validateSourceFixtureGraph, type SyntheticObjectPlan, type SyntheticPublication, type SyntheticScope } from "./synthetic.js";
import type { CoordinationCommitGuard, CoordinationCommitIntent, CoordinationTransport, WriteRecorder } from "./store.js";
import { requireCoordinationPush } from "./push_result.js";

export interface SyntheticCandidate {
  ref: string; head: string; expected: string | null; intent: CoordinationCommitIntent;
}
export interface SyntheticApplied { candidate: SyntheticCandidate; observedHead: string; }
export interface SyntheticWriteResult { candidate: SyntheticCandidate; pushed?: GitCommandResult; applied?: SyntheticApplied; error?: string; }
export type SyntheticPushGuard = (candidate: SyntheticCandidate) => WriteRecorder<SyntheticWriteResult>;
export type SyntheticPreparation = Readonly<{ kind: "prepared-synthetic-publication" }>;
const preparations = new WeakMap<SyntheticPreparation, { candidate: SyntheticCandidate; plan: SyntheticObjectPlan;
  transport: CoordinationTransport; beforePush: SyntheticPushGuard; readback: (candidate: SyntheticCandidate) => SyntheticApplied; consumed: boolean }>();

/** Preparation owns no dispatch lock or network attempt; the original ticket still governs the later send. */
export function prepareSyntheticPublication(transport: CoordinationTransport, input: SyntheticObjectPlan, publication: SyntheticPublication,
  beforeCommit: CoordinationCommitGuard, beforePush: SyntheticPushGuard, validateParent: (directory: string) => void,
  readback: (candidate: SyntheticCandidate) => SyntheticApplied): SyntheticPreparation {
  const plan = syntheticObjectSchema.parse(input);
  if (publication.fixtureId !== plan.metadata.objectId || plan.kind === "control-genesis" && publication.expected !== null) throw new Error("HUMAN_SYNTHETIC_SCOPE_REQUIRED");
  if (transport.readRef(publication.ref) !== publication.expected) throw new Error("COORDINATION_CAS_CONFLICT");
  const directory = objectDirectory(); let retain = false;
  try {
    if (plan.parents[0]) { transport.fetch(directory, plan.parents[0]); validateParent(directory); }
    const intent: CoordinationCommitIntent = { transactionId: publication.transactionId, parentSha: plan.parents[0] ?? null, treeSha: plan.treeSha,
      subject: { kind: plan.kind, fixtureId: plan.metadata.objectId, objectPlanHash: plan.objectPlanHash }, objectDirectory: directory, commitMetadataHash: plan.commitBytesSha256 };
    const recordCreation = beforeCommit(intent); retain = true;
    try {
      if (objectGit(directory, ["hash-object", "-w", "-t", "tree", "--stdin"], "").trim() !== plan.treeSha ||
          objectGit(directory, ["hash-object", "-w", "-t", "commit", "--stdin"], plan.commitText).trim() !== plan.commitSha) throw new Error("SYNTHETIC_OBJECT_MISMATCH");
      validateSyntheticObject(directory, plan);
    } catch (error) { recordCreation(null); throw error; }
    recordCreation(plan.commitSha);
    const candidate: SyntheticCandidate = { ref: publication.ref, head: plan.commitSha, expected: publication.expected, intent };
    const handle: SyntheticPreparation = Object.freeze({ kind: "prepared-synthetic-publication" });
    preparations.set(handle, { candidate, plan, transport, beforePush, readback, consumed: false }); return handle;
  } finally { if (!retain) rmSync(directory, { recursive: true, force: true }); }
}

/** No caller-supplied candidate, transport, scope or replay. Git still decides the exact-old-SHA condition. */
export function dispatchSyntheticPublication(handle: SyntheticPreparation): SyntheticApplied {
  const prepared = preparations.get(handle);
  if (!prepared || prepared.consumed) throw new Error("SYNTHETIC_PREPARATION_UNPROVEN");
  prepared.consumed = true;
  const { candidate, plan, transport, beforePush, readback } = prepared; const directory = candidate.intent.objectDirectory; let retain = true;
  try {
    validateSyntheticObject(directory, plan);
    const recordWrite = beforePush(candidate);
    let failure: { error: unknown } | undefined;
    try {
      let pushed: GitCommandResult | undefined; let applied: SyntheticApplied;
      try {
        pushed = transport.push(directory, candidate.head, candidate.ref, candidate.expected);
        requireCoordinationPush(pushed, candidate.head, candidate.ref);
        recordWrite({ candidate, pushed });
        applied = readback(candidate);
      } catch (error) {
        const code = error instanceof Error ? error.message : "COORDINATION_WRITE_OUTCOME_UNKNOWN";
        recordWrite({ candidate, pushed, error: code });
        if (code === "COORDINATION_CAS_CONFLICT" || code === "COORDINATION_CAS_NOT_PERFORMED") retain = false;
        throw error;
      }
      recordWrite({ candidate, pushed, applied }); retain = false; return applied;
    } catch (error) { failure = { error }; throw error; }
    finally {
      try { recordWrite.finish?.(); }
      catch (error) { if (failure) throw new AggregateError([failure.error, error], "COORDINATION_WRITE_AND_RELEASE_FAILED"); throw error; }
    }
  } finally { if (!retain) rmSync(directory, { recursive: true, force: true }); }
}

/** Ordinary publications use the same two boundaries consecutively, without a scheduling callback. */
export function publishSyntheticObject(...args: Parameters<typeof prepareSyntheticPublication>): SyntheticApplied {
  return dispatchSyntheticPublication(prepareSyntheticPublication(...args));
}

export function validateSourceAncestry(directory: string, plans: SyntheticObjectPlan[], head: string): string[] {
  const bySha = new Map(plans.map((plan) => [plan.commitSha, plan])); const history: string[] = [];
  let current: string | undefined = head;
  while (current) {
    const plan = bySha.get(current); if (!plan) throw new Error("SYNTHETIC_SOURCE_GRAPH_INVALID");
    validateSyntheticObject(directory, plan); history.push(current); current = plan.parents[0];
  }
  return history;
}

/** Read-only recovery accepts only the approved source graph, never project or control ancestry. */
export function recoverSourceFixture(transport: CoordinationTransport, scope: SyntheticScope, candidate: SyntheticCandidate): SyntheticApplied {
  const { plan, publication } = approvedSyntheticPublication(scope, candidate.intent.subject.kind === "source-fixture" ? candidate.intent.subject.fixtureId : "");
  if (plan.kind !== "source-fixture" || candidate.ref !== publication.ref || candidate.head !== plan.commitSha || candidate.expected !== publication.expected ||
      candidate.intent.transactionId !== publication.transactionId || candidate.intent.subject.kind !== plan.kind ||
      candidate.intent.subject.objectPlanHash !== plan.objectPlanHash || candidate.intent.parentSha !== (plan.parents[0] ?? null) ||
      candidate.intent.treeSha !== plan.treeSha || candidate.intent.commitMetadataHash !== plan.commitBytesSha256) throw new Error("COORDINATION_RECOVERY_REQUIRED");
  const plans = validateSourceFixtureGraph(scope.objects.filter((value) => value.kind === "source-fixture"));
  const observedHead = transport.readRef(publication.ref); if (!observedHead) throw new Error("COORDINATION_RECOVERY_REQUIRED");
  const directory = objectDirectory();
  try {
    transport.fetch(directory, observedHead);
    if (!validateSourceAncestry(directory, plans, observedHead).includes(candidate.head)) throw new Error("COORDINATION_RECOVERY_REQUIRED");
    return { candidate, observedHead };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

export function runApprovedSourceFixture(transport: CoordinationTransport, scope: SyntheticScope, fixtureId: string,
  beforeCommit: CoordinationCommitGuard, beforePush: SyntheticPushGuard): SyntheticApplied {
  const { plan, publication } = approvedSyntheticPublication(scope, fixtureId);
  if (plan.kind !== "source-fixture") throw new Error("HUMAN_SYNTHETIC_SCOPE_REQUIRED");
  const plans = validateSourceFixtureGraph(scope.objects.filter((value) => value.kind === "source-fixture"));
  return publishSyntheticObject(transport, plan, publication, beforeCommit, beforePush,
    (directory) => { validateSourceAncestry(directory, plans, plan.parents[0]); },
    (candidate) => recoverSourceFixture(transport, scope, candidate));
}
