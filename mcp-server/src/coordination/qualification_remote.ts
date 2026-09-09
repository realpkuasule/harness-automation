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
import { requiredQualificationCases } from "./qualification_cases.js";
import { sameShaClientFacts } from "./same_sha.js";

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
  if (!manifest.execution) throw new Error("QUALIFICATION_EXECUTION_REQUIRED");
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

/** Partial case evidence requires actual native settlement, original receipts and current approved remote history. */
export function observedQualificationCases(handle: QualificationRemoteEvidence) {
  const facts = readQualificationRemote(handle); const cases = requiredQualificationCases(facts.manifest.requiredCases);
  if (facts.manifest.execution?.kind !== "local-same-sha-publication/1") return cases;
  const proof = readSettledQualification(facts.settled); const negative = facts.manifest.sameShaPublicationNegativeControl!;
  if (proof.executionStatus !== "completed") return cases;
  const reader = proof.instances.find((instance) => instance.launch.role === "rejected-recovery");
  const winner = facts.observations.find((item) => item.ref === negative.ref)?.winner;
  if (proof.instances.length !== 3 || new Set(proof.instances.map((instance) => instance.leader.pid)).size !== 3 || !reader ||
      reader.launch.clientId !== negative.publications[1].clientId || proof.steps.length !== 5 || proof.steps.at(-1)?.stepId !== "rejected-restart" ||
      winner?.clientId !== negative.publications[0].clientId) throw new Error("QUALIFICATION_SAME_SHA_EVIDENCE_INVALID");
  const clients = negative.publications.map((publication, index) => {
    const client = facts.evidence.map(readVerifiedClientEvidence).find((item) => item.clientId === publication.clientId)!;
    const observed = sameShaClientFacts(client.projectRoot, client.approvalRef, index === 0 ? "updated" : "no-op");
    if (!observed.writesClosed || hashObject(observed.heads) !== hashObject(client.heads)) throw new Error("QUALIFICATION_EVIDENCE_DRIFT");
    return observed;
  });
  if (reader.launch.attemptId !== clients[1].attemptId || winner.attemptId !== clients[0].attemptId) throw new Error("QUALIFICATION_SAME_SHA_EVIDENCE_INVALID");
  const evidenceHash = hashObject({ remote: facts.evidenceHash, clients, instances: proof.instances, steps: proof.steps });
  for (const group of cases) for (const assertion of group.subassertions) {
    if (group.id === "dg01-cas" && ["same-sha-update", "same-sha-noop-rejected", "same-sha-unique-winner"].includes(assertion.id) ||
        group.id === "dg01-recovery" && assertion.id === "rejected-restart-not-upgraded") {
      assertion.status = "passed"; assertion.evidenceHash = evidenceHash; group.status = "incomplete";
    }
  }
  return cases;
}
