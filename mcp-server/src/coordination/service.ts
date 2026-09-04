import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { readJson, safePath } from "../v2/fs.js";
import { runGitCommand } from "../repository/git.js";
import { type CoordinationConfig, type CoordinationExpected, type CoordinationRecord } from "./types.js";
import { assertExpected, createCoordinationRecord, expectedRecord, recordWithoutHash } from "./record.js";
import { GitCoordinationStore } from "./store.js";
import { CoordinationClock } from "./clock.js";
import { confirmRenewal, nextLease, observeRenewal, rebindLease, requireWriteLease, reserveRenewal } from "./leases.js";
import type { GitHubCoordinationReader } from "./github.js";
export { assertExpected, createCoordinationRecord } from "./record.js";
export { GitCoordinationStore } from "./store.js";
export { confirmRenewal, nextLease, observeRenewal, rebindLease, reserveRenewal } from "./leases.js";

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

export function transferLease(record: CoordinationRecord, expected: CoordinationExpected, target: { owner: string; machine: string; sessionRef?: string }, evidence: ZeroLossTransferEvidence, clock: CoordinationClock, transactionId = randomUUID()): CoordinationRecord {
  requireWriteLease(record, expected, clock);
  if (!record.expiresAt || !target.owner || !target.machine || record.lifecycleState === "Integrated" || evidence.sourceHead !== record.lastObservedHead || evidence.remoteHead !== record.lastObservedHead || evidence.targetRetrievedHead !== record.lastObservedHead || !evidence.trackedClean || evidence.untracked.length || evidence.ignored.length || evidence.uniqueCommits !== 0 || evidence.unpushedCommits !== 0) fail("COORDINATION_TRANSFER_EVIDENCE_INSUFFICIENT");
  const next = recordWithoutHash(record); delete next.renewalConfirmation;
  return createCoordinationRecord({ ...next, owner: target.owner, machine: target.machine, sessionRef: target.sessionRef, generation: record.generation + 1, createdAt: new Date(Math.floor(Math.max(Date.parse(record.createdAt), clock.bounds().lowerMs))).toISOString(), transactionId });
}

/** Shared lifecycle composition: CLI and isolated qualification fixtures use these exact CAS paths. */
export class CoordinationLifecycleService {
  constructor(private readonly store: GitCoordinationStore, private readonly refreshClock: () => CoordinationClock, private readonly provider?: GitHubCoordinationReader) {}
  acquire(input: Parameters<typeof nextLease>[0]): CoordinationRecord {
    const current = this.store.read(input.workItem);
    if (current.record) fail("COORDINATION_ALREADY_ACQUIRED");
    const next = nextLease(input, this.refreshClock());
    return this.confirm(this.store.compareAndSwap({ workItem: input.workItem, expectedControlSha: current.controlSha, expected: {}, next }));
  }
  rebind(workItem: string, expected: CoordinationExpected, sessionRef: string | undefined, head: string): CoordinationRecord {
    const current = this.store.read(workItem); if (!current.record) fail("COORDINATION_RECORD_ABSENT");
    const next = rebindLease(current.record, expected, sessionRef, head, this.refreshClock());
    return this.confirm(this.store.compareAndSwap({ workItem, expectedControlSha: current.controlSha, expected, next }));
  }
  transfer(workItem: string, expected: CoordinationExpected, target: { owner: string; machine: string; sessionRef?: string }, evidence: ZeroLossTransferEvidence): CoordinationRecord {
    const current = this.store.read(workItem); if (!current.record) fail("COORDINATION_RECORD_ABSENT");
    const next = transferLease(current.record, expected, target, evidence, this.refreshClock());
    return this.confirm(this.store.compareAndSwap({ workItem, expectedControlSha: current.controlSha, expected, next }));
  }
  terminalClaim(workItem: string, expected: CoordinationExpected, number: number, baseRef: string): CoordinationRecord {
    if (!this.provider) fail("COORDINATION_MERGE_OBSERVER_REQUIRED");
    const current = this.store.read(workItem); if (!current.record) fail("COORDINATION_RECORD_ABSENT");
    assertExpected(current.record, expected);
    if (current.record.expiresAt === null) fail("COORDINATION_TERMINAL_CLAIM_INVALID");
    const integration = this.provider.observeMerge(current.record, number, baseRef);
    const content = recordWithoutHash(current.record); delete content.renewal; delete content.renewalConfirmation;
    // A terminal claim supersedes pending transfer authority; its evidence remains in validated ancestors.
    delete content.handoff;
    const next = createCoordinationRecord({ ...content, integration, lifecycleState: "Integrated", expiresAt: null,
      closeOwnerGeneration: current.record.generation, transactionId: randomUUID() });
    return this.confirm(this.store.compareAndSwap({ workItem, expectedControlSha: current.controlSha, expected, next }));
  }
  renew(workItem: string, expected: CoordinationExpected, ttlMs: number): CoordinationRecord {
    const current = this.store.read(workItem); if (!current.record) fail("COORDINATION_RECORD_ABSENT");
    const pending = reserveRenewal(current.record, expected, ttlMs, this.refreshClock());
    const reserved = this.store.compareAndSwap({ workItem, expectedControlSha: current.controlSha, expected, next: pending });
    if (reserved.disposition !== "current") fail("COORDINATION_TRANSACTION_SUPERSEDED");
    const observed = this.store.read(workItem);
    if (!observed.record || !observed.controlSha || observed.record.recordHash !== pending.recordHash) fail("COORDINATION_CAS_CONFLICT");
    const proof = observeRenewal(observed.record, observed.controlSha, this.refreshClock());
    const next = confirmRenewal(observed.record, expectedRecord(observed.record), proof, this.refreshClock());
    return this.confirm(this.store.compareAndSwap({ workItem, expectedControlSha: observed.controlSha, expected: expectedRecord(observed.record), next }));
  }
  private confirm(applied: ReturnType<GitCoordinationStore["compareAndSwap"]>): CoordinationRecord {
    if (applied.disposition !== "current" || !applied.current.record) fail("COORDINATION_TRANSACTION_SUPERSEDED");
    if (applied.current.record.expiresAt !== null) requireWriteLease(applied.current.record, expectedRecord(applied.current.record), this.refreshClock());
    return applied.current.record;
  }
}
