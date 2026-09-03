import { existsSync, mkdirSync, readdirSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { scrubSensitive } from "../credentials/service.js";
import { validSemanticApprovalPacket, type SemanticApprovalPacket } from "../approval/service.js";
import { requireMutationAllowed, type RecoveryApproval } from "../recovery/service.js";
import { assertCurrentHash, atomicWrite, durableWriteOnce, fileHash, hashObject, prettyJson, readJson, safePath, sha256, withoutHash } from "../v2/fs.js";

export interface TransactionWrite {
  path: string;
  beforeHash: string | null;
  beforeContent: string | null;
  afterContent: string;
}

export interface TransactionPlan {
  schemaVersion: "transaction-plan/3.0";
  kind: "transaction-plan";
  id: string;
  projectDir: string;
  commonDir: string;
  inputDigest: string;
  policyDigest: string;
  observedHash: string;
  writes: TransactionWrite[];
  planHash: string;
}

export interface TransactionApproval {
  schemaVersion: "semantic-approval-receipt/3.0";
  kind: "semantic-approval-receipt";
  planHash: string;
  inputDigest: string;
  policyDigest: string;
  observedHash: string;
  packetHash: string;
  packet: SemanticApprovalPacket;
  risk: "ordinary-reversible" | "human-required" | "protected";
  actor: string;
  actorType: "reviewer" | "human";
  verdict: "approved";
  approvedAt: string;
  expiresAt: string;
  approvalHash: string;
}

export interface TransactionReceipt {
  schemaVersion: "transaction-receipt/3.0";
  kind: "transaction-receipt";
  id: string;
  planId: string;
  planHash: string;
  inputDigest: string;
  policyDigest: string;
  observedHash: string;
  approvalHash: string;
  sequence: number;
  status: "started" | "applied" | "failed";
  previousReceiptHash: string | null;
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

function validId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}

function lock(commonDir: string): string {
  const path = lockPath(commonDir);
  mkdirSync(dirname(path), { recursive: true });
  try {
    mkdirSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    try {
      const owner = readJson<{ pid?: number }>(safePath(path, "owner.json"));
      if (!Number.isInteger(owner.pid) || owner.pid! <= 0) throw new Error("TRANSACTION_LOCKED");
      process.kill(owner.pid!, 0);
    } catch (ownerError) {
      if ((ownerError as NodeJS.ErrnoException).code !== "ESRCH") throw new Error("TRANSACTION_LOCKED");
      // ponytail: PID liveness is the bounded stale-lock recovery; use a fencing service only if cross-host transactions are added.
      rmSync(path, { recursive: true, force: false });
      mkdirSync(path);
    }
  }
  writeFileSync(safePath(path, "owner.json"), prettyJson({ pid: process.pid }), "utf8");
  return path;
}

function unlock(path: string): void {
  unlinkSync(safePath(path, "owner.json"));
  rmdirSync(path);
}

function receiptWithoutHash(receipt: TransactionReceipt): Omit<TransactionReceipt, "receiptHash"> {
  const copy: Partial<TransactionReceipt> = { ...receipt };
  delete copy.receiptHash;
  return copy as Omit<TransactionReceipt, "receiptHash">;
}

function approvalWithoutHash(approval: TransactionApproval): Omit<TransactionApproval, "approvalHash"> {
  const copy: Partial<TransactionApproval> = { ...approval };
  delete copy.approvalHash;
  return copy as Omit<TransactionApproval, "approvalHash">;
}

function receiptHash(receipt: Omit<TransactionReceipt, "receiptHash">): string {
  return hashObject(receipt);
}

export function readTransactionReceipts(commonDir: string): TransactionReceipt[] {
  const directory = receiptDirectory(commonDir);
  if (!existsSync(directory)) return [];
  const chain = readdirSync(directory).filter((name) => name.endsWith(".json")).map((name) => {
    if (!validId(name.slice(0, -5))) throw new Error("RECEIPT_PATH_INVALID");
    const receipt = readJson<TransactionReceipt>(safePath(directory, name));
    if (receipt.schemaVersion !== "transaction-receipt/3.0" || receipt.kind !== "transaction-receipt" ||
        !validId(receipt.id) || !validId(receipt.planId) ||
        receipt.receiptHash !== receiptHash(receiptWithoutHash(receipt))) throw new Error("RECEIPT_TAMPERED");
    return receipt;
  });
  chain.sort((left, right) => left.sequence - right.sequence);
  for (let index = 0; index < chain.length; index += 1) {
    if (chain[index].sequence !== index + 1 || chain[index].previousReceiptHash !== (index === 0 ? null : chain[index - 1].receiptHash)) throw new Error("RECEIPT_CHAIN_TAMPERED");
  }
  return chain;
}

function appendReceipt(commonDir: string, receipt: TransactionReceipt): void {
  const directory = receiptDirectory(commonDir);
  mkdirSync(directory, { recursive: true });
  const path = safePath(directory, `${receipt.id}.json`);
  try {
    durableWriteOnce(path, prettyJson(receipt));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("RECEIPT_WRITE_CONFLICT");
    throw error;
  }
  readTransactionReceipts(commonDir);
}

function nextReceipt(chain: TransactionReceipt[], plan: TransactionPlan, approval: TransactionApproval, status: TransactionReceipt["status"], writes: TransactionReceipt["writes"], error?: string): TransactionReceipt {
  const receipt: TransactionReceipt = {
    schemaVersion: "transaction-receipt/3.0", kind: "transaction-receipt", id: `transaction-${plan.id}-${chain.length + 1}`,
    planId: plan.id, planHash: plan.planHash, inputDigest: plan.inputDigest, policyDigest: plan.policyDigest,
    observedHash: plan.observedHash, approvalHash: approval.approvalHash, sequence: chain.length + 1,
    status, previousReceiptHash: chain.at(-1)?.receiptHash ?? null, writes, ...(error ? { error: scrubSensitive(error) } : {}), receiptHash: "",
  };
  receipt.receiptHash = receiptHash(receiptWithoutHash(receipt));
  return receipt;
}

export function createTransactionPlan(input: Omit<TransactionPlan, "schemaVersion" | "kind" | "planHash">): TransactionPlan {
  const plan: TransactionPlan = { schemaVersion: "transaction-plan/3.0", kind: "transaction-plan", ...input, planHash: "" };
  plan.planHash = hashObject(withoutHash(plan));
  return plan;
}

export function createTransactionApproval(input: Omit<TransactionApproval, "schemaVersion" | "kind" | "approvalHash">): TransactionApproval {
  const approval: TransactionApproval = { schemaVersion: "semantic-approval-receipt/3.0", kind: "semantic-approval-receipt", ...input, approvalHash: "" };
  approval.approvalHash = hashObject(approvalWithoutHash(approval));
  return approval;
}

export function validateTransactionPlan(plan: TransactionPlan, expectedProjectDir: string, expectedCommonDir: string, observedHash: string): void {
  if (plan.schemaVersion !== "transaction-plan/3.0" || plan.kind !== "transaction-plan" || !validId(plan.id) ||
      plan.planHash !== hashObject(withoutHash(plan)) || plan.projectDir !== expectedProjectDir || plan.commonDir !== expectedCommonDir ||
      plan.observedHash !== observedHash || !plan.inputDigest || !plan.policyDigest || plan.writes.length === 0 ||
      plan.writes.some((write) => write.beforeHash === null ? write.beforeContent !== null : write.beforeContent === null || sha256(write.beforeContent) !== write.beforeHash) ||
      plan.writes.some((write) => !write.path || write.path.split(/[\\/]/u).includes("..")) ||
      new Set(plan.writes.map((write) => write.path)).size !== plan.writes.length) throw new Error("TRANSACTION_PLAN_INVALID");
}

function validateApproval(plan: TransactionPlan, approval: TransactionApproval, now: Date): void {
  if (approval.schemaVersion !== "semantic-approval-receipt/3.0" || approval.kind !== "semantic-approval-receipt" ||
      approval.approvalHash !== hashObject(approvalWithoutHash(approval)) || !approval.actor || !approval.packetHash || approval.verdict !== "approved" ||
      approval.planHash !== plan.planHash || approval.inputDigest !== plan.inputDigest || approval.policyDigest !== plan.policyDigest || approval.observedHash !== plan.observedHash ||
      !["ordinary-reversible", "human-required", "protected"].includes(approval.risk) || !validSemanticApprovalPacket(approval.packet) ||
      approval.packetHash !== approval.packet.packetHash || approval.packet.planHash !== plan.planHash || approval.packet.inputHash !== plan.inputDigest || approval.packet.risk !== approval.risk ||
      !Number.isFinite(Date.parse(approval.approvedAt)) || Date.parse(approval.approvedAt) > now.getTime() || !Number.isFinite(Date.parse(approval.expiresAt)) || Date.parse(approval.expiresAt) <= now.getTime() ||
      (approval.risk === "ordinary-reversible" ? approval.actorType !== "reviewer" : approval.actorType !== "human")) throw new Error("TRANSACTION_APPROVAL_INVALID");
}

export function applyTransactionPlan(args: {
  plan: TransactionPlan;
  approval: TransactionApproval;
  expectedProjectDir: string;
  expectedCommonDir: string;
  reobserveIndependent: () => string;
  recoveryApproval?: RecoveryApproval;
  safeMode?: boolean;
  now?: Date;
  testInterruptAfterWrites?: number;
}): TransactionReceipt {
  const { plan } = args;
  requireMutationAllowed({ safeMode: args.safeMode });
  validateTransactionPlan(plan, args.expectedProjectDir, args.expectedCommonDir, args.reobserveIndependent());
  validateApproval(plan, args.approval, args.now ?? new Date());
  const held = lock(args.expectedCommonDir);
  try {
    const chain = readTransactionReceipts(args.expectedCommonDir);
    const prior = chain.find((receipt) => receipt.planHash === plan.planHash && receipt.status === "applied");
    if (prior) {
      for (const write of plan.writes) if (fileHash(safePath(args.expectedProjectDir, write.path)) !== sha256(write.afterContent)) throw new Error("TRANSACTION_IDEMPOTENCY_DRIFT");
      return prior;
    }
    // A started receipt is recoverable only when it is the newest receipt for this exact plan.
    const started = chain.at(-1)?.planHash === plan.planHash && chain.at(-1)?.status === "started" ? chain.at(-1) : undefined;
    if (started) requireMutationAllowed({ recoveryApproval: args.recoveryApproval, recoveryPlanHash: plan.planHash, recoveryPacketHash: args.approval.packetHash });
    for (const write of plan.writes) {
      const current = fileHash(safePath(args.expectedProjectDir, write.path));
      if (current !== write.beforeHash && (!started || current !== sha256(write.afterContent))) throw new Error("RECOVERY_REQUIRED: transaction target drifted");
    }
    if (!started) appendReceipt(args.expectedCommonDir, nextReceipt(chain, plan, args.approval, "started", []));
    const changed: Array<{ write: TransactionWrite; afterHash: string }> = [];
    const entries: TransactionReceipt["writes"] = [];
    try {
      for (const write of plan.writes) {
        const path = safePath(args.expectedProjectDir, write.path);
        const afterHash = sha256(write.afterContent);
        if (fileHash(path) === afterHash) {
          entries.push({ path: write.path, beforeHash: write.beforeHash, afterHash, status: "unchanged" });
          continue;
        }
        atomicWrite(path, write.afterContent);
        assertCurrentHash(path, afterHash);
        changed.push({ write, afterHash });
        entries.push({ path: write.path, beforeHash: write.beforeHash, afterHash, status: "applied" });
        if (args.testInterruptAfterWrites === changed.length) throw new Error("TEST_TRANSACTION_INTERRUPT");
      }
      appendReceipt(args.expectedCommonDir, nextReceipt(readTransactionReceipts(args.expectedCommonDir), plan, args.approval, "applied", entries));
      return readTransactionReceipts(args.expectedCommonDir).at(-1)!;
    } catch (error) {
      if (error instanceof Error && error.message === "TEST_TRANSACTION_INTERRUPT") throw error;
      for (const item of changed.reverse()) {
        const path = safePath(args.expectedProjectDir, item.write.path);
        if (fileHash(path) === item.afterHash) {
          if (item.write.beforeContent === null) unlinkSync(path); else atomicWrite(path, item.write.beforeContent);
          if (fileHash(path) === item.write.beforeHash) entries.find((entry) => entry.path === item.write.path)!.status = "compensated";
        } else entries.find((entry) => entry.path === item.write.path)!.status = "uncompensated";
      }
      const message = error instanceof Error ? error.message : String(error);
      appendReceipt(args.expectedCommonDir, nextReceipt(readTransactionReceipts(args.expectedCommonDir), plan, args.approval, "failed", entries, message));
      throw error;
    }
  } finally {
    unlock(held);
  }
}
