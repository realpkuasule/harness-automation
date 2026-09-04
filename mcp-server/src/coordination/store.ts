import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashObject, prettyJson } from "../v2/fs.js";
import type { GitCommandResult } from "../repository/git.js";
import { assertExpected, validRecord } from "./record.js";
import type { CoordinationExpected, CoordinationRecord } from "./types.js";
import type { HistoryCheck } from "./history.js";

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
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const pathFor = (workItem: string) => `records/${hashObject(workItem)}.json`;
const objectEnv = () => ({ PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" });
function objectGit(directory: string, argv: string[], input?: string): string {
  const result = spawnSync("git", ["--no-replace-objects", ...argv], { cwd: directory, env: objectEnv(), input, encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024 * 1024 });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") throw new Error("ENVIRONMENT_BLOCKED: GIT_UNAVAILABLE");
  if (result.error || result.status !== 0) throw new Error("COORDINATION_OBJECT_READ_FAILED");
  return result.stdout;
}

/** No checkout, hooks, project config, credential env or second transaction ledger. */
export class GitCoordinationStore {
  constructor(
    private readonly controlRef: string,
    private readonly transport: CoordinationTransport,
    // The use-case must persist this candidate in the existing receipt chain before any push.
    private readonly beforePush: (candidate: CoordinationCandidate) => void,
    private readonly initialize = false,
    private readonly historyCheck?: HistoryCheck,
  ) {
    if (!/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(controlRef) || controlRef.includes("..") || controlRef.endsWith("/") ||
        controlRef.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock") || part.endsWith("."))) throw new Error("COORDINATION_CONTROL_REF_INVALID");
  }
  private directory(): string {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "harness-coordination-objects-")));
    try { objectGit(directory, ["init", "--bare", "--quiet", "--template="]); return directory; }
    catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
  }
  private entries(directory: string, sha: string): Map<string, { blob: string; record: CoordinationRecord }> {
    if (!SHA.test(sha) || objectGit(directory, ["cat-file", "-t", sha]).trim() !== "commit") throw new Error("COORDINATION_CONTROL_OBJECT_INVALID");
    const raw = objectGit(directory, ["ls-tree", "-rz", "-t", "--full-tree", sha]);
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
  compareAndSwap(args: { workItem: string; expectedControlSha: string | null; expected: CoordinationExpected; next: CoordinationRecord }): CoordinationApplied {
    const directory = this.directory(); let retain = false;
    try {
      const current = this.snapshot(directory, args.workItem);
      if (current.controlSha !== args.expectedControlSha) throw new Error("COORDINATION_CAS_CONFLICT");
      if (!current.controlSha && !this.initialize) throw new Error("COORDINATION_BOOTSTRAP_AUTHORIZATION_REQUIRED");
      if (!this.historyCheck) throw new Error("COORDINATION_HISTORY_ANCHOR_REQUIRED");
      assertExpected(current.record, args.expected);
      if (!validRecord(args.next) || args.next.workItem !== args.workItem || args.next.repository !== this.transport.repository || args.next.repositoryId !== this.transport.repositoryId) throw new Error("COORDINATION_RECORD_INVALID");
      if (current.controlSha) objectGit(directory, ["read-tree", current.controlSha]);
      else objectGit(directory, ["read-tree", "--empty"]);
      const blob = objectGit(directory, ["hash-object", "-w", "--stdin"], prettyJson(args.next)).trim();
      objectGit(directory, ["update-index", "--add", "--cacheinfo", "100644", blob, pathFor(args.workItem)]);
      const treeSha = objectGit(directory, ["write-tree"]).trim();
      const parent = current.controlSha ? ["-p", current.controlSha] : [];
      const controlSha = objectGit(directory, ["-c", "user.name=Harness Coordination", "-c", "user.email=coordination@harness.invalid", "commit-tree", treeSha, ...parent], `coordination ${args.next.transactionId}\n`).trim();
      const written = this.entries(directory, controlSha);
      if (written.size !== current.entries.size + (current.record ? 0 : 1) || [...current.entries].some(([path, value]) => path !== pathFor(args.workItem) && written.get(path)?.blob !== value.blob)) throw new Error("COORDINATION_TREE_PRESERVATION_FAILED");
      const candidate = { controlRef: this.controlRef, expectedControlSha: current.controlSha, controlSha, treeSha, record: args.next, objectDirectory: directory };
      this.beforePush(candidate);
      retain = true;
      const pushed = this.transport.push(directory, controlSha, this.controlRef, current.controlSha);
      if (!pushed.error && pushed.status === 1 && /\[rejected\] \(stale info\)/u.test(pushed.stdout)) { retain = false; throw new Error("COORDINATION_CAS_CONFLICT"); }
      if (pushed.error || pushed.status !== 0) throw new Error("COORDINATION_WRITE_OUTCOME_UNKNOWN");
      const applied = this.recover(candidate);
      retain = false;
      return applied;
    } finally { if (!retain) rmSync(directory, { recursive: true, force: true }); }
  }
  /** Recovery proves history, never replays a write or restores a lease from a transaction ID alone. */
  recover(candidate: CoordinationCandidate): CoordinationApplied {
    if (candidate.controlRef !== this.controlRef || !SHA.test(candidate.controlSha) || !validRecord(candidate.record)) throw new Error("COORDINATION_RECOVERY_REQUIRED");
    const directory = this.directory();
    try {
      const current = this.snapshot(directory, candidate.record.workItem);
      if (!current.controlSha) throw new Error("COORDINATION_RECOVERY_REQUIRED");
      if (current.controlSha !== candidate.controlSha) objectGit(directory, ["merge-base", "--is-ancestor", candidate.controlSha, current.controlSha]);
      const candidateEntries = this.entries(directory, candidate.controlSha);
      const parents = objectGit(directory, ["show", "-s", "--format=%P", candidate.controlSha]).trim();
      const tree = objectGit(directory, ["show", "-s", "--format=%T", candidate.controlSha]).trim();
      if (parents !== (candidate.expectedControlSha ?? "") || tree !== candidate.treeSha || candidateEntries.get(pathFor(candidate.record.workItem))?.record.recordHash !== candidate.record.recordHash) throw new Error("COORDINATION_RECOVERY_REQUIRED");
      const disposition = current.record?.recordHash === candidate.record.recordHash ? "current" : "superseded";
      return { candidate, current: { controlSha: current.controlSha, record: current.record }, disposition };
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
}
