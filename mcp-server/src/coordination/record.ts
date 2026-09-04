import { z } from "zod";
import { hashObject } from "../v2/fs.js";
import { COORDINATION_SCHEMA_VERSION, type CoordinationExpected, type CoordinationRecord, type RenewalProof } from "./types.js";

const text = z.string().min(1).max(512).refine((value) => !/[\x00-\x1f\x7f]/u.test(value));
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const generation = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const repository = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
const timestamp = z.string().datetime();
const renewalProofSchema = z.object({
  transactionId: text, reservationControlSha: sha, reservationRecordHash: digest,
  oldExpiresAt: timestamp, proposedExpiresAt: timestamp, serverDate: text,
  roundTripMs: z.number().finite().nonnegative(), elapsedMs: z.number().finite().nonnegative(),
  observedUpperBoundAt: timestamp, proofHash: digest,
}).strict();
export function validRenewalProof(input: unknown): input is RenewalProof {
  const parsed = renewalProofSchema.safeParse(input); if (!parsed.success) return false;
  const { proofHash, ...proof } = parsed.data;
  const date = Date.parse(proof.serverDate);
  return Number.isFinite(date) && new Date(date).toUTCString() === proof.serverDate &&
    Date.parse(proof.observedUpperBoundAt) >= date + 1_000 + proof.roundTripMs + proof.elapsedMs &&
    Date.parse(proof.observedUpperBoundAt) < Date.parse(proof.oldExpiresAt) &&
    Date.parse(proof.proposedExpiresAt) > Date.parse(proof.oldExpiresAt) && proofHash === hashObject(proof);
}
export const coordinationRecordSchema = z.object({
  schemaVersion: z.literal(COORDINATION_SCHEMA_VERSION), repository, repositoryId: text,
  workItem: z.string().regex(/^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9][0-9]*$/u),
  branch: text.refine((value) => !value.startsWith("-") && !value.endsWith(".") && !value.includes("..") && !value.includes("@{") &&
    !/[ ~^:?*\[\\]/u.test(value) && value !== "@" && value.split("/").every((part) => part && !part.startsWith(".") && !part.endsWith(".lock"))),
  sourceRepositoryId: text, owner: text, machine: text, sessionRef: text.optional(), generation,
  controlEpochDigest: digest, createdAt: timestamp, expiresAt: timestamp.nullable(), lastObservedHead: sha,
  lifecycleState: z.enum(["Admitted", "Prepared", "Active", "Draft", "Ready", "MergeArmed", "Integrated", "Closing", "Closed", "Abandoned"]),
  renewal: z.object({ transactionId: text, proposedExpiresAt: timestamp, reservedAt: timestamp }).strict().optional(),
  renewalConfirmation: renewalProofSchema.optional(),
  closeOwnerGeneration: generation.optional(), transactionId: text, recordHash: digest,
}).strict();

export function recordWithoutHash(record: CoordinationRecord): Omit<CoordinationRecord, "recordHash"> {
  const copy = { ...record }; delete (copy as Partial<CoordinationRecord>).recordHash; return copy;
}
export function validRecord(input: unknown): input is CoordinationRecord {
  const parsed = coordinationRecordSchema.safeParse(input);
  if (!parsed.success) return false;
  const record = parsed.data;
  const terminal = ["Integrated", "Closing", "Closed", "Abandoned"].includes(record.lifecycleState);
  return record.workItem.startsWith(`github:${record.repository}#`) &&
    Number.isSafeInteger(Number(record.workItem.split("#")[1])) &&
    (terminal ? record.expiresAt === null && record.closeOwnerGeneration === record.generation && !record.renewal
      : record.expiresAt !== null && Date.parse(record.expiresAt) > Date.parse(record.createdAt) && record.closeOwnerGeneration === undefined) &&
    (!record.renewal || record.expiresAt !== null && record.renewal.transactionId === record.transactionId &&
      Date.parse(record.renewal.reservedAt) >= Date.parse(record.createdAt) && Date.parse(record.renewal.reservedAt) < Date.parse(record.expiresAt) &&
      Date.parse(record.renewal.proposedExpiresAt) > Date.parse(record.expiresAt)) &&
    (!record.renewalConfirmation || validRenewalProof(record.renewalConfirmation) && record.renewalConfirmation.proposedExpiresAt === record.expiresAt) &&
    record.recordHash === hashObject(recordWithoutHash(record));
}
export function createCoordinationRecord(input: Omit<CoordinationRecord, "schemaVersion" | "recordHash">): CoordinationRecord {
  const record: CoordinationRecord = { ...input, schemaVersion: COORDINATION_SCHEMA_VERSION, recordHash: "" };
  record.recordHash = hashObject(recordWithoutHash(record));
  if (!validRecord(record)) throw new Error("COORDINATION_RECORD_INVALID");
  return record;
}
const expectation = z.object({ recordHash: digest, generation, owner: text, machine: text, controlEpochDigest: digest, lastObservedHead: sha }).strict();
export function expectedRecord(record: CoordinationRecord): CoordinationExpected {
  return { recordHash: record.recordHash, generation: record.generation, owner: record.owner, machine: record.machine, controlEpochDigest: record.controlEpochDigest, lastObservedHead: record.lastObservedHead };
}
export function assertExpected(record: CoordinationRecord | null, expected: CoordinationExpected): void {
  if (!record) {
    if (!expected || Object.entries(expected).some(([key, value]) => key !== "recordHash" || value !== null)) throw new Error("COORDINATION_RECORD_ABSENT");
    return;
  }
  if (!validRecord(record)) throw new Error("COORDINATION_RECORD_INVALID");
  if (!expectation.safeParse(expected).success) throw new Error("COORDINATION_EXPECTATION_INCOMPLETE");
  for (const [key, value] of Object.entries(expected)) if (record[key as keyof CoordinationRecord] !== value) throw new Error(`COORDINATION_STALE_${key.toUpperCase()}`);
}
