import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { planCredentialHostBinding, applyCredentialHostBinding } from "../credentials/host_binding.js";
import { hashObject, sha256 } from "../v2/fs.js";
import { acquireMutationLock, releaseMutationLock } from "../recovery/service.js";
import { createSemanticApprovalPacket } from "../approval/service.js";
import { loadHumanAuthorization, recordHumanApproval, type HumanScope } from "../approval/human.js";
import { createQualificationRuntime, observeCoordinationBinding } from "./runtime.js";
import { GitHubCoordinationReader } from "./github.js";
import { GitHubCoordinationTransport, type CoordinationWriteIntent } from "./transport.js";
import { CoordinationLifecycleService, GitCoordinationStore } from "./service.js";
import { createCoordinationRecord, expectedRecord, validRecord } from "./record.js";
import { localTransport } from "./__fixtures__/transport.js";
import { validateCoordinationHistory } from "./history.js";

const nativeHost = vi.hoisted(() => ({ home: "" }));
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
  Object.defineProperty(process, "platform", { ...nativePlatform, value: "darwin" });
  const root = realpathSync(mkdtempSync(join(tmpdir(), "coordination-provider-"))); roots.push(root);
  nativeHost.home = join(root, "user"); mkdirSync(nativeHost.home);
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null"); vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  git(root, "init", "--quiet"); const endpoint = "https://github.com/owner/repo.git"; git(root, "remote", "add", "origin", endpoint);
  const commonDir = join(root, ".git");
  const plan = planCredentialHostBinding(commonDir, { schemaVersion: "credential-host-binding/1.0", commonDir, repository: "owner/repo", repositoryId: "42", endpointHash: sha256(endpoint),
    credentials: [
      { id: "api", purpose: "github-api", repository: "owner/repo", identity: "octo", scopes: ["pull_requests:read"], expiresAt: "2099-01-01T00:00:00.000Z", envVar: "GH_TOKEN", keychainService: "synthetic", keychainAccount: "fixture" },
      { id: "git", purpose: "git-transport", repository: "owner/repo", identity: "octo", scopes: ["contents:write"], expiresAt: "2099-01-01T00:00:00.000Z", envVar: "HARNESS_GIT_TOKEN", keychainService: "synthetic", keychainAccount: "git-fixture" },
    ] });
  applyCredentialHostBinding(commonDir, plan, plan.planHash);
  const bin = join(root, "bin"); mkdirSync(bin); const calls = join(root, "calls.jsonl"); const response = join(root, "response.json");
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
  const remote = join(root, "remote.git"); git(root, "init", "--bare", "--quiet", "--template=", remote);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim(); const trace = join(root, "git-transport.jsonl");
  writeFileSync(join(bin, "git"), `#!${process.execPath}\nconst fs=require('node:fs');const cp=require('node:child_process');let a=process.argv.slice(2);if(a.some(x=>['ls-remote','fetch','push'].includes(x))){if(!a.includes(${JSON.stringify(endpoint)})||process.env.HARNESS_GIT_TOKEN!=='synthetic-provider-canary')process.exit(2);fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({argv:a,global:process.env.GIT_CONFIG_GLOBAL,redirects:process.env.GIT_CONFIG_VALUE_2,hooks:process.env.GIT_CONFIG_VALUE_3})+'\\n');a=a.map(x=>x===${JSON.stringify(endpoint)}?${JSON.stringify(remote)}:x);}const r=cp.spawnSync(${JSON.stringify(realGit)},a,{env:process.env,stdio:['inherit','pipe','pipe']});process.stdout.write(r.stdout??'');process.stderr.write(r.stderr??'');process.exit(r.status??1);\n`, { mode: 0o700 });
  return { trace, remote };
}
afterEach(() => { Object.defineProperty(process, "platform", nativePlatform); vi.unstubAllEnvs(); roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); });

describe("authenticated GitHub merge observation (LOCAL native-command fixtures)", { timeout: 30_000 }, () => {
  it.each([false, true])("claims an expired unchanged generation from the real reader, including a frozen source (%s)", (frozen) => {
    const { root, commonDir, provider, record: original, calls } = fixture();
    const record = frozen ? createCoordinationRecord({ ...original, transactionId: "frozen-transfer", handoff: {
      transferId: "frozen-transfer", source: { owner: original.owner, machine: original.machine, generation: original.generation,
        epoch: original.controlEpochDigest, head: original.lastObservedHead, expiresAt: original.expiresAt! },
      target: { owner: "another", machine: "another-host" },
    } }) : original;
    const remote = join(root, "remote.git"); git(root, "init", "--bare", "--quiet", remote);
    const controlRef = "refs/heads/coordination"; let genesis = "";
    const store = new GitCoordinationStore(controlRef, { ...localTransport(root, remote), repositoryId: "42" }, (candidate) => { if (!candidate.expectedControlSha) genesis = candidate.controlSha; }, true,
      (head, readValidatedCommit, isAncestor) => {
        const result = validateCoordinationHistory({ commonDir, anchor: { validationVersion: "coordination-history/1", genesisSha: genesis, repository: "owner/repo", repositoryId: "42", controlRef }, head, readValidatedCommit, isAncestor });
        if (result.status !== "verified") throw new Error("COORDINATION_HISTORY_VALIDATION_PENDING");
      }, () => () => {});
    store.compareAndSwap({ workItem: record.workItem, expectedControlSha: null, expected: {}, next: record });
    const lifecycle = new CoordinationLifecycleService(store, () => provider.serverClock(), provider);
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
    const binding = observeCoordinationBinding(f.root, "origin", "42", "git"); const now = Date.now();
    const scope: HumanScope = { kind: "qualification-run", binding, runId: "native-fixture", refs: [controlRef], operations: ["create", "cas"],
      maxCommits: 1, maxWriteAttempts: 1, maxCleanupAttempts: 1, expiresAt: new Date(now + 3600_000).toISOString(), cleanupExpiresAt: new Date(now + 7200_000).toISOString() };
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
        return runtime.lifecycle.acquire({ repository: binding.repository, repositoryId: binding.repositoryId, workItem: f.record.workItem,
          branch: f.record.branch, sourceRepositoryId: binding.repositoryId, owner: binding.actor, machine: binding.hostId, controlEpochDigest: "d".repeat(64),
          head: f.record.lastObservedHead, ttlMs: 60_000, transactionId: "native-first-acquire" });
      } finally { if (held) releaseMutationLock(held); }
    })();
    if (held) expect(() => createQualificationRuntime(f.root, approvalRef, controlRef, held)).toThrow("MUTATION_LOCK_NOT_HELD");
    expect(acquired.generation).toBe(1); expect(acquired.machine).toBe(binding.hostId);
    const receipt = loadHumanAuthorization(f.commonDir, approvalRef);
    expect(receipt.candidates).toHaveLength(1); expect(receipt.attempts).toHaveLength(1); expect(receipt.attempts[0].outcome?.status).toBe("applied");
    const before = readFileSync(trace, "utf8"); expect(before).not.toContain("synthetic-provider-canary");
    expect(before.trim().split("\n").filter((line) => JSON.parse(line).argv.includes("push"))).toHaveLength(1);
    mkdirSync(join(f.root, ".harness"), { recursive: true });
    writeFileSync(join(f.root, ".harness/coordination.json"), JSON.stringify({ schemaVersion: "coordination-config/1.0", enabled: false, repository: binding.repository, repositoryId: binding.repositoryId, remote: "origin", controlRef }));
    expect(() => createQualificationRuntime(f.root, approvalRef, controlRef)).toThrow("HUMAN_AUTHORIZATION_BINDING_MISMATCH");
    expect(readFileSync(trace, "utf8")).toBe(before);
  });
});
