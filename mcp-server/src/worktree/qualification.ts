import { lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { qualificationResourcesSchema } from "../approval/human_scope.js";
import { loadHumanAuthorization, reserveQualificationResourcesLocked, type HumanScopeBinding } from "../approval/human.js";
import type { CoordinationClock } from "../coordination/clock.js";
import { assertMutationLock, type MutationLock } from "../recovery/service.js";
import { inspectGit } from "../repository/assets.js";
import { fileHash } from "../v2/fs.js";
import { validateBranch, validateTarget, workspaceLocalInventory } from "./service.js";

/** Read-only path/capacity admission, using the same rules as normal delivery and no Provider call. */
export function preflightQualificationResources(projectRoot: string, input: unknown) {
  const resources = qualificationResourcesSchema.parse(input); const inventory = workspaceLocalInventory(projectRoot, true);
  const { root, commonDir, loadedConfig, loadedLeases, hostBinding, qualificationResources, observedWorktrees } = inventory;
  if (root !== resources.authorityRoot || commonDir !== resources.commonDir) throw new Error("HUMAN_LOCAL_RESOURCE_BINDING_MISMATCH");
  if (!loadedConfig.configured || loadedConfig.config.mode !== "enforced") throw new Error("WORKTREE_ENFORCEMENT_NOT_ENABLED");
  if (!hostBinding.configured) throw new Error("WORKTREE_HOST_BINDING_REQUIRED");
  if (fileHash(join(root, ".harness/worktree-delivery.json")) !== resources.configHash || hostBinding.hash !== resources.hostBindingHash) throw new Error("HUMAN_LOCAL_RESOURCE_POLICY_DRIFT");
  if (loadedLeases.errors.length) throw new Error("WORKSPACE_DRIFT");
  if (resources.items.length > resources.maxConcurrent || inventory.capacity.available < resources.items.length) throw new Error("WORKTREE_CAPACITY_EXCEEDED");
  for (const item of resources.items) {
    validateBranch(root, item.branch);
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
