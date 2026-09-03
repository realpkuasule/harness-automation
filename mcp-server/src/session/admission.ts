import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { appendReceiptEvent, readLatestReceiptEvent } from "../receipt/service.js";
import { resolveRepositoryContext } from "../repository/git.js";
import { fileHash, hashObject, readJson, safePath } from "../v2/fs.js";
import { loadWorktreeConfig, loadWorktreeHostBinding } from "../worktree/config.js";
import { workspaceStatus } from "../worktree/service.js";
import type { WorkspaceLease } from "../worktree/types.js";
import {
  SESSION_ADMISSION_SCHEMA_VERSION,
  SESSION_INTENTS,
  sessionAdmissionRecordSchema,
  type SessionAdmissionFacts,
  type SessionAdmissionRecord,
  type SessionAdmissionResult,
  type SessionIntent,
} from "./types.js";

const contextReceiptSchema = z.object({
  schemaVersion: z.literal("2.0"),
  startedAt: z.string().datetime(),
  policyDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  owner: z.string().min(1),
  agent: z.enum(["portable", "claude-code", "codex"]),
}).strict();
const policyContextSchema = z.object({
  project: z.object({ owner: z.string().min(1) }).passthrough(),
}).passthrough();

export interface SessionAdmissionOptions {
  projectRoot: string;
  session: string;
  intent?: string;
  contextReceipt?: string;
  workItem?: string;
  reclassify?: boolean;
  managedWrite?: boolean;
  now?: Date;
}

interface ObservedAdmissionFacts {
  facts: SessionAdmissionFacts;
  mappingValid: boolean;
  deliveryFactsValid: boolean;
  coordinationRequired: boolean;
}

function fail(code: string, detail?: string): never {
  throw new Error(detail ? `${code}: ${detail}` : code);
}

function sessionId(input: string): string {
  const value = input.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) fail("SESSION_ADMISSION_SESSION_INVALID");
  return value;
}

function intent(input: string | undefined): SessionIntent | undefined {
  if (input === undefined) return undefined;
  if (!(SESSION_INTENTS as readonly string[]).includes(input)) {
    fail("SESSION_ADMISSION_INTENT_INVALID", "choose read-only, continue, new-code, or unclear");
  }
  return input as SessionIntent;
}

function workItem(input: string | undefined): string | null | undefined {
  if (input === undefined) return undefined;
  const value = input.trim();
  if (!value || value.length > 512 || /[\0\r\n]/u.test(value)) fail("SESSION_ADMISSION_WORK_ITEM_INVALID");
  return value;
}

function samePath(left: string, right: string): boolean {
  try {
    return realpathSync.native(left) === realpathSync.native(right);
  } catch {
    return resolve(left) === resolve(right);
  }
}

function normalizeContextReceipt(root: string, input: string | undefined): {
  path: string;
  hash: string;
  policyDigest: string;
} {
  if (!input) fail("SESSION_ADMISSION_CONTEXT_REQUIRED", "run `harness-automation context` and pass --context-receipt");
  if (input.includes("\\")) fail("SESSION_ADMISSION_CONTEXT_REQUIRED", "context receipt must use a repository-relative path");
  const normalized = input.startsWith("./") ? input.slice(2) : input;
  if (!/^\.harness\/sessions\/[A-Za-z0-9._-]+\.json$/u.test(normalized)) {
    fail("SESSION_ADMISSION_CONTEXT_REQUIRED", "context receipt must be under .harness/sessions");
  }
  const path = safePath(root, normalized);
  if (!existsSync(path)) fail("SESSION_ADMISSION_CONTEXT_REQUIRED", `missing ${normalized}`);
  let receipt: z.infer<typeof contextReceiptSchema>;
  let policy: z.infer<typeof policyContextSchema>;
  try {
    receipt = contextReceiptSchema.parse(readJson<unknown>(path));
    policy = policyContextSchema.parse(readJson<unknown>(safePath(root, ".harness/policy.yaml")));
  } catch {
    fail("SESSION_ADMISSION_CONTEXT_REQUIRED", "context receipt or effective policy is invalid");
  }
  const currentPolicyDigest = hashObject(policy);
  if (receipt.policyDigest !== currentPolicyDigest) {
    fail("SESSION_ADMISSION_CONTEXT_REQUIRED", "context receipt does not bind the current policy digest");
  }
  if (receipt.owner !== policy.project.owner) {
    fail("SESSION_ADMISSION_CONTEXT_REQUIRED", "context receipt owner does not match the current policy");
  }
  const hash = fileHash(path);
  if (!hash) fail("SESSION_ADMISSION_CONTEXT_REQUIRED", `unreadable ${normalized}`);
  return { path: normalized, hash, policyDigest: currentPolicyDigest };
}

function sortedLeases(leases: WorkspaceLease[]): WorkspaceLease[] {
  return [...leases].sort((left, right) => left.workItem.localeCompare(right.workItem));
}

function observeFacts(
  projectRoot: string,
  contextReceipt: string | undefined,
  requestedWorkItem: string | null,
): ObservedAdmissionFacts {
  const repository = resolveRepositoryContext(projectRoot);
  const loaded = loadWorktreeConfig(repository.projectDir);
  const binding = loadWorktreeHostBinding(repository.projectDir, repository.commonDir, loaded.legacyBinding);
  const status = workspaceStatus(binding.topology?.managementCheckout ?? repository.projectDir);
  const currentWorktree = status.worktrees.find((candidate) => samePath(candidate.path, repository.projectDir));
  if (!currentWorktree || currentWorktree.bare || currentWorktree.prunable) {
    fail("SESSION_ADMISSION_DELIVERY_FACTS_INVALID", "current checkout is not an active worktree");
  }
  if (hashObject(status.config) !== hashObject(loaded.config)) {
    fail("SESSION_ADMISSION_DELIVERY_FACTS_INVALID", "delivery config differs between current and management checkout");
  }

  const receipt = normalizeContextReceipt(repository.projectDir, contextReceipt);
  const currentLeases = sortedLeases(status.leases.filter((lease) => samePath(lease.path, repository.projectDir)));
  const currentLease = currentLeases.length === 1 ? currentLeases[0] : null;
  const leaseFingerprint = currentLeases.length === 0 ? null : hashObject(currentLeases);
  const managementCheckout = samePath(repository.projectDir, status.topology.managementCheckout) &&
    (status.config.managementBranch === undefined || currentWorktree.branch === status.config.managementBranch);
  const facts: SessionAdmissionFacts = {
    policyDigest: receipt.policyDigest,
    contextReceipt: receipt.path,
    contextReceiptHash: receipt.hash,
    repository: status.projectDir,
    commonDir: status.commonDir,
    cwd: repository.projectDir,
    branch: currentWorktree.branch,
    head: currentWorktree.head,
    configFingerprint: hashObject({
      configured: status.configured,
      config: status.config,
      hostBindingHash: status.hostBinding.hash,
      hostBindingTopology: status.hostBinding.topology ?? null,
    }),
    leaseFingerprint,
    workItem: requestedWorkItem,
    leaseWorkItem: currentLease?.workItem ?? null,
    managementCheckout,
  };
  const mappingValid = Boolean(
    requestedWorkItem &&
    currentLease &&
    currentLease.workItem === requestedWorkItem &&
    currentLease.status === "active" &&
    currentLease.branch === currentWorktree.branch &&
    currentLease.acceptedCommit === currentWorktree.head &&
    samePath(currentLease.path, repository.projectDir) &&
    !currentWorktree.detached,
  );
  return {
    facts,
    mappingValid,
    deliveryFactsValid: status.configured && status.mode === "enforced" && status.enforced && status.passing,
    coordinationRequired: status.config.provider.kind === "github",
  };
}

function recordFor(
  session: string,
  selectedIntent: SessionIntent,
  observed: ObservedAdmissionFacts,
  now: Date,
): SessionAdmissionRecord {
  let decision: SessionAdmissionRecord["decision"];
  let managedWriteAllowed = false;
  let reasonCodes: string[];
  switch (selectedIntent) {
    case "read-only":
      decision = "read-only";
      reasonCodes = ["SESSION_READ_ONLY"];
      break;
    case "continue":
      if (!observed.facts.workItem) fail("SESSION_ADMISSION_WORK_ITEM_REQUIRED", "continue requires --work-item");
      if (!observed.mappingValid) {
        fail("SESSION_ADMISSION_CONTINUE_MISMATCH", "work item, lease, worktree, branch, or delivery facts do not match");
      }
      decision = "continue";
      if (observed.coordinationRequired) {
        reasonCodes = ["COORDINATION_BACKEND_REQUIRED"];
      } else {
        if (!observed.deliveryFactsValid) fail("SESSION_ADMISSION_DELIVERY_FACTS_INVALID");
        managedWriteAllowed = true;
        reasonCodes = ["SESSION_CONTINUE_BOUND"];
      }
      break;
    case "new-code":
      decision = "prepare-required";
      reasonCodes = ["SESSION_PREPARE_REQUIRED"];
      break;
    case "unclear":
      decision = "unclear";
      reasonCodes = ["SESSION_INTENT_UNCLEAR"];
      break;
  }
  const record: SessionAdmissionRecord = {
    schemaVersion: SESSION_ADMISSION_SCHEMA_VERSION,
    kind: "session-admission",
    session,
    intent: selectedIntent,
    decision,
    enforcement: "managed-commands-only",
    managedWriteAllowed,
    facts: observed.facts,
    factsFingerprint: hashObject(observed.facts),
    reasonCodes,
    recordedAt: now.toISOString(),
  };
  return sessionAdmissionRecordSchema.parse(record);
}

function assertManagedWrite(record: SessionAdmissionRecord): void {
  if (record.managedWriteAllowed) return;
  if (record.reasonCodes.includes("COORDINATION_BACKEND_REQUIRED")) fail("COORDINATION_BACKEND_REQUIRED");
  if (record.decision === "prepare-required" && record.facts.managementCheckout) {
    fail("SESSION_MANAGEMENT_CHECKOUT_WRITE_FORBIDDEN", "prepare the delivery workspace before a managed write");
  }
  fail("SESSION_ADMISSION_MANAGED_WRITE_FORBIDDEN", record.decision);
}

function storedRecord(input: unknown, id: string): SessionAdmissionRecord {
  const parsed = sessionAdmissionRecordSchema.safeParse(input);
  if (!parsed.success || parsed.data.session !== id || parsed.data.factsFingerprint !== hashObject(parsed.data.facts)) {
    fail("SESSION_ADMISSION_RECEIPT_INVALID");
  }
  const expectedDecision = parsed.data.intent === "new-code" ? "prepare-required" : parsed.data.intent;
  if (parsed.data.decision !== expectedDecision || (parsed.data.managedWriteAllowed && parsed.data.intent !== "continue")) {
    fail("SESSION_ADMISSION_RECEIPT_INVALID");
  }
  return parsed.data;
}

/**
 * First-turn admission and deterministic later revalidation. This guards Harness-managed
 * mutations only; without a host pre-write hook it cannot prevent arbitrary filesystem writes.
 */
export function admitSession(options: SessionAdmissionOptions): SessionAdmissionResult {
  const id = sessionId(options.session);
  const selectedIntent = intent(options.intent);
  const key = { root: resolveRepositoryContext(options.projectRoot).commonDir, domain: "session-admission", transactionId: id } as const;
  const latest = readLatestReceiptEvent<SessionAdmissionRecord>(key);
  const previous = latest ? storedRecord(latest.snapshot, id) : null;
  const explicitWorkItem = workItem(options.workItem);
  const requestedWorkItem = explicitWorkItem ?? previous?.facts.workItem ?? null;
  const requestedReceipt = options.contextReceipt ?? previous?.facts.contextReceipt;
  const observed = observeFacts(options.projectRoot, requestedReceipt, requestedWorkItem);
  const factsFingerprint = hashObject(observed.facts);

  if (previous && latest) {
    const intentChanged = selectedIntent !== undefined && selectedIntent !== previous.intent;
    const workItemChanged = explicitWorkItem !== undefined && explicitWorkItem !== previous.facts.workItem;
    const factsChanged = factsFingerprint !== previous.factsFingerprint;
    if ((intentChanged || workItemChanged) && !options.reclassify) {
      fail(
        "SESSION_ADMISSION_RECLASSIFICATION_REQUIRED",
        [intentChanged ? "intent changed" : null, workItemChanged ? "work item changed" : null]
          .filter(Boolean).join("; "),
      );
    }
    if (!intentChanged && !workItemChanged && !factsChanged) {
      if (options.managedWrite) assertManagedWrite(previous);
      return { ...previous, reused: true, receiptSequence: latest.sequence, receiptEventHash: latest.eventHash };
    }
  }

  const effectiveIntent = selectedIntent ?? previous?.intent;
  if (!effectiveIntent) fail("SESSION_ADMISSION_INTENT_REQUIRED", "first admission requires --intent");
  const record = recordFor(id, effectiveIntent, observed, options.now ?? new Date());
  const event = appendReceiptEvent({ ...key, snapshot: record });
  if (options.managedWrite) assertManagedWrite(record);
  return { ...record, reused: false, receiptSequence: event.sequence, receiptEventHash: event.eventHash };
}
