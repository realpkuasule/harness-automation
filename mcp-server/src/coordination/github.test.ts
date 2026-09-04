import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { planCredentialHostBinding, applyCredentialHostBinding } from "../credentials/host_binding.js";
import { hashObject, sha256 } from "../v2/fs.js";
import { acquireMutationLock, releaseMutationLock } from "../recovery/service.js";
import { createSemanticApprovalPacket } from "../approval/service.js";
import { closeQualificationWrites, loadHumanAuthorization, recordHumanApproval, type HumanScope } from "../approval/human.js";
import { createQualificationRuntime, createTakeoverRuntime, observeCoordinationBinding } from "./runtime.js";
import { observeTakeoverRisk } from "./takeover.js";
import { GitHubCoordinationReader } from "./github.js";
import { GitHubCoordinationTransport, type CoordinationWriteIntent } from "./transport.js";
import { CoordinationLifecycleService, GitCoordinationStore } from "./service.js";
import { createCoordinationRecord, expectedRecord, validRecord } from "./record.js";
import { localHistory, localTransport, seedLocalGenesis } from "./__fixtures__/transport.js";
import { prepareSyntheticObject, type SyntheticScope } from "./synthetic.js";
import { controlEpochDigest } from "./authority.js";
import { prepareQualificationManifest, saveQualificationManifest, scopeForClient } from "./manifest.js";
import { collectClientEvidence, evaluateQualificationRun, readVerifiedClientEvidence, recheckClientEvidence } from "./evidence.js";
import { readSettledQualification, runLocalQualification } from "./qualification.js";
import { observeQualificationRemote, readQualificationRemote } from "./qualification_remote.js";
import { applyQualificationCleanup, planQualificationCleanup, recoverQualificationCleanup } from "./qualification_cleanup.js";
import { startClientProcess } from "./client_process.js";

const nativeHost = vi.hoisted(() => ({ home: "", sourceGroupSizes: [] as number[] }));
vi.mock("node:child_process", async (original) => {
  const native = await original<typeof import("node:child_process")>();
  return { ...native, spawn: ((command, args, options) => {
    if (!args?.some((arg) => arg.endsWith("/client_worker.ts"))) return native.spawn(command, args!, options!);
    const child = native.spawn(command, ["--loader", fileURLToPath(new URL("./__fixtures__/native-worker-loader.mjs", import.meta.url)),
      "--import", fileURLToPath(new URL("./__fixtures__/native-worker-os.mjs", import.meta.url)), ...args],
    { ...options, env: { ...options?.env, HARNESS_FIXTURE_USER_ROOT: nativeHost.home, TSX_DISABLE_CACHE: "1" } });
    child.on("message", (message) => {
      if ((message as { type?: string }).type === "ready") {
        const groups = native.execFileSync("ps", ["-axo", "pgid="], { encoding: "utf8", timeout: 5000 }).trim().split(/\s+/u).map(Number);
        nativeHost.sourceGroupSizes.push(groups.filter((group) => group === child.pid).length);
      }
    });
    return child;
  }) as typeof native.spawn };
});
vi.mock("node:os", async (original) => ({ ...await original<typeof import("node:os")>(), homedir: () => {
  if (!nativeHost.home) throw new Error("FIXTURE_HOST_REQUIRED"); return nativeHost.home;
} }));
// Only the independently tested artifact observation is synthetic here; resolver/Broker/Git/clock composition is real.
vi.mock("../repository/artifact.js", async (original) => ({ ...await original<typeof import("../repository/artifact.js")>(),
  currentHarnessArtifact: () => ({ implementation: { kind: "package", artifactDigest: "a".repeat(64) }, runnerHash: "a".repeat(64) }) }));
const roots: string[] = [];
const nativePlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
function git(root: string, ...args: string[]): string { return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function fixture() {
  // Exercise the macOS resolver on every CI host; only this test process's OS boundary is synthetic.
  Object.defineProperty(process, "platform", { ...nativePlatform, value: "darwin" }); nativeHost.sourceGroupSizes.length = 0;
  const container = realpathSync(mkdtempSync(join(tmpdir(), "coordination-provider-"))); roots.push(container);
  const root = join(container, "project"); mkdirSync(root);
  nativeHost.home = join(container, "user"); mkdirSync(nativeHost.home);
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null"); vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  git(root, "init", "--quiet"); const endpoint = "https://github.com/owner/repo.git"; git(root, "remote", "add", "origin", endpoint);
  const commonDir = join(root, ".git");
  const plan = planCredentialHostBinding(commonDir, { schemaVersion: "credential-host-binding/1.0", commonDir, repository: "owner/repo", repositoryId: "42", endpointHash: sha256(endpoint),
    credentials: [
      { id: "api", purpose: "github-api", repository: "owner/repo", identity: "octo", scopes: ["pull_requests:read"], expiresAt: "2099-01-01T00:00:00.000Z", envVar: "GH_TOKEN", keychainService: "synthetic", keychainAccount: "fixture" },
      { id: "git", purpose: "git-transport", repository: "owner/repo", identity: "octo", scopes: ["contents:write"], expiresAt: "2099-01-01T00:00:00.000Z", envVar: "HARNESS_GIT_TOKEN", keychainService: "synthetic", keychainAccount: "git-fixture" },
    ] });
  applyCredentialHostBinding(commonDir, plan, plan.planHash);
  const bin = join(container, "bin"); mkdirSync(bin); const calls = join(bin, "calls.jsonl"); const response = join(bin, "response.json");
  writeFileSync(join(bin, "security"), `#!${process.execPath}\nprocess.stdout.write('synthetic-provider-canary');\n`, { mode: 0o700 });
  writeFileSync(join(bin, "gh"), `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(a)+'\\n');if(process.env.GH_TOKEN!=='synthetic-provider-canary'||a[a.indexOf('--hostname')+1]!=='github.com')process.exit(2);const p=a.at(-1);const input=JSON.parse(fs.readFileSync(${JSON.stringify(response)},'utf8'));const body=p==='user'?{login:input.actor??'octo'}:p==='repos/owner/repo'?{full_name:'owner/repo',id:input.repoId??42}:input.pr;const date=input.date??new Date().toUTCString();process.stdout.write('HTTP/2 200\\nDate: '+date+'\\n\\n'+JSON.stringify(body));\n`, { mode: 0o700 });
  vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH}`);
  const record = createCoordinationRecord({ repository: "owner/repo", repositoryId: "42", workItem: "github:owner/repo#86", branch: "codex/feature", sourceRepositoryId: "43", owner: "octo", machine: plan.binding.hostId, generation: 1, controlEpochDigest: "a".repeat(64), createdAt: "2020-01-01T00:00:00.000Z", expiresAt: "2020-01-02T00:00:00.000Z", lastObservedHead: "b".repeat(40), lifecycleState: "Active", transactionId: "initial" });
  const pr = { id: 1234, number: 9, state: "closed", merged: true, merged_at: "2020-01-02T00:00:01.000Z", merge_commit_sha: "c".repeat(40), head: { sha: record.lastObservedHead, ref: record.branch, repo: { id: 43 } }, base: { ref: "main", repo: { id: 42, full_name: "owner/repo" } } };
  const respond = (data: unknown = { pr }) => writeFileSync(response, JSON.stringify(data)); respond();
  const provider = new GitHubCoordinationReader(root, "origin", "42", "api");
  return { root, commonDir, plan, calls, record, pr, respond, provider, bin, endpoint };
}
function nativeGitFixture({ root, bin, endpoint }: ReturnType<typeof fixture>) {
  const remote = join(bin, "remote.git"); git(root, "init", "--bare", "--quiet", "--template=", remote);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim(); const trace = join(bin, "git-transport.jsonl");
  const fault = join(bin, "fault.json"); const fired = join(bin, "fault-fired");
  writeFileSync(join(bin, "git"), `#!${process.execPath}
const fs=require('node:fs');const cp=require('node:child_process');let a=process.argv.slice(2);
const fault=fs.existsSync(${JSON.stringify(fault)})?JSON.parse(fs.readFileSync(${JSON.stringify(fault)},'utf8')):{};
const deleting=a.includes('push')&&a.at(-1).startsWith(':refs/heads/');
if(a.some(x=>['ls-remote','fetch','push'].includes(x))){
  if(!a.includes(${JSON.stringify(endpoint)})||process.env.HARNESS_GIT_TOKEN!=='synthetic-provider-canary')process.exit(2);
  fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({argv:a,global:process.env.GIT_CONFIG_GLOBAL,redirects:process.env.GIT_CONFIG_VALUE_2,hooks:process.env.GIT_CONFIG_VALUE_3})+'\\n');
  a=a.map(x=>x===${JSON.stringify(endpoint)}?${JSON.stringify(remote)}:x);
}
if(a.includes('ls-remote')&&fault.readbackFailure&&fs.existsSync(${JSON.stringify(fired)}))process.exit(1);
if(a.includes('ls-remote')&&fault.failReadRef&&a.includes(fault.failReadRef))process.exit(1);
if(deleting&&fault.beforeDeleteHead)cp.execFileSync(${JSON.stringify(realGit)},['--git-dir='+${JSON.stringify(remote)},'update-ref',a.at(-1).slice(1),fault.beforeDeleteHead]);
const r=cp.spawnSync(${JSON.stringify(realGit)},a,{env:process.env,stdio:['inherit','pipe','pipe']});
if(deleting&&fault.readbackFailure)fs.writeFileSync(${JSON.stringify(fired)},'deleted');
process.stdout.write(deleting&&fault.dropDeleteOutput?'':r.stdout??'');process.stderr.write(r.stderr??'');process.exit(r.status??1);
`, { mode: 0o700 });
  return { trace, remote, realGit, fault };
}
function syntheticScope(runId: string, controlRef: string): SyntheticScope {
  const genesis = prepareSyntheticObject("control-genesis", { runId, objectId: "genesis", seconds: 1788480000 });
  return { objects: [genesis], controls: [{ fixtureId: "genesis", ref: controlRef }], publications: [{ fixtureId: "genesis", transactionId: "bootstrap", ref: controlRef, expected: null }] };
}
function prepareSupervisedFixture(crossClient = false) {
  const f = fixture(); const native = nativeGitFixture(f); const binding = observeCoordinationBinding(f.root, "origin", "42", "git"); const now = Date.now();
  const controlRef = "refs/heads/supervised-control"; const sourceRef = "refs/heads/supervised-source";
  const synthetic = syntheticScope("supervised", controlRef); const source = prepareSyntheticObject("source-fixture", { ...synthetic.objects[0].metadata, objectId: "source" });
  synthetic.objects.push(source); synthetic.publications.push({ fixtureId: "source", transactionId: "source-create", ref: sourceRef, expected: null });
  const definition = { kind: "qualification-run" as const, binding, runId: "supervised", synthetic, refs: [controlRef, sourceRef], operations: ["create" as const],
    maxCommits: 2, maxWriteAttempts: 2, maxCleanupAttempts: 2, expiresAt: new Date(now + 3600_000).toISOString(), cleanupExpiresAt: new Date(now + 7200_000).toISOString() };
  const clients = [{ clientId: "local", scope: definition }]; const projectRoots = [f.root];
  if (crossClient) {
    const root = join(f.bin, "other-client"); mkdirSync(root); git(root, "init", "--quiet"); git(root, "remote", "add", "origin", f.endpoint);
    const commonDir = join(root, ".git");
    const plan = planCredentialHostBinding(commonDir, { schemaVersion: "credential-host-binding/1.0", commonDir, repository: "owner/repo", repositoryId: "42", endpointHash: binding.endpointHash,
      credentials: f.plan.binding.credentials.map(({ hostId, ...credential }) => { expect(hostId).toBe(binding.hostId); return credential; }) });
    applyCredentialHostBinding(commonDir, plan, plan.planHash);
    clients[0].scope = { ...definition, maxCommits: 1, maxWriteAttempts: 1, synthetic: { ...synthetic, publications: [synthetic.publications[0]] } };
    clients.push({ clientId: "other", scope: { ...definition, binding: observeCoordinationBinding(root, "origin", "42", "git"),
      maxCommits: 1, maxWriteAttempts: 1, maxCleanupAttempts: 0, synthetic: { ...synthetic, publications: [synthetic.publications[1]] } } }); projectRoots.push(root);
  }
  const sourceClient = crossClient ? "other" : "local";
  const manifest = prepareQualificationManifest({ schemaVersion: "qualification-run-manifest/1", runId: "supervised", repository: binding.repository, repositoryId: binding.repositoryId,
    endpointHash: binding.endpointHash, refs: definition.refs, synthetic, requiredCases: ["dg01-cas"], clients,
    cleanupClientId: "local", maxCommits: 2, maxWriteAttempts: 2, maxCleanupAttempts: 2, expiresAt: definition.expiresAt, cleanupExpiresAt: definition.cleanupExpiresAt,
    execution: { kind: "local-synthetic-publication/1", steps: [
      { stepId: "init", clientId: "local", operation: "bootstrap", fixtureId: "genesis", transactionId: "bootstrap" },
      { stepId: "source", clientId: sourceClient, operation: "publish-source", fixtureId: "source", transactionId: "source-create" },
    ] } });
  return { f, native, manifest, projectRoots, source, sourceRef, controlRef, synthetic, sourceClient, now };
}
async function supervisedFixture(crossClient = false) {
  const prepared = prepareSupervisedFixture(crossClient); const { manifest, projectRoots, now } = prepared;
  const targets = manifest.clients.map((client, index) => {
    const commonDir = client.scope.binding.commonDir; saveQualificationManifest(commonDir, manifest);
    const scope = scopeForClient(manifest, client.clientId); const inputHash = hashObject(scope); const planHash = hashObject({ inputHash });
    const packet = createSemanticApprovalPacket({ planHash, inputHash, producerIdentity: "native-runner-fixture", binding: { planHash, inputDigest: inputHash, contextDigest: inputHash, observedHash: inputHash, policyDigest: inputHash },
      actions: [{ id: scope.kind, kind: "permission-change", protected: true, summary: "LOCAL supervised native fixture", before: null, after: inputHash, reversible: true, recovery: "Retain unknown resources" }] });
    const approvalRef = recordHumanApproval(commonDir, { scope, packet, approvedBy: "fixture-human", approvedAt: new Date(now).toISOString(), source: { kind: "explicit-human", messageHash: inputHash } }, planHash);
    return { clientId: client.clientId, projectRoot: projectRoots[index], approvalRef };
  });
  const result = await runLocalQualification(manifest, targets);
  return { ...prepared, targets, result, approvalRef: targets[0].approvalRef };
}
function qualificationCli(root: string, ...args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => execFile(process.execPath, ["--loader", fileURLToPath(new URL("./__fixtures__/native-worker-loader.mjs", import.meta.url)),
    "--import", fileURLToPath(new URL("./__fixtures__/native-worker-os.mjs", import.meta.url)), "--import", "tsx",
    fileURLToPath(new URL("../cli.ts", import.meta.url)), "coordination", "qualification", ...args, "--project", root],
  { encoding: "utf8", timeout: 180_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, HARNESS_FIXTURE_USER_ROOT: nativeHost.home, TSX_DISABLE_CACHE: "1" } },
  (error, stdout, stderr) => resolve({ status: error ? typeof error.code === "number" ? error.code : 1 : 0, stdout, stderr })));
}
function qualificationRequest(prepared: ReturnType<typeof prepareSupervisedFixture>) {
  const manifest = prepared.manifest;
  const input = join(prepared.f.bin, "qualification-request.json");
  writeFileSync(input, JSON.stringify({ manifest: Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== "manifestHash")),
    targets: manifest.clients.map((client, index) => ({ clientId: client.clientId, projectRoot: prepared.projectRoots[index] })) }));
  return input;
}
afterEach(async () => {
  Object.defineProperty(process, "platform", nativePlatform); vi.unstubAllEnvs(); roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  // Native commands are synchronous. Drain pending worker/report RPC messages between cases, not after the entire file.
  await new Promise<void>((resolve) => setImmediate(resolve));
});

describe("authenticated GitHub merge observation (LOCAL native-command fixtures)", { timeout: 30_000 }, () => {
  it("keeps the actual worker's startup authorization error instead of replacing it with unexpected exit", async () => {
    const f = fixture();
    await expect(startClientProcess({ projectRoot: f.root, approvalRef: "b".repeat(64), manifestHash: "c".repeat(64),
      clientId: "local", bindingHash: "a".repeat(64) })).rejects.toThrow("HUMAN_APPROVAL_REQUIRED");
  });

  it("runs the real CLI with native receipts, retryable partial approval and two-ref cleanup, never green qualification", async () => {
    const p = prepareSupervisedFixture(true); const input = qualificationRequest(p);
    const before = p.projectRoots.map((root) => git(root, "status", "--porcelain"));
    const planned = await qualificationCli(p.f.root, "plan", "--input", input);
    expect(planned.status, planned.stderr).toBe(0); const plan = JSON.parse(planned.stdout);
    expect(plan).toMatchObject({ approved: false, secretsRead: false, remoteWrites: 0, productionEnabled: false });
    expect(plan.planPath.startsWith(join(p.f.commonDir, "harness/plans/"))).toBe(true);
    expect(p.projectRoots.map((root) => git(root, "status", "--porcelain"))).toEqual(before);
    expect(existsSync(p.f.calls)).toBe(false); expect(existsSync(p.native.trace)).toBe(false);
    const saved = JSON.parse(readFileSync(plan.planPath, "utf8"));
    const original = readFileSync(plan.planPath, "utf8");
    writeFileSync(plan.planPath, JSON.stringify({ ...saved, approved: true }));
    expect((await qualificationCli(p.f.root, "run", "--plan", plan.planPath)).status).toBe(1);
    writeFileSync(plan.planPath, original);
    const request = JSON.parse(readFileSync(input, "utf8")); request.manifest.clients[0].scope.binding.actor = "imposter";
    const drifted = join(p.f.bin, "drifted-request.json"); writeFileSync(drifted, JSON.stringify(request));
    const driftResult = await qualificationCli(p.f.root, "plan", "--input", drifted);
    expect(driftResult.status).toBe(1); expect(driftResult.stderr).toContain("HUMAN_AUTHORIZATION_BINDING_MISMATCH");
    for (const limit of ["budget", "refs"]) {
      const limited = JSON.parse(readFileSync(input, "utf8"));
      if (limit === "budget") limited.manifest.clients[0].scope.maxCleanupAttempts = 1;
      else limited.manifest.clients[0].scope.refs = [p.controlRef];
      writeFileSync(drifted, JSON.stringify(limited));
      const result = await qualificationCli(p.f.root, "plan", "--input", drifted);
      expect(result.status).toBe(1); expect(result.stderr).toContain("QUALIFICATION_CLEANUP_SCOPE_INSUFFICIENT");
    }
    for (const [index, packet] of saved.packets.entries()) expect(() => loadHumanAuthorization(p.manifest.clients[index].scope.binding.commonDir, packet.packet.packetHash)).toThrow("HUMAN_APPROVAL_REQUIRED");
    const unapproved = await qualificationCli(p.f.root, "run", "--plan", plan.planPath);
    expect(unapproved.status).toBe(1); expect(unapproved.stderr).toContain("HUMAN_APPROVAL_REQUIRED");
    const approve = ["approve", "--plan", plan.planPath, "--approve", plan.planHash, "--approved-by", "fixture-human", "--approval-source", "synthetic-explicit-user-message"];
    const wrong = [...approve]; wrong[4] = "0".repeat(64);
    expect((await qualificationCli(p.f.root, ...wrong)).status).toBe(1);
    const secondCommon = p.manifest.clients[1].scope.binding.commonDir;
    const lock = acquireMutationLock({ projectDir: p.projectRoots[1], commonDir: secondCommon, repository: true });
    try {
      const partial = await qualificationCli(p.f.root, ...approve); expect(partial.status).toBe(1);
      expect(JSON.parse(partial.stdout)).toMatchObject({ executionStatus: "partial", registered: [{ clientId: "local" }], pending: ["other"] });
    } finally { releaseMutationLock(lock); }
    const first = loadHumanAuthorization(p.f.commonDir, saved.packets[0].packet.packetHash);
    const resumed = await qualificationCli(p.f.root, ...approve); expect(resumed.status, resumed.stderr).toBe(0);
    const changedSource = [...approve]; changedSource[8] = "different-user-message";
    const changedApproval = await qualificationCli(p.f.root, ...changedSource);
    expect(changedApproval.status).toBe(1); expect(changedApproval.stderr).toContain("HUMAN_APPROVAL_ALREADY_RECORDED");
    expect(loadHumanAuthorization(p.f.commonDir, saved.packets[0].packet.packetHash)).toEqual(first);
    expect(loadHumanAuthorization(secondCommon, saved.packets[1].packet.packetHash).approval.approvedAt).toBe(first.approval.approvedAt);
    expect(existsSync(p.f.calls)).toBe(false); expect(existsSync(p.native.trace)).toBe(false);
    const completed = await qualificationCli(p.f.root, "run", "--plan", plan.planPath);
    expect(completed.status, completed.stderr || completed.stdout).toBe(2);
    const report = JSON.parse(completed.stdout);
    expect(report).toMatchObject({ executionStatus: "completed", qualificationStatus: "incomplete", qualified: false, topology: "LOCAL",
      counts: { commits: 2, writeAttempts: 2, cleanupAttempts: 2 }, requiredCases: [{ id: "dg01-cas", status: "not-run" }],
      cleanup: [{ status: "deleted", ref: p.controlRef }, { status: "deleted", ref: p.sourceRef }] });
    expect(JSON.parse(readFileSync(report.reportPath, "utf8"))).toMatchObject({ qualified: false, executionStatus: "completed" });
    expect(git(p.f.root, "--git-dir=" + p.native.remote, "for-each-ref", "--format=%(refname)")).toBe("");
    const repeated = await qualificationCli(p.f.root, "run", "--plan", plan.planPath);
    expect(repeated.status).toBe(1); expect(JSON.parse(repeated.stdout).error).toBe("QUALIFICATION_RUN_ALREADY_STARTED");
    expect(p.projectRoots.map((root) => git(root, "status", "--porcelain"))).toEqual(before);
  }, 180_000);

  it.each(["publication", "cleanup"])("retains real asynchronous failure facts without replay (%s)", async (phase) => {
    const p = prepareSupervisedFixture(); const input = qualificationRequest(p);
    const planned = await qualificationCli(p.f.root, "plan", "--input", input); expect(planned.status, planned.stderr).toBe(0);
    const plan = JSON.parse(planned.stdout);
    const approved = await qualificationCli(p.f.root, "approve", "--plan", plan.planPath, "--approve", plan.planHash, "--approved-by", "fixture-human", "--approval-source", "synthetic-explicit-user-message");
    expect(approved.status, approved.stderr).toBe(0);
    writeFileSync(p.native.fault, JSON.stringify(phase === "cleanup" ? { readbackFailure: true } : { failReadRef: p.sourceRef }));
    const failed = await qualificationCli(p.f.root, "run", "--plan", plan.planPath);
    expect(failed.status, failed.stderr).toBe(1); const report = JSON.parse(failed.stdout);
    expect(report).toMatchObject({ executionStatus: "failed", qualified: false, qualificationStatus: "incomplete", cleanup: [] });
    expect(report.error).toBeTruthy(); expect(failed.stderr).not.toContain("UnhandledPromiseRejection");
    expect(JSON.parse(readFileSync(report.reportPath, "utf8"))).toEqual(expect.objectContaining({ error: report.error, recovery: report.recovery }));
    const reference = JSON.parse(approved.stdout).registered[0].approvalRef;
    if (phase === "publication") {
      expect(report.execution).toMatchObject({ steps: [{ stepId: "init" }], launchRequestedClients: ["local"], readyClients: ["local"], drainCoverage: "unproven" });
      expect(git(p.f.root, "--git-dir=" + p.native.remote, "rev-parse", p.controlRef)).toBe(p.synthetic.objects[0].commitSha);
      expect(loadHumanAuthorization(p.f.commonDir, reference).attempts.some((item) => item.operation === "cleanup")).toBe(false);
      return;
    }
    const state = loadHumanAuthorization(p.f.commonDir, reference); const attempt = state.attempts.find((item) => item.operation === "cleanup")!;
    expect(attempt.outcome?.status).toBe("unknown");
    const pushes = () => readFileSync(p.native.trace, "utf8").split("\n").filter((line) => line && JSON.parse(line).argv.includes("push")).length;
    const count = pushes(); writeFileSync(p.native.fault, "{}");
    const recovered = await qualificationCli(p.f.root, "recover-cleanup", "--approval", reference, "--attempt", attempt.attemptId);
    expect(recovered.status, recovered.stderr).toBe(0); expect(JSON.parse(recovered.stdout)).toMatchObject({ status: "applied", attemptId: attempt.attemptId });
    expect(pushes()).toBe(count); expect(git(p.f.root, "--git-dir=" + p.native.remote, "rev-parse", p.sourceRef)).toBe(p.source.commitSha);
  }, 180_000);

  it.each([false, true])("supervises fixed native publications and exact cleanup without claiming the full DG case (cross-client=%s)", async (crossClient) => {
    const { f, native, manifest, targets, result, source, sourceRef, controlRef, synthetic, approvalRef, sourceClient } = await supervisedFixture(crossClient);
    expect(result.report).toMatchObject({ qualified: false, status: "incomplete", topology: "LOCAL", counts: { commits: 2, writeAttempts: 2, cleanupAttempts: 0 }, countsComplete: true });
    expect(result.report.requiredCases).toEqual([{ id: "dg01-cas", status: "not-run" }]);
    expect(result.report.blockers).toEqual([{ code: "QUALIFICATION_REMOTE_HISTORY_UNPROVEN" }]);
    expect(result.report.execution.steps.map((step) => step.stepId)).toEqual(["init", "source"]);
    expect(readSettledQualification(result.settled).instances[0]).toMatchObject({ leader: { parent: process.pid }, finalMembers: [] });
    // Uncached source transforms really started a compiler descendant; drain did not pass on a warm-loader coincidence.
    expect(nativeHost.sourceGroupSizes).toHaveLength(targets.length); expect(nativeHost.sourceGroupSizes.every((size) => size > 1)).toBe(true);
    expect(() => readSettledQualification({ ...result.settled })).toThrow("QUALIFICATION_RUNNER_DRAIN_UNPROVEN");
    const state = loadHumanAuthorization(f.commonDir, approvalRef); expect(state).toMatchObject({ writesClosed: true, revoked: false });
    expect(state.attempts.every((attempt) => attempt.outcome?.status === "applied")).toBe(true);
    expect(execFileSync(native.realGit, ["rev-parse", sourceRef], { cwd: native.remote, encoding: "utf8" }).trim()).toBe(source.commitSha);
    const observed = observeQualificationRemote(result.settled); const facts = readQualificationRemote(observed);
    expect(facts.observations).toEqual([
      { ref: controlRef, head: synthetic.objects[0].commitSha, ancestry: [synthetic.objects[0].commitSha], winner: expect.objectContaining({ clientId: "local", transactionId: "bootstrap" }) },
      { ref: sourceRef, head: source.commitSha, ancestry: [source.commitSha], winner: expect.objectContaining({ clientId: sourceClient, transactionId: "source-create" }) },
    ]);
    expect(() => readQualificationRemote({ ...observed })).toThrow("QUALIFICATION_REMOTE_ORIGIN_UNPROVEN");
    expect(() => observeQualificationRemote({ ...result.settled })).toThrow("QUALIFICATION_RUNNER_DRAIN_UNPROVEN");
    const trace = readFileSync(native.trace, "utf8"); expect(trace).not.toContain("synthetic-provider-canary");
    await expect(runLocalQualification(manifest, targets)).rejects.toThrow("QUALIFICATION_RUN_ALREADY_STARTED");
    expect(readFileSync(native.trace, "utf8")).toBe(trace);
    execFileSync(native.realGit, ["update-ref", sourceRef, synthetic.objects[0].commitSha, source.commitSha], { cwd: native.remote });
    expect(() => observeQualificationRemote(result.settled)).toThrow("QUALIFICATION_REMOTE_HISTORY_UNPROVEN");
    execFileSync(native.realGit, ["update-ref", sourceRef, source.commitSha, synthetic.objects[0].commitSha], { cwd: native.remote });
    const cleanup = planQualificationCleanup(observed, sourceRef);
    await expect(applyQualificationCleanup({ ...cleanup })).rejects.toThrow("QUALIFICATION_CLEANUP_ORIGIN_UNPROVEN");
    expect(() => planQualificationCleanup(observed, "refs/heads/main")).toThrow("HUMAN_WRITE_SCOPE_MISMATCH");
    const raw = new GitHubCoordinationTransport(f.root, "origin", "42", "git");
    expect(() => raw.deleteRef(sourceRef, source.commitSha)).toThrow("COORDINATION_CLEANUP_AUTHORIZATION_REQUIRED");
    expect(await applyQualificationCleanup(cleanup)).toMatchObject({ status: "deleted", ref: sourceRef });
    await expect(applyQualificationCleanup(cleanup)).rejects.toThrow("QUALIFICATION_CLEANUP_ORIGIN_UNPROVEN");
    const second = planQualificationCleanup(observeQualificationRemote(result.settled), controlRef);
    expect(await applyQualificationCleanup(second)).toMatchObject({ status: "deleted", ref: controlRef });
    expect(execFileSync(native.realGit, ["for-each-ref", "--format=%(refname)"], { cwd: native.remote, encoding: "utf8" }).trim()).toBe("");
    const absent = planQualificationCleanup(observeQualificationRemote(result.settled), sourceRef);
    expect(await applyQualificationCleanup(absent)).toEqual({ status: "observed-absent", ref: sourceRef, attemptId: null });
    const final = loadHumanAuthorization(f.commonDir, approvalRef);
    expect(final.attempts.filter((attempt) => attempt.operation === "cleanup")).toHaveLength(2);
    expect(final.candidates).toHaveLength(crossClient ? 1 : 2); expect(final.attempts.every((attempt) => attempt.outcome?.status === "applied")).toBe(true);
  }, 90_000);

  it.each(["stale", "readback", "lost-output"])("retains exact cleanup failures and recovers facts without replay (%s)", async (fault) => {
    const { f, native, result, sourceRef, controlRef, synthetic, approvalRef } = await supervisedFixture();
    const cleanup = planQualificationCleanup(observeQualificationRemote(result.settled), sourceRef);
    writeFileSync(native.fault, JSON.stringify(fault === "stale" ? { beforeDeleteHead: synthetic.objects[0].commitSha } : fault === "readback" ? { readbackFailure: true } : { dropDeleteOutput: true }));
    let failure: unknown; try { await applyQualificationCleanup(cleanup); } catch (error) { failure = error; }
    const attempt = loadHumanAuthorization(f.commonDir, approvalRef).attempts.at(-1)!;
    expect(failure instanceof Error ? failure.message : null, JSON.stringify(attempt.outcome?.push)).toContain(fault === "stale" ? "COORDINATION_CAS_CONFLICT" : fault === "readback" ? "COORDINATION_REMOTE_OBSERVATION_FAILED" : "COORDINATION_WRITE_OUTCOME_UNKNOWN");
    expect(attempt).toMatchObject({ operation: "cleanup", outcome: { status: fault === "stale" ? "rejected" : "unknown" } });
    await expect(applyQualificationCleanup(cleanup)).rejects.toThrow("QUALIFICATION_CLEANUP_ORIGIN_UNPROVEN");
    const pushes = () => readFileSync(native.trace, "utf8").trim().split("\n").map((line) => JSON.parse(line).argv as string[]).filter((argv) => argv.includes("push")).length;
    const before = pushes(); writeFileSync(native.fault, "{}");
    if (fault === "stale") {
      await expect(recoverQualificationCleanup(f.root, approvalRef, attempt.attemptId)).rejects.toThrow("COORDINATION_RECOVERY_REQUIRED");
      expect(execFileSync(native.realGit, ["rev-parse", sourceRef], { cwd: native.remote, encoding: "utf8" }).trim()).toBe(synthetic.objects[0].commitSha);
    } else {
      expect(() => observeQualificationRemote(result.settled)).toThrow("HUMAN_WRITE_OUTCOME_UNRESOLVED");
      const recovered = await recoverQualificationCleanup(f.root, approvalRef, attempt.attemptId);
      expect(recovered).toMatchObject({ observed: null, status: fault === "readback" ? "applied" : "state-observed" });
      await recoverQualificationCleanup(f.root, approvalRef, attempt.attemptId);
      expect(loadHumanAuthorization(f.commonDir, approvalRef).attempts.at(-1)!.outcome!.status).toBe(fault === "readback" ? "applied" : "unknown");
    }
    expect(pushes()).toBe(before);
    expect(execFileSync(native.realGit, ["rev-parse", controlRef], { cwd: native.remote, encoding: "utf8" }).trim()).toBe(synthetic.objects[0].commitSha);
    expect(loadHumanAuthorization(f.commonDir, approvalRef).attempts.filter((item) => item.operation === "cleanup")).toHaveLength(1);
  }, 90_000);

  it("collects actual local identity and complete receipts without turning missing clients, stale copies or absent execution into PASS", () => {
    const f = fixture(); const binding = observeCoordinationBinding(f.root, "origin", "42", "git"); const now = Date.now();
    const controlRef = "refs/heads/collector"; const synthetic = syntheticScope("collector", controlRef);
    const definition = { kind: "qualification-run" as const, binding, runId: "collector", synthetic, refs: [controlRef], operations: ["create" as const],
      maxCommits: 1, maxWriteAttempts: 1, maxCleanupAttempts: 1, expiresAt: new Date(now + 3600_000).toISOString(), cleanupExpiresAt: new Date(now + 7200_000).toISOString() };
    const input = { schemaVersion: "qualification-run-manifest/1" as const, runId: "collector", repository: binding.repository, repositoryId: binding.repositoryId, endpointHash: binding.endpointHash,
      refs: [controlRef], synthetic, requiredCases: ["dg01-cas" as const], clients: [{ clientId: "local", scope: definition },
        { clientId: "missing", scope: { ...definition, binding: { ...binding, commonDir: join(f.root, "not-collected") }, synthetic: { ...synthetic, publications: [] }, maxCleanupAttempts: 0 } }],
      cleanupClientId: "local", maxCommits: 2, maxWriteAttempts: 2, maxCleanupAttempts: 1, expiresAt: definition.expiresAt, cleanupExpiresAt: definition.cleanupExpiresAt };
    const manifest = prepareQualificationManifest(input); saveQualificationManifest(f.commonDir, manifest); const scope = scopeForClient(manifest, "local");
    const inputHash = hashObject(scope); const planHash = hashObject({ inputHash });
    const packet = createSemanticApprovalPacket({ planHash, inputHash, producerIdentity: "native-collector-fixture",
      binding: { planHash, inputDigest: inputHash, contextDigest: inputHash, observedHash: inputHash, policyDigest: inputHash },
      actions: [{ id: scope.kind, kind: "permission-change", protected: true, summary: "LOCAL collector test", before: null, after: inputHash, reversible: true, recovery: "Read-only facts" }] });
    const reference = recordHumanApproval(f.commonDir, { scope, packet, approvedBy: "fixture-human", approvedAt: new Date(now).toISOString(), source: { kind: "explicit-human", messageHash: inputHash } }, planHash);
    const before = collectClientEvidence(f.root, reference); const report = evaluateQualificationRun(manifest, [before]);
    expect(report).toMatchObject({ status: "incomplete", qualified: false, topology: "LOCAL", countsComplete: false });
    expect(report.blockers).toEqual(expect.arrayContaining([{ code: "QUALIFICATION_CLIENT_MISSING", clientId: "missing" },
      { code: "HUMAN_QUALIFICATION_WRITES_OPEN", clientId: "local" }, { code: "QUALIFICATION_RUNNER_DRAIN_UNPROVEN" }, { code: "QUALIFICATION_REMOTE_HISTORY_UNPROVEN" }]));
    expect(report.requiredCases).toEqual([{ id: "dg01-cas", status: "not-run" }]);
    expect(() => readVerifiedClientEvidence({ ...before })).toThrow("QUALIFICATION_EVIDENCE_ORIGIN_UNPROVEN");
    const projection = readVerifiedClientEvidence(before); projection.chains[0].state.writesClosed = true;
    expect(readVerifiedClientEvidence(before).chains[0].state.writesClosed).toBe(false);
    expect(() => evaluateQualificationRun(prepareQualificationManifest({ ...input, maxCommits: 3 }), [before])).toThrow("QUALIFICATION_CLIENT_EVIDENCE_MISMATCH");
    closeQualificationWrites(f.commonDir, reference); expect(() => recheckClientEvidence(before)).toThrow("QUALIFICATION_EVIDENCE_DRIFT");
    const after = collectClientEvidence(f.root, reference); expect(readVerifiedClientEvidence(after).chains[0].state.writesClosed).toBe(true);
    expect(evaluateQualificationRun(manifest, [after]).qualified).toBe(false);
    expect(() => readFileSync(f.calls)).toThrow(); // Identity/receipt collection neither resolves secrets nor calls GitHub.
    const records = readVerifiedClientEvidence(after).lkg; rmSync(join(f.commonDir, "harness/lkg/approval-human/records", `${String(records.at(-1)!.sequence).padStart(12, "0")}.json`));
    expect(() => collectClientEvidence(f.root, reference)).toThrow("HUMAN_AUTHORIZATION_RECOVERY_REQUIRED");
  });

  it.each([false, true])("claims an expired unchanged generation from the real reader, including a frozen source (%s)", (frozen) => {
    const { root, commonDir, provider, record: original, calls } = fixture();
    const record = frozen ? createCoordinationRecord({ ...original, transactionId: "frozen-transfer", handoff: {
      transferId: "frozen-transfer", source: { owner: original.owner, machine: original.machine, generation: original.generation,
        epoch: original.controlEpochDigest, head: original.lastObservedHead, expiresAt: original.expiresAt! },
      target: { owner: "another", machine: "another-host" },
    } }) : original;
    const remote = join(root, "remote.git"); git(root, "init", "--bare", "--quiet", remote);
    const controlRef = "refs/heads/coordination"; const genesis = seedLocalGenesis(remote, controlRef);
    const store = new GitCoordinationStore(controlRef, { ...localTransport(root, remote), repositoryId: "42" }, () => {}, genesis,
      localHistory(commonDir, controlRef, genesis, "42"), () => () => {});
    store.compareAndSwap({ workItem: record.workItem, expectedControlSha: genesis.commitSha, expected: {}, next: record });
    const lifecycle = new CoordinationLifecycleService(store, () => provider.serverClock(), provider, () => {}); // LOCAL store fixture; actual PR observer remains native.
    const terminal = lifecycle.terminalClaim(record.workItem, expectedRecord(record), 9, "main");
    expect(terminal).toMatchObject({ expiresAt: null, lifecycleState: "Integrated", generation: 1, closeOwnerGeneration: 1, lastObservedHead: record.lastObservedHead,
      integration: { integratedSourceHead: record.lastObservedHead, integratedCommit: "c".repeat(40), headRepositoryId: "43", baseRepositoryId: "42" } });
    expect(validRecord(terminal)).toBe(true);
    expect(terminal.handoff).toBeUndefined(); // The frozen source remains in the validated ancestor history.
    expect(() => lifecycle.rebind(record.workItem, expectedRecord(terminal), "no-write", record.lastObservedHead)).toThrow("COORDINATION_WRITE_LEASE_UNAVAILABLE");
    expect(() => lifecycle.terminalClaim(record.workItem, expectedRecord(record), 9, "main")).toThrow("COORDINATION_STALE_RECORDHASH");
    expect(readFileSync(calls, "utf8")).not.toContain("synthetic-provider-canary");
    expect(provider.serverClock().bounds().upperMs).toBeGreaterThan(0);
  });

  it("rejects unmerged, identity/source/base drift, bad Date and revoked metadata access", () => {
    const { provider, record, pr, respond } = fixture();
    for (const changed of [
      { ...pr, merged: false }, { ...pr, state: "open" }, { ...pr, number: 10 }, { ...pr, merge_commit_sha: null },
      { ...pr, head: { ...pr.head, sha: "d".repeat(40) } }, { ...pr, head: { ...pr.head, repo: { id: 99 } } },
      { ...pr, base: { ...pr.base, ref: "release" } }, { ...pr, base: { ...pr.base, repo: { id: 99, full_name: "owner/repo" } } },
    ]) { respond({ pr: changed }); expect(() => provider.observeMerge(record, 9, "main")).toThrow(); }
    respond({ pr, date: "bad-date" }); expect(() => provider.observeMerge(record, 9, "main")).toThrow();
    respond({ pr, actor: "another" }); expect(() => provider.observeMerge(record, 9, "main")).toThrow("CREDENTIAL_CAPABILITY_DENIED");
    respond({ pr, repoId: 99 }); expect(() => provider.observeMerge(record, 9, "main")).toThrow("CREDENTIAL_REPOSITORY_ID_MISMATCH");
  });

  it("refuses an endpoint change or stale native registration before reading a secret", () => {
    const { root, commonDir, provider, record, calls, plan } = fixture();
    git(root, "remote", "set-url", "origin", "https://github.com/owner/other.git");
    expect(() => provider.observeMerge(record, 9, "main")).toThrow("CREDENTIAL_REPOSITORY_BINDING_MISMATCH");
    git(root, "remote", "set-url", "origin", "https://github.com/owner/repo.git");
    const updated = planCredentialHostBinding(commonDir, { schemaVersion: plan.binding.schemaVersion, commonDir, repository: plan.binding.repository, repositoryId: "42", endpointHash: plan.binding.endpointHash,
      credentials: plan.binding.credentials.map(({ hostId, ...ref }) => ({ ...ref, keychainAccount: `replacement-${hostId}` })) });
    applyCredentialHostBinding(commonDir, updated, updated.planHash);
    expect(() => provider.observeMerge(record, 9, "main")).toThrow("CREDENTIAL_BINDING_STALE");
    expect(() => readFileSync(calls)).toThrow();
  });

  it("runs the production Git adapter with explicit credentials, exact CAS and no implicit write permission", () => {
    const f = fixture(); const { root, plan } = f; const { trace } = nativeGitFixture(f);
    const objectDirectory = realpathSync(mkdtempSync(join(root, "objects-")));
    git(root, "init", "--bare", "--quiet", "--template=", objectDirectory);
    const tree = git(objectDirectory, "hash-object", "-t", "tree", "-w", "--stdin");
    const commit = (message: string, parent?: string) => git(objectDirectory, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message);
    const head = commit("initial"); const ref = "refs/heads/coordination-fixture";
    const readonly = new GitHubCoordinationTransport(root, "origin", "42", "git");
    expect(readonly.readRef(ref)).toBeNull();
    expect(() => readonly.push(objectDirectory, head, ref, null)).toThrow("COORDINATION_WRITE_AUTHORIZATION_REQUIRED");
    expect(() => new GitHubCoordinationTransport(root, "origin", "42", "api")).toThrow("CREDENTIAL_REF_UNREGISTERED");
    const writes: CoordinationWriteIntent[] = [];
    const transport = new GitHubCoordinationTransport(root, "origin", "42", "git", (intent) => { expect(intent.ref).toBe(ref); writes.push(intent); });
    expect(transport.push(objectDirectory, head, ref, null).status).toBe(0);
    expect(transport.readRef(ref)).toBe(head);
    const next = commit("next", head); expect(transport.push(objectDirectory, next, ref, head).status).toBe(0);
    const stale = transport.push(objectDirectory, commit("stale", next), ref, head);
    expect(stale.status).toBe(1); expect(stale.stdout).toContain("[rejected] (stale info)");
    const target = realpathSync(mkdtempSync(join(root, "retrieved-"))); git(root, "init", "--bare", "--quiet", "--template=", target);
    transport.fetch(target, next); expect(git(target, "cat-file", "-t", next)).toBe("commit");
    expect(writes[0]).toMatchObject({ credentialBindingHash: plan.binding.bindingHash, actor: "octo", hostId: plan.binding.hostId, head, expected: null });
    const traceBefore = readFileSync(trace, "utf8");
    git(objectDirectory, "config", "url.https://attacker.invalid/.insteadOf", "https://github.com/");
    expect(() => transport.fetch(objectDirectory, next)).toThrow("COORDINATION_OBJECT_DIRECTORY_INVALID");
    expect(readFileSync(trace, "utf8")).toBe(traceBefore);
    expect(traceBefore).not.toContain("synthetic-provider-canary");
    for (const line of traceBefore.trim().split("\n")) expect(JSON.parse(line)).toMatchObject({ global: "/dev/null", redirects: "false", hooks: "/dev/null" });
  });

  it.each([false, true])("runs a first bounded native qualification write without production enablement (borrowed lock: %s)", (borrowed) => {
    const f = fixture(); const { trace } = nativeGitFixture(f); const controlRef = "refs/heads/qualification-native";
    git(f.root, "checkout", "-b", f.record.branch);
    git(f.root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "LOCAL source");
    const sourceHead = git(f.root, "rev-parse", "HEAD");
    const binding = observeCoordinationBinding(f.root, "origin", "42", "git"); const now = Date.now();
    const scope: HumanScope = { kind: "qualification-run", binding, runId: "native-fixture", refs: [controlRef], operations: ["create", "cas"],
      synthetic: syntheticScope("native-fixture", controlRef),
      maxCommits: 2, maxWriteAttempts: 2, maxCleanupAttempts: 1, expiresAt: new Date(now + 3600_000).toISOString(), cleanupExpiresAt: new Date(now + 7200_000).toISOString() };
    const inputHash = hashObject(scope); const planHash = hashObject({ inputHash });
    const packet = createSemanticApprovalPacket({ planHash, inputHash, producerIdentity: "native-fixture",
      binding: { planHash, inputDigest: inputHash, contextDigest: inputHash, observedHash: inputHash, policyDigest: inputHash },
      actions: [{ id: scope.kind, kind: "permission-change", protected: true, summary: "LOCAL native-command test", before: null, after: inputHash, reversible: true, recovery: "Retain unknown objects" }] });
    const approvalRef = recordHumanApproval(f.commonDir, { scope, packet, approvedBy: "fixture-human", approvedAt: new Date(now).toISOString(), source: { kind: "explicit-human", messageHash: inputHash } }, planHash);
    const context = { projectDir: f.root, commonDir: f.commonDir, repository: true };
    const held = borrowed ? acquireMutationLock(context) : undefined;
    const acquired = (() => {
      try {
        const runtime = createQualificationRuntime(f.root, approvalRef, controlRef, held);
        if (held) expect(() => acquireMutationLock(context)).toThrow("WORKSPACE_LOCKED");
        const input = { repository: binding.repository, repositoryId: binding.repositoryId, workItem: f.record.workItem,
          branch: f.record.branch, sourceRepositoryId: binding.repositoryId, owner: binding.actor, machine: binding.hostId, controlEpochDigest: controlEpochDigest(binding.controlEpoch),
          head: sourceHead, ttlMs: 60_000, transactionId: "native-first-acquire" };
        const unapproved = createCoordinationRecord({ ...f.record, sourceRepositoryId: binding.repositoryId, lastObservedHead: sourceHead,
          controlEpochDigest: input.controlEpochDigest, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString() });
        expect(() => runtime.store.compareAndSwap({ workItem: unapproved.workItem, expectedControlSha: null, expected: {}, next: unapproved })).toThrow("COORDINATION_BOOTSTRAP_AUTHORIZATION_REQUIRED");
        for (const patch of [{ owner: "another" }, { machine: "other-host" }, { repositoryId: "99" }, { controlEpochDigest: "f".repeat(64) },
          { repository: "other/repo", workItem: "github:other/repo#86" }, { head: "b".repeat(40) }, { branch: "different" }]) {
          expect(() => runtime.lifecycle.acquire({ ...input, ...patch })).toThrow();
        }
        expect(loadHumanAuthorization(f.commonDir, approvalRef).candidates).toHaveLength(0);
        runtime.bootstrap();
        const genesis = scope.synthetic!.objects[0];
        expect(runtime.store.read(input.workItem)).toEqual({ controlSha: genesis.commitSha, record: null });
        expect(() => runtime.store.compareAndSwap({ workItem: unapproved.workItem, expectedControlSha: genesis.commitSha, expected: {}, next: unapproved })).toThrow("COORDINATION_OPERATION_AUTHORITY_REQUIRED");
        return runtime.lifecycle.acquire(input);
      } finally { if (held) releaseMutationLock(held); }
    })();
    if (held) expect(() => createQualificationRuntime(f.root, approvalRef, controlRef, held)).toThrow("MUTATION_LOCK_NOT_HELD");
    expect(acquired.generation).toBe(1); expect(acquired.machine).toBe(binding.hostId);
    const receipt = loadHumanAuthorization(f.commonDir, approvalRef);
    expect(receipt.candidates).toHaveLength(2); expect(receipt.attempts).toHaveLength(2); expect(receipt.attempts.every((attempt) => attempt.outcome?.status === "applied")).toBe(true);
    const before = readFileSync(trace, "utf8"); expect(before).not.toContain("synthetic-provider-canary");
    expect(before.trim().split("\n").filter((line) => JSON.parse(line).argv.includes("push"))).toHaveLength(2);
    mkdirSync(join(f.root, ".harness"), { recursive: true });
    writeFileSync(join(f.root, ".harness/policy.yaml"), "{}");
    expect(() => createQualificationRuntime(f.root, approvalRef, controlRef)).toThrow("HUMAN_AUTHORIZATION_BINDING_MISMATCH");
    rmSync(join(f.root, ".harness/policy.yaml"));
    writeFileSync(join(f.root, ".harness/coordination.json"), JSON.stringify({ schemaVersion: "coordination-config/1.0", enabled: false, repository: binding.repository, repositoryId: binding.repositoryId, remote: "origin", controlRef }));
    expect(() => createQualificationRuntime(f.root, approvalRef, controlRef)).toThrow("HUMAN_AUTHORIZATION_BINDING_MISMATCH");
    expect(readFileSync(trace, "utf8")).toBe(before);
  });

  it("composes an exact takeover sub-ticket through registered native Broker/Git adapters without production adoption", () => {
    const f = fixture(); const native = nativeGitFixture(f); const controlRef = "refs/heads/takeover-native";
    git(f.root, "checkout", "-b", f.record.branch);
    git(f.root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "LOCAL source fixture");
    const head = git(f.root, "rev-parse", "HEAD");
    // LOCAL setup is separate from the bounded native operations under test, never a claimed LIVE fixture run.
    execFileSync(native.realGit, ["push", native.remote, `HEAD:refs/heads/${f.record.branch}`], { cwd: f.root, stdio: "pipe" });
    const binding = observeCoordinationBinding(f.root, "origin", "42", "git"); const now = Date.now();
    function approve(scope: HumanScope) {
      const inputHash = hashObject(scope); const planHash = hashObject({ inputHash });
      const packet = createSemanticApprovalPacket({ planHash, inputHash, producerIdentity: "native-fixture",
        binding: { planHash, inputDigest: inputHash, contextDigest: inputHash, observedHash: inputHash, policyDigest: inputHash },
        actions: [{ id: scope.kind, kind: "permission-change", protected: true, summary: "LOCAL native takeover fixture", before: null, after: inputHash, reversible: false, recovery: "Retain assets" }] });
      return recordHumanApproval(f.commonDir, { scope, packet, approvedBy: "fixture-human", approvedAt: new Date(now).toISOString(),
        source: { kind: "explicit-human", messageHash: inputHash } }, planHash, f.provider.serverClock());
    }
    const run: Extract<HumanScope, { kind: "qualification-run" }> = { kind: "qualification-run", binding, runId: "native-seed", refs: [controlRef, `refs/heads/${f.record.branch}`],
      synthetic: syntheticScope("native-seed", controlRef),
      operations: ["create", "cas"], maxCommits: 2, maxWriteAttempts: 2, maxCleanupAttempts: 1,
      expiresAt: new Date(now + 3600_000).toISOString(), cleanupExpiresAt: new Date(now + 7200_000).toISOString() };
    const seeded = createQualificationRuntime(f.root, approve(run), controlRef);
    seeded.bootstrap(); const genesis = run.synthetic!.objects[0];
    const initial = seeded.lifecycle.acquire({ repository: binding.repository, repositoryId: binding.repositoryId, workItem: f.record.workItem,
      branch: f.record.branch, sourceRepositoryId: binding.repositoryId, owner: binding.actor, machine: binding.hostId,
      controlEpochDigest: controlEpochDigest(binding.controlEpoch), head, ttlMs: 120_000 });
    const current = seeded.store.read(initial.workItem);
    const parent = approve({ ...run, synthetic: { ...run.synthetic!, publications: [] }, maxCommits: 2, maxWriteAttempts: 2, takeoverAllocations: [{ allocationId: "one",
      workItem: initial.workItem, controlRef, sourceRef: `refs/heads/${initial.branch}`, genesisSha: genesis.commitSha, maxCommits: 1, maxWriteAttempts: 1 }] });
    const context = { projectDir: f.root, commonDir: f.commonDir, repository: true }; let held = acquireMutationLock(context);
    let risk: ReturnType<typeof observeTakeoverRisk>;
    try { risk = observeTakeoverRisk(context, held, initial, new GitHubCoordinationTransport(f.root, "origin", "42", "git"), binding); }
    finally { releaseMutationLock(held); }
    const child = approve({ kind: "takeover", binding, expiresAt: run.expiresAt, workItem: initial.workItem, controlRef, expectedControlSha: current.controlSha!,
      expected: expectedRecord(initial) as Extract<HumanScope, { kind: "takeover" }>["expected"], targetOwner: binding.actor, targetHostId: binding.hostId,
      targetWorkspace: f.root, targetBranch: initial.branch, targetHead: head, sourceRepositoryId: binding.repositoryId, newEpochDigest: controlEpochDigest(binding.controlEpoch),
      newLease: { ttlMs: 120_000, notAfter: new Date(now + 3600_000).toISOString() }, assetRisk: risk!, assetRiskHash: hashObject(risk!),
      transactionId: "native-takeover-once", maxCommits: 1, maxWriteAttempts: 1,
      qualification: { parentApprovalRef: parent, runId: run.runId, allocationId: "one", genesisSha: genesis.commitSha } });
    held = acquireMutationLock(context);
    try { expect(createTakeoverRuntime(f.root, child, held).takeover()).toMatchObject({ generation: 2, owner: binding.actor, machine: binding.hostId }); }
    finally { releaseMutationLock(held); }
    const receipt = loadHumanAuthorization(f.commonDir, child);
    expect(receipt.candidates).toHaveLength(1); expect(receipt.attempts).toHaveLength(1); expect(receipt.attempts[0].outcome?.status).toBe("applied");
    expect(readFileSync(native.trace, "utf8")).not.toContain("synthetic-provider-canary");
  }, 90_000);
});
