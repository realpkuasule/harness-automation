import { lstatSync } from "node:fs";
import { z } from "zod";
import { fileHash, hashObject, safePath } from "../v2/fs.js";
import { runGit } from "../repository/git.js";
import type { HumanScopeBinding } from "../approval/human.js";
import type { CoordinationRecord } from "./types.js";
import type { CoordinationObservation, CoordinationCommitIntent } from "./store.js";
import type { CoordinationClock } from "./clock.js";
import { requireWriteLease } from "./leases.js";
import { expectedRecord } from "./record.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const controlEpochSchema = z.object({
  schemaVersion: z.literal("coordination-epoch/1"), protocol: z.literal("github-coordination/1.0"),
  mode: z.enum(["isolated-qualification", "production"]), coordinationConfigDigest: digest,
  policy: z.discriminatedUnion("kind", [z.object({ kind: z.literal("none") }).strict(),
    z.object({ kind: z.literal("harness-policy-file"), sha256: digest }).strict()]),
}).strict();
export function controlEpochDigest(snapshot: z.infer<typeof controlEpochSchema>): string { return hashObject(controlEpochSchema.parse(snapshot)); }

/** Observation for a human-approved isolated snapshot; absence is explicit, never an invented policy. */
export function observeQualificationEpoch(root: string, configHash: string): z.infer<typeof controlEpochSchema> {
  const path = safePath(root, ".harness/policy.yaml"); const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error("COORDINATION_POLICY_SNAPSHOT_INVALID");
  return controlEpochSchema.parse({ schemaVersion: "coordination-epoch/1", protocol: "github-coordination/1.0",
    mode: "isolated-qualification", coordinationConfigDigest: configHash,
    policy: stat ? { kind: "harness-policy-file", sha256: fileHash(path) } : { kind: "none" } });
}

export type CoordinationOperation = "acquire" | "rebind" | "renew-reserve" | "renew-confirm" | "terminal-claim";
export type OperationAuthority = (operation: CoordinationOperation, current: CoordinationObservation, proposed: CoordinationRecord) => void;

/** Shared native lifecycle/candidate defense. A valid credential cannot assign some other actor's lease. */
export function qualificationOperationAuthority(projectDir: string, initial: HumanScopeBinding,
  observeBinding: () => HumanScopeBinding, refreshClock: () => CoordinationClock) {
  let pending: { operation: CoordinationOperation; current: CoordinationObservation; proposed: CoordinationRecord } | undefined;
  function validate(operation: CoordinationOperation, current: CoordinationObservation, proposed: CoordinationRecord) {
    const binding = observeBinding();
    if (hashObject(binding) !== hashObject(initial)) throw new Error("HUMAN_AUTHORIZATION_BINDING_MISMATCH");
    for (const record of [current.record, proposed].filter((item): item is CoordinationRecord => item !== null)) {
      if (record.repository !== binding.repository || record.repositoryId !== binding.repositoryId || record.owner !== binding.actor ||
          record.machine !== binding.hostId || record.controlEpochDigest !== controlEpochDigest(binding.controlEpoch)) throw new Error("COORDINATION_OPERATION_IDENTITY_MISMATCH");
    }
    if (operation === "terminal-claim") return; // Native PR evidence, not current local HEAD, establishes integration.
    const env = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
    const head = runGit(projectDir, ["--no-replace-objects", "rev-parse", "--verify", "HEAD^{commit}"], { env }).trim();
    const branch = runGit(projectDir, ["symbolic-ref", "--quiet", "HEAD"], { env }).trim();
    if (head !== proposed.lastObservedHead || branch !== `refs/heads/${proposed.branch}`) throw new Error("COORDINATION_WORKSPACE_HEAD_MISMATCH");
    if (current.record && operation !== "renew-confirm") requireWriteLease(current.record, expectedRecord(current.record), refreshClock());
    if (!proposed.expiresAt) throw new Error("COORDINATION_WRITE_LEASE_UNAVAILABLE");
    refreshClock().requireBefore(proposed.expiresAt);
  }
  return {
    prepare: ((operation, current, proposed) => {
      pending = undefined; validate(operation, current, proposed);
      pending = { operation, current: structuredClone(current), proposed: structuredClone(proposed) };
    }) satisfies OperationAuthority,
    assertCandidate(intent: CoordinationCommitIntent) {
      if (!pending || intent.recordHash !== pending.proposed.recordHash || intent.transactionId !== pending.proposed.transactionId ||
          intent.parentSha !== pending.current.controlSha) throw new Error("COORDINATION_OPERATION_AUTHORITY_REQUIRED");
      validate(pending.operation, pending.current, pending.proposed);
    },
  };
}
