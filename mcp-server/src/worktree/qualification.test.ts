import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireMutationLock, releaseMutationLock, type MutationLock } from "../recovery/service.js";
import { fileHash, hashObject, sha256 } from "../v2/fs.js";
import { prepareSyntheticObject } from "../coordination/synthetic.js";
import { CoordinationClock } from "../coordination/clock.js";
import { prepareQualificationManifest, saveQualificationManifest, scopeForClient } from "../coordination/manifest.js";
import { createSemanticApprovalPacket } from "../approval/service.js";
import { recordHumanApproval } from "../approval/human.js";
import { humanScopeSchema } from "../approval/human_scope.js";
import { applyWorkspacePlan, planWorkspaceConfiguration, workspaceStatus } from "./service.js";
import { reserveQualificationWorkspacesLocked } from "./qualification.js";
import { createQualificationWorkspaceRuntime } from "./qualification_runtime.js";
import { planCredentialHostBinding, applyCredentialHostBinding } from "../credentials/host_binding.js";
import { appendReceiptEvent, appendLkgRecord } from "../receipt/service.js";

const digest = "a".repeat(64);
const roots: string[] = [];

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function ensureHomeExists(): void {
  try { mkdirSync(homedir(), { recursive: true }); } catch { /* already exists */ }
}

function configuredProject(): { projectRoot: string; commonDir: string; scope: ReturnType<typeof humanScopeSchema.parse> } {
  ensureHomeExists();
  const container = realpathSync(mkdtempSync(join(tmpdir(), "qualification-runtime-")));
  roots.push(container);
  const projectRoot = join(container, "project");
  mkdirSync(projectRoot);
  mkdirSync(join(container, "worktrees"));
  git(projectRoot, "init", "--quiet", "--template=", "--initial-branch=main");
  git(projectRoot, "-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture",
    "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "--allow-empty",
    "-m", "primary");
  git(projectRoot, "remote", "add", "origin", "https://github.com/owner/repo.git");
  const commonDir = join(projectRoot, ".git");
  const allowed = join(container, "worktrees");
  const configured = planWorkspaceConfiguration({ projectRoot, mode: "enforced",
    managementBranch: "main", maxPersistentWorktrees: 1,
    allowedRoots: [allowed], protectedRoots: [projectRoot, commonDir, "/"] });
  applyWorkspacePlan({ projectRoot, planPath: configured.path, approval: configured.plan.planHash });
  const endpoint = "https://github.com/owner/repo.git";
  const endpointHash = sha256(endpoint);
  const hostId = "741ba5a8-40e2-4848-b5a4-082f4f2145a9";
  const hostPlan = planCredentialHostBinding(commonDir, { schemaVersion: "credential-host-binding/1.0",
    commonDir, repository: "owner/repo", repositoryId: "42", endpointHash,
    credentials: [
      { id: "git", purpose: "git-transport", repository: "owner/repo", identity: "fixture",
        scopes: ["contents:write"], expiresAt: "2099-01-01T00:00:00.000Z", envVar: "HARNESS_GIT_TOKEN",
        keychainService: "synthetic", keychainAccount: "git-fixture" },
    ] });
  applyCredentialHostBinding(commonDir, hostPlan, hostPlan.planHash);
  const source = prepareSyntheticObject("source-fixture", { runId: "runtime", objectId: "source", seconds: 1788480000 });
  const expiresAt = "2026-09-04T05:00:00.000Z";
  const cleanupExpiresAt = "2026-09-04T06:00:00.000Z";
  const fileConfigHash = fileHash(join(projectRoot, ".harness/worktree-delivery.json"))!;
  const fileHostBindingHash = workspaceStatus(projectRoot).hostBinding.hash;
  const rawScope = {
    kind: "qualification-run" as const, runId: "runtime", expiresAt, cleanupExpiresAt,
    refs: ["refs/heads/codex/fixture"], operations: ["create" as const],
    maxCommits: 1, maxWriteAttempts: 1, maxCleanupAttempts: 1,
    binding: { commonDir, repository: "owner/repo", repositoryId: "42", endpointHash: digest,
      credentialBindingHash: digest, credentialRef: "git", credentialPurpose: "git-transport",
      actor: "fixture", hostId, configHash: fileConfigHash,
      implementation: { kind: "package" as const, artifactDigest: digest }, runnerHash: digest,
      controlEpoch: { schemaVersion: "coordination-epoch/1", protocol: "github-coordination/1.0",
        mode: "isolated-qualification", coordinationConfigDigest: fileConfigHash, policy: { kind: "none" as const } } },
    synthetic: { objects: [source], controls: [],
      publications: [{ fixtureId: "source", transactionId: "publish",
        ref: "refs/heads/codex/fixture", expected: null }] },
    localResources: { authorityRoot: projectRoot, commonDir,
      configHash: fileConfigHash,
      hostBindingHash: fileHostBindingHash,
      expiresAt, cleanupExpiresAt, maxConcurrent: 1,
      items: [{ resourceId: "source", clientId: "local",
        path: join(allowed, "fixture"), branch: "codex/fixture", fixtureId: "source",
        sourceSha: source.commitSha,
        operations: ["import-source", "create-once", "observe", "close-exact"] }] } };
  const scope = humanScopeSchema.parse(rawScope);
  return { projectRoot, commonDir, scope };
}

function approved(scope: ReturnType<typeof humanScopeSchema.parse>) {
  if (scope.kind !== "qualification-run" || !scope.synthetic) throw new Error("FIXTURE_SCOPE_REQUIRED");
  const manifest = prepareQualificationManifest({ schemaVersion: "qualification-run-manifest/1",
    runId: scope.runId, repository: scope.binding.repository, repositoryId: scope.binding.repositoryId,
    endpointHash: scope.binding.endpointHash, refs: scope.refs, synthetic: scope.synthetic,
    clients: [{ clientId: "local", scope: { ...scope, synthetic: scope.synthetic } }], cleanupClientId: "local",
    requiredCases: ["dg01-cas"], maxCommits: 1, maxWriteAttempts: 1, maxCleanupAttempts: 1,
    expiresAt: scope.expiresAt, cleanupExpiresAt: scope.cleanupExpiresAt });
  saveQualificationManifest(scope.binding.commonDir, manifest);
  const bound = scopeForClient(manifest, "local");
  const inputHash = hashObject(bound);
  const planHash = hashObject({ inputHash });
  const packet = createSemanticApprovalPacket({ planHash, inputHash, producerIdentity: "runtime-test",
    binding: { planHash, inputDigest: inputHash, contextDigest: digest, observedHash: digest, policyDigest: digest },
    actions: [{ id: "qualification-run", kind: "permission-change", protected: true,
      summary: "LOCAL runtime test", before: null, after: inputHash, reversible: true,
      recovery: "Retain unresolved reservations" }] });
  return recordHumanApproval(scope.binding.commonDir,
    { packet, scope: bound, approvedBy: "fixture", approvedAt: "2026-09-04T03:00:00.000Z",
      source: { kind: "explicit-human", messageHash: digest } }, planHash);
}

function lockFor(projectRoot: string, commonDir: string): MutationLock {
  return acquireMutationLock({ projectDir: projectRoot, commonDir, repository: true });
}

function reserveOnce(projectRoot: string, commonDir: string, approvalRef: string, scope: ReturnType<typeof humanScopeSchema.parse>): MutationLock {
  if (scope.kind !== "qualification-run" || !scope.localResources) throw new Error("FIXTURE_REQUIRED");
  const clock = new CoordinationClock(() => ({ monotonicMs: 0, wallMs: 0 }));
  clock.observe("Fri, 04 Sep 2026 04:00:00 GMT", clock.start());
  const lock = lockFor(projectRoot, commonDir);
  reserveQualificationWorkspacesLocked(lock, projectRoot, approvalRef, scope.binding, clock);
  return lock;
}

describe("createQualificationWorkspaceRuntime (LOCAL native fixtures)", () => {
  it("opens a runtime and reports authority + workspace contexts from the approved scope", () => {
    const { projectRoot, commonDir, scope } = configuredProject();
    const reference = approved(scope);
    const lock = reserveOnce(projectRoot, commonDir, reference, scope);
    const runtime = createQualificationWorkspaceRuntime(projectRoot, reference, lock);
    expect(runtime.authority.repository).toBe("owner/repo");
    expect(runtime.authority.repositoryId).toBe("42");
    expect(runtime.authority.controlEpochDigest).toBe(hashObject(scope.binding.controlEpoch));
    expect(runtime.authority.configHash).toBe(scope.binding.configHash);
    expect(runtime.authority.artifactDigest).toBe(digest);
    expect(runtime.authority.runnerHash).toBe(digest);
    expect(runtime.authority.observedAt).toMatch(/T.*Z/u);
    expect(runtime.workspace.approvalRef).toBe(reference);
    expect(runtime.workspace.resourceIds).toEqual(["source"]);
    expect(runtime.workspace.observedHeads).toEqual({ source: scope.localResources!.items[0].sourceSha });
    expect(Object.isFrozen(runtime.authority)).toBe(true);
    expect(Object.isFrozen(runtime.workspace)).toBe(true);
    runtime.dispose();
    expect(commonDir).toBeTruthy();
  });

  it("rejects a binding drift between localResources.configHash and binding.configHash (HUMAN_AUTHORIZATION_BINDING_MISMATCH)", () => {
    const { projectRoot, commonDir, scope } = configuredProject();
    const driftedScope = structuredClone(scope);
    if (driftedScope.kind !== "qualification-run" || !driftedScope.localResources) throw new Error("FIXTURE_REQUIRED");
    driftedScope.localResources.configHash = "b".repeat(64);
    const manifest = prepareQualificationManifest({ schemaVersion: "qualification-run-manifest/1",
      runId: driftedScope.runId, repository: driftedScope.binding.repository,
      repositoryId: driftedScope.binding.repositoryId, endpointHash: driftedScope.binding.endpointHash,
      refs: driftedScope.refs, synthetic: driftedScope.synthetic!,
      clients: [{ clientId: "local", scope: driftedScope }], cleanupClientId: "local",
      requiredCases: ["dg01-cas"], maxCommits: 1, maxWriteAttempts: 1, maxCleanupAttempts: 1,
      expiresAt: driftedScope.expiresAt, cleanupExpiresAt: driftedScope.cleanupExpiresAt });
    saveQualificationManifest(commonDir, manifest);
    const bound = scopeForClient(manifest, "local");
    const inputHash = hashObject(bound); const planHash = hashObject({ inputHash });
    const packet = createSemanticApprovalPacket({ planHash, inputHash, producerIdentity: "runtime-drift-test",
      binding: { planHash, inputDigest: inputHash, contextDigest: digest, observedHash: digest, policyDigest: digest },
      actions: [{ id: "qualification-run", kind: "permission-change", protected: true,
        summary: "LOCAL drift test", before: null, after: inputHash, reversible: true,
        recovery: "Retain unresolved reservations" }] });
    const reference = recordHumanApproval(commonDir,
      { packet, scope: bound, approvedBy: "fixture", approvedAt: "2026-09-04T03:00:00.000Z",
        source: { kind: "explicit-human", messageHash: digest } }, planHash);
    const lock = lockFor(projectRoot, commonDir);
    try {
      // Bypass reserveQualificationWorkspacesLocked (which would itself reject on configHash drift);
      // we only need resourcesReservedAt to be set so the runtime's later guard can fire.
      const event = appendReceiptEvent({ root: commonDir, domain: "approval-human", transactionId: reference,
        snapshot: { kind: "qualification-resources-reserved", reservedAt: "2026-09-04T04:30:00.000Z" } });
      appendLkgRecord({ root: commonDir, domain: "approval-human", transactionId: reference,
        appliedReceiptEventHash: event.eventHash, planHash: planHash, observedHash: event.snapshotHash });
    } finally { releaseMutationLock(lock); }
    expect(() => createQualificationWorkspaceRuntime(projectRoot, reference))
      .toThrow("HUMAN_AUTHORIZATION_BINDING_MISMATCH");
  });

  it("rejects an unknown resourceId at allocate / observe / close (HUMAN_LOCAL_RESOURCE_SCOPE_REQUIRED)", () => {
    const { projectRoot, commonDir, scope } = configuredProject();
    const reference = approved(scope);
    const lock = reserveOnce(projectRoot, commonDir, reference, scope);
    const runtime = createQualificationWorkspaceRuntime(projectRoot, reference, lock);
    try {
      expect(() => runtime.allocate(lock, "other")).toThrow("HUMAN_LOCAL_RESOURCE_SCOPE_REQUIRED");
      expect(() => runtime.observe("other")).toThrow("HUMAN_LOCAL_RESOURCE_SCOPE_REQUIRED");
      expect(() => runtime.close(lock, "other")).toThrow("HUMAN_LOCAL_RESOURCE_SCOPE_REQUIRED");
    } finally { releaseMutationLock(lock); }
    runtime.dispose();
  });

  it("rejects a non-qualification-run scope at construction", () => {
    const { projectRoot, commonDir } = configuredProject();
    const scope = humanScopeSchema.parse({
      kind: "production-enable", configBeforeHash: null, configAfterHash: digest, expiresAt: "2026-09-04T05:00:00.000Z",
      controlRef: "refs/heads/codex/fixture", genesisSha: digest, genesisTree: digest,
      qualificationEvidenceHash: digest, maxBootstrapAttempts: 1,
      binding: { commonDir, repository: "owner/repo", repositoryId: "42", endpointHash: digest,
        credentialBindingHash: digest, credentialRef: "git", credentialPurpose: "git-transport",
        actor: "fixture", hostId: "741ba5a8-40e2-4848-b5a4-082f4f2145a9", configHash: digest,
        implementation: { kind: "package", artifactDigest: digest }, runnerHash: digest,
        controlEpoch: { schemaVersion: "coordination-epoch/1", protocol: "github-coordination/1.0",
          mode: "production", coordinationConfigDigest: digest, policy: { kind: "none" } } } });
    const inputHash = hashObject(scope); const planHash = hashObject({ inputHash });
    const packet = createSemanticApprovalPacket({ planHash, inputHash, producerIdentity: "runtime-prod-test",
      binding: { planHash, inputDigest: inputHash, contextDigest: digest, observedHash: digest, policyDigest: digest },
      actions: [{ id: "production-enable", kind: "permission-change", protected: true,
        summary: "LOCAL non-qualification scope", before: null, after: inputHash, reversible: true,
        recovery: "Retain unresolved reservations" }] });
    const reference = recordHumanApproval(commonDir,
      { packet, scope, approvedBy: "fixture", approvedAt: "2026-09-04T03:00:00.000Z",
        source: { kind: "explicit-human", messageHash: digest } }, planHash);
    expect(() => createQualificationWorkspaceRuntime(projectRoot, reference))
      .toThrow("HUMAN_QUALIFICATION_WORKSPACE_RUNTIME_INVALID");
  });

  it("two runtimes for the same approval are distinct opaque handles with equal contexts", () => {
    const { projectRoot, commonDir, scope } = configuredProject();
    const reference = approved(scope);
    const lock = reserveOnce(projectRoot, commonDir, reference, scope);
    const runtimeA = createQualificationWorkspaceRuntime(projectRoot, reference, lock);
    const runtimeB = createQualificationWorkspaceRuntime(projectRoot, reference, lock);
    expect(runtimeA).not.toBe(runtimeB);
    expect(runtimeA.authority).toMatchObject({ repository: "owner/repo", repositoryId: "42",
      configHash: runtimeB.authority.configHash, controlEpochDigest: runtimeB.authority.controlEpochDigest });
    expect(runtimeA.workspace).toMatchObject({ approvalRef: reference,
      resourceIds: runtimeB.workspace.resourceIds, observedHeads: runtimeB.workspace.observedHeads });
    const snapA = runtimeA.snapshot();
    const snapB = runtimeB.snapshot();
    expect(snapA.workspace.approvalRef).toBe(snapB.workspace.approvalRef);
    expect(snapA.authority.repository).toBe(snapB.authority.repository);
    runtimeA.dispose(); runtimeB.dispose();
    releaseMutationLock(lock);
  });

  it("dispose() releases the internal lock and rejects subsequent snapshot calls", () => {
    const { projectRoot, commonDir, scope } = configuredProject();
    const reference = approved(scope);
    const lock = reserveOnce(projectRoot, commonDir, reference, scope);
    const runtime = createQualificationWorkspaceRuntime(projectRoot, reference, lock);
    const first = runtime.snapshot();
    releaseMutationLock(lock);
    runtime.dispose();
    runtime.dispose();
    expect(() => runtime.snapshot()).toThrow("HUMAN_QUALIFICATION_WORKSPACE_RUNTIME_DISPOSED");
    expect(first.authority.repository).toBe("owner/repo");
  });

  it("JSON.stringify(runtime) returns {} (capability leak guard)", () => {
    const { projectRoot, commonDir, scope } = configuredProject();
    const reference = approved(scope);
    const lock = reserveOnce(projectRoot, commonDir, reference, scope);
    const runtime = createQualificationWorkspaceRuntime(projectRoot, reference, lock);
    const json = JSON.stringify(runtime);
    expect(json).toBe("{}");
    const spread = Object.assign({}, runtime);
    expect(spread).not.toBe(runtime);
    expect(typeof (spread as { allocate?: unknown }).allocate).toBe("undefined");
    runtime.dispose();
  });
});