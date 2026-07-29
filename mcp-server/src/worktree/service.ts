import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import {
  assertCurrentHash,
  atomicWrite,
  fileHash,
  hashObject,
  prettyJson,
  readJson,
  safePath,
  sha256,
  withoutHash,
} from "../v2/fs.js";
import {
  WORKTREE_POLICY_IDS,
  WORKTREE_SCHEMA_VERSION,
  type WorktreeDeliveryConfig,
  type WorktreePolicyId,
  type WorktreeRecord,
  type RetentionAudit,
  type ReviewReceipt,
  type WorkspaceAudit,
  type WorktreeHostBinding,
  type WorktreeHostBindingObservation,
  type WorkspaceLease,
  type WorkspacePlan,
  type WorkspacePolicyResult,
  type WorkspaceReceipt,
  type WorkspaceStatus,
} from "./types.js";
import { observeProvider } from "./provider.js";

function git(cwd: string, args: string[], allowFailure = false): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30_000,
  });
  if (result.error || (!allowFailure && result.status !== 0)) {
    const detail = `${result.stderr ?? result.stdout ?? result.error ?? ""}`.trim();
    throw new Error(`GIT_COMMAND_FAILED: git ${args.join(" ")}: ${detail}`);
  }
  return result.status === 0 ? result.stdout : "";
}

function repositoryRoot(projectRoot: string): string {
  const requested = resolve(projectRoot);
  const root = git(requested, ["rev-parse", "--show-toplevel"]).trim();
  if (!isAbsolute(root)) throw new Error(`GIT_ROOT_INVALID: ${root}`);
  return resolve(root);
}

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  return existsSync(absolute)
    ? realpathSync.native(absolute)
    : join(realpathSync.native(dirname(absolute)), basename(absolute));
}

function samePath(left: string, right: string): boolean {
  return canonicalPath(left) === canonicalPath(right);
}

function gitCommonDir(root: string): string {
  const commonDir = git(root, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]).trim();
  if (!isAbsolute(commonDir)) throw new Error(`GIT_COMMON_DIR_INVALID: ${commonDir}`);
  return resolve(commonDir);
}

function defaultConfig(): WorktreeDeliveryConfig {
  return {
    schemaVersion: WORKTREE_SCHEMA_VERSION,
    mode: "audit-only",
    maxPersistentWorktrees: 4,
    leaseTtlHours: 168,
    reviewTtlMinutes: 120,
    remoteBranchRetentionDays: 14,
    remoteBranchDeletion: false,
    provider: { kind: "none" },
  };
}

const uniqueAbsolutePaths = z.array(z.string().min(1)).min(1)
  .refine((paths) => paths.every(isAbsolute), "must contain only absolute paths")
  .refine((paths) => new Set(paths).size === paths.length, "must contain unique paths");

const providerSchema = z.object({
  kind: z.enum(["none", "github", "gitlab", "jira"]),
  repository: z.string().min(1).optional(),
  project: z.object({
    owner: z.string().min(1),
    number: z.number().int().positive(),
    statusField: z.string().min(1),
    doneValues: z.array(z.string().min(1)).min(1)
      .refine((values) => new Set(values).size === values.length, "must be unique"),
  }).strict().optional(),
}).strict().superRefine((provider, context) => {
  if (provider.kind !== "none" && !provider.repository?.trim()) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["repository"],
      message: "is required for configured providers",
    });
  }
});

const worktreeConfigShape = {
  schemaVersion: z.literal(WORKTREE_SCHEMA_VERSION),
  mode: z.enum(["audit-only", "enforced"]),
  managementBranch: z.string().trim().min(1).optional(),
  maxPersistentWorktrees: z.number().int().positive(),
  leaseTtlHours: z.number().int().positive(),
  reviewTtlMinutes: z.number().int().positive(),
  remoteBranchRetentionDays: z.number().int().positive(),
  remoteBranchDeletion: z.literal(false),
  provider: providerSchema,
};

const worktreeConfigSchema = z.object(worktreeConfigShape).strict();
const legacyWorktreeConfigSchema = z.object({
  ...worktreeConfigShape,
  allowedRoots: uniqueAbsolutePaths,
  protectedRoots: uniqueAbsolutePaths,
}).strict();
const hostBindingSchema = z.object({
  schemaVersion: z.literal(WORKTREE_SCHEMA_VERSION),
  allowedRoots: uniqueAbsolutePaths,
  protectedRoots: uniqueAbsolutePaths,
}).strict();

function validConfig(input: unknown): WorktreeDeliveryConfig {
  const parsed = worktreeConfigSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`WORKTREE_CONFIG_INVALID: ${issue.path.join(".") || "config"} ${issue.message}`);
  }
  return parsed.data;
}

function validHostBinding(input: unknown): WorktreeHostBinding {
  const parsed = hostBindingSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `WORKTREE_HOST_BINDING_INVALID: ${issue.path.join(".") || "binding"} ${issue.message}`,
    );
  }
  return parsed.data;
}

const HOST_BINDING_PATH = "harness/worktree-delivery/host-binding.json" as const;

function hostBindingFile(commonDir: string): string {
  return safePath(commonDir, HOST_BINDING_PATH);
}

function loadConfig(root: string): {
  configured: boolean;
  config: WorktreeDeliveryConfig;
  legacyBinding?: WorktreeHostBinding;
} {
  const path = join(root, ".harness", "worktree-delivery.json");
  if (!existsSync(path)) return { configured: false, config: defaultConfig() };
  const input = readJson<unknown>(path);
  const portable = worktreeConfigSchema.safeParse(input);
  if (portable.success) return { configured: true, config: portable.data };
  const legacy = legacyWorktreeConfigSchema.safeParse(input);
  if (legacy.success) {
    const { allowedRoots, protectedRoots, ...config } = legacy.data;
    return {
      configured: true,
      config,
      legacyBinding: {
        schemaVersion: WORKTREE_SCHEMA_VERSION,
        allowedRoots,
        protectedRoots,
      },
    };
  }
  return { configured: true, config: validConfig(input) };
}

function defaultHostBinding(root: string, commonDir: string): WorktreeHostBinding {
  return {
    schemaVersion: WORKTREE_SCHEMA_VERSION,
    allowedRoots: [],
    protectedRoots: [root, commonDir, resolve("/")],
  };
}

function loadHostBinding(
  root: string,
  commonDir: string,
  legacyBinding?: WorktreeHostBinding,
): WorktreeHostBindingObservation {
  const path = hostBindingFile(commonDir);
  if (legacyBinding) {
    return {
      ...legacyBinding,
      configured: false,
      loaded: true,
      source: "legacy-config",
      path,
      hash: fileHash(path),
    };
  }
  if (existsSync(path)) {
    return {
      ...validHostBinding(readJson<unknown>(path)),
      configured: true,
      loaded: true,
      source: "host-local",
      path,
      hash: fileHash(path),
    };
  }
  const binding = defaultHostBinding(root, commonDir);
  return {
    ...binding,
    configured: false,
    loaded: true,
    source: "default",
    path,
    hash: null,
  };
}

export function parseWorktreePorcelain(output: string): WorktreeRecord[] {
  const records: WorktreeRecord[] = [];
  let current: WorktreeRecord | null = null;
  for (const token of output.split("\0")) {
    if (token === "") {
      if (current) records.push(current);
      current = null;
      continue;
    }
    const separator = token.indexOf(" ");
    const key = separator === -1 ? token : token.slice(0, separator);
    const value = separator === -1 ? "" : token.slice(separator + 1);
    if (key === "worktree") {
      if (current) records.push(current);
      current = {
        path: value,
        head: "",
        branch: null,
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
      };
      continue;
    }
    if (!current) throw new Error(`WORKTREE_PORCELAIN_INVALID: ${token}`);
    if (key === "HEAD") current.head = value;
    else if (key === "branch") current.branch = value.replace(/^refs\/heads\//u, "");
    else if (key === "bare") current.bare = true;
    else if (key === "detached") current.detached = true;
    else if (key === "locked") current.locked = true;
    else if (key === "prunable") current.prunable = true;
  }
  if (current) records.push(current);
  return records;
}

function commitCount(root: string, args: string[]): number {
  const output = git(root, ["rev-list", "--count", ...args], true).trim();
  return /^\d+$/u.test(output) ? Number(output) : 0;
}

function collectDirtyEvidence(root: string, worktreePath: string): Pick<
  WorktreeRecord,
  "dirtyEvidence" | "dirtyPatch"
> {
  const tokens = git(root, [
    "-C",
    worktreePath,
    "status",
    "--porcelain=v1",
    "-z",
  ], true).split("\0").filter(Boolean);
  const entries: NonNullable<WorktreeRecord["dirtyEvidence"]> = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const status = token.slice(0, 2);
    let path = token.slice(3);
    if (/^[RC]/u.test(status) && tokens[index + 1]) path = tokens[index += 1];
    const target = join(worktreePath, path);
    const back = relative(worktreePath, target);
    if (back.startsWith("..") || isAbsolute(back)) {
      throw new Error(`DIRTY_PATH_ESCAPES_WORKTREE: ${path}`);
    }
    if (!existsSync(target)) {
      entries.push({ path, status, size: 0, sha256: sha256("") });
      continue;
    }
    const metadata = lstatSync(target);
    const content = metadata.isSymbolicLink()
      ? Buffer.from(readlinkSync(target), "utf8")
      : metadata.isFile()
        ? readFileSync(target)
        : Buffer.alloc(0);
    entries.push({ path, status, size: content.byteLength, sha256: sha256(content) });
  }
  const patch = git(root, [
    "-C",
    worktreePath,
    "diff",
    "--binary",
    "--no-ext-diff",
    "HEAD",
    "--",
  ], true);
  return {
    dirtyEvidence: entries,
    dirtyPatch: { size: Buffer.byteLength(patch), sha256: sha256(patch) },
  };
}

function enrichWorktree(root: string, record: WorktreeRecord, refs: string[]): WorktreeRecord {
  if (record.bare || record.prunable || !existsSync(record.path)) return record;
  const dirty = git(root, ["-C", record.path, "status", "--porcelain=v1", "-z"], true).length > 0;
  const otherRefs = record.branch
    ? refs.filter((ref) => ref !== `refs/heads/${record.branch}`)
    : refs;
  return {
    ...record,
    dirty,
    ...(dirty ? collectDirtyEvidence(root, record.path) : {}),
    uniqueCommits: record.head
      ? commitCount(root, [record.head, "--not", ...otherRefs])
      : 0,
    unpushedCommits: record.head
      ? commitCount(root, [record.head, "--not", "--remotes"])
      : 0,
  };
}

function worktrees(root: string): WorktreeRecord[] {
  const refs = git(root, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"])
    .split(/\r?\n/u)
    .filter(Boolean);
  return parseWorktreePorcelain(git(root, ["worktree", "list", "--porcelain", "-z"]))
    .map((record) => enrichWorktree(root, record, refs));
}

function validLease(input: unknown, path: string): WorkspaceLease {
  const lease = input as Partial<WorkspaceLease>;
  const required = [
    "workItem",
    "branch",
    "path",
    "owner",
    "acceptedCommit",
    "createdAt",
    "heartbeatAt",
    "status",
  ] as const;
  if (
    lease.schemaVersion !== WORKTREE_SCHEMA_VERSION ||
    required.some((key) => typeof lease[key] !== "string") ||
    !["active", "review", "done"].includes(String(lease.status)) ||
    !Number.isFinite(Date.parse(String(lease.createdAt))) ||
    !Number.isFinite(Date.parse(String(lease.heartbeatAt)))
  ) {
    throw new Error(`WORKTREE_LEASE_INVALID: ${path}`);
  }
  return lease as WorkspaceLease;
}

function leases(commonDir: string): { values: WorkspaceLease[]; errors: string[] } {
  const directory = join(commonDir, "harness", "worktree-delivery", "leases");
  if (!existsSync(directory)) return { values: [], errors: [] };
  const values: WorkspaceLease[] = [];
  const errors: string[] = [];
  for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".json")).sort()) {
    const path = join(directory, name);
    try {
      values.push(validLease(JSON.parse(readFileSync(path, "utf8")), path));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { values, errors };
}

export function workspaceStatus(projectRoot: string): WorkspaceStatus {
  const root = repositoryRoot(projectRoot);
  const commonDir = gitCommonDir(root);
  const loadedConfig = loadConfig(root);
  const hostBinding = loadHostBinding(root, commonDir, loadedConfig.legacyBinding);
  const loadedLeases = leases(commonDir);
  const observedWorktrees = worktrees(root);
  const provider = observeProvider(root, loadedConfig.config, loadedLeases.values);
  const bindingError = loadedConfig.configured &&
    loadedConfig.config.mode === "enforced" &&
    !hostBinding.configured
    ? hostBinding.source === "legacy-config"
      ? "WORKTREE_HOST_BINDING_MIGRATION_REQUIRED"
      : "WORKTREE_HOST_BINDING_REQUIRED"
    : null;
  const errors = [
    ...loadedLeases.errors,
    ...(bindingError ? [bindingError] : []),
    ...(provider.configured && !provider.available ? [`PROVIDER_UNAVAILABLE: ${provider.error}`] : []),
  ];
  const refs = git(root, [
    "for-each-ref",
    "--format=%(refname)%00%(objectname)%00",
    "refs/heads",
    "refs/remotes",
  ]).split("\0").filter(Boolean);
  const observed = {
    configHash: fileHash(join(root, ".harness", "worktree-delivery.json")),
    hostBindingHash: hostBinding.hash,
    refs,
    worktrees: observedWorktrees.map((worktree) => {
      if (!samePath(worktree.path, root)) return worktree;
      return {
        path: worktree.path,
        head: worktree.head,
        branch: worktree.branch,
        bare: worktree.bare,
        detached: worktree.detached,
        locked: worktree.locked,
        prunable: worktree.prunable,
        uniqueCommits: worktree.uniqueCommits,
        unpushedCommits: worktree.unpushedCommits,
      };
    }),
    leases: loadedLeases.values,
    provider,
    errors,
  };
  return {
    schemaVersion: WORKTREE_SCHEMA_VERSION,
    projectDir: root,
    commonDir,
    configured: loadedConfig.configured,
    loaded: true,
    enforced: bindingError === null,
    passing: errors.length === 0,
    mode: loadedConfig.config.mode,
    config: loadedConfig.config,
    hostBinding,
    worktrees: observedWorktrees,
    leases: loadedLeases.values,
    provider,
    errors,
    observedHash: hashObject(observed),
  };
}

function isSameOrWithin(parent: string, child: string): boolean {
  const back = relative(canonicalPath(parent), canonicalPath(child));
  return back === "" || (!back.startsWith("..") && !isAbsolute(back));
}

function protectedPath(binding: WorktreeHostBinding, target: string): boolean {
  return binding.protectedRoots.some((protectedRoot) => {
    const normalized = canonicalPath(protectedRoot);
    if (normalized === resolve("/")) return resolve(target) === normalized;
    return isSameOrWithin(normalized, target);
  });
}

function result(
  status: WorkspaceStatus,
  id: WorktreePolicyId,
  passing: boolean,
  detail: string,
  evidence: string[] = [],
  enforced = true,
): WorkspacePolicyResult {
  return {
    id,
    configured: status.configured,
    loaded: status.loaded,
    enforced,
    passing,
    status: enforced ? (passing ? "verified" : "failing") : "guidance",
    detail,
    evidence,
  };
}

function blockedResult(
  status: WorkspaceStatus,
  id: WorktreePolicyId,
  detail: string,
  evidence: string[],
): WorkspacePolicyResult {
  return {
    id,
    configured: status.configured,
    loaded: status.loaded,
    enforced: false,
    passing: false,
    status: "blocked",
    detail,
    evidence,
  };
}

export function auditWorkspace(projectRoot: string): WorkspaceAudit {
  const status = workspaceStatus(projectRoot);
  const managementMatches = status.config.managementBranch
    ? status.worktrees.filter((worktree) =>
      !worktree.bare &&
      !worktree.prunable &&
      worktree.branch === status.config.managementBranch)
    : [];
  const managementPath = status.config.managementBranch && managementMatches.length === 1
    ? managementMatches[0].path
    : status.config.managementBranch
      ? null
      : status.projectDir;
  const managementErrors = !status.config.managementBranch
    ? []
    : managementMatches.length === 0
      ? [`management checkout not found for branch: ${status.config.managementBranch}`]
      : managementMatches.length > 1
        ? [`multiple management checkouts found for branch: ${status.config.managementBranch}`]
        : [];
  const duplicateItems = [...new Set(status.leases.map((lease) => lease.workItem))]
    .filter((workItem) => status.leases.filter((lease) => lease.workItem === workItem).length > 1);
  const leaseMappingErrors = status.leases.flatMap((lease) => {
    const observed = status.worktrees.find((worktree) => samePath(worktree.path, lease.path));
    if (!observed) return [`${lease.workItem}: lease path is not an observed worktree: ${lease.path}`];
    if (observed.branch !== lease.branch) {
      return [`${lease.workItem}: expected branch ${lease.branch}, observed ${observed.branch ?? "detached"}`];
    }
    return [];
  });
  const orphanWorktrees = managementErrors.length > 0 ? [] : status.worktrees
    .filter((worktree) =>
      !worktree.bare &&
      !worktree.prunable &&
      !(worktree.detached && samePath(worktree.path, status.projectDir)) &&
      !(managementPath && samePath(worktree.path, managementPath)) &&
      !status.leases.some((lease) => samePath(lease.path, worktree.path)))
    .map((worktree) => `unleased worktree: ${worktree.path}`);
  const projectMappingErrors = status.config.provider.project
    ? status.leases.flatMap((lease) => {
      const item = status.provider.items.find((candidate) => candidate.workItem === lease.workItem);
      return item?.projectItemPresent === false
        ? [`${lease.workItem}: not found in configured Project`]
        : [];
    })
    : [];
  const mappingErrors = [
    ...managementErrors,
    ...leaseMappingErrors,
    ...orphanWorktrees,
    ...projectMappingErrors,
  ];
  const staleLeases = status.leases.filter((lease) =>
    (Date.now() - Date.parse(lease.heartbeatAt)) / 3_600_000 > status.config.leaseTtlHours);
  const protectedPaths = status.leases
    .filter((lease) => protectedPath(status.hostBinding, lease.path))
    .map((lease) => `${lease.workItem}: ${lease.path}`);
  const doneValues = new Set(
    status.config.provider.project?.doneValues.map((value) => value.toLowerCase()) ?? [],
  );
  const doneLeases = status.leases.filter((lease) => {
    const providerItem = status.provider.items.find((item) => item.workItem === lease.workItem);
    return lease.status === "done" ||
      providerItem?.state.toLowerCase() === "closed" ||
      (providerItem?.projectStatus
        ? doneValues.has(providerItem.projectStatus.toLowerCase())
        : false);
  });
  const dirtyDone = doneLeases.flatMap((lease) => {
    const observed = status.worktrees.find((worktree) => samePath(worktree.path, lease.path));
    return observed?.dirty ? [`${lease.workItem}: ${lease.path}`] : [];
  });
  const uniqueDone = doneLeases.flatMap((lease) => {
    const observed = status.worktrees.find((worktree) => samePath(worktree.path, lease.path));
    return observed && ((observed.uniqueCommits ?? 0) > 0 || (observed.unpushedCommits ?? 0) > 0)
      ? [`${lease.workItem}: unique=${observed.uniqueCommits ?? 0}, unpushed=${observed.unpushedCommits ?? 0}`]
      : [];
  });
  const policyById = new Map<WorktreePolicyId, WorkspacePolicyResult>();
  const add = (policy: WorkspacePolicyResult): void => { policyById.set(policy.id, policy); };
  add(result(status, "workspace.issue-single-persistent-lease", duplicateItems.length === 0,
    duplicateItems.length === 0 ? "Every work item has at most one persistent lease." : "One or more work items have duplicate persistent leases.",
    duplicateItems));
  if (status.provider.configured && !status.provider.available) {
    add(blockedResult(
      status,
      "workspace.mapping-consistency",
      "Provider state is unavailable; Project/Issue/branch/thread/path mapping cannot be verified.",
      [status.provider.error ?? "provider unavailable", ...mappingErrors],
    ));
  } else {
    add(result(status, "workspace.mapping-consistency", mappingErrors.length === 0,
      mappingErrors.length === 0 ? "Lease paths and branches match observed worktrees." : "Lease/worktree mappings drifted.",
      mappingErrors));
  }
  if (!status.enforced) {
    add(blockedResult(
      status,
      "workspace.root-denylist",
      "Host-local path binding is unavailable; protected roots cannot be enforced.",
      status.errors.filter((error) => error.startsWith("WORKTREE_HOST_BINDING_")),
    ));
  } else {
    add(result(status, "workspace.root-denylist", protectedPaths.length === 0,
      protectedPaths.length === 0
        ? "No lease targets a protected root."
        : "A lease targets a protected root.",
      protectedPaths));
  }
  add(result(status, "workspace.capacity-budget", status.leases.length <= status.config.maxPersistentWorktrees,
    `${status.leases.length}/${status.config.maxPersistentWorktrees} persistent leases are present.`,
    status.leases.length <= status.config.maxPersistentWorktrees ? [] : status.leases.map((lease) => lease.path)));
  add(result(status, "workspace.lease-ttl", staleLeases.length === 0,
    staleLeases.length === 0 ? "Every active lease is within its heartbeat TTL." : "One or more leases exceeded their heartbeat TTL.",
    staleLeases.map((lease) => `${lease.workItem}: heartbeat=${lease.heartbeatAt}`)));
  add(result(status, "workspace.clean-before-close", dirtyDone.length === 0,
    dirtyDone.length === 0 ? "No completed worktree is dirty." : "Completed worktrees contain uncommitted content.",
    dirtyDone));
  add(result(status, "workspace.unique-commits-protected", uniqueDone.length === 0,
    uniqueDone.length === 0 ? "No completed worktree contains unique or unpushed commits." : "Completed worktrees contain protected commits.",
    uniqueDone));
  add(result(status, "workspace.done-no-persistent-worktree", doneLeases.length === 0,
    doneLeases.length === 0 ? "No completed work item retains a persistent worktree." : "Completed work items retain persistent worktrees.",
    doneLeases.map((lease) => `${lease.workItem}: ${lease.path}`)));
  add(result(status, "workspace.review-temporary-detached", true,
    "Temporary review worktrees are evaluated by the review wrapper."));
  add(result(status, "workspace.review-ttl", true,
    "Temporary review TTL is evaluated by retention-audit."));
  add(result(status, "workspace.zero-new-worktree-management", true,
    "Status, audit, and cleanup planning execute no worktree creation command."));
  add(result(status, "workspace.cleanup-exact-hash", true,
    "Persistent lifecycle changes require a canonical SHA-256 plan."));
  add(result(status, "workspace.cleanup-receipt", true,
    "Persistent lifecycle changes require a durable receipt."));
  add(result(status, "workspace.remote-delete-disabled", status.config.remoteBranchDeletion === false,
    "Remote branch deletion is disabled."));
  const policies = WORKTREE_POLICY_IDS.map((id) => policyById.get(id)!);
  return {
    schemaVersion: WORKTREE_SCHEMA_VERSION,
    configured: status.configured,
    loaded: status.loaded,
    enforced: policies.filter((policy) => policy.status !== "guidance").every((policy) => policy.enforced),
    passing: status.passing && policies.every(
      (policy) => policy.status === "guidance" || policy.passing,
    ),
    observedHash: status.observedHash,
    policies,
  };
}

function stateRoot(commonDir: string): string {
  return join(commonDir, "harness", "worktree-delivery");
}

function leaseFile(commonDir: string, workItem: string): string {
  return join(stateRoot(commonDir), "leases", `${sha256(workItem)}.json`);
}

function receiptFile(commonDir: string, id: string): string {
  return join(stateRoot(commonDir), "receipts", `${id}.json`);
}

function planPath(root: string, id: string): string {
  return `.harness/plans/${id}.json`;
}

function planId(operation: string, createdAt: string, seed: unknown): string {
  return `worktree-${operation}-${createdAt.replace(/[:.]/gu, "-")}-${hashObject(seed).slice(0, 12)}`;
}

function savePlan(root: string, draft: WorkspacePlan): { plan: WorkspacePlan; path: string } {
  draft.planHash = hashObject(withoutHash(draft));
  const path = planPath(root, draft.id);
  atomicWrite(safePath(root, path), prettyJson(draft));
  return { plan: draft, path };
}

function validateBranch(root: string, branch: string): void {
  if (!branch || branch.startsWith("-")) throw new Error("WORKTREE_BRANCH_INVALID");
  git(root, ["check-ref-format", "--branch", branch]);
}

function validateTarget(binding: WorktreeHostBinding, target: string): string {
  if (!isAbsolute(target)) throw new Error("WORKTREE_PATH_MUST_BE_ABSOLUTE");
  const resolved = canonicalPath(target);
  if (protectedPath(binding, resolved)) {
    throw new Error(`WORKTREE_PROTECTED_PATH: ${resolved}`);
  }
  if (
    binding.allowedRoots.length === 0 ||
    !binding.allowedRoots.some((allowedRoot) => isSameOrWithin(allowedRoot, resolved))
  ) {
    throw new Error(`WORKTREE_PATH_NOT_ALLOWED: ${resolved}`);
  }
  return resolved;
}

function requireHostBinding(status: WorkspaceStatus): void {
  if (status.hostBinding.configured) return;
  throw new Error(status.hostBinding.source === "legacy-config"
    ? "WORKTREE_HOST_BINDING_MIGRATION_REQUIRED"
    : "WORKTREE_HOST_BINDING_REQUIRED");
}

function planDraft(args: {
  status: WorkspaceStatus;
  operation: WorkspacePlan["operation"];
  now?: Date;
  warnings?: string[];
}): WorkspacePlan {
  const createdAt = (args.now ?? new Date()).toISOString();
  return {
    schemaVersion: "worktree-delivery/1.0",
    kind: "workspace-plan",
    id: planId(args.operation.kind, createdAt, {
      observedHash: args.status.observedHash,
      operation: args.operation,
    }),
    createdAt,
    projectDir: args.status.projectDir,
    commonDir: args.status.commonDir,
    observedHash: args.status.observedHash,
    operation: args.operation,
    warnings: args.warnings ?? [],
    planHash: "",
  };
}

export function planWorkspaceConfiguration(args: {
  projectRoot: string;
  mode?: "audit-only" | "enforced";
  managementBranch?: string;
  maxPersistentWorktrees?: number;
  leaseTtlHours?: number;
  reviewTtlMinutes?: number;
  remoteBranchRetentionDays?: number;
  allowedRoots?: string[];
  protectedRoots?: string[];
  provider?: WorktreeDeliveryConfig["provider"];
  now?: Date;
}): { plan: WorkspacePlan; path: string } {
  const status = workspaceStatus(args.projectRoot);
  const config = validConfig({
    ...status.config,
    mode: args.mode ?? status.config.mode,
    managementBranch: args.managementBranch ?? status.config.managementBranch,
    maxPersistentWorktrees: args.maxPersistentWorktrees ?? status.config.maxPersistentWorktrees,
    leaseTtlHours: args.leaseTtlHours ?? status.config.leaseTtlHours,
    reviewTtlMinutes: args.reviewTtlMinutes ?? status.config.reviewTtlMinutes,
    remoteBranchRetentionDays:
      args.remoteBranchRetentionDays ?? status.config.remoteBranchRetentionDays,
    provider: args.provider ?? status.config.provider,
  });
  const hostBinding = validHostBinding({
    schemaVersion: WORKTREE_SCHEMA_VERSION,
    allowedRoots: (
      args.allowedRoots ??
      (status.hostBinding.allowedRoots.length > 0
        ? status.hostBinding.allowedRoots
        : [dirname(status.projectDir)])
    ).map(canonicalPath),
    protectedRoots: (
      args.protectedRoots ??
      (status.hostBinding.protectedRoots.length > 0
        ? status.hostBinding.protectedRoots
        : [status.projectDir, status.commonDir, resolve("/")])
    ).map(canonicalPath),
  });
  const content = prettyJson(config);
  const hostBindingContent = prettyJson(hostBinding);
  const operation: WorkspacePlan["operation"] = {
    kind: "configure",
    configPath: ".harness/worktree-delivery.json",
    beforeHash: fileHash(join(status.projectDir, ".harness", "worktree-delivery.json")),
    afterHash: sha256(content),
    content,
    hostBindingPath: HOST_BINDING_PATH,
    beforeHostBindingHash: status.hostBinding.hash,
    afterHostBindingHash: sha256(hostBindingContent),
    hostBindingContent,
  };
  return savePlan(status.projectDir, planDraft({ status, operation, now: args.now }));
}

export function planWorkspaceAllocation(args: {
  projectRoot: string;
  workItem: string;
  branch: string;
  path: string;
  owner: string;
  thread?: string;
  startPoint?: string;
  now?: Date;
}): { plan: WorkspacePlan; path: string } {
  const status = workspaceStatus(args.projectRoot);
  if (!status.configured) throw new Error("WORKTREE_CONFIGURATION_REQUIRED");
  if (status.config.mode !== "enforced") throw new Error("WORKTREE_ENFORCEMENT_NOT_ENABLED");
  requireHostBinding(status);
  if (status.provider.configured && !status.provider.available) {
    throw new Error(`PROVIDER_UNAVAILABLE: ${status.provider.error}`);
  }
  if (!args.workItem.trim()) throw new Error("WORK_ITEM_REQUIRED");
  if (!args.owner.trim()) throw new Error("OWNER_REQUIRED");
  validateBranch(status.projectDir, args.branch);
  const target = validateTarget(status.hostBinding, args.path);
  if (existsSync(target)) throw new Error(`WORKTREE_PATH_EXISTS: ${target}`);
  if (status.leases.some((lease) => lease.workItem === args.workItem)) {
    throw new Error(`DUPLICATE_WORK_ITEM_LEASE: ${args.workItem}`);
  }
  if (status.leases.some((lease) => samePath(lease.path, target))) {
    throw new Error(`DUPLICATE_WORKTREE_PATH: ${target}`);
  }
  if (status.worktrees.some((worktree) => worktree.branch === args.branch)) {
    throw new Error(`BRANCH_ALREADY_CHECKED_OUT: ${args.branch}`);
  }
  if (status.leases.length >= status.config.maxPersistentWorktrees) {
    throw new Error(`WORKTREE_CAPACITY_EXCEEDED: ${status.config.maxPersistentWorktrees}`);
  }
  const startPoint = args.startPoint ?? "HEAD";
  const acceptedCommit = git(status.projectDir, [
    "rev-parse",
    "--verify",
    `${startPoint}^{commit}`,
  ]).trim();
  const createBranch = git(status.projectDir, [
    "show-ref",
    "--verify",
    `refs/heads/${args.branch}`,
  ], true).trim().length === 0;
  const timestamp = (args.now ?? new Date()).toISOString();
  const lease: WorkspaceLease = {
    schemaVersion: WORKTREE_SCHEMA_VERSION,
    workItem: args.workItem.trim(),
    branch: args.branch,
    path: target,
    owner: args.owner.trim(),
    thread: args.thread,
    acceptedCommit,
    createdAt: timestamp,
    heartbeatAt: timestamp,
    status: "active",
  };
  return savePlan(status.projectDir, planDraft({
    status,
    operation: { kind: "allocate", lease, startPoint: acceptedCommit, createBranch },
    now: args.now,
  }));
}

function remoteRefsContaining(root: string, commit: string): string[] {
  return git(root, [
    "for-each-ref",
    `--contains=${commit}`,
    "--format=%(refname)",
    "refs/remotes",
  ], true).split(/\r?\n/u).filter(Boolean);
}

export function planWorkspaceClose(args: {
  projectRoot: string;
  workItem: string;
  acceptedCommit: string;
  now?: Date;
}): { plan: WorkspacePlan; path: string } {
  const status = workspaceStatus(args.projectRoot);
  if (!status.configured || status.config.mode !== "enforced") {
    throw new Error("WORKTREE_ENFORCEMENT_NOT_ENABLED");
  }
  requireHostBinding(status);
  const matching = status.leases.filter((lease) => lease.workItem === args.workItem);
  if (matching.length !== 1) {
    throw new Error(matching.length === 0
      ? `WORKTREE_LEASE_NOT_FOUND: ${args.workItem}`
      : `DUPLICATE_WORK_ITEM_LEASE: ${args.workItem}`);
  }
  const lease = matching[0];
  validateTarget(status.hostBinding, lease.path);
  const observed = status.worktrees.find((worktree) => samePath(worktree.path, lease.path));
  if (!observed) throw new Error(`WORKTREE_NOT_FOUND: ${lease.path}`);
  if (observed.dirty) {
    throw new Error(`WORKTREE_DIRTY: ${lease.path}: ${JSON.stringify({
      files: observed.dirtyEvidence,
      patch: observed.dirtyPatch,
    })}`);
  }
  if (observed.head !== args.acceptedCommit) {
    throw new Error(`ACCEPTED_COMMIT_MISMATCH: expected ${observed.head}, received ${args.acceptedCommit}`);
  }
  if (remoteRefsContaining(status.projectDir, observed.head).length === 0) {
    throw new Error(`UNPUSHED_COMMIT: ${observed.head} has no remote reference`);
  }
  return savePlan(status.projectDir, planDraft({
    status,
    operation: {
      kind: "close",
      lease: { ...lease, acceptedCommit: args.acceptedCommit },
      expectedHead: observed.head,
      expectedLeaseHash: fileHash(leaseFile(status.commonDir, lease.workItem)) ?? "",
    },
    now: args.now,
    warnings: ["Local and remote branches are preserved after close."],
  }));
}

function loadWorkspacePlan(root: string, path: string): WorkspacePlan {
  const plan = readJson<WorkspacePlan>(safePath(root, path));
  if (
    plan.schemaVersion !== "worktree-delivery/1.0" ||
    plan.kind !== "workspace-plan" ||
    !["configure", "allocate", "close"].includes(plan.operation?.kind) ||
    (plan.operation.kind === "configure" && (
      plan.operation.hostBindingPath !== HOST_BINDING_PATH ||
      typeof plan.operation.beforeHostBindingHash !== "string" &&
        plan.operation.beforeHostBindingHash !== null ||
      typeof plan.operation.afterHostBindingHash !== "string" ||
      typeof plan.operation.hostBindingContent !== "string"
    ))
  ) {
    throw new Error("WORKSPACE_PLAN_INVALID");
  }
  return plan;
}

function validateWorkspacePlan(
  status: WorkspaceStatus,
  plan: WorkspacePlan,
  approval: string,
): void {
  if (hashObject(withoutHash(plan)) !== plan.planHash) {
    throw new Error("PLAN_TAMPERED: workspace plan content does not match its embedded hash");
  }
  if (approval !== plan.planHash) {
    throw new Error(`APPROVAL_MISMATCH: expected exact plan hash ${plan.planHash}`);
  }
  if (plan.projectDir !== status.projectDir || plan.commonDir !== status.commonDir) {
    throw new Error("PROJECT_MISMATCH: workspace plan belongs to another repository");
  }
  if (plan.observedHash !== status.observedHash) {
    throw new Error(`WORKSPACE_DRIFT: expected ${plan.observedHash}, observed ${status.observedHash}`);
  }
}

function acquireLock(commonDir: string): string {
  return acquireNamedLock(commonDir, "apply.lock");
}

function releaseLock(lock: string): void {
  if (existsSync(lock)) rmdirSync(lock);
}

function appliedReceipt(plan: WorkspacePlan): WorkspaceReceipt | null {
  const path = receiptFile(plan.commonDir, plan.id);
  if (!existsSync(path)) return null;
  const receipt = readJson<WorkspaceReceipt>(path);
  if (receipt.planHash !== plan.planHash) {
    throw new Error(`CHANGE_ID_CONFLICT: ${plan.id}`);
  }
  if (receipt.status === "applied" && receipt.after) {
    const current = workspaceStatus(plan.projectDir);
    if (current.observedHash !== receipt.after.observedHash) {
      throw new Error(`CHANGE_ID_CONFLICT: ${plan.id} was applied but workspace state drifted`);
    }
    return receipt;
  }
  if (receipt.status === "rolled-back") return receipt;
  if (receipt.status === "failed") {
    throw new Error(`CHANGE_PREVIOUSLY_FAILED: ${plan.id}; inspect its durable receipt`);
  }
  return null;
}

function writeReceipt(path: string, receipt: WorkspaceReceipt): void {
  atomicWrite(path, prettyJson(receipt));
}

export function applyWorkspacePlan(args: {
  projectRoot: string;
  planPath: string;
  approval: string;
  now?: Date;
}): WorkspaceReceipt {
  const root = repositoryRoot(args.projectRoot);
  const plan = loadWorkspacePlan(root, args.planPath);
  const previous = appliedReceipt(plan);
  if (previous) return previous;
  const before = workspaceStatus(root);
  validateWorkspacePlan(before, plan, args.approval);
  const lock = acquireLock(plan.commonDir);
  const receiptPath = receiptFile(plan.commonDir, plan.id);
  const receipt: WorkspaceReceipt = {
    schemaVersion: "worktree-delivery/1.0",
    kind: "workspace-receipt",
    id: plan.id,
    planHash: plan.planHash,
    operation: plan.operation.kind,
    status: "started",
    startedAt: (args.now ?? new Date()).toISOString(),
    steps: [],
    before,
  };
  let worktreeCreated = false;
  let configWritten = false;
  let hostBindingWritten = false;
  let worktreeRemoved = false;
  try {
    writeReceipt(receiptPath, receipt);
    if (plan.operation.kind === "configure") {
      const target = safePath(root, plan.operation.configPath);
      const hostBindingTarget = safePath(plan.commonDir, plan.operation.hostBindingPath);
      assertCurrentHash(target, plan.operation.beforeHash);
      assertCurrentHash(hostBindingTarget, plan.operation.beforeHostBindingHash);
      receipt.backupContent = plan.operation.beforeHash === null
        ? null
        : readFileSync(target, "utf8");
      receipt.backupHostBindingContent = plan.operation.beforeHostBindingHash === null
        ? null
        : readFileSync(hostBindingTarget, "utf8");
      atomicWrite(target, plan.operation.content);
      configWritten = true;
      assertCurrentHash(target, plan.operation.afterHash);
      receipt.steps.push({ id: "write-config", status: "applied", detail: plan.operation.configPath });
      atomicWrite(hostBindingTarget, plan.operation.hostBindingContent);
      hostBindingWritten = true;
      assertCurrentHash(hostBindingTarget, plan.operation.afterHostBindingHash);
      receipt.steps.push({
        id: "write-host-binding",
        status: "applied",
        detail: plan.operation.hostBindingPath,
      });
    } else if (plan.operation.kind === "allocate") {
      const operation = plan.operation;
      validateTarget(before.hostBinding, operation.lease.path);
      const argv = operation.createBranch
        ? ["worktree", "add", "-b", operation.lease.branch, operation.lease.path, operation.startPoint]
        : ["worktree", "add", operation.lease.path, operation.lease.branch];
      git(root, argv);
      worktreeCreated = true;
      receipt.steps.push({ id: "add-worktree", status: "applied", detail: operation.lease.path });
      const actualHead = git(root, ["-C", operation.lease.path, "rev-parse", "HEAD"]).trim();
      if (actualHead !== operation.lease.acceptedCommit) {
        throw new Error(`WORKTREE_HEAD_DRIFT: expected ${operation.lease.acceptedCommit}, observed ${actualHead}`);
      }
      atomicWrite(leaseFile(plan.commonDir, operation.lease.workItem), prettyJson(operation.lease));
      receipt.steps.push({ id: "write-lease", status: "applied", detail: operation.lease.workItem });
    } else {
      const operation = plan.operation;
      requireHostBinding(before);
      validateTarget(before.hostBinding, operation.lease.path);
      assertCurrentHash(leaseFile(plan.commonDir, operation.lease.workItem), operation.expectedLeaseHash);
      const observed = before.worktrees.find(
        (worktree) => samePath(worktree.path, operation.lease.path),
      );
      if (!observed || observed.head !== operation.expectedHead || observed.dirty) {
        throw new Error("WORKSPACE_DRIFT: close preconditions changed");
      }
      git(root, ["worktree", "remove", operation.lease.path]);
      worktreeRemoved = true;
      receipt.steps.push({ id: "remove-worktree", status: "applied", detail: operation.lease.path });
      unlinkSync(leaseFile(plan.commonDir, operation.lease.workItem));
      receipt.steps.push({ id: "remove-lease", status: "applied", detail: operation.lease.workItem });
    }
    receipt.status = "applied";
    receipt.completedAt = (args.now ?? new Date()).toISOString();
    receipt.after = workspaceStatus(root);
    writeReceipt(receiptPath, receipt);
    return receipt;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    receipt.status = "failed";
    receipt.error = message;
    receipt.steps.push({ id: "apply", status: "failed", detail: message });
    try {
      if (plan.operation.kind === "configure") {
        const target = safePath(root, plan.operation.configPath);
        const hostBindingTarget = safePath(plan.commonDir, plan.operation.hostBindingPath);
        if (hostBindingWritten) {
          if (receipt.backupHostBindingContent === null) unlinkSync(hostBindingTarget);
          else if (typeof receipt.backupHostBindingContent === "string") {
            atomicWrite(hostBindingTarget, receipt.backupHostBindingContent);
          }
          receipt.steps.push({
            id: "restore-host-binding",
            status: "compensated",
            detail: hostBindingTarget,
          });
        }
        if (configWritten) {
          if (receipt.backupContent === null) unlinkSync(target);
          else if (typeof receipt.backupContent === "string") {
            atomicWrite(target, receipt.backupContent);
          }
          receipt.steps.push({ id: "restore-config", status: "compensated", detail: target });
        }
      } else if (plan.operation.kind === "allocate" && worktreeCreated) {
        git(root, ["worktree", "remove", plan.operation.lease.path]);
        if (existsSync(leaseFile(plan.commonDir, plan.operation.lease.workItem))) {
          unlinkSync(leaseFile(plan.commonDir, plan.operation.lease.workItem));
        }
        if (plan.operation.createBranch) {
          git(root, ["branch", "-d", plan.operation.lease.branch]);
        }
        receipt.steps.push({ id: "remove-allocation", status: "compensated", detail: plan.operation.lease.path });
      } else if (plan.operation.kind === "close" && worktreeRemoved) {
        git(root, ["worktree", "add", plan.operation.lease.path, plan.operation.lease.branch]);
        atomicWrite(leaseFile(plan.commonDir, plan.operation.lease.workItem), prettyJson(plan.operation.lease));
        receipt.steps.push({ id: "restore-close", status: "compensated", detail: plan.operation.lease.path });
      }
    } catch (compensationError) {
      receipt.steps.push({
        id: "compensation",
        status: "failed",
        detail: compensationError instanceof Error ? compensationError.message : String(compensationError),
      });
    }
    receipt.completedAt = (args.now ?? new Date()).toISOString();
    writeReceipt(receiptPath, receipt);
    throw error;
  } finally {
    releaseLock(lock);
  }
}

export function rollbackWorkspaceChange(args: {
  projectRoot: string;
  changeId: string;
  now?: Date;
}): WorkspaceReceipt {
  const status = workspaceStatus(args.projectRoot);
  const path = receiptFile(status.commonDir, args.changeId);
  if (!existsSync(path)) throw new Error(`WORKSPACE_RECEIPT_NOT_FOUND: ${args.changeId}`);
  const receipt = readJson<WorkspaceReceipt>(path);
  if (receipt.status === "rolled-back") return receipt;
  if (receipt.status !== "applied" || !receipt.after) {
    throw new Error(`WORKSPACE_ROLLBACK_UNAVAILABLE: ${receipt.status}`);
  }
  if (status.observedHash !== receipt.after.observedHash) {
    throw new Error("WORKSPACE_DRIFT: workspace changed after apply");
  }
  const planPathValue = planPath(status.projectDir, receipt.id);
  const plan = loadWorkspacePlan(status.projectDir, planPathValue);
  const lock = acquireLock(status.commonDir);
  try {
    if (plan.operation.kind === "configure") {
      const target = safePath(status.projectDir, plan.operation.configPath);
      const hostBindingTarget = safePath(status.commonDir, plan.operation.hostBindingPath);
      assertCurrentHash(target, plan.operation.afterHash);
      assertCurrentHash(hostBindingTarget, plan.operation.afterHostBindingHash);
      if (receipt.backupContent === null) unlinkSync(target);
      else if (typeof receipt.backupContent === "string") atomicWrite(target, receipt.backupContent);
      if (receipt.backupHostBindingContent === null) unlinkSync(hostBindingTarget);
      else if (typeof receipt.backupHostBindingContent === "string") {
        atomicWrite(hostBindingTarget, receipt.backupHostBindingContent);
      }
      receipt.steps.push({ id: "rollback-config", status: "compensated", detail: target });
      receipt.steps.push({
        id: "rollback-host-binding",
        status: "compensated",
        detail: hostBindingTarget,
      });
    } else if (plan.operation.kind === "allocate") {
      throw new Error(
        "WORKSPACE_ROLLBACK_REQUIRES_CLOSE_PLAN: an allocated worktree must pass a new exact-hash close plan",
      );
    } else {
      requireHostBinding(status);
      validateTarget(status.hostBinding, plan.operation.lease.path);
      if (existsSync(plan.operation.lease.path)) {
        throw new Error(`WORKSPACE_ROLLBACK_UNSAFE: path exists: ${plan.operation.lease.path}`);
      }
      const branchHead = git(status.projectDir, [
        "rev-parse",
        "--verify",
        `${plan.operation.lease.branch}^{commit}`,
      ]).trim();
      if (branchHead !== plan.operation.expectedHead) {
        throw new Error("WORKSPACE_ROLLBACK_UNSAFE: branch head changed");
      }
      git(status.projectDir, ["worktree", "add", plan.operation.lease.path, plan.operation.lease.branch]);
      atomicWrite(
        leaseFile(status.commonDir, plan.operation.lease.workItem),
        prettyJson(plan.operation.lease),
      );
      receipt.steps.push({ id: "rollback-close", status: "compensated", detail: plan.operation.lease.path });
    }
    receipt.status = "rolled-back";
    receipt.completedAt = (args.now ?? new Date()).toISOString();
    receipt.after = workspaceStatus(status.projectDir);
    writeReceipt(path, receipt);
    return receipt;
  } finally {
    releaseLock(lock);
  }
}

function defaultHostStateRoot(): string {
  if (process.env.XDG_STATE_HOME) {
    return join(process.env.XDG_STATE_HOME, "harness-automation");
  }
  if (platform() === "win32") {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "harness-automation");
  }
  if (platform() === "darwin") {
    return join(homedir(), "Library", "Application Support", "harness-automation");
  }
  return join(homedir(), ".local", "state", "harness-automation");
}

function acquireNamedLock(commonDir: string, name: string): string {
  const root = stateRoot(commonDir);
  mkdirSync(root, { recursive: true });
  const lock = join(root, name);
  try {
    mkdirSync(lock);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw new Error(`WORKSPACE_LOCKED: ${lock}`);
    throw error;
  }
  return lock;
}

export function reviewWorkspace(args: {
  projectRoot: string;
  commit: string;
  command: string[];
  hostStateRoot?: string;
  now?: Date;
}): ReviewReceipt {
  if (args.command.length === 0) throw new Error("REVIEW_COMMAND_REQUIRED");
  const status = workspaceStatus(args.projectRoot);
  const commit = git(status.projectDir, [
    "rev-parse",
    "--verify",
    `${args.commit}^{commit}`,
  ]).trim();
  const createdAt = (args.now ?? new Date()).toISOString();
  const id = `review-${createdAt.replace(/[:.]/gu, "-")}-${hashObject({
    commonDir: status.commonDir,
    commit,
    command: args.command,
  }).slice(0, 12)}`;
  const hostStateRoot = resolve(args.hostStateRoot ?? defaultHostStateRoot());
  const receiptPath = join(hostStateRoot, "reviews", `${id}.json`);
  const base = mkdtempSync(join(tmpdir(), "harness-review-"));
  const checkout = canonicalPath(join(base, "checkout"));
  const receipt: ReviewReceipt = {
    schemaVersion: "worktree-delivery/1.0",
    kind: "review-receipt",
    id,
    projectDir: status.projectDir,
    commonDir: status.commonDir,
    commit,
    path: checkout,
    receiptPath,
    command: [...args.command],
    createdAt,
    status: "starting",
    detached: false,
    dirty: false,
    exitCode: null,
    output: "",
  };
  mkdirSync(dirname(receiptPath), { recursive: true });
  atomicWrite(receiptPath, prettyJson(receipt));
  const lock = acquireNamedLock(status.commonDir, "review.lock");
  let added = false;
  try {
    git(status.projectDir, ["worktree", "add", "--detach", checkout, commit]);
    added = true;
    receipt.detached = git(status.projectDir, [
      "-C",
      checkout,
      "symbolic-ref",
      "-q",
      "HEAD",
    ], true).trim().length === 0;
    if (!receipt.detached) throw new Error("REVIEW_NOT_DETACHED");
    receipt.status = "active";
    atomicWrite(receiptPath, prettyJson(receipt));

    const result = spawnSync(args.command[0], args.command.slice(1), {
      cwd: checkout,
      encoding: "utf8",
      timeout: 30 * 60_000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, CI: "1" },
    });
    receipt.exitCode = result.status;
    receipt.output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().slice(-20_000);
    if (result.error) receipt.error = String(result.error);
    receipt.dirty = git(status.projectDir, [
      "-C",
      checkout,
      "status",
      "--porcelain=v1",
      "-z",
    ]).length > 0;
    if (receipt.dirty) {
      const evidence = collectDirtyEvidence(status.projectDir, checkout);
      receipt.dirtyEvidence = evidence.dirtyEvidence;
      receipt.dirtyPatch = evidence.dirtyPatch;
    }
    receipt.completedAt = (args.now ?? new Date()).toISOString();
    if (receipt.dirty) {
      receipt.status = "blocked";
      receipt.error = receipt.error ?? "REVIEW_DIRTY: temporary review content was preserved";
    } else {
      git(status.projectDir, ["worktree", "remove", checkout]);
      added = false;
      rmdirSync(base);
      receipt.status = result.status === 0 && !result.error ? "cleaned" : "failed";
    }
    atomicWrite(receiptPath, prettyJson(receipt));
    return receipt;
  } catch (error) {
    receipt.error = error instanceof Error ? error.message : String(error);
    receipt.completedAt = (args.now ?? new Date()).toISOString();
    receipt.status = "failed";
    if (added) {
      const dirty = git(status.projectDir, [
        "-C",
        checkout,
        "status",
        "--porcelain=v1",
        "-z",
      ], true).length > 0;
      receipt.dirty = dirty;
      if (!dirty) {
        try {
          git(status.projectDir, ["worktree", "remove", checkout]);
          added = false;
          rmdirSync(base);
        } catch {
          receipt.status = "blocked";
        }
      } else {
        receipt.status = "blocked";
      }
    } else if (existsSync(base)) {
      try {
        rmdirSync(base);
      } catch {
        receipt.status = "blocked";
      }
    }
    atomicWrite(receiptPath, prettyJson(receipt));
    return receipt;
  } finally {
    releaseLock(lock);
  }
}

export function retentionAuditWorkspace(args: {
  projectRoot: string;
  hostStateRoot?: string;
  now?: Date;
}): RetentionAudit {
  const status = workspaceStatus(args.projectRoot);
  const now = args.now ?? new Date();
  const hostStateRoot = resolve(args.hostStateRoot ?? defaultHostStateRoot());
  const reviewDirectory = join(hostStateRoot, "reviews");
  const errors: string[] = [];
  const receipts: ReviewReceipt[] = [];
  if (existsSync(reviewDirectory)) {
    for (const name of readdirSync(reviewDirectory).filter((entry) => entry.endsWith(".json")).sort()) {
      const path = join(reviewDirectory, name);
      try {
        const receipt = readJson<ReviewReceipt>(path);
        if (receipt.kind !== "review-receipt") throw new Error("not a review receipt");
        receipts.push(receipt);
      } catch (error) {
        errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  const staleReviews = receipts.filter((receipt) => {
    if (!["active", "blocked", "failed", "starting"].includes(receipt.status)) return false;
    const ageMinutes = (now.getTime() - new Date(receipt.createdAt).getTime()) / 60_000;
    return ageMinutes > status.config.reviewTtlMinutes;
  });
  const staleLeases = status.leases
    .map((lease) => ({
      ...lease,
      ageHours: Math.max(0, (now.getTime() - Date.parse(lease.heartbeatAt)) / 3_600_000),
    }))
    .filter((lease) => lease.ageHours > status.config.leaseTtlHours);
  const remoteTokens = git(status.projectDir, [
    "for-each-ref",
    "--format=%(refname)%00%(committerdate:iso-strict)%00",
    "refs/remotes",
  ], true).split("\0").filter(Boolean);
  const remoteBranches: RetentionAudit["remoteBranches"] = [];
  for (let index = 0; index + 1 < remoteTokens.length; index += 2) {
    const ref = remoteTokens[index];
    if (ref.endsWith("/HEAD")) continue;
    const committedAt = remoteTokens[index + 1];
    const ageDays = Math.max(
      0,
      Math.floor((now.getTime() - new Date(committedAt).getTime()) / 86_400_000),
    );
    if (ageDays >= status.config.remoteBranchRetentionDays) {
      remoteBranches.push({ ref, committedAt, ageDays });
    }
  }
  const staleLocks: RetentionAudit["staleLocks"] = [];
  for (const [name, ttlMinutes] of [
    ["apply.lock", status.config.leaseTtlHours * 60],
    ["review.lock", status.config.reviewTtlMinutes],
  ] as const) {
    const path = join(stateRoot(status.commonDir), name);
    if (!existsSync(path)) continue;
    const ageMinutes = Math.max(0, (now.getTime() - statSync(path).mtimeMs) / 60_000);
    if (ageMinutes > ttlMinutes) staleLocks.push({ path, ageMinutes });
  }
  return {
    schemaVersion: WORKTREE_SCHEMA_VERSION,
    projectDir: status.projectDir,
    checkedAt: now.toISOString(),
    reviewTtlMinutes: status.config.reviewTtlMinutes,
    remoteBranchRetentionDays: status.config.remoteBranchRetentionDays,
    remoteDeletionEnabled: false,
    staleReviews,
    staleLeases,
    staleLocks,
    remoteBranches,
    errors,
  };
}
