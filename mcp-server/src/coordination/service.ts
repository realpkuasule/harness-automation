import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWrite, hashObject, readJson, safePath } from "../v2/fs.js";
import { remotePushEndpoint } from "../repository/remote.js";
import { runGitCommand } from "../repository/git.js";
import { COORDINATION_SCHEMA_VERSION, type CoordinationConfig, type CoordinationExpected, type CoordinationLifecycle, type CoordinationRecord } from "./types.js";

const SHA = /^[a-f0-9]{40,64}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const WORK_ITEM = /^github:[^/\s]+\/[^#\s]+#\d+$/u;
const LIFECYCLES: CoordinationLifecycle[] = ["Admitted", "Prepared", "Active", "Draft", "Ready", "MergeArmed", "Integrated", "Closing", "Closed", "Abandoned"];

function fail(code: string): never { throw new Error(code); }
function recordWithoutHash(record: CoordinationRecord): Omit<CoordinationRecord, "recordHash"> { const copy = { ...record }; delete (copy as Partial<CoordinationRecord>).recordHash; return copy; }
function recordPath(workItem: string): string { return `records/${hashObject(workItem)}.json`; }
function validRecord(record: CoordinationRecord): boolean {
  return record.schemaVersion === COORDINATION_SCHEMA_VERSION && WORK_ITEM.test(record.workItem) && record.repository.length > 0 && record.repositoryId.length > 0 && record.branch.length > 0 && record.sourceRepositoryId.length > 0 && record.owner.length > 0 && record.machine.length > 0 && Number.isSafeInteger(record.generation) && record.generation > 0 && DIGEST.test(record.controlEpochDigest) && SHA.test(record.lastObservedHead) && Number.isFinite(Date.parse(record.createdAt)) && (record.expiresAt === null || Number.isFinite(Date.parse(record.expiresAt))) && LIFECYCLES.includes(record.lifecycleState) && (record.closeOwnerGeneration === undefined || record.closeOwnerGeneration === record.generation) && (!record.renewal || typeof record.renewal.transactionId === "string" && Number.isFinite(Date.parse(record.renewal.proposedExpiresAt)) && Number.isFinite(Date.parse(record.renewal.reservedAt)) && (record.renewal.observedBeforeExpiryAt === undefined || Number.isFinite(Date.parse(record.renewal.observedBeforeExpiryAt)))) && record.recordHash === hashObject(recordWithoutHash(record));
}

export function createCoordinationRecord(input: Omit<CoordinationRecord, "schemaVersion" | "recordHash">): CoordinationRecord {
  const record: CoordinationRecord = { schemaVersion: COORDINATION_SCHEMA_VERSION, ...input, recordHash: "" };
  record.recordHash = hashObject(recordWithoutHash(record));
  if (!validRecord(record)) fail("COORDINATION_RECORD_INVALID");
  return record;
}

export function assertExpected(record: CoordinationRecord | null, expected: CoordinationExpected): void {
  if (!record) { if (Object.values(expected).some((value) => value !== undefined && value !== null)) fail("COORDINATION_RECORD_ABSENT"); return; }
  for (const [key, value] of Object.entries(expected)) if (value !== undefined && value !== null && record[key as keyof CoordinationRecord] !== value) fail(`COORDINATION_STALE_${key.toUpperCase()}`);
}

export function loadCoordinationConfig(root: string): CoordinationConfig | null {
  const path = safePath(root, ".harness/coordination.json");
  if (!existsSync(path)) return null;
  let config: CoordinationConfig;
  try { config = readJson<CoordinationConfig>(path); } catch { fail("COORDINATION_CONFIG_INVALID"); }
  if (config.schemaVersion !== "coordination-config/1.0" || typeof config.enabled !== "boolean" || !/^[^/\s]+\/[^/\s]+$/u.test(config.repository) || !config.repositoryId || !config.remote || !/^refs\/harness\/coordination\/[A-Za-z0-9._/-]+$/u.test(config.controlRef) || (config.qualificationEvidenceHash !== undefined && !DIGEST.test(config.qualificationEvidenceHash))) fail("COORDINATION_CONFIG_INVALID");
  return config;
}

export function coordinationStatus(root: string): Record<string, unknown> {
  const config = loadCoordinationConfig(root);
  return config ? { configured: true, enabled: config.enabled, coordinated: false, result: config.enabled ? "COORDINATION_QUALIFICATION_REQUIRED" : "COORDINATION_PRODUCTION_ENABLEMENT_REQUIRED" } : { configured: false, enabled: false, coordinated: false, result: "CoordinationBackendRequired" };
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv, allowFailure = false): string {
  const result = runGitCommand(cwd, args, env);
  if (result.error || (!allowFailure && result.status !== 0)) fail(`COORDINATION_GIT_FAILED: ${result.stderr.trim() || result.error || result.status}`);
  return result.stdout.trim();
}

function controlRefHead(root: string, endpoint: string, ref: string, env: NodeJS.ProcessEnv): string | null {
  const result = runGitCommand(root, ["ls-remote", endpoint, ref], env);
  if (result.error || result.status !== 0) fail("COORDINATION_REMOTE_OBSERVATION_FAILED");
  const lines = result.stdout.split(/\r?\n/u).filter(Boolean);
  if (lines.length === 0) return null;
  const [sha, observed] = lines[0].split(/\s+/u, 2);
  if (lines.length !== 1 || observed !== ref || !SHA.test(sha)) fail("COORDINATION_REMOTE_OBSERVATION_INVALID");
  return sha;
}

/** Git's one-ref CAS serializes unrelated work items; ponytail: shard only with measured contention. */
export class GitCoordinationStore {
  constructor(private readonly root: string, private readonly remote: string, private readonly controlRef: string, private readonly env: NodeJS.ProcessEnv = process.env) {}
  read(workItem: string): { controlSha: string | null; record: CoordinationRecord | null } {
    const endpoint = remotePushEndpoint(this.root, this.remote).value;
    const controlSha = controlRefHead(this.root, endpoint, this.controlRef, this.env);
    if (!controlSha) return { controlSha: null, record: null };
    const directory = mkdtempSync(join(tmpdir(), "harness-coordination-read-"));
    try {
      git(directory, ["init", "--quiet"], this.env); git(directory, ["fetch", "--quiet", endpoint, controlSha], this.env);
      const raw = git(directory, ["show", `${controlSha}:${recordPath(workItem)}`], this.env, true);
      if (!raw) return { controlSha, record: null };
      let record: CoordinationRecord; try { record = JSON.parse(raw) as CoordinationRecord; } catch { fail("COORDINATION_RECORD_INVALID"); }
      if (!validRecord(record) || record.workItem !== workItem) fail("COORDINATION_RECORD_INVALID");
      return { controlSha, record };
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
  compareAndSwap(args: { workItem: string; expectedControlSha: string | null; expected: CoordinationExpected; next: CoordinationRecord }): CoordinationRecord {
    const current = this.read(args.workItem);
    if (current.controlSha !== args.expectedControlSha) fail("COORDINATION_CAS_CONFLICT");
    assertExpected(current.record, args.expected);
    if (!validRecord(args.next) || args.next.workItem !== args.workItem) fail("COORDINATION_RECORD_INVALID");
    const endpoint = remotePushEndpoint(this.root, this.remote).value;
    const directory = mkdtempSync(join(tmpdir(), "harness-coordination-write-"));
    try {
      git(directory, ["init", "--quiet"], this.env);
      if (current.controlSha) { git(directory, ["fetch", "--quiet", endpoint, current.controlSha], this.env); git(directory, ["checkout", "--quiet", "--detach", current.controlSha], this.env); }
      mkdirSync(join(directory, "records"), { recursive: true });
      writeFileSync(join(directory, recordPath(args.workItem)), `${JSON.stringify(args.next, null, 2)}\n`, { encoding: "utf8", flag: "w" });
      git(directory, ["add", "records"], this.env);
      git(directory, ["-c", "user.name=Harness Coordination", "-c", "user.email=coordination@harness.invalid", "commit", "--quiet", "-m", `coordination ${args.next.transactionId}`], this.env);
      const commit = git(directory, ["rev-parse", "HEAD"], this.env);
      const lease = `--force-with-lease=${this.controlRef}:${current.controlSha ?? ""}`;
      git(directory, ["push", "--porcelain", lease, endpoint, `${commit}:${this.controlRef}`], this.env);
      const readback = this.read(args.workItem);
      if (!readback.record || readback.record.recordHash !== args.next.recordHash || readback.record.transactionId !== args.next.transactionId) fail("COORDINATION_READBACK_FAILED");
      // Cache is only a readback projection; remote state always wins on the next operation.
      const common = git(this.root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], this.env);
      atomicWrite(safePath(common, `harness/coordination/cache/${hashObject(args.workItem)}.json`), JSON.stringify({ controlSha: readback.controlSha, record: readback.record }, null, 2));
      return readback.record;
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
}

export function requireEnabledCoordination(root: string): CoordinationConfig {
  const config = loadCoordinationConfig(root);
  if (!config) fail("CoordinationBackendRequired");
  if (!config.enabled) fail("COORDINATION_PRODUCTION_ENABLEMENT_REQUIRED");
  // Production transport remains fail-closed until the existing credential broker supplies an explicit transport helper.
  fail("CREDENTIAL_TRANSPORT_HELPER_REQUIRED");
}

/** A pending renewal never grants time; confirmation needs independent server-time evidence before the old expiry. */
export function reserveRenewal(record: CoordinationRecord, expected: CoordinationExpected, proposedExpiresAt: string, transactionId = randomUUID()): CoordinationRecord {
  assertExpected(record, expected);
  if (!record.expiresAt || record.lifecycleState === "Integrated" || record.renewal || Date.parse(proposedExpiresAt) <= Date.parse(record.expiresAt)) fail("COORDINATION_RENEWAL_INVALID");
  return createCoordinationRecord({ ...recordWithoutHash(record), transactionId, renewal: { transactionId, proposedExpiresAt, reservedAt: new Date().toISOString() } });
}

export function confirmRenewal(record: CoordinationRecord, expected: CoordinationExpected, observedBeforeExpiryAt: string): CoordinationRecord {
  assertExpected(record, expected);
  const renewal = record.renewal;
  if (!renewal || !record.expiresAt || Date.parse(observedBeforeExpiryAt) >= Date.parse(record.expiresAt)) fail("COORDINATION_RENEWAL_TIME_UNPROVEN");
  const next = recordWithoutHash(record); delete (next as Partial<CoordinationRecord>).renewal;
  return createCoordinationRecord({ ...next, expiresAt: renewal.proposedExpiresAt, transactionId: renewal.transactionId });
}

export function terminalClaim(record: CoordinationRecord, expected: CoordinationExpected, integratedHead: string, transactionId = randomUUID()): CoordinationRecord {
  assertExpected(record, expected);
  if (!SHA.test(integratedHead) || record.lifecycleState === "Integrated" || record.lifecycleState === "Closing" || record.lifecycleState === "Closed" || record.lifecycleState === "Abandoned") fail("COORDINATION_TERMINAL_CLAIM_INVALID");
  return createCoordinationRecord({ ...recordWithoutHash(record), lastObservedHead: integratedHead, lifecycleState: "Integrated", expiresAt: null, closeOwnerGeneration: record.generation, transactionId });
}

export function rebindLease(record: CoordinationRecord, expected: CoordinationExpected, sessionRef: string | undefined, head: string, transactionId = randomUUID()): CoordinationRecord {
  assertExpected(record, expected);
  if (!record.expiresAt || !SHA.test(head) || record.lifecycleState === "Integrated") fail("COORDINATION_REBIND_INVALID");
  return createCoordinationRecord({ ...recordWithoutHash(record), sessionRef, lastObservedHead: head, transactionId });
}

export interface ZeroLossTransferEvidence {
  sourceHead: string;
  remoteHead: string;
  targetRetrievedHead: string;
  trackedClean: true;
  untracked: [];
  ignored: [];
  uniqueCommits: 0;
  unpushedCommits: 0;
}

/** Collect, rather than accept, the zero-loss facts from the frozen source and target repositories. */
export function observeZeroLossTransfer(sourceRoot: string, endpoint: string, sourceRef: string, targetRoot: string, env: NodeJS.ProcessEnv = process.env): ZeroLossTransferEvidence {
  const sourceHead = git(sourceRoot, ["rev-parse", "HEAD"], env);
  const remoteHead = controlRefHead(sourceRoot, endpoint, sourceRef, env);
  if (!remoteHead || remoteHead !== sourceHead) fail("COORDINATION_TRANSFER_REMOTE_HEAD_MISMATCH");
  const status = git(sourceRoot, ["status", "--porcelain=v1", "--ignored=matching"], env);
  const untracked = status.split("\n").filter((line) => line.startsWith("??"));
  const ignored = status.split("\n").filter((line) => line.startsWith("!!"));
  const tracked = status.split("\n").filter((line) => line && !line.startsWith("??") && !line.startsWith("!!"));
  const targetRetrievedHead = git(targetRoot, ["rev-parse", "--verify", `${sourceHead}^{commit}`], env, true) || "";
  const unpushedCommits = Number(git(sourceRoot, ["rev-list", "--count", `${remoteHead}..HEAD`], env));
  if (tracked.length || untracked.length || ignored.length || targetRetrievedHead !== sourceHead || unpushedCommits !== 0) fail("COORDINATION_TRANSFER_EVIDENCE_INSUFFICIENT");
  return { sourceHead, remoteHead, targetRetrievedHead, trackedClean: true, untracked: [], ignored: [], uniqueCommits: 0, unpushedCommits: 0 };
}

export function transferLease(record: CoordinationRecord, expected: CoordinationExpected, target: { owner: string; machine: string; sessionRef?: string }, evidence: ZeroLossTransferEvidence, transactionId = randomUUID()): CoordinationRecord {
  assertExpected(record, expected);
  if (!record.expiresAt || !target.owner || !target.machine || record.lifecycleState === "Integrated" || evidence.sourceHead !== record.lastObservedHead || evidence.remoteHead !== record.lastObservedHead || evidence.targetRetrievedHead !== record.lastObservedHead || !evidence.trackedClean || evidence.untracked.length || evidence.ignored.length || evidence.uniqueCommits !== 0 || evidence.unpushedCommits !== 0) fail("COORDINATION_TRANSFER_EVIDENCE_INSUFFICIENT");
  return createCoordinationRecord({ ...recordWithoutHash(record), owner: target.owner, machine: target.machine, sessionRef: target.sessionRef, generation: record.generation + 1, createdAt: new Date().toISOString(), transactionId });
}

export function nextLease(args: { prior: CoordinationRecord | null; repository: string; repositoryId: string; workItem: string; branch: string; sourceRepositoryId: string; owner: string; machine: string; sessionRef?: string; controlEpochDigest: string; head: string; expiresAt: string; lifecycleState?: CoordinationLifecycle; transactionId?: string }): CoordinationRecord {
  return createCoordinationRecord({ repository: args.repository, repositoryId: args.repositoryId, workItem: args.workItem, branch: args.branch, sourceRepositoryId: args.sourceRepositoryId, owner: args.owner, machine: args.machine, sessionRef: args.sessionRef, generation: (args.prior?.generation ?? 0) + 1, controlEpochDigest: args.controlEpochDigest, createdAt: new Date().toISOString(), expiresAt: args.expiresAt, lastObservedHead: args.head, lifecycleState: args.lifecycleState ?? "Admitted", transactionId: args.transactionId ?? randomUUID() });
}
