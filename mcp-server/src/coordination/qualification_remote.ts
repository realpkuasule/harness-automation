import { rmSync } from "node:fs";
import { assertHumanCandidateScope } from "../approval/human.js";
import { hashObject } from "../v2/fs.js";
import { evaluateQualificationRun, readVerifiedClientEvidence, recheckClientEvidence, type EvidenceLock, type VerifiedClientEvidence } from "./evidence.js";
import { loadQualificationManifest, type QualificationManifest } from "./manifest.js";
import { objectDirectory, validateSyntheticObject } from "./objects.js";
import { validateSourceAncestry } from "./publication.js";
import { coordinationPushOutcome } from "./push_result.js";
import { collectSettledEvidence, readSettledQualification, type SettledQualification } from "./qualification.js";
import { loadCoordinationConfig } from "./service.js";
import { GitHubCoordinationTransport } from "./transport.js";

type Winner = { clientId: string; approvalRef: string; candidateId: string; attemptId: string; transactionId: string };
type Observation = { ref: string; head: string | null; ancestry: string[]; winner: Winner | null };
type RemoteFacts = { manifest: QualificationManifest; evidence: VerifiedClientEvidence[]; observations: Observation[]; settled: SettledQualification };
export type QualificationRemoteEvidence = Readonly<{ kind: "native-qualification-remote-evidence" }>;
const observed = new WeakMap<QualificationRemoteEvidence, RemoteFacts>();

function publicationWinner(manifest: QualificationManifest, evidence: VerifiedClientEvidence[], ref: string, head: string): Winner {
  const winners: Winner[] = [];
  for (const handle of evidence) {
    const client = readVerifiedClientEvidence(handle);
    for (const { approvalRef, state } of client.chains) for (const attempt of state.attempts) {
      if (attempt.ref !== ref || attempt.head !== head || attempt.outcome?.status !== "applied" || attempt.operation === "cleanup") continue;
      const candidate = state.candidates.find((item) => item.candidateId === attempt.candidateId);
      if (!candidate || candidate.subject.kind === "coordination-record" || candidate.result?.status !== "created" || candidate.result.head !== head ||
          candidate.transactionId !== attempt.transactionId || !attempt.outcome.push || coordinationPushOutcome(attempt.outcome.push, head, ref) !== "updated") throw new Error("COORDINATION_UPDATE_ATTRIBUTION_UNPROVEN");
      assertHumanCandidateScope(state.approval.scope, candidate);
      const publication = manifest.clients.find((item) => item.clientId === client.clientId)?.scope.synthetic.publications.find((item) =>
        item.fixtureId === (candidate.subject as { fixtureId: string }).fixtureId && item.transactionId === attempt.transactionId);
      const plan = manifest.synthetic.objects.find((item) => item.commitSha === head);
      if (!publication || publication.ref !== ref || publication.expected !== attempt.expected || !plan ||
          plan.objectPlanHash !== candidate.subject.objectPlanHash) throw new Error("HUMAN_CLEANUP_OWNERSHIP_UNPROVEN");
      winners.push({ clientId: client.clientId, approvalRef, candidateId: candidate.candidateId, attemptId: attempt.attemptId, transactionId: attempt.transactionId });
    }
  }
  if (winners.length !== 1) throw new Error("HUMAN_CLEANUP_OWNERSHIP_UNPROVEN");
  return winners[0];
}

/** Read-only native observation. No injected transport, caller-supplied result or imported process proof. */
export function observeQualificationRemote(settlement: SettledQualification, held?: EvidenceLock): QualificationRemoteEvidence {
  const proof = readSettledQualification(settlement); const evidence = collectSettledEvidence(settlement, held);
  const first = readVerifiedClientEvidence(evidence[0]);
  const manifest = loadQualificationManifest(first.chains[0].state.approval.scope.binding.commonDir, proof.manifestHash);
  if (manifest.execution?.kind !== "local-synthetic-publication/1") throw new Error("QUALIFICATION_EXECUTION_REQUIRED");
  const report = evaluateQualificationRun(manifest, evidence, held);
  const gap = report.blockers.find((item) => !["QUALIFICATION_RUNNER_DRAIN_UNPROVEN", "QUALIFICATION_REMOTE_HISTORY_UNPROVEN"].includes(item.code));
  if (gap) throw new Error(gap.code);
  const cleaner = readVerifiedClientEvidence(evidence.find((item) => readVerifiedClientEvidence(item).clientId === manifest.cleanupClientId)!);
  const binding = cleaner.chains[0].state.approval.scope.binding;
  const transport = new GitHubCoordinationTransport(cleaner.projectRoot, loadCoordinationConfig(cleaner.projectRoot)?.remote ?? "origin", binding.repositoryId, binding.credentialRef);
  const observations: Observation[] = [];
  for (const ref of manifest.refs) {
    const head = transport.readRef(ref); let ancestry: string[] = []; let winner: Winner | null = null;
    if (head) {
      const plan = manifest.synthetic.objects.find((item) => item.commitSha === head);
      if (!plan) throw new Error("QUALIFICATION_REMOTE_HISTORY_UNPROVEN");
      const control = manifest.synthetic.controls.find((item) => item.ref === ref);
      if (control ? plan.kind !== "control-genesis" || control.fixtureId !== plan.metadata.objectId : plan.kind !== "source-fixture") throw new Error("QUALIFICATION_REMOTE_HISTORY_UNPROVEN");
      const directory = objectDirectory();
      try {
        transport.fetch(directory, head);
        if (control) { validateSyntheticObject(directory, plan); ancestry = [head]; }
        else ancestry = validateSourceAncestry(directory, manifest.synthetic.objects.filter((item) => item.kind === "source-fixture"), head);
      } finally { rmSync(directory, { recursive: true, force: true }); }
      winner = publicationWinner(manifest, evidence, ref, head);
    }
    if (transport.readRef(ref) !== head) throw new Error("QUALIFICATION_REMOTE_REF_DRIFT");
    observations.push({ ref, head, ancestry, winner });
  }
  evidence.forEach((handle) => recheckClientEvidence(handle, readVerifiedClientEvidence(handle).clientId === held?.clientId ? held.lock : undefined));
  const handle: QualificationRemoteEvidence = Object.freeze({ kind: "native-qualification-remote-evidence" });
  observed.set(handle, { manifest, evidence, observations, settled: settlement }); return handle;
}

/** Reports are projections, never importable authority. Keep the original private handles for the native cleanup boundary. */
export function readQualificationRemote(handle: QualificationRemoteEvidence) {
  const facts = observed.get(handle); if (!facts) throw new Error("QUALIFICATION_REMOTE_ORIGIN_UNPROVEN");
  readSettledQualification(facts.settled);
  return { manifest: structuredClone(facts.manifest), observations: structuredClone(facts.observations), evidence: [...facts.evidence], settled: facts.settled,
    evidenceHash: hashObject({ manifestHash: facts.manifest.manifestHash, observations: facts.observations,
      clients: facts.evidence.map((item) => { const value = readVerifiedClientEvidence(item); return { clientId: value.clientId, heads: value.heads }; }) }) };
}
