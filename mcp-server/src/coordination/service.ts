import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { readJson, safePath } from "../v2/fs.js";
import { runGitCommand } from "../repository/git.js";
import { type CoordinationConfig, type CoordinationExpected, type CoordinationLifecycle, type CoordinationRecord } from "./types.js";
import { assertExpected, createCoordinationRecord, recordWithoutHash } from "./record.js";
import { GitCoordinationStore } from "./store.js";
export { assertExpected, createCoordinationRecord } from "./record.js";
export { GitCoordinationStore } from "./store.js";

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

function fail(code: string): never { throw new Error(code); }

export function loadCoordinationConfig(root: string): CoordinationConfig | null {
  const path = safePath(root, ".harness/coordination.json");
  if (!existsSync(path)) return null;
  const text = z.string().min(1).max(512).refine((value) => !/[\x00-\x1f\x7f]/u.test(value));
  const schema = z.object({
    schemaVersion: z.literal("coordination-config/1.0"), enabled: z.boolean(),
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u), repositoryId: text,
    remote: text, controlRef: z.string().regex(/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u)
      .refine((value) => !value.includes("..") && value.split("/").every((part) => part && !part.startsWith(".") && !part.endsWith(".lock") && !part.endsWith("."))),
    qualificationEvidenceHash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  }).strict();
  try { return schema.parse(readJson<unknown>(path)); } catch { fail("COORDINATION_CONFIG_INVALID"); }
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

/** Shared lifecycle composition: CLI and isolated qualification fixtures use these exact CAS paths. */
export class CoordinationLifecycleService {
  constructor(private readonly store: GitCoordinationStore) {}
  acquire(input: Parameters<typeof nextLease>[0]): CoordinationRecord {
    const current = this.store.read(input.workItem);
    if (current.record) fail("COORDINATION_ALREADY_ACQUIRED");
    const next = nextLease({ ...input, prior: null });
    return this.confirm(this.store.compareAndSwap({ workItem: input.workItem, expectedControlSha: current.controlSha, expected: {}, next }));
  }
  rebind(workItem: string, expected: CoordinationExpected, sessionRef: string | undefined, head: string): CoordinationRecord {
    const current = this.store.read(workItem); if (!current.record) fail("COORDINATION_RECORD_ABSENT");
    const next = rebindLease(current.record, expected, sessionRef, head);
    return this.confirm(this.store.compareAndSwap({ workItem, expectedControlSha: current.controlSha, expected, next }));
  }
  transfer(workItem: string, expected: CoordinationExpected, target: { owner: string; machine: string; sessionRef?: string }, evidence: ZeroLossTransferEvidence): CoordinationRecord {
    const current = this.store.read(workItem); if (!current.record) fail("COORDINATION_RECORD_ABSENT");
    const next = transferLease(current.record, expected, target, evidence);
    return this.confirm(this.store.compareAndSwap({ workItem, expectedControlSha: current.controlSha, expected, next }));
  }
  terminalClaim(workItem: string, expected: CoordinationExpected, integratedHead: string): CoordinationRecord {
    const current = this.store.read(workItem); if (!current.record) fail("COORDINATION_RECORD_ABSENT");
    const next = terminalClaim(current.record, expected, integratedHead);
    return this.confirm(this.store.compareAndSwap({ workItem, expectedControlSha: current.controlSha, expected, next }));
  }
  private confirm(applied: ReturnType<GitCoordinationStore["compareAndSwap"]>): CoordinationRecord {
    if (applied.disposition !== "current" || !applied.current.record) fail("COORDINATION_TRANSACTION_SUPERSEDED");
    return applied.current.record;
  }
}

export function nextLease(args: { prior: CoordinationRecord | null; repository: string; repositoryId: string; workItem: string; branch: string; sourceRepositoryId: string; owner: string; machine: string; sessionRef?: string; controlEpochDigest: string; head: string; expiresAt: string; lifecycleState?: CoordinationLifecycle; transactionId?: string }): CoordinationRecord {
  return createCoordinationRecord({ repository: args.repository, repositoryId: args.repositoryId, workItem: args.workItem, branch: args.branch, sourceRepositoryId: args.sourceRepositoryId, owner: args.owner, machine: args.machine, sessionRef: args.sessionRef, generation: (args.prior?.generation ?? 0) + 1, controlEpochDigest: args.controlEpochDigest, createdAt: new Date().toISOString(), expiresAt: args.expiresAt, lastObservedHead: args.head, lifecycleState: args.lifecycleState ?? "Admitted", transactionId: args.transactionId ?? randomUUID() });
}
