import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSemanticApprovalPacket, reviewSemanticApproval, reviewSemanticApprovalWithHistory } from "./service.js";

const roots: string[] = [];

const base = () => createSemanticApprovalPacket({
  planHash: "a".repeat(64), inputHash: "b".repeat(64), producerIdentity: "producer",
  actions: [{ id: "write", kind: "write", summary: "Update generated config", before: "old", after: "new", reversible: true, recovery: "restore old" }],
});

describe("semantic approval", () => {
  it("fails closed without DG-02, on self-review, malformed responses, and a third attempt", () => {
    expect(reviewSemanticApproval({ packet: base() })).toMatchObject({ state: "ReviewPending", code: "DG02_REVIEWER_CONFIGURATION_REQUIRED" });
    expect(reviewSemanticApproval({ packet: base(), adapter: { identity: "producer", review: () => { throw new Error("unused"); } } }))
      .toMatchObject({ state: "NeedsHuman", code: "REVIEWER_SELF_REVIEW" });
    expect(reviewSemanticApproval({ packet: base(), attempt: 3 })).toMatchObject({ state: "NeedsHuman", code: "REVIEWER_ATTEMPT_LIMIT" });
    expect(reviewSemanticApproval({ packet: base(), adapter: { identity: "reviewer", review: () => ({ schemaVersion: "reviewer-verdict/1.0", planHash: "bad", inputHash: "bad", reviewerIdentity: "reviewer", verdict: "approve", reasonCodes: ["OK"] }) } }))
      .toMatchObject({ state: "NeedsHuman", code: "REVIEWER_INVALID" });
  });

  it("requires a human for protected or non-reversible plans", () => {
    const protectedPacket = createSemanticApprovalPacket({
      planHash: "a".repeat(64), inputHash: "b".repeat(64), producerIdentity: "producer",
      actions: [{ id: "protect", kind: "protected", summary: "change ruleset", before: "old", after: "new", reversible: true, protected: true, recovery: "restore" }],
    });
    expect(reviewSemanticApproval({ packet: protectedPacket })).toMatchObject({ state: "NeedsHuman", code: "HUMAN_APPROVAL_REQUIRED" });
  });

  it("derives the bounded review attempt from durable history", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-approval-"));
    roots.push(root);
    const adapter = { identity: "reviewer", review: () => ({ schemaVersion: "reviewer-verdict/1.0" as const, planHash: base().planHash, inputHash: base().inputHash, reviewerIdentity: "reviewer", verdict: "reject" as const, reasonCodes: ["NO"] }) };
    expect(reviewSemanticApprovalWithHistory({ commonDir: root, packet: base(), adapter })).toMatchObject({ state: "ReviewPending" });
    expect(reviewSemanticApprovalWithHistory({ commonDir: root, packet: base(), adapter })).toMatchObject({ state: "ReviewPending" });
    expect(reviewSemanticApprovalWithHistory({ commonDir: root, packet: base(), adapter })).toMatchObject({ state: "NeedsHuman", code: "REVIEWER_ATTEMPT_LIMIT" });
  });
});

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
