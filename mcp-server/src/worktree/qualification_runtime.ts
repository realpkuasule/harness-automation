import { assertMutationLock, acquireMutationLock, releaseMutationLock, type MutationLock } from "../recovery/service.js";
import { loadHumanAuthorization, qualificationResourceReservations } from "../approval/human.js";
import { resolveRepositoryContext } from "../repository/git.js";
import { hashObject } from "../v2/fs.js";
import { CoordinationClock } from "../coordination/clock.js";
import {
  closeQualificationWorkspaceLocked,
  createQualificationWorkspaceLocked,
  observeQualificationWorkspace,
  preflightQualificationResources,
  reserveQualificationWorkspacesLocked,
} from "./qualification.js";
import type { CloseResourceResult } from "./qualification.js";

/** Authority-side context projected from the approved qualification scope. */
export interface AuthorityContext {
  readonly commonDir: string;
  readonly repository: string;
  readonly repositoryId: string;
  readonly hostId: string;
  readonly controlEpochDigest: string;
  readonly credentialBindingHash: string;
  readonly endpointHash: string;
  readonly configHash: string;
  readonly artifactDigest: string;
  readonly runnerHash: string;
  readonly observedAt: string;
}

/** Workspace-side context projected from the approved qualification scope. */
export interface WorkspaceContext {
  readonly approvalRef: string;
  readonly resourceIds: ReadonlyArray<string>;
  readonly observedHeads: Readonly<Record<string, string>>;
  readonly reservedAt: string | undefined;
}

/** Read-only snapshot of the runtime's authority + workspace + current reservations. */
export interface RuntimeSnapshot {
  readonly authority: AuthorityContext;
  readonly workspace: WorkspaceContext;
  readonly reservations: ReadonlyArray<ReturnType<typeof qualificationResourceReservations>[number]>;
  readonly observedAt: string;
}

/** Public runtime handle. Opaque + process-local; cannot be JSON-serialized or reconstructed. */
export interface QualificationWorkspaceRuntime {
  readonly authority: AuthorityContext;
  readonly workspace: WorkspaceContext;
  snapshot(): RuntimeSnapshot;
  preflight(input: unknown): ReturnType<typeof preflightQualificationResources>;
  reserve(lock: MutationLock): void;
  allocate(lock: MutationLock, resourceId: string): ReturnType<typeof createQualificationWorkspaceLocked>;
  observe(resourceId: string): ReturnType<typeof observeQualificationWorkspace>;
  close(lock: MutationLock, resourceId: string): CloseResourceResult;
  dispose(): void;
}

const runtimeStates = new WeakMap<QualificationWorkspaceRuntime, RuntimeState>();
interface RuntimeState {
  projectRoot: string;
  approvalRef: string;
  heldLock: MutationLock | null;
  internalLock: MutationLock | null;
  disposed: boolean;
  clock: CoordinationClock;
}

function revalidate(state: RuntimeState): void {
  if (state.disposed) throw new Error("HUMAN_QUALIFICATION_WORKSPACE_RUNTIME_DISPOSED");
  const auth = loadHumanAuthorization(resolveRepositoryContext(state.projectRoot).commonDir, state.approvalRef);
  const scope = auth.approval.scope;
  if (scope.kind !== "qualification-run" || !scope.localResources) throw new Error("HUMAN_QUALIFICATION_WORKSPACE_RUNTIME_INVALID");
  if (auth.revoked) throw new Error("HUMAN_AUTHORIZATION_REVOKED");
  if (!auth.resourcesReservedAt) throw new Error("HUMAN_LOCAL_RESOURCES_NOT_RESERVED");
  if (state.heldLock) {
    assertMutationLock(resolveRepositoryContext(state.projectRoot), state.heldLock);
  }
}

function requireResource(state: RuntimeState, resourceId: string): void {
  revalidate(state);
  const scope = loadHumanAuthorization(resolveRepositoryContext(state.projectRoot).commonDir, state.approvalRef).approval.scope;
  if (scope.kind !== "qualification-run" || !scope.localResources) throw new Error("HUMAN_QUALIFICATION_WORKSPACE_RUNTIME_INVALID");
  if (!scope.localResources.items.some((item) => item.resourceId === resourceId)) {
    throw new Error("HUMAN_LOCAL_RESOURCE_SCOPE_REQUIRED");
  }
}

function buildContexts(projectRoot: string, approvalRef: string): { authority: AuthorityContext; workspace: WorkspaceContext } {
  const context = resolveRepositoryContext(projectRoot);
  const auth = loadHumanAuthorization(context.commonDir, approvalRef);
  const scope = auth.approval.scope;
  if (scope.kind !== "qualification-run" || !scope.localResources) {
    throw new Error("HUMAN_QUALIFICATION_WORKSPACE_RUNTIME_INVALID");
  }
  const observedAt = new Date().toISOString();
  const authority: AuthorityContext = Object.freeze({
    commonDir: context.commonDir,
    repository: scope.binding.repository,
    repositoryId: scope.binding.repositoryId,
    hostId: scope.binding.hostId,
    controlEpochDigest: hashObject(scope.binding.controlEpoch),
    credentialBindingHash: scope.binding.credentialBindingHash,
    endpointHash: scope.binding.endpointHash,
    configHash: scope.binding.configHash,
    artifactDigest: scope.binding.implementation.kind === "package" ? scope.binding.implementation.artifactDigest : "",
    runnerHash: scope.binding.runnerHash,
    observedAt,
  });
  const heads: Record<string, string> = {};
  for (const item of scope.localResources.items) {
    if (item.sourceSha) heads[item.resourceId] = item.sourceSha;
  }
  const workspace: WorkspaceContext = Object.freeze({
    approvalRef,
    resourceIds: Object.freeze(scope.localResources.items.map((item) => item.resourceId)),
    observedHeads: Object.freeze(heads),
    reservedAt: auth.resourcesReservedAt,
  });
  return { authority, workspace };
}

/**
 * Open a scoped workspace runtime for one approved `qualification-run` scope. The runtime
 * is opaque + process-local; two runtimes for the same approval observe the same
 * authority + workspace but acquire their own assertion tokens.
 */
export function createQualificationWorkspaceRuntime(
  projectRoot: string,
  approvalRef: string,
  held?: MutationLock,
): QualificationWorkspaceRuntime {
  const context = resolveRepositoryContext(projectRoot);
  if (held) assertMutationLock(context, held);
  const auth = loadHumanAuthorization(context.commonDir, approvalRef);
  const scope = auth.approval.scope;
  if (scope.kind !== "qualification-run" || !scope.localResources) {
    throw new Error("HUMAN_QUALIFICATION_WORKSPACE_RUNTIME_INVALID");
  }
  if (auth.revoked) {
    throw new Error("HUMAN_AUTHORIZATION_REVOKED");
  }
  if (!auth.resourcesReservedAt) {
    throw new Error("HUMAN_LOCAL_RESOURCES_NOT_RESERVED");
  }
  if (scope.localResources.configHash !== scope.binding.configHash) {
    throw new Error("HUMAN_AUTHORIZATION_BINDING_MISMATCH");
  }

  const internalLock = held ? null : acquireMutationLock(context);
  const clock = new CoordinationClock(() => ({ monotonicMs: 0, wallMs: 0 }));
  const state: RuntimeState = {
    projectRoot,
    approvalRef,
    heldLock: held ?? null,
    internalLock,
    disposed: false,
    clock,
  };

  const { authority, workspace } = buildContexts(projectRoot, approvalRef);

  const handle: QualificationWorkspaceRuntime = Object.freeze(Object.defineProperties(Object.create(null), {
    authority: { value: authority, enumerable: false, writable: false, configurable: false },
    workspace: { value: workspace, enumerable: false, writable: false, configurable: false },
    snapshot: { value(): RuntimeSnapshot {
      revalidate(state);
      return Object.freeze({
        authority,
        workspace,
        reservations: Object.freeze(qualificationResourceReservations(context.commonDir).slice()),
        observedAt: new Date().toISOString(),
      });
    }, enumerable: false, writable: false, configurable: false },
    preflight: { value(input: unknown) {
      revalidate(state);
      return preflightQualificationResources(state.projectRoot, input);
    }, enumerable: false, writable: false, configurable: false },
    reserve: { value(lock: MutationLock) {
      revalidate(state);
      assertMutationLock(context, lock);
      reserveQualificationWorkspacesLocked(lock, state.projectRoot, state.approvalRef, scope.binding, state.clock);
    }, enumerable: false, writable: false, configurable: false },
    allocate: { value(lock: MutationLock, resourceId: string) {
      requireResource(state, resourceId);
      assertMutationLock(context, lock);
      return createQualificationWorkspaceLocked(lock, state.projectRoot, state.approvalRef, resourceId);
    }, enumerable: false, writable: false, configurable: false },
    observe: { value(resourceId: string) {
      requireResource(state, resourceId);
      return observeQualificationWorkspace(state.projectRoot, state.approvalRef, resourceId);
    }, enumerable: false, writable: false, configurable: false },
    close: { value(lock: MutationLock, resourceId: string): CloseResourceResult {
      requireResource(state, resourceId);
      assertMutationLock(context, lock);
      return closeQualificationWorkspaceLocked(lock, state.projectRoot, state.approvalRef, resourceId);
    }, enumerable: false, writable: false, configurable: false },
    dispose: { value() {
      if (state.disposed) return;
      state.disposed = true;
      if (state.internalLock) {
        releaseMutationLock(state.internalLock);
        state.internalLock = null;
      }
    }, enumerable: false, writable: false, configurable: false },
  }));

  runtimeStates.set(handle, state);
  return handle;
}