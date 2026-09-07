import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createCoordinationRecord, expectedRecord } from "./record.js";
import { GitCoordinationStore, type CoordinationCandidate } from "./store.js";
import { fixtureGenesis, localHistory, localTransport, seedLocalGenesis } from "./__fixtures__/transport.js";

const roots: string[] = [];
const ref = "refs/heads/harness-automation/coordination/test";
const first = () => createCoordinationRecord({ repository: "owner/repo", repositoryId: "R_1", workItem: "github:owner/repo#1", branch: "codex/one", sourceRepositoryId: "R_1", owner: "octo", machine: "mac", generation: 1, controlEpochDigest: "a".repeat(64), createdAt: "2026-09-04T04:00:00.000Z", expiresAt: "2026-09-04T04:01:00.000Z", lastObservedHead: "b".repeat(40), lifecycleState: "Admitted", transactionId: "tx-first" });
function git(cwd: string, args: string[], input?: string) {
  const result = spawnSync("git", args, { cwd, input, encoding: "utf8", env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" } });
  if (result.status !== 0) throw new Error(result.stderr); return result.stdout.trim();
}
function fixture(seed = true) {
  const root = mkdtempSync(join(tmpdir(), "harness-object-test-")); roots.push(root);
  const remote = join(root, "remote.git"); git(root, ["init", "--bare", "--quiet", remote]);
  const transport = localTransport(root, remote); const candidates: CoordinationCandidate[] = [];
  const genesis = seed ? seedLocalGenesis(remote, ref) : fixtureGenesis();
  const history = localHistory(root, ref, genesis);
  const beforePush = (candidate: CoordinationCandidate) => { candidates.push(candidate); };
  const store = new GitCoordinationStore(ref, transport, beforePush, genesis, history, () => () => {});
  const record = first();
  return { root, remote, transport, candidates, store, history, beforePush, genesis, record, acquire: () => store.compareAndSwap({ workItem: record.workItem, expectedControlSha: seed ? genesis.commitSha : null, expected: {}, next: record }) };
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
it("requires bootstrap authority and a durable candidate before its sole remote write", () => {
  const absent = fixture(false); expect(() => absent.acquire()).toThrow("COORDINATION_BOOTSTRAP_AUTHORIZATION_REQUIRED");
  const f = fixture(); let pushes = 0;
  const transport = { ...f.transport, push: () => { pushes++; throw new Error("unexpected"); } };
  const args = { workItem: f.record.workItem, expectedControlSha: f.genesis.commitSha, expected: {}, next: f.record };
  expect(() => new GitCoordinationStore(ref, transport, () => {}, f.genesis, f.history).compareAndSwap(args)).toThrow("COORDINATION_CANDIDATE_AUTHORIZATION_REQUIRED");
  expect(() => new GitCoordinationStore(ref, transport, (candidate) => { roots.push(candidate.objectDirectory); throw new Error("receipt failed"); }, f.genesis, f.history, () => () => {}).compareAndSwap(args)).toThrow("receipt failed");
  expect(pushes).toBe(0); expect(f.transport.readRef(ref)).toBe(f.genesis.commitSha);
});
it("rejects unknown paths, symlinks, gitlinks, invalid blobs and fetch failures rather than claiming absence", () => {
  for (const mode of ["100644", "120000", "160000"]) {
    const f = fixture();
    const blob = git(f.remote, ["hash-object", "-w", "--stdin"], mode === "100644" ? "not-json" : "../../outside");
    const empty = git(f.remote, ["mktree"], "");
    const commit = git(f.remote, ["commit-tree", empty], "fixture\n");
    const tree = git(f.remote, ["mktree"], `${mode} ${mode === "160000" ? "commit" : "blob"} ${mode === "160000" ? commit : blob}\tunknown\n`);
    const bad = git(f.remote, ["commit-tree", tree, "-p", f.genesis.commitSha], "bad metadata\n"); git(f.remote, ["update-ref", ref, bad]);
    expect(() => f.store.read(f.record.workItem)).toThrow("COORDINATION_TREE_INVALID");
  }
  const f = fixture(); f.acquire();
  const broken = new GitCoordinationStore(ref, { ...f.transport, fetch: () => { throw new Error("FETCH_DENIED"); } }, () => {}, f.genesis, f.history);
  expect(() => broken.read("github:owner/repo#404")).toThrow("FETCH_DENIED");
});
it("preserves an unknown-outcome candidate and recovers by exact history without repeating the push", () => {
  const f = fixture(); let writes = 0; let candidate: CoordinationCandidate | undefined;
  const uncertain = new GitCoordinationStore(ref, { ...f.transport, push(...args) { writes++; const result = f.transport.push(...args); expect(result.status).toBe(0); return { ...result, status: null, error: "connection interrupted" }; } }, (value) => { candidate = value; f.beforePush(value); }, f.genesis, f.history, () => () => {});
  expect(() => uncertain.compareAndSwap({ workItem: f.record.workItem, expectedControlSha: f.genesis.commitSha, expected: {}, next: f.record })).toThrow("COORDINATION_WRITE_OUTCOME_UNKNOWN");
  expect(candidate).toBeDefined(); roots.push(candidate!.objectDirectory); expect(existsSync(candidate!.objectDirectory)).toBe(true);
  let recoveryWrites = 0;
  const recovery = new GitCoordinationStore(ref, { ...f.transport, push(...args) { recoveryWrites++; return f.transport.push(...args); } }, () => {}, f.genesis, f.history, () => () => {});
  const recovered = recovery.recover(candidate!); expect(recovered.disposition).toBe("current"); expect(writes).toBe(1); expect(recoveryWrites).toBe(0);
  const next = createCoordinationRecord({ ...f.record, owner: "another", generation: 2, transactionId: "tx-second" });
  const applied = f.store.compareAndSwap({ workItem: f.record.workItem, expectedControlSha: recovered.current.controlSha, expected: expectedRecord(f.record), next });
  expect(applied.current.record?.generation).toBe(2);
  expect(f.store.recover(candidate!).disposition).toBe("superseded"); expect(writes).toBe(1);
  expect(() => f.store.recover({ ...candidate!, treeSha: "a".repeat(40) })).toThrow("COORDINATION_RECOVERY_REQUIRED");
});

it("reserves commit quota before creating any commit and records its exact object before push", () => {
  const f = fixture(); const order: string[] = [];
  const commits = (directory: string) => git(directory, ["cat-file", "--batch-all-objects", "--batch-check=%(objecttype)"]).split("\n").filter((type) => type === "commit").length;
  const args = { workItem: f.record.workItem, expectedControlSha: f.genesis.commitSha, expected: {}, next: f.record };
  let refusedDirectory = "";
  const denied = new GitCoordinationStore(ref, f.transport, f.beforePush, f.genesis, f.history, (intent) => {
    refusedDirectory = intent.objectDirectory; expect(commits(intent.objectDirectory)).toBe(1); // Only fetched genesis, no new candidate.
    throw new Error("HUMAN_COMMIT_BUDGET_EXHAUSTED");
  });
  expect(() => denied.compareAndSwap(args)).toThrow("HUMAN_COMMIT_BUDGET_EXHAUSTED");
  expect(existsSync(refusedDirectory)).toBe(false); expect(f.transport.readRef(ref)).toBe(f.genesis.commitSha);
  const store = new GitCoordinationStore(ref, { ...f.transport, push(...params) { order.push("push"); return f.transport.push(...params); } },
    (candidate) => { order.push("candidate"); f.beforePush(candidate); }, f.genesis, f.history, (intent) => {
      expect(commits(intent.objectDirectory)).toBe(1); order.push("reserve");
      expect(intent).toMatchObject({ parentSha: f.genesis.commitSha, transactionId: f.record.transactionId, subject: { kind: "coordination-record", recordHash: f.record.recordHash } });
      return (head) => { expect(head).not.toBeNull(); expect(commits(intent.objectDirectory)).toBe(2); expect(git(intent.objectDirectory, ["show", "-s", "--format=%T", head!])).toBe(intent.treeSha); order.push("created"); };
    });
  store.compareAndSwap(args);
  expect(order).toEqual(["reserve", "created", "candidate", "push"]);
});

it("rejects a bad intermediate tree even when the latest tree returns to valid metadata", () => {
  const f = fixture(); const first = f.acquire().candidate;
  const blob = git(f.remote, ["hash-object", "-w", "--stdin"], "not metadata");
  const badTree = git(f.remote, ["mktree"], `100644 blob ${blob}\tunknown\n`);
  const bad = git(f.remote, ["commit-tree", badTree, "-p", first.controlSha], "invalid intermediate\n");
  const restored = git(f.remote, ["commit-tree", first.treeSha, "-p", bad], "valid latest tree\n");
  git(f.remote, ["update-ref", ref, restored]);
  expect(() => f.store.read(f.record.workItem)).toThrow("COORDINATION_TREE_INVALID");
});

it("prepares two private same-parent CAS candidates and lets Git reject the stale dispatch while preserving another work item", () => {
  const f = fixture(); const other = createCoordinationRecord({ ...f.record, workItem: "github:owner/repo#2", branch: "codex/two", transactionId: "preserved" });
  const base = f.store.compareAndSwap({ workItem: other.workItem, expectedControlSha: f.genesis.commitSha, expected: {}, next: other }).candidate.controlSha;
  const creations: string[] = []; const pushes: Array<{ expected: string | null; head: string; output: string }> = [];
  const stores = ["winner", "loser"].map(() => new GitCoordinationStore(ref, { ...f.transport, push(...args) {
    const result = f.transport.push(...args); pushes.push({ head: args[1], expected: args[3], output: result.stdout }); return result;
  } }, f.beforePush, f.genesis, f.history, (intent) => {
    roots.push(intent.objectDirectory); return (head) => { expect(head).not.toBeNull(); creations.push(head!); };
  }));
  const inputs = stores.map((_, index) => ({ workItem: f.record.workItem, expectedControlSha: base, expected: {},
    next: createCoordinationRecord({ ...f.record, transactionId: `contender-${index}` }) }));
  const prepared = stores.map((store, index) => store.prepareCompareAndSwap(inputs[index]));
  expect(creations).toHaveLength(2); expect(new Set(creations).size).toBe(2); expect(pushes).toEqual([]);
  expect(() => stores[0].dispatchPrepared({ ...prepared[0] })).toThrow("COORDINATION_PREPARATION_UNPROVEN");
  expect(() => stores[1].dispatchPrepared(prepared[0])).toThrow("COORDINATION_PREPARATION_UNPROVEN");
  // Public input mutation after preparation cannot alter its private candidate.
  inputs[0].next.owner = "mutated-after-prepare";
  const winner = stores[0].dispatchPrepared(prepared[0]); expect(winner.current.record?.owner).toBe(f.record.owner);
  expect(() => stores[1].dispatchPrepared(prepared[1])).toThrow("COORDINATION_CAS_CONFLICT");
  expect(pushes).toHaveLength(2); expect(pushes.every((push) => push.expected === base)).toBe(true);
  expect(pushes[0].output).toContain("\t"); expect(pushes[1].output).toContain("[rejected]"); expect(pushes[1].output).toContain("stale info");
  expect(() => stores[0].dispatchPrepared(prepared[0])).toThrow("COORDINATION_PREPARATION_UNPROVEN");
  expect(() => stores[1].dispatchPrepared(prepared[1])).toThrow("COORDINATION_PREPARATION_UNPROVEN");
  expect(pushes).toHaveLength(2); expect(creations).toHaveLength(2);
  expect(f.store.read(other.workItem).record).toEqual(other);
  expect(f.store.read(f.record.workItem).record?.transactionId).toBe("contender-0");
});
