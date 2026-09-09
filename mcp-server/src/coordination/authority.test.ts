import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { controlEpochDigest, observeQualificationEpoch, qualificationOperationAuthority } from "./authority.js";
import { CoordinationClock } from "./clock.js";
import { createCoordinationRecord } from "./record.js";

const roots: string[] = []; const digest = "a".repeat(64);
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "coordination-authority-"))); roots.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--quiet", "--initial-branch=codex/fixture");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "source");
  const head = git("rev-parse", "HEAD");
  const binding = { commonDir: join(root, ".git"), repository: "owner/repo", repositoryId: "42", endpointHash: digest,
    credentialBindingHash: digest, credentialRef: "git", credentialPurpose: "git-transport" as const, actor: "octo",
    hostId: "741ba5a8-40e2-4848-b5a4-082f4f2145a9", configHash: digest, controlEpoch: observeQualificationEpoch(root, digest),
    implementation: { kind: "package" as const, artifactDigest: digest }, runnerHash: digest };
  const record = createCoordinationRecord({ repository: binding.repository, repositoryId: binding.repositoryId, workItem: "github:owner/repo#1",
    branch: "codex/fixture", sourceRepositoryId: binding.repositoryId, owner: binding.actor, machine: binding.hostId,
    generation: 1, controlEpochDigest: controlEpochDigest(binding.controlEpoch), lastObservedHead: head,
    createdAt: "2026-09-04T04:00:00.000Z", expiresAt: "2026-09-04T04:01:00.000Z", lifecycleState: "Active", transactionId: "transaction" });
  let date = "Fri, 04 Sep 2026 04:00:00 GMT"; let observed = binding;
  const clock = () => { const value = new CoordinationClock(() => ({ monotonicMs: 0, wallMs: 0 })); value.observe(date, value.start()); return value; };
  const authority = qualificationOperationAuthority(root, binding, () => observed, clock);
  const intent = { transactionId: record.transactionId, parentSha: null, treeSha: head,
    subject: { kind: "coordination-record" as const, workItem: record.workItem, recordHash: record.recordHash }, objectDirectory: root, commitMetadataHash: digest };
  return { root, binding, record, authority, intent, expire: () => { date = "Fri, 04 Sep 2026 04:01:00 GMT"; },
    drift: () => { observed = { ...binding, credentialRef: "other" }; } };
}

it("binds a versioned cross-host epoch, including explicit absent policy and later policy drift", () => {
  const f = fixture(); const other = fixture();
  expect(controlEpochDigest(f.binding.controlEpoch)).toBe(controlEpochDigest(other.binding.controlEpoch));
  expect(controlEpochDigest(f.binding.controlEpoch)).not.toBe(f.binding.configHash);
  expect(() => controlEpochDigest({ ...f.binding.controlEpoch, hostId: f.binding.hostId } as never)).toThrow();
  mkdirSync(join(f.root, ".harness")); writeFileSync(join(f.root, ".harness/policy.yaml"), "{}");
  const present = observeQualificationEpoch(f.root, digest);
  expect(present.policy.kind).toBe("harness-policy-file"); expect(controlEpochDigest(present)).not.toBe(controlEpochDigest(f.binding.controlEpoch));
  writeFileSync(join(f.root, ".harness/policy.yaml"), '{"changed":true}'); expect(observeQualificationEpoch(f.root, digest)).not.toEqual(present);
  rmSync(join(f.root, ".harness/policy.yaml")); symlinkSync(join(f.root, "missing"), join(f.root, ".harness/policy.yaml"));
  expect(() => observeQualificationEpoch(f.root, digest)).toThrow("COORDINATION_POLICY_SNAPSHOT_INVALID");
});

it("rejects another owner's exact record, forged Head and raw candidate bypass", () => {
  const f = fixture(); const current = { controlSha: f.record.lastObservedHead, record: f.record };
  expect(() => f.authority.assertCandidate(f.intent)).toThrow("COORDINATION_OPERATION_AUTHORITY_REQUIRED");
  const victim = createCoordinationRecord({ ...f.record, owner: "victim" });
  for (const operation of ["rebind", "renew-reserve", "renew-confirm"] as const) {
    expect(() => f.authority.prepare(operation, { ...current, record: victim }, victim)).toThrow("COORDINATION_OPERATION_IDENTITY_MISMATCH");
  }
  expect(() => f.authority.prepare("rebind", current, createCoordinationRecord({ ...f.record, lastObservedHead: "b".repeat(40) })))
    .toThrow("COORDINATION_WORKSPACE_HEAD_MISMATCH");
  f.authority.prepare("acquire", { controlSha: null, record: null }, f.record); f.authority.assertCandidate(f.intent);
  expect(() => f.authority.assertCandidate({ ...f.intent, parentSha: f.record.lastObservedHead })).toThrow("COORDINATION_OPERATION_AUTHORITY_REQUIRED");
  f.expire(); expect(() => f.authority.assertCandidate(f.intent)).toThrow("COORDINATION_LEASE_WINDOW_EXHAUSTED");
});

it("rechecks credential binding at dispatch and invalidates a previous operation after failed preparation", () => {
  const f = fixture(); f.authority.prepare("acquire", { controlSha: null, record: null }, f.record);
  expect(() => f.authority.prepare("acquire", { controlSha: null, record: null }, createCoordinationRecord({ ...f.record, machine: "wrong" })))
    .toThrow("COORDINATION_OPERATION_IDENTITY_MISMATCH");
  expect(() => f.authority.assertCandidate(f.intent)).toThrow("COORDINATION_OPERATION_AUTHORITY_REQUIRED");
  f.authority.prepare("acquire", { controlSha: null, record: null }, f.record); f.drift();
  expect(() => f.authority.assertCandidate(f.intent)).toThrow("HUMAN_AUTHORIZATION_BINDING_MISMATCH");
});
