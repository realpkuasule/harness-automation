import { readTransactionReceipts, type TransactionReceipt } from "../transaction/service.js";

export const SAFE_MODE_COMMANDS = ["doctor", "audit", "plan", "receipt", "lkg", "recovery-plan", "recovery-verify"] as const;
export type SafeModeCommand = typeof SAFE_MODE_COMMANDS[number];

export function safeModeAllows(command: string): command is SafeModeCommand {
  return (SAFE_MODE_COMMANDS as readonly string[]).includes(command);
}

export function requireSafeModeCommand(command: string): void {
  if (!safeModeAllows(command)) throw new Error("SAFE_MODE_MUTATION_REJECTED");
}

export function loadLastKnownGood(commonDir: string): TransactionReceipt | null {
  let last: TransactionReceipt | null = null;
  for (const receipt of readTransactionReceipts(commonDir)) {
    if (receipt.status === "applied") last = receipt;
  }
  return last;
}

export interface RecoveryApproval {
  kind: "semantic-human-approval/3.0";
  planHash: string;
  packetHash: string;
  approvedBy: string;
  approvedAt: string;
  expiresAt: string;
}

export function recoveryExecutionAllowed(approval: RecoveryApproval | undefined, planHash: string, packetHash: string): void {
  if (!approval || approval.kind !== "semantic-human-approval/3.0" || !approval.approvedBy || approval.planHash !== planHash ||
      approval.packetHash !== packetHash || !Number.isFinite(Date.parse(approval.approvedAt)) || !Number.isFinite(Date.parse(approval.expiresAt)) ||
      Date.parse(approval.approvedAt) > Date.now() || Date.parse(approval.expiresAt) <= Date.now()) {
    throw new Error("RECOVERY_HUMAN_APPROVAL_REQUIRED");
  }
}

/** Shared mutation boundary for v2, worktree, and transaction Apply paths. */
export function requireMutationAllowed(args: {
  safeMode?: boolean;
  recoveryApproval?: RecoveryApproval;
  recoveryPlanHash?: string;
  recoveryPacketHash?: string;
}): void {
  if (args.safeMode) requireSafeModeCommand("apply");
  if (args.recoveryApproval || args.recoveryPlanHash || args.recoveryPacketHash) {
    recoveryExecutionAllowed(args.recoveryApproval, args.recoveryPlanHash ?? "", args.recoveryPacketHash ?? "");
  }
}
