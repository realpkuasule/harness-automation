import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileHash, sha256 } from "../v2/fs.js";
import { createSemanticApprovalPacket } from "../approval/service.js";
import { applyTransactionPlan, createTransactionApproval, createTransactionPlan, readTransactionReceipts } from "./service.js";

const roots: string[] = [];
const now = new Date("2026-09-03T00:00:00.000Z");

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-transaction-"));
  roots.push(root);
  return root;
}

function approved(plan: ReturnType<typeof createTransactionPlan>) {
  const packet = createSemanticApprovalPacket({
    planHash: plan.planHash, inputHash: plan.inputDigest, producerIdentity: "producer",
    actions: [{ id: "write", kind: "write", summary: "write", before: "before", after: "after", reversible: true, recovery: "recover" }],
  });
  return createTransactionApproval({
    planHash: plan.planHash, inputDigest: plan.inputDigest, policyDigest: plan.policyDigest, observedHash: plan.observedHash,
    packetHash: packet.packetHash, packet, risk: "ordinary-reversible", actor: "independent-reviewer", actorType: "reviewer",
    verdict: "approved", approvedAt: now.toISOString(), expiresAt: "2030-01-01T00:00:00.000Z",
  });
}

function apply(root: string, plan: ReturnType<typeof createTransactionPlan>, overrides: Partial<Parameters<typeof applyTransactionPlan>[0]> = {}) {
  return applyTransactionPlan({
    plan, approval: approved(plan), expectedProjectDir: root, expectedCommonDir: root,
    reobserveIndependent: () => "observed", now, ...overrides,
  });
}

function recovery(plan: ReturnType<typeof createTransactionPlan>) {
  return { kind: "semantic-human-approval/3.0" as const, planHash: plan.planHash, packetHash: approved(plan).packetHash, approvedBy: "owner", approvedAt: now.toISOString(), expiresAt: "2030-01-01T00:00:00.000Z" };
}

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("transaction plan", () => {
  it("uses trusted roots and an exact approval receipt", () => {
    const root = fixture();
    const path = join(root, "policy.json");
    writeFileSync(path, "before\n", "utf8");
    const plan = createTransactionPlan({
      id: "policy", projectDir: root, commonDir: root, inputDigest: "input", policyDigest: "policy", observedHash: "observed",
      writes: [{ path: "policy.json", beforeHash: fileHash(path), beforeContent: "before\n", afterContent: "after\n" }],
    });
    expect(() => apply(root, { ...plan, observedHash: "tampered" })).toThrow("TRANSACTION_PLAN_INVALID");
    expect(() => apply(root, plan, { expectedProjectDir: join(root, "other") })).toThrow("TRANSACTION_PLAN_INVALID");
    expect(() => apply(root, plan, { approval: { ...approved(plan), inputDigest: "wrong" } })).toThrow("TRANSACTION_APPROVAL_INVALID");
    expect(() => apply(root, plan, { approval: { ...approved(plan), risk: "unknown" as never, actorType: "human" } })).toThrow("TRANSACTION_APPROVAL_INVALID");
    expect(() => apply(root, plan, { approval: { ...approved(plan), packetHash: "f".repeat(64) } })).toThrow("TRANSACTION_APPROVAL_INVALID");
    const receipt = apply(root, plan);
    expect(receipt.status).toBe("applied");
    expect(readFileSync(path, "utf8")).toBe("after\n");
    expect(apply(root, plan)).toEqual(receipt);
  });

  it("fails closed for receipt tampering and unsafe receipt identifiers", () => {
    const root = fixture();
    const path = join(root, "first");
    writeFileSync(path, "old\n", "utf8");
    const plan = createTransactionPlan({
      id: "../escape", projectDir: root, commonDir: root, inputDigest: "input", policyDigest: "policy", observedHash: "observed",
      writes: [{ path: "first", beforeHash: fileHash(path), beforeContent: "old\n", afterContent: "new\n" }],
    });
    expect(() => apply(root, plan)).toThrow("TRANSACTION_PLAN_INVALID");
    mkdirSync(join(root, "harness/transactions/receipts"), { recursive: true });
    writeFileSync(join(root, "harness/transactions/receipts/forged.json"), "{}", "utf8");
    const valid = createTransactionPlan({
      id: "valid", projectDir: root, commonDir: root, inputDigest: "input", policyDigest: "policy", observedHash: "observed",
      writes: [{ path: "first", beforeHash: fileHash(path), beforeContent: "old\n", afterContent: "new\n" }],
    });
    expect(() => apply(root, valid)).toThrow("RECEIPT_TAMPERED");
  });

  it("resumes only the latest started receipt, rechecks independent drift, and preserves the strict receipt chain", () => {
    const root = fixture();
    const first = join(root, "first");
    const second = join(root, "second");
    writeFileSync(first, "one\n", "utf8");
    writeFileSync(second, "two\n", "utf8");
    const plan = createTransactionPlan({
      id: "resume", projectDir: root, commonDir: root, inputDigest: "input", policyDigest: "policy", observedHash: "observed",
      writes: [
        { path: "first", beforeHash: fileHash(first), beforeContent: "one\n", afterContent: "ONE\n" },
        { path: "second", beforeHash: fileHash(second), beforeContent: "two\n", afterContent: "TWO\n" },
      ],
    });
    expect(() => apply(root, plan, { testInterruptAfterWrites: 1 })).toThrow("TEST_TRANSACTION_INTERRUPT");
    expect(() => apply(root, plan, { reobserveIndependent: () => "external-drift", recoveryApproval: recovery(plan) })).toThrow("TRANSACTION_PLAN_INVALID");
    expect(apply(root, plan, { recoveryApproval: recovery(plan) }).status).toBe("applied");
    const chain = readTransactionReceipts(root);
    expect(chain.map((receipt) => receipt.sequence)).toEqual([1, 2]);
    expect(chain[1].previousReceiptHash).toBe(chain[0].receiptHash);
    expect(readFileSync(first, "utf8")).toBe("ONE\n");
    expect(readFileSync(second, "utf8")).toBe("TWO\n");
  });

  it("refuses a third target hash without creating a final receipt or overwriting user data", () => {
    const root = fixture();
    const path = join(root, "target");
    writeFileSync(path, "before\n", "utf8");
    const plan = createTransactionPlan({
      id: "drift", projectDir: root, commonDir: root, inputDigest: "input", policyDigest: "policy", observedHash: "observed",
      writes: [{ path: "target", beforeHash: fileHash(path), beforeContent: "before\n", afterContent: "after\n" }],
    });
    writeFileSync(path, "user change\n", "utf8");
    expect(() => apply(root, plan)).toThrow("RECOVERY_REQUIRED");
    expect(readFileSync(path, "utf8")).toBe("user change\n");
    expect(existsSync(join(root, "harness/transactions/receipts"))).toBe(false);
  });

  it("keeps plan content and secret-shaped errors out of durable receipts", () => {
    const root = fixture();
    const path = join(root, "target");
    writeFileSync(path, "before\n", "utf8");
    const plan = createTransactionPlan({
      id: "redaction", projectDir: root, commonDir: root, inputDigest: "input", policyDigest: "policy", observedHash: "observed",
      writes: [{ path: "target", beforeHash: fileHash(path), beforeContent: "before\n", afterContent: "secret-canary\n" }],
    });
    expect(apply(root, plan).writes[0].afterHash).toBe(sha256("secret-canary\n"));
    expect(JSON.stringify(readTransactionReceipts(root))).not.toContain("secret-canary");
  });

  it("reclaims only a provably dead transaction lock after a process interruption", () => {
    const root = fixture();
    const path = join(root, "target");
    writeFileSync(path, "before\n", "utf8");
    mkdirSync(join(root, "harness/transactions/apply.lock"), { recursive: true });
    writeFileSync(join(root, "harness/transactions/apply.lock/owner.json"), JSON.stringify({ pid: 999_999_999 }), "utf8");
    const plan = createTransactionPlan({
      id: "stale-lock", projectDir: root, commonDir: root, inputDigest: "input", policyDigest: "policy", observedHash: "observed",
      writes: [{ path: "target", beforeHash: fileHash(path), beforeContent: "before\n", afterContent: "after\n" }],
    });
    expect(apply(root, plan).status).toBe("applied");
  });
});
