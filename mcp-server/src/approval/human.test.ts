import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { hashObject } from "../v2/fs.js";
import { CoordinationClock } from "../coordination/clock.js";
import { controlEpochDigest } from "../coordination/authority.js";
import { prepareSyntheticObject } from "../coordination/synthetic.js";
import { prepareQualificationManifest, saveQualificationManifest, scopeForClient } from "../coordination/manifest.js";
import { listReceiptTransactions } from "../receipt/service.js";
import { createSemanticApprovalPacket } from "./service.js";
import { closeQualificationWrites, loadHumanAuthorization, recordCandidateResult, recordHumanApproval, recordWriteOutcome, reserveCandidateQuota, reserveWriteAttempt, revokeHumanAuthorization, type HumanScope, type HumanScopeBinding } from "./human.js";

const roots: string[] = [];
const digest = "a".repeat(64); const head = "b".repeat(40); const ref = "refs/heads/synthetic-qualification";
const binding = { commonDir: "/fixture-not-registered", repository: "owner/repo", repositoryId: "42", endpointHash: digest, credentialBindingHash: digest,
  credentialRef: "keychain:git", credentialPurpose: "git-transport" as const, actor: "octo", hostId: "741ba5a8-40e2-4848-b5a4-082f4f2145a9", configHash: digest,
  controlEpoch: { schemaVersion: "coordination-epoch/1" as const, protocol: "github-coordination/1.0" as const, mode: "isolated-qualification" as const,
    coordinationConfigDigest: digest, policy: { kind: "none" as const } },
  implementation: { kind: "source" as const, head, tree: head, artifactDigest: digest }, runnerHash: digest };
const scope: HumanScope = { kind: "qualification-run", binding, expiresAt: "2026-09-04T05:00:00.000Z", cleanupExpiresAt: "2026-09-04T06:00:00.000Z",
  runId: "bounded-run", refs: [ref], operations: ["create", "cas"], maxCommits: 2, maxWriteAttempts: 2, maxCleanupAttempts: 1 };
function clock(date = "Fri, 04 Sep 2026 04:00:00 GMT") { const value = new CoordinationClock(() => ({ monotonicMs: 0, wallMs: 0 })); value.observe(date, value.start()); return value; }
function fixture(input: HumanScope = scope, existingRoot?: string) {
  const root = existingRoot ?? realpathSync(mkdtempSync(join(tmpdir(), "human-approval-"))); if (!existingRoot) roots.push(root);
  input = { ...input, binding: { ...input.binding, commonDir: root } };
  if (input.kind === "takeover") {
    const assetRisk = { ...input.assetRisk, target: { ...input.assetRisk.target, workspace: root, commonDir: root } };
    input = { ...input, targetWorkspace: root, assetRisk, assetRiskHash: hashObject(assetRisk) };
  }
  const scopeHash = hashObject(input); const planHash = hashObject({ scopeHash });
  const packet = createSemanticApprovalPacket({ planHash, inputHash: scopeHash, producerIdentity: "test-producer",
    binding: { planHash, inputDigest: scopeHash, contextDigest: digest, observedHash: digest, policyDigest: digest },
    actions: [{ id: input.kind, kind: "permission-change", protected: true, summary: "Explicit bounded test scope", before: "unapproved", after: scopeHash, reversible: true, recovery: "Keep assets and recover observations without repeating writes." }] });
  const approval = { packet, scope: input, approvedBy: "human-fixture", approvedAt: "2026-09-04T03:00:00.000Z", source: { kind: "explicit-human" as const, messageHash: digest } };
  return { root, packet, approval, binding: input.binding, register: () => recordHumanApproval(root, approval, planHash, clock()) };
}
function takeoverScope(bound: HumanScopeBinding): Extract<HumanScope, { kind: "takeover" }> {
  const assetRisk = { schemaVersion: "takeover-risk/1" as const, target: { workspace: bound.commonDir, commonDir: bound.commonDir,
    actor: bound.actor, hostId: bound.hostId, branch: "fixture", head, assets: { indexHash: digest, entries: [] },
    handling: "retain-all-assets" as const, uniqueCommits: 0, unpushedCommits: 0, remoteOnlyCommits: 0 },
  remote: { repositoryId: bound.repositoryId, endpointHash: digest, ref: "refs/heads/fixture", head },
  source: { kind: "not-observed" as const, reason: "source-machine-not-accessed" as const },
  risks: ["source-assets-unknown", "external-writers-not-fenced", "old-assets-retained", "not-zero-loss-transfer"] as ["source-assets-unknown", "external-writers-not-fenced", "old-assets-retained", "not-zero-loss-transfer"] };
  return { kind: "takeover", binding: bound, expiresAt: scope.expiresAt, workItem: "github:owner/repo#1", controlRef: ref, expectedControlSha: head,
    expected: { recordHash: digest, generation: 1, owner: "old", machine: "old-host", lastObservedHead: head, controlEpochDigest: digest },
    targetOwner: bound.actor, targetHostId: bound.hostId, newEpochDigest: controlEpochDigest(bound.controlEpoch),
    assetRisk, assetRiskHash: hashObject(assetRisk), transactionId: "takeover-1", maxCommits: 2, maxWriteAttempts: 2,
    targetWorkspace: bound.commonDir, targetBranch: "fixture", targetHead: head, sourceRepositoryId: bound.repositoryId,
    newLease: { ttlMs: 60_000, notAfter: "2026-09-04T05:30:00.000Z" } };
}
const request = { transactionId: "transaction-1", operation: "create" as const, ref, head, expected: null };
const intent = { transactionId: request.transactionId, parentSha: null, treeSha: head, subject: { kind: "coordination-record" as const, workItem: "github:owner/repo#1", recordHash: digest }, commitMetadataHash: digest, objectDirectory: "/unit-producer-no-objects" };
function created(root: string, approvalRef: string, observed: HumanScopeBinding, transactionId = request.transactionId) {
  // Unit-level producer metadata only; the Store tests exercise real commit creation ordering.
  const scope = loadHumanAuthorization(root, approvalRef).approval.scope;
  const candidate = reserveCandidateQuota(root, approvalRef, observed, { ...intent, transactionId,
    parentSha: scope.kind === "takeover" ? scope.expectedControlSha : null }, clock());
  recordCandidateResult(root, approvalRef, { candidateId: candidate.candidateId, status: "created", head, evidenceHash: digest });
  return candidate;
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("fixed-purpose human authorization receipts", () => {
  it("closes existing and unissued child allocations without preventing late result facts or refunding quotas", () => {
    const initial = fixture(); const genesis = prepareSyntheticObject("control-genesis", { runId: scope.runId, objectId: "genesis", seconds: 1788480000 });
    const source = prepareSyntheticObject("source-fixture", { ...genesis.metadata, objectId: "source" }); const sourceRef = "refs/heads/fixture";
    const allocation = { allocationId: "existing", workItem: "github:owner/repo#1", controlRef: ref, sourceRef, genesisSha: genesis.commitSha, maxCommits: 2, maxWriteAttempts: 2 };
    const definition = { ...scope, binding: initial.binding, refs: [ref, sourceRef], maxCommits: 6, maxWriteAttempts: 6,
      takeoverAllocations: [allocation, { ...allocation, allocationId: "unissued" }],
      synthetic: { objects: [genesis, source], controls: [{ fixtureId: "genesis", ref }], publications: [
        { fixtureId: "genesis", transactionId: "bootstrap", ref, expected: null }, { fixtureId: "source", transactionId: "source-create", ref: sourceRef, expected: null },
      ] } };
    const manifest = prepareQualificationManifest({ schemaVersion: "qualification-run-manifest/1", runId: scope.runId, repository: binding.repository, repositoryId: binding.repositoryId,
      endpointHash: digest, refs: definition.refs, synthetic: definition.synthetic, clients: [{ clientId: "local", scope: definition }], cleanupClientId: "local", requiredCases: ["dg01-human-budget"],
      maxCommits: 6, maxWriteAttempts: 6, maxCleanupAttempts: 1, expiresAt: scope.expiresAt, cleanupExpiresAt: scope.cleanupExpiresAt });
    saveQualificationManifest(initial.root, manifest);
    const parent = fixture(scopeForClient(manifest, "local"), initial.root); const parentRef = parent.register();
    const childScope = { ...takeoverScope(parent.binding), qualification: { parentApprovalRef: parentRef, runId: scope.runId, allocationId: "existing", genesisSha: genesis.commitSha } };
    const child = fixture(childScope, parent.root); const childRef = child.register(); created(parent.root, childRef, parent.binding, "takeover-1");
    const attempt = reserveWriteAttempt(parent.root, childRef, parent.binding, { ...request, operation: "cas", expected: head, transactionId: "takeover-1" }, clock());
    closeQualificationWrites(parent.root, parentRef);
    recordWriteOutcome(parent.root, childRef, { attemptId: attempt.attemptId, status: "unknown", evidenceHash: digest });
    expect(() => fixture({ ...childScope, qualification: { ...childScope.qualification, allocationId: "unissued" } }, parent.root).register()).toThrow("HUMAN_QUALIFICATION_WRITES_CLOSED");
    expect(() => created(parent.root, childRef, parent.binding, "takeover-1")).toThrow("HUMAN_QUALIFICATION_WRITES_CLOSED");
    expect(() => reserveWriteAttempt(parent.root, childRef, parent.binding, { ...request, operation: "cas", expected: head, transactionId: "takeover-1" }, clock())).toThrow("HUMAN_QUALIFICATION_WRITES_CLOSED");
    recordWriteOutcome(parent.root, childRef, { attemptId: attempt.attemptId, status: "applied", evidenceHash: digest });
    expect(loadHumanAuthorization(parent.root, childRef).attempts[0].outcome?.status).toBe("applied");
    expect(loadHumanAuthorization(parent.root, parentRef)).toMatchObject({ writesClosed: true, revoked: false, attempts: [], candidates: [] });
  });

  it("binds synthetic candidates and dispatch to exact approved bytes, transaction, ref and old SHA", () => {
    const plan = prepareSyntheticObject("source-fixture", { runId: scope.runId, objectId: "source", seconds: 1788480000 });
    const publication = { fixtureId: "source", transactionId: "fixture-create", ref, expected: null };
    const synthetic = { objects: [plan], controls: [], publications: [publication] };
    const f = fixture({ ...scope, refs: [ref, "refs/heads/also-listed"], synthetic });
    const approvalRef = f.register();
    const exact = { ...intent, transactionId: publication.transactionId, treeSha: plan.treeSha, commitMetadataHash: plan.commitBytesSha256,
      subject: { kind: "source-fixture" as const, fixtureId: "source", objectPlanHash: plan.objectPlanHash } };
    for (const patch of [{ transactionId: "wrong" }, { parentSha: head }, { treeSha: head }, { commitMetadataHash: digest },
      { subject: { ...exact.subject, fixtureId: "unknown" } }, { subject: { ...exact.subject, kind: "control-genesis" as const } }]) {
      expect(() => reserveCandidateQuota(f.root, approvalRef, f.binding, { ...exact, ...patch }, clock())).toThrow("HUMAN_SYNTHETIC_SCOPE_REQUIRED");
    }
    expect(loadHumanAuthorization(f.root, approvalRef).candidates).toHaveLength(0);
    const candidate = reserveCandidateQuota(f.root, approvalRef, f.binding, exact, clock());
    recordCandidateResult(f.root, approvalRef, { candidateId: candidate.candidateId, status: "created", head: plan.commitSha, evidenceHash: digest });
    const write = { ...request, transactionId: publication.transactionId, head: plan.commitSha };
    for (const patch of [{ ref: "refs/heads/also-listed" }, { operation: "cas" as const, expected: head }]) {
      expect(() => reserveWriteAttempt(f.root, approvalRef, f.binding, { ...write, ...patch }, clock())).toThrow("HUMAN_WRITE_SCOPE_MISMATCH");
    }
    expect(loadHumanAuthorization(f.root, approvalRef).attempts).toHaveLength(0);
    reserveWriteAttempt(f.root, approvalRef, f.binding, write, clock());
    expect(loadHumanAuthorization(f.root, approvalRef).attempts).toHaveLength(1);
    expect(() => fixture({ ...scope, synthetic: { ...synthetic, publications: [{ ...publication, ref: "refs/heads/unlisted" }] } }).register()).toThrow("HUMAN_SCOPE_INVALID");
    expect(() => fixture({ ...scope, runId: "different", synthetic }).register()).toThrow("HUMAN_SCOPE_INVALID");
  });

  it("requires a recorded exact protected approval; no pre-existing write PASS is required for the bounded probe", () => {
    const { root, packet, approval, register, binding } = fixture();
    expect(() => loadHumanAuthorization(root, packet.packetHash)).toThrow("HUMAN_APPROVAL_REQUIRED");
    expect(() => recordHumanApproval(root, approval, digest)).toThrow("HUMAN_APPROVAL_REQUIRED");
    const misleading = createSemanticApprovalPacket({ ...packet, binding: packet.binding, actions: [] });
    expect(() => recordHumanApproval(root, { ...approval, packet: misleading }, misleading.planHash)).toThrow("HUMAN_APPROVAL_REQUIRED");
    const approvalRef = register(); expect(register()).toBe(approvalRef);
    expect(loadHumanAuthorization(root, approvalRef).approval.scope.kind).toBe("qualification-run");
    for (const field of Object.keys(binding)) expect(() => reserveWriteAttempt(root, approvalRef, { ...binding, [field]: "wrong" }, request, clock())).toThrow();
    expect(() => reserveWriteAttempt(root, approvalRef, binding, request, clock())).toThrow("HUMAN_CANDIDATE_UNPROVEN");
    created(root, approvalRef, binding);
    expect(() => reserveWriteAttempt(root, approvalRef, binding, { ...request, ref: "refs/heads/production" }, clock())).toThrow("HUMAN_WRITE_SCOPE_MISMATCH");
    const attempt = reserveWriteAttempt(root, approvalRef, binding, request, clock());
    expect(loadHumanAuthorization(root, approvalRef).attempts).toHaveLength(1);
    expect(attempt.expected).toBeNull();
    // This only reserves scope; no production adoption or remote operation occurs here.
    expect(loadHumanAuthorization(root, approvalRef).approval.scope).not.toHaveProperty("qualificationEvidenceHash");
  });

  it("does not overspend when independent processes contend for one attempt", async () => {
    const { root, register, binding } = fixture({ ...scope, maxWriteAttempts: 1 }); const approvalRef = register();
    created(root, approvalRef, binding);
    const source = new URL("./human.ts", import.meta.url).href; const clockSource = new URL("../coordination/clock.ts", import.meta.url).href;
    const run = (transactionId: string) => new Promise<number | null>((resolve, reject) => {
      const script = `import {reserveWriteAttempt} from ${JSON.stringify(source)};import {CoordinationClock} from ${JSON.stringify(clockSource)};try{const c=new CoordinationClock(()=>({monotonicMs:0,wallMs:0}));c.observe('Fri, 04 Sep 2026 04:00:00 GMT',c.start());reserveWriteAttempt(process.argv[1],process.argv[2],${JSON.stringify(binding)},{...${JSON.stringify(request)},transactionId:process.argv[3]},c);}catch{process.exitCode=1;}`;
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, root, approvalRef, transactionId], { stdio: "ignore" });
      child.once("error", reject); child.once("exit", resolve);
    });
    expect((await Promise.all([run(request.transactionId), run(request.transactionId)])).sort()).toEqual([0, 1]);
    expect(loadHumanAuthorization(root, approvalRef).attempts).toHaveLength(1);
  });

  it("counts rejection/unknown outcomes, refuses replay, and preserves separate cleanup allowance", () => {
    const { root, register, binding } = fixture(); const approvalRef = register();
    created(root, approvalRef, binding);
    const first = reserveWriteAttempt(root, approvalRef, binding, request, clock());
    expect(() => reserveWriteAttempt(root, approvalRef, binding, { ...request, attemptId: first.attemptId }, clock())).toThrow("HUMAN_WRITE_ATTEMPT_ALREADY_RESERVED");
    recordWriteOutcome(root, approvalRef, { attemptId: first.attemptId, status: "unknown", evidenceHash: digest });
    expect(() => reserveWriteAttempt(root, approvalRef, binding, { ...request, transactionId: "another" }, clock())).toThrow("HUMAN_WRITE_OUTCOME_UNRESOLVED");
    recordWriteOutcome(root, approvalRef, { attemptId: first.attemptId, status: "rejected", evidenceHash: head + "a".repeat(24) });
    const second = reserveWriteAttempt(root, approvalRef, binding, request, clock());
    recordWriteOutcome(root, approvalRef, { attemptId: second.attemptId, status: "applied", evidenceHash: digest });
    recordWriteOutcome(root, approvalRef, { attemptId: second.attemptId, status: "applied", evidenceHash: digest });
    expect(() => recordWriteOutcome(root, approvalRef, { attemptId: second.attemptId, status: "rejected", evidenceHash: digest })).toThrow("HUMAN_WRITE_OUTCOME_FINAL");
    expect(() => reserveWriteAttempt(root, approvalRef, binding, request, clock())).toThrow("HUMAN_WRITE_BUDGET_EXHAUSTED");
    const cleanup = reserveWriteAttempt(root, approvalRef, binding, { transactionId: "cleanup", operation: "cleanup", ref, head: null, expected: head }, clock("Fri, 04 Sep 2026 05:30:00 GMT"));
    recordWriteOutcome(root, approvalRef, { attemptId: cleanup.attemptId, status: "applied", evidenceHash: digest });
    expect(loadHumanAuthorization(root, approvalRef).attempts).toHaveLength(3);
    expect(() => reserveWriteAttempt(root, approvalRef, binding, { ...cleanup, attemptId: undefined }, clock("Fri, 04 Sep 2026 05:30:00 GMT"))).toThrow("HUMAN_WRITE_BUDGET_EXHAUSTED");
  });

  it("does not lose a reservation after LKG tail loss or use expired/revoked authority", () => {
    const { root, register, approval, binding } = fixture(); const approvalRef = register();
    created(root, approvalRef, binding);
    const first = reserveWriteAttempt(root, approvalRef, binding, request, clock());
    rmSync(join(root, "harness/lkg/approval-human/records/000000000004.json"));
    expect(() => loadHumanAuthorization(root, approvalRef)).toThrow("HUMAN_AUTHORIZATION_RECOVERY_REQUIRED");
    expect(() => reserveWriteAttempt(root, approvalRef, binding, { ...request, transactionId: "retry" }, clock())).toThrow("HUMAN_WRITE_OUTCOME_UNRESOLVED");
    expect(loadHumanAuthorization(root, approvalRef).attempts).toHaveLength(1);
    recordWriteOutcome(root, approvalRef, { attemptId: first.attemptId, status: "rejected", evidenceHash: digest });
    expect(() => reserveWriteAttempt(root, approvalRef, binding, request, clock("Fri, 04 Sep 2026 05:00:00 GMT"))).toThrow("COORDINATION_LEASE_WINDOW_EXHAUSTED");
    revokeHumanAuthorization(root, approvalRef, "explicit test revoke"); revokeHumanAuthorization(root, approvalRef, "same revoke");
    expect(() => reserveWriteAttempt(root, approvalRef, binding, request, clock())).toThrow("HUMAN_AUTHORIZATION_BINDING_MISMATCH");
    expect(() => recordHumanApproval(root, approval, approval.packet.planHash)).toThrow("HUMAN_APPROVAL_ALREADY_RECORDED");
    const eventPath = join(root, "harness/receipts/approval-human", approvalRef, "events/000000000001.json");
    const event = JSON.parse(readFileSync(eventPath, "utf8")); event.snapshot.scope.maxWriteAttempts = 99; writeFileSync(eventPath, JSON.stringify(event));
    expect(() => loadHumanAuthorization(root, approvalRef)).toThrow("RECEIPT_CHAIN_TAMPERED");
  });

  it("reserves before generation, keeps failed slots spent, and recovers unknown creation without replay", () => {
    const { root, register, binding } = fixture(); const approvalRef = register();
    const first = reserveCandidateQuota(root, approvalRef, binding, intent, clock());
    rmSync(join(root, "harness/lkg/approval-human/records/000000000002.json"));
    expect(() => loadHumanAuthorization(root, approvalRef)).toThrow("HUMAN_AUTHORIZATION_RECOVERY_REQUIRED");
    expect(() => reserveCandidateQuota(root, approvalRef, binding, intent, clock())).toThrow("HUMAN_WRITE_OUTCOME_UNRESOLVED");
    recordCandidateResult(root, approvalRef, { candidateId: first.candidateId, status: "unknown", head: null, evidenceHash: digest });
    expect(() => reserveWriteAttempt(root, approvalRef, binding, request, clock())).toThrow("HUMAN_WRITE_OUTCOME_UNRESOLVED");
    recordCandidateResult(root, approvalRef, { candidateId: first.candidateId, status: "failed", head: null, evidenceHash: digest });
    expect(() => recordCandidateResult(root, approvalRef, { candidateId: first.candidateId, status: "created", head, evidenceHash: digest })).toThrow("HUMAN_CANDIDATE_RESULT_FINAL");
    created(root, approvalRef, binding);
    expect(() => reserveCandidateQuota(root, approvalRef, binding, intent, clock())).toThrow("HUMAN_COMMIT_BUDGET_EXHAUSTED");
    const state = loadHumanAuthorization(root, approvalRef);
    expect(state.candidates).toHaveLength(2); expect(state.attempts).toHaveLength(0);
    const attempt = reserveWriteAttempt(root, approvalRef, binding, request, clock());
    expect(attempt.candidateId).toBe(state.candidates[1].candidateId);
  });

  it("binds takeover to one exact transaction and leaves adopted-config runtime outside the expired enable ticket", () => {
    const productionBinding = { ...binding, controlEpoch: { ...binding.controlEpoch, mode: "production" as const } };
    const takeover = takeoverScope(productionBinding);
    const first = fixture(takeover); const approvalRef = first.register();
    expect(() => created(first.root, approvalRef, first.binding)).toThrow("HUMAN_WRITE_SCOPE_MISMATCH");
    created(first.root, approvalRef, first.binding, "takeover-1");
    expect(() => reserveWriteAttempt(first.root, approvalRef, first.binding, { ...request, operation: "cas", expected: head }, clock())).toThrow("HUMAN_CANDIDATE_UNPROVEN");
    const attempt = reserveWriteAttempt(first.root, approvalRef, first.binding, { ...request, operation: "cas", expected: head, transactionId: "takeover-1" }, clock());
    recordWriteOutcome(first.root, approvalRef, { attemptId: attempt.attemptId, status: "applied", evidenceHash: digest });
    expect(() => reserveWriteAttempt(first.root, approvalRef, first.binding, { ...attempt, attemptId: undefined }, clock())).toThrow("HUMAN_WRITE_BUDGET_EXHAUSTED");
    const enable: HumanScope = { kind: "production-enable", binding: productionBinding, expiresAt: scope.expiresAt, configBeforeHash: null, configAfterHash: digest, controlRef: ref,
      genesisSha: head, genesisTree: head, qualificationEvidenceHash: digest, maxBootstrapAttempts: 1 };
    const second = fixture(enable); const enabledRef = second.register();
    expect(() => reserveWriteAttempt(second.root, enabledRef, second.binding, request, clock("Fri, 04 Sep 2026 05:00:00 GMT"))).toThrow("COORDINATION_LEASE_WINDOW_EXHAUSTED");
    // Loading history is always read-only; ongoing production authority must come from a separate validated adoption receipt.
    expect(loadHumanAuthorization(second.root, enabledRef).approval.scope.kind).toBe("production-enable");
  });

  it("permanently subtracts static child allocations and rejects mismatched or duplicate child approval", () => {
    const allocation = { allocationId: "takeover-slot", workItem: "github:owner/repo#1", controlRef: ref, sourceRef: "refs/heads/fixture", genesisSha: head, maxCommits: 2, maxWriteAttempts: 2 };
    const parent = fixture({ ...scope, refs: [ref, allocation.sourceRef], maxCommits: 3, maxWriteAttempts: 3, takeoverAllocations: [allocation] });
    const parentRef = parent.register(); created(parent.root, parentRef, parent.binding);
    const first = reserveWriteAttempt(parent.root, parentRef, parent.binding, request, clock());
    recordWriteOutcome(parent.root, parentRef, { attemptId: first.attemptId, status: "applied", evidenceHash: digest });
    expect(() => created(parent.root, parentRef, parent.binding)).toThrow("HUMAN_COMMIT_BUDGET_EXHAUSTED");
    expect(() => reserveWriteAttempt(parent.root, parentRef, parent.binding, request, clock())).toThrow("HUMAN_WRITE_BUDGET_EXHAUSTED");
    const childScope = { ...takeoverScope(parent.binding), qualification: { parentApprovalRef: parentRef, runId: scope.runId, allocationId: allocation.allocationId, genesisSha: head } };
    for (const changed of [ { ...childScope, maxCommits: 3 }, { ...childScope, qualification: { ...childScope.qualification, genesisSha: "c".repeat(40) } } ]) {
      expect(() => fixture(changed, parent.root).register()).toThrow("HUMAN_PARENT_SCOPE_MISMATCH");
    }
    const child = fixture(childScope, parent.root); const childRef = child.register(); expect(child.register()).toBe(childRef);
    expect(() => fixture({ ...childScope, transactionId: "another-ticket" }, parent.root).register()).toThrow("HUMAN_ALLOCATION_ALREADY_BOUND");
    revokeHumanAuthorization(parent.root, childRef, "unused but not refundable");
    expect(() => fixture({ ...childScope, transactionId: "replacement" }, parent.root).register()).toThrow("HUMAN_ALLOCATION_ALREADY_BOUND");
    expect(() => created(parent.root, parentRef, parent.binding)).toThrow("HUMAN_COMMIT_BUDGET_EXHAUSTED");
  });

  it("retains allocation ownership across an unindexed approval and permits fact recovery after parent revocation", () => {
    const allocation = { allocationId: "recover-slot", workItem: "github:owner/repo#1", controlRef: ref, sourceRef: "refs/heads/fixture", genesisSha: head, maxCommits: 2, maxWriteAttempts: 2 };
    const parent = fixture({ ...scope, refs: [ref, allocation.sourceRef], maxCommits: 3, maxWriteAttempts: 3, takeoverAllocations: [allocation] }); const parentRef = parent.register();
    const child = fixture({ ...takeoverScope(parent.binding), qualification: { parentApprovalRef: parentRef, runId: scope.runId, allocationId: allocation.allocationId, genesisSha: head } }, parent.root);
    const childRef = child.register(); rmSync(join(parent.root, "harness/lkg/approval-human/records/000000000002.json"));
    expect(() => fixture({ ...child.approval.scope, transactionId: "duplicate" } as HumanScope, parent.root).register()).toThrow("HUMAN_AUTHORIZATION_RECOVERY_REQUIRED");
    expect(child.register()).toBe(childRef); created(parent.root, childRef, parent.binding, "takeover-1");
    const attempt = reserveWriteAttempt(parent.root, childRef, parent.binding, { ...request, operation: "cas", expected: head, transactionId: "takeover-1" }, clock());
    recordWriteOutcome(parent.root, childRef, { attemptId: attempt.attemptId, status: "unknown", evidenceHash: digest });
    revokeHumanAuthorization(parent.root, parentRef, "parent revoked");
    expect(loadHumanAuthorization(parent.root, childRef).attempts[0].outcome?.status).toBe("unknown");
    recordWriteOutcome(parent.root, childRef, { attemptId: attempt.attemptId, status: "applied", evidenceHash: digest });
    expect(() => created(parent.root, childRef, parent.binding, "takeover-1")).toThrow("HUMAN_PARENT_REVOKED");
    expect(() => reserveWriteAttempt(parent.root, childRef, parent.binding, { ...request, operation: "cas", expected: head, transactionId: "takeover-1" }, clock())).toThrow("HUMAN_PARENT_REVOKED");
  });

  it("allows only one process to bind a child and stops new child actions after the parent's time window", async () => {
    const allocation = { allocationId: "race-slot", workItem: "github:owner/repo#1", controlRef: ref, sourceRef: "refs/heads/fixture", genesisSha: head, maxCommits: 2, maxWriteAttempts: 2 };
    const parent = fixture({ ...scope, refs: [ref, allocation.sourceRef], maxCommits: 3, maxWriteAttempts: 3, takeoverAllocations: [allocation] }); const parentRef = parent.register();
    const childScope = { ...takeoverScope(parent.binding), qualification: { parentApprovalRef: parentRef, runId: scope.runId, allocationId: allocation.allocationId, genesisSha: head } };
    const children = [fixture(childScope, parent.root), fixture({ ...childScope, transactionId: "other" }, parent.root)];
    const source = new URL("./human.ts", import.meta.url).href; const clockSource = new URL("../coordination/clock.ts", import.meta.url).href;
    const run = (child: typeof children[number]) => new Promise<number | null>((resolve, reject) => {
      const script = `import {recordHumanApproval} from ${JSON.stringify(source)};import {CoordinationClock} from ${JSON.stringify(clockSource)};try{const c=new CoordinationClock(()=>({monotonicMs:0,wallMs:0}));c.observe('Fri, 04 Sep 2026 04:00:00 GMT',c.start());const a=JSON.parse(process.argv[2]);recordHumanApproval(process.argv[1],a,a.packet.planHash,c);}catch{process.exitCode=1;}`;
      const processChild = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, parent.root, JSON.stringify(child.approval)], { stdio: "ignore" });
      processChild.once("error", reject); processChild.once("exit", resolve);
    });
    expect((await Promise.all(children.map(run))).sort()).toEqual([0, 1]);
    const references = listReceiptTransactions({ root: parent.root, domain: "approval-human" }); expect(references).toHaveLength(2);
    const childRef = references.find((value) => value !== parentRef)!; const childScopeActual = loadHumanAuthorization(parent.root, childRef).approval.scope;
    if (childScopeActual.kind !== "takeover") throw new Error("fixture child missing");
    expect(() => reserveCandidateQuota(parent.root, childRef, parent.binding, { ...intent, parentSha: head, transactionId: childScopeActual.transactionId },
      clock("Fri, 04 Sep 2026 05:00:00 GMT"))).toThrow("COORDINATION_LEASE_WINDOW_EXHAUSTED");
    expect(loadHumanAuthorization(parent.root, childRef).candidates).toEqual([]);
  });
});
