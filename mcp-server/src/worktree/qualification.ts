import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { qualificationResourcesSchema } from "../approval/human_scope.js";
import { loadHumanAuthorization, recordQualificationResourceLocked, reserveQualificationResourcesLocked, type HumanScopeBinding } from "../approval/human.js";
import { qualificationSourceGraph, type ResourceFact, type ResourceState } from "../approval/human_resources.js";
import type { CoordinationClock } from "../coordination/clock.js";
import { objectDirectory, objectEnv, objectGit, validateSyntheticObject } from "../coordination/objects.js";
import { nativeCoordinationObservers } from "../coordination/runtime.js";
import { readLkgChain } from "../receipt/service.js";
import { GitHubCoordinationTransport } from "../coordination/transport.js";
import { assertMutationLock, type MutationLock } from "../recovery/service.js";
import { inspectGit, observeWorkspaceAssets } from "../repository/assets.js";
import { resolveRepositoryContext, runGitCommand } from "../repository/git.js";
import { fileHash, hashObject } from "../v2/fs.js";
import { parseWorktreePorcelain, validateBranch, validateTarget, workspaceLocalInventory } from "./service.js";

function qualificationInventory(projectRoot: string, input: unknown) {
  const resources = qualificationResourcesSchema.parse(input); const inventory = workspaceLocalInventory(projectRoot, true);
  const { root, commonDir, loadedConfig, loadedLeases, hostBinding } = inventory;
  if (root !== resources.authorityRoot || commonDir !== resources.commonDir) throw new Error("HUMAN_LOCAL_RESOURCE_BINDING_MISMATCH");
  // Fixed empty fixtures must not inherit/copy per-worktree configuration or credentials.
  if (inspectGit(root, ["config", "--bool", "--get", "extensions.worktreeConfig"], true).trim() === "true") throw new Error("QUALIFICATION_RESOURCE_CONFIG_UNSUPPORTED");
  if (!loadedConfig.configured || loadedConfig.config.mode !== "enforced") throw new Error("WORKTREE_ENFORCEMENT_NOT_ENABLED");
  if (!hostBinding.configured) throw new Error("WORKTREE_HOST_BINDING_REQUIRED");
  if (fileHash(join(root, ".harness/worktree-delivery.json")) !== resources.configHash || hostBinding.hash !== resources.hostBindingHash) throw new Error("HUMAN_LOCAL_RESOURCE_POLICY_DRIFT");
  if (loadedLeases.errors.length) throw new Error("WORKSPACE_DRIFT");
  return { resources, inventory };
}

/** Read-only path/capacity admission, using the same rules as normal delivery and no Provider call. */
export function preflightQualificationResources(projectRoot: string, input: unknown) {
  const { resources, inventory } = qualificationInventory(projectRoot, input);
  const { root, loadedConfig, hostBinding, qualificationResources, observedWorktrees, loadedLeases } = inventory;
  if (resources.items.length > resources.maxConcurrent || inventory.capacity.available < resources.items.length) throw new Error("WORKTREE_CAPACITY_EXCEEDED");
  for (const item of resources.items) {
    validateBranch(root, item.branch);
    if (item.branch === loadedConfig.config.managementBranch) throw new Error("WORKTREE_MANAGEMENT_BRANCH_PROTECTED");
    if (validateTarget(hostBinding, item.path) !== item.path || lstatSync(item.path, { throwIfNoEntry: false })) throw new Error("WORKTREE_PATH_EXISTS_OR_NONCANONICAL");
    const parent = lstatSync(dirname(item.path), { throwIfNoEntry: false });
    if (!parent?.isDirectory() || parent.isSymbolicLink()) throw new Error("WORKTREE_ALLOWED_ROOT_MISSING");
    if (qualificationResources.some((other) => other.path === item.path || other.branch === item.branch) ||
        loadedLeases.values.some((other) => other.path === item.path || other.branch === item.branch) ||
        observedWorktrees.some((other) => other.path === item.path || other.branch === item.branch) ||
        inspectGit(root, ["for-each-ref", "--format=%(refname)", `refs/heads/${item.branch}`])) throw new Error("WORKTREE_QUALIFICATION_RESOURCE_RESERVED");
  }
  return inventory;
}

/** One local lock and one durable reservation event for the whole batch; no workspace creation or network write. */
export function reserveQualificationWorkspacesLocked(lock: MutationLock, projectRoot: string, approvalRef: string,
  binding: HumanScopeBinding, clock: CoordinationClock): void {
  assertMutationLock({ projectDir: projectRoot, commonDir: binding.commonDir, repository: true }, lock);
  const state = loadHumanAuthorization(binding.commonDir, approvalRef); const scope = state.approval.scope;
  if (scope.kind !== "qualification-run" || !scope.localResources) throw new Error("HUMAN_LOCAL_RESOURCE_SCOPE_REQUIRED");
  const inventory = preflightQualificationResources(projectRoot, scope.localResources);
  assertMutationLock({ projectDir: inventory.root, commonDir: inventory.commonDir, repository: true }, lock);
  reserveQualificationResourcesLocked(lock, inventory.commonDir, approvalRef, binding, clock);
}

function ownedDirectory(path: string): NonNullable<ResourceState["identity"]> {
  const stat = lstatSync(path); const parent = lstatSync(dirname(path));
  if (!stat.isDirectory() || stat.isSymbolicLink() || !parent.isDirectory() || parent.isSymbolicLink() || realpathSync(path) !== path) throw new Error("QUALIFICATION_RESOURCE_IDENTITY_UNPROVEN");
  return { device: stat.dev, inode: stat.ino, birthtimeMs: stat.birthtimeMs, parentDevice: parent.dev, parentInode: parent.ino, parentBirthtimeMs: parent.birthtimeMs };
}
function metadata(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error("QUALIFICATION_RESOURCE_REGISTRATION_UNPROVEN");
  return readFileSync(path, "utf8");
}
function registrationHash(gitDir: string): string {
  const files: Array<{ path: string; mode: number; hash: string }> = []; let count = 0;
  const visit = (path: string, relative: string) => {
    const stat = lstatSync(path);
    if (++count > 128 || stat.isSymbolicLink()) throw new Error("QUALIFICATION_RESOURCE_METADATA_UNSUPPORTED");
    if (stat.isDirectory()) {
      if (!["", "/logs", "/refs"].includes(relative)) throw new Error("QUALIFICATION_RESOURCE_METADATA_DRIFT");
      for (const name of readdirSync(path).sort()) visit(join(path, name), `${relative}/${name}`);
    }
    else {
      if (!["/HEAD", "/commondir", "/gitdir", "/index", "/logs/HEAD"].includes(relative)) throw new Error("QUALIFICATION_RESOURCE_METADATA_DRIFT");
      if (!stat.isFile() || stat.size > 64 * 1024) throw new Error("QUALIFICATION_RESOURCE_METADATA_UNSUPPORTED");
      files.push({ path: relative, mode: stat.mode, hash: fileHash(path)! });
    }
  };
  visit(gitDir, ""); return hashObject(files);
}

/** Actual registered empty synthetic checkout, not a same-path/same-SHA ownership inference. */
export function observeQualificationWorkspace(projectRoot: string, approvalRef: string, resourceId: string) {
  const context = resolveRepositoryContext(projectRoot); const state = loadHumanAuthorization(context.commonDir, approvalRef); const scope = state.approval.scope;
  if (scope.kind !== "qualification-run" || !scope.localResources) throw new Error("HUMAN_LOCAL_RESOURCE_SCOPE_REQUIRED");
  const { inventory } = qualificationInventory(projectRoot, scope.localResources);
  const resource = scope.localResources.items.find((item) => item.resourceId === resourceId);
  const progress = Object.hasOwn(state.resourceStates ?? {}, resourceId) ? state.resourceStates![resourceId] : undefined;
  if (!resource || !progress?.identity || !["add-started", "ready"].includes(progress.phase) || progress.branchCreated !== resource.sourceSha) throw new Error("QUALIFICATION_RESOURCE_OWNERSHIP_UNPROVEN");
  if (validateTarget(inventory.hostBinding, resource.path) !== resource.path || hashObject(ownedDirectory(resource.path)) !== hashObject(progress.identity)) throw new Error("QUALIFICATION_RESOURCE_IDENTITY_UNPROVEN");
  const records = parseWorktreePorcelain(inspectGit(projectRoot, ["worktree", "list", "--porcelain", "-z"]));
  const matched = records.filter((record) => record.path === resource.path || record.branch === resource.branch);
  if (matched.length !== 1 || matched[0].path !== resource.path || matched[0].branch !== resource.branch || matched[0].head !== resource.sourceSha ||
      matched[0].bare || matched[0].detached || matched[0].locked || matched[0].prunable) throw new Error("QUALIFICATION_RESOURCE_REGISTRATION_UNPROVEN");
  const gitFile = metadata(join(resource.path, ".git"));
  const match = /^gitdir: (.+)\n$/u.exec(gitFile); const gitDir = match ? resolve(resource.path, match[1]) : "";
  if (dirname(gitDir) !== join(context.commonDir, "worktrees") || realpathSync(gitDir) !== gitDir || !lstatSync(gitDir).isDirectory() ||
      lstatSync(gitDir).isSymbolicLink() || progress.gitDir && progress.gitDir !== gitDir ||
      metadata(join(gitDir, "gitdir")) !== `${join(resource.path, ".git")}\n` ||
      resolve(gitDir, metadata(join(gitDir, "commondir")).trim()) !== context.commonDir ||
      inspectGit(resource.path, ["rev-parse", "--show-toplevel"]).trim() !== resource.path ||
      inspectGit(resource.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim() !== context.commonDir ||
      inspectGit(resource.path, ["symbolic-ref", "HEAD"]).trim() !== `refs/heads/${resource.branch}` ||
      inspectGit(resource.path, ["rev-parse", "HEAD"]).trim() !== resource.sourceSha) throw new Error("QUALIFICATION_RESOURCE_REGISTRATION_UNPROVEN");
  for (const plan of qualificationSourceGraph(scope, resourceId)) validateSyntheticObject(context.commonDir, plan);
  const assets = observeWorkspaceAssets(resource.path);
  if (assets.entries.length || inspectGit(resource.path, ["ls-files", "--stage", "-z"]) ||
      readdirSync(resource.path).some((name) => name !== ".git")) throw new Error("QUALIFICATION_RESOURCE_ASSETS_RETAINED");
  if (hashObject(ownedDirectory(resource.path)) !== hashObject(progress.identity)) throw new Error("QUALIFICATION_RESOURCE_IDENTITY_UNPROVEN");
  const metadataHash = registrationHash(gitDir); const evidenceHash = hashObject({ resource, identity: progress.identity, gitDir, gitFile, assets, metadataHash });
  if (progress.phase === "ready" && progress.evidenceHash !== evidenceHash) throw new Error("QUALIFICATION_RESOURCE_METADATA_DRIFT");
  return { resourceId, path: resource.path, branch: resource.branch, head: resource.sourceSha, commonDir: context.commonDir, gitDir,
    identity: progress.identity, assets, metadataHash, evidenceHash };
}

/** Exact approved resources only; no production flag, extra clone, credential copy or checkout switch. */
export function createQualificationWorkspaceLocked(lock: MutationLock, projectRoot: string, approvalRef: string, resourceId: string) {
  const context = resolveRepositoryContext(projectRoot); assertMutationLock(context, lock);
  const state = loadHumanAuthorization(context.commonDir, approvalRef); const scope = state.approval.scope;
  if (scope.kind !== "qualification-run" || !scope.localResources || !Object.hasOwn(state.resourceStates ?? {}, resourceId)) throw new Error("HUMAN_LOCAL_RESOURCE_SCOPE_REQUIRED");
  if (state.writesClosed || state.revoked) throw new Error("HUMAN_QUALIFICATION_WRITES_CLOSED");
  const resource = scope.localResources.items.find((item) => item.resourceId === resourceId)!;
  const progress = state.resourceStates![resourceId];
  if (progress.importStarted || progress.createStarted || progress.phase !== "reserved") throw new Error("HUMAN_LOCAL_RESOURCE_CREATE_ALREADY_STARTED");
  const native = nativeCoordinationObservers(context, scope.binding);
  const guard = () => {
    assertMutationLock(context, lock);
    const { inventory } = qualificationInventory(projectRoot, scope.localResources);
    if (hashObject(native.observeBinding()) !== hashObject(scope.binding) || validateTarget(inventory.hostBinding, resource.path) !== resource.path) throw new Error("HUMAN_LOCAL_RESOURCE_BINDING_MISMATCH");
    const current = loadHumanAuthorization(context.commonDir, approvalRef);
    if (current.writesClosed || current.revoked || inventory.capacity.used > inventory.capacity.limit) throw new Error("HUMAN_LOCAL_RESOURCE_WRITE_BLOCKED");
    const clock = native.provider.serverClock(); clock.requireBefore(scope.localResources!.expiresAt, 30_000); return clock;
  };
  const record = (fact: ResourceFact) => recordQualificationResourceLocked(lock, context.commonDir, approvalRef, resourceId, fact, native.observeBinding(), native.provider.serverClock());
  const run = (args: string[]) => {
    guard();
    return runGitCommand(context.projectDir, ["--no-optional-locks", "--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
      "-c", "maintenance.auto=false", "-c", "gc.auto=0", ...args], objectEnv());
  };
  guard();
  const { inventory } = qualificationInventory(projectRoot, scope.localResources);
  if (resource.branch === inventory.loadedConfig.config.managementBranch || lstatSync(resource.path, { throwIfNoEntry: false }) ||
      inventory.loadedLeases.values.some((item) => item.path === resource.path || item.branch === resource.branch) ||
      inventory.observedWorktrees.some((item) => item.path === resource.path || item.branch === resource.branch) ||
      inspectGit(projectRoot, ["for-each-ref", "--format=%(refname)", `refs/heads/${resource.branch}`])) throw new Error("WORKTREE_PATH_OR_BRANCH_EXISTS");
  if (inspectGit(projectRoot, ["rev-parse", "--show-object-format"]).trim() !== "sha1") throw new Error("SYNTHETIC_OBJECT_FORMAT_UNSUPPORTED");
  const graph = qualificationSourceGraph(scope, resourceId); const directory = objectDirectory();
  try {
    const transport = new GitHubCoordinationTransport(projectRoot, native.remote, scope.binding.repositoryId, scope.binding.credentialRef);
    const ref = `refs/heads/${resource.branch}`;
    if (transport.readRef(ref) !== resource.sourceSha) throw new Error("QUALIFICATION_SOURCE_REF_MISMATCH");
    transport.fetch(directory, resource.sourceSha); graph.forEach((plan) => validateSyntheticObject(directory, plan));
    if (transport.readRef(ref) !== resource.sourceSha) throw new Error("QUALIFICATION_SOURCE_REF_MISMATCH");
    record({ type: "import-started", commits: graph.map((plan) => plan.commitSha), graphHash: hashObject(graph.map((plan) => plan.objectPlanHash)) });
    try {
      for (const plan of graph) {
        guard();
        if (objectGit(context.commonDir, ["hash-object", "-w", "-t", "tree", "--stdin"], "").trim() !== plan.treeSha ||
            objectGit(context.commonDir, ["hash-object", "-w", "-t", "commit", "--stdin"], plan.commitText).trim() !== plan.commitSha) throw new Error("SYNTHETIC_OBJECT_MISMATCH");
        validateSyntheticObject(context.commonDir, plan);
      }
    } catch (error) { record({ type: "import-result", status: "failed", evidenceHash: hashObject({ error: "IMPORT_FAILED" }) }); throw error; }
    record({ type: "import-result", status: "imported", evidenceHash: hashObject(graph.map((plan) => plan.objectPlanHash)) });
  } finally { rmSync(directory, { recursive: true, force: true }); }
  record({ type: "create-started" }); guard(); mkdirSync(resource.path);
  const identity = ownedDirectory(resource.path); record({ type: "mkdir-owned", identity });
  const created = run(["update-ref", `refs/heads/${resource.branch}`, resource.sourceSha, "0".repeat(resource.sourceSha.length)]);
  if (created.status !== 0 || created.error) throw new Error("QUALIFICATION_RESOURCE_BRANCH_CREATE_FAILED");
  record({ type: "branch-created", head: resource.sourceSha });
  record({ type: "add-started" });
  if (hashObject(ownedDirectory(resource.path)) !== hashObject(identity)) throw new Error("QUALIFICATION_RESOURCE_IDENTITY_UNPROVEN");
  const added = run(["worktree", "add", "--no-checkout", resource.path, resource.branch]);
  let observation: ReturnType<typeof observeQualificationWorkspace>;
  try { observation = observeQualificationWorkspace(projectRoot, approvalRef, resourceId); }
  catch (error) {
    if (added.status !== 0 || added.error) throw new Error("QUALIFICATION_RESOURCE_ADD_FAILED", { cause: { error, status: added.status } });
    throw error;
  }
  record({ type: "ready", gitDir: observation.gitDir, evidenceHash: observation.evidenceHash });
  if (added.status !== 0 || added.error) throw new Error("QUALIFICATION_RESOURCE_ADD_FAILED");
  return observation;
}

export type CloseOutcome = "released" | "retained";
export interface CloseResourceResult {
  resourceId: string;
  path: string;
  branch: string;
  evidenceHash: string;
  outcome: CloseOutcome;
  reason?: string;
}

/** Exact owned-resource close; re-uses the resource-owner apply lock and the same human receipt chain as create. */
export function closeQualificationWorkspaceLocked(lock: MutationLock, projectRoot: string, approvalRef: string, resourceId: string): CloseResourceResult {
  const context = resolveRepositoryContext(projectRoot);
  assertMutationLock(context, lock);                                                // NLC-02
  const state = loadHumanAuthorization(context.commonDir, approvalRef);
  const scope = state.approval.scope;
  if (scope.kind !== "qualification-run" || !scope.localResources) throw new Error("HUMAN_LOCAL_RESOURCE_SCOPE_REQUIRED"); // NLC-04
  const resource = scope.localResources.items.find((item) => item.resourceId === resourceId);
  const progress = state.resourceStates && state.resourceStates[resourceId];
  if (!resource || !progress) throw new Error("HUMAN_LOCAL_RESOURCE_SCOPE_REQUIRED");                                   // NLC-04
  if (state.revoked) throw new Error("HUMAN_AUTHORIZATION_REVOKED");                                                    // NLC-03
  if (!state.writesClosed) throw new Error("HUMAN_QUALIFICATION_WRITES_OPEN");                                          // NLC-03
  if (progress.phase === "released") {                                                                                  // NLC-14 + NLC-13
    return {
      resourceId, path: resource.path, branch: resource.branch,
      evidenceHash: progress.evidenceHash ?? hashObject({ alreadyReleased: true, resourceId, path: resource.path, branch: resource.branch }),
      outcome: "released",
    };
  }
  if (progress.retained && progress.phase !== "ready") {                                                                // NLC-12
    return {
      resourceId, path: resource.path, branch: resource.branch,
      evidenceHash: progress.retained.evidenceHash,
      outcome: "retained", reason: progress.retained.reason,
    };
  }
  const native = nativeCoordinationObservers(context, scope.binding);
  const clock = native.provider.serverClock();
  const record = (fact: ResourceFact) => recordQualificationResourceLocked(lock, context.commonDir, approvalRef, resourceId, fact, native.observeBinding(), clock);
  const run = (args: string[]) => runGitCommand(context.projectDir, [
    "--no-optional-locks", "--no-replace-objects",
    "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
    "-c", "maintenance.auto=false", "-c", "gc.auto=0",
    ...args,
  ], objectEnv());
  const lastRecordHash = (): string | null => {
    const records = readLkgChain({ root: context.commonDir, domain: "approval-human" }).filter((record) => record.transactionId === approvalRef);
    return records.length ? records[records.length - 1].recordHash : null;
  };
  const observedAt = () => new Date(Math.floor(clock.bounds().lowerMs)).toISOString();
  if (progress.phase === "reserved") {                                                                                // NLC-05
    const evidenceHash = hashObject({ resourceId, path: resource.path, branch: resource.branch, sourceSha: resource.sourceSha,
      worktreeRemoved: false, branchRemoved: false, recordedAt: lastRecordHash(), observedAt: observedAt() });
    record({ type: "released", evidenceHash });
    return { resourceId, path: resource.path, branch: resource.branch, evidenceHash, outcome: "released" };
  }
  if (progress.phase !== "ready") throw new Error("QUALIFICATION_RESOURCE_CLOSE_PHASE_NOT_READY");
  validateBranch(context.projectDir, resource.branch);
  const hostBinding = workspaceLocalInventory(projectRoot, true).hostBinding;
  if (validateTarget(hostBinding, resource.path) !== resource.path) throw new Error("HUMAN_LOCAL_RESOURCE_BINDING_MISMATCH");
  const pathStat = lstatSync(resource.path, { throwIfNoEntry: false });                                                 // NLC-08
  if (pathStat && !pathStat.isDirectory()) throw new Error("LOCAL_PATH_REPLACED");
  const currentBranch = inspectGit(context.projectDir, ["rev-parse", "--verify", `refs/heads/${resource.branch}^{commit}`], true).trim(); // NLC-07
  if (currentBranch && currentBranch !== resource.sourceSha) throw new Error("BRANCH_REF_DRIFT");
  const porcelain = parseWorktreePorcelain(inspectGit(context.projectDir, ["worktree", "list", "--porcelain", "-z"]));
  const matching = porcelain.filter((record) => record.path === resource.path);
  if (matching.length && matching.some((record) => record.head !== resource.sourceSha)) throw new Error("WORKTREE_HEAD_DRIFT");
  let worktreeRemoved = false;                                                                                          // NLC-06 (a)
  if (pathStat) {
    const removed = run(["worktree", "remove", resource.path]);
    if (removed.status === 0) worktreeRemoved = true;
    else if (/did not exist/i.test(removed.stderr ?? "")) worktreeRemoved = true;
    else throw new Error("WORKTREE_REMOVE_FAILED");                                                                     // NLC-09
  } else worktreeRemoved = true;
  const deleted = run(["update-ref", "-d", `refs/heads/${resource.branch}`, resource.sourceSha]);                       // NLC-06 (b)
  let branchRemoved = false;
  if (deleted.status === 0) branchRemoved = true;
  else if (/reference does not exist/i.test(deleted.stderr ?? "")) branchRemoved = true;
  else throw new Error("BRANCH_DELETE_FAILED");                                                                         // NLC-10
  if (progress.gitDir && lstatSync(progress.gitDir, { throwIfNoEntry: false })) throw new Error("GITDIR_REGISTERED_AFTER_CLOSE"); // NLC-11
  const evidenceHash = hashObject({                                                                                     // NLC-06 (d)
    resourceId, path: resource.path, branch: resource.branch, sourceSha: resource.sourceSha,
    worktreeRemoved, branchRemoved, recordedAt: lastRecordHash(), observedAt: observedAt(),
  });
  record({ type: "released", evidenceHash });
  return { resourceId, path: resource.path, branch: resource.branch, evidenceHash, outcome: "released" };
}
