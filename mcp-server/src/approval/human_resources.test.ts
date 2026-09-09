import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { humanScopeSchema, checkHumanScope } from "./human_scope.js";
import { prepareSyntheticObject } from "../coordination/synthetic.js";
import { prepareQualificationManifest, saveQualificationManifest, scopeForClient } from "../coordination/manifest.js";
import { CoordinationClock } from "../coordination/clock.js";
import { createSemanticApprovalPacket } from "./service.js";
import { closeQualificationWrites, closeQualificationWritesLocked, loadHumanAuthorization, qualificationResourceReservations, recordHumanApproval, recordQualificationResourceLocked, reserveQualificationResourcesLocked, revokeHumanAuthorization } from "./human.js";
import { acquireMutationLock, releaseMutationLock } from "../recovery/service.js";
import { fileHash, hashObject } from "../v2/fs.js";
import { applyWorkspacePlan, auditWorkspace, planWorkspaceAllocation, planWorkspaceConfiguration, workspaceStatus } from "../worktree/service.js";
import { preflightQualificationResources, reserveQualificationWorkspacesLocked } from "../worktree/qualification.js";

const roots: string[] = []; const digest = "a".repeat(64);
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const container = realpathSync(mkdtempSync(join(tmpdir(), "qualification-resources-"))); roots.push(container);
  const root = join(container, "project"); mkdirSync(root); mkdirSync(join(container, "worktrees"));
  const source = prepareSyntheticObject("source-fixture", { runId: "resources", objectId: "source", seconds: 1788480000 });
  const commonDir = join(root, ".git"); mkdirSync(commonDir); const expiresAt = "2026-09-04T05:00:00.000Z"; const cleanupExpiresAt = "2026-09-04T06:00:00.000Z";
  const scope = { kind: "qualification-run", runId: "resources", expiresAt, cleanupExpiresAt,
    refs: ["refs/heads/codex/fixture"], operations: ["create"], maxCommits: 1, maxWriteAttempts: 1, maxCleanupAttempts: 1,
    binding: { commonDir, repository: "owner/repo", repositoryId: "42", endpointHash: digest, credentialBindingHash: digest,
      credentialRef: "git", credentialPurpose: "git-transport", actor: "fixture", hostId: "741ba5a8-40e2-4848-b5a4-082f4f2145a9", configHash: digest,
      implementation: { kind: "package", artifactDigest: digest }, runnerHash: digest,
      controlEpoch: { schemaVersion: "coordination-epoch/1", protocol: "github-coordination/1.0", mode: "isolated-qualification", coordinationConfigDigest: digest, policy: { kind: "none" } } },
    synthetic: { objects: [source], controls: [], publications: [{ fixtureId: "source", transactionId: "publish", ref: "refs/heads/codex/fixture", expected: null }] },
    localResources: { authorityRoot: root, commonDir, configHash: digest, hostBindingHash: digest, expiresAt, cleanupExpiresAt, maxConcurrent: 1,
      items: [{ resourceId: "source-a", clientId: "a", path: join(container, "worktrees/fixture"), branch: "codex/fixture", fixtureId: "source", sourceSha: source.commitSha,
        operations: ["import-source", "create-once", "observe", "close-exact"] }] } };
  return { root, scope };
}
function approved(scope: ReturnType<typeof fixture>["scope"]) {
  const parsed = humanScopeSchema.parse(scope); if (parsed.kind !== "qualification-run" || !parsed.synthetic) throw new Error("FIXTURE_SCOPE_REQUIRED");
  const manifest = prepareQualificationManifest({ schemaVersion: "qualification-run-manifest/1", runId: parsed.runId,
    repository: parsed.binding.repository, repositoryId: parsed.binding.repositoryId, endpointHash: parsed.binding.endpointHash,
    refs: parsed.refs, synthetic: parsed.synthetic, clients: [{ clientId: "a", scope: { ...parsed, synthetic: parsed.synthetic } }], cleanupClientId: "a",
    requiredCases: ["dg01-cas"], maxCommits: 1, maxWriteAttempts: 1, maxCleanupAttempts: 1, expiresAt: parsed.expiresAt, cleanupExpiresAt: parsed.cleanupExpiresAt });
  saveQualificationManifest(parsed.binding.commonDir, manifest); const bound = scopeForClient(manifest, "a"); const inputHash = hashObject(bound); const planHash = hashObject({ inputHash });
  const packet = createSemanticApprovalPacket({ planHash, inputHash, producerIdentity: "local-resource-test",
    binding: { planHash, inputDigest: inputHash, contextDigest: digest, observedHash: digest, policyDigest: digest },
    actions: [{ id: "qualification-run", kind: "permission-change", protected: true, summary: "LOCAL resource accounting only", before: null, after: inputHash, reversible: true, recovery: "Retain unresolved reservations" }] });
  return recordHumanApproval(parsed.binding.commonDir, { packet, scope: bound, approvedBy: "fixture", approvedAt: "2026-09-04T03:00:00.000Z", source: { kind: "explicit-human", messageHash: digest } }, planHash);
}
function clock() { const value = new CoordinationClock(() => ({ monotonicMs: 0, wallMs: 0 })); value.observe("Fri, 04 Sep 2026 04:00:00 GMT", value.start()); return value; }

it("binds finite exact local resources without granting generic workspace authority", () => {
  const { scope } = fixture();
  const parsed = humanScopeSchema.parse(scope); checkHumanScope(parsed);
  expect(parsed).toEqual(scope);
  const patches: Array<(value: typeof scope) => void> = [
    (v) => { v.localResources.commonDir += "-other"; },
    (v) => { v.localResources.items[0].sourceSha = "b".repeat(40); },
    (v) => { v.localResources.items[0].branch = "main"; },
    (v) => { v.localResources.items[0].path += "/../elsewhere"; },
    (v) => { v.localResources.items[0].operations = ["observe"]; },
    (v) => { v.localResources.maxConcurrent = 0; },
    (v) => { v.localResources.items.push({ ...v.localResources.items[0] }); },
    (v) => { v.localResources.expiresAt = "2026-09-04T07:00:00.000Z"; },
    (v) => { v.localResources.cleanupExpiresAt = "2026-09-04T07:00:00.000Z"; },
  ];
  for (const patch of patches) { const value = structuredClone(scope); patch(value); expect(() => checkHumanScope(humanScopeSchema.parse(value))).toThrow(); }
  const ordinary: Partial<typeof scope> = { ...scope }; delete ordinary.localResources;
  expect(() => checkHumanScope(humanScopeSchema.parse(ordinary))).not.toThrow();
});

it("reserves the entire bounded resource list once in the original receipt and never refunds it on closure or revocation", () => {
  const { scope } = fixture(); const reference = approved(scope); const commonDir = scope.binding.commonDir;
  const binding = humanScopeSchema.parse(scope).binding; const context = { projectDir: commonDir, commonDir, repository: true };
  const lock = acquireMutationLock(context);
  try {
    expect(() => reserveQualificationResourcesLocked({ ...lock }, commonDir, reference, binding, clock())).toThrow();
    reserveQualificationResourcesLocked(lock, commonDir, reference, binding, clock());
    expect(() => reserveQualificationResourcesLocked(lock, commonDir, reference, binding, clock())).toThrow("HUMAN_LOCAL_RESOURCES_ALREADY_RESERVED");
  } finally { releaseMutationLock(lock); }
  expect(qualificationResourceReservations(commonDir)).toEqual([expect.objectContaining({ resourceId: "source-a", approvalRef: reference, status: "reserved" })]);
  expect(loadHumanAuthorization(commonDir, reference)).toMatchObject({ candidates: [], attempts: [] });
  closeQualificationWrites(commonDir, reference); revokeHumanAuthorization(commonDir, reference, "No refund");
  expect(qualificationResourceReservations(commonDir)).toHaveLength(1);
  const records = join(commonDir, "harness/lkg/approval-human/records"); const tail = readdirSync(records).sort().at(-1)!;
  rmSync(join(records, tail));
  expect(() => qualificationResourceReservations(commonDir)).toThrow("HUMAN_AUTHORIZATION_RECOVERY_REQUIRED");
});

it("tracks one resource lifecycle in the original human chain without refunding create-once or inventing ownership", () => {
  const { scope } = fixture(); const reference = approved(scope); const commonDir = scope.binding.commonDir;
  const context = { projectDir: commonDir, commonDir, repository: true }; const lock = acquireMutationLock(context);
  const binding = humanScopeSchema.parse(scope).binding; const source = scope.synthetic.objects[0];
  const event = (fact: unknown) => recordQualificationResourceLocked(lock, commonDir, reference, "source-a", fact, binding, clock());
  try {
    expect(() => event({ type: "create-started" })).toThrow("HUMAN_LOCAL_RESOURCES_NOT_RESERVED");
    reserveQualificationResourcesLocked(lock, commonDir, reference, binding, clock());
    expect(() => event({ type: "mkdir-owned", identity: { device: 1, inode: 2, birthtimeMs: 3, parentDevice: 1, parentInode: 4, parentBirthtimeMs: 5 } })).toThrow("HUMAN_LOCAL_RESOURCE_HISTORY_INVALID");
    const imported = { type: "import-started", commits: [source.commitSha], graphHash: hashObject([source.objectPlanHash]) };
    expect(() => event({ ...imported, commits: ["b".repeat(40)] })).toThrow("HUMAN_LOCAL_RESOURCE_HISTORY_INVALID");
    event(imported);
    expect(() => event(imported)).toThrow("HUMAN_LOCAL_RESOURCE_HISTORY_INVALID");
    expect(() => event({ type: "create-started" })).toThrow("HUMAN_LOCAL_RESOURCE_HISTORY_INVALID");
    event({ type: "import-result", status: "imported", evidenceHash: digest }); event({ type: "create-started" });
    expect(() => event({ type: "create-started" })).toThrow("HUMAN_LOCAL_RESOURCE_HISTORY_INVALID");
    event({ type: "mkdir-owned", identity: { device: 1, inode: 2, birthtimeMs: 3, parentDevice: 1, parentInode: 4, parentBirthtimeMs: 5 } });
    expect(() => event({ type: "branch-created", head: "b".repeat(40) })).toThrow("HUMAN_LOCAL_RESOURCE_HISTORY_INVALID");
    event({ type: "branch-created", head: source.commitSha }); event({ type: "add-started" });
    event({ type: "ready", gitDir: join(commonDir, "worktrees/fixture"), evidenceHash: digest });
    expect(() => event({ type: "released", evidenceHash: digest })).toThrow("HUMAN_QUALIFICATION_WRITES_OPEN");
    closeQualificationWritesLocked(lock, commonDir, reference);
    event({ type: "retained", reason: "LOCAL_PATH_REPLACED", evidenceHash: digest });
    expect(qualificationResourceReservations(commonDir)).toEqual([expect.objectContaining({ phase: "ready", status: "retained", resourceId: "source-a" })]);
    event({ type: "released", evidenceHash: digest });
    expect(qualificationResourceReservations(commonDir)).toEqual([]);
    expect(() => event({ type: "create-started" })).toThrow("HUMAN_QUALIFICATION_WRITES_CLOSED");
    expect(() => reserveQualificationResourcesLocked(lock, commonDir, reference, binding, clock())).toThrow("HUMAN_QUALIFICATION_WRITES_CLOSED");
    expect(loadHumanAuthorization(commonDir, reference)).toMatchObject({ candidates: [], attempts: [], resourceStates: {
      "source-a": { phase: "released", createStarted: true, branchCreated: source.commitSha, importResult: "imported" },
    } });
  } finally { releaseMutationLock(lock); }
});

it.each(["failed", "unknown"])("retains an incomplete import without permitting creation or a forged success (%s)", (status) => {
  const { scope } = fixture(); const reference = approved(scope); const commonDir = scope.binding.commonDir;
  const lock = acquireMutationLock({ projectDir: commonDir, commonDir, repository: true }); const binding = humanScopeSchema.parse(scope).binding;
  const event = (fact: unknown) => recordQualificationResourceLocked(lock, commonDir, reference, "source-a", fact, binding, clock());
  try {
    reserveQualificationResourcesLocked(lock, commonDir, reference, binding, clock());
    expect(() => recordQualificationResourceLocked({ ...lock }, commonDir, reference, "source-a", { type: "create-started" }, binding, clock())).toThrow();
    expect(() => recordQualificationResourceLocked(lock, commonDir, reference, "other", { type: "create-started" }, binding, clock())).toThrow("HUMAN_LOCAL_RESOURCE_SCOPE_REQUIRED");
    const source = scope.synthetic.objects[0]; event({ type: "import-started", commits: [source.commitSha], graphHash: hashObject([source.objectPlanHash]) });
    event({ type: "import-result", status, evidenceHash: digest });
    expect(() => event({ type: "import-result", status: "imported", evidenceHash: digest })).toThrow("HUMAN_LOCAL_RESOURCE_HISTORY_INVALID");
    expect(() => event({ type: "create-started" })).toThrow("HUMAN_LOCAL_RESOURCE_HISTORY_INVALID");
    event({ type: "retained", reason: "IMPORT_INCOMPLETE", evidenceHash: digest });
    expect(qualificationResourceReservations(commonDir)).toEqual([expect.objectContaining({ phase: "reserved", status: "retained" })]);
  } finally { releaseMutationLock(lock); }
});

it("shares real worktree path protection, capacity and audit without creating a fixture or a Delivery lease", () => {
  const { root, scope } = fixture(); const commonDir = scope.binding.commonDir;
  const env = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  execFileSync("git", ["init", "--quiet", "--template=", "--initial-branch=main"], { cwd: root, env });
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "fixture"], { cwd: root, env });
  expect(() => preflightQualificationResources(root, scope.localResources)).toThrow("WORKTREE_ENFORCEMENT_NOT_ENABLED");
  const configuration = planWorkspaceConfiguration({ projectRoot: root, mode: "enforced", managementBranch: "main", maxPersistentWorktrees: 1,
    allowedRoots: [dirname(scope.localResources.items[0].path)], protectedRoots: [root, commonDir, "/"] });
  applyWorkspacePlan({ projectRoot: root, planPath: configuration.path, approval: configuration.plan.planHash });
  const before = workspaceStatus(root); scope.localResources.configHash = fileHash(join(root, ".harness/worktree-delivery.json"))!;
  scope.localResources.hostBindingHash = before.hostBinding.hash!;
  expect(preflightQualificationResources(root, scope.localResources).capacity).toMatchObject({ used: 0, available: 1 });
  execFileSync("git", ["config", "extensions.worktreeConfig", "true"], { cwd: root, env });
  writeFileSync(join(commonDir, "config.worktree"), "[credential]\n\thelper = synthetic-credential-must-not-copy\n");
  expect(() => preflightQualificationResources(root, scope.localResources)).toThrow("QUALIFICATION_RESOURCE_CONFIG_UNSUPPORTED");
  expect(readFileSync(join(commonDir, "config.worktree"), "utf8")).toContain("synthetic-credential-must-not-copy");
  execFileSync("git", ["config", "--unset", "extensions.worktreeConfig"], { cwd: root, env }); rmSync(join(commonDir, "config.worktree"));
  const protectedScope = structuredClone(scope.localResources); protectedScope.items[0].path = root;
  expect(() => preflightQualificationResources(root, protectedScope)).toThrow("WORKTREE_PROTECTED_PATH");
  expect(() => preflightQualificationResources(root, { ...scope.localResources, configHash: "b".repeat(64) })).toThrow("HUMAN_LOCAL_RESOURCE_POLICY_DRIFT");
  const target = scope.localResources.items[0].path;
  writeFileSync(target, "preserve"); expect(() => preflightQualificationResources(root, scope.localResources)).toThrow("WORKTREE_PATH_EXISTS_OR_NONCANONICAL");
  expect(readFileSync(target, "utf8")).toBe("preserve"); rmSync(target);
  symlinkSync(root, target); expect(() => preflightQualificationResources(root, scope.localResources)).toThrow(); rmSync(target);
  const oversized = structuredClone(scope.localResources); oversized.maxConcurrent = 2;
  oversized.items.push({ ...oversized.items[0], resourceId: "second", branch: "codex/second", path: join(dirname(target), "second") });
  expect(() => preflightQualificationResources(root, oversized)).toThrow("WORKTREE_CAPACITY_EXCEEDED");
  expect(qualificationResourceReservations(commonDir)).toEqual([]);
  const reference = approved(scope); const lock = acquireMutationLock({ projectDir: root, commonDir, repository: true });
  try { reserveQualificationWorkspacesLocked(lock, root, reference, humanScopeSchema.parse(scope).binding, clock()); }
  finally { releaseMutationLock(lock); }
  expect(workspaceStatus(root)).toMatchObject({ leases: [], capacity: { used: 1, available: 0 }, qualificationResources: [{ resourceId: "source-a", status: "reserved" }] });
  expect(auditWorkspace(root).capacity).toMatchObject({ used: 1, available: 0 });
  expect(readdirSync(dirname(scope.localResources.items[0].path))).toEqual([]);
  expect(() => planWorkspaceAllocation({ projectRoot: root, workItem: "github:owner/repo#2", branch: "codex/2-feature", owner: "fixture",
    path: join(dirname(scope.localResources.items[0].path), "two") })).toThrow("WORKTREE_CAPACITY_EXCEEDED");
  closeQualificationWrites(commonDir, reference);
  expect(workspaceStatus(root).capacity.used).toBe(1);
});
import { execFileSync } from "node:child_process";
