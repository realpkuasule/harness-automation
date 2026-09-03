import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileHash, sha256 } from "../v2/fs.js";
import { applyTransactionPlan, createTransactionPlan } from "./service.js";

const roots: string[] = [];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-transaction-"));
  roots.push(root);
  return root;
}

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("transaction plan", () => {
  it("rejects tampered plans, serializes writers, and preserves same-byte retries", () => {
    const root = fixture();
    const path = join(root, "policy.json");
    writeFileSync(path, "before\n", "utf8");
    const plan = createTransactionPlan({
      id: "policy", projectDir: root, commonDir: root, observedHash: "observed",
      writes: [{ path: "policy.json", beforeHash: fileHash(path), beforeContent: "before\n", afterContent: "after\n" }],
    });
    expect(() => applyTransactionPlan({ plan: { ...plan, observedHash: "tampered" }, reobserve: () => "observed" }))
      .toThrow("TRANSACTION_PLAN_INVALID");
    const receipt = applyTransactionPlan({ plan, reobserve: () => "observed" });
    expect(receipt.status).toBe("applied");
    expect(readFileSync(path, "utf8")).toBe("after\n");
    expect(applyTransactionPlan({ plan, reobserve: () => "observed" })).toEqual(receipt);
  });

  it("does not compensate over user changes and detects receipt tampering", () => {
    const root = fixture();
    const first = join(root, "first");
    writeFileSync(first, "old\n", "utf8");
    const plan = createTransactionPlan({
      id: "failure", projectDir: root, commonDir: root, observedHash: "observed",
      writes: [
        { path: "first", beforeHash: fileHash(first), beforeContent: "old\n", afterContent: "new\n" },
        { path: "second", beforeHash: sha256("missing"), beforeContent: "missing", afterContent: "new\n" },
      ],
    });
    expect(() => applyTransactionPlan({ plan, reobserve: () => "observed" })).toThrow("RECOVERY_REQUIRED");
    expect(readFileSync(first, "utf8")).toBe("old\n");
    const receiptPath = join(root, "harness/transactions/receipts/transaction-failure-1.json");
    expect(existsSync(receiptPath)).toBe(false);
    mkdirSync(join(root, "harness/transactions/receipts"), { recursive: true });
    writeFileSync(join(root, "harness/transactions/receipts/forged.json"), "{}", "utf8");
    expect(() => applyTransactionPlan({ plan, reobserve: () => "observed" })).toThrow("RECEIPT_TAMPERED");
  });

  it("resumes an interrupted receipt only when every target is still at its exact before or after bytes", () => {
    const root = fixture();
    const first = join(root, "first");
    const second = join(root, "second");
    writeFileSync(first, "one\n", "utf8");
    writeFileSync(second, "two\n", "utf8");
    const plan = createTransactionPlan({
      id: "resume", projectDir: root, commonDir: root, observedHash: "observed",
      writes: [
        { path: "first", beforeHash: fileHash(first), beforeContent: "one\n", afterContent: "ONE\n" },
        { path: "second", beforeHash: fileHash(second), beforeContent: "two\n", afterContent: "TWO\n" },
      ],
    });
    expect(() => applyTransactionPlan({ plan, reobserve: () => "observed", testInterruptAfterWrites: 1 }))
      .toThrow("TEST_TRANSACTION_INTERRUPT");
    expect(applyTransactionPlan({ plan, reobserve: () => "changed-by-own-write" }).status).toBe("applied");
    expect(readFileSync(first, "utf8")).toBe("ONE\n");
    expect(readFileSync(second, "utf8")).toBe("TWO\n");
  });
});
