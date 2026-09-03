export const SAFE_MODE_COMMANDS = ["doctor", "audit", "plan", "receipt", "lkg", "recovery-plan", "recovery-verify"] as const;
export type SafeModeCommand = typeof SAFE_MODE_COMMANDS[number];

export function safeModeAllows(command: string): command is SafeModeCommand {
  return (SAFE_MODE_COMMANDS as readonly string[]).includes(command);
}

export function requireSafeModeCommand(command: string): void {
  if (!safeModeAllows(command)) throw new Error("SAFE_MODE_MUTATION_REJECTED");
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

/** Shared mutation boundary for existing domain-plan Apply paths. */
export function inspectRecoveryState(context: { projectDir: string; commonDir: string }): void {
  const receipts = safePath(context.commonDir, "harness/worktree-delivery/receipts");
  if (existsSync(receipts)) {
    for (const name of readdirSync(receipts).filter((entry) => entry.endsWith(".json"))) {
      const receipt = readJson<{ status?: string; id?: string }>(join(receipts, name));
      if (receipt.status === "started" || receipt.status === "failed") {
        throw new Error(`RECOVERY_REQUIRED: ${receipt.id ?? name}`);
      }
    }
  }
  const changes = safePath(context.projectDir, ".harness/changes");
  if (!existsSync(changes)) return;
  for (const id of readdirSync(changes)) {
    const journal = join(changes, id, "apply.json");
    if (!existsSync(journal)) continue;
    const state = readJson<{ status?: string }>(journal);
    if (state.status === "started" || state.status === "failed-uncompensated") throw new Error(`RECOVERY_REQUIRED: ${id}`);
  }
}

/** Every public mutation derives safe mode from durable journals; callers cannot disable it. */
export function requireMutationAllowed(context: { projectDir: string; commonDir: string }): void {
  inspectRecoveryState(context);
}
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readJson, safePath } from "../v2/fs.js";
