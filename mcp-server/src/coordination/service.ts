import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { readJson, safePath } from "../v2/fs.js";
import { type CoordinationConfig, type CoordinationExpected, type CoordinationRecord } from "./types.js";
import { assertExpected, createCoordinationRecord, expectedRecord, recordWithoutHash } from "./record.js";
import { GitCoordinationStore } from "./store.js";
import { CoordinationClock } from "./clock.js";
import { confirmRenewal, nextLease, observeRenewal, rebindLease, requireWriteLease, reserveRenewal } from "./leases.js";
import type { GitHubCoordinationReader } from "./github.js";
import type { CoordinationOperation, OperationAuthority } from "./authority.js";
import type { CoordinationObservation, CoordinationPreparation } from "./store.js";
import type { HandoffObservers } from "./handoff.js";
export { assertExpected, createCoordinationRecord } from "./record.js";
export { GitCoordinationStore } from "./store.js";
export { confirmRenewal, nextLease, observeRenewal, rebindLease, reserveRenewal } from "./leases.js";

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

export function requireEnabledCoordination(root: string): CoordinationConfig {
  const config = loadCoordinationConfig(root);
  if (!config) fail("CoordinationBackendRequired");
  if (!config.enabled) fail("COORDINATION_PRODUCTION_ENABLEMENT_REQUIRED");
  // Production transport remains fail-closed until the existing credential broker supplies an explicit transport helper.
  fail("CREDENTIAL_TRANSPORT_HELPER_REQUIRED");
}

/** Shared lifecycle composition: CLI and isolated qualification fixtures use these exact CAS paths. */
export class CoordinationLifecycleService {
  private readonly acquisitions = new WeakSet<CoordinationPreparation>();
  constructor(private readonly store: GitCoordinationStore, private readonly refreshClock: () => CoordinationClock,
    private readonly provider?: GitHubCoordinationReader, private readonly authority?: OperationAuthority, private readonly handoff?: HandoffObservers) {}
  acquire(input: Parameters<typeof nextLease>[0]): CoordinationRecord {
    return this.dispatchAcquire(this.prepareAcquire(input));
  }
  prepareAcquire(input: Parameters<typeof nextLease>[0]): CoordinationPreparation {
    const current = this.store.read(input.workItem);
    if (current.record) fail("COORDINATION_ALREADY_ACQUIRED");
    const next = nextLease(input, this.refreshClock());
    if (!this.authority) fail("COORDINATION_OPERATION_AUTHORITY_REQUIRED");
    this.authority("acquire", current, next);
    const prepared = this.store.prepareCompareAndSwap({ workItem: next.workItem, expectedControlSha: current.controlSha, expected: {}, next });
    this.acquisitions.add(prepared); return prepared;
  }
  dispatchAcquire(prepared: CoordinationPreparation): CoordinationRecord {
    if (!this.acquisitions.delete(prepared)) fail("COORDINATION_PREPARATION_UNPROVEN");
    return this.confirm(this.store.dispatchPrepared(prepared));
  }
  rebind(workItem: string, expected: CoordinationExpected, sessionRef: string | undefined, head: string): CoordinationRecord {
    const current = this.store.read(workItem); if (!current.record) fail("COORDINATION_RECORD_ABSENT");
    const next = rebindLease(current.record, expected, sessionRef, head, this.refreshClock());
    return this.confirm(this.apply("rebind", current, next));
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
    return this.confirm(this.apply("terminal-claim", current, next));
  }
  renew(workItem: string, expected: CoordinationExpected, ttlMs: number): CoordinationRecord {
    const current = this.store.read(workItem); if (!current.record) fail("COORDINATION_RECORD_ABSENT");
    const pending = reserveRenewal(current.record, expected, ttlMs, this.refreshClock());
    const reserved = this.apply("renew-reserve", current, pending);
    if (reserved.disposition !== "current") fail("COORDINATION_TRANSACTION_SUPERSEDED");
    const observed = this.store.read(workItem);
    if (!observed.record || !observed.controlSha || observed.record.recordHash !== pending.recordHash) fail("COORDINATION_CAS_CONFLICT");
    const proof = observeRenewal(observed.record, observed.controlSha, this.refreshClock());
    const next = confirmRenewal(observed.record, expectedRecord(observed.record), proof, this.refreshClock());
    return this.confirm(this.apply("renew-confirm", observed, next));
  }
  freezeTransfer(workItem: string, expectedControlSha: string, expected: CoordinationExpected,
    target: { owner: string; machine: string }, transferId = randomUUID()): CoordinationRecord {
    const current = this.transferCurrent(workItem, expectedControlSha, expected);
    requireWriteLease(current.record, expected, this.refreshClock()); this.handoff!.beforeFreeze(current.record);
    const content = recordWithoutHash(current.record); delete content.renewalConfirmation;
    const next = createCoordinationRecord({ ...content, transactionId: transferId, handoff: { transferId, target, source: {
      owner: content.owner, machine: content.machine, generation: content.generation, epoch: content.controlEpochDigest,
      head: content.lastObservedHead, expiresAt: content.expiresAt!,
    } } });
    return this.confirmHandoff(this.apply("transfer-freeze", current, next));
  }
  publishSourceProof(workItem: string, expectedControlSha: string, expected: CoordinationExpected, transferId: string): CoordinationRecord {
    const current = this.transferCurrent(workItem, expectedControlSha, expected, transferId);
    const binding = this.handoff!.check(current.record);
    if (current.record.owner !== binding.actor || current.record.machine !== binding.hostId) fail("COORDINATION_OPERATION_IDENTITY_MISMATCH");
    if (current.record.handoff!.sourceProof) fail("COORDINATION_SOURCE_PROOF_ALREADY_PUBLISHED");
    const sourceProof = this.handoff!.sourceProof(current.record);
    const next = createCoordinationRecord({ ...recordWithoutHash(current.record), handoff: { ...current.record.handoff!, sourceProof } });
    return this.confirmHandoff(this.apply("transfer-proof", current, next));
  }
  acceptTransfer(workItem: string, expectedControlSha: string, expected: CoordinationExpected, transferId: string, sessionRef?: string): CoordinationRecord {
    const current = this.transferCurrent(workItem, expectedControlSha, expected, transferId); const handoff = current.record.handoff!;
    const binding = this.handoff!.check(current.record);
    if (handoff.target.owner !== binding.actor || handoff.target.machine !== binding.hostId) fail("COORDINATION_OPERATION_IDENTITY_MISMATCH");
    const frozen = createCoordinationRecord({ ...recordWithoutHash(current.record), handoff: { ...handoff, sourceProof: undefined } });
    if (handoff.sourceProof?.freezeRecordHash !== frozen.recordHash) fail("COORDINATION_TRANSFER_EVIDENCE_INSUFFICIENT");
    const targetAcceptance = this.handoff!.targetAcceptance(current.record);
    const next = createCoordinationRecord({ ...recordWithoutHash(current.record), owner: binding.actor, machine: binding.hostId,
      sessionRef, generation: current.record.generation + 1, handoff: { ...handoff, targetAcceptance } });
    return this.confirm(this.apply("transfer-accept", current, next));
  }
  private transferCurrent(workItem: string, expectedControlSha: string, expected: CoordinationExpected, transferId?: string) {
    if (!this.handoff) fail("COORDINATION_HANDOFF_OBSERVER_REQUIRED"); this.handoff.requireLock();
    const current = this.store.read(workItem); if (!current.record) fail("COORDINATION_RECORD_ABSENT");
    if (current.controlSha !== expectedControlSha) fail("COORDINATION_CAS_CONFLICT"); assertExpected(current.record, expected);
    if (!current.record.expiresAt) fail("COORDINATION_WRITE_LEASE_UNAVAILABLE"); this.refreshClock().requireBefore(current.record.expiresAt);
    if (transferId !== undefined && (current.record.handoff?.transferId !== transferId || current.record.handoff.targetAcceptance)) fail("COORDINATION_TRANSFER_NOT_FROZEN");
    return { ...current, record: current.record };
  }
  private confirmHandoff(applied: ReturnType<GitCoordinationStore["compareAndSwap"]>): CoordinationRecord {
    if (applied.disposition !== "current" || !applied.current.record?.expiresAt) fail("COORDINATION_TRANSACTION_SUPERSEDED");
    this.handoff!.check(applied.current.record); this.refreshClock().requireBefore(applied.current.record.expiresAt);
    return applied.current.record;
  }
  private apply(operation: CoordinationOperation, current: CoordinationObservation, next: CoordinationRecord) {
    if (!this.authority) fail("COORDINATION_OPERATION_AUTHORITY_REQUIRED");
    this.authority(operation, current, next);
    return this.store.compareAndSwap({ workItem: next.workItem, expectedControlSha: current.controlSha,
      expected: current.record ? expectedRecord(current.record) : {}, next });
  }
  private confirm(applied: ReturnType<GitCoordinationStore["compareAndSwap"]>): CoordinationRecord {
    if (applied.disposition !== "current" || !applied.current.record) fail("COORDINATION_TRANSACTION_SUPERSEDED");
    if (applied.current.record.expiresAt !== null) requireWriteLease(applied.current.record, expectedRecord(applied.current.record), this.refreshClock());
    return applied.current.record;
  }
}
