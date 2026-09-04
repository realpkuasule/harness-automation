import { mkdtempSync, realpathSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { loadHumanAuthorization, recordHumanApproval, type HumanScope } from "../approval/human.js";
import { createSemanticApprovalPacket } from "../approval/service.js";
import { hashObject } from "../v2/fs.js";
import { humanCoordinationGuards, recoverHumanSyntheticWrite } from "./authorization.js";
import { CoordinationClock } from "./clock.js";
import { objectGit } from "./objects.js";
import { recoverSourceFixture, runApprovedSourceFixture } from "./publication.js";
import { createCoordinationRecord } from "./record.js";
import { GitCoordinationStore } from "./store.js";
import { prepareSyntheticObject, type SyntheticScope } from "./synthetic.js";
import { fixtureGenesis, localHistory, localTransport } from "./__fixtures__/transport.js";
import { coordinationPushOutcome } from "./push_result.js";

const roots: string[] = []; const digest = "a".repeat(64); const controlRef = "refs/heads/control"; const sourceRef = "refs/heads/source";
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture(maxCommits = 8, sharedRemote?: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "approved-publication-"))); roots.push(root);
  const remote = sharedRemote ?? join(root, "remote.git"); if (!sharedRemote) objectGit(root, ["init", "--bare", "--quiet", "--template=", remote]);
  const genesis = fixtureGenesis(); const source = prepareSyntheticObject("source-fixture", { ...genesis.metadata, objectId: "source" });
  const next = prepareSyntheticObject("source-fixture", { ...genesis.metadata, objectId: "source-next" }, [source.commitSha]);
  const synthetic: SyntheticScope = { objects: [genesis, source, next], controls: [{ fixtureId: "genesis", ref: controlRef }], publications: [
    { fixtureId: "genesis", transactionId: "bootstrap", ref: controlRef, expected: null },
    { fixtureId: "source", transactionId: "source-create", ref: sourceRef, expected: null },
    { fixtureId: "source-next", transactionId: "source-update", ref: sourceRef, expected: source.commitSha },
  ] };
  const binding = { commonDir: root, repository: "owner/repo", repositoryId: "R_1", endpointHash: digest, credentialBindingHash: digest,
    credentialRef: "git", credentialPurpose: "git-transport" as const, actor: "fixture", hostId: "741ba5a8-40e2-4848-b5a4-082f4f2145a9", configHash: digest,
    controlEpoch: { schemaVersion: "coordination-epoch/1" as const, protocol: "github-coordination/1.0" as const, mode: "isolated-qualification" as const, coordinationConfigDigest: digest, policy: { kind: "none" as const } },
    implementation: { kind: "package" as const, artifactDigest: digest }, runnerHash: digest };
  const scope: HumanScope = { kind: "qualification-run", binding, runId: genesis.metadata.runId, synthetic, refs: [controlRef, sourceRef], operations: ["create", "cas"],
    maxCommits, maxWriteAttempts: maxCommits, maxCleanupAttempts: 2, expiresAt: "2026-09-04T05:00:00.000Z", cleanupExpiresAt: "2026-09-04T06:00:00.000Z" };
  const inputHash = hashObject(scope); const planHash = hashObject({ inputHash });
  const packet = createSemanticApprovalPacket({ planHash, inputHash, producerIdentity: "local-fixture",
    binding: { planHash, inputDigest: inputHash, contextDigest: digest, policyDigest: digest, observedHash: inputHash },
    actions: [{ id: scope.kind, kind: "permission-change", protected: true, summary: "Disposable LOCAL empty objects", before: null, after: inputHash, reversible: true, recovery: "Read back without replay" }] });
  const approvalRef = recordHumanApproval(root, { packet, scope, approvedBy: "fixture-human", approvedAt: "2026-09-04T03:00:00.000Z", source: { kind: "explicit-human", messageHash: digest } }, planHash);
  let date = "Fri, 04 Sep 2026 04:00:00 GMT"; let pushes = 0; let beforeDispatch = () => {}; let uncertain = false;
  const clock = () => { const clock = new CoordinationClock(() => ({ monotonicMs: 0, wallMs: 0 })); clock.observe(date, clock.start()); return clock; };
  const guards = humanCoordinationGuards(root, approvalRef, () => binding, clock); const local = localTransport(root, remote);
  const transport = { ...local, push(directory: string, head: string, ref: string, expected: string | null) {
    guards.authorizeWrite({ ...binding, ref, head, expected }); beforeDispatch(); pushes++;
    const result = local.push(directory, head, ref, expected);
    return uncertain ? { ...result, status: null, error: "connection interrupted" } : result;
  } };
  const observations: { directory: string; commits: number }[] = [];
  const beforeCommit: typeof guards.beforeCommit = (intent) => {
    roots.push(intent.objectDirectory);
    observations.push({ directory: intent.objectDirectory, commits: objectGit(intent.objectDirectory, ["cat-file", "--batch-all-objects", "--batch-check=%(objecttype)"]).split("\n").filter((type) => type === "commit").length });
    return guards.beforeCommit(intent);
  };
  const store = new GitCoordinationStore(controlRef, transport, guards.beforePush, genesis, localHistory(root, controlRef, genesis), beforeCommit);
  return { root, remote, genesis, source, next, synthetic, store, local, transport, approvalRef, observations, guards,
    state: () => loadHumanAuthorization(root, approvalRef), pushes: () => pushes,
    bootstrap: () => store.bootstrap(synthetic.publications[0], guards.beforeSyntheticPush),
    sourceFixture: (id: string) => runApprovedSourceFixture(transport, synthetic, id, beforeCommit, guards.beforeSyntheticPush),
    race: (run: () => void) => { beforeDispatch = run; }, uncertain: () => { uncertain = true; }, expire: () => { date = "Fri, 04 Sep 2026 06:00:00 GMT"; } };
}

it("materializes only after quota, then makes the first business record a single-parent child of approved empty genesis", () => {
  const f = fixture();
  const record = createCoordinationRecord({ repository: "owner/repo", repositoryId: "R_1", workItem: "github:owner/repo#86", branch: "source", sourceRepositoryId: "R_1", owner: "fixture", machine: "host", generation: 1,
    controlEpochDigest: digest, createdAt: "2026-09-04T04:00:00.000Z", expiresAt: "2026-09-04T04:01:00.000Z", lastObservedHead: "b".repeat(40), lifecycleState: "Admitted", transactionId: "first" });
  expect(() => f.store.compareAndSwap({ workItem: record.workItem, expectedControlSha: null, expected: {}, next: record })).toThrow("COORDINATION_BOOTSTRAP_AUTHORIZATION_REQUIRED");
  expect(f.state().candidates).toHaveLength(0);
  const bootstrap = f.bootstrap(); expect(bootstrap.observedHead).toBe(f.genesis.commitSha);
  expect(f.observations[0].commits).toBe(0); expect(f.store.read(record.workItem)).toEqual({ controlSha: f.genesis.commitSha, record: null });
  const saved = f.store.compareAndSwap({ workItem: record.workItem, expectedControlSha: f.genesis.commitSha, expected: {}, next: record });
  expect(objectGit(f.remote, ["show", "-s", "--format=%P", saved.candidate.controlSha]).trim()).toBe(f.genesis.commitSha);
  expect(f.state().candidates.map((value) => value.subject.kind)).toEqual(["control-genesis", "coordination-record"]);
  expect(f.store.recoverBootstrap(bootstrap.candidate).observedHead).toBe(saved.candidate.controlSha);
  const bad = objectGit(f.remote, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit-tree", f.genesis.treeSha, "-p", saved.candidate.controlSha], "unapproved empty descendant\n").trim();
  objectGit(f.remote, ["update-ref", controlRef, bad]); expect(() => f.store.read(record.workItem)).toThrow("COORDINATION_TREE_INVALID");
  const exhausted = fixture(1); exhausted.bootstrap();
  expect(() => exhausted.sourceFixture("source")).toThrow("HUMAN_COMMIT_BUDGET_EXHAUSTED");
  expect(exhausted.observations[1].commits).toBe(0); expect(existsSync(exhausted.observations[1].directory)).toBe(false);
  expect(exhausted.local.readRef(sourceRef)).toBeNull(); expect(exhausted.pushes()).toBe(1);
});

it("publishes only exact approved source bytes and fetches, rather than recreates, approved ancestors", () => {
  const f = fixture(); f.bootstrap(); const first = f.sourceFixture("source"); const next = f.sourceFixture("source-next");
  expect(f.observations.map((value) => value.commits)).toEqual([0, 0, 1]);
  expect(f.state().candidates).toHaveLength(3); expect(f.state().attempts).toHaveLength(3);
  expect(objectGit(f.remote, ["cat-file", "commit", f.next.commitSha])).toBe(f.next.commitText);
  expect(recoverSourceFixture(f.transport, f.synthetic, first.candidate).observedHead).toBe(next.candidate.head);
  expect(() => f.sourceFixture("genesis")).toThrow("HUMAN_SYNTHETIC_SCOPE_REQUIRED");
  expect(() => f.sourceFixture("arbitrary")).toThrow("HUMAN_SYNTHETIC_SCOPE_REQUIRED");
  expect(() => recoverSourceFixture(f.transport, f.synthetic, { ...first.candidate, ref: controlRef })).toThrow("COORDINATION_RECOVERY_REQUIRED");
  expect(f.pushes()).toBe(3);
});

it("observes an interrupted bootstrap after expiry without inventing attempt attribution or issuing a lease", () => {
  const f = fixture(); f.uncertain(); expect(() => f.bootstrap()).toThrow("COORDINATION_WRITE_OUTCOME_UNKNOWN");
  const attempt = f.state().attempts[0]; expect(attempt.outcome?.status).toBe("unknown");
  expect(existsSync(f.state().candidates[0].objectDirectory)).toBe(true); f.expire();
  expect(recoverHumanSyntheticWrite(f.root, f.approvalRef, attempt.attemptId, f.store, f.transport)).toMatchObject({ observedHead: f.genesis.commitSha, status: "state-observed" });
  expect(f.state().attempts[0].outcome?.status).toBe("unknown");
  recoverHumanSyntheticWrite(f.root, f.approvalRef, attempt.attemptId, f.store, f.transport);
  expect(f.pushes()).toBe(1); expect(f.state().candidates).toHaveLength(1); expect(f.store.read("absent").record).toBeNull();
});

it("uses durable positive push evidence to finish failed readback after expiry without a new dispatch", () => {
  const f = fixture(); const readback = vi.spyOn(f.store, "recoverBootstrap").mockImplementationOnce(() => { throw new Error("READBACK_FAILED"); });
  expect(() => f.bootstrap()).toThrow("READBACK_FAILED"); readback.mockRestore();
  const attempt = f.state().attempts[0]; expect(attempt.outcome).toMatchObject({ status: "unknown", push: { status: 0, error: null } });
  f.expire(); expect(recoverHumanSyntheticWrite(f.root, f.approvalRef, attempt.attemptId, f.store, f.transport).status).toBe("applied");
  expect(f.state().attempts[0].outcome?.status).toBe("applied"); expect(f.pushes()).toBe(1); expect(f.state().candidates).toHaveLength(1);
});

it("preserves both readback and finalization errors for synthetic publication", () => {
  const f = fixture(); const before = f.guards.beforeSyntheticPush;
  vi.spyOn(f.store, "recoverBootstrap").mockImplementation(() => { throw new Error("READBACK_FAILED"); });
  vi.spyOn(f.guards, "beforeSyntheticPush").mockImplementation((candidate) => {
    const recorder = before(candidate); const finish = recorder.finish;
    recorder.finish = () => { finish(); throw new Error("RELEASE_REPORT_FAILED"); }; return recorder;
  });
  let failure: unknown; try { f.bootstrap(); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors.map((error: Error) => error.message)).toEqual(["READBACK_FAILED", "RELEASE_REPORT_FAILED"]);
  expect(f.state().attempts[0].outcome?.status).toBe("unknown");
});

it("does not count a same-SHA up-to-date race loser as an applied bootstrap", () => {
  const loser = fixture(); const winner = fixture(8, loser.remote); loser.race(() => { winner.bootstrap(); });
  expect(() => loser.bootstrap()).toThrow("COORDINATION_CAS_NOT_PERFORMED");
  expect(loser.state().attempts[0].outcome?.status).toBe("rejected");
  expect(winner.state().attempts[0].outcome?.status).toBe("applied");
  expect(() => recoverHumanSyntheticWrite(loser.root, loser.approvalRef, loser.state().attempts[0].attemptId, loser.store, loser.transport)).toThrow("COORDINATION_RECOVERY_REQUIRED");
  const source = new URL("./authorization.ts", import.meta.url).href;
  const script = `import {recoverHumanSyntheticWrite} from ${JSON.stringify(source)};try{recoverHumanSyntheticWrite(process.argv[1],process.argv[2],process.argv[3],{recoverBootstrap(){throw Error('READBACK_CALLED')}},{repository:'owner/repo',repositoryId:'R_1'});process.exitCode=1}catch(e){if(e.message!=='COORDINATION_RECOVERY_REQUIRED')throw e}`;
  execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, loser.root, loser.approvalRef, loser.state().attempts[0].attemptId]);
  expect(loser.state().attempts[0].outcome?.status).toBe("rejected");
});

it("requires one complete exact-ref porcelain result, not a success exit, substring or truncated output", () => {
  const head = "a".repeat(40); const line = `*\t${head}:${controlRef}\t[new branch]`;
  const result = { status: 0, stdout: `To fixture\n${line}\nDone\n`, error: null };
  expect(coordinationPushOutcome(result, head, controlRef)).toBe("updated");
  for (const changed of [{ ...result, stdout: `${line}\n` }, { ...result, stdout: `${line}\n${line}\nDone\n` },
    { ...result, stdout: "Everything up-to-date\n" }, { ...result, error: "truncated" }, { ...result, stdout: `${result.stdout}trailing garbage\n` }]) {
    expect(coordinationPushOutcome(changed, head, controlRef)).toBe("unknown");
  }
  expect(coordinationPushOutcome(result, head, sourceRef)).toBe("unknown");
});
