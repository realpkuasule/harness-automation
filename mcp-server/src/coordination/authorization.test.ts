import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createSemanticApprovalPacket } from "../approval/service.js";
import { loadHumanAuthorization, recordHumanApproval, type HumanScope } from "../approval/human.js";
import { hashObject } from "../v2/fs.js";
import { localHistory, localTransport } from "./__fixtures__/transport.js";
import { humanCoordinationGuards, recoverHumanCoordinationWrite } from "./authorization.js";
import { CoordinationClock } from "./clock.js";
import { createCoordinationRecord } from "./record.js";
import { GitCoordinationStore, type CoordinationCandidate } from "./store.js";

const roots: string[] = []; const digest = "a".repeat(64); const sha = "b".repeat(40);
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "qualification-composition-"))); roots.push(root);
  const remote = join(root, "remote.git"); execFileSync("git", ["init", "--bare", "--quiet", remote]);
  const controlRef = "refs/heads/synthetic-run";
  const binding = { commonDir: root, repository: "owner/repo", repositoryId: "R_1", endpointHash: digest, credentialBindingHash: digest,
    credentialRef: "git", credentialPurpose: "git-transport" as const, actor: "octo", hostId: "741ba5a8-40e2-4848-b5a4-082f4f2145a9",
    configHash: digest, implementation: { kind: "source" as const, head: sha, tree: sha, artifactDigest: digest }, runnerHash: digest };
  const bound = { ...binding, controlEpoch: { schemaVersion: "coordination-epoch/1" as const, protocol: "github-coordination/1.0" as const,
    mode: "isolated-qualification" as const, coordinationConfigDigest: digest, policy: { kind: "none" as const } } };
  const scope: HumanScope = { kind: "qualification-run", binding: bound, runId: "fixture", refs: [controlRef], operations: ["create", "cas"],
    maxCommits: 2, maxWriteAttempts: 2, maxCleanupAttempts: 1, expiresAt: "2026-09-04T05:00:00.000Z", cleanupExpiresAt: "2026-09-04T06:00:00.000Z" };
  const inputHash = hashObject(scope); const planHash = hashObject({ inputHash });
  const packet = createSemanticApprovalPacket({ planHash, inputHash, producerIdentity: "isolated-fixture",
    binding: { planHash, inputDigest: inputHash, contextDigest: digest, observedHash: digest, policyDigest: digest },
    actions: [{ id: scope.kind, kind: "permission-change", protected: true, summary: "LOCAL fixture only", before: null, after: inputHash, reversible: true, recovery: "Retain unknown objects" }] });
  const approvalRef = recordHumanApproval(root, { packet, scope, approvedBy: "fixture-human", approvedAt: "2026-09-04T03:00:00.000Z", source: { kind: "explicit-human", messageHash: digest } }, planHash);
  const clock = () => { const value = new CoordinationClock(() => ({ monotonicMs: 0, wallMs: 0 })); value.observe("Fri, 04 Sep 2026 04:00:00 GMT", value.start()); return value; };
  let observed = bound; const guards = humanCoordinationGuards(root, approvalRef, () => observed, clock);
  const transport = localTransport(root, remote); let pushes = 0; let genesis = ""; let candidate: CoordinationCandidate | undefined;
  const store = new GitCoordinationStore(controlRef, { ...transport, push(directory, head, ref, expected) {
    guards.authorizeWrite({ ...binding, ref, head, expected }); pushes++;
    return transport.push(directory, head, ref, expected);
  } }, (value) => { candidate = value; if (!value.expectedControlSha) genesis = value.controlSha; return guards.beforePush(value); },
  true, localHistory(root, controlRef, () => genesis), guards.beforeCommit);
  const record = createCoordinationRecord({ repository: binding.repository, repositoryId: binding.repositoryId, workItem: "github:owner/repo#1", branch: "codex/fixture",
    sourceRepositoryId: binding.repositoryId, owner: binding.actor, machine: binding.hostId, generation: 1, controlEpochDigest: digest,
    createdAt: "2026-09-04T04:00:00.000Z", expiresAt: "2026-09-04T04:01:00.000Z", lastObservedHead: sha, lifecycleState: "Admitted", transactionId: "tx-1" });
  return { root, approvalRef, binding, store, record, guards, transport, controlRef, candidate: () => candidate!, pushes: () => pushes,
    drift: () => { observed = { ...bound, configHash: "d".repeat(64) }; },
    state: () => loadHumanAuthorization(root, approvalRef),
    acquire: () => store.compareAndSwap({ workItem: record.workItem, expectedControlSha: null, expected: {}, next: record }) };
}

it("connects commit quota, per-dispatch authority and exact readback through one real LOCAL Git CAS", () => {
  const f = fixture(); const applied = f.acquire();
  expect(f.pushes()).toBe(1);
  expect(f.state().candidates[0].result).toMatchObject({ status: "created", head: applied.candidate.controlSha });
  expect(f.state().attempts[0].outcome?.status).toBe("applied");
  expect(f.transport.readRef(f.controlRef)).toBe(applied.candidate.controlSha);
  expect(() => f.guards.authorizeWrite({ ...f.binding, ref: f.controlRef, head: applied.candidate.controlSha, expected: null })).toThrow("COORDINATION_WRITE_NOT_PREPARED");
});

it("records unknown instead of Applied when a successful push lacks authenticated history readback", () => {
  const f = fixture(); const recover = vi.spyOn(f.store, "recover").mockImplementationOnce(() => { throw new Error("READBACK_FAILED"); });
  expect(() => f.acquire()).toThrow("READBACK_FAILED"); roots.push(f.candidate().objectDirectory);
  expect(f.state().attempts[0].outcome?.status).toBe("unknown");
  expect(() => f.guards.beforeCommit({ transactionId: "retry", parentSha: null, treeSha: sha,
    subject: { kind: "coordination-record", workItem: f.record.workItem, recordHash: digest }, commitMetadataHash: digest, objectDirectory: f.root })).toThrow("HUMAN_WRITE_OUTCOME_UNRESOLVED");
  recover.mockRestore();
  expect(f.store.recover(f.candidate()).disposition).toBe("current"); expect(f.pushes()).toBe(1);
  expect(f.state().attempts[0].outcome?.status).toBe("unknown");
  const attemptId = f.state().attempts[0].attemptId;
  expect(recoverHumanCoordinationWrite(f.root, f.approvalRef, attemptId, f.store).disposition).toBe("current");
  expect(f.state().attempts[0].outcome?.status).toBe("applied");
  recoverHumanCoordinationWrite(f.root, f.approvalRef, attemptId, f.store);
  expect(f.pushes()).toBe(1); expect(f.state().attempts).toHaveLength(1); expect(f.state().candidates).toHaveLength(1);
});

it("rechecks changed bindings after candidate creation without dispatching or refunding its slot", () => {
  const f = fixture(); const before = f.guards.beforePush;
  // The Store's callback captures the guards object: drift occurs between generation and authorization.
  vi.spyOn(f.guards, "beforePush").mockImplementation((candidate) => { const finish = before(candidate); f.drift(); return finish; });
  expect(() => f.acquire()).toThrow("HUMAN_AUTHORIZATION_BINDING_MISMATCH"); roots.push(f.candidate().objectDirectory);
  expect(f.pushes()).toBe(0); expect(f.state().candidates).toHaveLength(1); expect(f.state().attempts).toHaveLength(0);
  expect(f.transport.readRef(f.controlRef)).toBeNull();
});
