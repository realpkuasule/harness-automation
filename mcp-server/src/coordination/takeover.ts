import { assertHumanWritesOpen, loadHumanAuthorization, type HumanScope, type HumanScopeBinding } from "../approval/human.js";
import { assertMutationLock, type MutationLock } from "../recovery/service.js";
import { inspectGit, observeWorkspaceAssets } from "../repository/assets.js";
import { resolveRepositoryContext, type RepositoryContext } from "../repository/git.js";
import { hashObject } from "../v2/fs.js";
import { assertCoordinationIdentity, assertCoordinationWorkspace, controlEpochDigest } from "./authority.js";
import type { CoordinationClock } from "./clock.js";
import { requireWriteLease } from "./leases.js";
import { assertExpected, coordinationRecordSchema, createCoordinationRecord, expectedRecord, recordWithoutHash } from "./record.js";
import type { CoordinationCommitIntent, CoordinationTransport, GitCoordinationStore } from "./store.js";
import type { CoordinationRecord } from "./types.js";
import { takeoverRiskSchema } from "./takeover_record.js";

type SourceReader = Pick<CoordinationTransport, "readRef" | "repositoryId">;

/** Local target facts only; not opening a source machine is explicitly unknown, never evidence of offline/clean. */
export function observeTakeoverRisk(context: RepositoryContext, held: MutationLock, current: CoordinationRecord,
  source: SourceReader, binding: HumanScopeBinding) {
  assertMutationLock(context, held);
  if (hashObject(resolveRepositoryContext(context.projectDir)) !== hashObject(context) || binding.commonDir !== context.commonDir ||
      current.repository !== binding.repository || current.repositoryId !== binding.repositoryId) throw new Error("COORDINATION_WORKSPACE_BINDING_MISMATCH");
  if (source.repositoryId !== current.sourceRepositoryId) throw new Error("COORDINATION_SOURCE_REPOSITORY_BINDING_REQUIRED");
  const head = inspectGit(context.projectDir, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
  const ref = `refs/heads/${current.branch}`;
  if (inspectGit(context.projectDir, ["symbolic-ref", "--quiet", "HEAD"]).trim() !== ref) throw new Error("COORDINATION_WORKSPACE_HEAD_MISMATCH");
  const remoteHead = coordinationRecordSchema.shape.lastObservedHead.parse(source.readRef(ref));
  // Missing remote objects require an explicit authenticated fetch before planning; failure is never a zero count.
  const counts = inspectGit(context.projectDir, ["rev-list", "--left-right", "--count", `${remoteHead}...${head}`]).trim().split(/\s+/u);
  if (counts.length !== 2 || counts.some((value) => !/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value)))) throw new Error("WORKSPACE_ASSET_OBSERVATION_FAILED");
  const assets = observeWorkspaceAssets(context.projectDir);
  if (source.readRef(ref) !== remoteHead || inspectGit(context.projectDir, ["rev-parse", "--verify", "HEAD^{commit}"]).trim() !== head ||
      inspectGit(context.projectDir, ["symbolic-ref", "--quiet", "HEAD"]).trim() !== ref) throw new Error("WORKSPACE_ASSET_CHANGED");
  assertMutationLock(context, held);
  return takeoverRiskSchema.parse({ schemaVersion: "takeover-risk/1", target: {
    workspace: context.projectDir, commonDir: context.commonDir, actor: binding.actor, hostId: binding.hostId, branch: current.branch, head,
    assets, handling: "retain-all-assets", uniqueCommits: Number(counts[1]), unpushedCommits: Number(counts[1]), remoteOnlyCommits: Number(counts[0]),
  }, remote: { repositoryId: source.repositoryId, endpointHash: binding.endpointHash, ref, head: remoteHead },
  source: { kind: "not-observed", reason: "source-machine-not-accessed", historicalProofHash: current.handoff?.sourceProof?.proofHash },
  risks: ["source-assets-unknown", "external-writers-not-fenced", "old-assets-retained", "not-zero-loss-transfer"] });
}

/** Native composition supplies observers; the only user input is a durable approval reference. */
export function prepareTakeover(context: RepositoryContext, held: MutationLock, approvalRef: string, store: GitCoordinationStore,
  source: SourceReader, observeBinding: () => HumanScopeBinding, refreshClock: () => CoordinationClock) {
  assertMutationLock(context, held);
  const loaded = loadHumanAuthorization(context.commonDir, approvalRef).approval.scope;
  if (loaded.kind !== "takeover") throw new Error("COORDINATION_TAKEOVER_APPROVAL_REQUIRED");
  const approved: Extract<HumanScope, { kind: "takeover" }> = loaded;
  const current = store.read(approved.workItem);
  if (!current.record || current.record.expiresAt === null) throw new Error("COORDINATION_TAKEOVER_TERMINAL_OR_ABSENT");
  const previous = current.record;
  if (previous.lifecycleState === "MergeArmed") throw new Error("COORDINATION_DISARM_REQUIRED");
  if (["Prepared", "Draft"].includes(previous.lifecycleState)) throw new Error("COORDINATION_DELIVERY_MAPPING_OBSERVER_REQUIRED");
  function validate(): Extract<HumanScope, { kind: "takeover" }> {
    assertMutationLock(context, held);
    const state = loadHumanAuthorization(context.commonDir, approvalRef); const scope = state.approval.scope; const binding = observeBinding();
    assertHumanWritesOpen(context.commonDir, state);
    if (state.revoked || hashObject(scope) !== hashObject(approved) || hashObject(binding) !== hashObject(approved.binding)) throw new Error("HUMAN_AUTHORIZATION_BINDING_MISMATCH");
    if (current.controlSha !== approved.expectedControlSha) throw new Error("COORDINATION_CAS_CONFLICT");
    assertExpected(previous, approved.expected);
    if (previous.sourceRepositoryId !== approved.sourceRepositoryId || previous.branch !== approved.targetBranch ||
        approved.targetWorkspace !== context.projectDir || approved.newEpochDigest !== controlEpochDigest(binding.controlEpoch)) throw new Error("COORDINATION_TAKEOVER_SCOPE_MISMATCH");
    const risk = observeTakeoverRisk(context, held, previous, source, binding);
    if (hashObject(risk) !== approved.assetRiskHash) throw new Error("COORDINATION_TAKEOVER_ASSET_DRIFT");
    refreshClock().requireBefore(approved.expiresAt); return approved;
  }
  validate(); const bounds = refreshClock().requireBefore(approved.expiresAt);
  const end = Math.floor(Math.min(bounds.lowerMs + approved.newLease.ttlMs, Date.parse(approved.newLease.notAfter)));
  if (!Number.isSafeInteger(end) || bounds.upperMs >= end) throw new Error("COORDINATION_LEASE_WINDOW_EXHAUSTED");
  const content = recordWithoutHash(previous); delete content.handoff; delete content.renewal; delete content.renewalConfirmation; delete content.sessionRef;
  const next = createCoordinationRecord({ ...content, owner: approved.targetOwner, machine: approved.targetHostId, generation: previous.generation + 1,
    lifecycleState: previous.lifecycleState === "Ready" ? "Active" : previous.lifecycleState,
    lastObservedHead: approved.targetHead, controlEpochDigest: approved.newEpochDigest, createdAt: new Date(Math.floor(bounds.lowerMs)).toISOString(),
    expiresAt: new Date(end).toISOString(), transactionId: approved.transactionId });
  return {
    assertCandidate(intent: CoordinationCommitIntent) {
      if (intent.subject.kind !== "coordination-record" || intent.subject.workItem !== approved.workItem ||
          intent.parentSha !== approved.expectedControlSha || intent.subject.recordHash !== next.recordHash || intent.transactionId !== approved.transactionId) throw new Error("COORDINATION_OPERATION_AUTHORITY_REQUIRED");
      validate(); assertCoordinationIdentity(next, observeBinding()); assertCoordinationWorkspace(context.projectDir, next);
      refreshClock().requireBefore(next.expiresAt!);
    },
    apply() {
      const applied = store.compareAndSwap({ workItem: approved.workItem, expectedControlSha: approved.expectedControlSha, expected: approved.expected, next });
      if (applied.disposition !== "current" || applied.current.record?.recordHash !== next.recordHash) throw new Error("COORDINATION_TRANSACTION_SUPERSEDED");
      assertMutationLock(context, held); assertCoordinationIdentity(next, observeBinding()); assertCoordinationWorkspace(context.projectDir, next);
      requireWriteLease(next, expectedRecord(next), refreshClock()); return next;
    },
  };
}
