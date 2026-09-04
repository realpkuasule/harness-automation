import { rmSync } from "node:fs";
import type { GitCommandResult } from "../repository/git.js";
import { objectDirectory, objectGit, validateSyntheticObject } from "./objects.js";
import { approvedSyntheticPublication, syntheticObjectSchema, validateSourceFixtureGraph, type SyntheticObjectPlan, type SyntheticPublication, type SyntheticScope } from "./synthetic.js";
import type { CoordinationCommitGuard, CoordinationCommitIntent, CoordinationTransport } from "./store.js";
import { requireCoordinationPush } from "./push_result.js";

export interface SyntheticCandidate {
  ref: string; head: string; expected: string | null; intent: CoordinationCommitIntent;
}
export interface SyntheticApplied { candidate: SyntheticCandidate; observedHead: string; }
export interface SyntheticWriteResult { candidate: SyntheticCandidate; pushed?: GitCommandResult; applied?: SyntheticApplied; error?: string; }
export type SyntheticPushGuard = (candidate: SyntheticCandidate) => (result: SyntheticWriteResult) => void;

/** Only precomputed empty-tree objects. Authority and quota are checked before materialization and each dispatch. */
export function publishSyntheticObject(transport: CoordinationTransport, input: SyntheticObjectPlan, publication: SyntheticPublication,
  beforeCommit: CoordinationCommitGuard, beforePush: SyntheticPushGuard, validateParent: (directory: string) => void,
  readback: (candidate: SyntheticCandidate) => SyntheticApplied): SyntheticApplied {
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
    const recordWrite = beforePush(candidate); let pushed: GitCommandResult | undefined; let applied: SyntheticApplied;
    try {
      pushed = transport.push(directory, plan.commitSha, publication.ref, publication.expected);
      requireCoordinationPush(pushed, plan.commitSha, publication.ref);
      recordWrite({ candidate, pushed });
      applied = readback(candidate);
    } catch (error) {
      const code = error instanceof Error ? error.message : "COORDINATION_WRITE_OUTCOME_UNKNOWN";
      recordWrite({ candidate, pushed, error: code });
      if (code === "COORDINATION_CAS_CONFLICT" || code === "COORDINATION_CAS_NOT_PERFORMED") retain = false;
      throw error;
    }
    recordWrite({ candidate, pushed, applied }); retain = false; return applied;
  } finally { if (!retain) rmSync(directory, { recursive: true, force: true }); }
}

function validateSourceAncestry(directory: string, plans: SyntheticObjectPlan[], head: string): string[] {
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
