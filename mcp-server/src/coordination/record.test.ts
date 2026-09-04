import { describe, expect, it } from "vitest";
import { hashObject } from "../v2/fs.js";
import { createCoordinationRecord, assertExpected } from "./service.js";

const input = { repository: "owner/repo", repositoryId: "42", workItem: "github:owner/repo#1", branch: "codex/test", sourceRepositoryId: "42", owner: "octo", machine: "mac", generation: 1, controlEpochDigest: "a".repeat(64), createdAt: "2026-09-04T04:00:00.000Z", expiresAt: "2026-09-04T04:01:00.000Z", lastObservedHead: "b".repeat(40), lifecycleState: "Admitted" as const, transactionId: "tx-1" };
describe("strict coordination records", () => {
  it("rejects unknown fields, invalid values and inconsistent lifecycle/identity claims", () => {
    const patches = [{ surprise: true }, { generation: 0 }, { generation: Number.MAX_SAFE_INTEGER + 1 }, { workItem: "github:owner/repo#0" }, { workItem: "github:other/repo#1" }, { repository: null }, { branch: "bad..branch" }, { branch: "-option" }, { machine: "mac\n" }, { lastObservedHead: "a".repeat(41) }, { expiresAt: null }, { expiresAt: input.createdAt }, { lifecycleState: "Integrated" }, { closeOwnerGeneration: 1 }, { renewal: { transactionId: "tx-1", proposedExpiresAt: input.expiresAt, reservedAt: input.createdAt } }];
    for (const patch of patches) expect(() => createCoordinationRecord({ ...input, ...patch } as never), JSON.stringify(patch)).toThrow("COORDINATION_RECORD_INVALID");
    expect(createCoordinationRecord(input).recordHash).toHaveLength(64);
  });
  it("requires the complete exact expectation for an existing record; null is absence, not a wildcard", () => {
    const record = createCoordinationRecord(input);
    const expected = { recordHash: record.recordHash, generation: record.generation, owner: record.owner, machine: record.machine, lastObservedHead: record.lastObservedHead, controlEpochDigest: record.controlEpochDigest };
    expect(() => assertExpected(record, expected)).not.toThrow();
    for (const key of Object.keys(expected)) {
      const partial = { ...expected }; delete partial[key as keyof typeof partial];
      expect(() => assertExpected(record, partial)).toThrow("COORDINATION_EXPECTATION_INCOMPLETE");
    }
    expect(() => assertExpected(record, { ...expected, recordHash: null })).toThrow("COORDINATION_EXPECTATION_INCOMPLETE");
    expect(() => assertExpected(null, expected)).toThrow("COORDINATION_RECORD_ABSENT");
    expect(() => assertExpected(null, {})).not.toThrow();
    expect(() => assertExpected(record, { ...expected, owner: "another" })).toThrow("COORDINATION_STALE_OWNER");
    expect(hashObject(record)).toHaveLength(64);
  });
});
