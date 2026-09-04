import { loadHumanAuthorization, type HumanScopeBinding } from "../approval/human.js";
import { loadCredentialHostBinding } from "../credentials/host_binding.js";
import { currentHarnessArtifact } from "../repository/artifact.js";
import { assertMutationLock, type MutationLock } from "../recovery/service.js";
import { resolveRepositoryContext, type RepositoryContext } from "../repository/git.js";
import { githubEndpointRepository, remotePushEndpoint } from "../repository/remote.js";
import { hashObject } from "../v2/fs.js";
import { humanCoordinationGuards } from "./authorization.js";
import { GitHubCoordinationReader } from "./github.js";
import { validateCoordinationHistory } from "./history.js";
import { CoordinationLifecycleService, loadCoordinationConfig } from "./service.js";
import { GitCoordinationStore } from "./store.js";
import { GitHubCoordinationTransport } from "./transport.js";
import { observeQualificationEpoch, qualificationOperationAuthority } from "./authority.js";
import { handoffObservers } from "./handoff.js";
import type { ManagedWriteContext } from "./writer.js";
import { prepareTakeover } from "./takeover.js";

/** Non-secret observation; all identity comes from the actual checkout, approved host binding and running artifact. */
export function observeCoordinationBinding(projectRoot: string, remote: string, repositoryId: string, credentialId: string): HumanScopeBinding {
  const { commonDir, projectDir } = resolveRepositoryContext(projectRoot); const endpoint = remotePushEndpoint(projectDir, remote);
  const repository = githubEndpointRepository(endpoint.value, remote);
  const registered = loadCredentialHostBinding(commonDir, { repository, repositoryId, endpointHash: endpoint.hash });
  const credential = registered.credentials.find((ref) => ref.id === credentialId && ref.purpose === "git-transport");
  if (!credential) throw new Error("CREDENTIAL_REF_UNREGISTERED");
  const configHash = hashObject(loadCoordinationConfig(projectDir));
  return { commonDir, repository, repositoryId, endpointHash: endpoint.hash, credentialBindingHash: registered.bindingHash,
    credentialRef: credential.id, credentialPurpose: "git-transport", actor: credential.identity, hostId: registered.hostId,
    configHash, controlEpoch: observeQualificationEpoch(projectDir, configHash), ...currentHarnessArtifact() };
}

function nativeObservers(context: RepositoryContext, approved: HumanScopeBinding) {
  const remote = loadCoordinationConfig(context.projectDir)?.remote ?? "origin";
  const observeBinding = () => observeCoordinationBinding(context.projectDir, remote, approved.repositoryId, approved.credentialRef);
  const binding = observeBinding();
  if (hashObject(binding) !== hashObject(approved)) throw new Error("HUMAN_AUTHORIZATION_BINDING_MISMATCH");
  const registered = loadCredentialHostBinding(context.commonDir, binding);
  const api = registered.credentials.filter((ref) => ref.purpose === "github-api" && ref.identity === binding.actor);
  if (api.length !== 1) throw new Error("COORDINATION_API_CREDENTIAL_REQUIRED");
  return { remote, observeBinding, binding, provider: new GitHubCoordinationReader(context.projectDir, remote, binding.repositoryId, api[0].id) };
}

/** No production-enabled flag or injected Provider: the bounded ticket alone authorizes the first qualification write. */
export function createQualificationRuntime(projectRoot: string, approvalRef: string, controlRef: string, held?: MutationLock) {
  const context = resolveRepositoryContext(projectRoot); const state = loadHumanAuthorization(context.commonDir, approvalRef);
  if (held) assertMutationLock(context, held);
  const scope = state.approval.scope;
  if (scope.kind !== "qualification-run" || !scope.refs.includes(controlRef)) throw new Error("COORDINATION_QUALIFICATION_SCOPE_REQUIRED");
  if (state.revoked) throw new Error("HUMAN_AUTHORIZATION_BINDING_MISMATCH");
  const { remote, observeBinding, binding, provider } = nativeObservers(context, scope.binding);
  const authority = qualificationOperationAuthority(context.projectDir, binding, observeBinding, () => provider.serverClock());
  const guards = humanCoordinationGuards(context.commonDir, approvalRef, observeBinding, () => provider.serverClock(), held, authority.assertCandidate);
  const transport = new GitHubCoordinationTransport(context.projectDir, remote, binding.repositoryId, binding.credentialRef, guards.authorizeWrite);
  const store = new GitCoordinationStore(controlRef, transport, guards.beforePush, true, (head, readValidatedCommit, isAncestor) => {
    const history = loadHumanAuthorization(context.commonDir, approvalRef);
    const bootstrap = history.attempts.find((attempt) => attempt.operation === "create" && attempt.ref === controlRef);
    const candidate = history.candidates.find((item) => item.candidateId === bootstrap?.candidateId && item.parentSha === null);
    if (!bootstrap?.head || candidate?.result?.head !== bootstrap.head) throw new Error("COORDINATION_RUN_GENESIS_REQUIRED");
    const checked = validateCoordinationHistory({ commonDir: context.commonDir, anchor: { validationVersion: "coordination-history/1",
      genesisSha: bootstrap.head, repository: binding.repository, repositoryId: binding.repositoryId, controlRef }, head, readValidatedCommit, isAncestor });
    if (checked.status !== "verified") throw new Error("COORDINATION_HISTORY_VALIDATION_PENDING");
  }, guards.beforeCommit);
  const handoff = handoffObservers(context, held, transport, observeBinding, () => provider.serverClock());
  const writer: ManagedWriteContext = { context, store, refreshClock: () => provider.serverClock(), observeAuthority: (record) => {
    const current = loadHumanAuthorization(context.commonDir, approvalRef); const observed = observeBinding();
    if (current.revoked || hashObject(observed) !== hashObject(current.approval.scope.binding)) throw new Error("HUMAN_AUTHORIZATION_BINDING_MISMATCH");
    if (current.approval.scope.kind !== "qualification-run" || !current.approval.scope.refs.includes(`refs/heads/${record.branch}`)) throw new Error("COORDINATION_SOURCE_WRITE_SCOPE_REQUIRED");
    if (current.attempts.some((attempt) => !attempt.outcome || attempt.outcome.status === "unknown") ||
        current.candidates.some((candidate) => !candidate.result || candidate.result.status === "unknown")) throw new Error("HUMAN_WRITE_OUTCOME_UNRESOLVED");
    provider.serverClock().requireBefore(current.approval.scope.expiresAt); return observed;
  } };
  return { context, binding, store, provider, writer, lifecycle: new CoordinationLifecycleService(store, () => provider.serverClock(), provider, authority.prepare, handoff) };
}

/** Exact isolated takeover sub-ticket. Production will additionally consume its adopted configuration, never this ticket alone. */
export function createTakeoverRuntime(projectRoot: string, approvalRef: string, held: MutationLock) {
  const context = resolveRepositoryContext(projectRoot); assertMutationLock(context, held);
  const state = loadHumanAuthorization(context.commonDir, approvalRef); const scope = state.approval.scope;
  if (scope.kind !== "takeover") throw new Error("COORDINATION_TAKEOVER_APPROVAL_REQUIRED");
  if (!scope.qualification) throw new Error("COORDINATION_PRODUCTION_ADOPTION_REQUIRED");
  if (state.revoked) throw new Error("HUMAN_AUTHORIZATION_BINDING_MISMATCH");
  const { remote, observeBinding, binding, provider } = nativeObservers(context, scope.binding);
  let prepared: ReturnType<typeof prepareTakeover> | undefined;
  const guards = humanCoordinationGuards(context.commonDir, approvalRef, observeBinding, () => provider.serverClock(), held, (intent) => {
    if (!prepared) throw new Error("COORDINATION_OPERATION_AUTHORITY_REQUIRED"); prepared.assertCandidate(intent);
  }, "takeover");
  const transport = new GitHubCoordinationTransport(context.projectDir, remote, binding.repositoryId, binding.credentialRef, guards.authorizeWrite);
  const store = new GitCoordinationStore(scope.controlRef, transport, guards.beforePush, false, (head, readValidatedCommit, isAncestor) => {
    const checked = validateCoordinationHistory({ commonDir: context.commonDir, anchor: { validationVersion: "coordination-history/1",
      genesisSha: scope.qualification!.genesisSha, repository: binding.repository, repositoryId: binding.repositoryId, controlRef: scope.controlRef },
    head, readValidatedCommit, isAncestor });
    if (checked.status !== "verified") throw new Error("COORDINATION_HISTORY_VALIDATION_PENDING");
  }, guards.beforeCommit);
  return { context, binding, store, provider, takeover() {
    prepared = undefined; prepared = prepareTakeover(context, held, approvalRef, store, transport, observeBinding, () => provider.serverClock());
    return prepared.apply();
  } };
}
