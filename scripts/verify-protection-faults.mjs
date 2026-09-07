import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createHash } from "node:crypto";

const sourceRoot = resolve(new URL("..", import.meta.url).pathname);
const packageRoot = resolve(sourceRoot, "mcp-server");
const selfTest = process.argv.includes("--self-test");
if (!selfTest && execFileSync("git", ["-C", sourceRoot, "status", "--porcelain"], { encoding: "utf8" }) !== "") {
  throw new Error("PROTECTION_FAULT_SOURCE_NOT_CLEAN");
}
const sourceSha = selfTest ? "self-test" : execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const cases = [
  ["identity-owner", "src/coordination/authority.ts", "identity?.owner !== binding.actor ||", "false ||", "src/coordination/authority.test.ts", "rejects another owner's exact record, forged Head and raw candidate bypass", "AssertionError: expected [Function] to throw an error", "src/coordination/authority.test.ts:53:"],
  ["expired-write", "src/coordination/leases.ts", "  clock.requireBefore(record.expiresAt);", "  void record.expiresAt;", "src/coordination/takeover.test.ts", "recovers an unknown applied transaction after expiry without replay, new generation or a new deadline", "AssertionError: expected [Function] to throw an error", "src/coordination/takeover.test.ts:122:"],
  ["exact-cas", "src/coordination/store.ts", "this.transport.push(directory, controlSha, this.controlRef, expectedControlSha)", "this.transport.push(directory, controlSha, this.controlRef, this.transport.readRef(this.controlRef))", "src/coordination/store.test.ts", "prepares two private same-parent CAS candidates and lets Git reject the stale dispatch while preserving another work item", "AssertionError: expected [Function] to throw error including 'COORDINATION_CAS_CONFLICT' but got 'COORDINATION_HISTORY_OBSERVATION_FAIL", "src/coordination/store.test.ts:116:"],
  ["stale-owner", "src/coordination/record.ts", "for (const [key, value] of Object.entries(expected)) if (record[key as keyof CoordinationRecord] !== value)", "for (const [key, value] of Object.entries(expected)) if (key !== \"owner\" && record[key as keyof CoordinationRecord] !== value)", "src/coordination/record.test.ts", "requires the complete exact expectation for an existing record; null is absence, not a wildcard", "AssertionError: expected [Function] to throw an error", "src/coordination/record.test.ts:29:"],
  ["one-shot", "src/coordination/publication.ts", "if (!prepared || prepared.consumed) throw new Error(\"SYNTHETIC_PREPARATION_UNPROVEN\");", "if (!prepared) throw new Error(\"SYNTHETIC_PREPARATION_UNPROVEN\");", "src/coordination/publication.test.ts", "rechecks the original authority and object at prepared dispatch (revocation)", "AssertionError: expected [Function] to throw error including 'SYNTHETIC_PREPARATION_UNPROVEN' but got 'HUMAN_AUTHORIZATION_BINDING_MISMATCH", "src/coordination/publication.test.ts:159:"],
  ["other-work-item", "src/coordination/store.ts", "objectGit(directory, [\"read-tree\", current.controlSha]);", "objectGit(directory, [\"read-tree\", \"--empty\"]);", "src/coordination/store.test.ts", "prepares two private same-parent CAS candidates and lets Git reject the stale dispatch while preserving another work item", "Error: COORDINATION_TREE_PRESERVATION_FAILED", "src/coordination/store.test.ts:109:"],
  ["remote-delete", "src/coordination/push_result.ts", "return result.status === 0 && match[1] === \"-\" && !match[2] && match[4] === \"[deleted]\" ? \"deleted\" : \"unknown\";", "return result.status === 0 ? \"deleted\" : \"unknown\";", "src/coordination/publication.test.ts", "requires exact positive deletion porcelain rather than absence, nonempty sources, no-ops or truncated output", "AssertionError: expected 'deleted' to be 'unknown'", "src/coordination/publication.test.ts:180:"],
  ["local-canonical-path", "src/approval/human_scope.ts", "const canonicalAbsolute = text.refine((value) => isAbsolute(value) && resolve(value) === value && !value.split(\"/\").includes(\"..\"));", "const canonicalAbsolute = text.refine((value) => isAbsolute(value));", "src/approval/human_resources.test.ts", "binds finite exact local resources without granting generic workspace authority", "AssertionError: expected [Function] to throw an error", "src/approval/human_resources.test.ts:64:"],
  ["revoked-write", "src/approval/human.ts", "if (!state.revoked) append(commonDir, state.approval.packet, event);", "if (false) append(commonDir, state.approval.packet, event);", "src/approval/human.test.ts", "does not lose a reservation after LKG tail loss or use expired/revoked authority", "AssertionError: expected [Function] to throw an error", "src/approval/human.test.ts:181:"],
  ["write-budget", "src/approval/human.ts", "if (used >= (cleanup ? scope.maxCleanupAttempts : ordinaryLimit(scope, \"maxWriteAttempts\"))) throw new Error(\"HUMAN_WRITE_BUDGET_EXHAUSTED\");", "if (used > (cleanup ? scope.maxCleanupAttempts : ordinaryLimit(scope, \"maxWriteAttempts\"))) throw new Error(\"HUMAN_WRITE_BUDGET_EXHAUSTED\");", "src/approval/human.test.ts", "counts rejection/unknown outcomes, refuses replay, and preserves separate cleanup allowance", "AssertionError: expected [Function] to throw an error", "src/approval/human.test.ts:163:"],
  ["writes-closed", "src/approval/human.ts", "if (!state.writesClosed) append(commonDir, state.approval.packet, { kind: \"qualification-writes-closed\", runId: scope.runId, manifest: scope.manifest });", "if (false) append(commonDir, state.approval.packet, { kind: \"qualification-writes-closed\", runId: scope.runId, manifest: scope.manifest });", "src/coordination/manifest.test.ts", "closes ordinary writes durably and idempotently, allowing facts but neither dispatch nor unverified cleanup", "AssertionError: expected {", "src/coordination/manifest.test.ts:150:"],
  ["local-assets", "src/worktree/qualification.ts", "if (assets.entries.length || inspectGit(resource.path, [\"ls-files\", \"--stage\", \"-z\"]) ||\n      readdirSync(resource.path).some((name) => name !== \".git\")) throw new Error(\"QUALIFICATION_RESOURCE_ASSETS_RETAINED\");", "if (false) throw new Error(\"QUALIFICATION_RESOURCE_ASSETS_RETAINED\");", "src/coordination/github.test.ts", "creates approved synthetic worktrees without touching primary content or erasing failure (complete)", "AssertionError: expected [Function] to throw error including 'QUALIFICATION_RESOURCE_ASSETS_RETAINED' but got 'QUALIFICATION_RESOURCE_METADATA_DRIFT'", "src/coordination/github.test.ts:300:"],
  // One fault model spans registration and lookup: accepting a structural, enumerable private handle.
  ["copied-private-handle", "src/coordination/publication.ts", ["new WeakMap<SyntheticPreparation,", "const prepared = preparations.get(handle);"], ["new Map<SyntheticPreparation,", "const prepared = preparations.get(handle) ?? [...preparations.values()][0];"], "src/coordination/publication.test.ts", "prepares without an attempt or held lock, refuses copied/reused handles, and still lets Git classify a later same-SHA no-op", "AssertionError: expected [Function] to throw an error", "src/coordination/publication.test.ts:145:"],
  ["local-directory-identity", "src/worktree/qualification.ts", "return { device: stat.dev, inode: stat.ino, birthtimeMs: stat.birthtimeMs, parentDevice: parent.dev, parentInode: parent.ino, parentBirthtimeMs: parent.birthtimeMs };", "return { device: parent.dev, inode: parent.ino, birthtimeMs: parent.birthtimeMs, parentDevice: parent.dev, parentInode: parent.ino, parentBirthtimeMs: parent.birthtimeMs };", "src/coordination/github.test.ts", "creates approved synthetic worktrees without touching primary content or erasing failure (complete)", "AssertionError: expected [Function] to throw an error", "src/coordination/github.test.ts:306:"],
  ["unknown-replay", "src/coordination/store.ts", "return this.recoverRecordedCandidate({ ...candidate, recordHash: candidate.record.recordHash });", "this.transport.push(candidate.objectDirectory, candidate.controlSha, candidate.controlRef, candidate.expectedControlSha); return this.recoverRecordedCandidate({ ...candidate, recordHash: candidate.record.recordHash });", "src/coordination/store.test.ts", "preserves an unknown-outcome candidate and recovers by exact history without repeating the push", "AssertionError: expected 1 to be +0", "src/coordination/store.test.ts:59:"],
];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const executionEnvironment = Object.freeze({ source: "fresh mcp-server package copy", gitMetadata: "excluded", harnessState: "excluded", credentials: "not provided", home: "fresh temporary directory", dependencyInstall: "npm ci --offline --ignore-scripts", ci: "1" });
const hasSingleTargetReport = (result) => Array.isArray(result?.report?.matches) && result.report.matches.length === 1 &&
  typeof result.report.report?.success === "boolean" && typeof result.report.report.numFailedTests === "number";
const completedTarget = (result) => result?.error === null && result.signal === null && typeof result.exitCode === "number" && hasSingleTargetReport(result);
const passedTarget = (result) => completedTarget(result) && result.exitCode === 0 && result.report.report.success === true &&
  result.report.matches[0].status === "passed" && result.report.report.numFailedTests === 0;
const failedTarget = (result, expectedAssertion, expectedFailureLocation) => completedTarget(result) && result.exitCode === 1 && result.report.report.success === false &&
  result.report.matches[0].status === "failed" && result.report.report.numFailedTests === 1 &&
  Array.isArray(result.report.matches[0].failureMessages) &&
  result.report.matches[0].failureMessages.some((message) => message.startsWith(expectedAssertion) && message.includes(expectedFailureLocation));
const classify = (patchApplied, clean, mutant, restored, expectedAssertion, expectedFailureLocation) => {
  if (!patchApplied) return "invalid-injection";
  if (!passedTarget(clean) || !passedTarget(restored) || !completedTarget(mutant)) return "unable-to-execute";
  if (failedTarget(mutant, expectedAssertion, expectedFailureLocation)) return "correctly-caught";
  return passedTarget(mutant) ? "survived" : "unrelated-failure";
};
if (selfTest) {
  const passed = { error: null, signal: null, exitCode: 0, report: { matches: [{ status: "passed", failureMessages: [] }], report: { success: true, numFailedTests: 0 } } };
  const failed = { error: null, signal: null, exitCode: 1, report: { matches: [{ status: "failed", failureMessages: ["AssertionError: expected [Function] to throw an error\\n    at src/target.test.ts:10:3"] }], report: { success: false, numFailedTests: 1 } } };
  const assertion = "AssertionError: expected [Function] to throw an error";
  const location = "src/target.test.ts:10:";
  assert.equal(passedTarget(passed), true);
  assert.equal(passedTarget({ ...passed, exitCode: 1 }), false);
  assert.equal(failedTarget(failed, assertion, location), true);
  assert.equal(failedTarget(failed, assertion, "src/target.test.ts:11:"), false);
  assert.equal(classify(true, { ...passed, exitCode: 1 }, failed, passed, assertion, location), "unable-to-execute");
  assert.equal(classify(true, passed, { ...failed, signal: "SIGTERM", exitCode: null }, passed, assertion, location), "unable-to-execute");
  assert.equal(classify(true, passed, failed, passed, assertion, "src/target.test.ts:11:"), "unrelated-failure");
  process.stdout.write("protection-fault verifier self-test passed\\n");
  process.exit(0);
}
const run = (command, args, cwd, env) => {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
  const stdout = result.stdout ?? ""; const stderr = result.stderr ?? "";
  return { exitCode: result.status, signal: result.signal, error: result.error?.code ?? (result.error ? "UNKNOWN" : null), stdoutSha256: hash(stdout), stderrSha256: hash(stderr), stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr), output: `${stdout}${stderr}` };
};
const targetResult = (path, testName) => {
  try {
    const report = JSON.parse(readFileSync(path, "utf8"));
    const matches = report.testResults.flatMap((suite) => suite.assertionResults).filter((test) => test.fullName.endsWith(testName));
    return { reportSha256: hash(JSON.stringify(report)), report, matches };
  } catch { return null; }
};
const root = mkdtempSync(join(tmpdir(), "harness-protection-faults-"));
const evidence = [];
try {
  for (const [id, path, before, after, testFile, testName, expectedAssertion, expectedFailureLocation] of cases) {
    const sandbox = join(root, id);
    cpSync(packageRoot, sandbox, { recursive: true, filter: (entry) => !["node_modules", "dist", ".harness"].includes(basename(entry)) });
    // Dependencies are copied into each sandbox. No source tree, Git metadata, approval receipt, or credential location is shared.
    const npmEnv = { PATH: process.env.PATH, HOME: join(root, "home"), NPM_CONFIG_USERCONFIG: "/dev/null", NPM_CONFIG_CACHE: join(process.env.HOME ?? "", ".npm") };
    const setupArgv = ["npm", "ci", "--offline", "--ignore-scripts", "--no-audit", "--fund=false"];
    execFileSync(setupArgv[0], setupArgv.slice(1), { cwd: sandbox, env: npmEnv, stdio: "pipe" });
    const target = join(sandbox, path); const original = readFileSync(target, "utf8");
    const invoke = (phase) => {
      const reportPath = join(sandbox, `${phase}.json`);
      const testPattern = testName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      const argv = ["./node_modules/.bin/vitest", "run", testFile, "-t", testPattern, "--reporter=json", `--outputFile=${reportPath}`, "--maxWorkers=1"];
      const execution = run(argv[0], argv.slice(1), sandbox, { PATH: process.env.PATH, HOME: join(root, "home"), CI: "1" });
      return { argv, environment: executionEnvironment, ...execution, report: targetResult(reportPath, testName) };
    };
    const clean = invoke("baseline");
    const beforeParts = Array.isArray(before) ? before : [before]; const afterParts = Array.isArray(after) ? after : [after];
    const patchApplied = beforeParts.length === afterParts.length && beforeParts.every((value) => original.includes(value) && original.indexOf(value) === original.lastIndexOf(value));
    if (patchApplied) writeFileSync(target, beforeParts.reduce((source, value, index) => source.replace(value, afterParts[index]), original));
    const mutant = patchApplied ? invoke("mutant") : null;
    writeFileSync(target, original);
    const restored = invoke("restored");
    const classification = classify(patchApplied, clean, mutant, restored, expectedAssertion, expectedFailureLocation);
    evidence.push({ id, sourceSha, path, beforeSha256: hash(original), patchSha256: hash(JSON.stringify({ before, after })), setup: { argv: setupArgv, environment: executionEnvironment }, testFile, testName, expectedAssertion, expectedFailureLocation, patchApplied, clean: { ...clean, output: undefined }, mutant: mutant && { ...mutant, output: undefined }, restored: { ...restored, output: undefined }, classification });
  }
  const report = { schemaVersion: "protection-fault-report/1", sourceSha, executionEnvironment, cases: evidence };
  process.stdout.write(`${JSON.stringify({ ...report, reportSha256: hash(JSON.stringify(report)) }, null, 2)}\n`);
  if (evidence.some((item) => item.classification !== "correctly-caught")) process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
