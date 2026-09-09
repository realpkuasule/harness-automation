import type { GitCommandResult } from "../repository/git.js";

/** A zero exit is not enough: Git can report up-to-date without performing the requested CAS. */
export function coordinationPushOutcome(result: Pick<GitCommandResult, "status" | "stdout" | "error">, head: string, ref: string): "updated" | "rejected" | "not-performed" | "unknown" {
  if (result.error || (result.status !== 0 && result.status !== 1)) return "unknown";
  const lines = result.stdout.split(/\r?\n/u); const rows = lines.filter((line) => line.includes("\t"));
  if (rows.length !== 1 || lines.filter((line) => line === "Done").length !== 1 || lines.filter(Boolean).at(-1) !== "Done") return "unknown";
  const match = /^([ *+=!-])\t([^:\t]+):([^\t]+)\t([^\r\n]+)$/u.exec(rows[0]);
  if (!match || match[2] !== head || match[3] !== ref) return "unknown";
  if (result.status === 1 && match[1] === "!" && match[4] === "[rejected] (stale info)") return "rejected";
  if (result.status !== 0) return "unknown";
  if (match[1] === "=" && match[4] === "[up to date]") return "not-performed";
  return [" ", "*", "+"].includes(match[1]) ? "updated" : "unknown";
}

export function requireCoordinationPush(result: GitCommandResult, head: string, ref: string): void {
  const outcome = coordinationPushOutcome(result, head, ref);
  if (outcome === "rejected") throw new Error("COORDINATION_CAS_CONFLICT");
  if (outcome === "not-performed") throw new Error("COORDINATION_CAS_NOT_PERFORMED");
  if (outcome !== "updated") throw new Error("COORDINATION_WRITE_OUTCOME_UNKNOWN");
}

/** Deletion has an empty source and a distinct positive flag. Absence alone never attributes this attempt. */
export function coordinationDeleteOutcome(result: Pick<GitCommandResult, "status" | "stdout" | "error">, ref: string): "deleted" | "rejected" | "unknown" {
  if (result.error || (result.status !== 0 && result.status !== 1)) return "unknown";
  const lines = result.stdout.split(/\r?\n/u); const rows = lines.filter((line) => line.includes("\t"));
  if (rows.length !== 1 || lines.filter((line) => line === "Done").length !== 1 || lines.filter(Boolean).at(-1) !== "Done") return "unknown";
  const match = /^([-!])\t(\(delete\))?:([^\t]+)\t([^\r\n]+)$/u.exec(rows[0]);
  if (!match || match[3] !== ref) return "unknown";
  // Git labels a rejected deletion's source `(delete)`, while a performed deletion has an empty source.
  if (result.status === 1 && match[1] === "!" && match[4] === "[rejected] (stale info)") return "rejected";
  return result.status === 0 && match[1] === "-" && !match[2] && match[4] === "[deleted]" ? "deleted" : "unknown";
}
