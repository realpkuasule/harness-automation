import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readSync,
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
  type ProviderObservation,
  type WorktreeRecord,
  type WorkspaceAdoptionInput,
  type WorkspaceAdoptionManifest,
  type WorkspaceAdoptionPlanItem,
  type WorkspaceAdoptionSnapshot,
  type RetentionAudit,
  type ReviewReceipt,
  type WorkspaceAudit,
  type WorktreeHostBinding,
  type WorktreeHostBindingObservation,
  type WorkspaceLease,
  type WorkspaceLeaseChange,
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

function gitDirtyPatch(cwd: string, args: string[], allowFailure = false): {
  size: number;
  sha256: string;
} {
  const path = join(tmpdir(), `harness-dirty-patch-${process.pid}-${randomUUID()}`);
  const output = openSync(path, "wx+");
  try {
    const result = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", output, "pipe"],
      timeout: 30_000,
    });
    if (result.error || (!allowFailure && result.status !== 0)) {
      const detail = `${result.stderr ?? result.error ?? ""}`.trim();
      throw new Error(`GIT_COMMAND_FAILED: git ${args.join(" ")}: ${detail}`);
    }
    if (result.status !== 0) return { size: 0, sha256: sha256("") };

    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let size = 0;
    let bytes = 0;
    let position = 0;
    while ((bytes = readSync(output, buffer, 0, buffer.length, position)) > 0) {
      size += bytes;
      position += bytes;
      hash.update(buffer.subarray(0, bytes));
    }
    return { size, sha256: hash.digest("hex") };
  } finally {
    closeSync(output);
    unlinkSync(path);
  }
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

const adoptionInputSchema = z.object({
  workItem: z.string().trim().min(1),
  owner: z.string().trim().min(1),
  thread: z.string().trim().min(1).optional(),
  path: z.string().trim().min(1),
  branch: z.string().trim().min(1),
}).strict();

const adoptionManifestSchema = z.object({
  schemaVersion: z.literal("worktree-adopt/1.0"),
  items: z.array(adoptionInputSchema).min(1),
}).strict();

export function parseWorkspaceAdoptionManifest(input: unknown): WorkspaceAdoptionManifest {
  const parsed = adoptionManifestSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const code = issue.path.length === 1 && issue.path[0] === "items" && issue.code === "too_small"
      ? "WORKTREE_ADOPT_BATCH_EMPTY"
      : "WORKTREE_ADOPT_INPUT_INVALID";
    throw new Error(`${code}: ${issue.path.join(".") || "manifest"} ${issue.message}`);
  }
  return parsed.data;
}

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

export function loadConfig(root: string): {
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

function worktreeStatusTokens(
  root: string,
  worktreePath: string,
  adoptionSafe = false,
): string[] {
  return git(root, adoptionSafe
    ? [
        "--no-optional-locks",
        "-C",
        worktreePath,
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ]
    : ["-C", worktreePath, "status", "--porcelain=v1", "-z"], !adoptionSafe)
    .split("\0").filter(Boolean);
}

function collectDirtyEvidence(
  root: string,
  worktreePath: string,
  tokens = worktreeStatusTokens(root, worktreePath),
  adoptionSafe = false,
): Pick<
  WorktreeRecord,
  "dirtyEvidence" | "dirtyPatch"
> {
  const entries: NonNullable<WorktreeRecord["dirtyEvidence"]> = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const status = token.slice(0, 2);
    let path = token.slice(3);
    const renamed = adoptionSafe ? /[RC]/u.test(status) : /^[RC]/u.test(status);
    if (renamed && tokens[index + 1]) {
      if (!adoptionSafe) path = tokens[index + 1];
      index += 1;
    }
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
    if (adoptionSafe && !metadata.isSymbolicLink() && !metadata.isFile()) {
      throw new Error(`DIRTY_FILE_TYPE_UNSUPPORTED: ${path}`);
    }
    const content = metadata.isSymbolicLink()
      ? Buffer.from(readlinkSync(target), "utf8")
      : metadata.isFile()
        ? readFileSync(target)
        : Buffer.alloc(0);
    entries.push({ path, status, size: content.byteLength, sha256: sha256(content) });
  }
  const dirtyPatch = gitDirtyPatch(root, adoptionSafe
    ? [
        "--no-optional-locks",
        "-C",
        worktreePath,
        "diff",
        "--binary",
        "--no-ext-diff",
        "--no-textconv",
        "HEAD",
        "--",
      ]
    : ["-C", worktreePath, "diff", "--binary", "--no-ext-diff", "HEAD", "--"],
  !adoptionSafe);
  return {
    dirtyEvidence: adoptionSafe
      ? entries.sort((left, right) =>
          left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
      : entries,
    dirtyPatch,
  };
}

function enrichWorktree(
  root: string,
  record: WorktreeRecord,
  refs: string[],
  adoptionSafe = false,
): WorktreeRecord {
  if (record.bare || record.prunable || !existsSync(record.path)) return record;
  const tokens = worktreeStatusTokens(root, record.path, adoptionSafe);
  const dirty = tokens.length > 0;
  const otherRefs = record.branch
    ? refs.filter((ref) => ref !== `refs/heads/${record.branch}`)
    : refs;
  return {
    ...record,
    dirty,
    ...(dirty ? collectDirtyEvidence(root, record.path, tokens, adoptionSafe) : {}),
    uniqueCommits: record.head
      ? commitCount(root, [record.head, "--not", ...otherRefs])
      : 0,
    unpushedCommits: record.head
      ? commitCount(root, [record.head, "--not", "--remotes"])
      : 0,
  };
}

function worktrees(root: string, adoptionSafe = false): WorktreeRecord[] {
  const refs = git(root, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"])
    .split(/\r?\n/u)
    .filter(Boolean);
  return parseWorktreePorcelain(git(root, ["worktree", "list", "--porcelain", "-z"]))
    .map((record) => enrichWorktree(root, record, refs, adoptionSafe));
}

function refsObservation(root: string): string[] {
  return git(root, [
    "for-each-ref",
    "--format=%(refname)%00%(objectname)%00",
    "refs/heads",
    "refs/remotes",
  ]).split("\0").filter(Boolean);
}

function worktreeRegistrationObservation(worktreeRecords: WorktreeRecord[]): Array<{
  path: string;
  head: string;
  branch: string | null;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
}> {
  return worktreeRecords.map((worktree) => ({
    path: worktree.path,
    head: worktree.head,
    branch: worktree.branch,
    bare: worktree.bare,
    detached: worktree.detached,
    locked: worktree.locked,
    prunable: worktree.prunable,
  })).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
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

function stateJsonFiles(
  commonDir: string,
  kind: "leases" | "receipts",
): Array<{ path: string; relativePath: string }> {
  const relativeDirectory = `harness/worktree-delivery/${kind}`;
  const directory = safePath(commonDir, relativeDirectory);
  if (!existsSync(directory)) return [];
  if (!lstatSync(directory).isDirectory()) {
    throw new Error(`WORKTREE_STATE_INVALID: ${directory} is not a directory`);
  }
  return readdirSync(directory)
    .filter((entry) => entry.endsWith(".json"))
    .sort()
    .map((name) => {
      const relativePath = `${relativeDirectory}/${name}`;
      const path = safePath(commonDir, relativePath);
      if (!lstatSync(path).isFile()) {
        throw new Error(`WORKTREE_STATE_INVALID: ${path} is not a regular file`);
      }
      return { path, relativePath };
    });
}

function leases(commonDir: string): { values: WorkspaceLease[]; errors: string[] } {
  const values: WorkspaceLease[] = [];
  const errors: string[] = [];
  let files: Array<{ path: string; relativePath: string }> = [];
  try {
    files = stateJsonFiles(commonDir, "leases");
  } catch (error) {
    return { values, errors: [error instanceof Error ? error.message : String(error)] };
  }
  for (const { path } of files) {
    try {
      values.push(validLease(JSON.parse(readFileSync(path, "utf8")), path));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { values, errors };
}

function leaseStateObservation(
  commonDir: string,
): Array<{ leasePath: string; sha256: string }> {
  return stateJsonFiles(commonDir, "leases").map(({ path, relativePath }) => ({
    leasePath: relativePath,
    sha256: fileHash(path) ?? "",
  }));
}

export function workspaceStatus(
  projectRoot: string,
  options: {
    adoptionSafe?: boolean;
    providerWorkItems?: string[];
    providerObservation?: ProviderObservation;
  } = {},
): WorkspaceStatus {
  const root = repositoryRoot(projectRoot);
  const commonDir = gitCommonDir(root);
  const loadedConfig = loadConfig(root);
  const hostBinding = loadHostBinding(root, commonDir, loadedConfig.legacyBinding);
  const loadedLeases = leases(commonDir);
  const observedWorktrees = worktrees(root, options.adoptionSafe);
  const provider = options.providerObservation ?? observeProvider(
      root,
      loadedConfig.config,
      loadedLeases.values,
      options.providerWorkItems,
    );
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
  const refs = refsObservation(root);
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
  if (status.provider.configured && !status.provider.available) {
    const evidence = [status.provider.error ?? "provider unavailable"];
    add(blockedResult(status, "workspace.clean-before-close",
      "Provider state is unavailable; completed dirty worktrees cannot be fully identified.",
      evidence));
    add(blockedResult(status, "workspace.unique-commits-protected",
      "Provider state is unavailable; completed worktrees with protected commits cannot be fully identified.",
      evidence));
    add(blockedResult(status, "workspace.done-no-persistent-worktree",
      "Provider state is unavailable; completed worktrees cannot be fully identified.",
      evidence));
  } else {
    add(result(status, "workspace.clean-before-close", dirtyDone.length === 0,
      dirtyDone.length === 0 ? "No completed worktree is dirty." : "Completed worktrees contain uncommitted content.",
      dirtyDone));
    add(result(status, "workspace.unique-commits-protected", uniqueDone.length === 0,
      uniqueDone.length === 0 ? "No completed worktree contains unique or unpushed commits." : "Completed worktrees contain protected commits.",
      uniqueDone));
    add(result(status, "workspace.done-no-persistent-worktree", doneLeases.length === 0,
      doneLeases.length === 0 ? "No completed work item retains a persistent worktree." : "Completed work items retain persistent worktrees.",
      doneLeases.map((lease) => `${lease.workItem}: ${lease.path}`)));
  }
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

function leaseRelativePath(workItem: string): string {
  return `harness/worktree-delivery/leases/${sha256(workItem)}.json`;
}

function leaseFile(commonDir: string, workItem: string): string {
  return safePath(commonDir, leaseRelativePath(workItem));
}

function receiptFile(commonDir: string, id: string): string {
  return safePath(commonDir, `harness/worktree-delivery/receipts/${id}.json`);
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
  const workItem = args.workItem.trim();
  if (!workItem) throw new Error("WORK_ITEM_REQUIRED");
  const root = repositoryRoot(args.projectRoot);
  const configuredProvider = loadConfig(root).config.provider;
  if (
    configuredProvider.kind === "github" &&
    !workItem.startsWith(`github:${configuredProvider.repository ?? ""}#`)
  ) {
    throw new Error(`PROVIDER_WORK_ITEM_INVALID: ${workItem}`);
  }
  const status = workspaceStatus(root, { providerWorkItems: [workItem] });
  if (!status.configured) throw new Error("WORKTREE_CONFIGURATION_REQUIRED");
  if (status.config.mode !== "enforced") throw new Error("WORKTREE_ENFORCEMENT_NOT_ENABLED");
  requireHostBinding(status);
  if (status.provider.configured && !status.provider.available) {
    throw new Error(`PROVIDER_UNAVAILABLE: ${status.provider.error}`);
  }
  if (!args.owner.trim()) throw new Error("OWNER_REQUIRED");
  const providerItem = status.provider.items.find((item) => item.workItem === workItem);
  if (status.provider.configured && !providerItem) {
    throw new Error(`PROVIDER_WORK_ITEM_INVALID: ${workItem}`);
  }
  if (status.config.provider.project && providerItem?.projectItemPresent !== true) {
    throw new Error(`PROVIDER_PROJECT_ITEM_REQUIRED: ${workItem}`);
  }
  validateBranch(status.projectDir, args.branch);
  const target = validateTarget(status.hostBinding, args.path);
  if (existsSync(target)) throw new Error(`WORKTREE_PATH_EXISTS: ${target}`);
  if (status.leases.some((lease) => lease.workItem === workItem)) {
    throw new Error(`DUPLICATE_WORK_ITEM_LEASE: ${workItem}`);
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
    workItem,
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
    operation: {
      kind: "allocate",
      lease,
      startPoint: acceptedCommit,
      createBranch,
      providerObservationBound: true,
    },
    now: args.now,
  }));
}

function normalizedAdoptionInputs(input: unknown): WorkspaceAdoptionInput[] {
  const parsed = z.array(adoptionInputSchema).min(1).safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const code = issue.code === "too_small"
      ? "WORKTREE_ADOPT_BATCH_EMPTY"
      : "WORKTREE_ADOPT_INPUT_INVALID";
    throw new Error(`${code}: ${issue.path.join(".") || "items"} ${issue.message}`);
  }
  return parsed.data.map((item) => {
    if (!isAbsolute(item.path)) throw new Error("WORKTREE_PATH_MUST_BE_ABSOLUTE");
    return { ...item, path: canonicalPath(item.path) };
  }).sort((left, right) => {
    if (left.workItem !== right.workItem) return left.workItem < right.workItem ? -1 : 1;
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
  });
}

function assertUniqueAdoptionInputs(items: WorkspaceAdoptionInput[]): void {
  for (const [field, code] of [
    ["workItem", "DUPLICATE_ADOPT_WORK_ITEM"],
    ["path", "DUPLICATE_ADOPT_PATH"],
    ["branch", "DUPLICATE_ADOPT_BRANCH"],
  ] as const) {
    const values = items.map((item) => item[field]);
    const duplicate = values.find((value, index) => values.indexOf(value) !== index);
    if (duplicate) throw new Error(`${code}: ${duplicate}`);
  }
}

function adoptionSnapshot(
  root: string,
  commonDir: string,
  record: WorktreeRecord,
  requestedBranch: string,
): WorkspaceAdoptionSnapshot {
  if (record.bare) throw new Error(`WORKTREE_BARE: ${record.path}`);
  if (record.detached || !record.branch) throw new Error(`WORKTREE_DETACHED: ${record.path}`);
  if (record.locked) throw new Error(`WORKTREE_LOCKED: ${record.path}`);
  if (record.prunable) throw new Error(`WORKTREE_PRUNABLE: ${record.path}`);
  if (record.branch !== requestedBranch) {
    throw new Error(
      `WORKTREE_BRANCH_MISMATCH: requested ${requestedBranch}, observed ${record.branch}`,
    );
  }
  const branchHead = git(root, [
    "rev-parse",
    "--verify",
    `refs/heads/${requestedBranch}^{commit}`,
  ]).trim();
  if (branchHead !== record.head) {
    throw new Error(
      `WORKTREE_BRANCH_MISMATCH: ${requestedBranch}=${branchHead}, worktree HEAD=${record.head}`,
    );
  }
  const worktreeGitDir = git(root, [
    "-C",
    record.path,
    "rev-parse",
    "--absolute-git-dir",
  ]).trim();
  const observedIndexPath = join(worktreeGitDir, "index");
  if (lstatSync(observedIndexPath).isSymbolicLink()) {
    throw new Error(`SYMLINK_TARGET_REJECTED: worktree index ${observedIndexPath}`);
  }
  if (!lstatSync(observedIndexPath).isFile()) {
    throw new Error(`WORKTREE_INDEX_UNAVAILABLE: ${record.path}`);
  }
  const indexPath = safePath(commonDir, relative(commonDir, observedIndexPath));
  if (!lstatSync(indexPath).isFile()) {
    throw new Error(`WORKTREE_INDEX_UNAVAILABLE: ${record.path}`);
  }
  const indexHash = fileHash(indexPath);
  if (!indexHash) throw new Error(`WORKTREE_INDEX_UNAVAILABLE: ${record.path}`);
  const tokens = worktreeStatusTokens(root, record.path, true);
  const evidence = collectDirtyEvidence(root, record.path, tokens, true);
  const draft = {
    path: canonicalPath(record.path),
    branch: requestedBranch,
    head: record.head,
    branchHead,
    indexHash,
    bare: false as const,
    detached: false as const,
    locked: false as const,
    prunable: false as const,
    dirty: tokens.length > 0,
    dirtyEvidence: evidence.dirtyEvidence ?? [],
    dirtyPatch: evidence.dirtyPatch ?? { size: 0, sha256: sha256("") },
  };
  return { ...draft, snapshotHash: hashObject(draft) };
}

function adoptionOperation(
  status: WorkspaceStatus,
  input: unknown,
  timestamp: string,
  providerObservationBound = true,
): Extract<WorkspacePlan["operation"], { kind: "adopt" }> {
  if (!status.configured) throw new Error("WORKTREE_CONFIGURATION_REQUIRED");
  if (status.config.mode !== "enforced") throw new Error("WORKTREE_ENFORCEMENT_NOT_ENABLED");
  requireHostBinding(status);
  if (status.errors.length > 0) {
    throw new Error(`WORKSPACE_DRIFT: ${status.errors.join("; ")}`);
  }
  const items = normalizedAdoptionInputs(input);
  assertUniqueAdoptionInputs(items);
  const afterCapacity = status.leases.length + items.length;
  if (afterCapacity > status.config.maxPersistentWorktrees) {
    throw new Error(`WORKTREE_CAPACITY_EXCEEDED: ${status.config.maxPersistentWorktrees}`);
  }
  const snapshots: Array<{
    input: WorkspaceAdoptionInput;
    snapshot: WorkspaceAdoptionSnapshot;
    provisionalLease: WorkspaceLease;
  }> = [];
  for (const item of items) {
    validateBranch(status.projectDir, item.branch);
    const management = status.worktrees.find((worktree) =>
      samePath(worktree.path, item.path) && (
        samePath(worktree.path, status.projectDir) ||
        (status.config.managementBranch && worktree.branch === status.config.managementBranch)
      ));
    if (management) throw new Error(`WORKTREE_MANAGEMENT_CHECKOUT: ${item.path}`);
    const target = validateTarget(status.hostBinding, item.path);
    if (status.leases.some((lease) => lease.workItem === item.workItem)) {
      throw new Error(`DUPLICATE_WORK_ITEM_LEASE: ${item.workItem}`);
    }
    if (status.leases.some((lease) => samePath(lease.path, target))) {
      throw new Error(`DUPLICATE_WORKTREE_PATH: ${target}`);
    }
    if (status.leases.some((lease) => lease.branch === item.branch)) {
      throw new Error(`DUPLICATE_WORKTREE_BRANCH: ${item.branch}`);
    }
    if (fileHash(leaseFile(status.commonDir, item.workItem)) !== null) {
      throw new Error(`DUPLICATE_WORK_ITEM_LEASE: ${item.workItem}`);
    }
    const matches = status.worktrees.filter((worktree) => samePath(worktree.path, target));
    if (matches.length !== 1) throw new Error(`WORKTREE_NOT_FOUND: ${target}`);
    const record = matches[0];
    const snapshot = adoptionSnapshot(status.projectDir, status.commonDir, record, item.branch);
    const branchCheckouts = status.worktrees.filter((worktree) => worktree.branch === item.branch);
    if (
      branchCheckouts.length !== 1 ||
      !samePath(branchCheckouts[0].path, target)
    ) {
      throw new Error(`DUPLICATE_WORKTREE_BRANCH: ${item.branch}`);
    }
    snapshots.push({
      input: { ...item, path: target },
      snapshot,
      provisionalLease: {
        schemaVersion: WORKTREE_SCHEMA_VERSION,
        workItem: item.workItem,
        branch: item.branch,
        path: target,
        owner: item.owner,
        thread: item.thread,
        acceptedCommit: snapshot.head,
        createdAt: timestamp,
        heartbeatAt: timestamp,
        status: "active",
      },
    });
  }
  if (status.config.provider.kind === "github") {
    const repository = status.config.provider.repository ?? "";
    const prefix = `github:${repository}#`;
    for (const item of items) {
      if (!item.workItem.startsWith(prefix) || !/^\d+$/u.test(item.workItem.slice(prefix.length))) {
        throw new Error(`PROVIDER_WORK_ITEM_INVALID: ${item.workItem}`);
      }
    }
  }
  const provider = providerObservationBound
    ? { ...status.provider, items: [...status.provider.items] }
    : observeProvider(status.projectDir, status.config, [
      ...status.leases,
      ...snapshots.map((item) => item.provisionalLease),
    ]);
  provider.items.sort((left, right) =>
    left.workItem < right.workItem ? -1 : left.workItem > right.workItem ? 1 : 0);
  if (provider.configured && !provider.available) {
    throw new Error(`PROVIDER_UNAVAILABLE: ${provider.error}`);
  }
  const planItems: WorkspaceAdoptionPlanItem[] = snapshots.map((item) => {
    const providerItem = provider.items.find(
      (candidate) => candidate.workItem === item.input.workItem,
    );
    if (status.config.provider.kind !== "none" && !providerItem) {
      throw new Error(`PROVIDER_WORK_ITEM_INVALID: ${item.input.workItem}`);
    }
    if (status.config.provider.project && providerItem?.projectItemPresent !== true) {
      throw new Error(`PROVIDER_PROJECT_ITEM_REQUIRED: ${item.input.workItem}`);
    }
    const lease: WorkspaceLease = {
      ...item.provisionalLease,
      workItemState: providerItem?.state,
    };
    const content = prettyJson(lease);
    return {
      lease,
      snapshot: item.snapshot,
      providerItem,
      leasePath: leaseRelativePath(lease.workItem),
      beforeLeaseHash: null,
      afterLeaseHash: sha256(content),
    };
  });
  const configHash = fileHash(join(status.projectDir, ".harness", "worktree-delivery.json"));
  if (!configHash || !status.hostBinding.hash) {
    throw new Error("WORKSPACE_DRIFT: configuration or host binding is unavailable");
  }
  return {
    kind: "adopt",
    configHash,
    hostBindingHash: status.hostBinding.hash,
    refsHash: hashObject(refsObservation(status.projectDir)),
    worktreeRegistrationHash: hashObject(worktreeRegistrationObservation(status.worktrees)),
    existingLeases: leaseStateObservation(status.commonDir),
    capacity: {
      limit: status.config.maxPersistentWorktrees,
      before: status.leases.length,
      adopting: planItems.length,
      after: afterCapacity,
    },
    providerHash: hashObject(provider),
    provider,
    ...(providerObservationBound ? { providerObservationBound: true as const } : {}),
    items: planItems,
  };
}

export function planWorkspaceAdoption(args: {
  projectRoot: string;
  items: WorkspaceAdoptionInput[];
  now?: Date;
}): { plan: WorkspacePlan; path: string } {
  const items = normalizedAdoptionInputs(args.items);
  const root = repositoryRoot(args.projectRoot);
  const configuredProvider = loadConfig(root).config.provider;
  if (configuredProvider.kind === "github") {
    const prefix = `github:${configuredProvider.repository ?? ""}#`;
    const invalid = items.find((item) =>
      !item.workItem.startsWith(prefix) ||
      !/^\d+$/u.test(item.workItem.slice(prefix.length)));
    if (invalid) throw new Error(`PROVIDER_WORK_ITEM_INVALID: ${invalid.workItem}`);
  }
  const status = workspaceStatus(root, {
    adoptionSafe: true,
    providerWorkItems: items.map((item) => item.workItem),
  });
  const timestamp = (args.now ?? new Date()).toISOString();
  const operation = adoptionOperation(status, items, timestamp);
  const doneValues = new Set(
    status.config.provider.project?.doneValues.map((value) => value.toLowerCase()) ?? [],
  );
  const warnings = operation.items.flatMap((item) => {
    const completed = item.providerItem?.state.toLowerCase() === "closed" ||
      (item.providerItem?.projectStatus
        ? doneValues.has(item.providerItem.projectStatus.toLowerCase())
        : false);
    return completed
      ? [`${item.lease.workItem} is already complete in the Provider; adopt it first, then close it with a separate exact-hash plan.`]
      : [];
  });
  return savePlan(status.projectDir, planDraft({
    status,
    operation,
    now: args.now,
    warnings,
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

export function planWorkspaceRebind(args: {
  projectRoot: string;
  workItem: string;
  branch: string;
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
  validateBranch(status.projectDir, args.branch);
  if (lease.branch === args.branch) {
    throw new Error(`WORKTREE_REBIND_NOOP: ${args.workItem} already uses ${args.branch}`);
  }
  if (status.leases.some((item) => item.workItem !== lease.workItem && item.branch === args.branch)) {
    throw new Error(`DUPLICATE_WORKTREE_BRANCH: ${args.branch}`);
  }
  const observed = status.worktrees.find((worktree) => samePath(worktree.path, lease.path));
  if (!observed || observed.branch !== args.branch || observed.bare || observed.detached ||
      observed.locked || observed.prunable) {
    throw new Error("WORKTREE_REBIND_PRECONDITION_FAILED: observed worktree does not match requested branch");
  }
  const branchHead = git(status.projectDir, [
    "rev-parse",
    "--verify",
    `${args.branch}^{commit}`,
  ]).trim();
  if (branchHead !== observed.head) {
    throw new Error("WORKTREE_REBIND_PRECONDITION_FAILED: branch head changed");
  }
  const timestamp = (args.now ?? new Date()).toISOString();
  const replacementLease: WorkspaceLease = {
    ...lease,
    branch: args.branch,
    acceptedCommit: observed.head,
    heartbeatAt: timestamp,
  };
  const expectedLeaseHash = fileHash(leaseFile(status.commonDir, lease.workItem));
  if (!expectedLeaseHash) throw new Error(`WORKTREE_LEASE_NOT_FOUND: ${args.workItem}`);
  return savePlan(status.projectDir, planDraft({
    status,
    operation: {
      kind: "rebind",
      lease,
      replacementLease,
      expectedHead: observed.head,
      expectedLeaseHash,
      afterLeaseHash: sha256(prettyJson(replacementLease)),
    },
    now: args.now,
    warnings: ["Rebind updates the existing lease only; the worktree and branches are preserved."],
  }));
}

export function planWorkspaceRenew(args: {
  projectRoot: string;
  workItem: string;
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
  validateBranch(status.projectDir, lease.branch);
  const observed = status.worktrees.find((worktree) => samePath(worktree.path, lease.path));
  if (!observed || observed.branch !== lease.branch || observed.bare || observed.detached ||
      observed.locked || observed.prunable || observed.head !== lease.acceptedCommit) {
    throw new Error("WORKTREE_RENEW_PRECONDITION_FAILED: observed worktree does not match lease");
  }
  const branchHead = git(status.projectDir, [
    "rev-parse",
    "--verify",
    `${lease.branch}^{commit}`,
  ]).trim();
  if (branchHead !== observed.head) {
    throw new Error("WORKTREE_RENEW_PRECONDITION_FAILED: branch head changed");
  }
  const heartbeatAt = (args.now ?? new Date()).toISOString();
  if (heartbeatAt === lease.heartbeatAt) {
    throw new Error(`WORKTREE_RENEW_NOOP: ${args.workItem} already has this heartbeat`);
  }
  const replacementLease: WorkspaceLease = { ...lease, heartbeatAt };
  const expectedLeaseHash = fileHash(leaseFile(status.commonDir, lease.workItem));
  if (!expectedLeaseHash) throw new Error(`WORKTREE_LEASE_NOT_FOUND: ${args.workItem}`);
  return savePlan(status.projectDir, planDraft({
    status,
    operation: {
      kind: "renew",
      lease,
      replacementLease,
      expectedHead: observed.head,
      expectedLeaseHash,
      afterLeaseHash: sha256(prettyJson(replacementLease)),
    },
    now: args.now,
    warnings: ["Renew updates only the existing lease heartbeat; the worktree and branches are preserved."],
  }));
}

function loadWorkspacePlan(root: string, path: string): WorkspacePlan {
  const plan = readJson<WorkspacePlan>(safePath(root, path));
  if (
    plan.schemaVersion !== "worktree-delivery/1.0" ||
    plan.kind !== "workspace-plan" ||
    !["configure", "allocate", "adopt", "close", "rebind", "renew"].includes(plan.operation?.kind) ||
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
  if (plan.operation.kind === "adopt") {
    try {
      const operation = plan.operation;
      const validHash = (value: unknown): value is string =>
        typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
      const validItems = Array.isArray(operation.items) && operation.items.length > 0 &&
        operation.items.every((item) => {
          validLease(item.lease, item.leasePath);
          return item.leasePath === leaseRelativePath(item.lease.workItem) &&
            item.beforeLeaseHash === null &&
            validHash(item.afterLeaseHash) &&
            item.afterLeaseHash === sha256(prettyJson(item.lease)) &&
            item.snapshot.path === item.lease.path &&
            item.snapshot.branch === item.lease.branch &&
            item.snapshot.head === item.lease.acceptedCommit &&
            validHash(item.snapshot.indexHash) &&
            validHash(item.snapshot.snapshotHash) &&
            item.snapshot.snapshotHash === hashObject({
              ...item.snapshot,
              snapshotHash: undefined,
            });
        });
      const validExistingLeases = Array.isArray(operation.existingLeases) &&
        operation.existingLeases.every((item) =>
          typeof item.leasePath === "string" &&
          /^harness\/worktree-delivery\/leases\/[a-f0-9]{64}\.json$/u.test(item.leasePath) &&
          validHash(item.sha256)) &&
        new Set(operation.existingLeases.map((item) => item.leasePath)).size ===
          operation.existingLeases.length &&
        operation.existingLeases.every((item, index, entries) =>
          index === 0 || entries[index - 1].leasePath < item.leasePath) &&
        operation.items.every((item) =>
          !operation.existingLeases.some((existing) => existing.leasePath === item.leasePath));
      if (
        !validItems ||
        !validExistingLeases ||
        !validHash(operation.configHash) ||
        !validHash(operation.hostBindingHash) ||
        !validHash(operation.refsHash) ||
        !validHash(operation.worktreeRegistrationHash) ||
        !validHash(operation.providerHash) ||
        operation.providerHash !== hashObject(operation.provider) ||
        operation.capacity.before !== operation.existingLeases.length ||
        operation.capacity.before + operation.capacity.adopting !== operation.capacity.after ||
        operation.capacity.adopting !== operation.items.length ||
        operation.capacity.after > operation.capacity.limit
      ) {
        throw new Error("WORKSPACE_PLAN_INVALID");
      }
    } catch {
      throw new Error("WORKSPACE_PLAN_INVALID");
    }
  }
  if (plan.operation.kind === "rebind") {
    try {
      const operation = plan.operation;
      validLease(operation.lease, leaseRelativePath(operation.lease.workItem));
      validLease(operation.replacementLease, leaseRelativePath(operation.replacementLease.workItem));
      const unchanged = ["workItem", "path", "owner", "thread", "createdAt", "status"] as const;
      if (
        operation.lease.workItem !== operation.replacementLease.workItem ||
        unchanged.some((key) => operation.lease[key] !== operation.replacementLease[key]) ||
        operation.lease.branch === operation.replacementLease.branch ||
        operation.replacementLease.acceptedCommit !== operation.expectedHead ||
        operation.expectedLeaseHash !== sha256(prettyJson(operation.lease)) ||
        operation.afterLeaseHash !== sha256(prettyJson(operation.replacementLease)) ||
        !/^[a-f0-9]{40,64}$/u.test(operation.expectedHead) ||
        !/^[a-f0-9]{64}$/u.test(operation.expectedLeaseHash) ||
        !/^[a-f0-9]{64}$/u.test(operation.afterLeaseHash)
      ) {
        throw new Error("WORKSPACE_PLAN_INVALID");
      }
    } catch {
      throw new Error("WORKSPACE_PLAN_INVALID");
    }
  }
  if (plan.operation.kind === "renew") {
    try {
      const operation = plan.operation;
      validLease(operation.lease, leaseRelativePath(operation.lease.workItem));
      validLease(operation.replacementLease, leaseRelativePath(operation.replacementLease.workItem));
      const unchanged = [
        "workItem", "branch", "path", "owner", "thread", "workItemState", "acceptedCommit", "createdAt", "status",
      ] as const;
      if (
        operation.lease.workItem !== operation.replacementLease.workItem ||
        unchanged.some((key) => operation.lease[key] !== operation.replacementLease[key]) ||
        operation.lease.heartbeatAt === operation.replacementLease.heartbeatAt ||
        operation.lease.acceptedCommit !== operation.expectedHead ||
        operation.expectedLeaseHash !== sha256(prettyJson(operation.lease)) ||
        operation.afterLeaseHash !== sha256(prettyJson(operation.replacementLease)) ||
        !/^[a-f0-9]{40,64}$/u.test(operation.expectedHead) ||
        !/^[a-f0-9]{64}$/u.test(operation.expectedLeaseHash) ||
        !/^[a-f0-9]{64}$/u.test(operation.afterLeaseHash)
      ) {
        throw new Error("WORKSPACE_PLAN_INVALID");
      }
    } catch {
      throw new Error("WORKSPACE_PLAN_INVALID");
    }
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

function validateWorkspacePlanEnvelope(
  root: string,
  commonDir: string,
  plan: WorkspacePlan,
  approval: string,
): void {
  if (hashObject(withoutHash(plan)) !== plan.planHash) {
    throw new Error("PLAN_TAMPERED: workspace plan content does not match its embedded hash");
  }
  if (approval !== plan.planHash) {
    throw new Error(`APPROVAL_MISMATCH: expected exact plan hash ${plan.planHash}`);
  }
  if (plan.projectDir !== root || plan.commonDir !== commonDir) {
    throw new Error("PROJECT_MISMATCH: workspace plan belongs to another repository");
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
  if (plan.operation.kind === "adopt") {
    validateAdoptionReceipt(receipt, plan as WorkspacePlan & {
      operation: Extract<WorkspacePlan["operation"], { kind: "adopt" }>;
    });
    if (receipt.status === "started") {
      throw new Error(`WORKTREE_ADOPT_RECOVERY_REQUIRED: ${plan.id}`);
    }
  }
  if (receipt.status === "applied" && receipt.after) {
    const current = workspaceStatus(plan.projectDir, {
      adoptionSafe: plan.operation.kind === "adopt",
      providerObservation:
        (plan.operation.kind === "allocate" || plan.operation.kind === "adopt") &&
        plan.operation.providerObservationBound
          ? receipt.after.provider
          : undefined,
    });
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

function adoptionLeaseChanges(
  operation: Extract<WorkspacePlan["operation"], { kind: "adopt" }>,
  includeRemovals = false,
): WorkspaceLeaseChange[] {
  const created = operation.items.map((item) => ({
    action: "create" as const,
    workItem: item.lease.workItem,
    path: item.lease.path,
    branch: item.lease.branch,
    leasePath: item.leasePath,
    beforeHash: null,
    afterHash: item.afterLeaseHash,
  }));
  return includeRemovals
    ? [
        ...created,
        ...operation.items.map((item) => ({
          action: "remove" as const,
          workItem: item.lease.workItem,
          path: item.lease.path,
          branch: item.lease.branch,
          leasePath: item.leasePath,
          beforeHash: item.afterLeaseHash,
          afterHash: null,
        })),
      ]
    : created;
}

function validateAdoptionReceipt(
  receipt: WorkspaceReceipt,
  plan: WorkspacePlan & {
    operation: Extract<WorkspacePlan["operation"], { kind: "adopt" }>;
  },
): void {
  if (
    receipt.schemaVersion !== "worktree-delivery/1.0" ||
    receipt.kind !== "workspace-receipt" ||
    receipt.id !== plan.id ||
    receipt.planHash !== plan.planHash ||
    receipt.operation !== "adopt" ||
    receipt.before?.projectDir !== plan.projectDir ||
    receipt.before?.commonDir !== plan.commonDir ||
    receipt.before?.observedHash !== plan.observedHash ||
    receipt.beforeObservedHash !== plan.observedHash
  ) {
    throw new Error("WORKSPACE_RECEIPT_INVALID: adopt receipt identity does not match plan");
  }
  const expectedCreates = adoptionLeaseChanges(plan.operation);
  const changes = receipt.leaseChanges ?? [];
  if (receipt.status === "started" || receipt.status === "failed") {
    if (
      changes.length > expectedCreates.length ||
      changes.some((change, index) => hashObject(change) !== hashObject(expectedCreates[index]))
    ) {
      throw new Error("WORKSPACE_RECEIPT_INVALID: adopt receipt lease changes are invalid");
    }
    return;
  }
  if (
    !receipt.after ||
    receipt.after.projectDir !== plan.projectDir ||
    receipt.after.commonDir !== plan.commonDir ||
    receipt.afterObservedHash !== receipt.after.observedHash ||
    hashObject(changes) !== hashObject(adoptionLeaseChanges(
      plan.operation,
      receipt.status === "rolled-back",
    )) ||
    (receipt.status === "rolled-back" && (
      !receipt.rollbackAfter ||
      receipt.rollbackAfter.projectDir !== plan.projectDir ||
      receipt.rollbackAfter.commonDir !== plan.commonDir ||
      receipt.rollbackObservedHash !== receipt.rollbackAfter.observedHash
    ))
  ) {
    throw new Error("WORKSPACE_RECEIPT_INVALID: adopt receipt state does not match plan");
  }
}

function assertAdoptionPostconditions(
  status: WorkspaceStatus,
  operation: Extract<WorkspacePlan["operation"], { kind: "adopt" }>,
): void {
  if (
    fileHash(join(status.projectDir, ".harness", "worktree-delivery.json")) !==
      operation.configHash ||
    status.hostBinding.hash !== operation.hostBindingHash ||
    hashObject(refsObservation(status.projectDir)) !== operation.refsHash ||
    hashObject(worktreeRegistrationObservation(status.worktrees)) !==
      operation.worktreeRegistrationHash ||
    hashObject({
      ...status.provider,
      items: [...status.provider.items].sort((left, right) =>
        left.workItem < right.workItem ? -1 : left.workItem > right.workItem ? 1 : 0),
    }) !== operation.providerHash ||
    hashObject(leaseStateObservation(status.commonDir)) !== hashObject([
      ...operation.existingLeases,
      ...operation.items.map((item) => ({
        leasePath: item.leasePath,
        sha256: item.afterLeaseHash,
      })),
    ].sort((left, right) =>
      left.leasePath < right.leasePath ? -1 : left.leasePath > right.leasePath ? 1 : 0))
  ) {
    throw new Error("WORKTREE_ADOPT_POSTCONDITION_FAILED: workspace metadata changed");
  }
  for (const item of operation.items) {
    const target = safePath(status.commonDir, item.leasePath);
    assertCurrentHash(target, item.afterLeaseHash);
    const record = status.worktrees.find((worktree) => samePath(worktree.path, item.lease.path));
    if (!record) throw new Error(`WORKTREE_ADOPT_POSTCONDITION_FAILED: ${item.lease.path}`);
    const snapshot = adoptionSnapshot(
      status.projectDir,
      status.commonDir,
      record,
      item.lease.branch,
    );
    if (snapshot.snapshotHash !== item.snapshot.snapshotHash) {
      throw new Error(`WORKTREE_ADOPT_POSTCONDITION_FAILED: ${item.lease.path}`);
    }
  }
}

function applyWorkspaceAdoptionPlan(
  root: string,
  plan: WorkspacePlan & {
    operation: Extract<WorkspacePlan["operation"], { kind: "adopt" }>;
  },
  args: { approval: string; now?: Date; testFailAfterLeaseWrites?: number },
): WorkspaceReceipt {
  validateWorkspacePlanEnvelope(root, gitCommonDir(root), plan, args.approval);
  const lock = acquireLock(plan.commonDir);
  try {
    const previous = appliedReceipt(plan);
    if (previous) return previous;
    const providerWorkItems = plan.operation.providerObservationBound
      ? plan.operation.items.map((item) => item.lease.workItem)
      : undefined;
    const before = workspaceStatus(root, { adoptionSafe: true, providerWorkItems });
    validateWorkspacePlan(before, plan, args.approval);
    let reobserved: Extract<WorkspacePlan["operation"], { kind: "adopt" }>;
    try {
      reobserved = adoptionOperation(
        before,
        plan.operation.items.map((item) => ({
          workItem: item.lease.workItem,
          owner: item.lease.owner,
          thread: item.lease.thread,
          path: item.lease.path,
          branch: item.lease.branch,
        })),
        plan.operation.items[0].lease.createdAt,
        plan.operation.providerObservationBound === true,
      );
    } catch (error) {
      throw new Error(
        `WORKSPACE_DRIFT: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (hashObject(reobserved) !== hashObject(plan.operation)) {
      throw new Error("WORKSPACE_DRIFT: adoption preconditions changed");
    }
    const path = receiptFile(plan.commonDir, plan.id);
    const receipt: WorkspaceReceipt = {
      schemaVersion: "worktree-delivery/1.0",
      kind: "workspace-receipt",
      id: plan.id,
      planHash: plan.planHash,
      operation: "adopt",
      status: "started",
      startedAt: (args.now ?? new Date()).toISOString(),
      steps: [],
      before,
      beforeObservedHash: before.observedHash,
      leaseChanges: [],
      compensationStatus: "not-required",
    };
    const written: WorkspaceAdoptionPlanItem[] = [];
    writeReceipt(path, receipt);
    try {
      for (const item of plan.operation.items) {
        const target = safePath(plan.commonDir, item.leasePath);
        assertCurrentHash(target, item.beforeLeaseHash);
      }
      for (const item of plan.operation.items) {
        const target = safePath(plan.commonDir, item.leasePath);
        atomicWrite(target, prettyJson(item.lease));
        written.push(item);
        assertCurrentHash(target, item.afterLeaseHash);
        receipt.steps.push({ id: "write-adopted-lease", status: "applied", detail: item.lease.workItem });
        receipt.leaseChanges!.push({
          action: "create",
          workItem: item.lease.workItem,
          path: item.lease.path,
          branch: item.lease.branch,
          leasePath: item.leasePath,
          beforeHash: null,
          afterHash: item.afterLeaseHash,
        });
        if (args.testFailAfterLeaseWrites === written.length) {
          throw new Error("TEST_ADOPT_WRITE_FAILURE");
        }
      }
      const after = workspaceStatus(root, {
        adoptionSafe: true,
        providerObservation: reobserved.provider,
      });
      assertAdoptionPostconditions(after, plan.operation);
      receipt.status = "applied";
      receipt.completedAt = (args.now ?? new Date()).toISOString();
      receipt.after = after;
      receipt.afterObservedHash = after.observedHash;
      writeReceipt(path, receipt);
      return receipt;
    } catch (error) {
      let compensationFailed = false;
      for (const item of [...written].reverse()) {
        const target = safePath(plan.commonDir, item.leasePath);
        try {
          if (fileHash(target) !== item.afterLeaseHash) {
            throw new Error("lease changed after this transaction created it");
          }
          unlinkSync(target);
          receipt.steps.push({
            id: "remove-adopted-lease",
            status: "compensated",
            detail: item.lease.workItem,
          });
        } catch (compensationError) {
          compensationFailed = true;
          receipt.steps.push({
            id: "remove-adopted-lease",
            status: "failed",
            detail: `${item.lease.workItem}: ${compensationError instanceof Error
              ? compensationError.message
              : String(compensationError)}`,
          });
        }
      }
      const original = error instanceof Error ? error.message : String(error);
      receipt.status = "failed";
      receipt.compensationStatus = compensationFailed ? "failed" : "completed";
      receipt.error = compensationFailed
        ? `WORKTREE_ADOPT_COMPENSATION_FAILED: ${original}`
        : original;
      receipt.steps.push({ id: "apply", status: "failed", detail: receipt.error });
      receipt.completedAt = (args.now ?? new Date()).toISOString();
      writeReceipt(path, receipt);
      if (compensationFailed) throw new Error(receipt.error);
      throw error;
    }
  } finally {
    releaseLock(lock);
  }
}

export function applyWorkspacePlan(args: {
  projectRoot: string;
  planPath: string;
  approval: string;
  now?: Date;
  testFailAfterLeaseWrites?: number;
  testFailCloseAfterWorktreeRemove?: boolean;
}): WorkspaceReceipt {
  const root = repositoryRoot(args.projectRoot);
  const plan = loadWorkspacePlan(root, args.planPath);
  if (plan.operation.kind === "adopt") {
    return applyWorkspaceAdoptionPlan(root, plan as WorkspacePlan & {
      operation: Extract<WorkspacePlan["operation"], { kind: "adopt" }>;
    }, args);
  }
  const previous = appliedReceipt(plan);
  if (previous) return previous;
  const config = loadConfig(root).config;
  if (
    plan.operation.kind === "allocate" &&
    !plan.operation.providerObservationBound &&
    config.provider.kind === "github" &&
    config.provider.project
  ) {
    throw new Error(
      "WORKSPACE_PLAN_REPLAN_REQUIRED: legacy allocation plan does not bind GitHub Project state",
    );
  }
  let before = workspaceStatus(root, {
    providerWorkItems: plan.operation.kind === "allocate" &&
        plan.operation.providerObservationBound
      ? [plan.operation.lease.workItem]
      : undefined,
  });
  validateWorkspacePlan(before, plan, args.approval);
  const lock = acquireLock(plan.commonDir);
  if (plan.operation.kind === "renew") {
    before = workspaceStatus(root);
    validateWorkspacePlan(before, plan, args.approval);
  }
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
      receipt.leaseChanges = [{
        action: "create",
        workItem: operation.lease.workItem,
        path: operation.lease.path,
        branch: operation.lease.branch,
        leasePath: leaseRelativePath(operation.lease.workItem),
        beforeHash: null,
        afterHash: fileHash(leaseFile(plan.commonDir, operation.lease.workItem)),
      }];
    } else if (plan.operation.kind === "close") {
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
      receipt.leaseChanges = [{
        action: "remove",
        workItem: operation.lease.workItem,
        path: operation.lease.path,
        branch: operation.lease.branch,
        leasePath: leaseRelativePath(operation.lease.workItem),
        beforeHash: operation.expectedLeaseHash,
        afterHash: null,
      }];
      git(root, ["worktree", "remove", operation.lease.path]);
      worktreeRemoved = true;
      receipt.steps.push({ id: "remove-worktree", status: "applied", detail: operation.lease.path });
      if (args.testFailCloseAfterWorktreeRemove) {
        throw new Error("TEST_CLOSE_AFTER_WORKTREE_REMOVE_FAILURE");
      }
      unlinkSync(leaseFile(plan.commonDir, operation.lease.workItem));
      receipt.steps.push({ id: "remove-lease", status: "applied", detail: operation.lease.workItem });
    } else if (plan.operation.kind === "rebind") {
      const operation = plan.operation;
      requireHostBinding(before);
      validateTarget(before.hostBinding, operation.lease.path);
      assertCurrentHash(leaseFile(plan.commonDir, operation.lease.workItem), operation.expectedLeaseHash);
      const observed = before.worktrees.find(
        (worktree) => samePath(worktree.path, operation.lease.path),
      );
      if (!observed || observed.head !== operation.expectedHead ||
          observed.branch !== operation.replacementLease.branch || observed.bare || observed.detached ||
          observed.locked || observed.prunable) {
        throw new Error("WORKSPACE_DRIFT: rebind preconditions changed");
      }
      atomicWrite(leaseFile(plan.commonDir, operation.lease.workItem), prettyJson(operation.replacementLease));
      assertCurrentHash(leaseFile(plan.commonDir, operation.lease.workItem), operation.afterLeaseHash);
      receipt.leaseChanges = [{
        action: "update",
        workItem: operation.lease.workItem,
        path: operation.replacementLease.path,
        branch: operation.replacementLease.branch,
        leasePath: leaseRelativePath(operation.lease.workItem),
        beforeHash: operation.expectedLeaseHash,
        afterHash: operation.afterLeaseHash,
      }];
      receipt.steps.push({ id: "rebind-lease", status: "applied", detail: operation.lease.workItem });
    } else if (plan.operation.kind === "renew") {
      const operation = plan.operation;
      requireHostBinding(before);
      validateTarget(before.hostBinding, operation.lease.path);
      assertCurrentHash(leaseFile(plan.commonDir, operation.lease.workItem), operation.expectedLeaseHash);
      const observed = before.worktrees.find(
        (worktree) => samePath(worktree.path, operation.lease.path),
      );
      if (!observed || observed.head !== operation.expectedHead ||
          observed.branch !== operation.lease.branch || observed.bare || observed.detached ||
          observed.locked || observed.prunable) {
        throw new Error("WORKSPACE_DRIFT: renew preconditions changed");
      }
      atomicWrite(leaseFile(plan.commonDir, operation.lease.workItem), prettyJson(operation.replacementLease));
      assertCurrentHash(leaseFile(plan.commonDir, operation.lease.workItem), operation.afterLeaseHash);
      receipt.leaseChanges = [{
        action: "update",
        workItem: operation.lease.workItem,
        path: operation.lease.path,
        branch: operation.lease.branch,
        leasePath: leaseRelativePath(operation.lease.workItem),
        beforeHash: operation.expectedLeaseHash,
        afterHash: operation.afterLeaseHash,
      }];
      receipt.steps.push({ id: "renew-lease", status: "applied", detail: operation.lease.workItem });
    }
    receipt.status = "applied";
    receipt.completedAt = (args.now ?? new Date()).toISOString();
    receipt.after = workspaceStatus(root, {
      providerObservation: plan.operation.kind === "allocate" &&
          plan.operation.providerObservationBound
        ? before.provider
        : undefined,
    });
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
      } else if (plan.operation.kind === "rebind" &&
          fileHash(leaseFile(plan.commonDir, plan.operation.lease.workItem)) === plan.operation.afterLeaseHash) {
        atomicWrite(leaseFile(plan.commonDir, plan.operation.lease.workItem), prettyJson(plan.operation.lease));
        receipt.steps.push({ id: "restore-rebind", status: "compensated", detail: plan.operation.lease.workItem });
      } else if (plan.operation.kind === "renew" &&
          fileHash(leaseFile(plan.commonDir, plan.operation.lease.workItem)) === plan.operation.afterLeaseHash) {
        atomicWrite(leaseFile(plan.commonDir, plan.operation.lease.workItem), prettyJson(plan.operation.lease));
        receipt.steps.push({ id: "restore-renew", status: "compensated", detail: plan.operation.lease.workItem });
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

function laterLifecycleUsesAdoptedLease(
  commonDir: string,
  receipt: WorkspaceReceipt,
  operation: Extract<WorkspacePlan["operation"], { kind: "adopt" }>,
): string | null {
  const hashes = new Set(operation.items.map((item) => item.afterLeaseHash));
  for (const { path } of stateJsonFiles(commonDir, "receipts")) {
    const candidate = readJson<WorkspaceReceipt>(path);
    if (candidate.id === receipt.id) continue;
    const use = candidate.leaseChanges?.find(
      (change) => change.beforeHash !== null && hashes.has(change.beforeHash),
    );
    if (use) return `${candidate.id}: ${use.workItem}`;
  }
  return null;
}

function rollbackWorkspaceAdoption(args: {
  root: string;
  commonDir: string;
  receiptPath: string;
  plan: WorkspacePlan & {
    operation: Extract<WorkspacePlan["operation"], { kind: "adopt" }>;
  };
  now?: Date;
}): WorkspaceReceipt {
  const lock = acquireLock(args.commonDir);
  try {
    const receipt = readJson<WorkspaceReceipt>(args.receiptPath);
    validateAdoptionReceipt(receipt, args.plan);
    if (receipt.status === "rolled-back") return receipt;
    if (receipt.status !== "applied" || !receipt.after) {
      throw new Error(`WORKSPACE_ROLLBACK_UNAVAILABLE: ${receipt.status}`);
    }
    if (
      receipt.planHash !== args.plan.planHash ||
      hashObject(withoutHash(args.plan)) !== args.plan.planHash
    ) {
      throw new Error("WORKSPACE_ROLLBACK_UNSAFE: plan or receipt hash mismatch");
    }
    const status = workspaceStatus(args.root, { adoptionSafe: true });
    if (
      status.observedHash !== receipt.after.observedHash ||
      receipt.afterObservedHash !== receipt.after.observedHash
    ) {
      throw new Error("WORKSPACE_DRIFT: workspace changed after apply");
    }
    const laterUse = laterLifecycleUsesAdoptedLease(
      args.commonDir,
      receipt,
      args.plan.operation,
    );
    if (laterUse) {
      throw new Error(`WORKSPACE_ROLLBACK_LATER_LIFECYCLE_USE: ${laterUse}`);
    }
    assertAdoptionPostconditions(status, args.plan.operation);
    for (const item of args.plan.operation.items) {
      assertCurrentHash(safePath(args.commonDir, item.leasePath), item.afterLeaseHash);
    }
    const removed: WorkspaceAdoptionPlanItem[] = [];
    const rollbackSteps: WorkspaceReceipt["steps"] = [];
    try {
      for (const item of [...args.plan.operation.items].reverse()) {
        unlinkSync(safePath(args.commonDir, item.leasePath));
        removed.push(item);
        rollbackSteps.push({
          id: "rollback-adopted-lease",
          status: "compensated",
          detail: item.lease.workItem,
        });
      }
      const rollbackAfter = workspaceStatus(args.root, {
        adoptionSafe: true,
        providerObservation: receipt.before.provider,
      });
      if (rollbackAfter.observedHash !== receipt.before.observedHash) {
        throw new Error("WORKSPACE_ROLLBACK_POSTCONDITION_FAILED: pre-adoption state was not restored");
      }
      const rolledBack: WorkspaceReceipt = {
        ...receipt,
        status: "rolled-back",
        completedAt: (args.now ?? new Date()).toISOString(),
        steps: [...receipt.steps, ...rollbackSteps],
        error: undefined,
        rollbackAfter,
        rollbackObservedHash: rollbackAfter.observedHash,
        leaseChanges: adoptionLeaseChanges(args.plan.operation, true),
      };
      writeReceipt(args.receiptPath, rolledBack);
      return rolledBack;
    } catch (error) {
      let compensationFailed = false;
      for (const item of [...removed].reverse()) {
        const target = safePath(args.commonDir, item.leasePath);
        try {
          if (fileHash(target) !== null) {
            throw new Error("lease path is no longer absent");
          }
          atomicWrite(target, prettyJson(item.lease));
          assertCurrentHash(target, item.afterLeaseHash);
        } catch {
          compensationFailed = true;
        }
      }
      const original = error instanceof Error ? error.message : String(error);
      const failure = compensationFailed
        ? `WORKSPACE_ROLLBACK_UNSAFE: rollback compensation failed: ${original}`
        : original;
      writeReceipt(args.receiptPath, {
        ...receipt,
        status: "applied",
        error: failure,
        compensationStatus: compensationFailed ? "failed" : "completed",
        steps: [
          ...receipt.steps,
          ...rollbackSteps,
          { id: "rollback-adopt", status: "failed", detail: failure },
        ],
      });
      throw new Error(failure);
    }
  } finally {
    releaseLock(lock);
  }
}

export function rollbackWorkspaceChange(args: {
  projectRoot: string;
  changeId: string;
  now?: Date;
}): WorkspaceReceipt {
  const root = repositoryRoot(args.projectRoot);
  const commonDir = gitCommonDir(root);
  const path = receiptFile(commonDir, args.changeId);
  if (!existsSync(path)) throw new Error(`WORKSPACE_RECEIPT_NOT_FOUND: ${args.changeId}`);
  const receipt = readJson<WorkspaceReceipt>(path);
  if (receipt.id !== args.changeId) {
    throw new Error("WORKSPACE_RECEIPT_INVALID: receipt id does not match requested change");
  }
  const planPathValue = planPath(root, receipt.id);
  const plan = loadWorkspacePlan(root, planPathValue);
  if (plan.operation.kind === "adopt") {
    return rollbackWorkspaceAdoption({
      root,
      commonDir,
      receiptPath: path,
      plan: plan as WorkspacePlan & {
        operation: Extract<WorkspacePlan["operation"], { kind: "adopt" }>;
      },
      now: args.now,
    });
  }
  if (receipt.status === "rolled-back") return receipt;
  const status = workspaceStatus(root);
  if (receipt.status !== "applied" || !receipt.after) {
    throw new Error(`WORKSPACE_ROLLBACK_UNAVAILABLE: ${receipt.status}`);
  }
  if (status.observedHash !== receipt.after.observedHash) {
    throw new Error("WORKSPACE_DRIFT: workspace changed after apply");
  }
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
    } else if (plan.operation.kind === "close") {
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
      receipt.leaseChanges = [
        ...(receipt.leaseChanges ?? []),
        {
          action: "restore",
          workItem: plan.operation.lease.workItem,
          path: plan.operation.lease.path,
          branch: plan.operation.lease.branch,
          leasePath: leaseRelativePath(plan.operation.lease.workItem),
          beforeHash: null,
          afterHash: fileHash(leaseFile(status.commonDir, plan.operation.lease.workItem)),
        },
      ];
    } else if (plan.operation.kind === "rebind") {
      throw new Error(
        "WORKSPACE_ROLLBACK_REQUIRES_REBIND_PLAN: lease metadata must be restored with a new exact-hash rebind plan",
      );
    } else if (plan.operation.kind === "renew") {
      assertCurrentHash(
        leaseFile(status.commonDir, plan.operation.lease.workItem),
        plan.operation.afterLeaseHash,
      );
      atomicWrite(
        leaseFile(status.commonDir, plan.operation.lease.workItem),
        prettyJson(plan.operation.lease),
      );
      receipt.steps.push({ id: "rollback-renew", status: "compensated", detail: plan.operation.lease.workItem });
      receipt.leaseChanges = [
        ...(receipt.leaseChanges ?? []),
        {
          action: "update",
          workItem: plan.operation.lease.workItem,
          path: plan.operation.lease.path,
          branch: plan.operation.lease.branch,
          leasePath: leaseRelativePath(plan.operation.lease.workItem),
          beforeHash: plan.operation.afterLeaseHash,
          afterHash: plan.operation.expectedLeaseHash,
        },
      ];
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
  const status = workspaceStatus(args.projectRoot, {
    providerObservation: { kind: "none", configured: false, available: true, items: [] },
  });
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
  const status = workspaceStatus(args.projectRoot, {
    providerObservation: { kind: "none", configured: false, available: true, items: [] },
  });
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
