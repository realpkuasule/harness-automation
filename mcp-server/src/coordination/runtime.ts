import { assertHumanCandidateScope, assertHumanWritesOpen, loadHumanAuthorization, type HumanScopeBinding } from "../approval/human.js";
import { loadCredentialHostBinding } from "../credentials/host_binding.js";
import { currentHarnessArtifact } from "../repository/artifact.js";
import { assertMutationLock, type MutationLock } from "../recovery/service.js";
import { resolveRepositoryContext, type RepositoryContext } from "../repository/git.js";
import { githubEndpointRepository, remotePushEndpoint } from "../repository/remote.js";
import { hashObject } from "../v2/fs.js";
import { humanCoordinationGuards, recoverHumanSyntheticWrite } from "./authorization.js";
import { GitHubCoordinationReader } from "./github.js";
import { coordinationHistoryCheck } from "./history.js";
import { CoordinationLifecycleService, loadCoordinationConfig } from "./service.js";
import { GitCoordinationStore } from "./store.js";
import { GitHubCoordinationTransport } from "./transport.js";
import { observeQualificationEpoch, qualificationOperationAuthority } from "./authority.js";
import { handoffObservers } from "./handoff.js";
import type { ManagedWriteContext } from "./writer.js";
import { prepareTakeover } from "./takeover.js";
import { approvedControlGenesis, approvedSyntheticPublication } from "./synthetic.js";
import { runApprovedSourceFixture } from "./publication.js";

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

export function nativeCoordinationObservers(context: RepositoryContext, approved: HumanScopeBinding) {
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
  const genesis = approvedControlGenesis(scope.synthetic, controlRef);
  const { remote, observeBinding, binding, provider } = nativeCoordinationObservers(context, scope.binding);
  const authority = qualificationOperationAuthority(context.projectDir, binding, observeBinding, () => provider.serverClock());
  const guards = humanCoordinationGuards(context.commonDir, approvalRef, observeBinding, () => provider.serverClock(), held, (intent) => {
    if (intent.subject.kind === "coordination-record") authority.assertCandidate(intent);
    else assertHumanCandidateScope(loadHumanAuthorization(context.commonDir, approvalRef).approval.scope, intent);
  });
  const transport = new GitHubCoordinationTransport(context.projectDir, remote, binding.repositoryId, binding.credentialRef, guards.authorizeWrite);
  const store = new GitCoordinationStore(controlRef, transport, guards.beforePush, genesis, coordinationHistoryCheck(context.commonDir,
    { validationVersion: "coordination-history/2", genesis, endpointHash: binding.endpointHash, repository: binding.repository, repositoryId: binding.repositoryId, controlRef }), guards.beforeCommit);
  const handoff = handoffObservers(context, held, transport, observeBinding, () => provider.serverClock());
  const writer: ManagedWriteContext = { context, store, refreshClock: () => provider.serverClock(), observeAuthority: (record) => {
    const current = loadHumanAuthorization(context.commonDir, approvalRef); const observed = observeBinding();
    assertHumanWritesOpen(context.commonDir, current);
    if (current.revoked || hashObject(observed) !== hashObject(current.approval.scope.binding)) throw new Error("HUMAN_AUTHORIZATION_BINDING_MISMATCH");
    if (current.approval.scope.kind !== "qualification-run" || !current.approval.scope.refs.includes(`refs/heads/${record.branch}`)) throw new Error("COORDINATION_SOURCE_WRITE_SCOPE_REQUIRED");
    if (current.attempts.some((attempt) => !attempt.outcome || attempt.outcome.status === "unknown") ||
        current.candidates.some((candidate) => !candidate.result || candidate.result.status === "unknown")) throw new Error("HUMAN_WRITE_OUTCOME_UNRESOLVED");
    provider.serverClock().requireBefore(current.approval.scope.expiresAt); return observed;
  } };
  return { context, binding, store, provider, writer,
    bootstrap: () => store.bootstrap(approvedSyntheticPublication(scope.synthetic!, genesis.metadata.objectId).publication, guards.beforeSyntheticPush),
    sourceFixture: (fixtureId: string) => runApprovedSourceFixture(transport, scope.synthetic!, fixtureId, guards.beforeCommit, guards.beforeSyntheticPush),
    recoverSynthetic: (attemptId: string) => recoverHumanSyntheticWrite(context.commonDir, approvalRef, attemptId, store, transport, held),
    lifecycle: new CoordinationLifecycleService(store, () => provider.serverClock(), provider, authority.prepare, handoff) };
}

/** Exact isolated takeover sub-ticket. Production will additionally consume its adopted configuration, never this ticket alone. */
export function createTakeoverRuntime(projectRoot: string, approvalRef: string, held: MutationLock) {
  const context = resolveRepositoryContext(projectRoot); assertMutationLock(context, held);
  const state = loadHumanAuthorization(context.commonDir, approvalRef); const scope = state.approval.scope;
  if (scope.kind !== "takeover") throw new Error("COORDINATION_TAKEOVER_APPROVAL_REQUIRED");
  if (!scope.qualification) throw new Error("COORDINATION_PRODUCTION_ADOPTION_REQUIRED");
  if (state.revoked) throw new Error("HUMAN_AUTHORIZATION_BINDING_MISMATCH");
  const parent = loadHumanAuthorization(context.commonDir, scope.qualification.parentApprovalRef).approval.scope;
  const genesis = approvedControlGenesis(parent.kind === "qualification-run" ? parent.synthetic : undefined, scope.controlRef);
  if (genesis.commitSha !== scope.qualification.genesisSha) throw new Error("HUMAN_PARENT_SCOPE_MISMATCH");
  const { remote, observeBinding, binding, provider } = nativeCoordinationObservers(context, scope.binding);
  let prepared: ReturnType<typeof prepareTakeover> | undefined;
  const guards = humanCoordinationGuards(context.commonDir, approvalRef, observeBinding, () => provider.serverClock(), held, (intent) => {
    if (!prepared) throw new Error("COORDINATION_OPERATION_AUTHORITY_REQUIRED"); prepared.assertCandidate(intent);
  }, "takeover");
  const transport = new GitHubCoordinationTransport(context.projectDir, remote, binding.repositoryId, binding.credentialRef, guards.authorizeWrite);
  const store = new GitCoordinationStore(scope.controlRef, transport, guards.beforePush, genesis, coordinationHistoryCheck(context.commonDir,
    { validationVersion: "coordination-history/2", genesis, endpointHash: binding.endpointHash, repository: binding.repository, repositoryId: binding.repositoryId, controlRef: scope.controlRef }), guards.beforeCommit);
  return { context, binding, store, provider, takeover() {
    prepared = undefined; prepared = prepareTakeover(context, held, approvalRef, store, transport, observeBinding, () => provider.serverClock());
    return prepared.apply();
  } };
}
