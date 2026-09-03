import { existsSync, mkdirSync, readdirSync, rmdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  durableWriteOnce,
  fileHash,
  hashObject,
  prettyJson,
  readJson,
  safePath,
} from "../v2/fs.js";
import { readLatestReceiptEvent } from "../receipt/service.js";

export const SAFE_MODE_COMMANDS = ["doctor", "audit", "plan", "receipt", "lkg", "recovery-plan", "recovery-verify"] as const;
export type SafeModeCommand = typeof SAFE_MODE_COMMANDS[number];

export interface RecoveryContext {
  projectDir: string;
  commonDir: string;
  repository?: boolean;
}

export interface RecoveryApproval {
  schemaVersion: "recovery-approval/2.0";
  kind: "semantic-human-approval";
  id: string;
  targetKind: "file-apply" | "file-rollback" | "workspace";
  targetId: string;
  planHash: string;
  action: RecoveryAction;
  packetHash: string;
  evidenceHash: string;
  contextDigest: string;
  approvedBy: string;
  approvedAt: string;
  expiresAt: string;
  approvalHash: string;
}

export interface FileApplyOperation {
  path: string;
  beforeHash: string | null;
  afterHash: string;
}

export interface FileApplyJournal {
  schemaVersion: "file-apply-journal/1.0";
  kind: "file-apply-journal";
  recoveryId: string;
  planHash: string;
  operations: FileApplyOperation[];
  status: "started" | "failed-compensated" | "failed-uncompensated";
  written: string[];
  journalHash: string;
}

export interface FileRollbackJournal {
  schemaVersion: "file-rollback-journal/1.0";
  kind: "file-rollback-journal";
  recoveryId: string;
  planHash: string;
  appliedReceiptEventHash: string;
  operations: FileApplyOperation[];
  status: "started";
  restored: string[];
  journalHash: string;
}

export interface RecoveryFinding {
  kind: "file-apply" | "file-rollback" | "workspace" | "invalid";
  id: string;
  planHash?: string;
  action: RecoveryAction;
  packetHash: string;
  evidenceHash: string;
}

export type RecoveryAction = "resume-apply" | "resume-rollback" | "quarantine-invalid-evidence";

export function safeModeAllows(command: string): command is SafeModeCommand {
  return (SAFE_MODE_COMMANDS as readonly string[]).includes(command);
}

export function requireSafeModeCommand(command: string): void {
  if (!safeModeAllows(command)) throw new Error("SAFE_MODE_MUTATION_REJECTED");
}

function contextDigest(context: RecoveryContext): string {
  return hashObject({ projectDir: context.projectDir, commonDir: context.commonDir });
}

function recoveryRoot(context: RecoveryContext): string {
  return context.repository === false
    ? safePath(context.projectDir, ".harness/recovery")
    : safePath(context.commonDir, "harness/recovery");
}

/** This is the same lock path used by the worktree lifecycle. */
export function acquireMutationLock(context: RecoveryContext): string {
  const directory = context.repository === false
    ? safePath(context.projectDir, ".harness/locks")
    : safePath(context.commonDir, "harness/worktree-delivery");
  mkdirSync(directory, { recursive: true });
  const lock = join(directory, "apply.lock");
  try {
    mkdirSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`WORKSPACE_LOCKED: ${lock}`);
    }
    throw error;
  }
  return lock;
}

export function releaseMutationLock(lock: string): void {
  if (existsSync(lock)) rmdirSync(lock);
}

function withoutJournalHash(journal: FileApplyJournal): Omit<FileApplyJournal, "journalHash"> {
  const copy: Partial<FileApplyJournal> = { ...journal };
  delete copy.journalHash;
  return copy as Omit<FileApplyJournal, "journalHash">;
}

function withoutRollbackJournalHash(journal: FileRollbackJournal): Omit<FileRollbackJournal, "journalHash"> {
  const copy: Partial<FileRollbackJournal> = { ...journal };
  delete copy.journalHash;
  return copy as Omit<FileRollbackJournal, "journalHash">;
}

export function createFileApplyJournal(input: Omit<FileApplyJournal, "schemaVersion" | "kind" | "journalHash">): FileApplyJournal {
  const journal: FileApplyJournal = {
    schemaVersion: "file-apply-journal/1.0", kind: "file-apply-journal", ...input, journalHash: "",
  };
  journal.journalHash = hashObject(withoutJournalHash(journal));
  return journal;
}

export function createFileRollbackJournal(
  input: Omit<FileRollbackJournal, "schemaVersion" | "kind" | "journalHash">,
): FileRollbackJournal {
  const journal: FileRollbackJournal = {
    schemaVersion: "file-rollback-journal/1.0",
    kind: "file-rollback-journal",
    ...input,
    journalHash: "",
  };
  journal.journalHash = hashObject(withoutRollbackJournalHash(journal));
  return journal;
}

function validDigest(value: unknown, nullable = false): boolean {
  return (nullable && value === null) ||
    (typeof value === "string" && /^[a-f0-9]{64}$/u.test(value));
}

function validRelativePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !isAbsolute(value) &&
    !value.split(/[\\/]/u).includes("..");
}

export function validateFileApplyJournal(journal: FileApplyJournal): void {
  if (!journal || typeof journal !== "object" ||
      journal.schemaVersion !== "file-apply-journal/1.0" || journal.kind !== "file-apply-journal" ||
      !/^[a-f0-9-]{36}$/u.test(journal.recoveryId) || !validDigest(journal.planHash) ||
      !Array.isArray(journal.operations) || journal.operations.length === 0 ||
      !Array.isArray(journal.written) ||
      !["started", "failed-compensated", "failed-uncompensated"].includes(journal.status) ||
      new Set(journal.operations.map((operation) => operation.path)).size !== journal.operations.length ||
      journal.operations.some((operation) => !operation || !validRelativePath(operation.path) ||
        !validDigest(operation.beforeHash, true) || !validDigest(operation.afterHash)) ||
      new Set(journal.written).size !== journal.written.length ||
      journal.written.some((path) => !validRelativePath(path) ||
        !journal.operations.some((operation) => operation.path === path)) ||
      journal.journalHash !== hashObject(withoutJournalHash(journal))) {
    throw new Error("RECOVERY_JOURNAL_INVALID");
  }
}

export function validateFileRollbackJournal(journal: FileRollbackJournal): void {
  if (!journal || typeof journal !== "object" ||
      journal.schemaVersion !== "file-rollback-journal/1.0" || journal.kind !== "file-rollback-journal" ||
      !/^[a-f0-9-]{36}$/u.test(journal.recoveryId) || !validDigest(journal.planHash) ||
      !validDigest(journal.appliedReceiptEventHash) || !Array.isArray(journal.operations) ||
      journal.operations.length === 0 || journal.status !== "started" || !Array.isArray(journal.restored) ||
      new Set(journal.operations.map((operation) => operation.path)).size !== journal.operations.length ||
      journal.operations.some((operation) => !operation || !validRelativePath(operation.path) ||
        !validDigest(operation.beforeHash, true) || !validDigest(operation.afterHash)) ||
      new Set(journal.restored).size !== journal.restored.length ||
      journal.restored.some((path) => !validRelativePath(path) ||
        !journal.operations.some((operation) => operation.path === path)) ||
      journal.journalHash !== hashObject(withoutRollbackJournalHash(journal))) {
    throw new Error("RECOVERY_ROLLBACK_JOURNAL_INVALID");
  }
}

export function fileApplyRecoveryPacketHash(journal: FileApplyJournal, context: RecoveryContext): string {
  validateFileApplyJournal(journal);
  return hashObject({
    kind: "file-apply-recovery/1.0",
    recoveryId: journal.recoveryId,
    planHash: journal.planHash,
    operationsDigest: hashObject(journal.operations),
    action: "resume-apply",
    evidenceHash: journal.journalHash,
    contextDigest: contextDigest(context),
  });
}

function fileRollbackRecoveryPacketHash(journal: FileRollbackJournal, context: RecoveryContext): string {
  validateFileRollbackJournal(journal);
  return hashObject({
    kind: "file-rollback-recovery/1.0",
    recoveryId: journal.recoveryId,
    planHash: journal.planHash,
    appliedReceiptEventHash: journal.appliedReceiptEventHash,
    operationsDigest: hashObject(journal.operations),
    action: "resume-rollback",
    evidenceHash: journal.journalHash,
    contextDigest: contextDigest(context),
  });
}

function withoutApprovalHash(approval: RecoveryApproval): Omit<RecoveryApproval, "approvalHash"> {
  const copy: Partial<RecoveryApproval> = { ...approval };
  delete copy.approvalHash;
  return copy as Omit<RecoveryApproval, "approvalHash">;
}

export function createRecoveryApproval(args: {
  context: RecoveryContext;
  finding: RecoveryFinding;
  approvedBy: string;
  approvedAt: string;
  expiresAt: string;
}): RecoveryApproval {
  if (args.finding.kind === "invalid" || !args.finding.planHash) {
    throw new Error("RECOVERY_APPROVAL_TARGET_INVALID");
  }
  const approval: RecoveryApproval = {
    schemaVersion: "recovery-approval/2.0",
    kind: "semantic-human-approval",
    id: `recovery-${args.finding.packetHash.slice(0, 16)}-${hashObject({
      approvedBy: args.approvedBy,
      approvedAt: args.approvedAt,
      expiresAt: args.expiresAt,
    }).slice(0, 12)}`,
    targetKind: args.finding.kind,
    targetId: args.finding.id,
    planHash: args.finding.planHash,
    action: args.finding.action,
    packetHash: args.finding.packetHash,
    evidenceHash: args.finding.evidenceHash,
    contextDigest: contextDigest(args.context),
    approvedBy: args.approvedBy,
    approvedAt: args.approvedAt,
    expiresAt: args.expiresAt,
    approvalHash: "",
  };
  approval.approvalHash = hashObject(withoutApprovalHash(approval));
  return approval;
}

export function recordRecoveryApproval(context: RecoveryContext, approval: RecoveryApproval): string {
  validateRecoveryApproval(context, approval);
  const path = safePath(recoveryRoot(context), `approvals/${approval.id}.json`);
  durableWriteOnce(path, prettyJson(approval));
  return path;
}

function validateRecoveryApproval(context: RecoveryContext, approval: RecoveryApproval): void {
  if (!approval || typeof approval !== "object" || approval.schemaVersion !== "recovery-approval/2.0" ||
      approval.kind !== "semantic-human-approval" ||
      !/^recovery-[a-f0-9]{16}-[a-f0-9]{12}$/u.test(approval.id) ||
      !["file-apply", "file-rollback", "workspace"].includes(approval.targetKind) ||
      !approval.targetId || !["resume-apply", "resume-rollback"].includes(approval.action) ||
      !validDigest(approval.planHash) || !validDigest(approval.packetHash) || !validDigest(approval.evidenceHash) ||
      approval.contextDigest !== contextDigest(context) || !approval.approvedBy ||
      !Number.isFinite(Date.parse(approval.approvedAt)) || !Number.isFinite(Date.parse(approval.expiresAt)) ||
      approval.approvalHash !== hashObject(withoutApprovalHash(approval))) {
    throw new Error("RECOVERY_APPROVAL_INVALID");
  }
}

export function recoveryExecutionAllowed(
  context: RecoveryContext,
  approvalRef: string | undefined,
  finding: RecoveryFinding,
  now = new Date(),
): RecoveryApproval {
  if (!approvalRef || !/^recovery-[a-f0-9]{16}-[a-f0-9]{12}$/u.test(approvalRef)) {
    throw new Error("RECOVERY_HUMAN_APPROVAL_REQUIRED");
  }
  let approval: RecoveryApproval;
  try {
    approval = readJson<RecoveryApproval>(safePath(recoveryRoot(context), `approvals/${approvalRef}.json`));
    validateRecoveryApproval(context, approval);
  } catch {
    throw new Error("RECOVERY_HUMAN_APPROVAL_REQUIRED");
  }
  if (finding.kind === "invalid" || !finding.planHash || approval.id !== approvalRef ||
      approval.targetKind !== finding.kind || approval.targetId !== finding.id ||
      approval.planHash !== finding.planHash || approval.action !== finding.action ||
      approval.packetHash !== finding.packetHash || approval.evidenceHash !== finding.evidenceHash ||
      Date.parse(approval.approvedAt) > now.getTime() || Date.parse(approval.expiresAt) <= now.getTime()) {
    throw new Error("RECOVERY_HUMAN_APPROVAL_REQUIRED");
  }
  return approval;
}

function completedFileChange(projectDir: string, changeDir: string, journal: FileApplyJournal): boolean {
  const path = safePath(changeDir, "change.json");
  if (!existsSync(path)) return false;
  try {
    const change = readJson<{ planHash?: string; operations?: Array<{ path?: string; beforeHash?: string | null; afterHash?: string }> }>(path);
    return change.planHash === journal.planHash && Array.isArray(change.operations) &&
      hashObject(change.operations.map(({ path: itemPath, beforeHash, afterHash }) => ({ path: itemPath, beforeHash, afterHash }))) === hashObject(journal.operations) &&
      journal.operations.every((item) => fileHash(safePath(projectDir, item.path)) === item.afterHash);
  } catch {
    return false;
  }
}

interface FileRollbackReceiptSnapshot {
  schemaVersion: "file-rollback/1.0";
  kind: "file-rollback-receipt";
  id: string;
  planHash: string;
  appliedReceiptEventHash: string;
  status: "rolled-back";
  restored: string[];
  rolledBackAt: string;
  observedHash: string;
}

function completedFileRollback(
  context: RecoveryContext,
  id: string,
  journal: FileRollbackJournal,
): boolean {
  try {
    const marker = safePath(context.projectDir, `.harness/changes/${id}/rolled-back.json`);
    const compatibilitySnapshot = existsSync(marker) ? readJson<unknown>(marker) : undefined;
    const latest = readLatestReceiptEvent<FileRollbackReceiptSnapshot>({
      root: context.repository ? context.commonDir : context.projectDir,
      stateDirectory: context.repository ? "harness" : ".harness",
      domain: "file-rollback",
      transactionId: id,
      ...(compatibilitySnapshot === undefined ? {} : { compatibilitySnapshot }),
    });
    const receipt = latest?.snapshot;
    if (!receipt || receipt.schemaVersion !== "file-rollback/1.0" ||
        receipt.kind !== "file-rollback-receipt" || receipt.id !== id ||
        receipt.planHash !== journal.planHash || receipt.appliedReceiptEventHash !== journal.appliedReceiptEventHash ||
        receipt.status !== "rolled-back" || !Array.isArray(receipt.restored) ||
        !Number.isFinite(Date.parse(receipt.rolledBackAt)) || !validDigest(receipt.observedHash) ||
        hashObject(receipt.restored) !== hashObject(journal.operations.map((item) => item.path))) return false;
    const observedHash = hashObject(journal.operations.map((item) => ({
      path: item.path,
      sha256: fileHash(safePath(context.projectDir, item.path)),
    })));
    return observedHash === receipt.observedHash &&
      journal.operations.every((item) => fileHash(safePath(context.projectDir, item.path)) === item.beforeHash);
  } catch {
    return false;
  }
}

const WORKSPACE_OPERATIONS = ["configure", "allocate", "adopt", "migrate", "close", "rebind", "renew", "recover"] as const;
const WORKSPACE_STATUSES = ["started", "applied", "failed", "rolled-back"] as const;

interface WorkspaceRecoveryReceipt {
  schemaVersion: string;
  kind: string;
  id: string;
  planHash: string;
  operation: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  steps: Array<{ id: string; status: string; detail: string }>;
  before?: { observedHash?: string };
  after?: { observedHash?: string };
  beforeObservedHash?: string;
  mutationStarted?: boolean;
  compensationStatus?: string;
  compensationObservedHash?: string;
  rollbackStatus?: string;
}

function validateWorkspaceReceipt(receipt: WorkspaceRecoveryReceipt, expectedId: string): void {
  if (!receipt || typeof receipt !== "object" || receipt.schemaVersion !== "worktree-delivery/1.0" ||
      receipt.kind !== "workspace-receipt" || receipt.id !== expectedId || !validDigest(receipt.planHash) ||
      !(WORKSPACE_OPERATIONS as readonly string[]).includes(receipt.operation) ||
      !(WORKSPACE_STATUSES as readonly string[]).includes(receipt.status) ||
      !Number.isFinite(Date.parse(receipt.startedAt)) || !Array.isArray(receipt.steps) ||
      receipt.steps.some((step) => !step || typeof step.id !== "string" || typeof step.detail !== "string" ||
        !["applied", "failed", "compensated"].includes(step.status)) ||
      receipt.mutationStarted !== undefined && typeof receipt.mutationStarted !== "boolean" ||
      receipt.compensationStatus !== undefined && !["not-required", "completed", "failed"].includes(receipt.compensationStatus) ||
      receipt.rollbackStatus !== undefined && !["started", "completed", "failed"].includes(receipt.rollbackStatus)) {
    throw new Error("WORKSPACE_RECEIPT_INVALID");
  }
}

function workspaceNeedsRecovery(receipt: WorkspaceRecoveryReceipt): boolean {
  if (receipt.rollbackStatus === "started" || receipt.compensationStatus === "failed" || receipt.status === "started") return true;
  if (receipt.rollbackStatus === "failed") {
    return receipt.compensationStatus !== "completed" || !receipt.after?.observedHash ||
      receipt.compensationObservedHash !== receipt.after.observedHash;
  }
  if (receipt.status !== "failed") return false;
  const mutationStarted = receipt.mutationStarted ?? receipt.steps.some((step) =>
    step.status === "applied" || step.status === "compensated");
  if (!mutationStarted && (receipt.compensationStatus === undefined || receipt.compensationStatus === "not-required")) return false;
  return receipt.compensationStatus !== "completed" || !receipt.beforeObservedHash ||
    receipt.compensationObservedHash !== receipt.beforeObservedHash;
}

function workspaceRecoveryAction(receipt: WorkspaceRecoveryReceipt): RecoveryAction {
  return receipt.rollbackStatus === "started" || receipt.rollbackStatus === "failed"
    ? "resume-rollback"
    : "resume-apply";
}

function workspacePacketHash(context: RecoveryContext, receipt: WorkspaceRecoveryReceipt): string {
  const evidenceHash = hashObject(receipt);
  return hashObject({
    kind: "workspace-recovery/1.0",
    id: receipt.id,
    planHash: receipt.planHash,
    operation: receipt.operation,
    beforeObservedHash: receipt.beforeObservedHash ?? receipt.before?.observedHash ?? null,
    action: workspaceRecoveryAction(receipt),
    evidenceHash,
    contextDigest: contextDigest(context),
  });
}

/** Inspect durable journals without trusting caller-supplied safe-mode booleans. */
export function inspectRecoveryState(context: RecoveryContext): RecoveryFinding[] {
  const findings: RecoveryFinding[] = [];
  const receipts = safePath(context.commonDir, "harness/worktree-delivery/receipts");
  if (existsSync(receipts)) {
    for (const name of readdirSync(receipts).filter((entry) => entry.endsWith(".json"))) {
      const receiptPath = safePath(receipts, name);
      const id = name.slice(0, -5);
      if (!/^worktree-[A-Za-z0-9._-]{1,200}$/u.test(id)) {
        findings.push({ kind: "invalid", id: name, action: "quarantine-invalid-evidence", packetHash: hashObject({ kind: "invalid-workspace-receipt/1.0", name }), evidenceHash: hashObject(name) });
        continue;
      }
      try {
        const receipt = readJson<WorkspaceRecoveryReceipt>(receiptPath);
        validateWorkspaceReceipt(receipt, id);
        if (workspaceNeedsRecovery(receipt)) {
          findings.push({
            kind: "workspace",
            id,
            planHash: receipt.planHash,
            action: workspaceRecoveryAction(receipt),
            packetHash: workspacePacketHash(context, receipt),
            evidenceHash: hashObject(receipt),
          });
        }
      } catch {
        findings.push({ kind: "invalid", id, action: "quarantine-invalid-evidence", packetHash: hashObject({ kind: "invalid-workspace-receipt/1.0", id }), evidenceHash: fileHash(receiptPath) ?? hashObject(name) });
      }
    }
  }

  const changes = safePath(context.projectDir, ".harness/changes");
  if (!existsSync(changes)) return findings;
  for (const id of readdirSync(changes)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id)) {
      findings.push({ kind: "invalid", id, action: "quarantine-invalid-evidence", packetHash: hashObject({ kind: "invalid-change-id/1.0", id }), evidenceHash: hashObject(id) });
      continue;
    }
    const changeDir = safePath(changes, id);
    const journalPath = safePath(changeDir, "apply.json");
    if (existsSync(journalPath)) {
      try {
        const journal = readJson<FileApplyJournal>(journalPath);
        validateFileApplyJournal(journal);
        if (!completedFileChange(context.projectDir, changeDir, journal) && journal.status !== "failed-compensated") {
          findings.push({
            kind: "file-apply",
            id,
            planHash: journal.planHash,
            action: "resume-apply",
            packetHash: fileApplyRecoveryPacketHash(journal, context),
            evidenceHash: journal.journalHash,
          });
        }
      } catch {
        findings.push({ kind: "invalid", id, action: "quarantine-invalid-evidence", packetHash: hashObject({ kind: "invalid-file-journal/1.0", id }), evidenceHash: fileHash(journalPath) ?? hashObject(id) });
      }
    }
    const rollbackPath = safePath(changeDir, "rollback.json");
    if (existsSync(rollbackPath)) {
      try {
        const journal = readJson<FileRollbackJournal>(rollbackPath);
        validateFileRollbackJournal(journal);
        if (!completedFileRollback(context, id, journal)) {
          findings.push({
            kind: "file-rollback",
            id,
            planHash: journal.planHash,
            action: "resume-rollback",
            packetHash: fileRollbackRecoveryPacketHash(journal, context),
            evidenceHash: journal.journalHash,
          });
        }
      } catch {
        findings.push({ kind: "invalid", id, action: "quarantine-invalid-evidence", packetHash: hashObject({ kind: "invalid-rollback-journal/1.0", id }), evidenceHash: fileHash(rollbackPath) ?? hashObject(id) });
      }
    }
  }
  return findings;
}

/** Every transaction Apply derives safe mode from durable state under the repository mutation lock. */
export function requireMutationAllowed(
  context: RecoveryContext,
  recovery?: { kind: "file-apply" | "file-rollback" | "workspace"; id: string; action: Exclude<RecoveryAction, "quarantine-invalid-evidence">; approvalRef?: string; now?: Date },
): void {
  const findings = inspectRecoveryState(context);
  if (findings.length === 0) return;
  if (recovery) {
    const targets = findings.filter((finding) =>
      finding.kind === recovery.kind && finding.id === recovery.id && finding.action === recovery.action);
    if (targets.length === 1) {
      recoveryExecutionAllowed(context, recovery.approvalRef, targets[0], recovery.now);
      return;
    }
  }
  throw new Error(`RECOVERY_REQUIRED: ${findings.map((finding) => `${finding.kind}:${finding.id}`).join(",")}`);
}
