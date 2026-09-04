import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { zodToJsonSchema } from "zod-to-json-schema";
import { hashObject } from "../v2/fs.js";
import { CoordinationClock } from "./clock.js";
import { handoffSchema, type HandoffSourceProof, type HandoffTargetAcceptance } from "./handoff_record.js";
import { rebindLease, requireWriteLease, reserveRenewal } from "./leases.js";
import { createCoordinationRecord, expectedRecord, recordWithoutHash } from "./record.js";

const digest = "a".repeat(64); const head = "b".repeat(40);
function clock() { const value = new CoordinationClock(() => ({ monotonicMs: 0, wallMs: 0 })); value.observe("Fri, 04 Sep 2026 04:00:00 GMT", value.start()); return value; }
function fixture() {
  const input = { repository: "owner/repo", repositoryId: "42", workItem: "github:owner/repo#1", branch: "codex/test", sourceRepositoryId: "42", owner: "source", machine: "source-host", generation: 1, controlEpochDigest: digest, createdAt: "2026-09-04T04:00:00.000Z", expiresAt: "2026-09-04T04:01:00.000Z", lastObservedHead: head, lifecycleState: "Active" as const, transactionId: "transfer-1" };
  const frozen = createCoordinationRecord({ ...input, handoff: { transferId: input.transactionId,
    source: { owner: input.owner, machine: input.machine, generation: input.generation, epoch: digest, head, expiresAt: input.expiresAt }, target: { owner: "target", machine: "target-host" } } });
  const sourceProof: HandoffSourceProof = { freezeRecordHash: frozen.recordHash, facts: { sourceRepositoryId: "42", sourceRef: "refs/heads/codex/test", endpointHash: digest,
    sourceHead: head, remoteHead: head, workspace: "/source/worktree", commonDir: "/source/repo/.git", trackedClean: true,
    untracked: [], ignored: [], uniqueCommits: 0, unpushedCommits: 0, observer: "source", hostId: "source-host", observedAt: "2026-09-04T04:00:05.000Z" },
    coverage: { kind: "isolated-qualification", observerId: "fixture/1", entrypoints: ["managed-write"], quiescenceHash: digest }, proofHash: "" };
  sourceProof.proofHash = hashObject({ ...sourceProof, proofHash: undefined });
  const targetAcceptance: HandoffTargetAcceptance = { sourceProofHash: sourceProof.proofHash, sourceRepositoryId: "42", sourceRef: "refs/heads/codex/test", endpointHash: digest,
    sourceHead: head, remoteHead: head, retrievedHead: head, targetHead: head, workspace: "C:\\worktree", commonDir: "C:\\repo\\.git",
    observer: "target", hostId: "target-host", observedAt: "2026-09-04T04:00:06.000Z", acceptanceHash: "" };
  targetAcceptance.acceptanceHash = hashObject({ ...targetAcceptance, acceptanceHash: undefined });
  const published = createCoordinationRecord({ ...recordWithoutHash(frozen), handoff: { ...frozen.handoff!, sourceProof } });
  const acceptedInput = { ...recordWithoutHash(published), owner: "target", machine: "target-host", generation: 2,
    handoff: { ...published.handoff!, targetAcceptance } };
  return { frozen, published, acceptedInput, accepted: createCoordinationRecord(acceptedInput) };
}

it("freezes ordinary writes, renew and rebind without inventing a lifecycle value", () => {
  const { frozen, published } = fixture();
  for (const record of [frozen, published]) {
    expect(record.lifecycleState).toBe("Active");
    expect(() => requireWriteLease(record, expectedRecord(record), clock())).toThrow("COORDINATION_WRITE_LEASE_UNAVAILABLE");
    expect(() => reserveRenewal(record, expectedRecord(record), 120_000, clock())).toThrow("COORDINATION_WRITE_LEASE_UNAVAILABLE");
    expect(() => rebindLease(record, expectedRecord(record), "session", head, clock())).toThrow("COORDINATION_WRITE_LEASE_UNAVAILABLE");
  }
});

it("requires proof and exact target/generation/head/deadline consistency before ending the frozen shape", () => {
  const { accepted, acceptedInput, frozen } = fixture();
  expect(() => requireWriteLease(accepted, expectedRecord(accepted), clock())).not.toThrow();
  for (const patch of [{ owner: "source" }, { machine: "wrong-host" }, { generation: 1 }, { generation: 3 },
    { lastObservedHead: "d".repeat(40) }, { expiresAt: "2026-09-04T05:00:00.000Z" }, { controlEpochDigest: "c".repeat(64) }]) {
    expect(() => createCoordinationRecord({ ...acceptedInput, ...patch })).toThrow("COORDINATION_RECORD_INVALID");
  }
  expect(() => createCoordinationRecord({ ...recordWithoutHash(frozen), handoff: { ...frozen.handoff!, targetAcceptance: accepted.handoff!.targetAcceptance } })).toThrow("COORDINATION_RECORD_INVALID");
  const tampered = structuredClone(acceptedInput); tampered.handoff.targetAcceptance.retrievedHead = "d".repeat(40);
  expect(() => createCoordinationRecord(tampered)).toThrow("COORDINATION_RECORD_INVALID");
  const renewed = createCoordinationRecord({ ...recordWithoutHash(accepted), transactionId: "later-rebind", lastObservedHead: "c".repeat(40) });
  expect(renewed.handoff?.source.head).toBe(head); // Preserve the historical transfer while current work advances.
});

it("keeps the handoff JSON schema mechanically aligned with the strict runtime shape", () => {
  const published = JSON.parse(readFileSync(new URL("../../../docs/api/coordination-handoff.schema.json", import.meta.url), "utf8"));
  delete published.$comment;
  expect(published).toEqual(zodToJsonSchema(handoffSchema, { $refStrategy: "none" }));
  expect(handoffSchema.safeParse({ ...fixture().frozen.handoff, drained: true }).success).toBe(false);
});
