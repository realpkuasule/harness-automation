import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { hashObject, prettyJson } from "../v2/fs.js";
import type { GitCommandResult } from "../repository/git.js";
import { assertExpected, validRecord } from "./record.js";
import type { CoordinationExpected, CoordinationRecord } from "./types.js";
import type { HistoryCheck } from "./history.js";
import { syntheticObjectSchema, type CoordinationCommitSubject, type SyntheticObjectPlan, type SyntheticPublication } from "./synthetic.js";
import { objectDirectory, objectEnv, objectGit, validateSyntheticObject } from "./objects.js";
import { publishSyntheticObject, type SyntheticApplied, type SyntheticCandidate, type SyntheticPushGuard } from "./publication.js";
import { requireCoordinationPush } from "./push_result.js";

export interface CoordinationTransport {
  readonly repository: string;
  readonly repositoryId: string;
  readRef(ref: string): string | null;
  fetch(directory: string, sha: string): void;
  push(directory: string, sha: string, ref: string, expected: string | null): GitCommandResult;
}
export interface CoordinationCandidate {
  controlRef: string;
  expectedControlSha: string | null;
  controlSha: string;
  treeSha: string;
  record: CoordinationRecord;
  objectDirectory: string;
}
export interface CoordinationObservation { controlSha: string | null; record: CoordinationRecord | null; }
export interface CoordinationApplied { candidate: CoordinationCandidate; current: CoordinationObservation; disposition: "current" | "superseded"; }
export interface CoordinationWriteResult { candidate: CoordinationCandidate; pushed?: GitCommandResult; applied?: CoordinationApplied; error?: string; }
export type WriteRecorder<T> = ((result: T) => void) & { finish?: () => void };
export interface CoordinationCommitIntent {
  transactionId: string; parentSha: string | null; treeSha: string; subject: CoordinationCommitSubject;
  objectDirectory: string; commitMetadataHash: string;
}
// Called before commit-tree; the returned recorder runs before any remote dispatch.
export type CoordinationCommitGuard = (intent: CoordinationCommitIntent) => (head: string | null) => void;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const pathFor = (workItem: string) => `records/${hashObject(workItem)}.json`;

/** No checkout, hooks, project config, credential env or second transaction ledger. */
export class GitCoordinationStore {
  constructor(
    private readonly controlRef: string,
    private readonly transport: CoordinationTransport,
    // The use-case must persist this candidate in the existing receipt chain before any push.
    private readonly beforePush: (candidate: CoordinationCandidate) => void | WriteRecorder<CoordinationWriteResult>,
    private readonly genesis?: SyntheticObjectPlan,
    private readonly historyCheck?: HistoryCheck,
    private readonly beforeCommit?: CoordinationCommitGuard,
  ) {
    if (genesis && (syntheticObjectSchema.parse(genesis).kind !== "control-genesis")) throw new Error("COORDINATION_HISTORY_GENESIS_INVALID");
    if (!/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(controlRef) || controlRef.includes("..") || controlRef.endsWith("/") ||
        controlRef.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock") || part.endsWith("."))) throw new Error("COORDINATION_CONTROL_REF_INVALID");
  }
  private directory = objectDirectory;
  private entries(directory: string, sha: string): Map<string, { blob: string; record: CoordinationRecord }> {
    if (!SHA.test(sha) || objectGit(directory, ["cat-file", "-t", sha]).trim() !== "commit") throw new Error("COORDINATION_CONTROL_OBJECT_INVALID");
    const raw = objectGit(directory, ["ls-tree", "-rz", "-t", "--full-tree", sha]);
    if (raw === "" && this.genesis?.commitSha === sha) { validateSyntheticObject(directory, this.genesis); return new Map(); }
    const rows = raw.split("\0");
    if (rows.pop() !== "") throw new Error("COORDINATION_TREE_INVALID");
    const entries = new Map<string, { blob: string; record: CoordinationRecord }>();
    const paths = new Set<string>(); let totalBytes = 0;
    for (const row of rows) {
      const match = /^(\d{6}) (blob|tree) ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/u.exec(row);
      if (!match || paths.has(match[4])) throw new Error("COORDINATION_TREE_INVALID");
      const [, mode, type, blob, path] = match; paths.add(path);
      if (path === "records" && mode === "040000" && type === "tree") continue;
      if (mode !== "100644" || type !== "blob" || !/^records\/[a-f0-9]{64}\.json$/u.test(path)) throw new Error("COORDINATION_TREE_INVALID");
      const bytes = Number(objectGit(directory, ["cat-file", "-s", blob]).trim());
      totalBytes += bytes;
      // ponytail: bounded full-tree validation; shard only after measured repository-scale contention.
      if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > 64 * 1024 || totalBytes > 8 * 1024 * 1024 || entries.size >= 10_000) throw new Error("COORDINATION_TREE_LIMIT_EXCEEDED");
      let record: unknown;
      try { record = JSON.parse(objectGit(directory, ["cat-file", "blob", blob])); } catch { throw new Error("COORDINATION_RECORD_INVALID"); }
      if (!validRecord(record) || pathFor(record.workItem) !== path || record.repository !== this.transport.repository || record.repositoryId !== this.transport.repositoryId) throw new Error("COORDINATION_RECORD_INVALID");
      entries.set(path, { blob, record });
    }
    if (!entries.size || !paths.has("records")) throw new Error("COORDINATION_TREE_INVALID");
    return entries;
  }
  private snapshot(directory: string, workItem: string): CoordinationObservation & { entries: Map<string, { blob: string; record: CoordinationRecord }> } {
    const controlSha = this.transport.readRef(this.controlRef);
    if (controlSha === null) return { controlSha, record: null, entries: new Map() };
    if (!SHA.test(controlSha)) throw new Error("COORDINATION_REMOTE_OBSERVATION_INVALID");
    this.transport.fetch(directory, controlSha);
    if (!this.historyCheck) throw new Error("COORDINATION_HISTORY_ANCHOR_REQUIRED");
    const cache = new Map<string, ReturnType<GitCoordinationStore["entries"]>>();
    const read = (sha: string) => {
      if (!cache.has(sha)) cache.set(sha, this.entries(directory, sha));
      const [treeSha, parents = ""] = objectGit(directory, ["show", "-s", "--format=%T%n%P", sha]).trimEnd().split("\n");
      return { treeSha, parents: parents.split(" ").filter(Boolean) };
    };
    this.historyCheck(controlSha, read, (ancestor, descendant) => {
      const result = spawnSync("git", ["--no-replace-objects", "merge-base", "--is-ancestor", ancestor, descendant], { cwd: directory, env: objectEnv(), encoding: "utf8", timeout: 10_000 });
      if (result.error || (result.status !== 0 && result.status !== 1)) throw new Error("COORDINATION_HISTORY_OBSERVATION_FAILED");
      return result.status === 0;
    });
    const entries = cache.get(controlSha) ?? this.entries(directory, controlSha);
    return { controlSha, record: entries.get(pathFor(workItem))?.record ?? null, entries };
  }
  read(workItem: string): CoordinationObservation {
    const directory = this.directory();
    try { const { controlSha, record } = this.snapshot(directory, workItem); return { controlSha, record }; }
    finally { rmSync(directory, { recursive: true, force: true }); }
  }
  bootstrap(publication: SyntheticPublication, beforePush: SyntheticPushGuard): SyntheticApplied {
    if (!this.genesis || !this.beforeCommit || !this.historyCheck || publication.ref !== this.controlRef || publication.expected !== null) throw new Error("COORDINATION_BOOTSTRAP_AUTHORIZATION_REQUIRED");
    return publishSyntheticObject(this.transport, this.genesis, publication, this.beforeCommit, beforePush, () => {}, (candidate) => this.recoverBootstrap(candidate));
  }
  recoverBootstrap(candidate: SyntheticCandidate): SyntheticApplied {
    const genesis = this.genesis;
    if (!genesis || candidate.ref !== this.controlRef || candidate.expected !== null || candidate.head !== genesis.commitSha ||
        candidate.intent.subject.kind !== "control-genesis" || candidate.intent.subject.objectPlanHash !== genesis.objectPlanHash ||
        candidate.intent.subject.fixtureId !== genesis.metadata.objectId || candidate.intent.treeSha !== genesis.treeSha ||
        candidate.intent.parentSha !== null || candidate.intent.commitMetadataHash !== genesis.commitBytesSha256) throw new Error("COORDINATION_RECOVERY_REQUIRED");
    const current = this.read("bootstrap-observation");
    if (!current.controlSha) throw new Error("COORDINATION_RECOVERY_REQUIRED");
    return { candidate, observedHead: current.controlSha };
  }
  compareAndSwap(args: { workItem: string; expectedControlSha: string | null; expected: CoordinationExpected; next: CoordinationRecord }): CoordinationApplied {
    const directory = this.directory(); let retain = false;
    try {
      const current = this.snapshot(directory, args.workItem);
      if (current.controlSha !== args.expectedControlSha) throw new Error("COORDINATION_CAS_CONFLICT");
      if (!current.controlSha) throw new Error("COORDINATION_BOOTSTRAP_AUTHORIZATION_REQUIRED");
      if (!this.historyCheck) throw new Error("COORDINATION_HISTORY_ANCHOR_REQUIRED");
      assertExpected(current.record, args.expected);
      if (!validRecord(args.next) || args.next.workItem !== args.workItem || args.next.repository !== this.transport.repository || args.next.repositoryId !== this.transport.repositoryId) throw new Error("COORDINATION_RECORD_INVALID");
      objectGit(directory, ["read-tree", current.controlSha]);
      const blob = objectGit(directory, ["hash-object", "-w", "--stdin"], prettyJson(args.next)).trim();
      objectGit(directory, ["update-index", "--add", "--cacheinfo", "100644", blob, pathFor(args.workItem)]);
      const treeSha = objectGit(directory, ["write-tree"]).trim();
      const parent = ["-p", current.controlSha];
      if (!this.beforeCommit) throw new Error("COORDINATION_CANDIDATE_AUTHORIZATION_REQUIRED");
      const metadata = { name: "Harness Coordination", email: "coordination@harness.invalid", seconds: Math.floor(Date.now() / 1000), timezone: "+0000", message: `coordination ${args.next.transactionId}\n` };
      const recordCreation = this.beforeCommit({ transactionId: args.next.transactionId, parentSha: current.controlSha, treeSha,
        subject: { kind: "coordination-record", workItem: args.workItem, recordHash: args.next.recordHash }, objectDirectory: directory, commitMetadataHash: hashObject(metadata) });
      retain = true; let controlSha: string;
      try {
        controlSha = objectGit(directory, ["-c", `user.name=${metadata.name}`, "-c", `user.email=${metadata.email}`, "commit-tree", treeSha, ...parent], metadata.message, `${metadata.seconds} ${metadata.timezone}`).trim();
        if (!SHA.test(controlSha)) throw new Error("COORDINATION_OBJECT_READ_FAILED");
      } catch (error) { recordCreation(null); throw error; }
      recordCreation(controlSha);
      const written = this.entries(directory, controlSha);
      if (written.size !== current.entries.size + (current.record ? 0 : 1) || [...current.entries].some(([path, value]) => path !== pathFor(args.workItem) && written.get(path)?.blob !== value.blob)) throw new Error("COORDINATION_TREE_PRESERVATION_FAILED");
      const candidate = { controlRef: this.controlRef, expectedControlSha: current.controlSha, controlSha, treeSha, record: args.next, objectDirectory: directory };
      const recordWrite = this.beforePush(candidate);
      let failure: { error: unknown } | undefined;
      try {
        let pushed: GitCommandResult | undefined; let applied: CoordinationApplied;
        try {
          pushed = this.transport.push(directory, controlSha, this.controlRef, current.controlSha);
          requireCoordinationPush(pushed, controlSha, this.controlRef);
          recordWrite?.({ candidate, pushed }); // Intermediate evidence; the write lock still covers readback.
          applied = this.recover(candidate);
        } catch (error) {
          const code = error instanceof Error ? error.message : "COORDINATION_WRITE_OUTCOME_UNKNOWN";
          recordWrite?.({ candidate, pushed, error: code });
          if (code === "COORDINATION_CAS_CONFLICT" || code === "COORDINATION_CAS_NOT_PERFORMED") retain = false;
          throw error;
        }
        recordWrite?.({ candidate, pushed, applied });
        retain = false;
        return applied;
      } catch (error) { failure = { error }; throw error; }
      finally {
        try { recordWrite?.finish?.(); }
        catch (error) { if (failure) throw new AggregateError([failure.error, error], "COORDINATION_WRITE_AND_RELEASE_FAILED"); throw error; }
      }
    } finally { if (!retain) rmSync(directory, { recursive: true, force: true }); }
  }
  /** Recovery proves history, never replays a write or restores a lease from a transaction ID alone. */
  recover(candidate: CoordinationCandidate): CoordinationApplied {
    if (candidate.controlRef !== this.controlRef || !SHA.test(candidate.controlSha) || !validRecord(candidate.record)) throw new Error("COORDINATION_RECOVERY_REQUIRED");
    return this.recoverRecordedCandidate({ ...candidate, recordHash: candidate.record.recordHash });
  }
  /** Reconstruct only from fetched, validated history; no caller-provided record or retained directory is trusted. */
  recoverRecordedCandidate(input: Pick<CoordinationCandidate, "controlSha" | "expectedControlSha" | "treeSha" | "objectDirectory"> & { recordHash: string }): CoordinationApplied {
    if (!SHA.test(input.controlSha) || !SHA.test(input.treeSha) || (input.expectedControlSha !== null && !SHA.test(input.expectedControlSha)) || !/^[a-f0-9]{64}$/u.test(input.recordHash)) throw new Error("COORDINATION_RECOVERY_REQUIRED");
    const directory = this.directory();
    try {
      const current = this.snapshot(directory, "recovery-observation");
      if (!current.controlSha) throw new Error("COORDINATION_RECOVERY_REQUIRED");
      if (current.controlSha !== input.controlSha) objectGit(directory, ["merge-base", "--is-ancestor", input.controlSha, current.controlSha]);
      const record = [...this.entries(directory, input.controlSha).values()].find((entry) => entry.record.recordHash === input.recordHash)?.record;
      const parents = objectGit(directory, ["show", "-s", "--format=%P", input.controlSha]).trim();
      const tree = objectGit(directory, ["show", "-s", "--format=%T", input.controlSha]).trim();
      if (!record || parents !== (input.expectedControlSha ?? "") || tree !== input.treeSha) throw new Error("COORDINATION_RECOVERY_REQUIRED");
      const candidate: CoordinationCandidate = { controlRef: this.controlRef, controlSha: input.controlSha, expectedControlSha: input.expectedControlSha, treeSha: input.treeSha, objectDirectory: input.objectDirectory, record };
      const currentRecord = current.entries.get(pathFor(record.workItem))?.record ?? null;
      const disposition = currentRecord?.recordHash === record.recordHash ? "current" : "superseded";
      return { candidate, current: { controlSha: current.controlSha, record: currentRecord }, disposition };
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
}
