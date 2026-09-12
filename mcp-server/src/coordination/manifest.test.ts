import { mkdtempSync, realpathSync, rmSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { closeQualificationWrites, loadHumanAuthorization, recordCandidateResult, recordHumanApproval, recordWriteOutcome,
  reserveCandidateQuota, reserveWriteAttempt, revokeHumanAuthorization } from "../approval/human.js";
import { createSemanticApprovalPacket } from "../approval/service.js";
import { acquireMutationLock, releaseMutationLock } from "../recovery/service.js";
import { appendReceiptEvent } from "../receipt/service.js";
import { hashObject } from "../v2/fs.js";
import { CoordinationClock } from "./clock.js";
import { humanCoordinationGuards } from "./authorization.js";
import { runLocalQualification } from "./qualification.js";
import { prepareQualificationManifest, qualificationSteps, saveQualificationManifest, scopeForClient, loadQualificationManifest, type QualificationManifestInput } from "./manifest.js";
import { fixtureGenesis } from "./__fixtures__/transport.js";
import { prepareSyntheticObject } from "./synthetic.js";

const roots: string[] = []; const digest = "a".repeat(64); const controlRef = "refs/heads/control"; const sourceRef = "refs/heads/source";
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const dirs = ["a", "b"].map(() => { const root = realpathSync(mkdtempSync(join(tmpdir(), "qualification-manifest-"))); roots.push(root); return root; });
  const genesis = fixtureGenesis(); const source = prepareSyntheticObject("source-fixture", { ...genesis.metadata, objectId: "source" });
  const synthetic = { objects: [genesis, source], controls: [{ fixtureId: "genesis", ref: controlRef }], publications: [
    { fixtureId: "genesis", transactionId: "bootstrap", ref: controlRef, expected: null }, { fixtureId: "source", transactionId: "source-create", ref: sourceRef, expected: null },
  ] };
  const clients: QualificationManifestInput["clients"] = dirs.map((commonDir, index) => ({ clientId: ["a", "b"][index], scope: {
    kind: "qualification-run", runId: genesis.metadata.runId, refs: [controlRef, sourceRef], operations: ["create", "cas"],
    maxCommits: 3, maxWriteAttempts: 3, maxCleanupAttempts: index === 0 ? 2 : 0, expiresAt: "2026-09-04T05:00:00.000Z", cleanupExpiresAt: "2026-09-04T06:00:00.000Z",
    binding: { commonDir, repository: "owner/repo", repositoryId: "42", endpointHash: digest, credentialBindingHash: digest, credentialRef: "git", credentialPurpose: "git-transport", actor: "fixture",
      hostId: "741ba5a8-40e2-4848-b5a4-082f4f2145a9", configHash: digest,
      implementation: { kind: "package", artifactDigest: digest }, runnerHash: digest,
      controlEpoch: { schemaVersion: "coordination-epoch/1", protocol: "github-coordination/1.0", mode: "isolated-qualification", coordinationConfigDigest: digest, policy: { kind: "none" } } },
    synthetic: { ...synthetic, publications: [synthetic.publications[index]] },
  } }));
  const input: QualificationManifestInput = { schemaVersion: "qualification-run-manifest/1", runId: genesis.metadata.runId, repository: "owner/repo", repositoryId: "42", endpointHash: digest,
    synthetic, refs: [controlRef, sourceRef], clients, requiredCases: ["dg01-cas", "dg01-human-budget"], cleanupClientId: "a", maxCommits: 6, maxWriteAttempts: 6, maxCleanupAttempts: 2,
    expiresAt: clients[0].scope.expiresAt, cleanupExpiresAt: clients[0].scope.cleanupExpiresAt };
  return { dirs, genesis, source, input };
}
function clock() { const value = new CoordinationClock(() => ({ monotonicMs: 0, wallMs: 0 })); value.observe("Fri, 04 Sep 2026 04:00:00 GMT", value.start()); return value; }
function approve(scope: ReturnType<typeof scopeForClient>, tag = "first") {
  const inputHash = hashObject(scope); const planHash = hashObject({ inputHash, tag });
  const packet = createSemanticApprovalPacket({ planHash, inputHash, producerIdentity: "local-test",
    binding: { planHash, inputDigest: inputHash, contextDigest: digest, observedHash: digest, policyDigest: digest },
    actions: [{ id: scope.kind, kind: "permission-change", protected: true, summary: "LOCAL unit authorization only", before: null, after: inputHash, reversible: true, recovery: "Retain unknown results" }] });
  return recordHumanApproval(scope.binding.commonDir, { packet, scope, approvedBy: "fixture-human", approvedAt: "2026-09-04T03:00:00.000Z", source: { kind: "explicit-human", messageHash: digest } }, planHash);
}

it("binds ordered fixed publication steps without inferring missing dependencies or accepting commands", () => {
  const f = fixture(); const next = prepareSyntheticObject("source-fixture", { ...f.source.metadata, objectId: "source-next" }, [f.source.commitSha]);
  f.input.synthetic.objects.push(next); const publication = { fixtureId: "source-next", transactionId: "source-update", ref: sourceRef, expected: f.source.commitSha };
  f.input.synthetic.publications.push(publication); f.input.clients[1].scope.synthetic.publications.push(publication);
  f.input.execution = { kind: "local-synthetic-publication/1", steps: [
    { stepId: "init", clientId: "a", operation: "bootstrap", fixtureId: "genesis", transactionId: "bootstrap" },
    { stepId: "source", clientId: "b", operation: "publish-source", fixtureId: "source", transactionId: "source-create" },
    { stepId: "next", clientId: "b", operation: "publish-source", fixtureId: "source-next", transactionId: "source-update" },
  ] };
  const manifest = prepareQualificationManifest(f.input); expect(manifest.execution?.steps).toHaveLength(3);
  expect(readdirSync(f.dirs[0])).toEqual([]);
  for (const patch of [{ clientId: "a" }, { operation: "bootstrap" }, { transactionId: "different" }, { stepId: "init" }, { command: "shell" }]) {
    const input = structuredClone(f.input); Object.assign(input.execution!.steps[1], patch); expect(() => prepareQualificationManifest(input)).toThrow();
  }
  const reordered = structuredClone(f.input); reordered.execution!.steps.reverse(); expect(() => prepareQualificationManifest(reordered)).toThrow("QUALIFICATION_MANIFEST_INVALID");
});

it("binds an explicit two-client acquire contention to its own execution profile", async () => {
  const f = fixture(); f.input.requiredCases = ["dg01-acquire-contention"];
  const contenders = [{ clientId: "a", transactionId: "acquire-a" }, { clientId: "b", transactionId: "acquire-b" }];
  f.input.acquireContention = { caseId: "dg01-acquire-contention", controlRef, contenders };
  f.input.execution = { kind: "local-acquire-contention/1", steps: [
    { stepId: "init", clientId: "a", operation: "bootstrap", fixtureId: "genesis", transactionId: "bootstrap" },
    { stepId: "source", clientId: "b", operation: "publish-source", fixtureId: "source", transactionId: "source-create" },
  ] };
  const manifest = prepareQualificationManifest(f.input);
  expect(manifest.execution?.kind).toBe("local-acquire-contention/1");
  expect(qualificationSteps(manifest).map((step) => step.stepId)).toEqual(["init", "source"]);
  expect(manifest.acquireContention?.contenders.map((item) => item.clientId)).toEqual(["a", "b"]);
  expect(readdirSync(f.dirs[0])).toEqual([]);

  const cases: Array<{ why: string; patch: (value: QualificationManifestInput) => void }> = [
    { why: "the case is not selected", patch: (value) => { value.requiredCases = ["dg01-cas"]; } },
    { why: "a different case id", patch: (value) => { value.acquireContention!.caseId = "dg01-cas"; } },
    { why: "a ref that is not an approved control anchor", patch: (value) => { value.acquireContention!.controlRef = sourceRef; } },
    { why: "one client contending twice", patch: (value) => { value.acquireContention!.contenders[1].clientId = "a"; } },
    { why: "one transaction contending twice", patch: (value) => { value.acquireContention!.contenders[1].transactionId = "acquire-a"; } },
    { why: "an unknown client", patch: (value) => { value.acquireContention!.contenders[1].clientId = "missing"; } },
    { why: "both contenders sharing one common dir", patch: (value) => { value.clients[1].scope.binding.commonDir = value.clients[0].scope.binding.commonDir; } },
    { why: "an unknown field", patch: (value) => { (value.acquireContention as Record<string, unknown>).command = "shell"; } },
    { why: "contention declared under the publication profile", patch: (value) => { value.execution = { ...f.input.execution!, kind: "local-synthetic-publication/1" }; } },
    { why: "the acquire profile without a declared contention", patch: (value) => { delete value.acquireContention; } },
  ];
  for (const { why, patch } of cases) {
    const value = structuredClone(f.input); patch(value);
    expect(() => prepareQualificationManifest(value), why).toThrow();
  }
  // The runner cannot execute the contention yet; refusing is honest, running a reduced sequence is not.
  await expect(runLocalQualification(manifest, [{ clientId: "a", projectRoot: f.dirs[0], approvalRef: digest }]))
    .rejects.toThrow("QUALIFICATION_ACQUIRE_EXECUTION_UNSUPPORTED");
});

it("keeps hashes acyclic, requires exact per-client approval and counts parent budgets including child allocations once", () => {
  const f = fixture(); f.input.clients[0].scope.takeoverAllocations = [{ allocationId: "child-a", workItem: "github:owner/repo#86", controlRef, sourceRef, genesisSha: f.genesis.commitSha, maxCommits: 2, maxWriteAttempts: 2 }];
  const manifest = prepareQualificationManifest(f.input);
  expect(manifest.maxCommits).toBe(6); expect(readdirSync(f.dirs[0])).toEqual([]);
  expect(JSON.stringify(manifest)).not.toContain("approvalRef"); expect(manifest.clients[0].scope).not.toHaveProperty("manifest");
  const scope = scopeForClient(manifest, "a"); expect(() => approve(scope)).toThrow();
  saveQualificationManifest(f.dirs[0], manifest); expect(saveQualificationManifest(f.dirs[0], manifest)).toEqual(manifest);
  expect(() => approve({ ...scope, maxCommits: 4 })).toThrow("QUALIFICATION_CLIENT_SCOPE_MISMATCH");
  expect(() => approve({ ...scope, manifest: { ...scope.manifest!, clientId: "b" } })).toThrow("QUALIFICATION_CLIENT_SCOPE_MISMATCH");
  const reference = approve(scope); expect(approve(scope)).toBe(reference);
  expect(() => approve(scope, "second-packet")).toThrow("QUALIFICATION_CLIENT_ALREADY_BOUND");
  revokeHumanAuthorization(f.dirs[0], reference, "not refundable");
  expect(() => approve(scope, "third-packet")).toThrow("QUALIFICATION_CLIENT_ALREADY_BOUND");
  expect(loadQualificationManifest(f.dirs[0], manifest.manifestHash)).toEqual(manifest);
});

it("rejects over-budget, ambiguous ownership, extra resources, mismatched genesis and duplicate allocations", () => {
  const { input, genesis } = fixture(); const patches: Array<(value: QualificationManifestInput) => void> = [
    (v) => { v.maxCommits--; }, (v) => { v.maxWriteAttempts--; }, (v) => { v.maxCleanupAttempts--; },
    (v) => { v.clients[1].scope.maxCleanupAttempts = 1; }, (v) => { v.clients[1].clientId = "a"; },
    (v) => { v.clients[1].scope.binding.commonDir = v.clients[0].scope.binding.commonDir; },
    (v) => { v.clients[1].scope.binding.repositoryId = "other"; }, (v) => { v.clients[1].scope.binding.endpointHash = "b".repeat(64); },
    (v) => { v.clients[1].scope.runId = "other"; }, (v) => { v.refs.push("refs/heads/production"); },
    (v) => { v.clients[1].scope.expiresAt = "2026-09-04T05:01:00.000Z"; },
    (v) => { v.clients[1].scope.synthetic.publications = v.synthetic.publications; },
    (v) => { v.clients[0].scope.synthetic.publications = []; },
    (v) => { v.requiredCases.push("dg01-cas"); },
    (v) => { v.clients[1].scope.synthetic.controls[0].ref = sourceRef; },
    (v) => { const allocation = { allocationId: "duplicate", workItem: "github:owner/repo#86", controlRef, sourceRef, genesisSha: genesis.commitSha, maxCommits: 1, maxWriteAttempts: 1 }; v.clients.forEach((client) => { client.scope.takeoverAllocations = [allocation]; }); },
  ];
  for (const patch of patches) { const value = structuredClone(input); patch(value); expect(() => prepareQualificationManifest(value)).toThrow(); }
  expect(() => prepareQualificationManifest({ ...input, command: "arbitrary-shell" } as QualificationManifestInput)).toThrow();
});

it("allows exactly two listed same-SHA publishers, each with one charged candidate and one dispatch", () => {
  const f = fixture(); f.input.clients[0].scope.synthetic.publications.push(f.input.synthetic.publications[1]);
  f.input.clients[1].scope.synthetic.publications[0] = { ...f.input.synthetic.publications[1], transactionId: "same-sha-negative" };
  expect(() => prepareQualificationManifest(f.input)).toThrow("QUALIFICATION_MANIFEST_INVALID");
  f.input.sameShaPublicationNegativeControl = { caseId: "dg01-cas", fixtureId: "source", ref: sourceRef, expected: null,
    publications: [{ clientId: "a", transactionId: "source-create" }, { clientId: "b", transactionId: "same-sha-negative" }] };
  const manifest = prepareQualificationManifest(f.input); saveQualificationManifest(f.dirs[1], manifest); const scope = scopeForClient(manifest, "b"); const reference = approve(scope);
  const intent = { transactionId: "same-sha-negative", parentSha: null, treeSha: f.source.treeSha,
    subject: { kind: "source-fixture" as const, fixtureId: "source", objectPlanHash: f.source.objectPlanHash }, objectDirectory: f.dirs[1], commitMetadataHash: f.source.commitBytesSha256 };
  const candidate = reserveCandidateQuota(f.dirs[1], reference, scope.binding, intent, clock());
  recordCandidateResult(f.dirs[1], reference, { candidateId: candidate.candidateId, head: f.source.commitSha, status: "created", evidenceHash: digest });
  expect(() => reserveCandidateQuota(f.dirs[1], reference, scope.binding, intent, clock())).toThrow("HUMAN_PUBLICATION_BUDGET_EXHAUSTED");
  const request = { transactionId: intent.transactionId, ref: sourceRef, operation: "create" as const, head: f.source.commitSha, expected: null };
  const attempt = reserveWriteAttempt(f.dirs[1], reference, scope.binding, request, clock());
  recordWriteOutcome(f.dirs[1], reference, { attemptId: attempt.attemptId, status: "rejected", evidenceHash: digest });
  expect(() => reserveWriteAttempt(f.dirs[1], reference, scope.binding, request, clock())).toThrow("HUMAN_PUBLICATION_BUDGET_EXHAUSTED");
  expect(loadHumanAuthorization(f.dirs[1], reference).attempts).toHaveLength(1);
});

it("limits the fixed same-SHA execution to one approved genesis, two writers and the required negative/recovery groups", () => {
  const f = fixture(); const input = f.input; const publication = input.synthetic.publications[0];
  input.refs = [controlRef]; input.synthetic = { ...input.synthetic, objects: [f.genesis], publications: [publication] };
  for (const [index, client] of input.clients.entries()) {
    client.scope.synthetic = { ...input.synthetic, publications: [{ ...publication, transactionId: index === 0 ? "bootstrap" : "no-op" }] };
    client.scope.refs = [controlRef];
  }
  input.requiredCases = ["dg01-cas", "dg01-recovery"];
  input.sameShaPublicationNegativeControl = { caseId: "dg01-cas", fixtureId: "genesis", ref: controlRef, expected: null,
    publications: [{ clientId: "a", transactionId: "bootstrap" }, { clientId: "b", transactionId: "no-op" }] };
  input.execution = { kind: "local-same-sha-publication/1" };
  expect(prepareQualificationManifest(input).execution?.kind).toBe("local-same-sha-publication/1");
  expect(readdirSync(f.dirs[0])).toEqual([]);
  for (const patch of [
    (value: QualificationManifestInput) => { delete value.sameShaPublicationNegativeControl; },
    (value: QualificationManifestInput) => { value.requiredCases = ["dg01-cas"]; },
    (value: QualificationManifestInput) => { value.sameShaPublicationNegativeControl!.expected = f.genesis.commitSha; },
    (value: QualificationManifestInput) => { value.clients[1].clientId = value.clients[0].clientId; },
    (value: QualificationManifestInput) => { value.execution = { kind: "local-synthetic-publication/1", steps: [{ stepId: "uncontrolled", clientId: "a", operation: "bootstrap", fixtureId: "genesis", transactionId: "bootstrap" }] }; },
  ]) {
    const changed = structuredClone(input); patch(changed); expect(() => prepareQualificationManifest(changed)).toThrow();
  }
});

it("closes ordinary writes durably and idempotently, allowing facts but neither dispatch nor unverified cleanup", () => {
  const f = fixture(); const manifest = prepareQualificationManifest(f.input); saveQualificationManifest(f.dirs[0], manifest);
  const scope = scopeForClient(manifest, "a"); const reference = approve(scope); const root = f.dirs[0];
  const intent = { transactionId: "bootstrap", parentSha: null, treeSha: f.genesis.treeSha, subject: { kind: "control-genesis" as const, fixtureId: "genesis", objectPlanHash: f.genesis.objectPlanHash },
    objectDirectory: root, commitMetadataHash: f.genesis.commitBytesSha256 };
  const candidate = reserveCandidateQuota(root, reference, scope.binding, intent, clock());
  const context = { projectDir: root, commonDir: root, repository: true }; const held = acquireMutationLock(context);
  try { expect(() => closeQualificationWrites(root, reference)).toThrow("WORKSPACE_LOCKED"); } finally { releaseMutationLock(held); }
  expect(closeQualificationWrites(root, reference)).toMatchObject({ writesClosed: true, revoked: false });
  expect(closeQualificationWrites(root, reference).candidates).toHaveLength(1);
  const eventDir = join(root, "harness/receipts/approval-human", reference, "events"); expect(readdirSync(eventDir)).toHaveLength(3);
  recordCandidateResult(root, reference, { candidateId: candidate.candidateId, status: "created", head: f.genesis.commitSha, evidenceHash: digest });
  expect(() => reserveCandidateQuota(root, reference, scope.binding, intent, clock())).toThrow("HUMAN_QUALIFICATION_WRITES_CLOSED");
  expect(() => reserveWriteAttempt(root, reference, scope.binding, { transactionId: "bootstrap", operation: "create", ref: controlRef, head: f.genesis.commitSha, expected: null }, clock())).toThrow("HUMAN_QUALIFICATION_WRITES_CLOSED");
  const guards = humanCoordinationGuards(root, reference, () => scope.binding, clock);
  expect(() => guards.beforeSyntheticPush({ ref: controlRef, head: f.genesis.commitSha, expected: null, intent })).toThrow("HUMAN_QUALIFICATION_WRITES_CLOSED");
  releaseMutationLock(acquireMutationLock(context));
  expect(() => reserveWriteAttempt(root, reference, scope.binding, { transactionId: "cleanup", operation: "cleanup", ref: controlRef, head: null, expected: f.genesis.commitSha }, clock())).toThrow("QUALIFICATION_CLEANUP_EVIDENCE_REQUIRED");
  expect(loadHumanAuthorization(root, reference).attempts).toEqual([]);
});

it("does not silently repair missing LKG tails or accept changed/symlinked manifest inputs", () => {
  const f = fixture(); const manifest = prepareQualificationManifest(f.input); const root = f.dirs[0]; saveQualificationManifest(root, manifest);
  const scope = scopeForClient(manifest, "a"); const reference = approve(scope); closeQualificationWrites(root, reference);
  rmSync(join(root, "harness/lkg/approval-human/records/000000000002.json"));
  expect(() => loadHumanAuthorization(root, reference)).toThrow("HUMAN_AUTHORIZATION_RECOVERY_REQUIRED");
  expect(closeQualificationWrites(root, reference).writesClosed).toBe(true);
  const path = join(root, `harness/plans/qualification-${manifest.manifestHash}.json`);
  writeFileSync(path, JSON.stringify({ ...manifest, maxCommits: 7 })); expect(() => loadHumanAuthorization(root, reference)).toThrow("QUALIFICATION_MANIFEST_HASH_MISMATCH");
  rmSync(path); const other = join(f.dirs[1], "manifest.json"); writeFileSync(other, JSON.stringify(manifest)); symlinkSync(other, path);
  expect(() => loadQualificationManifest(root, manifest.manifestHash)).toThrow("SYMLINK_TARGET_REJECTED");
});

it("replays cleanup audit as quota registration only, enforcing prior closure, exact cleaner and finite pending budget", () => {
  const f = fixture(); const manifest = prepareQualificationManifest(f.input);
  for (const root of f.dirs) saveQualificationManifest(root, manifest);
  const scope = scopeForClient(manifest, "a"); const reference = approve(scope); const root = f.dirs[0];
  const request = { transactionId: "cleanup", operation: "cleanup" as const, ref: sourceRef, head: null, expected: f.source.commitSha,
    cleanupEvidenceHash: digest, cleanupManifest: scope.manifest };
  expect(() => reserveWriteAttempt(root, reference, scope.binding, request, clock())).toThrow("HUMAN_QUALIFICATION_WRITES_OPEN");
  closeQualificationWrites(root, reference);
  for (const cleanupManifest of [undefined, { ...scope.manifest!, clientId: "b" }]) {
    expect(() => reserveWriteAttempt(root, reference, scope.binding, { ...request, cleanupManifest }, clock())).toThrow("QUALIFICATION_CLEANUP_EVIDENCE_REQUIRED");
  }
  // Audit bytes cannot attest a winner or dispatch: the native cleanup/transport boundary has separate private handles.
  const first = reserveWriteAttempt(root, reference, scope.binding, request, clock());
  expect(loadHumanAuthorization(root, reference).attempts[0].outcome).toBeUndefined();
  expect(() => reserveWriteAttempt(root, reference, scope.binding, request, clock())).toThrow("HUMAN_WRITE_OUTCOME_UNRESOLVED");
  recordWriteOutcome(root, reference, { attemptId: first.attemptId, status: "rejected", evidenceHash: digest });
  const second = reserveWriteAttempt(root, reference, scope.binding, request, clock());
  recordWriteOutcome(root, reference, { attemptId: second.attemptId, status: "rejected", evidenceHash: digest });
  expect(() => reserveWriteAttempt(root, reference, scope.binding, request, clock())).toThrow("HUMAN_WRITE_BUDGET_EXHAUSTED");
  expect(loadHumanAuthorization(root, reference)).toMatchObject({ writesClosed: true, candidates: [] });
  const other = scopeForClient(manifest, "b"); const otherRef = approve(other); closeQualificationWrites(f.dirs[1], otherRef);
  expect(() => reserveWriteAttempt(f.dirs[1], otherRef, other.binding, { ...request, cleanupManifest: other.manifest }, clock())).toThrow("HUMAN_WRITE_BUDGET_EXHAUSTED");
});

it("cannot retroactively legalize a cleanup reservation by appending a later writes-closed event", () => {
  const f = fixture(); const manifest = prepareQualificationManifest(f.input); const root = f.dirs[0]; saveQualificationManifest(root, manifest);
  const scope = scopeForClient(manifest, "a"); const reference = approve(scope); const key = { root, domain: "approval-human", transactionId: reference };
  appendReceiptEvent({ ...key, snapshot: { kind: "reserved", attempt: { transactionId: "cleanup", operation: "cleanup", ref: sourceRef, head: null,
    expected: f.source.commitSha, candidateId: null, attemptId: "741ba5a8-40e2-4848-b5a4-082f4f2145a9", reservedAt: "2026-09-04T04:00:00.000Z",
    cleanupEvidenceHash: digest, cleanupManifest: scope.manifest } } });
  appendReceiptEvent({ ...key, snapshot: { kind: "qualification-writes-closed", runId: scope.runId, manifest: scope.manifest } });
  expect(() => loadHumanAuthorization(root, reference)).toThrow("HUMAN_QUALIFICATION_WRITES_OPEN");
});
