import { randomUUID } from "node:crypto";
import { hashObject } from "../v2/fs.js";
import { CoordinationClock } from "./clock.js";
import { assertExpected, createCoordinationRecord, recordWithoutHash, validRenewalProof } from "./record.js";
import type { CoordinationExpected, CoordinationRecord, RenewalProof } from "./types.js";

export function requireWriteLease(record: CoordinationRecord, expected: CoordinationExpected, clock: CoordinationClock): void {
  assertExpected(record, expected);
  if (record.expiresAt === null || record.renewal) throw new Error("COORDINATION_WRITE_LEASE_UNAVAILABLE");
  clock.requireBefore(record.expiresAt);
}
export function nextLease(args: {
  repository: string; repositoryId: string; workItem: string; branch: string; sourceRepositoryId: string;
  owner: string; machine: string; sessionRef?: string; controlEpochDigest: string; head: string;
  ttlMs: number; transactionId?: string;
}, clock: CoordinationClock): CoordinationRecord {
  const createdAt = new Date(Math.floor(clock.bounds().lowerMs)).toISOString();
  const expiresAt = clock.deadline(args.ttlMs); clock.requireBefore(expiresAt);
  return createCoordinationRecord({ repository: args.repository, repositoryId: args.repositoryId, workItem: args.workItem,
    branch: args.branch, sourceRepositoryId: args.sourceRepositoryId, owner: args.owner, machine: args.machine,
    sessionRef: args.sessionRef, generation: 1, controlEpochDigest: args.controlEpochDigest, createdAt, expiresAt,
    lastObservedHead: args.head, lifecycleState: "Admitted", transactionId: args.transactionId ?? randomUUID() });
}
export function reserveRenewal(record: CoordinationRecord, expected: CoordinationExpected, ttlMs: number, clock: CoordinationClock, transactionId = randomUUID()): CoordinationRecord {
  requireWriteLease(record, expected, clock);
  const proposedExpiresAt = clock.deadline(ttlMs);
  if (Date.parse(proposedExpiresAt) <= Date.parse(record.expiresAt!)) throw new Error("COORDINATION_RENEWAL_INVALID");
  const reservedAt = new Date(Math.floor(Math.max(Date.parse(record.createdAt), clock.bounds().lowerMs))).toISOString();
  return createCoordinationRecord({ ...recordWithoutHash(record), transactionId, renewal: { transactionId, proposedExpiresAt, reservedAt } });
}
/** Called only after fresh exact record readback; CLI never accepts caller-supplied time proof. */
export function observeRenewal(record: CoordinationRecord, controlSha: string, clock: CoordinationClock): RenewalProof {
  if (!record.renewal || !record.expiresAt || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(controlSha)) throw new Error("COORDINATION_RENEWAL_TIME_UNPROVEN");
  const bounds = clock.requireBefore(record.expiresAt);
  const proof: RenewalProof = { transactionId: record.renewal.transactionId, reservationControlSha: controlSha,
    reservationRecordHash: record.recordHash, oldExpiresAt: record.expiresAt, proposedExpiresAt: record.renewal.proposedExpiresAt,
    serverDate: bounds.date, roundTripMs: bounds.roundTripMs, elapsedMs: bounds.elapsedMs,
    observedUpperBoundAt: new Date(Math.ceil(bounds.upperMs)).toISOString(), proofHash: "" };
  proof.proofHash = hashObject({ ...proof, proofHash: undefined });
  if (!validRenewalProof(proof)) throw new Error("COORDINATION_RENEWAL_TIME_UNPROVEN");
  return proof;
}
export function confirmRenewal(record: CoordinationRecord, expected: CoordinationExpected, proof: RenewalProof, clock: CoordinationClock): CoordinationRecord {
  assertExpected(record, expected);
  if (!record.renewal || !record.expiresAt || !validRenewalProof(proof) || proof.transactionId !== record.renewal.transactionId ||
      proof.reservationRecordHash !== record.recordHash || proof.oldExpiresAt !== record.expiresAt || proof.proposedExpiresAt !== record.renewal.proposedExpiresAt) throw new Error("COORDINATION_RENEWAL_TIME_UNPROVEN");
  // The old deadline may have passed; only its already-timely reservation can finish before the new deadline.
  clock.requireBefore(proof.proposedExpiresAt);
  const next = recordWithoutHash(record); delete next.renewal;
  return createCoordinationRecord({ ...next, expiresAt: proof.proposedExpiresAt, renewalConfirmation: proof, transactionId: proof.transactionId });
}
export function rebindLease(record: CoordinationRecord, expected: CoordinationExpected, sessionRef: string | undefined, head: string, clock: CoordinationClock, transactionId = randomUUID()): CoordinationRecord {
  requireWriteLease(record, expected, clock);
  return createCoordinationRecord({ ...recordWithoutHash(record), sessionRef, lastObservedHead: head, transactionId });
}
