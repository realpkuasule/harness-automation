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
  renameSync,
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
  type ReviewReceiptScope,
  type WorkspaceAudit,
  type WorkspaceIntegrationCheck,
  type WorkspaceAiDecision,
  type WorkspaceAiReviewResult,
  type WorkspaceBranchCleanup,
  type WorktreeApprovalPolicy,
  type WorktreeContainerTopology,
  type WorktreeDelegatableOperation,
  type WorktreeHostBinding,
  type WorktreeHostBindingObservation,
  type WorkspaceLease,
  type WorkspaceLeaseChange,
  type WorkspacePlan,
  type WorkspacePolicyResult,
  type WorkspaceReceipt,
  type WorkspaceStatus,
  type WorkspaceTopology,
  WORKTREE_DELEGATABLE_OPERATIONS,
} from "./types.js";
import { commandJson, observeProvider } from "./provider.js";
import {
  HOST_BINDING_PATH,
  loadWorktreeConfig,
  loadWorktreeHostBinding,
  validWorktreeConfig as validConfig,
  validWorktreeHostBinding as validHostBinding,
  worktreeHostBindingFile as hostBindingFile,
} from "./config.js";
import { runGit, runGitCommand, runGitToFile } from "../repository/git.js";
export { githubEndpointRepository, remotePushEndpoint, remoteRefHead } from "../repository/remote.js";
import { githubEndpointRepository, remotePushEndpoint, remoteRefHead } from "../repository/remote.js";

function git(cwd: string, args: string[], allowFailure = false): string {
  return runGit(cwd, args, { allowFailure });
}

function gitCommand(cwd: string, args: string[], env: NodeJS.ProcessEnv): {
  status: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
} {
  return runGitCommand(cwd, args, env);
}

function removeTemporaryTree(path: string): void {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const target = join(path, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) removeTemporaryTree(target);
    else unlinkSync(target);
  }
  rmdirSync(path);
}

function gitDirtyPatch(cwd: string, args: string[], allowFailure = false): {
  size: number;
  sha256: string;
} {
  const path = join(tmpdir(), `harness-dirty-patch-${process.pid}-${randomUUID()}`);
  const output = openSync(path, "wx+");
  try {
    if (runGitToFile(cwd, args, output, allowFailure) !== 0) return { size: 0, sha256: sha256("") };

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
  return canonicalPath(root);
}

function canonicalPath(path: string): string {
  if (!isAbsolute(path)) throw new Error(`WORKTREE_PATH_MUST_BE_ABSOLUTE: ${path}`);
  const absolute = resolve(path);
  let existing = absolute;
  const missing: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) throw new Error(`WORKTREE_PATH_UNRESOLVABLE: ${path}`);
    missing.unshift(basename(existing));
    existing = parent;
  }
  if (!lstatSync(existing).isDirectory() && missing.length > 0) {
    throw new Error(`WORKTREE_PATH_PARENT_NOT_DIRECTORY: ${existing}`);
  }
  return join(realpathSync.native(existing), ...missing);
}

function samePath(left: string, right: string): boolean {
  return canonicalPath(left) === canonicalPath(right);
}

function rejectTraversal(path: string): void {
  if (/(^|[\\/])\.\.([\\/]|$)/u.test(path)) {
    throw new Error(`WORKTREE_PATH_TRAVERSAL: ${path}`);
  }
}

function directoryState(path: string): "absent" | "empty" | "non-empty" {
  if (!existsSync(path)) return "absent";
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`WORKTREE_PATH_INVALID: ${path}`);
  }
  return readdirSync(path).length === 0 ? "empty" : "non-empty";
}

function containerTopology(
  root: string,
  commonDir: string,
  workspaceContainer: string,
  managementBranch: string | undefined,
  records: WorktreeRecord[],
  requireEmptyRoot = false,
): WorktreeContainerTopology {
  rejectTraversal(workspaceContainer);
  const container = canonicalPath(workspaceContainer);
  if (container === resolve("/")) throw new Error("WORKTREE_CONTAINER_INVALID: root is not allowed");
  if (!lstatSync(container).isDirectory()) throw new Error(`WORKTREE_CONTAINER_INVALID: ${container}`);
  if (git(container, ["rev-parse", "--show-toplevel"], true).trim()) {
    throw new Error(`WORKTREE_CONTAINER_GIT_ROOT: ${container}`);
  }
  const managementCheckout = canonicalPath(join(container, "main"));
  if (!samePath(root, managementCheckout)) {
    throw new Error(`WORKTREE_MANAGEMENT_CHECKOUT_REQUIRED: expected ${managementCheckout}, observed ${root}`);
  }
  const management = records.find((record) => samePath(record.path, root));
  if (!management || management.bare || management.detached ||
      (managementBranch && management.branch !== managementBranch)) {
    throw new Error("WORKTREE_MANAGEMENT_CHECKOUT_INVALID");
  }
  const persistentWorktreeRoot = canonicalPath(join(container, "worktrees"));
  const state = directoryState(persistentWorktreeRoot);
  if (requireEmptyRoot && state === "non-empty") {
    throw new Error(`WORKTREE_ALLOWED_ROOT_NOT_EMPTY: ${persistentWorktreeRoot}`);
  }
  if (samePath(persistentWorktreeRoot, managementCheckout) ||
      isSameOrWithin(managementCheckout, persistentWorktreeRoot)) {
    throw new Error(`WORKTREE_ALLOWED_ROOT_INVALID: ${persistentWorktreeRoot}`);
  }
  if (samePath(commonDir, persistentWorktreeRoot) || isSameOrWithin(persistentWorktreeRoot, commonDir)) {
    throw new Error(`WORKTREE_ALLOWED_ROOT_INVALID: ${persistentWorktreeRoot}`);
  }
  return { kind: "container-v1", workspaceContainer: container, managementCheckout, persistentWorktreeRoot };
}

function gitCommonDir(root: string): string {
  const commonDir = git(root, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]).trim();
  if (!isAbsolute(commonDir)) throw new Error(`GIT_COMMON_DIR_INVALID: ${commonDir}`);
  return canonicalPath(commonDir);
}

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

export function loadConfig(root: string): {
  configured: boolean;
  config: WorktreeDeliveryConfig;
  legacyBinding?: WorktreeHostBinding;
} {
  return loadWorktreeConfig(root);
}

function loadHostBinding(
  root: string,
  commonDir: string,
  legacyBinding?: WorktreeHostBinding,
): WorktreeHostBindingObservation {
  return loadWorktreeHostBinding(root, commonDir, legacyBinding);
}

function observedTopology(
  root: string,
  commonDir: string,
  config: WorktreeDeliveryConfig,
  binding: WorktreeHostBinding,
  records: WorktreeRecord[],
): WorkspaceTopology {
  if (binding.topology) {
    const topology = containerTopology(
      root,
      commonDir,
      binding.topology.workspaceContainer,
      config.managementBranch,
      records,
    );
    if (
      topology.managementCheckout !== binding.topology.managementCheckout ||
      topology.persistentWorktreeRoot !== binding.topology.persistentWorktreeRoot ||
      binding.allowedRoots.length !== 1 ||
      !samePath(binding.allowedRoots[0], topology.persistentWorktreeRoot) ||
      !binding.protectedRoots.some((path) => samePath(path, topology.managementCheckout)) ||
      !binding.protectedRoots.some((path) => samePath(path, commonDir))
    ) {
      throw new Error("WORKTREE_TOPOLOGY_INVALID: host binding paths drifted");
    }
    return {
      ...topology,
      allowedRoots: binding.allowedRoots,
      protectedRoots: binding.protectedRoots,
      commonDir,
      worktreeTopLevels: records.filter((record) => !record.bare && !record.prunable)
        .map((record) => canonicalPath(record.path)).sort(),
    };
  }
  return {
    kind: "legacy-flat",
    managementCheckout: root,
    allowedRoots: binding.allowedRoots,
    protectedRoots: binding.protectedRoots,
    commonDir,
    worktreeTopLevels: records.filter((record) => !record.bare && !record.prunable)
      .map((record) => canonicalPath(record.path)).sort(),
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
  return git(root, [
    "--no-optional-locks",
    "-C",
    worktreePath,
    "status",
    "--porcelain=v1",
    "-z",
    ...(adoptionSafe ? ["--untracked-files=all"] : []),
  ], !adoptionSafe)
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
    : ["--no-optional-locks", "-C", worktreePath, "diff", "--binary", "--no-ext-diff", "HEAD", "--"],
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
  const path = canonicalPath(record.path);
  const gitTopLevel = canonicalPath(git(root, ["-C", record.path, "rev-parse", "--show-toplevel"]).trim());
  if (!samePath(record.path, gitTopLevel)) {
    throw new Error(`WORKTREE_TOPLEVEL_MISMATCH: ${record.path}`);
  }
  const tokens = worktreeStatusTokens(root, record.path, adoptionSafe);
  const dirty = tokens.length > 0;
  const otherRefs = record.branch
    ? refs.filter((ref) => ref !== `refs/heads/${record.branch}`)
    : refs;
  return {
    ...record,
    path,
    gitTopLevel,
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
  const topology = observedTopology(root, commonDir, loadedConfig.config, hostBinding, observedWorktrees);
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
    ...(loadedConfig.configured && hostBinding.topology &&
      directoryState(hostBinding.topology.persistentWorktreeRoot) === "absent"
      ? [`WORKTREE_ALLOWED_ROOT_MISSING: ${hostBinding.topology.persistentWorktreeRoot}`]
      : []),
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
    topology,
    allowedRootState: hostBinding.topology
      ? directoryState(hostBinding.topology.persistentWorktreeRoot)
      : undefined,
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
    topology,
    capacity: {
      limit: loadedConfig.config.maxPersistentWorktrees,
      used: loadedLeases.values.length,
      available: Math.max(0, loadedConfig.config.maxPersistentWorktrees - loadedLeases.values.length),
    },
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
  const incompleteMigrations = stateJsonFiles(status.commonDir, "receipts").flatMap(({ path }) => {
    try {
      const receipt = readJson<WorkspaceReceipt>(path);
      return receipt.operation === "migrate" && (receipt.status === "started" || receipt.status === "failed")
        ? [`${receipt.id}: ${receipt.status}: ${path}`]
        : [];
    } catch {
      return [`invalid receipt: ${path}`];
    }
  });
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
  const topologyErrors = status.topology.kind === "container-v1"
    ? [
        ...(managementPath && !samePath(managementPath, status.topology.managementCheckout)
          ? [`management checkout must be ${status.topology.managementCheckout}`]
          : []),
        ...status.leases.flatMap((lease) =>
          dirname(lease.path) !== status.topology.persistentWorktreeRoot
            ? [`${lease.workItem}: not a direct child of ${status.topology.persistentWorktreeRoot}`]
            : []),
      ]
    : [];
  const mappingErrors = [
    ...managementErrors,
    ...leaseMappingErrors,
    ...orphanWorktrees,
    ...projectMappingErrors,
    ...topologyErrors,
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
  add(result(status, "workspace.cleanup-receipt", incompleteMigrations.length === 0,
    incompleteMigrations.length === 0
      ? "Persistent lifecycle changes require a durable receipt."
      : "An interrupted migration requires explicit recovery with its exact plan hash.",
    incompleteMigrations));
  add(result(status, "workspace.remote-delete-disabled", true,
    status.config.remoteBranchDeletion
      ? "Merged branch cleanup is enabled; the legacy policy ID is retained for API compatibility."
      : "Merged branch cleanup is disabled by explicit compatibility configuration."));
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
    topology: status.topology,
    capacity: status.capacity,
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

function aiDecisionFile(commonDir: string, id: string): string {
  return safePath(commonDir, `harness/worktree-delivery/ai-decisions/${id}.json`);
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

function workItemId(workItem: string): string {
  const value = workItem.trim();
  const separator = Math.max(value.lastIndexOf("#"), value.lastIndexOf(":"));
  const id = separator === -1 ? "" : value.slice(separator + 1);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(id) || id === "." || id === "..") {
    throw new Error(`WORK_ITEM_ID_INVALID: ${workItem}`);
  }
  return id;
}

function branchContainsWorkItemId(branch: string, id: string): boolean {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:^|[/._-])${escaped}(?=$|[/._-])`, "u").test(branch);
}

function validateTarget(binding: WorktreeHostBinding, target: string): string {
  if (!isAbsolute(target)) throw new Error("WORKTREE_PATH_MUST_BE_ABSOLUTE");
  rejectTraversal(target);
  const resolved = canonicalPath(target);
  if (resolved === resolve("/") || basename(resolved) === ".git") {
    throw new Error(`WORKTREE_PATH_INVALID: ${resolved}`);
  }
  if (protectedPath(binding, resolved)) {
    throw new Error(`WORKTREE_PROTECTED_PATH: ${resolved}`);
  }
  if (
    binding.allowedRoots.length === 0 ||
    !binding.allowedRoots.some((allowedRoot) => isSameOrWithin(allowedRoot, resolved))
  ) {
    throw new Error(`WORKTREE_PATH_NOT_ALLOWED: ${resolved}`);
  }
  if (binding.topology && (
    dirname(resolved) !== binding.topology.persistentWorktreeRoot ||
    samePath(resolved, binding.topology.managementCheckout)
  )) {
    throw new Error(`WORKTREE_TOPOLOGY_TARGET_INVALID: ${resolved}`);
  }
  return resolved;
}

function requireHostBinding(status: WorkspaceStatus): void {
  if (status.hostBinding.configured) return;
  throw new Error(status.hostBinding.source === "legacy-config"
    ? "WORKTREE_HOST_BINDING_MIGRATION_REQUIRED"
    : "WORKTREE_HOST_BINDING_REQUIRED");
}

function survivingManagementCheckout(status: WorkspaceStatus, removedPath: string): string {
  const branch = status.config.managementBranch;
  const matches = branch
    ? status.worktrees.filter((worktree) =>
      !worktree.bare && !worktree.prunable && !worktree.detached &&
      worktree.branch === branch && !samePath(worktree.path, removedPath))
    : [];
  if (matches.length !== 1 || !existsSync(matches[0].path)) {
    throw new Error("WORKTREE_CLOSE_MANAGEMENT_CHECKOUT_REQUIRED");
  }
  return matches[0].path;
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
  remoteBranchDeletion?: boolean;
  allowedRoots?: string[];
  protectedRoots?: string[];
  topology?: "container-v1";
  workspaceContainer?: string;
  approval?: WorktreeApprovalPolicy;
  provider?: WorktreeDeliveryConfig["provider"];
  providerObservation?: ProviderObservation;
  now?: Date;
}): { plan: WorkspacePlan; path: string } {
  const status = workspaceStatus(args.projectRoot, { providerObservation: args.providerObservation });
  if (args.topology && args.topology !== "container-v1") {
    throw new Error("WORKTREE_TOPOLOGY_INVALID: choose container-v1");
  }
  const containerRequested = args.topology === "container-v1" || args.workspaceContainer !== undefined;
  if (containerRequested && !args.workspaceContainer) {
    throw new Error("WORKTREE_CONTAINER_REQUIRED");
  }
  const config = validConfig({
    ...status.config,
    mode: args.mode ?? status.config.mode,
    managementBranch: args.managementBranch ?? status.config.managementBranch,
    maxPersistentWorktrees: args.maxPersistentWorktrees ?? status.config.maxPersistentWorktrees,
    leaseTtlHours: args.leaseTtlHours ?? status.config.leaseTtlHours,
    reviewTtlMinutes: args.reviewTtlMinutes ?? status.config.reviewTtlMinutes,
    remoteBranchRetentionDays:
      args.remoteBranchRetentionDays ?? status.config.remoteBranchRetentionDays,
    remoteBranchDeletion: args.remoteBranchDeletion ?? status.config.remoteBranchDeletion,
    provider: args.provider ?? status.config.provider,
  });
  if (config.remoteBranchDeletion && !config.managementBranch) {
    throw new Error("WORKTREE_MANAGEMENT_BRANCH_REQUIRED");
  }
  let hostBinding: WorktreeHostBinding;
  let topology: WorkspaceTopology;
  let allowedRoot: Extract<WorkspacePlan["operation"], { kind: "configure" }>["allowedRoot"];
  if (containerRequested) {
    if (args.allowedRoots || args.protectedRoots) {
      throw new Error("WORKTREE_CONTAINER_TOPOLOGY_PATHS_DERIVED");
    }
    const managementBranch = config.managementBranch;
    if (!managementBranch) throw new Error("WORKTREE_MANAGEMENT_BRANCH_REQUIRED");
    const existingTopology = status.hostBinding.topology;
    const candidate = containerTopology(
      status.projectDir,
      status.commonDir,
      args.workspaceContainer!,
      managementBranch,
      status.worktrees,
      !existingTopology || !samePath(existingTopology.persistentWorktreeRoot,
        canonicalPath(join(canonicalPath(args.workspaceContainer!), "worktrees"))),
    );
    const rootState = directoryState(candidate.persistentWorktreeRoot);
    hostBinding = validHostBinding({
      schemaVersion: WORKTREE_SCHEMA_VERSION,
      allowedRoots: [candidate.persistentWorktreeRoot],
      protectedRoots: [status.projectDir, status.commonDir, resolve("/")].map(canonicalPath),
      topology: candidate,
      approval: args.approval ?? status.hostBinding.approval,
    });
    topology = {
      ...candidate,
      allowedRoots: hostBinding.allowedRoots,
      protectedRoots: hostBinding.protectedRoots,
      commonDir: status.commonDir,
      worktreeTopLevels: status.worktrees.filter((worktree) => !worktree.bare && !worktree.prunable)
        .map((worktree) => canonicalPath(worktree.path)).sort(),
    };
    allowedRoot = rootState === "absent"
      ? { path: candidate.persistentWorktreeRoot, before: "absent" }
      : rootState === "empty"
        ? { path: candidate.persistentWorktreeRoot, before: "empty" }
        : undefined;
  } else {
    hostBinding = validHostBinding({
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
      topology: status.hostBinding.topology,
      approval: args.approval ?? status.hostBinding.approval,
    });
    topology = status.topology;
  }
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
    topology,
    ...(args.providerObservation ? {
      providerObservationBound: true as const,
      providerObservation: args.providerObservation,
    } : {}),
    ...(allowedRoot ? { allowedRoot } : {}),
  };
  return savePlan(status.projectDir, planDraft({ status, operation, now: args.now }));
}

function migrationTargetTopology(root: string, workspaceContainer: string): WorkspaceTopology {
  rejectTraversal(workspaceContainer);
  const container = canonicalPath(workspaceContainer);
  if (container === resolve("/") || isSameOrWithin(container, root) || isSameOrWithin(root, container)) {
    throw new Error(`WORKTREE_MIGRATION_CONTAINER_INVALID: ${container}`);
  }
  const containerState = directoryState(container);
  if (containerState !== "absent" && containerState !== "empty") {
    throw new Error(`WORKTREE_MIGRATION_CONTAINER_INVALID: ${container}`);
  }
  if (containerState !== "absent") {
    if (!lstatSync(container).isDirectory() || lstatSync(container).isSymbolicLink() ||
        git(container, ["rev-parse", "--show-toplevel"], true).trim()) {
      throw new Error(`WORKTREE_MIGRATION_CONTAINER_INVALID: ${container}`);
    }
  }
  if (!existsSync(dirname(container)) || !lstatSync(dirname(container)).isDirectory()) {
    throw new Error(`WORKTREE_MIGRATION_CONTAINER_INVALID: ${container}`);
  }
  if (git(dirname(container), ["rev-parse", "--show-toplevel"], true).trim()) {
    throw new Error(`WORKTREE_MIGRATION_CONTAINER_GIT_PARENT: ${container}`);
  }
  const managementCheckout = canonicalPath(join(container, "main"));
  const persistentWorktreeRoot = canonicalPath(join(container, "worktrees"));
  if (existsSync(managementCheckout) || existsSync(persistentWorktreeRoot)) {
    throw new Error(`WORKTREE_MIGRATION_TARGET_EXISTS: ${container}`);
  }
  const targetCommonDir = canonicalPath(join(managementCheckout, ".git"));
  return {
    kind: "container-v1",
    workspaceContainer: container,
    managementCheckout,
    persistentWorktreeRoot,
    allowedRoots: [persistentWorktreeRoot],
    protectedRoots: [managementCheckout, targetCommonDir, resolve("/")].map(canonicalPath),
    commonDir: targetCommonDir,
    worktreeTopLevels: [],
  };
}

function migrationOperation(status: WorkspaceStatus, workspaceContainer: string): Extract<WorkspacePlan["operation"], { kind: "migrate" }> {
  if (!status.configured || !status.hostBinding.configured) {
    throw new Error("WORKTREE_MIGRATION_CONFIGURATION_REQUIRED");
  }
  if (status.hostBinding.topology) throw new Error("WORKTREE_MIGRATION_NOT_LEGACY_FLAT");
  if (!status.config.managementBranch) throw new Error("WORKTREE_MANAGEMENT_BRANCH_REQUIRED");
  const management = status.worktrees.filter((worktree) =>
    !worktree.bare && !worktree.prunable && worktree.branch === status.config.managementBranch);
  if (management.length !== 1 || status.worktrees.length !== 1 || !samePath(management[0].path, status.projectDir) ||
      management[0].detached || !samePath(status.commonDir, join(status.projectDir, ".git"))) {
    throw new Error("WORKTREE_MIGRATION_V1_PRECONDITION_FAILED: require one primary legacy management checkout and zero persistent worktrees");
  }
  const commonMetadata = lstatSync(status.commonDir);
  if (!commonMetadata.isDirectory() || commonMetadata.isSymbolicLink()) {
    throw new Error("WORKTREE_MIGRATION_V1_PRECONDITION_FAILED: management common-dir must be a real .git directory");
  }
  const leaseHashes = leaseStateObservation(status.commonDir);
  if (status.leases.length !== 0 || leaseHashes.length !== 0 ||
      status.errors.some((error) => error.startsWith("WORKTREE_LEASE_") || error.startsWith("WORKTREE_STATE_"))) {
    throw new Error("WORKTREE_MIGRATION_V1_PRECONDITION_FAILED: persistent leases require a later migration capability");
  }
  const topology = migrationTargetTopology(status.projectDir, workspaceContainer);
  if (statSync(status.projectDir).dev !== statSync(dirname(topology.workspaceContainer!)).dev) {
    throw new Error("WORKTREE_MIGRATION_CROSS_DEVICE_UNSUPPORTED");
  }
  const afterBinding = validHostBinding({
    schemaVersion: WORKTREE_SCHEMA_VERSION,
    allowedRoots: [topology.persistentWorktreeRoot!],
    protectedRoots: topology.protectedRoots,
    topology: {
      kind: "container-v1",
      workspaceContainer: topology.workspaceContainer!,
      managementCheckout: topology.managementCheckout,
      persistentWorktreeRoot: topology.persistentWorktreeRoot!,
    },
    approval: status.hostBinding.approval,
  });
  const worktreeRecords = status.worktrees.map((worktree) => ({
    path: canonicalPath(worktree.path),
    branch: worktree.branch,
    head: worktree.head,
    dirty: Boolean(worktree.dirty),
    dirtyEvidence: worktree.dirtyEvidence ?? [],
    dirtyPatch: worktree.dirtyPatch ?? { size: 0, sha256: sha256("") },
    uniqueCommits: worktree.uniqueCommits ?? 0,
    unpushedCommits: worktree.unpushedCommits ?? 0,
  })).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const referencePaths = [
    ...status.hostBinding.allowedRoots,
    ...status.hostBinding.protectedRoots,
    ...status.leases.map((lease) => lease.path),
    ...worktreeRecords.map((worktree) => worktree.path),
  ].map(canonicalPath).sort();
  return {
    kind: "migrate",
    topology,
    preflight: {
      configHash: fileHash(join(status.projectDir, ".harness", "worktree-delivery.json")) ?? "",
      hostBindingHash: status.hostBinding.hash,
      afterHostBindingHash: sha256(prettyJson(afterBinding)),
      afterHostBindingContent: prettyJson(afterBinding),
      refsHash: hashObject(refsObservation(status.projectDir)),
      worktreeRegistrationHash: hashObject(worktreeRegistrationObservation(status.worktrees)),
      leaseHashes: leaseHashes.map((lease) => ({ path: lease.leasePath, sha256: lease.sha256 })),
      referencePaths,
      managementCheckout: status.projectDir,
      commonDir: status.commonDir,
      targetContainerState: directoryState(topology.workspaceContainer!) as "absent" | "empty",
      targetMainState: "absent",
      targetWorktreesState: "absent",
      leases: [],
      worktrees: worktreeRecords,
    },
    manualSteps: [
      `Run only \`worktree migrate apply\` with this plan's exact SHA-256 to move ${status.projectDir} to ${topology.managementCheckout}.`,
      `The executor creates only ${topology.workspaceContainer} and ${topology.persistentWorktreeRoot}, then writes the container-v1 host binding.`,
      "Rollback is deliberately unavailable after a directory migration; inspect the durable receipt if execution is interrupted.",
    ],
  };
}

export function planWorkspaceMigration(args: {
  projectRoot: string;
  workspaceContainer: string;
  now?: Date;
}): { plan: WorkspacePlan; path: string } {
  const status = workspaceStatus(args.projectRoot);
  const operation = migrationOperation(status, args.workspaceContainer);
  return savePlan(status.projectDir, planDraft({
    status,
    operation,
    now: args.now,
    warnings: ["Migration planning is read-only. Only the explicit worktree migrate apply command can execute an exactly approved plan."],
  }));
}

function managementRoot(projectRoot: string): string {
  const root = repositoryRoot(projectRoot);
  const records = worktrees(root).filter((record) => !record.bare && !record.prunable && !record.detached);
  const branches = [...new Set(records.flatMap((record) => {
    try {
      const loaded = loadConfig(record.path);
      return loaded.configured && loaded.config.managementBranch ? [loaded.config.managementBranch] : [];
    } catch {
      return [];
    }
  }))];
  if (branches.length === 0) return root;
  if (branches.length !== 1) throw new Error("WORKTREE_MANAGEMENT_CHECKOUT_INVALID");
  const matches = records.filter((record) => record.branch === branches[0]);
  if (matches.length !== 1) throw new Error("WORKTREE_MANAGEMENT_CHECKOUT_INVALID");
  return canonicalPath(matches[0].path);
}

function localTarget(root: string, target: string): { ref: string; head: string } {
  const ref = git(root, ["rev-parse", "--symbolic-full-name", "--verify", target], true).trim();
  if (!ref.startsWith("refs/heads/") && !ref.startsWith("refs/tags/")) {
    throw new Error(`WORKTREE_INTEGRATION_TARGET_UNAVAILABLE: ${target}`);
  }
  const head = git(root, ["rev-parse", "--verify", `${ref}^{commit}`], true).trim();
  if (!/^[0-9a-f]{40,64}$/u.test(head)) {
    throw new Error(`WORKTREE_INTEGRATION_TARGET_UNAVAILABLE: ${target}`);
  }
  return { ref: target, head };
}

export function integrationCheckWorkspace(args: {
  projectRoot: string;
  workItem: string;
  target?: string;
  temporaryRootParent?: string;
  cleanupTemporaryTree?: (path: string) => void;
}): WorkspaceIntegrationCheck {
  const root = managementRoot(args.projectRoot);
  const status = workspaceStatus(root, {
    providerObservation: { kind: "none", configured: false, available: true, items: [] },
  });
  if (!status.configured || status.config.mode !== "enforced" || !status.hostBinding.configured || status.errors.length > 0) {
    throw new Error(`WORKTREE_INTEGRATION_PRECONDITION_FAILED: ${status.errors.join(", ") || `configured=${status.configured}, mode=${status.config.mode}, binding=${status.hostBinding.configured}`}`);
  }
  const workItem = args.workItem.trim();
  const id = workItemId(workItem);
  const matchingLeases = status.leases.filter((lease) => lease.workItem === workItem);
  if (matchingLeases.length === 0) throw new Error(`WORKTREE_LEASE_NOT_FOUND: ${workItem}`);
  if (matchingLeases.length !== 1) throw new Error(`DUPLICATE_WORK_ITEM_LEASE: ${workItem}`);
  const lease = matchingLeases[0];
  const matchingWorktrees = status.worktrees.filter((record) => samePath(record.path, lease.path));
  if (matchingWorktrees.length !== 1) throw new Error(`WORKTREE_NOT_FOUND: ${lease.path}`);
  const source = matchingWorktrees[0];
  if (source.bare || source.detached || source.locked || source.prunable || source.branch !== lease.branch ||
      !source.gitTopLevel || !samePath(source.gitTopLevel, lease.path) ||
      (status.topology.kind === "container-v1" && dirname(lease.path) !== status.topology.persistentWorktreeRoot)) {
    throw new Error(`WORKTREE_INTEGRATION_PRECONDITION_FAILED: ${workItem} lease/worktree mapping drifted`);
  }
  const sourceHead = git(source.path, ["--no-optional-locks", "rev-parse", "--verify", "HEAD^{commit}"], true).trim();
  if (sourceHead !== source.head) {
    throw new Error(`WORKTREE_INTEGRATION_PRECONDITION_FAILED: ${workItem} HEAD drifted`);
  }
  const targetRef = args.target ?? status.config.managementBranch;
  if (!targetRef) throw new Error("WORKTREE_INTEGRATION_TARGET_UNAVAILABLE: management branch is required");
  const target = localTarget(root, targetRef);
  const mergeBase = git(root, ["merge-base", target.head, sourceHead], true).trim();
  if (!/^[0-9a-f]{40,64}$/u.test(mergeBase)) {
    throw new Error(`WORKTREE_INTEGRATION_TARGET_UNAVAILABLE: no merge-base for ${targetRef}`);
  }
  const ahead = commitCount(root, [`${target.head}..${sourceHead}`]);
  const behind = commitCount(root, [`${sourceHead}..${target.head}`]);
  const currentConflicts = (source.dirtyEvidence ?? [])
    .filter((entry) => ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(entry.status))
    .map(({ path, status: conflictStatus }) => ({ path, status: conflictStatus }));
  const temporaryRoot = mkdtempSync(join(args.temporaryRootParent ?? tmpdir(), "harness-integration-"));
  const objectDirectory = join(temporaryRoot, "objects");
  mkdirSync(objectDirectory);
  let command: ReturnType<typeof gitCommand> | undefined;
  try {
    command = gitCommand(root, [
      "--no-optional-locks",
      "merge-tree",
      "--write-tree",
      "--name-only",
      "-z",
      target.head,
      sourceHead,
    ], {
      ...process.env,
      GIT_OBJECT_DIRECTORY: objectDirectory,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: realpathSync.native(join(status.commonDir, "objects")),
      GIT_OPTIONAL_LOCKS: "0",
    });
    if (command.error || (command.status !== 0 && command.status !== 1)) {
      throw new Error(
        `WORKTREE_INTEGRATION_GIT_FAILED: exit=${command.status ?? "spawn"}; stdout=${command.stdout}; stderr=${command.stderr}; error=${command.error ?? ""}`,
      );
    }
    const conflictingPaths = [...new Set(command.stdout.split("\0").flatMap((token) => {
      const value = token.trim();
      const explicit = /^Auto-merging (.+)$/u.exec(value)?.[1] ??
        /\b(?:in|for) ([^\n]+)$/u.exec(value)?.[1];
      if (explicit) return [explicit];
      const candidate = join(root, value);
      return value && !value.includes("\n") && !value.includes("\0") &&
        !/^(?:\d+|[0-9a-f]{40,64}|CONFLICT \(.+\))$/u.test(value) &&
        !relative(root, candidate).startsWith("..") && existsSync(candidate)
        ? [value]
        : [];
    }))].sort();
    const blockers: WorkspaceIntegrationCheck["blockers"] = [];
    if (source.dirty && currentConflicts.length === 0) {
      blockers.push({ code: "WORKTREE_INTEGRATION_DIRTY", detail: `${source.path} has uncommitted changes` });
    }
    if (currentConflicts.length > 0) {
      blockers.push({ code: "WORKTREE_INTEGRATION_CONFLICTED", detail: `${source.path} has unresolved conflicts` });
    }
    if ((source.unpushedCommits ?? 0) > 0) {
      blockers.push({ code: "WORKTREE_INTEGRATION_UNPUSHED", detail: `${source.unpushedCommits} source commits are not in a remote ref` });
    }
    if (command.status === 1 || conflictingPaths.length > 0) {
      blockers.push({ code: "WORKTREE_INTEGRATION_MERGE_CONFLICT", detail: conflictingPaths.join(", ") || "git merge-tree reported a conflict" });
    }
    const warnings: WorkspaceIntegrationCheck["warnings"] = behind > 0
      ? [{ code: "WORKTREE_INTEGRATION_BEHIND", detail: `${source.path} is behind ${targetRef} by ${behind} commits` }]
      : [];
    const check: WorkspaceIntegrationCheck = {
      schemaVersion: "worktree-integration-check/1.0",
      projectDir: status.projectDir,
      commonDir: status.commonDir,
      workItem,
      workItemId: id,
      source: { path: source.path, branch: lease.branch, head: sourceHead, unpushedCommits: source.unpushedCommits ?? 0 },
      target: { ref: targetRef, head: target.head, source: args.target ? "explicit-local-ref" : "management-branch" },
      mergeBase,
      ahead,
      behind,
      clean: !source.dirty,
      currentConflicts,
      mergeable: command.status === 0,
      conflictingPaths,
      blockers,
      warnings,
      status: blockers.length > 0 ? "blocked" : warnings.length > 0 ? "warning" : "ready",
      passing: blockers.length === 0,
      observedHash: "",
    };
    check.observedHash = hashObject({ ...check, observedHash: undefined, workspaceObservedHash: status.observedHash });
    return check;
  } finally {
    try {
      (args.cleanupTemporaryTree ?? removeTemporaryTree)(temporaryRoot);
    } catch (error) {
      const diagnostic = command
        ? ` stdout=${command.stdout}; stderr=${command.stderr}; exit=${command.status ?? "spawn"}`
        : "";
      throw new Error(`WORKTREE_INTEGRATION_TEMP_CLEANUP_FAILED: ${temporaryRoot}: ${error instanceof Error ? error.message : String(error)};${diagnostic}`);
    }
  }
}

export function planWorkspaceAllocation(args: {
  projectRoot: string;
  workItem: string;
  branch: string;
  path?: string;
  owner: string;
  thread?: string;
  startPoint?: string;
  now?: Date;
}): { plan: WorkspacePlan; path: string } {
  const workItem = args.workItem.trim();
  if (!workItem) throw new Error("WORK_ITEM_REQUIRED");
  const id = workItemId(workItem);
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
  if (!branchContainsWorkItemId(args.branch, id)) {
    throw new Error(`WORKTREE_BRANCH_ID_REQUIRED: ${id}`);
  }
  const derived = status.topology.kind === "container-v1"
    ? canonicalPath(join(status.topology.persistentWorktreeRoot!, id))
    : undefined;
  if (derived && args.path !== undefined && canonicalPath(args.path) !== derived) {
    throw new Error(`WORKTREE_PATH_ID_MISMATCH: expected ${derived}, observed ${args.path}`);
  }
  if (!derived && !args.path) throw new Error("WORKTREE_PATH_REQUIRED");
  const target = validateTarget(status.hostBinding, derived ?? args.path!);
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

function ignoredPaths(root: string, target: string, excludedPath?: string): string[] {
  return git(root, [
    "-C",
    target,
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "-z",
  ]).split("\0").filter(Boolean).filter((path) =>
    !excludedPath || !samePath(join(target, path), excludedPath)
  ).sort();
}

function gitIsAncestor(root: string, ancestor: string, target: string): boolean {
  const result = gitCommand(root, ["merge-base", "--is-ancestor", ancestor, target], process.env);
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`GIT_COMMAND_FAILED: git merge-base --is-ancestor: ${result.stderr || result.error || "unknown error"}`);
}

function branchConfig(root: string, branch: string): Array<{ key: string; value: string }> {
  const escaped = branch.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return git(root, ["config", "-z", "--get-regexp", `^branch\\.${escaped}\\.`], true)
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf("\n");
      if (separator <= 0) throw new Error(`BRANCH_CONFIG_INVALID: ${branch}`);
      return { key: entry.slice(0, separator), value: entry.slice(separator + 1) };
    });
}

function removeBranchConfig(root: string, branch: string, planned: Array<{ key: string; value: string }>): void {
  if (hashObject(branchConfig(root, branch)) !== hashObject(planned)) {
    throw new Error(`BRANCH_CONFIG_DRIFT: ${branch}`);
  }
  const entries = new Map(planned.map((entry) => [`${entry.key}\0${entry.value}`, entry]));
  for (const entry of entries.values()) {
    const result = gitCommand(root, [
      "config",
      "--fixed-value",
      "--unset-all",
      entry.key,
      entry.value,
    ], process.env);
    if (result.status !== 0) throw new Error(`BRANCH_CONFIG_REMOVE_FAILED: ${branch}`);
  }
  if (branchConfig(root, branch).length !== 0) throw new Error(`BRANCH_CONFIG_DRIFT: ${branch}`);
}

function restoreBranchConfig(
  root: string,
  branch: string,
  planned: Array<{ key: string; value: string }>,
): void {
  const remaining = [...planned];
  for (const entry of branchConfig(root, branch)) {
    const index = remaining.findIndex((candidate) =>
      candidate.key === entry.key && candidate.value === entry.value
    );
    if (index === -1) throw new Error("WORKSPACE_CLOSE_COMPENSATION_UNSAFE: branch config changed");
    remaining.splice(index, 1);
  }
  for (const entry of remaining) git(root, ["config", "--add", entry.key, entry.value]);
}

function branchUpstream(
  root: string,
  branch: string,
): { remote: string; ref: string; config: Array<{ key: string; value: string }> } {
  const config = branchConfig(root, branch);
  const prefix = `branch.${branch}.`;
  const remote = config.filter((entry) => entry.key === `${prefix}remote`).map((entry) => entry.value);
  const merge = config.filter((entry) => entry.key === `${prefix}merge`).map((entry) => entry.value);
  if (remote.length !== 1 || merge.length !== 1 || remote[0] === "." ||
      !merge[0].startsWith("refs/heads/")) {
    throw new Error(`BRANCH_UPSTREAM_REQUIRED: ${branch}`);
  }
  return { remote: remote[0], ref: merge[0], config };
}

function deleteRemoteBranch(
  root: string,
  endpoint: string,
  remote: string,
  ref: string,
  expectedHead: string,
): void {
  const result = gitCommand(root, [
    "push",
    `--force-with-lease=${ref}:${expectedHead}`,
    endpoint,
    `:${ref}`,
  ], process.env);
  if (result.status !== 0) {
    const detail = (result.stderr || result.error || "unknown error").replaceAll(endpoint, "<remote>");
    throw new Error(`REMOTE_BRANCH_DELETE_FAILED: ${remote} ${ref}: ${detail}`);
  }
}

function objectValue(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

function githubMergeProof(
  root: string,
  config: WorktreeDeliveryConfig,
  upstream: { remote: string; ref: string },
  endpoint: string,
  expectedHead: string,
  managementUpstream: { remote: string; ref: string },
  managementEndpoint: string,
): WorkspaceBranchCleanup["proof"] {
  const repository = config.provider.repository;
  if (!repository) throw new Error("GITHUB_MERGE_PROOF_UNAVAILABLE: repository is not configured");
  for (const [remote, value] of [[upstream.remote, endpoint], [managementUpstream.remote, managementEndpoint]]) {
    if (githubEndpointRepository(value, remote).toLowerCase() !== repository.toLowerCase()) {
      throw new Error(`GITHUB_REMOTE_REPOSITORY_MISMATCH: ${remote}`);
    }
  }
  const branch = upstream.ref.slice("refs/heads/".length);
  const managementBranch = managementUpstream.ref.slice("refs/heads/".length);
  const [owner] = repository.split("/", 1);
  const query = new URLSearchParams({
    state: "closed",
    base: managementBranch,
    head: `${owner}:${branch}`,
    per_page: "100",
  });
  const response = commandJson(root, "gh", [
    "api",
    "--method",
    "GET",
    `repos/${repository}/pulls?${query.toString()}`,
  ]);
  if (!response.ok || !Array.isArray(response.value)) {
    throw new Error(`GITHUB_MERGE_PROOF_UNAVAILABLE: ${response.error ?? "invalid response"}`);
  }
  const matches = response.value.filter((candidate) => {
    const head = objectValue(candidate, "head");
    const base = objectValue(candidate, "base");
    return typeof objectValue(candidate, "merged_at") === "string" &&
      objectValue(head, "ref") === branch &&
      objectValue(head, "sha") === expectedHead &&
      objectValue(objectValue(head, "repo"), "full_name") === repository &&
      objectValue(base, "ref") === managementBranch &&
      objectValue(objectValue(base, "repo"), "full_name") === repository;
  });
  if (matches.length !== 1) {
    throw new Error(matches.length === 0
      ? `BRANCH_NOT_MERGED: ${branch} has no exact merged pull request`
      : `GITHUB_MERGE_PROOF_AMBIGUOUS: ${branch}`);
  }
  const number = objectValue(matches[0], "number");
  const mergedAt = objectValue(matches[0], "merged_at");
  if (typeof number !== "number" || typeof mergedAt !== "string") {
    throw new Error("GITHUB_MERGE_PROOF_INVALID");
  }
  return { kind: "github-pr", number, mergedAt };
}

function branchCleanupEvidence(
  status: WorkspaceStatus,
  lease: WorkspaceLease,
  expectedHead: string,
): WorkspaceBranchCleanup {
  const managementBranch = status.config.managementBranch;
  if (!managementBranch) throw new Error("WORKTREE_MANAGEMENT_BRANCH_REQUIRED");
  if (lease.branch === managementBranch) {
    throw new Error(`PROTECTED_BRANCH_CLEANUP: ${lease.branch}`);
  }
  if (status.leases.some((item) => item.workItem !== lease.workItem && item.branch === lease.branch) ||
      status.worktrees.some((item) => item.branch === lease.branch && !samePath(item.path, lease.path))) {
    throw new Error(`BRANCH_CLEANUP_IN_USE: ${lease.branch}`);
  }
  const localRef = `refs/heads/${lease.branch}`;
  const localHead = git(status.projectDir, ["rev-parse", "--verify", `${localRef}^{commit}`]).trim();
  if (localHead !== expectedHead) throw new Error(`LOCAL_BRANCH_DRIFT: ${lease.branch}`);
  const managementHead = git(status.projectDir, [
    "rev-parse",
    "--verify",
    `${managementBranch}^{commit}`,
  ]).trim();
  const upstream = branchUpstream(status.projectDir, lease.branch);
  const managementUpstream = branchUpstream(status.projectDir, managementBranch);
  const endpoint = remotePushEndpoint(status.projectDir, upstream.remote);
  const managementEndpoint = remotePushEndpoint(status.projectDir, managementUpstream.remote);
  const managementRemoteHead = remoteRefHead(
    status.projectDir,
    managementEndpoint.value,
    managementUpstream.remote,
    managementUpstream.ref,
  );
  if (managementRemoteHead !== managementHead) {
    throw new Error(`MANAGEMENT_BRANCH_NOT_CURRENT: local ${managementHead}, remote ${managementRemoteHead ?? "absent"}`);
  }
  const remoteHead = remoteRefHead(status.projectDir, endpoint.value, upstream.remote, upstream.ref);
  if (remoteHead !== null && remoteHead !== expectedHead) {
    throw new Error(`REMOTE_BRANCH_DRIFT: expected ${expectedHead}, observed ${remoteHead}`);
  }
  const proof = gitIsAncestor(status.projectDir, expectedHead, managementHead)
    ? { kind: "ancestry" as const }
    : status.config.provider.kind === "github"
      ? githubMergeProof(
        status.projectDir,
        status.config,
        upstream,
        endpoint.value,
        expectedHead,
        managementUpstream,
        managementEndpoint.value,
      )
      : (() => { throw new Error(`BRANCH_NOT_MERGED: ${lease.branch}`); })();
  return {
    branch: lease.branch,
    localRef,
    expectedHead,
    branchConfig: upstream.config,
    managementBranch,
    managementHead,
    proof,
    remote: {
      name: upstream.remote,
      ref: upstream.ref,
      expectedHead: remoteHead,
      endpointHash: endpoint.hash,
    },
  };
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
  const ignored = ignoredPaths(status.projectDir, lease.path);
  if (ignored.length > 0) {
    throw new Error(`WORKTREE_IGNORED_CONTENT: ${lease.path}: ${JSON.stringify(ignored)}`);
  }
  const branchCleanup = status.config.remoteBranchDeletion
    ? branchCleanupEvidence(status, lease, observed.head)
    : undefined;
  if (!branchCleanup && remoteRefsContaining(status.projectDir, observed.head).length === 0) {
    throw new Error(`UNPUSHED_COMMIT: ${observed.head} has no remote reference`);
  }
  return savePlan(status.projectDir, planDraft({
    status,
    operation: {
      kind: "close",
      lease: { ...lease, acceptedCommit: args.acceptedCommit },
      expectedHead: observed.head,
      expectedLeaseHash: fileHash(leaseFile(status.commonDir, lease.workItem)) ?? "",
      ignoredPathCount: 0,
      ignoredPathsHash: hashObject(ignored),
      branchCleanup,
    },
    now: args.now,
    warnings: branchCleanup
      ? ["Close deletes the exact merged local branch and its matching remote ref using SHA compare-and-swap."]
      : ["Local and remote branches are preserved by explicit compatibility configuration."],
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
      observed.locked || observed.prunable) {
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
  const replacementLease: WorkspaceLease = { ...lease, acceptedCommit: observed.head, heartbeatAt };
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

export function planWorkspaceRecover(args: {
  projectRoot: string;
  path: string;
  now?: Date;
}): { plan: WorkspacePlan; path: string } {
  const status = workspaceStatus(args.projectRoot);
  if (!status.configured || status.config.mode !== "enforced") {
    throw new Error("WORKTREE_ENFORCEMENT_NOT_ENABLED");
  }
  requireHostBinding(status);
  const target = canonicalPath(args.path);
  if (protectedPath(status.hostBinding, target)) {
    throw new Error(`PROTECTED_WORKTREE_PATH: ${target}`);
  }
  const matches = status.worktrees.filter((worktree) => samePath(worktree.path, target));
  if (matches.length !== 1) throw new Error(`WORKTREE_NOT_FOUND: ${target}`);
  const worktree = matches[0];
  if (worktree.dirty) {
    throw new Error(`WORKTREE_DIRTY: ${target}: ${JSON.stringify({
      files: worktree.dirtyEvidence,
      patch: worktree.dirtyPatch,
    })}`);
  }
  if (!worktree.detached || worktree.branch !== null || worktree.bare || worktree.locked || worktree.prunable) {
    throw new Error("WORKTREE_RECOVER_PRECONDITION_FAILED: worktree must be clean and detached");
  }
  if (status.leases.some((lease) => samePath(lease.path, target))) {
    throw new Error(`WORKTREE_RECOVER_LEASED: ${target}`);
  }
  return savePlan(status.projectDir, planDraft({
    status,
    operation: {
      kind: "recover",
      path: target,
      removePath: target,
      expectedHead: worktree.head,
      dirtyEvidence: [],
      dirtyPatch: { size: 0, sha256: sha256("") },
    },
    now: args.now,
    warnings: ["Recovery removes only the exact clean, detached, unleased worktree; branches are preserved."],
  }));
}

function loadWorkspacePlan(root: string, path: string): WorkspacePlan {
  const plan = readJson<WorkspacePlan>(safePath(root, path));
  if (
    plan.schemaVersion !== "worktree-delivery/1.0" ||
    plan.kind !== "workspace-plan" ||
    !["configure", "migrate", "allocate", "adopt", "close", "rebind", "renew", "recover"].includes(plan.operation?.kind) ||
    (plan.operation.kind === "configure" && (
      plan.operation.hostBindingPath !== HOST_BINDING_PATH ||
      typeof plan.operation.beforeHostBindingHash !== "string" &&
        plan.operation.beforeHostBindingHash !== null ||
      typeof plan.operation.afterHostBindingHash !== "string" ||
      typeof plan.operation.hostBindingContent !== "string" ||
      !plan.operation.topology
    ))
  ) {
    throw new Error("WORKSPACE_PLAN_INVALID");
  }
  if (plan.operation.kind === "migrate") {
    const operation = plan.operation;
    if (
      typeof operation.preflight?.configHash !== "string" ||
      typeof operation.preflight.afterHostBindingContent !== "string" ||
      typeof operation.preflight.afterHostBindingHash !== "string" ||
      operation.preflight.targetContainerState === undefined
    ) {
      throw new Error("WORKTREE_MIGRATION_REPLAN_REQUIRED");
    }
    if (
      operation.topology?.kind !== "container-v1" ||
      !isAbsolute(operation.topology.workspaceContainer ?? "") ||
      !isAbsolute(operation.topology.managementCheckout) ||
      !isAbsolute(operation.topology.persistentWorktreeRoot ?? "") ||
      !isAbsolute(operation.topology.commonDir) ||
      typeof operation.preflight?.configHash !== "string" ||
      !/^[a-f0-9]{64}$/u.test(operation.preflight.configHash) ||
      (operation.preflight.hostBindingHash !== null &&
        !/^[a-f0-9]{64}$/u.test(operation.preflight.hostBindingHash)) ||
      !/^[a-f0-9]{64}$/u.test(operation.preflight.afterHostBindingHash ?? "") ||
      typeof operation.preflight.afterHostBindingContent !== "string" ||
      sha256(operation.preflight.afterHostBindingContent) !== operation.preflight.afterHostBindingHash ||
      !/^[a-f0-9]{64}$/u.test(operation.preflight.refsHash ?? "") ||
      !/^[a-f0-9]{64}$/u.test(operation.preflight.worktreeRegistrationHash ?? "") ||
      !Array.isArray(operation.preflight?.leases) ||
      operation.preflight.leases.length !== 0 ||
      !Array.isArray(operation.preflight?.leaseHashes) ||
      operation.preflight.leaseHashes.length !== 0 ||
      !Array.isArray(operation.preflight?.worktrees) ||
      operation.preflight.worktrees.length !== 1 ||
      !Array.isArray(operation.preflight?.referencePaths) ||
      operation.preflight.managementCheckout !== plan.projectDir ||
      operation.preflight.commonDir !== plan.commonDir ||
      !["absent", "empty"].includes(operation.preflight.targetContainerState) ||
      operation.preflight.targetMainState !== "absent" ||
      operation.preflight.targetWorktreesState !== "absent" ||
      !Array.isArray(operation.manualSteps) ||
      operation.manualSteps.length === 0
    ) {
      throw new Error("WORKSPACE_PLAN_INVALID");
    }
    try {
      const container = canonicalPath(operation.topology.workspaceContainer!);
      const management = canonicalPath(join(container, "main"));
      const worktreesRoot = canonicalPath(join(container, "worktrees"));
      const targetCommonDir = canonicalPath(join(management, ".git"));
      const afterBinding = validHostBinding(JSON.parse(operation.preflight.afterHostBindingContent));
      if (
        operation.topology.workspaceContainer !== container ||
        operation.topology.managementCheckout !== management ||
        operation.topology.persistentWorktreeRoot !== worktreesRoot ||
        operation.topology.commonDir !== targetCommonDir ||
        afterBinding.topology?.kind !== "container-v1" ||
        afterBinding.topology.workspaceContainer !== container ||
        afterBinding.topology.managementCheckout !== management ||
        afterBinding.topology.persistentWorktreeRoot !== worktreesRoot ||
        hashObject(afterBinding.allowedRoots) !== hashObject([worktreesRoot]) ||
        hashObject(afterBinding.protectedRoots) !== hashObject([management, targetCommonDir, resolve("/")].map(canonicalPath))
      ) {
        throw new Error("invalid migration topology");
      }
    } catch {
      throw new Error("WORKSPACE_PLAN_INVALID");
    }
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
  if (plan.operation.kind === "close") {
    try {
      const operation = plan.operation;
      validLease(operation.lease, leaseRelativePath(operation.lease.workItem));
      if (
        operation.lease.acceptedCommit !== operation.expectedHead ||
        !/^[a-f0-9]{40,64}$/u.test(operation.expectedHead) ||
        !/^[a-f0-9]{64}$/u.test(operation.expectedLeaseHash) ||
        (operation.ignoredPathCount !== undefined && operation.ignoredPathCount !== 0) ||
        (operation.ignoredPathsHash !== undefined && operation.ignoredPathsHash !== hashObject([]))
      ) {
        throw new Error("invalid close envelope");
      }
      const cleanup = operation.branchCleanup;
      const branchPrefix = cleanup ? `branch.${cleanup.branch}.` : "";
      if (cleanup && (
        cleanup.branch !== operation.lease.branch ||
        cleanup.localRef !== `refs/heads/${operation.lease.branch}` ||
        cleanup.expectedHead !== operation.expectedHead ||
        !Array.isArray(cleanup.branchConfig) || cleanup.branchConfig.length < 2 ||
        cleanup.branchConfig.some((entry) =>
          typeof entry.key !== "string" || typeof entry.value !== "string") ||
        cleanup.managementBranch === operation.lease.branch ||
        !/^[0-9a-f]{40,64}$/u.test(cleanup.managementHead) ||
        cleanup.branchConfig.filter((entry) =>
          entry.key === `${branchPrefix}remote` && entry.value === cleanup.remote.name).length !== 1 ||
        cleanup.branchConfig.filter((entry) =>
          entry.key === `${branchPrefix}merge` && entry.value === cleanup.remote.ref).length !== 1 ||
        (cleanup.remote.expectedHead !== null &&
          cleanup.remote.expectedHead !== operation.expectedHead) ||
        !["ancestry", "github-pr"].includes(cleanup.proof.kind)
      )) {
        throw new Error("invalid branch cleanup evidence");
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
        "workItem", "branch", "path", "owner", "thread", "workItemState", "createdAt", "status",
      ] as const;
      if (
        operation.lease.workItem !== operation.replacementLease.workItem ||
        unchanged.some((key) => operation.lease[key] !== operation.replacementLease[key]) ||
        operation.lease.heartbeatAt === operation.replacementLease.heartbeatAt ||
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
  if (plan.operation.kind === "recover") {
    const operation = plan.operation;
    if (
      !isAbsolute(operation.path) ||
      operation.removePath !== operation.path ||
      !/^[a-f0-9]{40,64}$/u.test(operation.expectedHead) ||
      !Array.isArray(operation.dirtyEvidence) ||
      operation.dirtyEvidence.length !== 0 ||
      operation.dirtyPatch?.size !== 0 ||
      operation.dirtyPatch.sha256 !== sha256("")
    ) {
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

const aiReviewerOutputSchema = z.object({
  verdict: z.enum(["approve", "deny", "abstain"]),
  reasonCodes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/u)).min(1).max(8),
  summary: z.string().trim().min(1).max(1_000),
}).strict();

const aiReviewerJsonSchema = JSON.stringify({
  type: "object",
  additionalProperties: false,
  required: ["verdict", "reasonCodes", "summary"],
  properties: {
    verdict: { enum: ["approve", "deny", "abstain"] },
    reasonCodes: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: { type: "string", pattern: "^[A-Z][A-Z0-9_]{1,63}$" },
    },
    summary: { type: "string", minLength: 1, maxLength: 1_000 },
  },
});

function isDelegatableOperation(kind: WorkspacePlan["operation"]["kind"]):
kind is WorktreeDelegatableOperation {
  return (WORKTREE_DELEGATABLE_OPERATIONS as readonly string[]).includes(kind);
}

function decisionWithoutHash(decision: WorkspaceAiDecision): Omit<WorkspaceAiDecision, "decisionHash"> {
  const body: Partial<WorkspaceAiDecision> = { ...decision };
  delete body.decisionHash;
  return body as Omit<WorkspaceAiDecision, "decisionHash">;
}

function parseReviewerOutput(output: string): z.infer<typeof aiReviewerOutputSchema> {
  const envelope = JSON.parse(output) as Record<string, unknown>;
  let candidate: unknown = envelope.structured_output ?? envelope;
  if (typeof candidate === "string") candidate = JSON.parse(candidate);
  if (candidate === envelope && typeof envelope.result === "string") {
    candidate = JSON.parse(envelope.result);
  }
  return aiReviewerOutputSchema.parse(candidate);
}

function destructiveAiEvidence(root: string, plan: WorkspacePlan): {
  safe: boolean;
  uniqueCommits: number;
  unpushedCommits: number;
  ignoredPathCount: number;
  ignoredPathsHash: string;
} | undefined {
  if (plan.operation.kind !== "close" && plan.operation.kind !== "recover") return undefined;
  const target = plan.operation.kind === "close" ? plan.operation.lease.path : plan.operation.path;
  const record = worktrees(root).find((worktree) => samePath(worktree.path, target));
  if (!record) {
    return {
      safe: false,
      uniqueCommits: 0,
      unpushedCommits: 0,
      ignoredPathCount: 0,
      ignoredPathsHash: hashObject([]),
    };
  }
  const ignored = ignoredPaths(root, target);
  const uniqueCommits = record.uniqueCommits ?? 0;
  const unpushedCommits = record.unpushedCommits ?? 0;
  return {
    safe: !record.dirty && uniqueCommits === 0 && unpushedCommits === 0 && ignored.length === 0,
    uniqueCommits,
    unpushedCommits,
    ignoredPathCount: ignored.length,
    ignoredPathsHash: hashObject(ignored),
  };
}

function runClaudeReviewer(args: {
  plan: WorkspacePlan;
  intent: string;
  policy: Extract<WorktreeApprovalPolicy, { mode: "delegated-ai" }>;
  destructiveEvidence?: ReturnType<typeof destructiveAiEvidence>;
}): z.infer<typeof aiReviewerOutputSchema> {
  const prompt = [
    "You are the independent, read-only authorization reviewer for a Git worktree governance plan.",
    "You have no mutation authority. Decide whether the stated human intent matches the exact canonical plan.",
    "Deterministic safety checks run separately and cannot be waived. APPROVE only when the operation and every target match the intent and delegated policy. DENY contradictions or unsafe intent. ABSTAIN when evidence is insufficient.",
    "Return only the required structured result.",
    prettyJson({
      intent: args.intent,
      delegatedPolicy: args.policy,
      destructiveEvidence: args.destructiveEvidence,
      plan: args.plan,
    }),
  ].join("\n\n");
  const isolatedCwd = mkdtempSync(join(tmpdir(), "harness-ai-reviewer-"));
  try {
    const result = spawnSync("claude", [
      "--print",
      "--safe-mode",
      "--no-session-persistence",
      "--tools",
      "",
      "--permission-mode",
      "plan",
      "--output-format",
      "json",
      "--json-schema",
      aiReviewerJsonSchema,
      "--model",
      args.policy.reviewer.model,
    ], {
      cwd: isolatedCwd,
      encoding: "utf8",
      input: prompt,
      timeout: args.policy.reviewerTimeoutSeconds * 1_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, CI: "1" },
      shell: process.platform === "win32",
    });
    if (result.error || result.status !== 0) {
      const detail = `${result.stderr ?? result.stdout ?? result.error ?? ""}`.trim().slice(-2_000);
      throw new Error(`WORKSPACE_AI_REVIEWER_FAILED: ${detail}`);
    }
    try {
      return parseReviewerOutput(result.stdout);
    } catch (error) {
      throw new Error(
        `WORKSPACE_AI_REVIEWER_INVALID: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } finally {
    rmdirSync(isolatedCwd);
  }
}

function buildAiDecision(args: {
  plan: WorkspacePlan;
  intent: string;
  policy: Extract<WorktreeApprovalPolicy, { mode: "delegated-ai" }>;
  verdict: WorkspaceAiDecision["verdict"];
  reasonCodes: string[];
  summary: string;
  now: Date;
}): WorkspaceAiDecision {
  if (!isDelegatableOperation(args.plan.operation.kind)) {
    throw new Error(`WORKSPACE_AI_OPERATION_UNSUPPORTED: ${args.plan.operation.kind}`);
  }
  const issuedAt = args.now.toISOString();
  const planExpiresAt = Date.parse(args.plan.createdAt) + args.policy.planTtlSeconds * 1_000;
  const decision: WorkspaceAiDecision = {
    schemaVersion: "worktree-ai-decision/1.0",
    kind: "workspace-ai-decision",
    id: `ai-${args.plan.id}-${issuedAt.replace(/[:.]/gu, "-")}`,
    planHash: args.plan.planHash,
    intent: args.intent,
    intentHash: sha256(args.intent),
    policyHash: hashObject(args.policy),
    projectDir: args.plan.projectDir,
    commonDir: args.plan.commonDir,
    observedHash: args.plan.observedHash,
    operation: args.plan.operation.kind,
    reviewer: args.policy.reviewer,
    verdict: args.verdict,
    reasonCodes: args.reasonCodes,
    summary: args.summary,
    issuedAt,
    expiresAt: new Date(Math.min(
      args.now.getTime() + args.policy.planTtlSeconds * 1_000,
      planExpiresAt,
    )).toISOString(),
    decisionHash: "",
  };
  decision.decisionHash = hashObject(decisionWithoutHash(decision));
  return decision;
}

function validateAiAuthorization(
  plan: WorkspacePlan,
  policy: Extract<WorktreeApprovalPolicy, { mode: "delegated-ai" }>,
  decision: WorkspaceAiDecision | undefined,
  now: Date,
): WorkspaceAiDecision {
  if (!decision) throw new Error("WORKSPACE_AI_AUTHORIZATION_REQUIRED");
  const output = aiReviewerOutputSchema.safeParse({
    verdict: decision.verdict,
    reasonCodes: decision.reasonCodes,
    summary: decision.summary,
  });
  if (
    decision.schemaVersion !== "worktree-ai-decision/1.0" ||
    decision.kind !== "workspace-ai-decision" ||
    !decision.id ||
    !decision.intent ||
    decision.intentHash !== sha256(decision.intent) ||
    !/^[a-f0-9]{64}$/u.test(decision.planHash) ||
    !/^[a-f0-9]{64}$/u.test(decision.policyHash) ||
    !/^[a-f0-9]{64}$/u.test(decision.observedHash) ||
    !/^[a-f0-9]{64}$/u.test(decision.decisionHash) ||
    !output.success ||
    hashObject(decisionWithoutHash(decision)) !== decision.decisionHash ||
    decision.verdict !== "approve" ||
    decision.planHash !== plan.planHash ||
    decision.policyHash !== hashObject(policy) ||
    decision.projectDir !== plan.projectDir ||
    decision.commonDir !== plan.commonDir ||
    decision.observedHash !== plan.observedHash ||
    decision.operation !== plan.operation.kind ||
    decision.reviewer.kind !== policy.reviewer.kind ||
    decision.reviewer.model !== policy.reviewer.model ||
    !policy.allowedOperations.includes(decision.operation) ||
    !Number.isFinite(Date.parse(decision.issuedAt)) ||
    !Number.isFinite(Date.parse(decision.expiresAt)) ||
    Date.parse(decision.issuedAt) > now.getTime() ||
    Date.parse(decision.expiresAt) <= now.getTime()
  ) {
    throw new Error("WORKSPACE_AI_AUTHORIZATION_INVALID");
  }
  return decision;
}

function workspaceAuthorization(args: {
  root: string;
  plan: WorkspacePlan;
  decision?: WorkspaceAiDecision;
  now: Date;
}): WorkspaceAiDecision | undefined {
  const binding = loadHostBinding(args.root, args.plan.commonDir);
  if (args.plan.operation.kind === "configure" || binding.approval.mode === "manual") {
    if (args.decision) throw new Error("WORKSPACE_AI_DELEGATION_NOT_ENABLED");
    return undefined;
  }
  return validateAiAuthorization(args.plan, binding.approval, args.decision, args.now);
}

function receiptAuthorization(decision?: WorkspaceAiDecision): Pick<
WorkspaceReceipt,
"authorizationMode" | "authorizationDecisionHash" | "authorizationPolicyHash" |
"authorizationReviewer"
> {
  return decision
    ? {
        authorizationMode: "delegated-ai",
        authorizationDecisionHash: decision.decisionHash,
        authorizationPolicyHash: decision.policyHash,
        authorizationReviewer: decision.reviewer,
      }
    : { authorizationMode: "manual" };
}

export function reviewAndApplyWorkspacePlan(args: {
  projectRoot: string;
  planPath: string;
  intent: string;
  now?: Date;
}): WorkspaceAiReviewResult {
  const root = repositoryRoot(args.projectRoot);
  const plan = loadWorkspacePlan(root, args.planPath);
  validateWorkspacePlanEnvelope(root, gitCommonDir(root), plan, plan.planHash);
  const intent = args.intent.trim();
  if (!intent) throw new Error("WORKSPACE_AI_INTENT_REQUIRED");
  const binding = loadHostBinding(root, plan.commonDir);
  if (!binding.configured || binding.approval.mode !== "delegated-ai") {
    throw new Error("WORKSPACE_AI_DELEGATION_NOT_ENABLED");
  }
  const policy = binding.approval;
  const now = args.now ?? new Date();
  let verdict: WorkspaceAiDecision["verdict"] = "abstain";
  let reasonCodes = ["REVIEWER_UNAVAILABLE"];
  let summary = "The delegated reviewer was not available.";
  const createdAt = Date.parse(plan.createdAt);
  const destructiveEvidence = destructiveAiEvidence(root, plan);
  if (!isDelegatableOperation(plan.operation.kind) ||
      !policy.allowedOperations.includes(plan.operation.kind)) {
    verdict = "deny";
    reasonCodes = ["OPERATION_NOT_DELEGATED"];
    summary = `Operation ${plan.operation.kind} is not authorized by the host-local delegation.`;
  } else if (!Number.isFinite(createdAt) || createdAt > now.getTime() ||
      now.getTime() - createdAt > policy.planTtlSeconds * 1_000) {
    reasonCodes = ["PLAN_EXPIRED"];
    summary = "The plan is outside the delegated review TTL and must be regenerated.";
  } else if (destructiveEvidence && !destructiveEvidence.safe) {
    verdict = "deny";
    reasonCodes = ["DESTRUCTIVE_EVIDENCE_UNSAFE"];
    summary = "Destructive delegation requires zero dirty, unique, unpushed, and ignored evidence.";
  } else {
    try {
      ({ verdict, reasonCodes, summary } = runClaudeReviewer({
        plan,
        intent,
        policy,
        destructiveEvidence,
      }));
    } catch (error) {
      summary = error instanceof Error ? error.message : String(error);
      reasonCodes = [summary.startsWith("WORKSPACE_AI_REVIEWER_INVALID")
        ? "REVIEWER_INVALID"
        : "REVIEWER_UNAVAILABLE"];
    }
  }
  const decision = buildAiDecision({
    plan,
    intent,
    policy,
    verdict,
    reasonCodes,
    summary,
    now,
  });
  const decisionPath = aiDecisionFile(plan.commonDir, decision.id);
  atomicWrite(decisionPath, prettyJson(decision));
  if (decision.verdict !== "approve") return { decisionPath, decision };
  const receipt = applyWorkspacePlan({
    projectRoot: root,
    planPath: args.planPath,
    approval: plan.planHash,
    authorization: decision,
    now,
  });
  return { decisionPath, decision, receipt };
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
        plan.operation.kind === "configure" && plan.operation.providerObservationBound
          ? plan.operation.providerObservation
          : (plan.operation.kind === "allocate" || plan.operation.kind === "adopt") &&
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
  if (receipt.status === "started" && plan.operation.kind === "close") {
    throw new Error(`WORKTREE_CLOSE_RECOVERY_REQUIRED: ${plan.id}; inspect its durable receipt`);
  }
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
  args: {
    approval: string;
    authorization?: WorkspaceAiDecision;
    now?: Date;
    testFailAfterLeaseWrites?: number;
  },
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
      ...receiptAuthorization(args.authorization),
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

function migratedPath(sourceRoot: string, targetRoot: string, sourcePath: string): string {
  const suffix = relative(sourceRoot, sourcePath);
  if (suffix === "" || suffix.startsWith("..") || isAbsolute(suffix)) {
    throw new Error(`WORKTREE_MIGRATION_PATH_INVALID: ${sourcePath}`);
  }
  return join(targetRoot, suffix);
}

function assertMigrationPostconditions(
  status: WorkspaceStatus,
  operation: Extract<WorkspacePlan["operation"], { kind: "migrate" }>,
): void {
  const source = operation.preflight.worktrees[0];
  const observed = status.worktrees[0];
  const topology = operation.topology;
  if (
    status.projectDir !== topology.managementCheckout ||
    status.commonDir !== topology.commonDir ||
    existsSync(operation.preflight.managementCheckout) ||
    status.topology.kind !== "container-v1" ||
    status.topology.workspaceContainer !== topology.workspaceContainer ||
    status.topology.managementCheckout !== topology.managementCheckout ||
    status.topology.persistentWorktreeRoot !== topology.persistentWorktreeRoot ||
    status.hostBinding.hash !== operation.preflight.afterHostBindingHash ||
    hashObject(status.hostBinding.allowedRoots) !== hashObject([topology.persistentWorktreeRoot!]) ||
    hashObject(status.hostBinding.protectedRoots) !== hashObject(topology.protectedRoots) ||
    status.leases.length !== 0 ||
    status.capacity.used !== 0 ||
    status.worktrees.length !== 1 ||
    !observed ||
    observed.path !== topology.managementCheckout ||
    observed.gitTopLevel !== topology.managementCheckout ||
    observed.branch !== source.branch ||
    observed.head !== source.head ||
    Boolean(observed.dirty) !== source.dirty ||
    hashObject(observed.dirtyEvidence ?? []) !== hashObject(source.dirtyEvidence) ||
    hashObject(observed.dirtyPatch ?? { size: 0, sha256: sha256("") }) !== hashObject(source.dirtyPatch) ||
    observed.uniqueCommits !== source.uniqueCommits ||
    observed.unpushedCommits !== source.unpushedCommits ||
    hashObject(refsObservation(status.projectDir)) !== operation.preflight.refsHash ||
    fileHash(join(status.projectDir, ".harness", "worktree-delivery.json")) !== operation.preflight.configHash ||
    directoryState(topology.persistentWorktreeRoot!) !== "empty"
  ) {
    throw new Error("WORKTREE_MIGRATION_POSTCONDITION_FAILED");
  }
}

export function applyWorkspaceMigration(args: {
  projectRoot: string;
  planPath: string;
  approval: string;
  now?: Date;
  testFailAfterMove?: boolean;
}): WorkspaceReceipt {
  const root = repositoryRoot(args.projectRoot);
  const plan = loadWorkspacePlan(root, args.planPath);
  if (plan.operation.kind !== "migrate") {
    throw new Error("WORKTREE_MIGRATION_PLAN_REQUIRED");
  }
  if (hashObject(withoutHash(plan)) !== plan.planHash) {
    throw new Error("PLAN_TAMPERED: workspace plan content does not match its embedded hash");
  }
  if (args.approval !== plan.planHash) {
    throw new Error(`APPROVAL_MISMATCH: expected exact plan hash ${plan.planHash}`);
  }
  const operation = plan.operation;
  const atSource = root === plan.projectDir && gitCommonDir(root) === plan.commonDir;
  const atTarget = root === operation.topology.managementCheckout &&
    gitCommonDir(root) === operation.topology.commonDir;
  if (!atSource && !atTarget) throw new Error("PROJECT_MISMATCH: workspace plan belongs to another repository");
  const sourceReceiptPath = receiptFile(plan.commonDir, plan.id);
  const targetCommonDir = plan.operation.topology.commonDir;
  const targetReceiptPath = receiptFile(targetCommonDir, plan.id);
  const existingPath = atTarget ? targetReceiptPath : sourceReceiptPath;
  const existing = existsSync(existingPath) ? readJson<WorkspaceReceipt>(existingPath) : undefined;
  if (existing && existing.planHash !== plan.planHash) throw new Error(`CHANGE_ID_CONFLICT: ${plan.id}`);
  if (existing?.status === "applied") {
    if (!atTarget) throw new Error(`WORKTREE_MIGRATION_RECOVERY_REQUIRED: ${plan.id}`);
    const after = workspaceStatus(root);
    assertMigrationPostconditions(after, operation);
    return existing;
  }
  if (atSource && existing) {
    throw new Error(`WORKTREE_MIGRATION_RECOVERY_REQUIRED: ${plan.id}; inspect its durable receipt`);
  }
  let before: WorkspaceStatus;
  if (atSource) {
    before = workspaceStatus(root);
    validateWorkspacePlan(before, plan, args.approval);
  } else {
    before = existing?.before ?? (() => { throw new Error("WORKTREE_MIGRATION_RECOVERY_REQUIRED: missing receipt"); })();
  }
  let lock = acquireLock(atSource ? plan.commonDir : targetCommonDir);
  let moved = atTarget;
  const receipt: WorkspaceReceipt = existing ?? {
    schemaVersion: "worktree-delivery/1.0",
    kind: "workspace-receipt",
    id: plan.id,
    planHash: plan.planHash,
    operation: "migrate",
    status: "started",
    startedAt: (args.now ?? new Date()).toISOString(),
    steps: [],
    before,
    beforeObservedHash: before.observedHash,
    compensationStatus: "not-required",
    migration: {
      sourceProjectDir: plan.projectDir,
      targetProjectDir: operation.topology.managementCheckout,
      sourceCommonDir: plan.commonDir,
      targetCommonDir,
      recoveryState: "before-move",
    },
  };
  const checkpoint = (): void => writeReceipt(moved ? targetReceiptPath : sourceReceiptPath, receipt);
  try {
    const topology = operation.topology;
    if (!moved) {
      const reobserved = migrationOperation(before, topology.workspaceContainer!);
      if (hashObject(reobserved) !== hashObject(operation)) {
        throw new Error("WORKSPACE_DRIFT: migration preconditions changed");
      }
      checkpoint();
      if (
        directoryState(topology.workspaceContainer!) !== operation.preflight.targetContainerState ||
        directoryState(topology.managementCheckout) !== "absent" ||
        directoryState(topology.persistentWorktreeRoot!) !== "absent"
      ) {
        throw new Error("WORKSPACE_DRIFT: migration target paths changed");
      }
      if (directoryState(topology.workspaceContainer!) === "absent") {
        mkdirSync(topology.workspaceContainer!);
        if (directoryState(topology.workspaceContainer!) !== "empty") {
          throw new Error(`WORKTREE_MIGRATION_CONTAINER_CREATE_FAILED: ${topology.workspaceContainer}`);
        }
        receipt.createdDirectories = [topology.workspaceContainer!];
        receipt.steps.push({ id: "create-container", status: "applied", detail: topology.workspaceContainer! });
        checkpoint();
      }
      mkdirSync(topology.persistentWorktreeRoot!);
      if (directoryState(topology.persistentWorktreeRoot!) !== "empty") {
        throw new Error(`WORKTREE_MIGRATION_WORKTREES_CREATE_FAILED: ${topology.persistentWorktreeRoot}`);
      }
      receipt.createdDirectories = [...(receipt.createdDirectories ?? []), topology.persistentWorktreeRoot!];
      receipt.steps.push({ id: "create-worktrees-root", status: "applied", detail: topology.persistentWorktreeRoot! });
      checkpoint();
      assertCurrentHash(join(root, ".harness", "worktree-delivery.json"), operation.preflight.configHash);
      assertCurrentHash(hostBindingFile(plan.commonDir), operation.preflight.hostBindingHash);
      renameSync(root, topology.managementCheckout);
      moved = true;
      lock = migratedPath(root, topology.managementCheckout, lock);
      receipt.migration!.recoveryState = "after-move";
      receipt.steps.push({ id: "move-management-checkout", status: "applied", detail: `${root} -> ${topology.managementCheckout}` });
      checkpoint();
      if (args.testFailAfterMove) throw new Error("TEST_MIGRATION_AFTER_MOVE_FAILURE");
    } else {
      const current = workspaceStatus(root);
      const source = operation.preflight.worktrees[0];
      const observed = current.worktrees[0];
      if (
        existsSync(plan.projectDir) ||
        current.worktrees.length !== 1 ||
        current.leases.length !== 0 ||
        !observed || observed.path !== topology.managementCheckout || observed.gitTopLevel !== topology.managementCheckout ||
        observed.branch !== source.branch || observed.head !== source.head || Boolean(observed.dirty) !== source.dirty ||
        hashObject(observed.dirtyEvidence ?? []) !== hashObject(source.dirtyEvidence) ||
        hashObject(observed.dirtyPatch ?? { size: 0, sha256: sha256("") }) !== hashObject(source.dirtyPatch) ||
        observed.uniqueCommits !== source.uniqueCommits || observed.unpushedCommits !== source.unpushedCommits ||
        hashObject(refsObservation(root)) !== operation.preflight.refsHash ||
        fileHash(join(root, ".harness", "worktree-delivery.json")) !== operation.preflight.configHash ||
        directoryState(topology.persistentWorktreeRoot!) !== "empty" ||
        ![operation.preflight.hostBindingHash, operation.preflight.afterHostBindingHash].includes(current.hostBinding.hash)
      ) {
        throw new Error("WORKTREE_MIGRATION_RECOVERY_UNSAFE");
      }
      receipt.status = "started";
      receipt.error = undefined;
      receipt.migration!.recoveryState = "after-move";
      receipt.steps.push({ id: "resume-migration", status: "applied", detail: topology.managementCheckout });
      checkpoint();
    }
    const bindingHash = fileHash(hostBindingFile(targetCommonDir));
    if (bindingHash === operation.preflight.hostBindingHash) {
      atomicWrite(hostBindingFile(targetCommonDir), operation.preflight.afterHostBindingContent);
      assertCurrentHash(hostBindingFile(targetCommonDir), operation.preflight.afterHostBindingHash);
      receipt.steps.push({ id: "write-container-host-binding", status: "applied", detail: hostBindingFile(targetCommonDir) });
      checkpoint();
    } else if (bindingHash !== operation.preflight.afterHostBindingHash) {
      throw new Error("WORKTREE_MIGRATION_RECOVERY_UNSAFE: host binding changed");
    }
    const after = workspaceStatus(topology.managementCheckout);
    assertMigrationPostconditions(after, operation);
    receipt.status = "applied";
    receipt.completedAt = (args.now ?? new Date()).toISOString();
    receipt.after = after;
    receipt.afterObservedHash = after.observedHash;
    receipt.migration!.recoveryState = "complete";
    checkpoint();
    return receipt;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    receipt.status = "failed";
    receipt.error = message;
    receipt.migration ??= {
      sourceProjectDir: plan.projectDir,
      targetProjectDir: operation.topology.managementCheckout,
      sourceCommonDir: plan.commonDir,
      targetCommonDir,
      recoveryState: "failed",
    };
    receipt.migration.recoveryState = "failed";
    receipt.steps.push({ id: "apply", status: "failed", detail: message });
    receipt.completedAt = (args.now ?? new Date()).toISOString();
    checkpoint();
    throw error;
  } finally {
    releaseLock(lock);
  }
}

export function applyWorkspacePlan(args: {
  projectRoot: string;
  planPath: string;
  approval: string;
  authorization?: WorkspaceAiDecision;
  now?: Date;
  testFailAfterLeaseWrites?: number;
  testFailCloseAfterWorktreeRemove?: boolean;
  testFailRemoteDeleteAfterPush?: boolean;
}): WorkspaceReceipt {
  const root = repositoryRoot(args.projectRoot);
  const plan = loadWorkspacePlan(root, args.planPath);
  validateWorkspacePlanEnvelope(root, gitCommonDir(root), plan, plan.planHash);
  if (plan.operation.kind === "migrate") {
    throw new Error("WORKTREE_MIGRATION_APPLY_UNSUPPORTED");
  }
  const authorization = workspaceAuthorization({
    root,
    plan,
    decision: args.authorization,
    now: args.now ?? new Date(),
  });
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
    providerObservation: plan.operation.kind === "configure" && plan.operation.providerObservationBound
      ? plan.operation.providerObservation
      : undefined,
  });
  validateWorkspacePlan(before, plan, args.approval);
  const postCloseRoot = plan.operation.kind === "close" && samePath(root, plan.operation.lease.path)
    ? survivingManagementCheckout(before, plan.operation.lease.path)
    : root;
  const lock = acquireLock(plan.commonDir);
  if (authorization || plan.operation.kind === "renew" || plan.operation.kind === "recover") {
    before = workspaceStatus(root, {
      providerWorkItems: plan.operation.kind === "allocate" &&
          plan.operation.providerObservationBound
        ? [plan.operation.lease.workItem]
        : undefined,
      providerObservation: plan.operation.kind === "configure" && plan.operation.providerObservationBound
        ? plan.operation.providerObservation
        : undefined,
    });
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
    ...receiptAuthorization(authorization),
  };
  let worktreeCreated = false;
  let configWritten = false;
  let hostBindingWritten = false;
  let allowedRootCreated = false;
  let worktreeRemoved = false;
  let localBranchDeleted = false;
  let branchConfigRemoved = false;
  let remoteDeleteAttempted = false;
  let remoteDeleteEndpoint: string | null = null;
  let remoteBranchDeleted = false;
  let recoveryRemoved = false;
  try {
    writeReceipt(receiptPath, receipt);
    if (plan.operation.kind === "configure") {
      const target = safePath(root, plan.operation.configPath);
      const hostBindingTarget = safePath(plan.commonDir, plan.operation.hostBindingPath);
      const plannedConfig = validConfig(JSON.parse(plan.operation.content));
      const plannedBinding = validHostBinding(JSON.parse(plan.operation.hostBindingContent));
      if (plannedBinding.topology) {
        containerTopology(
          root,
          plan.commonDir,
          plannedBinding.topology.workspaceContainer,
          plannedConfig.managementBranch,
          before.worktrees,
          Boolean(plan.operation.allowedRoot),
        );
      }
      if (plan.operation.allowedRoot) {
        const state = directoryState(plan.operation.allowedRoot.path);
        if (state !== plan.operation.allowedRoot.before) {
          throw new Error(`WORKSPACE_DRIFT: allowed root changed: ${plan.operation.allowedRoot.path}`);
        }
        if (state === "absent") {
          mkdirSync(plan.operation.allowedRoot.path);
          if (directoryState(plan.operation.allowedRoot.path) !== "empty") {
            throw new Error(`WORKTREE_ALLOWED_ROOT_CREATE_FAILED: ${plan.operation.allowedRoot.path}`);
          }
          allowedRootCreated = true;
          receipt.createdDirectories = [plan.operation.allowedRoot.path];
          receipt.steps.push({
            id: "create-allowed-root",
            status: "applied",
            detail: plan.operation.allowedRoot.path,
          });
        }
      }
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
      if (authorization && destructiveAiEvidence(root, plan)?.safe !== true) {
        throw new Error("WORKSPACE_AI_DESTRUCTIVE_PRECONDITION_FAILED");
      }
      requireHostBinding(before);
      validateTarget(before.hostBinding, operation.lease.path);
      assertCurrentHash(leaseFile(plan.commonDir, operation.lease.workItem), operation.expectedLeaseHash);
      const observed = before.worktrees.find(
        (worktree) => samePath(worktree.path, operation.lease.path),
      );
      if (!observed || observed.head !== operation.expectedHead || observed.dirty) {
        throw new Error("WORKSPACE_DRIFT: close preconditions changed");
      }
      const ignored = ignoredPaths(
        before.projectDir,
        operation.lease.path,
        resolve(root, args.planPath),
      );
      if (ignored.length > 0 ||
          operation.ignoredPathCount !== undefined && operation.ignoredPathCount !== ignored.length ||
          operation.ignoredPathsHash !== undefined && operation.ignoredPathsHash !== hashObject(ignored)) {
        throw new Error(`WORKSPACE_DRIFT: ignored close content changed: ${JSON.stringify(ignored)}`);
      }
      if (operation.branchCleanup) {
        const cleanup = branchCleanupEvidence(before, operation.lease, operation.expectedHead);
        if (hashObject(cleanup) !== hashObject(operation.branchCleanup)) {
          throw new Error("WORKSPACE_DRIFT: branch cleanup evidence changed");
        }
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
      git(postCloseRoot, ["worktree", "remove", operation.lease.path]);
      worktreeRemoved = true;
      receipt.steps.push({ id: "remove-worktree", status: "applied", detail: operation.lease.path });
      if (args.testFailCloseAfterWorktreeRemove) {
        throw new Error("TEST_CLOSE_AFTER_WORKTREE_REMOVE_FAILURE");
      }
      unlinkSync(leaseFile(plan.commonDir, operation.lease.workItem));
      receipt.steps.push({ id: "remove-lease", status: "applied", detail: operation.lease.workItem });
      if (operation.branchCleanup) {
        git(postCloseRoot, [
          "update-ref",
          "-d",
          operation.branchCleanup.localRef,
          operation.branchCleanup.expectedHead,
        ]);
        localBranchDeleted = true;
        receipt.steps.push({
          id: "delete-local-branch",
          status: "applied",
          detail: `${operation.branchCleanup.localRef}@${operation.branchCleanup.expectedHead}`,
        });
        branchConfigRemoved = true;
        removeBranchConfig(
          postCloseRoot,
          operation.branchCleanup.branch,
          operation.branchCleanup.branchConfig,
        );
        receipt.steps.push({
          id: "remove-branch-config",
          status: "applied",
          detail: operation.branchCleanup.branch,
        });
        if (operation.branchCleanup.remote.expectedHead !== null) {
          const endpoint = remotePushEndpoint(postCloseRoot, operation.branchCleanup.remote.name);
          if (endpoint.hash !== operation.branchCleanup.remote.endpointHash) {
            throw new Error(`REMOTE_PUSH_ENDPOINT_DRIFT: ${operation.branchCleanup.remote.name}`);
          }
          remoteDeleteEndpoint = endpoint.value;
          remoteDeleteAttempted = true;
          receipt.steps.push({
            id: "checkpoint-remote-branch-delete",
            status: "applied",
            detail: `${operation.branchCleanup.remote.name}/${operation.branchCleanup.remote.ref}@${operation.branchCleanup.remote.expectedHead}`,
          });
          writeReceipt(receiptPath, receipt);
          deleteRemoteBranch(
            postCloseRoot,
            endpoint.value,
            operation.branchCleanup.remote.name,
            operation.branchCleanup.remote.ref,
            operation.branchCleanup.remote.expectedHead,
          );
          if (args.testFailRemoteDeleteAfterPush) {
            throw new Error("TEST_REMOTE_DELETE_CLIENT_FAILURE");
          }
          remoteBranchDeleted = true;
          receipt.steps.push({
            id: "delete-remote-branch",
            status: "applied",
            detail: `${operation.branchCleanup.remote.name}/${operation.branchCleanup.remote.ref}`,
          });
        }
      }
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
    } else if (plan.operation.kind === "recover") {
      const operation = plan.operation;
      if (authorization && destructiveAiEvidence(root, plan)?.safe !== true) {
        throw new Error("WORKSPACE_AI_DESTRUCTIVE_PRECONDITION_FAILED");
      }
      requireHostBinding(before);
      if (protectedPath(before.hostBinding, operation.path)) {
        throw new Error(`PROTECTED_WORKTREE_PATH: ${operation.path}`);
      }
      if (before.leases.some((lease) => samePath(lease.path, operation.path))) {
        throw new Error(`WORKTREE_RECOVER_LEASED: ${operation.path}`);
      }
      const observed = before.worktrees.find((worktree) => samePath(worktree.path, operation.path));
      if (!observed || observed.head !== operation.expectedHead || observed.dirty ||
          !observed.detached || observed.branch !== null || observed.bare || observed.locked ||
          observed.prunable || operation.dirtyEvidence.length !== 0 || operation.dirtyPatch.size !== 0 ||
          operation.dirtyPatch.sha256 !== sha256("")) {
        throw new Error("WORKSPACE_DRIFT: recover preconditions changed");
      }
      git(root, ["worktree", "remove", operation.removePath]);
      recoveryRemoved = true;
      receipt.steps.push({ id: "remove-recovered-worktree", status: "applied", detail: operation.removePath });
    }
    receipt.status = "applied";
    receipt.completedAt = (args.now ?? new Date()).toISOString();
    receipt.after = workspaceStatus(postCloseRoot, {
      providerObservation: plan.operation.kind === "configure" && plan.operation.providerObservationBound
        ? plan.operation.providerObservation
        : plan.operation.kind === "allocate" && plan.operation.providerObservationBound
          ? before.provider
          : undefined,
    });
    writeReceipt(receiptPath, receipt);
    return receipt;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    let finalError: unknown = error;
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
        if (allowedRootCreated && plan.operation.allowedRoot) {
          if (directoryState(plan.operation.allowedRoot.path) !== "empty") {
            throw new Error(`WORKTREE_ALLOWED_ROOT_COMPENSATION_UNSAFE: ${plan.operation.allowedRoot.path}`);
          }
          rmdirSync(plan.operation.allowedRoot.path);
          receipt.steps.push({
            id: "remove-allowed-root",
            status: "compensated",
            detail: plan.operation.allowedRoot.path,
          });
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
      } else if (plan.operation.kind === "close" && worktreeRemoved && !remoteBranchDeleted) {
        let compensationSafe = true;
        if (remoteDeleteAttempted && plan.operation.branchCleanup?.remote.expectedHead) {
          try {
            if (!remoteDeleteEndpoint) throw new Error("remote endpoint was not retained");
            const observed = remoteRefHead(
              postCloseRoot,
              remoteDeleteEndpoint,
              plan.operation.branchCleanup.remote.name,
              plan.operation.branchCleanup.remote.ref,
            );
            if (observed !== plan.operation.branchCleanup.remote.expectedHead) {
              compensationSafe = false;
              remoteBranchDeleted = observed === null;
              finalError = new Error(
                `WORKTREE_CLOSE_RECOVERY_REQUIRED: remote delete outcome is ${
                  observed === null ? "deleted" : `moved to ${observed}`
                }; inspect ${receiptPath}`,
              );
            }
          } catch (observationError) {
            compensationSafe = false;
            finalError = new Error(
              `WORKTREE_CLOSE_RECOVERY_REQUIRED: remote delete outcome is unobservable: ${
                observationError instanceof Error ? observationError.message : String(observationError)
              }; inspect ${receiptPath}`,
            );
          }
          if (!compensationSafe) {
            receipt.steps.push({
              id: "remote-delete-recovery",
              status: "failed",
              detail: finalError instanceof Error ? finalError.message : String(finalError),
            });
          }
        }
        if (!compensationSafe) {
          receipt.error = finalError instanceof Error ? finalError.message : String(finalError);
        } else {
        if (localBranchDeleted && plan.operation.branchCleanup) {
          git(postCloseRoot, [
            "update-ref",
            plan.operation.branchCleanup.localRef,
            plan.operation.branchCleanup.expectedHead,
            "0".repeat(plan.operation.branchCleanup.expectedHead.length),
          ]);
          receipt.steps.push({
            id: "restore-local-branch",
            status: "compensated",
            detail: plan.operation.branchCleanup.localRef,
          });
        }
        if (branchConfigRemoved && plan.operation.branchCleanup) {
          restoreBranchConfig(
            postCloseRoot,
            plan.operation.branchCleanup.branch,
            plan.operation.branchCleanup.branchConfig,
          );
          receipt.steps.push({
            id: "restore-branch-config",
            status: "compensated",
            detail: plan.operation.branchCleanup.branch,
          });
        }
        git(postCloseRoot, ["worktree", "add", plan.operation.lease.path, plan.operation.lease.branch]);
        atomicWrite(leaseFile(plan.commonDir, plan.operation.lease.workItem), prettyJson(plan.operation.lease));
        receipt.steps.push({ id: "restore-close", status: "compensated", detail: plan.operation.lease.path });
        }
      } else if (plan.operation.kind === "rebind" &&
          fileHash(leaseFile(plan.commonDir, plan.operation.lease.workItem)) === plan.operation.afterLeaseHash) {
        atomicWrite(leaseFile(plan.commonDir, plan.operation.lease.workItem), prettyJson(plan.operation.lease));
        receipt.steps.push({ id: "restore-rebind", status: "compensated", detail: plan.operation.lease.workItem });
      } else if (plan.operation.kind === "renew" &&
          fileHash(leaseFile(plan.commonDir, plan.operation.lease.workItem)) === plan.operation.afterLeaseHash) {
        atomicWrite(leaseFile(plan.commonDir, plan.operation.lease.workItem), prettyJson(plan.operation.lease));
        receipt.steps.push({ id: "restore-renew", status: "compensated", detail: plan.operation.lease.workItem });
      } else if (plan.operation.kind === "recover" && recoveryRemoved) {
        git(root, ["worktree", "add", "--detach", plan.operation.path, plan.operation.expectedHead]);
        receipt.steps.push({ id: "restore-recovered-worktree", status: "compensated", detail: plan.operation.path });
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
    throw finalError;
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
  if (plan.operation.kind === "migrate") {
    throw new Error("WORKTREE_MIGRATION_ROLLBACK_UNSUPPORTED: inspect the durable migration receipt and recover manually");
  }
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
  const status = workspaceStatus(root, {
    providerObservation: plan.operation.kind === "configure" && plan.operation.providerObservationBound
      ? plan.operation.providerObservation
      : undefined,
  });
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
      if (plan.operation.allowedRoot &&
          receipt.createdDirectories?.includes(plan.operation.allowedRoot.path)) {
        if (directoryState(plan.operation.allowedRoot.path) !== "empty") {
          throw new Error(`WORKSPACE_ROLLBACK_UNSAFE: allowed root is not empty: ${plan.operation.allowedRoot.path}`);
        }
        rmdirSync(plan.operation.allowedRoot.path);
        receipt.steps.push({
          id: "rollback-allowed-root",
          status: "compensated",
          detail: plan.operation.allowedRoot.path,
        });
      }
    } else if (plan.operation.kind === "allocate") {
      throw new Error(
        "WORKSPACE_ROLLBACK_REQUIRES_CLOSE_PLAN: an allocated worktree must pass a new exact-hash close plan",
      );
    } else if (plan.operation.kind === "close") {
      if (plan.operation.branchCleanup) {
        throw new Error(
          "WORKSPACE_ROLLBACK_UNAVAILABLE: branch cleanup is irreversible by automatic rollback",
        );
      }
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
    } else if (plan.operation.kind === "recover") {
      const operation = plan.operation;
      requireHostBinding(status);
      if (protectedPath(status.hostBinding, operation.path)) {
        throw new Error(`PROTECTED_WORKTREE_PATH: ${operation.path}`);
      }
      if (status.worktrees.some((worktree) => samePath(worktree.path, operation.path))) {
        throw new Error(`WORKSPACE_ROLLBACK_UNSAFE: path exists: ${operation.path}`);
      }
      git(status.projectDir, [
        "worktree",
        "add",
        "--detach",
        operation.path,
        operation.expectedHead,
      ]);
      receipt.steps.push({ id: "rollback-recover", status: "compensated", detail: operation.path });
    }
    receipt.status = "rolled-back";
    receipt.completedAt = (args.now ?? new Date()).toISOString();
    receipt.after = workspaceStatus(status.projectDir, {
      providerObservation: plan.operation.kind === "configure" && plan.operation.providerObservationBound
        ? plan.operation.providerObservation
        : undefined,
    });
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

const reviewReceiptPathSchema = z.string().min(1)
  .refine((value) => isAbsolute(value) && !value.includes("\0"), "must be a safe absolute path");
const reviewReceiptTimestampSchema = z.string()
  .refine((value) => Number.isFinite(Date.parse(value)), "must be a valid timestamp");
const reviewReceiptSchema = z.object({
  schemaVersion: z.literal("worktree-delivery/1.0"),
  kind: z.literal("review-receipt"),
  id: z.string().min(1),
  projectDir: reviewReceiptPathSchema,
  commonDir: reviewReceiptPathSchema,
  commit: z.string().min(1),
  path: reviewReceiptPathSchema,
  receiptPath: reviewReceiptPathSchema,
  command: z.array(z.string()).min(1),
  createdAt: reviewReceiptTimestampSchema,
  completedAt: reviewReceiptTimestampSchema.optional(),
  status: z.enum(["starting", "active", "cleaned", "blocked", "failed"]),
  detached: z.boolean(),
  dirty: z.boolean(),
  exitCode: z.number().int().nonnegative().nullable(),
  output: z.string(),
  dirtyEvidence: z.array(z.object({
    path: z.string(),
    status: z.string(),
    size: z.number().nonnegative(),
    sha256: z.string(),
  }).passthrough()).optional(),
  dirtyPatch: z.object({
    size: z.number().nonnegative(),
    sha256: z.string(),
  }).passthrough().optional(),
  error: z.string().optional(),
}).passthrough();

function validReviewReceipt(input: unknown): ReviewReceipt {
  if (input && typeof input === "object" &&
      (input as { kind?: unknown }).kind !== "review-receipt") {
    throw new Error("not a review receipt");
  }
  const parsed = reviewReceiptSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`invalid review receipt: ${issue.path.join(".") || "receipt"} ${issue.message}`);
  }
  return parsed.data as ReviewReceipt;
}

export function retentionAuditWorkspace(args: {
  projectRoot: string;
  hostStateRoot?: string;
  now?: Date;
  receiptScope?: ReviewReceiptScope;
}): RetentionAudit {
  const status = workspaceStatus(args.projectRoot, {
    providerObservation: { kind: "none", configured: false, available: true, items: [] },
  });
  const now = args.now ?? new Date();
  const hostStateRoot = resolve(args.hostStateRoot ?? defaultHostStateRoot());
  const reviewDirectory = join(hostStateRoot, "reviews");
  const receiptScope = args.receiptScope ?? "host-global";
  if (receiptScope !== "host-global" && receiptScope !== "project") {
    throw new Error("RECEIPT_SCOPE_INVALID: choose host-global or project");
  }
  const errors: string[] = [];
  const receipts: ReviewReceipt[] = [];
  let excludedReviewReceiptCount = 0;
  if (existsSync(reviewDirectory)) {
    for (const name of readdirSync(reviewDirectory).filter((entry) => entry.endsWith(".json")).sort()) {
      const path = join(reviewDirectory, name);
      try {
        const receipt = validReviewReceipt(readJson<unknown>(path));
        if (receiptScope === "project") {
          const receiptProjectDir = canonicalPath(receipt.projectDir);
          const receiptCommonDir = canonicalPath(receipt.commonDir);
          if (receiptProjectDir !== status.projectDir || receiptCommonDir !== status.commonDir) {
            excludedReviewReceiptCount += 1;
            continue;
          }
        }
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
  ], true).split("\0").map((token) => token.trim()).filter(Boolean);
  const remotes = git(status.projectDir, ["remote"], true).split(/\r?\n/u).filter(Boolean)
    .sort((left, right) => right.length - left.length);
  const remoteBranches: RetentionAudit["remoteBranches"] = [];
  for (let index = 0; index + 1 < remoteTokens.length; index += 2) {
    const ref = remoteTokens[index];
    if (ref.endsWith("/HEAD")) continue;
    const remote = remotes.find((candidate) => ref.startsWith(`refs/remotes/${candidate}/`));
    const branch = remote ? ref.slice(`refs/remotes/${remote}/`.length) : null;
    if (status.config.managementBranch && branch === status.config.managementBranch) continue;
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
    receiptScope,
    excludedReviewReceiptCount,
    reviewTtlMinutes: status.config.reviewTtlMinutes,
    remoteBranchRetentionDays: status.config.remoteBranchRetentionDays,
    remoteDeletionEnabled: status.config.remoteBranchDeletion,
    staleReviews,
    staleLeases,
    staleLocks,
    remoteBranches,
    errors,
  };
}
