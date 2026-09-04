import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createHash } from "node:crypto";

const packageRoot = resolve(new URL("..", import.meta.url).pathname);
const sourceRoot = resolve(packageRoot, "..");
if (execFileSync("git", ["-C", sourceRoot, "status", "--porcelain"], { encoding: "utf8" }) !== "") {
  throw new Error("PROTECTION_FAULT_SOURCE_NOT_CLEAN");
}
const sourceSha = execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const cases = [
  ["identity-owner", "src/coordination/authority.ts", "identity?.owner !== binding.actor ||", "false ||", "src/coordination/authority.test.ts", "rejects another owner's exact record, forged Head and raw candidate bypass", "COORDINATION_OPERATION_IDENTITY_MISMATCH"],
  ["expired-write", "src/coordination/leases.ts", "  clock.requireBefore(record.expiresAt);", "  void record.expiresAt;", "src/coordination/service.test.ts", "refuses an expired lease in the actual rebind handler before a remote mutation", "COORDINATION_LEASE_WINDOW_EXHAUSTED"],
  ["exact-cas", "src/coordination/store.ts", "this.transport.push(directory, controlSha, this.controlRef, expectedControlSha)", "this.transport.push(directory, controlSha, this.controlRef, this.transport.readRef(this.controlRef))", "src/coordination/store.test.ts", "prepares two private same-parent CAS candidates and lets Git reject the stale dispatch while preserving another work item", "COORDINATION_CAS_CONFLICT"],
  ["stale-owner", "src/coordination/record.ts", "for (const [key, value] of Object.entries(expected)) if (record[key as keyof CoordinationRecord] !== value)", "for (const [key, value] of Object.entries(expected)) if (key !== \"owner\" && record[key as keyof CoordinationRecord] !== value)", "src/coordination/record.test.ts", "requires the complete exact expectation for an existing record; null is absence, not a wildcard", "COORDINATION_STALE_OWNER"],
  ["one-shot", "src/coordination/publication.ts", "if (!prepared || prepared.consumed) throw new Error(\"SYNTHETIC_PREPARATION_UNPROVEN\");", "if (!prepared) throw new Error(\"SYNTHETIC_PREPARATION_UNPROVEN\");", "src/coordination/publication.test.ts", "prepares without an attempt or held lock, refuses copied/reused handles, and still lets Git classify a later same-SHA no-op", "SYNTHETIC_PREPARATION_UNPROVEN"],
  ["other-work-item", "src/coordination/store.ts", "objectGit(directory, [\"read-tree\", current.controlSha]);", "objectGit(directory, [\"read-tree\", \"--empty\"]);", "src/coordination/store.test.ts", "prepares two private same-parent CAS candidates and lets Git reject the stale dispatch while preserving another work item", "COORDINATION_TREE_PRESERVATION_FAILED"],
  ["remote-delete", "src/coordination/push_result.ts", "return result.status === 0 && match[1] === \"-\" && !match[2] && match[4] === \"[deleted]\" ? \"deleted\" : \"unknown\";", "return result.status === 0 ? \"deleted\" : \"unknown\";", "src/coordination/publication.test.ts", "requires exact positive deletion porcelain rather than absence, nonempty sources, no-ops or truncated output", "unknown"],
];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const run = (command, args, cwd, env) => {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
  const stdout = result.stdout ?? ""; const stderr = result.stderr ?? "";
  return { exitCode: result.status, signal: result.signal, error: result.error?.code ?? null, stdoutSha256: hash(stdout), stderrSha256: hash(stderr), stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr), output: `${stdout}${stderr}` };
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
  for (const [id, path, before, after, testFile, testName, expectedAssertion] of cases) {
    const sandbox = join(root, id);
    cpSync(packageRoot, sandbox, { recursive: true, filter: (entry) => !["node_modules", "dist", ".harness"].includes(basename(entry)) });
    // Dependencies are copied into each sandbox. No source tree, Git metadata, approval receipt, or credential location is shared.
    execFileSync("npm", ["ci", "--offline", "--ignore-scripts", "--no-audit", "--fund=false"], { cwd: sandbox, env: { PATH: process.env.PATH, HOME: join(root, "home"), NPM_CONFIG_USERCONFIG: "/dev/null", NPM_CONFIG_CACHE: join(process.env.HOME ?? "", ".npm") }, stdio: "pipe" });
    const target = join(sandbox, path); const original = readFileSync(target, "utf8");
    const invoke = (phase) => {
      const reportPath = join(sandbox, `${phase}.json`);
      const argv = ["./node_modules/.bin/vitest", "run", testFile, "-t", testName, "--reporter=json", `--outputFile=${reportPath}`, "--maxWorkers=1"];
      const execution = run(argv[0], argv.slice(1), sandbox, { PATH: process.env.PATH, HOME: join(root, "home"), CI: "1" });
      return { ...execution, report: targetResult(reportPath, testName) };
    };
    const clean = invoke("baseline");
    const patchApplied = original.includes(before) && original.indexOf(before) === original.lastIndexOf(before);
    if (patchApplied) writeFileSync(target, original.replace(before, after));
    const mutant = patchApplied ? invoke("mutant") : null;
    writeFileSync(target, original);
    const restored = invoke("restored");
    const passedTarget = (result) => result?.report?.matches?.length === 1 && result.report.matches[0].status === "passed" && result.report.report.numFailedTests === 0;
    const failedTarget = mutant?.report?.matches?.length === 1 && mutant.report.matches[0].status === "failed" && mutant.report.report.numFailedTests === 1 && mutant.report.matches[0].failureMessages.some((message) => message.includes(expectedAssertion));
    const classification = !patchApplied ? "invalid-injection" : !passedTarget(clean) || !passedTarget(restored) ? "unable-to-execute" : failedTarget ? "correctly-caught" : mutant?.exitCode ? "unrelated-failure" : "survived";
    evidence.push({ id, sourceSha, path, beforeSha256: hash(original), patchSha256: hash(`${before}\n${after}`), testFile, testName, expectedAssertion, patchApplied, clean: { ...clean, output: undefined }, mutant: mutant && { ...mutant, output: undefined }, restored: { ...restored, output: undefined }, classification });
  }
  const report = { schemaVersion: "protection-fault-report/1", sourceSha, cases: evidence };
  process.stdout.write(`${JSON.stringify({ ...report, reportSha256: hash(JSON.stringify(report)) }, null, 2)}\n`);
  if (evidence.some((item) => item.classification !== "correctly-caught")) process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
