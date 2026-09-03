import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertCurrentHash, atomicWrite, fileHash, hashObject, prettyJson, readJson, safePath, sha256, withoutHash } from "../v2/fs.js";

export interface TransactionWrite {
  path: string;
  beforeHash: string | null;
  beforeContent: string | null;
  afterContent: string;
}

export interface TransactionPlan {
  schemaVersion: "transaction-plan/1.0";
  kind: "transaction-plan";
  id: string;
  projectDir: string;
  commonDir: string;
  observedHash: string;
  writes: TransactionWrite[];
  planHash: string;
}

export interface TransactionReceipt {
  schemaVersion: "transaction-receipt/1.0";
  kind: "transaction-receipt";
  id: string;
  planHash: string;
  sequence: number;
  status: "started" | "applied" | "failed";
  previousReceiptHash: string | null;
  plan: TransactionPlan;
  writes: Array<{ path: string; beforeHash: string | null; afterHash: string; status: "applied" | "unchanged" | "compensated" | "uncompensated" }>;
  error?: string;
  receiptHash: string;
}

function receiptDirectory(commonDir: string): string {
  return safePath(commonDir, "harness/transactions/receipts");
}

function lockPath(commonDir: string): string {
  return safePath(commonDir, "harness/transactions/apply.lock");
}

function lock(commonDir: string): string {
  const path = lockPath(commonDir);
  mkdirSync(dirname(path), { recursive: true });
  try {
    mkdirSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("TRANSACTION_LOCKED");
    throw error;
  }
  return path;
}

function unlock(path: string): void {
  rmdirSync(path);
}

function receiptWithoutHash(receipt: TransactionReceipt): Omit<TransactionReceipt, "receiptHash"> {
  const copy: Partial<TransactionReceipt> = { ...receipt };
  delete copy.receiptHash;
  return copy as Omit<TransactionReceipt, "receiptHash">;
}

function receiptHash(receipt: Omit<TransactionReceipt, "receiptHash">): string {
  return hashObject(receipt);
}

export function readTransactionReceipts(commonDir: string): TransactionReceipt[] {
  const directory = receiptDirectory(commonDir);
  if (!existsSync(directory)) return [];
  const chain = readdirSync(directory).filter((name) => name.endsWith(".json")).map((name) => {
    const receipt = readJson<TransactionReceipt>(join(directory, name));
    if (receipt.schemaVersion !== "transaction-receipt/1.0" || receipt.kind !== "transaction-receipt" ||
        receipt.planHash !== hashObject(withoutHash(receipt.plan)) || receipt.receiptHash !== receiptHash(receiptWithoutHash(receipt))) {
      throw new Error("RECEIPT_TAMPERED");
    }
    return receipt;
  });
  chain.sort((left, right) => left.sequence - right.sequence);
  for (let index = 0; index < chain.length; index += 1) {
    if (chain[index].sequence !== index + 1 || chain[index].previousReceiptHash !== (index === 0 ? null : chain[index - 1].receiptHash)) {
      throw new Error("RECEIPT_CHAIN_TAMPERED");
    }
  }
  return chain;
}

function previousReceiptHash(commonDir: string): string | null {
  const chain = readTransactionReceipts(commonDir);
  return chain.at(-1)?.receiptHash ?? null;
}

function writeReceipt(commonDir: string, receipt: TransactionReceipt): void {
  const directory = receiptDirectory(commonDir);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${receipt.id}.json`);
  const descriptor = openSync(path, "wx");
  try {
    writeFileSync(descriptor, prettyJson(receipt), "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function createTransactionPlan(input: Omit<TransactionPlan, "schemaVersion" | "kind" | "planHash">): TransactionPlan {
  const plan: TransactionPlan = { schemaVersion: "transaction-plan/1.0", kind: "transaction-plan", ...input, planHash: "" };
  plan.planHash = hashObject(withoutHash(plan));
  return plan;
}

export function validateTransactionPlan(plan: TransactionPlan, projectDir: string, commonDir: string, observedHash: string): void {
  if (plan.schemaVersion !== "transaction-plan/1.0" || plan.kind !== "transaction-plan" ||
      plan.planHash !== hashObject(withoutHash(plan)) || plan.projectDir !== projectDir ||
      plan.commonDir !== commonDir || plan.observedHash !== observedHash || plan.writes.length === 0 ||
      plan.writes.some((write) => write.beforeHash === null ? write.beforeContent !== null :
        write.beforeContent === null || sha256(write.beforeContent) !== write.beforeHash) ||
      new Set(plan.writes.map((write) => write.path)).size !== plan.writes.length) {
    throw new Error("TRANSACTION_PLAN_INVALID");
  }
}

export function applyTransactionPlan(args: {
  plan: TransactionPlan;
  reobserve: () => string;
  testInterruptAfterWrites?: number;
}): TransactionReceipt {
  const { plan } = args;
  validateTransactionPlan(plan, plan.projectDir, plan.commonDir, plan.observedHash);
  const held = lock(plan.commonDir);
  try {
    const chain = readTransactionReceipts(plan.commonDir);
    const prior = chain.find((receipt) => receipt.planHash === plan.planHash && receipt.status === "applied");
    if (prior) {
      for (const write of plan.writes) {
        if (fileHash(safePath(plan.projectDir, write.path)) !== sha256(write.afterContent)) {
          throw new Error("TRANSACTION_IDEMPOTENCY_DRIFT");
        }
      }
      return prior;
    }
    const started = chain.find((receipt) => receipt.planHash === plan.planHash && receipt.status === "started");
    if (!started) validateTransactionPlan(plan, plan.projectDir, plan.commonDir, args.reobserve());
    for (const write of plan.writes) {
      const current = fileHash(safePath(plan.projectDir, write.path));
      if (current !== write.beforeHash && (!started || current !== sha256(write.afterContent))) {
        throw new Error("RECOVERY_REQUIRED: transaction target drifted");
      }
    }
    const sequence = chain.length + 1;
    if (!started) {
      const journal: TransactionReceipt = {
        schemaVersion: "transaction-receipt/1.0", kind: "transaction-receipt", id: `transaction-${plan.id}-${sequence}`,
        sequence, planHash: plan.planHash, status: "started", previousReceiptHash: previousReceiptHash(plan.commonDir),
        plan, writes: [], receiptHash: "",
      };
      journal.receiptHash = receiptHash(receiptWithoutHash(journal));
      writeReceipt(plan.commonDir, journal);
    }
    const changed: Array<{ write: TransactionWrite; afterHash: string }> = [];
    const entries: TransactionReceipt["writes"] = [];
    try {
      for (const write of plan.writes) {
        const path = safePath(plan.projectDir, write.path);
        const afterHash = sha256(write.afterContent);
        const current = fileHash(path);
        if (current === afterHash) {
          entries.push({ path: write.path, beforeHash: write.beforeHash, afterHash, status: "unchanged" });
          continue;
        }
        atomicWrite(path, write.afterContent);
        assertCurrentHash(path, afterHash);
        changed.push({ write, afterHash });
        entries.push({ path: write.path, beforeHash: write.beforeHash, afterHash, status: "applied" });
        if (args.testInterruptAfterWrites === changed.length) throw new Error("TEST_TRANSACTION_INTERRUPT");
      }
      const receipt: TransactionReceipt = {
        schemaVersion: "transaction-receipt/1.0", kind: "transaction-receipt",
        id: `transaction-${plan.id}-${sequence + 1}`, sequence: sequence + 1, planHash: plan.planHash,
        status: "applied", previousReceiptHash: previousReceiptHash(plan.commonDir), plan, writes: entries, receiptHash: "",
      };
      receipt.receiptHash = receiptHash(receiptWithoutHash(receipt));
      writeReceipt(plan.commonDir, receipt);
      return receipt;
    } catch (error) {
      if (error instanceof Error && error.message === "TEST_TRANSACTION_INTERRUPT") throw error;
      for (const item of changed.reverse()) {
        const path = safePath(plan.projectDir, item.write.path);
        if (fileHash(path) === item.afterHash) {
          if (item.write.beforeContent === null) unlinkSync(path);
          else atomicWrite(path, item.write.beforeContent);
          if (fileHash(path) === item.write.beforeHash) entries.find((entry) => entry.path === item.write.path)!.status = "compensated";
        } else {
          entries.find((entry) => entry.path === item.write.path)!.status = "uncompensated";
        }
      }
      const receipt: TransactionReceipt = {
        schemaVersion: "transaction-receipt/1.0", kind: "transaction-receipt",
        id: `transaction-${plan.id}-${sequence + 1}`, sequence: sequence + 1, planHash: plan.planHash,
        status: "failed", previousReceiptHash: previousReceiptHash(plan.commonDir), plan, writes: entries,
        error: error instanceof Error ? error.message : String(error), receiptHash: "",
      };
      receipt.receiptHash = receiptHash(receiptWithoutHash(receipt));
      writeReceipt(plan.commonDir, receipt);
      throw error;
    }
  } finally {
    unlock(held);
  }
}
