import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  appendLkgRecord,
  appendReceiptEvent,
  readLatestReceiptEvent,
  type ReceiptEvent,
} from "../receipt/service.js";
import { acquireMutationLock, releaseMutationLock } from "../recovery/service.js";
import { resolveRepositoryContext, runGit } from "../repository/git.js";
import {
  createGitHubWorkItem,
  listGitHubWorkItems,
  loadGitHubTrackingConfig,
  readGitHubWorkItem,
  updateGitHubWorkItem,
  type GitHubTrackingRequest,
  type GitHubWorkItem,
} from "../tracking/service.js";
import { durableWriteOnce, fileHash, hashObject, prettyJson, readJson, safePath, sha256, withoutHash } from "../v2/fs.js";
import { loadWorktreeConfig } from "../worktree/config.js";
import { applyWorkspacePlan, planWorkspaceAdoption, planWorkspaceAllocation, workspaceStatus } from "../worktree/service.js";
import type { WorkspaceLease, WorkspacePlan, WorkspaceReceipt } from "../worktree/types.js";
import { admitSession } from "../session/admission.js";
import { sessionAdmissionRecordSchema } from "../session/types.js";

export const DELIVERY_PREPARE_SCHEMA_VERSION = "delivery-prepare/1.0" as const;
export const DELIVERY_PREPARE_PHASES = [
  "planned",
  "work-item-admitted",
  "claim-acquired",
  "workspace-established",
  "binding-seeded",
  "prepared",
] as const;

const moduleDirectory = dirname(fileURLToPath(import.meta.url));

type PreparePhase = typeof DELIVERY_PREPARE_PHASES[number];
type PrepareMode = "github" | "local-only";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const gitObjectSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const nullableText = z.string().min(1).nullable();
const workspacePlanRefSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  archivePath: z.string().min(1),
  planHash: digestSchema,
}).strict();

export const deliveryPreparePlanSchema = z.object({
  schemaVersion: z.literal(DELIVERY_PREPARE_SCHEMA_VERSION),
  kind: z.literal("delivery-prepare-plan"),
  transactionId: z.string().regex(/^prepare-[a-f0-9]{24}$/u),
  session: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
  admissionEventHash: digestSchema,
  admissionFactsHash: digestSchema,
  confirmation: z.object({
    text: z.string().min(3).max(500),
    scope: z.literal("admit-work-item+establish-delivery-workspace+bind-session"),
    hash: digestSchema,
  }).strict(),
  requestHash: digestSchema,
  mode: z.enum(["github", "local-only"]),
  requestedWorkItem: nullableText,
  title: nullableText,
  description: z.string().max(20_000),
  priority: z.enum(["critical", "high", "medium", "low"]),
  phase: z.number().int().min(0).max(999),
  owner: z.string().min(1).max(128),
  requestedBranch: nullableText,
  requestedPath: nullableText,
  baseRef: z.string().min(1),
  baseSha: gitObjectSchema,
  adoptedHead: gitObjectSchema.nullable(),
  management: z.object({
    projectDir: z.string().min(1),
    commonDir: z.string().min(1),
    branch: z.string().min(1),
    head: gitObjectSchema,
    indexHash: gitObjectSchema,
    workingTreeHash: digestSchema,
  }).strict(),
  createdAt: z.string().datetime(),
  planHash: digestSchema,
}).strict();

export const deliveryPrepareJournalSchema = z.object({
  schemaVersion: z.literal(DELIVERY_PREPARE_SCHEMA_VERSION),
  kind: z.literal("delivery-prepare-journal"),
  transactionId: z.string().regex(/^prepare-[a-f0-9]{24}$/u),
  planHash: digestSchema,
  session: z.string().min(1),
  mode: z.enum(["github", "local-only"]),
  phase: z.enum(DELIVERY_PREPARE_PHASES),
  state: z.enum(["Observed", "Admitted", "Prepared"]),
  outcome: z.enum(["InProgress", "PreparedNotOpened", "CoordinationBackendRequired", "RecoveryRequired"]),
  blocked: z.boolean(),
  workItem: nullableText,
  branch: nullableText,
  path: nullableText,
  baseSha: gitObjectSchema,
  workspacePlan: workspacePlanRefSchema.nullable(),
  workspaceReceiptId: nullableText,
  observedHash: digestSchema.nullable(),
  error: z.string().min(1).max(2_000).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  journalHash: digestSchema,
}).strict();

export const deliveryPrepareReceiptSchema = z.object({
  schemaVersion: z.literal(DELIVERY_PREPARE_SCHEMA_VERSION),
  kind: z.literal("delivery-prepare-receipt"),
  transactionId: z.string().regex(/^prepare-[a-f0-9]{24}$/u),
  planHash: digestSchema,
  session: z.string().min(1),
  mode: z.enum(["github", "local-only"]),
  phase: z.enum(DELIVERY_PREPARE_PHASES),
  state: z.enum(["Admitted", "Prepared"]),
  outcome: z.enum(["PreparedNotOpened", "CoordinationBackendRequired"]),
  attachments: z.array(z.enum(["Blocked"])).max(1),
  workItem: z.string().min(1),
  branch: nullableText,
  path: nullableText,
  baseSha: gitObjectSchema,
  workspaceReceiptId: nullableText,
  reused: z.boolean(),
  receiptSequence: z.number().int().positive(),
  receiptEventHash: digestSchema,
  lkgRecordHash: digestSchema.nullable(),
}).strict();

export type DeliveryPreparePlan = z.infer<typeof deliveryPreparePlanSchema>;
export type DeliveryPrepareJournal = z.infer<typeof deliveryPrepareJournalSchema>;
export type DeliveryPrepareReceipt = z.infer<typeof deliveryPrepareReceiptSchema>;

export interface DeliveryPrepareOptions {
  projectRoot: string;
  session: string;
  confirmation: string;
  baseRef: string;
  baseSha: string;
  localOnly?: boolean;
  workItem?: string;
  title?: string;
  description?: string;
  priority?: "critical" | "high" | "medium" | "low";
  phase?: number;
  owner: string;
  branch?: string;
  path?: string;
  now?: Date;
  /** Test seam. Production GitHub Prepare waits for the credential-bound Wave 3 adapter. */
  githubRequest?: GitHubTrackingRequest;
  /** Deterministic crash injection used only by transaction tests. */
  testFailAfter?: PreparePhase;
  /** Simulates process death after the workspace planner writes its immutable plan. */
  testCrashAfterWorkspacePlan?: boolean;
}

export const localTaskSchema = z.object({
  id: z.string().min(1),
  phase: z.number().int().min(0),
  status: z.enum(["pending", "in_progress", "completed", "deleted"]),
  title: z.string().min(1),
  description: z.string().min(1),
  priority: z.enum(["critical", "high", "medium", "low"]),
  blockedBy: z.array(z.string().min(1)),
  blocks: z.array(z.string().min(1)),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  createdBy: z.string().min(1),
  updatedBy: z.string().min(1),
  relatedFiles: z.array(z.string().min(1)),
}).strict();
export const localBoardSchema = z.object({
  schemaVersion: z.literal("1.0"),
  meta: z.object({ project: z.string().min(1), updated: z.string().min(1) }).strict(),
  tasks: z.array(localTaskSchema),
}).strict();

function fail(code: string, detail?: string): never {
  throw new Error(detail ? `${code}: ${detail}` : code);
}

function text(input: string | undefined, name: string, required = false, maximum = 20_000): string | null {
  if (input === undefined) {
    if (required) fail(`DELIVERY_PREPARE_${name}_REQUIRED`);
    return null;
  }
  const normalized = input.trim();
  if (!normalized || normalized.length > maximum || /[\0]/u.test(normalized)) {
    fail(`DELIVERY_PREPARE_${name}_INVALID`);
  }
  return normalized;
}

function transactionId(session: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(session)) fail("DELIVERY_PREPARE_SESSION_INVALID");
  return `prepare-${sha256(session).slice(0, 24)}`;
}

function requestFingerprint(options: DeliveryPrepareOptions, mode: PrepareMode): string {
  return hashObject({
    session: options.session,
    confirmation: options.confirmation.trim(),
    mode,
    workItem: options.workItem?.trim() ?? null,
    title: options.title?.trim() ?? null,
    description: options.description?.trim() ?? "",
    priority: options.priority ?? "medium",
    phase: options.phase ?? 0,
    owner: options.owner.trim(),
    branch: options.branch?.trim() ?? null,
    path: options.path ?? null,
    baseRef: options.baseRef,
    baseSha: options.baseSha,
  });
}

function managementStatus(root: string, ignoredPlanPath?: string): string {
  const observed = runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (!ignoredPlanPath) return observed;
  const exactUntrackedEntry = `?? ${ignoredPlanPath}`;
  let removed = 0;
  const filtered = observed.split("\0").filter((entry) => {
    if (entry !== exactUntrackedEntry) return true;
    removed += 1;
    return false;
  }).join("\0");
  if (removed > 1) fail("DELIVERY_PREPARE_ORPHAN_PLAN_STATUS_AMBIGUOUS");
  return filtered;
}

function managementSnapshot(root: string, commonDir: string, ignoredPlanPath?: string): DeliveryPreparePlan["management"] {
  const branch = runGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], { fallbackError: true }).trim();
  if (!branch) fail("DELIVERY_PREPARE_MANAGEMENT_BRANCH_REQUIRED");
  return {
    projectDir: root,
    commonDir,
    branch,
    head: runGit(root, ["rev-parse", "HEAD"]).trim(),
    indexHash: runGit(root, ["write-tree"]).trim(),
    workingTreeHash: workingTreeEvidence(root, ignoredPlanPath),
  };
}

function preparePlanPath(commonDir: string, id: string): string {
  return safePath(commonDir, `harness/delivery-prepare/plans/${id}.json`);
}

function confirmationHash(plan: Omit<DeliveryPreparePlan, "planHash"> | DeliveryPreparePlan): string {
  return hashObject({
    text: plan.confirmation.text,
    scope: plan.confirmation.scope,
    admissionEventHash: plan.admissionEventHash,
    admissionFactsHash: plan.admissionFactsHash,
    mode: plan.mode,
    requestedWorkItem: plan.requestedWorkItem,
    title: plan.title,
    description: plan.description,
    priority: plan.priority,
    phase: plan.phase,
    owner: plan.owner,
    branchSelector: plan.requestedBranch ?? "codex/{id}-{slug(title)}",
    pathSelector: plan.requestedPath ?? "configured-worktree-root/{id}",
    baseRef: plan.baseRef,
    baseSha: plan.baseSha,
    adoptedHead: plan.adoptedHead,
    management: plan.management,
  });
}

function journalProjection(commonDir: string, id: string): { root: string; path: string } {
  return { root: commonDir, path: `harness/delivery-prepare/journals/${id}.json` };
}

function parsePlan(value: unknown): DeliveryPreparePlan {
  const plan = deliveryPreparePlanSchema.parse(value);
  if (hashObject(withoutHash(plan)) !== plan.planHash || plan.confirmation.hash !== confirmationHash(plan)) {
    fail("DELIVERY_PREPARE_PLAN_TAMPERED");
  }
  return plan;
}

function parseJournal(value: unknown): DeliveryPrepareJournal {
  const journal = deliveryPrepareJournalSchema.parse(value);
  const unhashed = { ...journal, journalHash: "" };
  delete (unhashed as Partial<DeliveryPrepareJournal>).journalHash;
  if (hashObject(unhashed) !== journal.journalHash) fail("DELIVERY_PREPARE_JOURNAL_TAMPERED");
  return journal;
}

function currentJournal(commonDir: string, id: string): { journal: DeliveryPrepareJournal; event: ReceiptEvent<DeliveryPrepareJournal> } | null {
  const projection = journalProjection(commonDir, id);
  const projectionPath = safePath(projection.root, projection.path);
  const compatibilitySnapshot = existsSync(projectionPath) ? parseJournal(readJson<unknown>(projectionPath)) : undefined;
  const event = readLatestReceiptEvent<DeliveryPrepareJournal>({
    root: commonDir,
    domain: "delivery-prepare",
    transactionId: id,
    ...(compatibilitySnapshot ? { compatibilitySnapshot } : {}),
  });
  if (!event) return null;
  return { journal: parseJournal(event.snapshot), event };
}

function journalSnapshot(
  plan: DeliveryPreparePlan,
  previous: DeliveryPrepareJournal | null,
  update: Partial<Omit<DeliveryPrepareJournal, "schemaVersion" | "kind" | "transactionId" | "planHash" | "session" | "mode" | "baseSha" | "createdAt" | "updatedAt" | "journalHash">>,
  now: Date,
): DeliveryPrepareJournal {
  const phase = update.phase ?? previous?.phase ?? "planned";
  if (previous && DELIVERY_PREPARE_PHASES.indexOf(phase) < DELIVERY_PREPARE_PHASES.indexOf(previous.phase)) {
    fail("DELIVERY_PREPARE_PHASE_REGRESSION");
  }
  const draft: DeliveryPrepareJournal = {
    schemaVersion: DELIVERY_PREPARE_SCHEMA_VERSION,
    kind: "delivery-prepare-journal",
    transactionId: plan.transactionId,
    planHash: plan.planHash,
    session: plan.session,
    mode: plan.mode,
    phase,
    state: update.state ?? previous?.state ?? "Observed",
    outcome: update.outcome ?? previous?.outcome ?? "InProgress",
    blocked: update.blocked ?? previous?.blocked ?? false,
    workItem: update.workItem === undefined ? previous?.workItem ?? null : update.workItem,
    branch: update.branch === undefined ? previous?.branch ?? null : update.branch,
    path: update.path === undefined ? previous?.path ?? null : update.path,
    baseSha: plan.baseSha,
    workspacePlan: update.workspacePlan === undefined ? previous?.workspacePlan ?? null : update.workspacePlan,
    workspaceReceiptId: update.workspaceReceiptId === undefined ? previous?.workspaceReceiptId ?? null : update.workspaceReceiptId,
    observedHash: update.observedHash === undefined ? previous?.observedHash ?? null : update.observedHash,
    error: update.error === undefined ? previous?.error ?? null : update.error,
    createdAt: previous?.createdAt ?? now.toISOString(),
    updatedAt: now.toISOString(),
    journalHash: "",
  };
  const unhashed = { ...draft };
  delete (unhashed as Partial<DeliveryPrepareJournal>).journalHash;
  draft.journalHash = hashObject(unhashed);
  return deliveryPrepareJournalSchema.parse(draft);
}

function appendJournal(
  plan: DeliveryPreparePlan,
  previous: { journal: DeliveryPrepareJournal; event: ReceiptEvent<DeliveryPrepareJournal> } | null,
  update: Parameters<typeof journalSnapshot>[2],
  now: Date,
): { journal: DeliveryPrepareJournal; event: ReceiptEvent<DeliveryPrepareJournal> } {
  const latest = currentJournal(plan.management.commonDir, plan.transactionId);
  if ((latest?.event.eventHash ?? null) !== (previous?.event.eventHash ?? null)) {
    fail("DELIVERY_PREPARE_JOURNAL_CONCURRENT_UPDATE");
  }
  const journal = journalSnapshot(plan, previous?.journal ?? null, update, now);
  const event = appendReceiptEvent({
    root: plan.management.commonDir,
    domain: "delivery-prepare",
    transactionId: plan.transactionId,
    snapshot: journal,
    projection: journalProjection(plan.management.commonDir, plan.transactionId),
  });
  return { journal, event };
}

async function withMutationLock<T>(plan: DeliveryPreparePlan, action: () => Promise<T> | T): Promise<T> {
  const lock = acquireMutationLock({
    projectDir: plan.management.projectDir,
    commonDir: plan.management.commonDir,
    repository: true,
  });
  try {
    return await action();
  } finally {
    releaseMutationLock(lock);
  }
}

function modeFor(root: string, localOnly: boolean): PrepareMode {
  const loaded = loadWorktreeConfig(root);
  if (!loaded.configured || loaded.config.mode !== "enforced") fail("DELIVERY_PREPARE_WORKTREE_ENFORCEMENT_REQUIRED");
  if (loaded.config.provider.kind === "none") {
    if (!localOnly) fail("DELIVERY_PREPARE_LOCAL_ONLY_CONFIRMATION_REQUIRED", "pass --local-only");
    return "local-only";
  }
  if (localOnly) fail("DELIVERY_PREPARE_TRACKING_MODE_MISMATCH", "a configured remote provider cannot fall back to Local-only");
  if (loaded.config.provider.kind !== "github") fail("DELIVERY_PREPARE_PROVIDER_UNSUPPORTED");
  return "github";
}

function contentDigest(path: string): string {
  const stat = lstatSync(path);
  const hash = createHash("sha256");
  if (stat.isSymbolicLink()) hash.update(`symlink\0${readlinkSync(path)}`);
  else if (stat.isFile()) hash.update(readFileSync(path));
  else hash.update(`other\0${stat.mode}\0${stat.size}`);
  return hash.digest("hex");
}

function workingTreeEvidence(root: string, ignoredPlanPath?: string): string {
  const untracked = runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter((path) => path && path !== ignoredPlanPath)
    .sort()
    .map((path) => ({ path, digest: contentDigest(safePath(root, path)) }));
  return hashObject({
    porcelain: managementStatus(root, ignoredPlanPath),
    trackedDiff: sha256(runGit(root, ["diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD", "--"])),
    untracked,
  });
}

function adoptedHead(
  root: string,
  requestedWorkItem: string | null,
  requestedBranch: string | null,
  requestedPath: string | null,
): string | null {
  if (!requestedWorkItem || !requestedBranch || !requestedPath || !existsSync(requestedPath)) return null;
  const id = requestedWorkItem.slice(Math.max(requestedWorkItem.lastIndexOf(":"), requestedWorkItem.lastIndexOf("#")) + 1);
  const branch = requestedBranch.replaceAll("{id}", id);
  const status = workspaceStatus(root, { adoptionSafe: true, providerWorkItems: [requestedWorkItem] });
  const canonicalPath = (path: string): string => existsSync(path) ? realpathSync.native(path) : resolve(path);
  const matches = status.worktrees.filter((worktree) => canonicalPath(worktree.path) === canonicalPath(requestedPath) && worktree.branch === branch);
  if (matches.length !== 1 || matches[0].detached || matches[0].bare || matches[0].locked || matches[0].prunable || matches[0].dirty) {
    fail("DELIVERY_PREPARE_ADOPTION_FACTS_INVALID");
  }
  return matches[0].head;
}

function validateAdmission(plan: DeliveryPreparePlan, now?: Date): void {
  const current = admitSession({ projectRoot: plan.management.projectDir, session: plan.session, now });
  if (current.receiptEventHash !== plan.admissionEventHash || current.factsFingerprint !== plan.admissionFactsHash ||
      current.intent !== "new-code" || current.decision !== "prepare-required" || current.managedWriteAllowed ||
      current.facts.repository !== plan.management.projectDir || current.facts.commonDir !== plan.management.commonDir ||
      current.facts.branch !== plan.management.branch || current.facts.head !== plan.management.head ||
      !current.facts.managementCheckout) {
    fail("DELIVERY_PREPARE_ADMISSION_DRIFT");
  }
}

function validateAdoptedHead(plan: DeliveryPreparePlan): void {
  if (plan.adoptedHead !== null && (
    !plan.requestedPath || !existsSync(plan.requestedPath) ||
    runGit(plan.requestedPath, ["rev-parse", "HEAD"]).trim() !== plan.adoptedHead
  )) fail("DELIVERY_PREPARE_ADOPTION_HEAD_DRIFT");
}

function loadOrCreatePlan(options: DeliveryPrepareOptions): DeliveryPreparePlan {
  const context = resolveRepositoryContext(options.projectRoot);
  const id = transactionId(options.session);
  const path = preparePlanPath(context.commonDir, id);
  const mode = modeFor(context.projectDir, options.localOnly === true);
  const fingerprint = requestFingerprint(options, mode);
  if (existsSync(path)) {
    const stored = parsePlan(readJson<unknown>(path));
    if (stored.transactionId !== id || stored.requestHash !== fingerprint || stored.management.projectDir !== context.projectDir ||
        stored.management.commonDir !== context.commonDir) {
      fail("DELIVERY_PREPARE_TRANSACTION_CONFLICT", "this session already has a different Prepare plan");
    }
    return stored;
  }

  const confirmation = text(options.confirmation, "CONFIRMATION", true, 500)!;
  const owner = text(options.owner, "OWNER", true, 128)!;
  const requestedWorkItem = text(options.workItem, "WORK_ITEM", false, 512);
  const title = text(options.title, "TITLE", requestedWorkItem === null, 200);
  const description = options.description?.trim() ?? "";
  if (description.length > 20_000 || /\0/u.test(description)) fail("DELIVERY_PREPARE_DESCRIPTION_INVALID");
  const requestedBranch = text(options.branch, "BRANCH", false, 255);
  const requestedPath = text(options.path, "PATH", false, 4_096);
  if (requestedPath !== null && !isAbsolute(requestedPath)) fail("DELIVERY_PREPARE_PATH_INVALID", "path must be absolute");
  const phase = options.phase ?? 0;
  if (!Number.isInteger(phase) || phase < 0 || phase > 999) fail("DELIVERY_PREPARE_PHASE_INVALID");
  const priority = options.priority ?? "medium";
  if (!["critical", "high", "medium", "low"].includes(priority)) fail("DELIVERY_PREPARE_PRIORITY_INVALID");

  // Reuse Admission's complete deterministic revalidation rather than trusting a stale receipt subset.
  admitSession({ projectRoot: context.projectDir, session: options.session, now: options.now });
  const admissionEvent = readLatestReceiptEvent<unknown>({
    root: context.commonDir,
    domain: "session-admission",
    transactionId: options.session,
  });
  if (!admissionEvent) fail("DELIVERY_PREPARE_ADMISSION_REQUIRED", "run session admit with intent new-code first");
  const admission = sessionAdmissionRecordSchema.parse(admissionEvent.snapshot);
  if (admission.session !== options.session || admission.intent !== "new-code" || admission.decision !== "prepare-required" ||
      admission.managedWriteAllowed || !admission.facts.managementCheckout ||
      admission.facts.repository !== context.projectDir || admission.facts.commonDir !== context.commonDir ||
      admission.factsFingerprint !== hashObject(admission.facts)) {
    fail("DELIVERY_PREPARE_ADMISSION_INVALID");
  }
  const management = managementSnapshot(context.projectDir, context.commonDir);
  if (admission.facts.branch !== management.branch || admission.facts.head !== management.head) {
    fail("DELIVERY_PREPARE_ADMISSION_DRIFT", "management Branch or HEAD changed after admission");
  }
  const baseRef = text(options.baseRef, "BASE_REF", true, 512)!;
  const baseSha = text(options.baseSha, "BASE_SHA", true, 64)!;
  if (baseRef !== `refs/heads/${management.branch}` || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(baseSha) ||
      runGit(context.projectDir, ["rev-parse", "--verify", `${baseRef}^{commit}`]).trim() !== baseSha || baseSha !== management.head) {
    fail("DELIVERY_PREPARE_BASE_DRIFT");
  }
  const selectedAdoptedHead = adoptedHead(
    context.projectDir,
    requestedWorkItem,
    requestedBranch,
    requestedPath,
  );
  const draft: DeliveryPreparePlan = {
    schemaVersion: DELIVERY_PREPARE_SCHEMA_VERSION,
    kind: "delivery-prepare-plan",
    transactionId: id,
    session: options.session,
    admissionEventHash: admissionEvent.eventHash,
    admissionFactsHash: admission.factsFingerprint,
    confirmation: {
      text: confirmation,
      scope: "admit-work-item+establish-delivery-workspace+bind-session",
      hash: "0".repeat(64),
    },
    requestHash: fingerprint,
    mode,
    requestedWorkItem,
    title,
    description,
    priority,
    phase,
    owner,
    requestedBranch,
    requestedPath,
    baseRef,
    baseSha,
    adoptedHead: selectedAdoptedHead,
    management,
    createdAt: (options.now ?? new Date()).toISOString(),
    planHash: "0".repeat(64),
  };
  draft.confirmation.hash = confirmationHash(draft);
  draft.planHash = hashObject(withoutHash(draft));
  const plan = deliveryPreparePlanSchema.parse(draft);
  try {
    durableWriteOnce(path, prettyJson(plan));
    return plan;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const concurrent = parsePlan(readJson<unknown>(path));
    if (concurrent.transactionId !== id || concurrent.requestHash !== fingerprint ||
        concurrent.management.projectDir !== context.projectDir || concurrent.management.commonDir !== context.commonDir) {
      fail("DELIVERY_PREPARE_TRANSACTION_CONFLICT", "a concurrent Prepare won with different inputs");
    }
    return concurrent;
  }
}

function marker(plan: DeliveryPreparePlan): string {
  return `<!-- harness-automation:delivery-prepare:${plan.transactionId}:${plan.planHash} -->`;
}

function localBoard(plan: DeliveryPreparePlan): z.infer<typeof localBoardSchema> {
  const path = safePath(plan.management.commonDir, "harness/local-tracking/TASK.json");
  if (!existsSync(path)) return { schemaVersion: "1.0", meta: { project: "local", updated: plan.createdAt }, tasks: [] };
  return localBoardSchema.parse(readJson<unknown>(path));
}

async function runLocalTaskScript(plan: DeliveryPreparePlan, args: string[]): Promise<void> {
  const scriptDirectory = [
    join(moduleDirectory, "..", "scripts"),
    join(moduleDirectory, "..", "..", "..", "scripts"),
  ].find((candidate) => {
    const task = join(candidate, "task.py");
    const helper = join(candidate, "local_tracking.py");
    return existsSync(task) && existsSync(helper) && lstatSync(task).isFile() && !lstatSync(task).isSymbolicLink() &&
      lstatSync(helper).isFile() && !lstatSync(helper).isSymbolicLink();
  });
  if (!scriptDirectory) fail("DELIVERY_PREPARE_BUNDLED_TASK_SCRIPT_REQUIRED");
  const script = join(scriptDirectory, "task.py");
  const command = process.platform === "win32" ? "python" : "python3";
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    LANG: process.env.LANG ?? "C.UTF-8",
    HARNESS_REPO_ROOT: plan.management.projectDir,
    PYTHONDONTWRITEBYTECODE: "1",
  };
  for (const name of ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"] as const) {
    if (process.env[name]) env[name] = process.env[name];
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [script, "--local-only", ...args], {
      cwd: plan.management.projectDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    const capture = (chunk: Buffer): void => {
      size += chunk.length;
      if (size <= 1024 * 1024) chunks.push(chunk);
      else child.kill();
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 30_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`DELIVERY_PREPARE_LOCAL_TASK_COMMAND_FAILED: ${error.message}`));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const detail = Buffer.concat(chunks).toString("utf8").trim().slice(0, 2_000);
      if (timedOut) reject(new Error("DELIVERY_PREPARE_LOCAL_TASK_COMMAND_TIMEOUT"));
      else if (size > 1024 * 1024) reject(new Error("DELIVERY_PREPARE_LOCAL_TASK_COMMAND_OUTPUT_LIMIT"));
      else if (code !== 0) reject(new Error(`DELIVERY_PREPARE_LOCAL_TASK_COMMAND_FAILED: ${detail || `exit ${code ?? "unknown"}`}`));
      else resolve();
    });
  });
}

function localId(input: string): string {
  const match = /^local:([A-Za-z0-9][A-Za-z0-9._-]*)$/u.exec(input);
  if (!match) fail("DELIVERY_PREPARE_LOCAL_WORK_ITEM_INVALID");
  return match[1];
}

async function admitLocalWorkItem(plan: DeliveryPreparePlan): Promise<string> {
  if (plan.requestedWorkItem) {
    const id = localId(plan.requestedWorkItem);
    await runLocalTaskScript(plan, ["show", id]);
    const task = localBoard(plan).tasks.find((candidate) => candidate.id === id);
    if (!task || task.status === "deleted") fail("DELIVERY_PREPARE_LOCAL_WORK_ITEM_INVALID", plan.requestedWorkItem);
    return `local:${id}`;
  }
  const token = marker(plan);
  let matches = localBoard(plan).tasks.filter((task) => task.description.includes(token));
  if (matches.length > 1) fail("DELIVERY_PREPARE_LOCAL_WORK_ITEM_AMBIGUOUS");
  if (matches.length === 0) {
    await runLocalTaskScript(plan, [
      "add",
      String(plan.phase),
      plan.title!,
      `${plan.description || plan.title!}\n\n${token}`,
      "--priority",
      plan.priority,
      "--by",
      plan.owner,
    ]);
    matches = localBoard(plan).tasks.filter((task) => task.description.includes(token));
  }
  if (matches.length !== 1 || matches[0].status === "deleted" || matches[0].title !== plan.title) {
    fail("DELIVERY_PREPARE_LOCAL_WORK_ITEM_READBACK_FAILED");
  }
  return `local:${matches[0].id}`;
}

function githubIssueNumber(workItem: string, repository: string): number {
  const prefix = `github:${repository}#`;
  const selected = workItem.startsWith(prefix) ? workItem.slice(prefix.length) : "";
  if (!/^[1-9][0-9]*$/u.test(selected)) fail("DELIVERY_PREPARE_GITHUB_WORK_ITEM_INVALID");
  return Number(selected);
}

function verifyOpenIssue(issue: GitHubWorkItem): GitHubWorkItem {
  if (issue.state !== "OPEN") fail("DELIVERY_PREPARE_GITHUB_WORK_ITEM_CLOSED", `#${issue.number}`);
  return issue;
}

function verifyProjectReadback(issue: GitHubWorkItem, configured: boolean): GitHubWorkItem {
  if (configured && (!issue.projectItemId || !issue.projectStatus || !issue.projectPriority)) {
    fail("DELIVERY_PREPARE_GITHUB_PROJECT_READBACK_REQUIRED", `#${issue.number}`);
  }
  return issue;
}

function githubIssueBody(plan: DeliveryPreparePlan): string {
  const token = marker(plan);
  return `${plan.description}${plan.description ? "\n\n" : ""}${token}`;
}

function admitGitHubWorkItem(plan: DeliveryPreparePlan, request?: GitHubTrackingRequest): string {
  if (!request) fail("DELIVERY_PREPARE_GITHUB_CREDENTIAL_REQUIRED");
  const loaded = loadGitHubTrackingConfig(plan.management.projectDir);
  if (plan.requestedWorkItem) {
    const number = githubIssueNumber(plan.requestedWorkItem, loaded.config.repository);
    verifyProjectReadback(
      verifyOpenIssue(readGitHubWorkItem({ ...loaded, issue: number, request })),
      loaded.config.project !== undefined,
    );
    return `github:${loaded.config.repository}#${number}`;
  }
  const token = marker(plan);
  const matches = listGitHubWorkItems({ ...loaded, request }).items.filter((issue) => issue.body.includes(token));
  if (matches.length > 1) fail("DELIVERY_PREPARE_GITHUB_WORK_ITEM_AMBIGUOUS");
  const expectedBody = githubIssueBody(plan);
  let issue = matches.length === 1
    ? verifyOpenIssue(matches[0])
    : createGitHubWorkItem({
      ...loaded,
      title: plan.title!,
      body: expectedBody,
      ...(loaded.config.project ? { priority: plan.priority } : {}),
      request,
    });
  if (issue.title !== plan.title || issue.body !== expectedBody) {
    fail("DELIVERY_PREPARE_GITHUB_WORK_ITEM_DRIFT", `#${issue.number}`);
  }
  if (loaded.config.project && (
    !issue.projectItemId || issue.projectStatus !== loaded.config.project.defaultStatus ||
    issue.projectPriority !== plan.priority
  )) {
    issue = updateGitHubWorkItem({
      ...loaded,
      issue: issue.number,
      status: loaded.config.project.defaultStatus,
      priority: plan.priority,
      request,
    });
  }
  verifyProjectReadback(verifyOpenIssue(issue), loaded.config.project !== undefined);
  return `github:${loaded.config.repository}#${issue.number}`;
}

function branchName(plan: DeliveryPreparePlan, workItem: string): string {
  const id = workItem.slice(Math.max(workItem.lastIndexOf(":"), workItem.lastIndexOf("#")) + 1);
  if (plan.requestedBranch) return plan.requestedBranch.replaceAll("{id}", id);
  const slug = (plan.title ?? "work")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 48) || "work";
  return `codex/${id}-${slug}`;
}

function loadWorkspacePlan(plan: DeliveryPreparePlan, reference: NonNullable<DeliveryPrepareJournal["workspacePlan"]>): WorkspacePlan {
  const path = safePath(plan.management.projectDir, reference.path);
  const archivePath = safePath(plan.management.commonDir, reference.archivePath);
  const value = readJson<WorkspacePlan>(archivePath);
  if (value.id !== reference.id || value.planHash !== reference.planHash || hashObject(withoutHash(value)) !== value.planHash) {
    fail("DELIVERY_PREPARE_WORKSPACE_PLAN_TAMPERED");
  }
  const content = prettyJson(value);
  if (!existsSync(path)) durableWriteOnce(path, content);
  else if (fileHash(path) !== sha256(content)) fail("DELIVERY_PREPARE_WORKSPACE_PLAN_TAMPERED");
  return value;
}

function archiveWorkspacePlan(
  plan: DeliveryPreparePlan,
  workspacePlan: WorkspacePlan,
  relativePath: string,
): NonNullable<DeliveryPrepareJournal["workspacePlan"]> {
  const archivePath = `harness/delivery-prepare/workspace-plans/${plan.transactionId}.json`;
  const target = safePath(plan.management.commonDir, archivePath);
  const content = prettyJson(workspacePlan);
  try {
    durableWriteOnce(target, content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || fileHash(target) !== sha256(content)) throw error;
  }
  return { id: workspacePlan.id, path: relativePath, archivePath, planHash: workspacePlan.planHash };
}

function cleanupWorkspacePlan(plan: DeliveryPreparePlan, workspacePlan: WorkspacePlan, relativePath: string): void {
  const path = safePath(plan.management.projectDir, relativePath);
  if (fileHash(path) !== sha256(prettyJson(workspacePlan))) fail("DELIVERY_PREPARE_WORKSPACE_PLAN_CLEANUP_UNSAFE");
  unlinkSync(path);
}

function preparedLease(workspacePlan: WorkspacePlan): WorkspaceLease {
  if (workspacePlan.operation.kind === "allocate") return workspacePlan.operation.lease;
  if (workspacePlan.operation.kind === "adopt" && workspacePlan.operation.items.length === 1) {
    return workspacePlan.operation.items[0].lease;
  }
  fail("DELIVERY_PREPARE_WORKSPACE_PLAN_INVALID");
}

interface OrphanWorkspacePlan {
  plan: WorkspacePlan;
  path: string;
}

function transactionOwnedOrphanWorkspacePlan(
  plan: DeliveryPreparePlan,
  workItem: string,
  branch: string,
  adoption: boolean,
): OrphanWorkspacePlan | null {
  const expectedHead = adoption ? plan.adoptedHead : plan.baseSha;
  if (!expectedHead) fail("DELIVERY_PREPARE_ADOPTION_HEAD_REQUIRED");
  const directory = safePath(plan.management.projectDir, ".harness/plans");
  if (!existsSync(directory)) return null;
  const matches: OrphanWorkspacePlan[] = [];
  for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".json")).sort()) {
    const relativePath = `.harness/plans/${name}`;
    const path = safePath(plan.management.projectDir, relativePath);
    try {
      if (!lstatSync(path).isFile()) continue;
      const candidate = readJson<WorkspacePlan>(path);
      if (candidate.schemaVersion !== "worktree-delivery/1.0" || candidate.kind !== "workspace-plan" ||
          `${candidate.id}.json` !== name || candidate.createdAt !== plan.createdAt ||
          candidate.projectDir !== plan.management.projectDir || candidate.commonDir !== plan.management.commonDir ||
          candidate.planHash !== hashObject(withoutHash(candidate)) ||
          candidate.operation.kind !== (adoption ? "adopt" : "allocate")) continue;
      const lease = preparedLease(candidate);
      if (lease.workItem !== workItem || lease.branch !== branch || lease.owner !== plan.owner ||
          lease.thread !== plan.session || lease.acceptedCommit !== expectedHead || lease.createdAt !== plan.createdAt ||
          lease.heartbeatAt !== plan.createdAt || lease.status !== "active") continue;
      if (candidate.operation.kind === "allocate" && (
        !candidate.operation.createBranch || candidate.operation.startPoint !== plan.baseSha ||
        candidate.operation.providerObservationBound !== true
      )) continue;
      if (candidate.operation.kind === "adopt" && candidate.operation.providerObservationBound !== true) continue;
      matches.push({ plan: candidate, path: relativePath });
    } catch {
      // Unrelated or damaged plans remain visible to the ordinary management drift check.
    }
  }
  if (matches.length > 1) fail("DELIVERY_PREPARE_ORPHAN_PLAN_AMBIGUOUS");
  if (matches.length === 0) return null;
  const status = workspaceStatus(plan.management.projectDir, {
    ...(adoption ? { adoptionSafe: true } : {}),
    providerWorkItems: [workItem],
  });
  if (matches[0].plan.observedHash !== status.observedHash) fail("DELIVERY_PREPARE_ORPHAN_PLAN_DRIFT");
  return matches[0];
}

function verifyPreparedWorkspace(
  plan: DeliveryPreparePlan,
  workItem: string,
  workspacePlan: WorkspacePlan,
  receipt: WorkspaceReceipt,
): string {
  const lease = preparedLease(workspacePlan);
  const expectedHead = plan.adoptedHead ?? plan.baseSha;
  if (receipt.status !== "applied" || receipt.operation !== workspacePlan.operation.kind) {
    fail("DELIVERY_PREPARE_WORKSPACE_APPLY_FAILED");
  }
  const status = workspaceStatus(plan.management.projectDir);
  const leases = status.leases.filter((lease) => lease.workItem === workItem);
  const worktrees = status.worktrees.filter((worktree) => worktree.path === lease.path);
  if (leases.length !== 1 || worktrees.length !== 1) fail("DELIVERY_PREPARE_WORKSPACE_READBACK_FAILED");
  const observedLease = leases[0];
  const worktree = worktrees[0];
  if (observedLease.branch !== lease.branch || observedLease.path !== lease.path || observedLease.owner !== plan.owner ||
      observedLease.thread !== plan.session || observedLease.acceptedCommit !== expectedHead ||
      observedLease.status !== "active" || worktree.branch !== lease.branch ||
      worktree.head !== expectedHead || worktree.detached || worktree.bare || worktree.locked || worktree.prunable || worktree.dirty) {
    fail("DELIVERY_PREPARE_WORKSPACE_READBACK_FAILED");
  }
  return status.observedHash;
}

function assertManagementUnchanged(plan: DeliveryPreparePlan, ignoredPlanPath?: string): void {
  if (hashObject(managementSnapshot(plan.management.projectDir, plan.management.commonDir, ignoredPlanPath)) !== hashObject(plan.management)) {
    fail("DELIVERY_PREPARE_MANAGEMENT_CHECKOUT_DRIFT");
  }
}

function finalReceipt(
  plan: DeliveryPreparePlan,
  journal: DeliveryPrepareJournal,
  event: ReceiptEvent<DeliveryPrepareJournal>,
  reused: boolean,
): DeliveryPrepareReceipt {
  if (!journal.workItem || (journal.outcome === "PreparedNotOpened" && (!journal.branch || !journal.path))) {
    fail("DELIVERY_PREPARE_RECEIPT_INVALID");
  }
  const lkg = journal.outcome === "PreparedNotOpened"
    ? appendLkgRecord({
        root: plan.management.commonDir,
        domain: "delivery-prepare",
        transactionId: plan.transactionId,
        appliedReceiptEventHash: event.eventHash,
        planHash: plan.planHash,
        observedHash: journal.observedHash ?? hashObject({ state: journal.state, outcome: journal.outcome, workItem: journal.workItem }),
      })
    : null;
  return deliveryPrepareReceiptSchema.parse({
    schemaVersion: DELIVERY_PREPARE_SCHEMA_VERSION,
    kind: "delivery-prepare-receipt",
    transactionId: plan.transactionId,
    planHash: plan.planHash,
    session: plan.session,
    mode: plan.mode,
    phase: journal.phase,
    state: journal.state,
    outcome: journal.outcome,
    attachments: journal.blocked ? ["Blocked"] : [],
    workItem: journal.workItem,
    branch: journal.branch,
    path: journal.path,
    baseSha: plan.baseSha,
    workspaceReceiptId: journal.workspaceReceiptId,
    reused,
    receiptSequence: event.sequence,
    receiptEventHash: event.eventHash,
    lkgRecordHash: lkg?.recordHash ?? null,
  });
}

function maybeFail(options: DeliveryPrepareOptions, phase: PreparePhase): void {
  if (options.testFailAfter === phase) throw new Error(`TEST_DELIVERY_PREPARE_AFTER_${phase.toUpperCase().replaceAll("-", "_")}`);
}

function reached(current: DeliveryPrepareJournal, phase: PreparePhase): boolean {
  return DELIVERY_PREPARE_PHASES.indexOf(current.phase) >= DELIVERY_PREPARE_PHASES.indexOf(phase);
}

/** One confirmed, journaled Prepare event. It never substitutes Local-only for a configured GitHub project. */
async function prepareDeliveryTransaction(options: DeliveryPrepareOptions): Promise<DeliveryPrepareReceipt> {
  const plan = loadOrCreatePlan(options);
  validateAdmission(plan, options.now);
  let current = currentJournal(plan.management.commonDir, plan.transactionId);
  if (current && (current.journal.outcome === "PreparedNotOpened" || current.journal.outcome === "CoordinationBackendRequired")) {
    return withMutationLock(plan, () => finalReceipt(plan, current!.journal, current!.event, true));
  }
  validateAdoptedHead(plan);
  try {
    if (!current) {
      current = await withMutationLock(plan, () => appendJournal(plan, null, { phase: "planned" }, options.now ?? new Date()));
      maybeFail(options, "planned");
    }

    if (!current.journal.workItem) {
      const workItem = await withMutationLock(plan, async () => {
        assertManagementUnchanged(plan);
        return plan.mode === "local-only"
          ? admitLocalWorkItem(plan)
          : admitGitHubWorkItem(plan, options.githubRequest);
      });
      current = await withMutationLock(plan, () => appendJournal(plan, current!, {
        phase: "work-item-admitted",
        state: "Admitted",
        workItem,
        error: null,
      }, options.now ?? new Date()));
      maybeFail(options, "work-item-admitted");
    }

    if (plan.mode === "github") {
      current = await withMutationLock(plan, () => appendJournal(plan, current!, {
        state: "Admitted",
        outcome: "CoordinationBackendRequired",
        blocked: true,
        observedHash: hashObject({ mode: plan.mode, state: "Admitted", workItem: current!.journal.workItem }),
        error: null,
      }, options.now ?? new Date()));
      return withMutationLock(plan, () => finalReceipt(plan, current!.journal, current!.event, false));
    }

    let workspacePlan: WorkspacePlan;
    if (current.journal.workspacePlan) {
      workspacePlan = loadWorkspacePlan(plan, current.journal.workspacePlan);
    } else {
      const branch = branchName(plan, current.journal.workItem!);
      const adopt = plan.requestedWorkItem !== null && plan.requestedBranch !== null &&
        plan.requestedPath !== null && existsSync(plan.requestedPath);
      const orphan = transactionOwnedOrphanWorkspacePlan(plan, current.journal.workItem!, branch, adopt);
      assertManagementUnchanged(plan, orphan?.path);
      const planned = await withMutationLock(plan, () => adopt
        ? planWorkspaceAdoption({
            projectRoot: plan.management.projectDir,
            items: [{
              workItem: current!.journal.workItem!,
              branch,
              path: plan.requestedPath!,
              owner: plan.owner,
              thread: plan.session,
            }],
            now: new Date(plan.createdAt),
          })
        : planWorkspaceAllocation({
            projectRoot: plan.management.projectDir,
            workItem: current!.journal.workItem!,
            branch,
            ...(plan.requestedPath ? { path: plan.requestedPath } : {}),
            owner: plan.owner,
            thread: plan.session,
            startPoint: plan.baseSha,
            now: new Date(plan.createdAt),
          }));
      if (orphan && (planned.path !== orphan.path || planned.plan.planHash !== orphan.plan.planHash)) {
        if (planned.path !== orphan.path) cleanupWorkspacePlan(plan, planned.plan, planned.path);
        fail("DELIVERY_PREPARE_ORPHAN_PLAN_MISMATCH");
      }
      if (options.testCrashAfterWorkspacePlan) throw new Error("TEST_DELIVERY_PREPARE_AFTER_WORKSPACE_PLAN");
      const operation = planned.plan.operation;
      if (operation.kind === "allocate" && !operation.createBranch) {
        cleanupWorkspacePlan(plan, planned.plan, planned.path);
        fail("DELIVERY_PREPARE_EXISTING_ASSET_REQUIRES_ADOPTION");
      }
      const lease = preparedLease(planned.plan);
      if (lease.acceptedCommit !== (plan.adoptedHead ?? plan.baseSha)) {
        cleanupWorkspacePlan(plan, planned.plan, planned.path);
        fail("DELIVERY_PREPARE_ADOPTION_HEAD_MISMATCH");
      }
      workspacePlan = planned.plan;
      const workspacePlanReference = archiveWorkspacePlan(plan, workspacePlan, planned.path);
      current = await withMutationLock(plan, () => appendJournal(plan, current!, {
        workspacePlan: workspacePlanReference,
        branch: lease.branch,
        path: lease.path,
        error: null,
      }, options.now ?? new Date()));
    }
    const lease = preparedLease(workspacePlan);

    // applyWorkspacePlan owns the same common-dir lock; never hold acquireMutationLock across this call.
    const workspaceReceipt = applyWorkspacePlan({
      projectRoot: plan.management.projectDir,
      planPath: current.journal.workspacePlan!.path,
      approval: workspacePlan.planHash,
      now: options.now,
    });
    if (!reached(current.journal, "claim-acquired")) {
      current = await withMutationLock(plan, () => appendJournal(plan, current!, {
        phase: "claim-acquired",
        workspaceReceiptId: workspaceReceipt.id,
        error: null,
      }, options.now ?? new Date()));
      maybeFail(options, "claim-acquired");
    }

    const observedHash = verifyPreparedWorkspace(
      plan,
      current.journal.workItem!,
      workspacePlan,
      workspaceReceipt,
    );
    if (!reached(current.journal, "workspace-established")) {
      current = await withMutationLock(plan, () => appendJournal(plan, current!, {
        phase: "workspace-established",
        branch: lease.branch,
        path: lease.path,
        observedHash,
        error: null,
      }, options.now ?? new Date()));
      maybeFail(options, "workspace-established");
    }

    if (!reached(current.journal, "binding-seeded")) {
      current = await withMutationLock(plan, () => appendJournal(plan, current!, {
        phase: "binding-seeded",
        error: null,
      }, options.now ?? new Date()));
      maybeFail(options, "binding-seeded");
    }

    cleanupWorkspacePlan(plan, workspacePlan, current.journal.workspacePlan!.path);
    assertManagementUnchanged(plan);
    current = await withMutationLock(plan, () => appendJournal(plan, current!, {
      phase: "prepared",
      state: "Prepared",
      outcome: "PreparedNotOpened",
      blocked: false,
      error: null,
    }, options.now ?? new Date()));
    maybeFail(options, "prepared");
    return withMutationLock(plan, () => finalReceipt(plan, current!.journal, current!.event, false));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "TEST_DELIVERY_PREPARE_AFTER_WORKSPACE_PLAN") throw error;
    try {
      const latest = currentJournal(plan.management.commonDir, plan.transactionId);
      if (latest && latest.journal.outcome !== "PreparedNotOpened" && latest.journal.outcome !== "CoordinationBackendRequired") {
        await withMutationLock(plan, () => appendJournal(plan, latest, {
          outcome: "RecoveryRequired",
          blocked: true,
          error: message.slice(0, 2_000),
        }, options.now ?? new Date()));
      }
    } catch {
      // Preserve the original failure; receipt/lock corruption must be repaired through the recovery plane.
    }
    throw new Error(`DELIVERY_PREPARE_RECOVERY_REQUIRED: ${plan.transactionId}: ${message}`);
  }
}

const activePrepareTransactions = new Map<string, Promise<DeliveryPrepareReceipt>>();

export async function prepareDelivery(options: DeliveryPrepareOptions): Promise<DeliveryPrepareReceipt> {
  const context = resolveRepositoryContext(options.projectRoot);
  const key = `${context.commonDir}\0${transactionId(options.session)}`;
  const active = activePrepareTransactions.get(key);
  if (active) {
    const winner = await active;
    const plan = loadOrCreatePlan(options);
    validateAdmission(plan, options.now);
    const current = currentJournal(plan.management.commonDir, plan.transactionId);
    if (!current || current.event.eventHash !== winner.receiptEventHash || current.journal.planHash !== winner.planHash ||
        !["PreparedNotOpened", "CoordinationBackendRequired"].includes(current.journal.outcome)) {
      fail("DELIVERY_PREPARE_SINGLE_FLIGHT_READBACK_FAILED");
    }
    return deliveryPrepareReceiptSchema.parse({ ...winner, reused: true });
  }
  const flight = prepareDeliveryTransaction(options);
  activePrepareTransactions.set(key, flight);
  try {
    return await flight;
  } finally {
    if (activePrepareTransactions.get(key) === flight) activePrepareTransactions.delete(key);
  }
}
