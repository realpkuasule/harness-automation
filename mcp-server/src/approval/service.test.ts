import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSemanticApprovalPacket, reviewSemanticApproval, reviewSemanticApprovalWithHistory, validSemanticApprovalPacket } from "./service.js";

const roots: string[] = [];

const base = () => createSemanticApprovalPacket({
  planHash: "a".repeat(64), inputHash: "b".repeat(64), producerIdentity: "producer",
  binding: {
    planHash: "a".repeat(64), contextDigest: "c".repeat(64), inputDigest: "b".repeat(64),
    policyDigest: "d".repeat(64), observedHash: "e".repeat(64),
  },
  actions: [{ id: "write", kind: "write", summary: "Update generated config", before: "old", after: "new", reversible: true, recovery: "restore old" }],
});

describe("semantic approval", () => {
  it("fails closed without DG-02, on self-review, malformed responses, and a third attempt", () => {
    expect(validSemanticApprovalPacket({} as ReturnType<typeof base>)).toBe(false);
    expect(reviewSemanticApproval({ packet: base() })).toMatchObject({ state: "ReviewPending", code: "DG02_REVIEWER_CONFIGURATION_REQUIRED" });
    expect(reviewSemanticApproval({ packet: base(), adapter: { identity: "producer", review: () => { throw new Error("unused"); } } }))
      .toMatchObject({ state: "NeedsHuman", code: "REVIEWER_SELF_REVIEW" });
    expect(reviewSemanticApproval({ packet: base(), attempt: 3 })).toMatchObject({ state: "NeedsHuman", code: "REVIEWER_ATTEMPT_LIMIT" });
    expect(reviewSemanticApproval({ packet: base(), adapter: { identity: "reviewer", review: () => ({ schemaVersion: "reviewer-verdict/1.0", packetHash: "bad", planHash: "bad", inputHash: "bad", reviewerIdentity: "reviewer", verdict: "approve", reasonCodes: ["OK"] }) } }))
      .toMatchObject({ state: "NeedsHuman", code: "REVIEWER_INVALID" });
    expect(reviewSemanticApproval({ packet: base(), adapter: { identity: "reviewer", review: () => ({} as never) } }))
      .toMatchObject({ state: "NeedsHuman", code: "REVIEWER_INVALID" });
  });

  it("requires a human for protected or non-reversible plans", () => {
    const protectedPacket = createSemanticApprovalPacket({
      planHash: "a".repeat(64), inputHash: "b".repeat(64), producerIdentity: "producer",
      binding: { planHash: "a".repeat(64), contextDigest: "c".repeat(64), inputDigest: "b".repeat(64), policyDigest: "d".repeat(64), observedHash: "e".repeat(64) },
      actions: [{ id: "protect", kind: "protected", summary: "change ruleset", before: "old", after: "new", reversible: true, protected: true, recovery: "restore" }],
    });
    expect(reviewSemanticApproval({ packet: protectedPacket })).toMatchObject({ state: "NeedsHuman", code: "HUMAN_APPROVAL_REQUIRED" });
  });

  it("derives the bounded review attempt from durable history", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-approval-"));
    roots.push(root);
    const adapter = { identity: "reviewer", review: (packet: ReturnType<typeof base>) => ({ schemaVersion: "reviewer-verdict/1.0" as const, packetHash: packet.packetHash, planHash: packet.planHash, inputHash: packet.inputHash, reviewerIdentity: "reviewer", verdict: "reject" as const, reasonCodes: ["NO"] }) };
    expect(reviewSemanticApprovalWithHistory({ commonDir: root, packet: base(), adapter })).toMatchObject({ state: "ReviewPending" });
    expect(reviewSemanticApprovalWithHistory({ commonDir: root, packet: base(), adapter })).toMatchObject({ state: "ReviewPending" });
    expect(reviewSemanticApprovalWithHistory({ commonDir: root, packet: base(), adapter })).toMatchObject({ state: "NeedsHuman", code: "REVIEWER_ATTEMPT_LIMIT" });
  });

  it("does not consume review attempts while DG-02 is unconfigured", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-approval-"));
    roots.push(root);
    expect(reviewSemanticApprovalWithHistory({ commonDir: root, packet: base() })).toMatchObject({ state: "ReviewPending" });
    expect(reviewSemanticApprovalWithHistory({ commonDir: root, packet: base() })).toMatchObject({ state: "ReviewPending" });
    const adapter = { identity: "reviewer", review: (packet: ReturnType<typeof base>) => ({
      schemaVersion: "reviewer-verdict/1.0" as const, packetHash: packet.packetHash,
      planHash: packet.planHash, inputHash: packet.inputHash, reviewerIdentity: "reviewer",
      verdict: "reject" as const, reasonCodes: ["NO"],
    }) };
    expect(reviewSemanticApprovalWithHistory({ commonDir: root, packet: base(), adapter })).toMatchObject({ state: "ReviewPending" });
    expect(reviewSemanticApprovalWithHistory({ commonDir: root, packet: base(), adapter })).toMatchObject({ state: "ReviewPending" });
    expect(reviewSemanticApprovalWithHistory({ commonDir: root, packet: base(), adapter }))
      .toMatchObject({ state: "NeedsHuman", code: "REVIEWER_ATTEMPT_LIMIT" });
  });

  it("fails closed when an immutable review receipt is removed", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-approval-"));
    roots.push(root);
    const packet = base();
    const adapter = { identity: "reviewer", review: () => ({
      schemaVersion: "reviewer-verdict/1.0" as const, packetHash: packet.packetHash,
      planHash: packet.planHash, inputHash: packet.inputHash, reviewerIdentity: "reviewer",
      verdict: "reject" as const, reasonCodes: ["NO"],
    }) };
    expect(reviewSemanticApprovalWithHistory({ commonDir: root, packet, adapter })).toMatchObject({ state: "ReviewPending" });
    rmSync(join(root, "harness", "receipts", "approval", packet.packetHash, "events", "000000000001.json"));
    expect(() => reviewSemanticApprovalWithHistory({ commonDir: root, packet, adapter })).toThrow("APPROVAL_HISTORY_TAMPERED");
  });

  it("repairs only a valid receipt tail whose LKG record was interrupted", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-approval-"));
    roots.push(root);
    const packet = base();
    const adapter = { identity: "reviewer", review: () => ({
      schemaVersion: "reviewer-verdict/1.0" as const, packetHash: packet.packetHash,
      planHash: packet.planHash, inputHash: packet.inputHash, reviewerIdentity: "reviewer",
      verdict: "reject" as const, reasonCodes: ["NO"],
    }) };
    reviewSemanticApprovalWithHistory({ commonDir: root, packet, adapter });
    rmSync(join(root, "harness", "lkg", "approval", "records", "000000000001.json"));
    expect(reviewSemanticApprovalWithHistory({ commonDir: root, packet, adapter })).toMatchObject({ state: "ReviewPending" });
    expect(reviewSemanticApprovalWithHistory({ commonDir: root, packet, adapter }))
      .toMatchObject({ state: "NeedsHuman", code: "REVIEWER_ATTEMPT_LIMIT" });
  });

  it("binds the reviewer verdict to the exact packet and rejects action or binding drift", () => {
    const packet = base();
    const adapter = { identity: "reviewer", review: () => ({
      schemaVersion: "reviewer-verdict/1.0" as const, packetHash: packet.packetHash,
      planHash: packet.planHash, inputHash: packet.inputHash, reviewerIdentity: "reviewer",
      verdict: "approve" as const, reasonCodes: ["OK"],
    }) };
    expect(reviewSemanticApproval({ packet, adapter })).toMatchObject({ state: "Approved" });
    expect(reviewSemanticApproval({ packet: { ...packet, binding: { ...packet.binding, policyDigest: "f".repeat(64) } }, adapter }))
      .toMatchObject({ state: "NeedsHuman" });
    expect(reviewSemanticApproval({ packet: { ...packet, actions: [{ ...packet.actions[0], kind: "protected" }] }, adapter }))
      .toMatchObject({ state: "NeedsHuman" });
    expect(reviewSemanticApproval({ packet, adapter: { ...adapter, review: () => ({ ...adapter.review(), packetHash: "f".repeat(64) }) } }))
      .toMatchObject({ state: "NeedsHuman", code: "REVIEWER_INVALID" });
  });
});

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
