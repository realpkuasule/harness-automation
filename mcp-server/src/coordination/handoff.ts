import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertMutationLock, type MutationLock } from "../recovery/service.js";
import { resolveRepositoryContext, runGit, type RepositoryContext } from "../repository/git.js";
import { hashObject } from "../v2/fs.js";
import type { HumanScopeBinding } from "../approval/human.js";
import type { CoordinationClock } from "./clock.js";
import type { CoordinationTransport } from "./store.js";
import type { CoordinationRecord } from "./types.js";
import type { HandoffSourceProof, HandoffTargetAcceptance } from "./handoff_record.js";
import { assertCoordinationWorkspace } from "./authority.js";
import { assertInspectableWorkspace } from "../repository/assets.js";

const env = () => ({ PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" });
const git = (root: string, args: string[]) => runGit(root,
  ["--no-optional-locks", "--no-replace-objects", "-c", "core.fsmonitor=false", ...args], { env: env() }).trim();

function workspace(context: RepositoryContext, record: CoordinationRecord, assets: boolean) {
  if (hashObject(resolveRepositoryContext(context.projectDir)) !== hashObject(context)) throw new Error("COORDINATION_WORKSPACE_BINDING_MISMATCH");
  const head = assertCoordinationWorkspace(context.projectDir, record);
  if (assets) {
    // Do not run project filters or call hidden index/submodule assets clean.
    try { assertInspectableWorkspace(context.projectDir); }
    catch (error) {
      if (error instanceof Error && error.message === "WORKSPACE_ASSETS_UNSUPPORTED") throw new Error("COORDINATION_TRANSFER_ASSETS_UNSUPPORTED");
      throw error;
    }
    if (git(context.projectDir, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching", "--ignore-submodules=none"])) throw new Error("COORDINATION_TRANSFER_EVIDENCE_INSUFFICIENT");
  }
  return head;
}

/** Fetches through this host's bound transport, never through the source machine's directory. */
function retrieve(transport: Pick<CoordinationTransport, "readRef" | "fetch">, ref: string, expected: string): string {
  if (transport.readRef(ref) !== expected) throw new Error("COORDINATION_TRANSFER_REMOTE_HEAD_MISMATCH");
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "harness-transfer-retrieval-")));
  try {
    git(directory, ["init", "--bare", "--quiet", "--template="]); transport.fetch(directory, expected);
    const retrieved = git(directory, ["rev-parse", "--verify", `${expected}^{commit}`]);
    if (retrieved !== expected || transport.readRef(ref) !== expected) throw new Error("COORDINATION_TRANSFER_REMOTE_HEAD_MISMATCH");
    return retrieved;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

/** Native composition only. CLI supplies intent, never facts, coverage booleans or a source path. */
export function handoffObservers(context: RepositoryContext, held: MutationLock | undefined,
  source: Pick<CoordinationTransport, "readRef" | "fetch" | "repositoryId">,
  observeBinding: () => HumanScopeBinding, refreshClock: () => CoordinationClock,
  observeCoverage?: (record: CoordinationRecord, lock: MutationLock) => HandoffSourceProof["coverage"]) {
  function requireLock() {
    if (!held) throw new Error("COORDINATION_MUTATION_LOCK_REQUIRED");
    assertMutationLock(context, held);
  }
  function check(record: CoordinationRecord) {
    requireLock();
    const binding = observeBinding();
    if (binding.commonDir !== context.commonDir || binding.repository !== record.repository || binding.repositoryId !== record.repositoryId) throw new Error("COORDINATION_WORKSPACE_BINDING_MISMATCH");
    if (source.repositoryId !== record.sourceRepositoryId) throw new Error("COORDINATION_SOURCE_REPOSITORY_BINDING_REQUIRED");
    return binding;
  }
  function observedAt(record: CoordinationRecord): string {
    if (!record.expiresAt) throw new Error("COORDINATION_WRITE_LEASE_UNAVAILABLE");
    return new Date(Math.ceil(refreshClock().requireBefore(record.expiresAt).upperMs)).toISOString();
  }
  return {
    beforeFreeze(record: CoordinationRecord) { check(record); workspace(context, record, false); },
    sourceProof(record: CoordinationRecord): HandoffSourceProof {
      const binding = check(record);
      if (!observeCoverage) throw new Error("COORDINATION_SOURCE_WRITER_COVERAGE_REQUIRED");
      const coverage = observeCoverage(record, held!);
      if (coverage.kind !== (binding.controlEpoch.mode === "isolated-qualification" ? "isolated-qualification" : "host-verified")) throw new Error("COORDINATION_SOURCE_WRITER_COVERAGE_REQUIRED");
      const sourceHead = workspace(context, record, true); const sourceRef = `refs/heads/${record.branch}`;
      const remoteHead = retrieve(source, sourceRef, sourceHead);
      check(record); workspace(context, record, true);
      const unpushed = Number(git(context.projectDir, ["rev-list", "--count", `${remoteHead}..HEAD`]));
      const unique = Number(git(context.projectDir, ["rev-list", "--count", "HEAD", "--not", remoteHead]));
      if (unpushed !== 0 || unique !== 0) throw new Error("COORDINATION_TRANSFER_EVIDENCE_INSUFFICIENT");
      const proof: HandoffSourceProof = { freezeRecordHash: record.recordHash, coverage, facts: {
        sourceRepositoryId: record.sourceRepositoryId, sourceRef, endpointHash: binding.endpointHash, sourceHead, remoteHead,
        workspace: context.projectDir, commonDir: context.commonDir, trackedClean: true, untracked: [], ignored: [], uniqueCommits: unique,
        unpushedCommits: unpushed, observer: binding.actor, hostId: binding.hostId, observedAt: observedAt(record),
      }, proofHash: "" };
      proof.proofHash = hashObject({ ...proof, proofHash: undefined }); return proof;
    },
    targetAcceptance(record: CoordinationRecord): HandoffTargetAcceptance {
      const binding = check(record); const proof = record.handoff?.sourceProof;
      if (!proof || proof.facts.endpointHash !== binding.endpointHash ||
          proof.coverage.kind !== (binding.controlEpoch.mode === "isolated-qualification" ? "isolated-qualification" : "host-verified")) throw new Error("COORDINATION_TRANSFER_EVIDENCE_INSUFFICIENT");
      workspace(context, record, true);
      const retrievedHead = retrieve(source, proof.facts.sourceRef, record.lastObservedHead);
      check(record); const targetHead = workspace(context, record, true);
      const acceptance: HandoffTargetAcceptance = { sourceProofHash: proof.proofHash, sourceRepositoryId: record.sourceRepositoryId,
        sourceRef: proof.facts.sourceRef, endpointHash: binding.endpointHash, sourceHead: record.lastObservedHead,
        remoteHead: retrievedHead, retrievedHead, targetHead, workspace: context.projectDir, commonDir: context.commonDir,
        observer: binding.actor, hostId: binding.hostId, observedAt: observedAt(record), acceptanceHash: "" };
      acceptance.acceptanceHash = hashObject({ ...acceptance, acceptanceHash: undefined }); return acceptance;
    },
    check, requireLock,
  };
}
export type HandoffObservers = ReturnType<typeof handoffObservers>;
