import { z } from "zod";
import { hashObject } from "../v2/fs.js";
import type { CoordinationRecord } from "./types.js";

const text = z.string().min(1).max(512).refine((value) => !/[\x00-\x1f\x7f]/u.test(value));
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const timestamp = z.string().datetime();
// Stored paths belong to the observing host; parsing must not impose this machine's OS path syntax.
const path = text.refine((value) => /^(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(value));
const sourceFacts = z.object({
  sourceRepositoryId: text, sourceRef: text, endpointHash: digest, sourceHead: sha, remoteHead: sha,
  workspace: path, commonDir: path, trackedClean: z.literal(true), untracked: z.tuple([]), ignored: z.tuple([]),
  uniqueCommits: z.literal(0), unpushedCommits: z.literal(0), observer: text, hostId: text, observedAt: timestamp,
}).strict();
const sourceProof = z.object({
  freezeRecordHash: digest, facts: sourceFacts,
  coverage: z.object({ kind: z.enum(["isolated-qualification", "host-verified"]), observerId: text,
    entrypoints: z.array(text).min(1).max(32), quiescenceHash: digest }).strict(), proofHash: digest,
}).strict();
const targetAcceptance = z.object({
  sourceProofHash: digest, sourceRepositoryId: text, sourceRef: text, endpointHash: digest,
  sourceHead: sha, remoteHead: sha, retrievedHead: sha, targetHead: sha, workspace: path, commonDir: path,
  observer: text, hostId: text, observedAt: timestamp, acceptanceHash: digest,
}).strict();
export const handoffSchema = z.object({
  transferId: text,
  source: z.object({ owner: text, machine: text, generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    epoch: digest, head: sha, expiresAt: timestamp }).strict(),
  target: z.object({ owner: text, machine: text }).strict(),
  sourceProof: sourceProof.optional(), targetAcceptance: targetAcceptance.optional(),
}).strict();
export type CoordinationHandoff = z.infer<typeof handoffSchema>;
export type HandoffSourceProof = z.infer<typeof sourceProof>;
export type HandoffTargetAcceptance = z.infer<typeof targetAcceptance>;

/** Shape/hash consistency is not permission: native handlers must collect and validate the actual facts. */
export function validHandoff(record: CoordinationRecord): boolean {
  if (!record.handoff) return true;
  const parsed = handoffSchema.safeParse(record.handoff); if (!parsed.success) return false;
  const handoff = parsed.data; const { source, target, sourceProof: proof, targetAcceptance: accepted } = handoff;
  if (source.owner === target.owner && source.machine === target.machine || source.epoch !== record.controlEpochDigest) return false;
  if (proof && (proof.proofHash !== hashObject({ ...proof, proofHash: undefined }) ||
      proof.facts.sourceRepositoryId !== record.sourceRepositoryId || proof.facts.sourceRef !== `refs/heads/${record.branch}` ||
      proof.facts.sourceHead !== source.head || proof.facts.remoteHead !== source.head ||
      proof.facts.observer !== source.owner || proof.facts.hostId !== source.machine ||
      Date.parse(proof.facts.observedAt) >= Date.parse(source.expiresAt) ||
      new Set(proof.coverage.entrypoints).size !== proof.coverage.entrypoints.length)) return false;
  if (!accepted) return record.transactionId === handoff.transferId && !record.renewal && !record.renewalConfirmation &&
    record.owner === source.owner && record.machine === source.machine && record.generation === source.generation &&
    record.lastObservedHead === source.head && record.expiresAt === source.expiresAt;
  return Boolean(proof) && accepted.acceptanceHash === hashObject({ ...accepted, acceptanceHash: undefined }) &&
    accepted.sourceProofHash === proof!.proofHash && accepted.sourceRepositoryId === record.sourceRepositoryId &&
    accepted.sourceRef === proof!.facts.sourceRef && accepted.endpointHash === proof!.facts.endpointHash &&
    accepted.sourceHead === source.head && accepted.remoteHead === source.head && accepted.retrievedHead === source.head && accepted.targetHead === source.head &&
    accepted.observer === target.owner && accepted.hostId === target.machine && Date.parse(accepted.observedAt) < Date.parse(source.expiresAt) &&
    record.owner === target.owner && record.machine === target.machine && record.generation === source.generation + 1 &&
    // Later renew/rebind can advance time/head; the acceptance transaction itself cannot grant either.
    (record.transactionId !== handoff.transferId || record.expiresAt === source.expiresAt && record.lastObservedHead === source.head);
}
