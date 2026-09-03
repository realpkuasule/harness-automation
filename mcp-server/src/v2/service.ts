import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, closeSync, constants, existsSync, lstatSync, openSync, readSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverProject } from "./discovery.js";
import {
  assertCurrentHash,
  atomicWrite,
  fileHash,
  hashObject,
  prettyJson,
  readJson,
  safePath,
  sha256,
  withoutHash,
} from "./fs.js";
import {
  acquireMutationLock,
  createFileApplyJournal,
  releaseMutationLock,
  requireMutationAllowed,
  validateFileApplyJournal,
  type FileApplyJournal,
} from "../recovery/service.js";
import { resolveProjectContext } from "../repository/git.js";
import {
  GO_NAMING_CHECKER,
  PYTHON_NAMING_CHECKER,
  compilePolicy,
  managedInstructionBlock,
  renderEffectivePolicy,
  upsertManagedBlock,
} from "./policy.js";
import type {
  AppliedChange,
  ChangePlan,
  CompilerIdentity,
  CompilerVersionStatus,
  Discovery,
  DeliveryProfile,
  DomainProfile,
  EnforcementResult,
  FileOperation,
  Intake,
  LegacyEvalSnapshotMigration,
  PolicyDocument,
  PolicyEvaluationSnapshot,
  PolicyRule,
  PolicyUpdateMetadata,
  QualityProfile,
  SemanticFieldChange,
  SourceSnapshot,
  Stack,
  StackAdapterResult,
  StackProfile,
  TypeScriptNamingBaseline,
} from "./types.js";
import { hasBuiltInStackAdapter, stackAdapterSupport, TYPESCRIPT_NAMING_RULE_ID } from "./types.js";
import { EVAL_CONTRACT_PATH, evaluationSourcePaths, inspectEvaluations, readEvalContract } from "./evals.js";
import { checkGo, checkPython, checkTypeScript, inspectTypeScript } from "./verifier.js";
import {
  applyWorkspacePlan,
  auditWorkspace,
  loadConfig,
  planWorkspaceConfiguration,
  rollbackWorkspaceChange,
  workspaceStatus,
} from "../worktree/service.js";
import type { ProviderObservation, WorkspaceAudit, WorkspacePlan, WorkspaceReceipt } from "../worktree/types.js";

const HARNESS_DIR = ".harness";
const PACKAGE_ROOT = resolve(join(fileURLToPath(new URL(".", import.meta.url)), "../.."));
const COMPILER_PACKAGE = "@realpkuasule/harness-automation" as const;
const SKILL_NAMES = ["harness-automation", "manage-worktree-delivery"] as const;

export type SkillName = typeof SKILL_NAMES[number];

function currentCompilerIdentity(packagePath = PACKAGE_ROOT): CompilerIdentity {
  const metadata = readJson<{ name?: string; version?: string }>(join(resolve(packagePath), "package.json"));
  if (metadata.name !== COMPILER_PACKAGE || !metadata.version ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(metadata.version)) {
    throw new Error(`COMPILER_IDENTITY_INVALID: expected ${COMPILER_PACKAGE} with an exact semantic version`);
  }
  return { package: COMPILER_PACKAGE, version: metadata.version };
}

export function packagedSkillPath(packagePath: string, name: SkillName): string {
  const built = join(packagePath, "dist", name === "harness-automation" ? "skill" : name);
  if (existsSync(built)) return built;
  return name === "harness-automation" ? join(packagePath, "skill") : join(packagePath, "skills", name);
}

function skillDirectoryDigest(path: string): { digest: string | null; blocked: boolean } {
  let rootStat: ReturnType<typeof lstatSync>;
  try {
    rootStat = lstatSync(path);
  } catch (error) {
    return { digest: null, blocked: (error as NodeJS.ErrnoException).code !== "ENOENT" };
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return { digest: null, blocked: true };
  const entries: Array<{ path: string; sha256: string }> = [];
  const visit = (directory: string, prefix: string): boolean => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    )) {
      const target = join(directory, entry.name);
      const entryPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) return false;
      if (entry.isDirectory()) {
        if (!visit(target, entryPath)) return false;
      } else if (entry.isFile()) {
        entries.push({ path: entryPath, sha256: sha256(readFileSync(target)) });
      } else {
        return false;
      }
    }
    return true;
  };
  try {
    return visit(path, "")
      ? { digest: sha256(entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0).map((entry) => `${entry.path}\0${entry.sha256}\n`).join("")), blocked: false }
      : { digest: null, blocked: true };
  } catch {
    return { digest: null, blocked: true };
  }
}

function skillPathHasSymlinkAncestor(homeDirectory: string, agentHome: string, name: SkillName): boolean {
  for (const path of [join(homeDirectory, agentHome), join(homeDirectory, agentHome, "skills"), join(homeDirectory, agentHome, "skills", name)]) {
    try {
      if (lstatSync(path).isSymbolicLink()) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return true;
    }
  }
  return false;
}

export function inspectSkillInstallations(options: {
  packagePath?: string;
  homeDirectory?: string;
} = {}): Record<string, unknown> {
  const packagePath = resolve(options.packagePath ?? PACKAGE_ROOT);
  const homeDirectory = resolve(options.homeDirectory ?? homedir());
  let version: string | null = null;
  try {
    version = (readJson<{ version?: string }>(join(packagePath, "package.json")).version ?? null);
  } catch {
    // A source digest remains useful when package metadata is unavailable.
  }
  const skills = SKILL_NAMES.map((name) => {
    const sourcePath = packagedSkillPath(packagePath, name);
    const source = skillDirectoryDigest(sourcePath);
    const targets = [".claude", ".codex", ".agents"].map((agentHome) => {
      const path = join(homeDirectory, agentHome, "skills", name);
      const ancestorBlocked = skillPathHasSymlinkAncestor(homeDirectory, agentHome, name);
      const observed = ancestorBlocked ? { digest: null, blocked: true } : skillDirectoryDigest(path);
      const status = observed.blocked
        ? "blocked"
        : observed.digest === null
          ? "missing"
          : source.digest !== null && observed.digest === source.digest
            ? "current"
            : "stale";
      return { path, digest: observed.digest, status };
    });
    return {
      name,
      source: { path: sourcePath, digest: source.digest, status: source.blocked ? "blocked" : source.digest ? "available" : "missing" },
      targets,
      inSync: !source.blocked && source.digest !== null && targets.every((target) => target.status === "current"),
      repairHint: "harness-automation install",
    };
  });
  return {
    package: { path: packagePath, version },
    skills,
    inSync: skills.every((skill) => skill.inSync),
    repairHint: "harness-automation install",
  };
}

function harnessPath(root: string, path: string): string {
  return safePath(root, `${HARNESS_DIR}/${path}`);
}

function markdownFiles(directory: string, root: string): string[] {
  if (!existsSync(directory)) return [];
  const output: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && /\.(md|json)$/u.test(entry.name)) output.push(relative(root, path).replaceAll("\\", "/"));
    }
  };
  visit(directory);
  return output.sort();
}

function sourceFiles(root: string, extension: string): string[] {
  const output: string[] = [];
  const ignored = new Set([".git", ".harness", ".next", ".venv", "dist", "generated", "node_modules", "vendor"]);
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) visit(path);
      } else if (entry.isFile() && entry.name.endsWith(extension)) {
        output.push(relative(root, path).replaceAll("\\", "/"));
      }
    }
  };
  visit(root);
  return output.sort();
}

function sourceId(kind: SourceSnapshot["kind"], path: string, used: Set<string>): string {
  const stem = basename(path).replace(/\.[^.]+$/u, "").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "") || "document";
  const base = kind === "prd" ? "prd" : `${kind}-${stem}`;
  let id = base;
  let index = 2;
  while (used.has(id)) id = `${base}-${index++}`;
  used.add(id);
  return id;
}

function collectSources(root: string): SourceSnapshot[] {
  const prd = "docs/PRD.md";
  if (!existsSync(join(root, prd))) {
    throw new Error("PRD_REQUIRED: docs/PRD.md was not found. Finish requirement grilling and write the approved PRD first.");
  }
  const designs = markdownFiles(safePath(root, "docs/design"), root);
  for (const candidate of ["DESIGN.md", "ARCHITECTURE.md", "docs/DESIGN.md", "docs/ARCHITECTURE.md"]) {
    if (existsSync(safePath(root, candidate)) && !designs.includes(candidate)) designs.push(candidate);
  }
  const research = markdownFiles(safePath(root, "docs/research"), root);
  if (research.length === 0) {
    throw new Error("RESEARCH_REQUIRED: docs/research/ has no Markdown or JSON evidence. Run `harness-automation research github` first.");
  }
  const used = new Set<string>();
  const evaluations = evaluationSourcePaths(root);
  return [
    { kind: "prd" as const, path: prd },
    ...designs.sort().map((path) => ({ kind: "design" as const, path })),
    ...research.map((path) => ({ kind: "research" as const, path })),
    ...evaluations.map((path) => ({ kind: "eval" as const, path })),
  ].map(({ kind, path }) => ({
    id: sourceId(kind, path, used),
    kind,
    path,
    sha256: sha256(readFileSync(safePath(root, path))),
    approved: true,
  }));
}

export function intakeProject(args: {
  projectRoot: string;
  owner: string;
  approveSources: boolean;
  approveTypeScriptNamingAdoption?: boolean;
  approveWeakening?: string;
  weakeningRuleIds?: string[];
  now?: Date;
}): Intake {
  if (!args.owner.trim()) throw new Error("OWNER_REQUIRED: provide the project owner's stable name or handle");
  if (!args.approveSources) {
    throw new Error("SOURCE_APPROVAL_REQUIRED: the project owner must confirm that PRD, design, and research are final");
  }
  const root = resolve(args.projectRoot);
  const intake: Intake = {
    schemaVersion: "2.0",
    owner: args.owner.trim(),
    approvedAt: (args.now ?? new Date()).toISOString(),
    sources: collectSources(root),
  };
  if (args.approveTypeScriptNamingAdoption) {
    const observed = inspectTypeScript(root);
    if (observed.some((violation) => violation.fingerprint === null)) {
      throw new Error("TYPESCRIPT_NAMING_ADOPTION_PARSE_ERROR: fix TypeScript parse errors before approving naming debt");
    }
    intake.typescriptNamingAdoption = {
      ruleId: TYPESCRIPT_NAMING_RULE_ID,
      fingerprints: observed.map((violation) => violation.fingerprint!).sort(),
    };
  }
  if (args.approveWeakening) {
    const ruleIds = [...new Set(args.weakeningRuleIds ?? [])].sort();
    if (!/^[a-f0-9]{64}$/u.test(args.approveWeakening) || ruleIds.length === 0 ||
      ruleIds.some((id) => !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(id))) {
      throw new Error("WEAKENING_APPROVAL_INVALID: provide the exact digest and every affected --weakening-rule id");
    }
    intake.policyWeakeningApproval = { digest: args.approveWeakening, ruleIds };
  } else if ((args.weakeningRuleIds?.length ?? 0) > 0) {
    throw new Error("WEAKENING_APPROVAL_DIGEST_REQUIRED: pass --approve-weakening with the exact digest");
  }
  atomicWrite(harnessPath(root, "intake.json"), prettyJson(intake));
  return intake;
}

export function discoverAndSave(projectRoot: string, now?: Date): Discovery {
  const root = resolve(projectRoot);
  const discovery = discoverProject(root, now);
  atomicWrite(harnessPath(root, "discovery.json"), prettyJson(discovery));
  return discovery;
}

function ensureApprovedSources(root: string, intake: Intake): void {
  for (const source of intake.sources) {
    const path = safePath(root, source.path);
    const actual = fileHash(path);
    if (!source.approved || actual !== source.sha256) {
      throw new Error(`SOURCE_DRIFT: ${source.path} changed after owner approval; run intake again`);
    }
  }
}

function operation(root: string, path: string, content: string, managed = true): FileOperation {
  return {
    id: `write-${path.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "")}`,
    kind: "write",
    path,
    beforeHash: fileHash(safePath(root, path)),
    afterHash: sha256(content),
    content,
    managed,
  };
}

function existingText(root: string, path: string): string {
  const target = safePath(root, path);
  return existsSync(target) ? readFileSync(target, "utf8") : "";
}

function deduplicateCommands(policy: PolicyDocument): string[][] {
  const commands = policy.policies.flatMap((item) => item.verification.commands);
  const seen = new Set<string>();
  return commands.filter((command) => {
    const key = JSON.stringify(command);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueCommands(commands: string[][]): string[][] {
  const seen = new Set<string>();
  return commands.filter((command) => {
    const key = JSON.stringify(command);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function typeScriptNamingBaseline(baseline: unknown): TypeScriptNamingBaseline | null {
  if (!baseline || typeof baseline !== "object" || Array.isArray(baseline)) return null;
  const candidate = baseline as Record<string, unknown>;
  if (candidate.ruleId !== TYPESCRIPT_NAMING_RULE_ID || typeof candidate.approvedIntakeHash !== "string" ||
    !Array.isArray(candidate.fingerprints) || !candidate.fingerprints.every((item) => typeof item === "string")) return null;
  const fingerprints = candidate.fingerprints as string[];
  const sorted = [...fingerprints].sort();
  if (!/^[a-f0-9]{64}$/u.test(candidate.approvedIntakeHash) ||
    fingerprints.some((item, index) => !/^[a-f0-9]{64}$/u.test(item) || item !== sorted[index])) return null;
  return {
    ruleId: TYPESCRIPT_NAMING_RULE_ID,
    approvedIntakeHash: candidate.approvedIntakeHash,
    fingerprints: sorted,
  };
}

function currentTypeScriptNamingBaseline(root: string): TypeScriptNamingBaseline | null {
  const path = harnessPath(root, "policy.yaml");
  if (!existsSync(path)) return null;
  return typeScriptNamingBaseline((readJson<Record<string, unknown>>(path)).typescriptNamingBaseline);
}

function sameFingerprints(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function subtractFingerprints(left: readonly string[], right: readonly string[]): string[] {
  const remaining = new Map<string, number>();
  for (const item of right) remaining.set(item, (remaining.get(item) ?? 0) + 1);
  return left.filter((item) => {
    const count = remaining.get(item) ?? 0;
    if (count === 0) return true;
    remaining.set(item, count - 1);
    return false;
  });
}

function intersectFingerprints(left: readonly string[], right: readonly string[]): string[] {
  const remaining = new Map<string, number>();
  for (const item of right) remaining.set(item, (remaining.get(item) ?? 0) + 1);
  return left.filter((item) => {
    const count = remaining.get(item) ?? 0;
    if (count === 0) return false;
    remaining.set(item, count - 1);
    return true;
  });
}

function exactCompilerIdentity(input: unknown): CompilerIdentity | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const candidate = input as Record<string, unknown>;
  return candidate.package === COMPILER_PACKAGE && typeof candidate.version === "string" &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(candidate.version)
    ? { package: COMPILER_PACKAGE, version: candidate.version }
    : null;
}

function sameJson(left: unknown, right: unknown): boolean {
  return hashObject(left) === hashObject(right);
}

function sortedStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function normalizedTargets(rule: PolicyRule): unknown[] {
  return rule.targets.map((target) => ({
    kind: target.kind,
    adapter: target.adapter,
    configPath: target.configPath ?? null,
    command: target.command ?? null,
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function normalizedCommands(commands: string[][]): string[][] {
  return [...commands].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function adapterCoverage(policy: PolicyDocument): string[] {
  return sortedStrings(policy.policies.flatMap((rule) => rule.targets.map((target) => `${target.kind}:${target.adapter}`)));
}

function semanticEvalSuite(suite: PolicyEvaluationSnapshot["suites"][number]): Record<string, unknown> {
  return {
    kind: suite.kind,
    command: suite.command,
    tasks: sortedStrings(suite.tasks),
    baseline: suite.baseline,
    target: suite.target,
    graders: [...suite.graders].sort((left, right) => left.id.localeCompare(right.id)),
    runnerSources: sortedStrings(suite.runnerSources ?? []),
    traceability: [...(suite.traceability ?? [])]
      .map((trace) => ({ requirementId: trace.requirementId, ruleIds: sortedStrings(trace.ruleIds) }))
      .sort((left, right) => left.requirementId.localeCompare(right.requirementId)),
    negativeControl: suite.negativeControl ?? null,
  };
}

function evaluationRuleIds(suite: PolicyEvaluationSnapshot["suites"][number]): string[] {
  const ids = sortedStrings((suite.traceability ?? []).flatMap((trace) => trace.ruleIds));
  return ids.length > 0 ? ids : ["eval-regression-gate"];
}

function evaluationDifference(
  before: PolicyEvaluationSnapshot | undefined,
  after: PolicyEvaluationSnapshot | undefined,
): {
  changes: PolicyUpdateMetadata["evaluations"];
  weakeningReasons: string[];
} {
  const oldSuites = new Map((before?.suites ?? []).map((suite) => [suite.id, suite]));
  const newSuites = new Map((after?.suites ?? []).map((suite) => [suite.id, suite]));
  const added = [...newSuites.keys()].filter((id) => !oldSuites.has(id)).sort();
  const removed = [...oldSuites.keys()].filter((id) => !newSuites.has(id)).sort();
  const changed: PolicyUpdateMetadata["evaluations"]["changed"] = [];
  const weakeningReasons: string[] = [];
  const weaken = (suite: PolicyEvaluationSnapshot["suites"][number], reason: string): void => {
    for (const ruleId of evaluationRuleIds(suite)) weakeningReasons.push(`${ruleId}: eval suite ${suite.id} ${reason}`);
  };
  for (const id of removed) weaken(oldSuites.get(id)!, "removed");
  for (const id of [...oldSuites.keys()].filter((value) => newSuites.has(value)).sort()) {
    const oldSuite = oldSuites.get(id)!;
    const newSuite = newSuites.get(id)!;
    const oldFields = semanticEvalSuite(oldSuite);
    const newFields = semanticEvalSuite(newSuite);
    const fields = Object.keys(oldFields).flatMap((field) =>
      sameJson(oldFields[field], newFields[field]) ? [] : [{ field, before: oldFields[field], after: newFields[field] }]);
    if (fields.length > 0) changed.push({ suiteId: id, fields });
    if (newSuite.target.metric !== oldSuite.target.metric) weaken(oldSuite, `target metric changed from ${oldSuite.target.metric} to ${newSuite.target.metric}`);
    if (newSuite.target.threshold < oldSuite.target.threshold) weaken(oldSuite, `target threshold decreased from ${oldSuite.target.threshold} to ${newSuite.target.threshold}`);
    if (newSuite.target.trials < oldSuite.target.trials) weaken(oldSuite, `target trials decreased from ${oldSuite.target.trials} to ${newSuite.target.trials}`);
    if (oldSuite.tasks.some((task) => !newSuite.tasks.includes(task))) weaken(oldSuite, "task removed");
    if (oldSuite.negativeControl && !newSuite.negativeControl) weaken(oldSuite, "known-bad control removed");
    else if (oldSuite.negativeControl && !sameJson(oldSuite.negativeControl, newSuite.negativeControl)) weaken(oldSuite, "known-bad control changed");
    const newGraders = new Map(newSuite.graders.map((grader) => [grader.id, grader]));
    if (oldSuite.graders.some((grader) => grader.role === "gate" && newGraders.get(grader.id)?.role !== "gate")) weaken(oldSuite, "gate grader removed or demoted");
    const oldTraceRuleIds = sortedStrings((oldSuite.traceability ?? []).flatMap((trace) => trace.ruleIds));
    const newTraceRuleIds = new Set((newSuite.traceability ?? []).flatMap((trace) => trace.ruleIds));
    if (oldTraceRuleIds.some((ruleId) => !newTraceRuleIds.has(ruleId))) weaken(oldSuite, "traceability rule ID removed");
  }
  return { changes: { added, removed, changed }, weakeningReasons };
}

function weakeningDigest(
  before: PolicyDocument,
  after: PolicyDocument,
  rules: PolicyUpdateMetadata["rules"],
  evaluations: PolicyUpdateMetadata["evaluations"],
  ruleIds: string[],
  reasons: string[],
): string {
  return hashObject({
    beforePolicyDigest: hashObject(before),
    afterPolicyDigest: hashObject(after),
    rules,
    evaluations,
    ruleIds,
    reasons,
  });
}

function semanticRule(rule: PolicyRule): Record<string, unknown> {
  return {
    status: rule.status,
    severity: rule.severity,
    formalization: rule.formalization,
    "scope.include": sortedStrings(rule.scope.include),
    "scope.exclude": sortedStrings(rule.scope.exclude),
    "scope.boundaries": sortedStrings(rule.scope.boundaries),
    targets: normalizedTargets(rule),
    verification: {
      commands: normalizedCommands(rule.verification.commands),
      passCriteria: rule.verification.passCriteria,
      timeoutSeconds: rule.verification.timeoutSeconds ?? null,
    },
    title: rule.title,
    statement: rule.statement,
    rationale: rule.rationale,
    owner: rule.owner,
    sourceRefs: sortedStrings(rule.sourceRefs),
    examples: rule.examples ?? null,
    changeControl: rule.changeControl,
  };
}

function removedJsonValues(before: unknown[], after: unknown[]): boolean {
  const remaining = new Map<string, number>();
  for (const value of after) {
    const key = JSON.stringify(value);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  return before.some((value) => {
    const key = JSON.stringify(value);
    const count = remaining.get(key) ?? 0;
    if (count === 0) return true;
    remaining.set(key, count - 1);
    return false;
  });
}

function ruleWeakeningReasons(before: PolicyRule, after: PolicyRule): string[] {
  const reasons: string[] = [];
  const severity = { info: 0, warn: 1, error: 2 } as const;
  const formalization = { cognitive: 0, procedural: 1, deterministic: 2 } as const;
  if (before.status === "active" && after.status !== "active") reasons.push(`${before.id}: active rule became ${after.status}`);
  if (severity[after.severity] < severity[before.severity]) reasons.push(`${before.id}: severity ${before.severity} -> ${after.severity}`);
  if (formalization[after.formalization] < formalization[before.formalization]) {
    reasons.push(`${before.id}: formalization ${before.formalization} -> ${after.formalization}`);
  }
  if (removedJsonValues(normalizedCommands(before.verification.commands), normalizedCommands(after.verification.commands))) {
    reasons.push(`${before.id}: verification command removed`);
  }
  if (removedJsonValues(normalizedTargets(before), normalizedTargets(after))) reasons.push(`${before.id}: target adapter removed`);
  if (before.scope.include.some((value) => !after.scope.include.includes(value))) reasons.push(`${before.id}: include scope narrowed`);
  if (after.scope.exclude.some((value) => !before.scope.exclude.includes(value))) reasons.push(`${before.id}: exclude scope expanded`);
  if (before.scope.boundaries.some((value) => !after.scope.boundaries.includes(value))) reasons.push(`${before.id}: boundary removed`);
  if (before.changeControl.approvalRequired && !after.changeControl.approvalRequired) {
    reasons.push(`${before.id}: approval requirement removed`);
  }
  return reasons;
}

function policyDifference(
  before: PolicyDocument,
  after: PolicyDocument,
  beforeEvaluations = before.evaluations,
): {
  rules: PolicyUpdateMetadata["rules"];
  evaluations: PolicyUpdateMetadata["evaluations"];
  weakening: Omit<PolicyUpdateMetadata["weakening"], "approved">;
} {
  const oldRules = new Map(before.policies.map((rule) => [rule.id, rule]));
  const newRules = new Map(after.policies.map((rule) => [rule.id, rule]));
  const added = [...newRules.keys()].filter((id) => !oldRules.has(id)).sort();
  const removed = [...oldRules.keys()].filter((id) => !newRules.has(id)).sort();
  const changed: PolicyUpdateMetadata["rules"]["changed"] = [];
  const weakeningReasons = removed.flatMap((id) => oldRules.get(id)?.status === "active" ? [`${id}: active rule removed`] : []);
  for (const id of [...oldRules.keys()].filter((value) => newRules.has(value)).sort()) {
    const oldRule = oldRules.get(id)!;
    const newRule = newRules.get(id)!;
    const oldFields = semanticRule(oldRule);
    const newFields = semanticRule(newRule);
    const fields: SemanticFieldChange[] = Object.keys(oldFields).flatMap((field) =>
      sameJson(oldFields[field], newFields[field]) ? [] : [{ field, before: oldFields[field], after: newFields[field] }]);
    if (fields.length > 0) changed.push({ ruleId: id, fields });
    weakeningReasons.push(...ruleWeakeningReasons(oldRule, newRule));
  }
  const evaluations = evaluationDifference(beforeEvaluations, after.evaluations);
  weakeningReasons.push(...evaluations.weakeningReasons);
  const rules = { added, removed, changed };
  const ruleIds = sortedStrings(weakeningReasons.map((reason) => reason.split(":", 1)[0]));
  const reasons = sortedStrings(weakeningReasons);
  return {
    rules,
    evaluations: evaluations.changes,
    weakening: {
      detected: reasons.length > 0,
      ruleIds,
      reasons,
      digest: weakeningDigest(before, after, rules, evaluations.changes, ruleIds, reasons),
    },
  };
}

function baselineDifference(before: PolicyDocument, after: PolicyDocument): PolicyUpdateMetadata["baseline"] {
  const oldBaseline = typeScriptNamingBaseline(before.typescriptNamingBaseline);
  const newBaseline = typeScriptNamingBaseline(after.typescriptNamingBaseline);
  if (!oldBaseline && !newBaseline) return null;
  const oldFingerprints = oldBaseline?.fingerprints ?? [];
  const newFingerprints = newBaseline?.fingerprints ?? [];
  return {
    before: oldFingerprints,
    after: newFingerprints,
    added: subtractFingerprints(newFingerprints, oldFingerprints),
    removed: subtractFingerprints(oldFingerprints, newFingerprints),
  };
}

function inheritedEvaluationSnapshot(
  before: PolicyDocument,
  after: PolicyDocument,
): PolicyEvaluationSnapshot | undefined {
  if (before.evaluations || !after.evaluations) return before.evaluations;
  const oldSources = before.sources.filter((source) => source.kind === "eval")
    .map(({ path, sha256: sourceHash }) => ({ path, sha256: sourceHash }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const newSources = after.sources.filter((source) => source.kind === "eval")
    .map(({ path, sha256: sourceHash }) => ({ path, sha256: sourceHash }))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (oldSources.length > 0 && sameJson(oldSources, newSources)) return after.evaluations;
  throw new Error("EVAL_SEMANTICS_HISTORY_REQUIRED: legacy policy has no eval snapshot and approved eval sources changed; restore the old sources or perform an owner-reviewed migration");
}

function evaluationSources(policy: PolicyDocument): Array<{ path: string; sha256: string }> {
  return policy.sources
    .filter((source) => source.kind === "eval")
    .map(({ path, sha256: sourceHash }) => ({ path, sha256: sourceHash }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function approvedEvaluationSources(intake: Intake): Array<{ path: string; sha256: string }> {
  return intake.sources
    .filter((source) => source.kind === "eval")
    .map(({ path, sha256: sourceHash }) => ({ path, sha256: sourceHash }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function discoveredEvaluationSnapshot(discovery: Discovery): PolicyEvaluationSnapshot | undefined {
  const evaluations = discovery.evaluations;
  if (!evaluations?.valid || !evaluations.schemaVersion) return undefined;
  return { schemaVersion: evaluations.schemaVersion, suites: evaluations.suites };
}

function legacyEvalSnapshotMigration(
  before: PolicyDocument,
  after: PolicyDocument,
): LegacyEvalSnapshotMigration {
  if (before.evaluations) throw new Error("LEGACY_EVAL_SNAPSHOT_MIGRATION_NOT_REQUIRED: policy already has an evaluations snapshot");
  if (!after.evaluations) throw new Error("LEGACY_EVAL_SNAPSHOT_MIGRATION_CANDIDATE_REQUIRED: current approved sources do not produce an evaluations snapshot");
  const historicalEvalSources = evaluationSources(before);
  const currentApprovedEvalSources = evaluationSources(after);
  if (currentApprovedEvalSources.length === 0 || sameJson(historicalEvalSources, currentApprovedEvalSources)) {
    throw new Error("LEGACY_EVAL_SNAPSHOT_MIGRATION_NOT_REQUIRED: migration requires a legacy eval source drift");
  }
  const affectedSuites = after.evaluations.suites.map((suite) => {
    const traceability = suite.traceability ?? [];
    const requirementIds = sortedStrings(traceability.map((trace) => trace.requirementId));
    const ruleIds = sortedStrings(traceability.flatMap((trace) => trace.ruleIds));
    if (requirementIds.length === 0 || ruleIds.length === 0) {
      throw new Error(`LEGACY_EVAL_SNAPSHOT_MIGRATION_TRACEABILITY_REQUIRED: suite ${suite.id} must declare Requirement IDs and rule IDs`);
    }
    return { suiteId: suite.id, requirementIds, ruleIds };
  }).sort((left, right) => left.suiteId.localeCompare(right.suiteId));
  return {
    kind: "legacy-eval-snapshot-adoption",
    historicalContinuity: "unavailable",
    legacyPolicyDigest: hashObject(before),
    historicalEvalSources,
    currentApprovedEvalSources,
    candidateEvaluations: after.evaluations,
    affectedSuites,
  };
}

function legacyEvalSnapshotMigrationReceipt(plan: ChangePlan, policy: PolicyDocument): AppliedChange["legacyEvalSnapshotMigration"] {
  const migration = plan.legacyEvalSnapshotMigration;
  if (!migration) return undefined;
  if (!policy.evaluations) throw new Error("LEGACY_EVAL_SNAPSHOT_RECEIPT_INVALID: applied policy has no evaluations snapshot");
  return {
    kind: migration.kind,
    owner: policy.project.owner,
    before: {
      evaluationsSnapshot: "absent",
      policyDigest: migration.legacyPolicyDigest,
    },
    after: {
      policyDigest: hashObject(policy),
      evaluationsSha256: hashObject(policy.evaluations),
      approvedEvalSources: migration.currentApprovedEvalSources,
    },
  };
}

function inheritedPolicyConfiguration(
  policy: PolicyDocument,
  discovery: Discovery,
): PolicyUpdateMetadata["inherited"] {
  const project = policy.project;
  const profile = project.profile ?? discovery.profile;
  if (!["full-typescript", "python-data-ai", "go-performance", "custom"].includes(profile)) {
    throw new Error("UPDATE_PROFILE_UNKNOWN: rerun intake and discover before updating");
  }
  return {
    owner: project.owner,
    profile,
    stacks: [...project.stacks],
    deliveryProfiles: [...(project.deliveryProfiles ?? [])],
    domainProfiles: [...(project.domainProfiles ?? [])],
    qualityProfiles: [...(project.qualityProfiles ?? [])],
    phase: project.phase,
  };
}

function previousCompilerMetadata(
  policy: PolicyDocument,
  manifest: Manifest,
  policyDigest: string,
): PolicyUpdateMetadata["from"] {
  const policyCompiler = exactCompilerIdentity(policy.compiler);
  const manifestCompiler = exactCompilerIdentity(manifest.compiler);
  const compiler = policyCompiler && manifestCompiler && sameJson(policyCompiler, manifestCompiler)
    ? policyCompiler
    : null;
  return {
    compiler,
    policyCompiler,
    manifestCompiler,
    compilerStatus: compiler ? "exact" : policyCompiler && manifestCompiler ? "stale" : "legacy-version-unknown",
    schemaVersion: policy.schemaVersion ?? null,
    policyDigest,
  };
}

function updateDriftMetadata(
  root: string,
  manifest: Manifest,
  intake: Intake,
  intakeHash: string,
  discoveryHash: string,
): PolicyUpdateMetadata["drift"] {
  return {
    intake: {
      expected: manifest.intakeHash ?? intakeHash,
      actual: intakeHash,
      clean: (manifest.intakeHash ?? intakeHash) === intakeHash,
    },
    discovery: {
      expected: manifest.discoveryHash ?? discoveryHash,
      actual: discoveryHash,
      clean: (manifest.discoveryHash ?? discoveryHash) === discoveryHash,
    },
    sources: intake.sources.map((source) => {
      const actual = fileHash(safePath(root, source.path));
      return { path: source.path, expected: source.sha256, actual, clean: actual === source.sha256 };
    }),
  };
}

interface ProjectPlanArgs {
  projectRoot: string;
  owner?: string;
  projectName?: string;
  phase?: PolicyDocument["project"]["phase"];
  profile?: StackProfile;
  stacks?: Stack[];
  inheritedStacks?: Stack[];
  deliveryProfiles?: DeliveryProfile[];
  domainProfiles?: DomainProfile[];
  qualityProfiles?: QualityProfile[];
  adoptTypeScriptNaming?: boolean;
  now?: Date;
}

function compileProjectPlan(args: ProjectPlanArgs & { writePlan: boolean }): { plan: ChangePlan; path: string; policy: PolicyDocument } {
  const root = resolve(args.projectRoot);
  const intakeFile = harnessPath(root, "intake.json");
  const discoveryFile = harnessPath(root, "discovery.json");
  if (!existsSync(intakeFile)) throw new Error("INTAKE_REQUIRED: run intake first");
  if (!existsSync(discoveryFile)) throw new Error("DISCOVERY_REQUIRED: run discover first");
  const intake = readJson<Intake>(intakeFile);
  const discovery = readJson<Discovery>(discoveryFile);
  const intakeHash = fileHash(intakeFile)!;
  ensureApprovedSources(root, intake);
  const qualityProfiles = [...new Set(args.qualityProfiles ?? [])];
  if (qualityProfiles.includes("eval-driven-development")) {
    const approvedEvalPaths = new Set(
      intake.sources.filter((source) => source.kind === "eval").map((source) => source.path),
    );
    if (!approvedEvalPaths.has(EVAL_CONTRACT_PATH)) {
      throw new Error(`EVAL_CONTRACT_REQUIRED: create ${EVAL_CONTRACT_PATH}, then run intake and discover again`);
    }
    readEvalContract(root, approvedEvalPaths);
    if (!discovery.evaluations?.valid) {
      throw new Error("EVAL_DISCOVERY_REQUIRED: run discover again after approving the evaluation contract");
    }
  }
  const policy = compilePolicy({
    projectRoot: root,
    compiler: currentCompilerIdentity(),
    projectName: args.projectName,
    phase: args.phase,
    owner: args.owner ?? intake.owner,
    intake,
    discovery,
    profile: args.profile,
    stacks: args.stacks,
    inheritedStacks: args.inheritedStacks,
    deliveryProfiles: args.deliveryProfiles,
    domainProfiles: args.domainProfiles,
    qualityProfiles,
  });
  const currentBaseline = currentTypeScriptNamingBaseline(root);
  const observedNaming = policy.project.stacks.includes("typescript") ? inspectTypeScript(root) : [];
  const observedFingerprints = observedNaming.flatMap((violation) => violation.fingerprint ?? []).sort();
  if (args.adoptTypeScriptNaming) {
    if (!policy.project.stacks.includes("typescript")) {
      throw new Error("TYPESCRIPT_NAMING_ADOPTION_REQUIRES_TYPESCRIPT: select the typescript stack first");
    }
    if (observedNaming.some((violation) => violation.fingerprint === null)) {
      throw new Error("TYPESCRIPT_NAMING_ADOPTION_PARSE_ERROR: fix TypeScript parse errors before adopting naming debt");
    }
    const approval = intake.typescriptNamingAdoption;
    if (approval?.ruleId !== TYPESCRIPT_NAMING_RULE_ID) {
      throw new Error("TYPESCRIPT_NAMING_ADOPTION_INTAKE_REQUIRED: rerun intake with explicit owner approval for the current naming fingerprints");
    }
    if (!sameFingerprints(approval.fingerprints, observedFingerprints)) {
      throw new Error("TYPESCRIPT_NAMING_ADOPTION_DRIFT: naming violations changed after intake approval; rerun intake");
    }
    const added = subtractFingerprints(observedFingerprints, currentBaseline?.fingerprints ?? []);
    if (currentBaseline && added.length > 0 && currentBaseline.approvedIntakeHash === intakeHash) {
      throw new Error("TYPESCRIPT_NAMING_ADOPTION_FRESH_INTAKE_REQUIRED: baseline expansion or replacement requires a new explicit adoption intake");
    }
    policy.typescriptNamingBaseline = {
      ruleId: TYPESCRIPT_NAMING_RULE_ID,
      approvedIntakeHash: intakeHash,
      fingerprints: observedFingerprints,
    };
  } else if (policy.project.stacks.includes("typescript")) {
    policy.typescriptNamingBaseline = {
      ruleId: TYPESCRIPT_NAMING_RULE_ID,
      approvedIntakeHash: currentBaseline?.approvedIntakeHash ?? intakeHash,
      fingerprints: currentBaseline
        ? intersectFingerprints(currentBaseline.fingerprints, observedFingerprints)
        : [],
    };
  }
  const policyDigest = hashObject(policy);
  const effectivePolicy = renderEffectivePolicy(policy, policyDigest);
  const instruction = managedInstructionBlock(policyDigest);

  const operations: FileOperation[] = [
    operation(root, ".harness/policy.yaml", prettyJson(policy)),
    operation(root, ".harness/generated/effective-policy.md", effectivePolicy),
    operation(root, "AGENTS.md", upsertManagedBlock(existingText(root, "AGENTS.md"), instruction)),
    operation(root, "CLAUDE.md", upsertManagedBlock(existingText(root, "CLAUDE.md"), instruction)),
    operation(root, ".harness/.gitignore", "sessions/*\n!sessions/.gitkeep\neval-runs/*\n"),
  ];
  if (policy.project.stacks.includes("python")) {
    operations.push(operation(root, ".harness/generated/check_python_naming.py", PYTHON_NAMING_CHECKER));
  }
  if (policy.project.stacks.includes("go")) {
    operations.push(operation(root, ".harness/generated/check_go_naming.go", GO_NAMING_CHECKER));
  }

  const manifest = {
    schemaVersion: "2.0",
    compiler: currentCompilerIdentity(),
    policyDigest,
    intakeHash,
    discoveryHash: fileHash(discoveryFile) ?? "",
    outputs: operations.map(({ path, afterHash }) => ({ path, sha256: afterHash })),
  };
  operations.push(operation(root, ".harness/manifest.json", prettyJson(manifest)));

  const createdAt = (args.now ?? new Date()).toISOString();
  const seed = hashObject({
    intake: fileHash(intakeFile),
    discovery: fileHash(discoveryFile),
    profile: args.profile ?? discovery.profile,
    stacks: args.stacks ?? null,
    inheritedStacks: args.inheritedStacks ?? null,
    deliveryProfiles: args.deliveryProfiles ?? [],
    domainProfiles: args.domainProfiles ?? [],
    qualityProfiles,
    adoptTypeScriptNaming: args.adoptTypeScriptNaming === true,
  });
  const id = `${createdAt.replace(/[:.]/gu, "-")}-${seed.slice(0, 12)}`;
  const draft: ChangePlan = {
    schemaVersion: "2.0",
    id,
    createdAt,
    projectDir: root,
    intakeHash,
    discoveryHash: fileHash(discoveryFile) ?? "",
    sourceHashes: intake.sources.map(({ path, sha256: sourceHash }) => ({ path, sha256: sourceHash })),
    operations,
    commands: uniqueCommands([
      ...deduplicateCommands(policy),
      ...trustedCommands(root, discovery, "ci").map((item) => item.command),
    ]),
    warnings: [
      ...discovery.warnings,
      ...(args.stacks ?? [])
        .filter((stack) => !discovery.stacks.includes(stack))
        .map((stack) => `Owner-selected stack not observed during discovery: ${stack}`),
      ...policy.project.stacks
        .filter((stack) => !hasBuiltInStackAdapter(stack))
        .map((stack) => `Stack-specific enforcement blocked for '${stack}': no built-in adapter; generic continuity policies will still be applied.`),
      ...policy.policies.filter((item) => item.formalization === "cognitive").map((item) => `${item.id}: guidance requires owner/reviewer judgment`),
      ...(args.adoptTypeScriptNaming
        ? [`Owner-approved intake adopts ${policy.typescriptNamingBaseline?.fingerprints.length ?? 0} existing TypeScript naming violation(s) as a ratcheted baseline.`]
        : []),
      ...(currentBaseline && !args.adoptTypeScriptNaming && (policy.typescriptNamingBaseline?.fingerprints.length ?? 0) < currentBaseline.fingerprints.length
        ? [`TypeScript naming baseline ratchets from ${currentBaseline.fingerprints.length} to ${policy.typescriptNamingBaseline?.fingerprints.length ?? 0} violation(s).`]
        : []),
    ],
    planHash: "",
  };
  draft.planHash = hashObject(withoutHash(draft));
  const path = `.harness/plans/${id}.json`;
  if (args.writePlan) atomicWrite(safePath(root, path), prettyJson(draft));
  return { plan: draft, path, policy };
}

export function planProject(args: ProjectPlanArgs): { plan: ChangePlan; path: string; policy: PolicyDocument } {
  return compileProjectPlan({ ...args, writePlan: true });
}

function compilerVersionReport(root: string, packagePath = PACKAGE_ROOT): {
  status: CompilerVersionStatus;
  current: CompilerIdentity;
  policy: CompilerIdentity | null;
  manifest: CompilerIdentity | null;
} {
  const current = currentCompilerIdentity(packagePath);
  const policyPath = harnessPath(root, "policy.yaml");
  const manifestPath = harnessPath(root, "manifest.json");
  if (!existsSync(policyPath) || !existsSync(manifestPath)) {
    return { status: "unconfigured", current, policy: null, manifest: null };
  }
  const policy = readJson<{ compiler?: unknown }>(policyPath);
  const manifest = readJson<{ compiler?: unknown }>(manifestPath);
  const policyCompiler = exactCompilerIdentity(policy.compiler);
  const manifestCompiler = exactCompilerIdentity(manifest.compiler);
  if (!policyCompiler || !manifestCompiler) {
    return { status: "legacy-version-unknown", current, policy: policyCompiler, manifest: manifestCompiler };
  }
  const status = sameJson(policyCompiler, manifestCompiler) && sameJson(policyCompiler, current) ? "current" : "stale";
  return { status, current, policy: policyCompiler, manifest: manifestCompiler };
}

function currentDiscovery(root: string, stored: Discovery): { expected: string; actual: string; clean: boolean } {
  const generatedAt = new Date(stored.generatedAt);
  if (Number.isNaN(generatedAt.valueOf())) throw new Error("DISCOVERY_INVALID: generatedAt is not a valid timestamp");
  const observed = discoverProject(root, generatedAt);
  observed.agents = observed.agents.filter((agent) => {
    if (stored.agents.some((item) => item.id === agent.id)) return true;
    if (agent.id === "codex" && agent.evidence.every((path) => path === "AGENTS.md")) return false;
    if (agent.id === "claude-code" && agent.evidence.every((path) => path === "CLAUDE.md")) return false;
    return true;
  });
  const actual = hashObject(observed);
  const expected = hashObject(stored);
  return { expected, actual, clean: expected === actual };
}

function observeWorktreeUpdate(root: string): PolicyUpdateMetadata["worktree"] {
  const configPath = join(root, ".harness", "worktree-delivery.json");
  if (!existsSync(configPath)) {
    return { status: "not-configured", configurationPlanPath: null, configurationPlanHash: null, migrationCommand: null, error: null };
  }
  try {
    const loaded = loadConfig(root);
    const providerObservation: ProviderObservation = {
      kind: loaded.config.provider.kind,
      configured: loaded.config.provider.kind !== "none",
      available: true,
      items: [],
    };
    workspaceStatus(root, { providerObservation });
    return {
      status: loaded.legacyBinding ? "configuration-plan-required" : "compatible",
      configurationPlanPath: null,
      configurationPlanHash: null,
      migrationCommand: null,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/^(?:WORKTREE_TOPOLOGY_INVALID|WORKTREE_MANAGEMENT_CHECKOUT_REQUIRED|WORKTREE_MANAGEMENT_CHECKOUT_INVALID|WORKTREE_CONTAINER_|WORKTREE_ALLOWED_ROOT_)/u.test(message)) {
      return {
        status: "migration-required",
        configurationPlanPath: null,
        configurationPlanHash: null,
        migrationCommand: ["harness-automation", "worktree", "migrate", "--workspace-container", "<absolute-path>", "--project", root],
        error: message,
      };
    }
    throw new Error(`WORKTREE_UPDATE_BLOCKED: ${message}`);
  }
}

function inspectWorktreeUpdate(root: string, now?: Date): PolicyUpdateMetadata["worktree"] {
  const observed = observeWorktreeUpdate(root);
  if (observed.status !== "configuration-plan-required") return observed;
  const loaded = loadConfig(root);
  if (!loaded.legacyBinding) throw new Error("WORKTREE_UPDATE_BLOCKED: legacy host binding disappeared during planning");
  const config = loaded.config;
  const providerObservation: ProviderObservation = {
    kind: config.provider.kind,
    configured: config.provider.kind !== "none",
    available: true,
    items: [],
  };
  const plansDirectory = harnessPath(root, "plans");
  const existingPlans = new Set(existsSync(plansDirectory) ? readdirSync(plansDirectory) : []);
  const planned = planWorkspaceConfiguration({
    projectRoot: root,
    mode: config.mode,
    managementBranch: config.managementBranch,
    maxPersistentWorktrees: config.maxPersistentWorktrees,
    leaseTtlHours: config.leaseTtlHours,
    reviewTtlMinutes: config.reviewTtlMinutes,
    remoteBranchRetentionDays: config.remoteBranchRetentionDays,
    remoteBranchDeletion: config.remoteBranchDeletion,
    allowedRoots: loaded.legacyBinding.allowedRoots,
    protectedRoots: loaded.legacyBinding.protectedRoots,
    approval: loaded.legacyBinding.approval,
    provider: config.provider,
    providerObservation,
    now,
  });
  const operation = planned.plan.operation;
  if (operation.kind !== "configure" || !sameJson(JSON.parse(operation.content), config) ||
    !sameJson(JSON.parse(operation.hostBindingContent), loaded.legacyBinding)) {
    const filename = basename(planned.path);
    if (!existingPlans.has(filename)) rmSync(safePath(root, planned.path), { force: true });
    throw new Error("WORKTREE_UPDATE_BLOCKED: explicit values changed while planning the schema rewrite");
  }
  return {
    ...observed,
    configurationPlanPath: planned.path,
    configurationPlanHash: planned.plan.planHash,
  };
}

function validateWorktreeUpdateMetadata(root: string, expected: PolicyUpdateMetadata["worktree"]): void {
  const observed = observeWorktreeUpdate(root);
  if (observed.status !== expected.status) {
    throw new Error("UPDATE_METADATA_INVALID: worktree update status drifted after planning");
  }
  if (expected.status !== "configuration-plan-required") {
    if (!sameJson(expected, observed)) throw new Error("UPDATE_METADATA_INVALID: worktree update metadata is false");
    return;
  }
  if (!expected.configurationPlanPath || !expected.configurationPlanHash || expected.migrationCommand || expected.error) {
    throw new Error("UPDATE_METADATA_INVALID: companion workspace plan metadata is incomplete");
  }
  const companion = readJson<WorkspacePlan>(safePath(root, expected.configurationPlanPath));
  if (companion.kind !== "workspace-plan" || companion.operation.kind !== "configure" ||
    companion.planHash !== expected.configurationPlanHash || hashObject(withoutHash(companion)) !== companion.planHash) {
    throw new Error("UPDATE_METADATA_INVALID: companion workspace plan hash is invalid");
  }
  const loaded = loadConfig(root);
  if (!loaded.legacyBinding || !sameJson(JSON.parse(companion.operation.content), loaded.config) ||
    !sameJson(JSON.parse(companion.operation.hostBindingContent), loaded.legacyBinding)) {
    throw new Error("UPDATE_METADATA_INVALID: companion workspace plan does not preserve current explicit values");
  }
}

export interface ProjectUpdatePlanResult {
  status: "current" | "planned";
  planPath: string | null;
  planHash: string | null;
  plan: ChangePlan | null;
  policy: PolicyDocument;
  worktree: PolicyUpdateMetadata["worktree"];
}

export function planProjectUpdate(args: {
  projectRoot: string;
  adoptTypeScriptNaming?: boolean;
  migrateLegacyEvalSnapshot?: boolean;
  now?: Date;
}): ProjectUpdatePlanResult {
  if (!isAbsolute(args.projectRoot)) throw new Error("UPDATE_PROJECT_ABSOLUTE_REQUIRED: --project must be an absolute path");
  const root = resolve(args.projectRoot);
  const policyPath = harnessPath(root, "policy.yaml");
  const manifestPath = harnessPath(root, "manifest.json");
  const intakePath = harnessPath(root, "intake.json");
  const discoveryPath = harnessPath(root, "discovery.json");
  if (!existsSync(policyPath)) throw new Error("HARNESS_INITIALIZATION_REQUIRED: run intake, discover, plan, and apply before update plan");
  if (![manifestPath, intakePath, discoveryPath].every(existsSync)) {
    throw new Error("HARNESS_APPLIED_STATE_INCOMPLETE: manifest, intake, and discovery are required for update plan");
  }
  const oldPolicy = readJson<PolicyDocument>(policyPath);
  const oldManifest = readJson<Manifest>(manifestPath);
  const intake = readJson<Intake>(intakePath);
  const discovery = readJson<Discovery>(discoveryPath);
  const oldPolicyDigest = hashObject(oldPolicy);
  if (oldManifest.policyDigest && oldManifest.policyDigest !== oldPolicyDigest) {
    throw new Error("MANIFEST_POLICY_DIGEST_MISMATCH: manifest policyDigest does not match .harness/policy.yaml");
  }
  ensureApprovedSources(root, intake);
  if (new Date(discovery.generatedAt).valueOf() < new Date(intake.approvedAt).valueOf()) {
    throw new Error("DISCOVERY_STALE: run discover after the approved intake");
  }
  const discoveryDrift = currentDiscovery(root, discovery);
  if (!discoveryDrift.clean) throw new Error("DISCOVERY_DRIFT: repository facts changed; run intake if sources changed, then discover again");
  const outputDrift = oldManifest.outputs.flatMap((output) => {
    const actual = fileHash(safePath(root, output.path));
    return actual === output.sha256 ? [] : [output.path];
  });
  if (outputDrift.length > 0) throw new Error(`TARGET_DRIFT: ${outputDrift.join(", ")} changed after the last apply`);

  const knownPolicyFields = new Set(["schemaVersion", "compiler", "typescriptNamingBaseline", "evaluations", "project", "sources", "agents", "policies"]);
  const unknownPolicyFields = Object.keys(oldPolicy).filter((field) => !knownPolicyFields.has(field));
  if (unknownPolicyFields.length > 0) {
    throw new Error(`UPDATE_EXPLICIT_CONFIG_UNKNOWN: cannot safely inherit ${unknownPolicyFields.sort().join(", ")}`);
  }
  const project = oldPolicy.project as PolicyDocument["project"] & Record<string, unknown>;
  const knownProjectFields = new Set(["name", "owner", "phase", "profile", "stacks", "deliveryProfiles", "domainProfiles", "qualityProfiles"]);
  const unknownProjectFields = Object.keys(project).filter((field) => !knownProjectFields.has(field));
  if (unknownProjectFields.length > 0) {
    throw new Error(`UPDATE_EXPLICIT_CONFIG_UNKNOWN: cannot safely inherit project.${unknownProjectFields.sort().join(", project.")}`);
  }
  const inherited = inheritedPolicyConfiguration(oldPolicy, discovery);
  const candidate = compileProjectPlan({
    projectRoot: root,
    owner: inherited.owner,
    projectName: project.name,
    phase: project.phase,
    profile: inherited.profile,
    inheritedStacks: inherited.stacks,
    deliveryProfiles: inherited.deliveryProfiles,
    domainProfiles: inherited.domainProfiles,
    qualityProfiles: inherited.qualityProfiles,
    adoptTypeScriptNaming: args.adoptTypeScriptNaming,
    now: args.now,
    writePlan: false,
  });
  const migration = args.migrateLegacyEvalSnapshot
    ? legacyEvalSnapshotMigration(oldPolicy, candidate.policy)
    : undefined;
  const oldEvaluations = migration ? undefined : inheritedEvaluationSnapshot(oldPolicy, candidate.policy);
  const differences = policyDifference(oldPolicy, candidate.policy, oldEvaluations);
  const baseline = baselineDifference(oldPolicy, candidate.policy);
  if ((baseline?.added.length ?? 0) > 0) {
    differences.weakening.detected = true;
    differences.weakening.ruleIds = sortedStrings([...differences.weakening.ruleIds, TYPESCRIPT_NAMING_RULE_ID]);
    differences.weakening.reasons = sortedStrings([...differences.weakening.reasons, `${TYPESCRIPT_NAMING_RULE_ID}: baseline fingerprints added`]);
    differences.weakening.digest = weakeningDigest(
      oldPolicy,
      candidate.policy,
      differences.rules,
      differences.evaluations,
      differences.weakening.ruleIds,
      differences.weakening.reasons,
    );
  }
  const intakeHash = fileHash(intakePath)!;
  const weakeningApproval = intake.policyWeakeningApproval;
  const approved = !differences.weakening.detected || Boolean(weakeningApproval &&
    weakeningApproval.digest === differences.weakening.digest &&
    sameFingerprints(weakeningApproval.ruleIds, differences.weakening.ruleIds) &&
    oldManifest.intakeHash !== intakeHash);
  const worktree = migration ? observeWorktreeUpdate(root) : inspectWorktreeUpdate(root, args.now);
  const discoveryHash = fileHash(discoveryPath)!;
  const localCompiler = currentCompilerIdentity();
  const metadata: PolicyUpdateMetadata = {
    from: previousCompilerMetadata(oldPolicy, oldManifest, oldPolicyDigest),
    to: { compiler: localCompiler, schemaVersion: candidate.policy.schemaVersion, policyDigest: hashObject(candidate.policy) },
    inherited,
    drift: updateDriftMetadata(root, oldManifest, intake, intakeHash, discoveryHash),
    rules: differences.rules,
    evaluations: differences.evaluations,
    adapterCoverage: {
      before: adapterCoverage(oldPolicy),
      after: adapterCoverage(candidate.policy),
      added: subtractFingerprints(adapterCoverage(candidate.policy), adapterCoverage(oldPolicy)),
      removed: subtractFingerprints(adapterCoverage(oldPolicy), adapterCoverage(candidate.policy)),
    },
    baseline,
    targets: candidate.plan.operations.map(({ path, beforeHash, afterHash }) => ({ path, beforeHash, afterHash })),
    weakening: { ...differences.weakening, approved },
    worktree,
    migrationRequired: worktree.status === "migration-required",
  };
  const version = compilerVersionReport(root);
  const targetChanged = candidate.plan.operations.some((item) => item.beforeHash !== item.afterHash);
  const semanticChanged = metadata.rules.added.length > 0 || metadata.rules.removed.length > 0 ||
    metadata.rules.changed.length > 0 || metadata.evaluations.added.length > 0 ||
    metadata.evaluations.removed.length > 0 || metadata.evaluations.changed.length > 0 || Boolean(metadata.baseline &&
      (metadata.baseline.added.length > 0 || metadata.baseline.removed.length > 0));
  if (!targetChanged && !semanticChanged && version.status === "current") {
    return { status: "current", planPath: null, planHash: null, plan: null, policy: candidate.policy, worktree };
  }
  candidate.plan.update = metadata;
  if (migration) candidate.plan.legacyEvalSnapshotMigration = migration;
  candidate.plan.warnings = [
    ...candidate.plan.warnings,
    ...(migration
      ? ["Legacy evaluation snapshot adoption: historical pre-implementation continuity is unavailable; owner review is required before apply."]
      : []),
    ...(differences.weakening.detected && !approved
      ? [`Policy weakening requires owner intake approval for digest ${differences.weakening.digest}.`]
      : []),
    ...(worktree.migrationCommand ? [`Worktree topology migration must be planned separately: ${worktree.migrationCommand.join(" ")}`] : []),
  ];
  candidate.plan.planHash = hashObject(withoutHash(candidate.plan));
  const planTarget = safePath(root, candidate.path);
  if (existsSync(planTarget) && readFileSync(planTarget, "utf8") !== prettyJson(candidate.plan)) {
    throw new Error(`PLAN_ID_CONFLICT: ${candidate.path} already exists with different content`);
  }
  atomicWrite(planTarget, prettyJson(candidate.plan));
  return {
    status: "planned",
    planPath: candidate.path,
    planHash: candidate.plan.planHash,
    plan: candidate.plan,
    policy: candidate.policy,
    worktree,
  };
}

/** @deprecated Use planProjectUpdate. */
export const planProjectUpgrade = planProjectUpdate;
/** @deprecated Use ProjectUpdatePlanResult. */
export type ProjectUpgradePlanResult = ProjectUpdatePlanResult;

function validatePlan(root: string, plan: ChangePlan, approval: string): void {
  const computed = hashObject(withoutHash(plan));
  if (computed !== plan.planHash) throw new Error("PLAN_TAMPERED: plan content does not match its embedded hash");
  if (approval !== plan.planHash) throw new Error(`APPROVAL_MISMATCH: expected exact plan hash ${plan.planHash}`);
  if (realpathSync.native(resolve(plan.projectDir)) !== realpathSync.native(root)) {
    throw new Error("PROJECT_MISMATCH: plan belongs to another project directory");
  }
  assertCurrentHash(harnessPath(root, "intake.json"), plan.intakeHash);
  assertCurrentHash(harnessPath(root, "discovery.json"), plan.discoveryHash);
  for (const source of plan.sourceHashes) assertCurrentHash(safePath(root, source.path), source.sha256);
}

function validateUpdateTransition(root: string, plan: ChangePlan): void {
  if (plan.update && plan.upgrade) throw new Error("UPDATE_METADATA_INVALID: plan cannot contain both update and legacy upgrade metadata");
  const update = plan.update ?? plan.upgrade;
  if (plan.legacyEvalSnapshotMigration && !update) {
    throw new Error("LEGACY_EVAL_SNAPSHOT_MIGRATION_UPDATE_REQUIRED: migration metadata requires an update plan");
  }
  if (!update) return;
  const policyOperation = plan.operations.find((item) => item.path === ".harness/policy.yaml");
  if (!policyOperation) throw new Error("UPDATE_POLICY_OPERATION_REQUIRED: update plan must contain the compiled policy");
  const before = readJson<PolicyDocument>(harnessPath(root, "policy.yaml"));
  const after = JSON.parse(policyOperation.content) as PolicyDocument;
  const manifest = readJson<Manifest>(harnessPath(root, "manifest.json"));
  const intake = readJson<Intake>(harnessPath(root, "intake.json"));
  const discovery = readJson<Discovery>(harnessPath(root, "discovery.json"));
  const beforeDigest = hashObject(before);
  if (manifest.policyDigest && manifest.policyDigest !== beforeDigest) {
    throw new Error("MANIFEST_POLICY_DIGEST_MISMATCH: manifest policyDigest does not match .harness/policy.yaml");
  }
  const afterCompiler = exactCompilerIdentity(after.compiler);
  if (!afterCompiler) throw new Error("UPDATE_METADATA_INVALID: updated policy has no exact compiler identity");
  const intakeHash = fileHash(harnessPath(root, "intake.json"))!;
  const discoveryHash = fileHash(harnessPath(root, "discovery.json"))!;
  const migration = plan.legacyEvalSnapshotMigration;
  const expectedMigration = migration ? legacyEvalSnapshotMigration(before, after) : undefined;
  if (migration && !sameJson(migration, expectedMigration)) {
    throw new Error("LEGACY_EVAL_SNAPSHOT_MIGRATION_INVALID: migration metadata does not match the policy transition");
  }
  if (migration && (!sameJson(evaluationSources(after), approvedEvaluationSources(intake)) ||
    !sameJson(after.evaluations, discoveredEvaluationSnapshot(discovery)))) {
    throw new Error("LEGACY_EVAL_SNAPSHOT_MIGRATION_INVALID: candidate evaluations do not match current approved discovery evidence");
  }
  const differences = policyDifference(before, after, migration ? undefined : inheritedEvaluationSnapshot(before, after));
  const baseline = baselineDifference(before, after);
  if ((baseline?.added.length ?? 0) > 0) {
    differences.weakening.detected = true;
    differences.weakening.ruleIds = sortedStrings([...differences.weakening.ruleIds, TYPESCRIPT_NAMING_RULE_ID]);
    differences.weakening.reasons = sortedStrings([...differences.weakening.reasons, `${TYPESCRIPT_NAMING_RULE_ID}: baseline fingerprints added`]);
    differences.weakening.digest = weakeningDigest(
      before,
      after,
      differences.rules,
      differences.evaluations,
      differences.weakening.ruleIds,
      differences.weakening.reasons,
    );
  }
  const expectedTargets = plan.operations.map(({ path, beforeHash, afterHash }) => ({ path, beforeHash, afterHash }));
  const expectedFrom = previousCompilerMetadata(before, manifest, beforeDigest);
  const expectedTo = { compiler: afterCompiler, schemaVersion: after.schemaVersion, policyDigest: hashObject(after) };
  const expectedInherited = inheritedPolicyConfiguration(before, discovery);
  const expectedDrift = updateDriftMetadata(root, manifest, intake, intakeHash, discoveryHash);
  if (migration) {
    if (!sameJson(update.worktree, observeWorktreeUpdate(root))) {
      throw new Error("UPDATE_METADATA_INVALID: worktree update status drifted after planning");
    }
  } else {
    validateWorktreeUpdateMetadata(root, update.worktree);
  }
  if (!sameJson(update.from, expectedFrom) || !sameJson(update.to, expectedTo) ||
    !sameJson(update.inherited, expectedInherited) || !sameJson(update.drift, expectedDrift) ||
    update.migrationRequired !== (update.worktree.status === "migration-required") ||
    !sameJson(update.rules, differences.rules) || !sameJson(update.baseline, baseline) ||
    !sameJson(update.evaluations, differences.evaluations) ||
    !sameJson(update.adapterCoverage, {
      before: adapterCoverage(before),
      after: adapterCoverage(after),
      added: subtractFingerprints(adapterCoverage(after), adapterCoverage(before)),
      removed: subtractFingerprints(adapterCoverage(before), adapterCoverage(after)),
    }) ||
    !sameJson(update.targets, expectedTargets) ||
    update.weakening.digest !== differences.weakening.digest ||
    !sameJson(update.weakening.ruleIds, differences.weakening.ruleIds) ||
    !sameJson(update.weakening.reasons, differences.weakening.reasons)) {
    throw new Error("UPDATE_METADATA_INVALID: semantic diff or weakening digest does not match the policy transition");
  }
  if (!currentDiscovery(root, discovery).clean) {
    throw new Error("DISCOVERY_DRIFT: repository facts changed after update planning; run intake if sources changed, then discover and plan again");
  }
  if (!differences.weakening.detected) return;
  const approval = intake.policyWeakeningApproval;
  if (!approval || approval.digest !== differences.weakening.digest ||
    !sameFingerprints(approval.ruleIds, differences.weakening.ruleIds) || !update.weakening.approved ||
    update.drift.intake.expected === plan.intakeHash) {
    throw new Error(`WEAKENING_APPROVAL_REQUIRED: owner must approve digest ${differences.weakening.digest} and rule IDs ${differences.weakening.ruleIds.join(", ")} in a fresh intake`);
  }
}

function validateTypeScriptNamingTransition(root: string, plan: ChangePlan): void {
  const policyOperation = plan.operations.find((item) => item.path === ".harness/policy.yaml");
  if (!policyOperation) return;
  const nextPolicy = JSON.parse(policyOperation.content) as Record<string, unknown>;
  const next = typeScriptNamingBaseline(nextPolicy.typescriptNamingBaseline);
  const project = nextPolicy.project as Record<string, unknown> | undefined;
  if (!Array.isArray(project?.stacks) || !project.stacks.includes("typescript")) return;
  if (!next) throw new Error("TYPESCRIPT_NAMING_BASELINE_INVALID: TypeScript policy requires a sorted rule-bound fingerprint baseline");
  const current = currentTypeScriptNamingBaseline(root);
  const nextFingerprints = next.fingerprints;
  const observed = inspectTypeScript(root);
  if (observed.some((violation) => violation.fingerprint === null) ||
    !sameFingerprints(observed.flatMap((violation) => violation.fingerprint ?? []), nextFingerprints)) {
    throw new Error("TYPESCRIPT_NAMING_ADOPTION_DRIFT: naming violations changed after the plan was created");
  }
  const added = subtractFingerprints(nextFingerprints, current?.fingerprints ?? []);
  if (added.length === 0) return;

  const intake = readJson<Intake>(harnessPath(root, "intake.json"));
  const approval = intake.typescriptNamingAdoption;
  if (approval?.ruleId !== TYPESCRIPT_NAMING_RULE_ID ||
    !sameFingerprints(approval.fingerprints, nextFingerprints) || next.approvedIntakeHash !== plan.intakeHash) {
    throw new Error("TYPESCRIPT_NAMING_BASELINE_EXPANSION_NOT_APPROVED: baseline expansion or replacement requires the matching explicit adoption intake");
  }
  if (current?.approvedIntakeHash === plan.intakeHash) {
    throw new Error("TYPESCRIPT_NAMING_ADOPTION_FRESH_INTAKE_REQUIRED: baseline expansion or replacement requires a new explicit adoption intake");
  }
}

export function applyPlan(args: {
  projectRoot: string;
  planPath: string;
  approval: string;
  recoveryApprovalRef?: string;
  now?: Date;
  testInterruptAfterWrites?: number;
  testFailPostApply?: boolean;
  testInterruptAfterChangeReceipt?: boolean;
}): AppliedChange | WorkspaceReceipt {
  const context = resolveProjectContext(args.projectRoot);
  const root = context.projectDir;
  const candidate = readJson<{ kind?: string }>(safePath(root, args.planPath));
  if (candidate.kind === "workspace-plan") return applyWorkspacePlan(args);
  return applyFilePlan(args, context);
}

function applyFilePlan(args: {
  projectRoot: string;
  planPath: string;
  approval: string;
  recoveryApprovalRef?: string;
  now?: Date;
  testInterruptAfterWrites?: number;
  testFailPostApply?: boolean;
  testInterruptAfterChangeReceipt?: boolean;
}, context = resolveProjectContext(args.projectRoot)): AppliedChange {
  const lock = acquireMutationLock(context);
  try {
    return applyFilePlanLocked(args, context);
  } finally {
    releaseMutationLock(lock);
  }
}

function applyFilePlanLocked(args: {
  projectRoot: string;
  planPath: string;
  approval: string;
  recoveryApprovalRef?: string;
  now?: Date;
  testInterruptAfterWrites?: number;
  testFailPostApply?: boolean;
  testInterruptAfterChangeReceipt?: boolean;
}, context: ReturnType<typeof resolveProjectContext>): AppliedChange {
  const root = context.projectDir;
  const plan = readJson<ChangePlan>(safePath(root, args.planPath));
  validatePlan(root, plan, args.approval);
  const changeFile = harnessPath(root, `changes/${plan.id}/change.json`);
  const journalFile = harnessPath(root, `changes/${plan.id}/apply.json`);
  if (existsSync(changeFile)) {
    const existing = readJson<AppliedChange>(changeFile);
    if (existing.planHash === plan.planHash && existing.operations.every((item) => fileHash(safePath(root, item.path)) === item.afterHash)) {
      return existing;
    }
    throw new Error(`CHANGE_ID_CONFLICT: ${plan.id} was already applied but repository outputs have drifted`);
  }
  let existingJournal = existsSync(journalFile) ? readJson<FileApplyJournal>(journalFile) : null;
  const operations = plan.operations.map(({ path, beforeHash, afterHash }) => ({ path, beforeHash, afterHash }));
  if (existingJournal) {
    validateFileApplyJournal(existingJournal);
    if (existingJournal.planHash !== plan.planHash ||
        hashObject(existingJournal.operations) !== hashObject(operations) ||
        existingJournal.written.some((path) => !plan.operations.some((item) => item.path === path))) {
      throw new Error(`RECOVERY_REQUIRED: ${plan.id}`);
    }
    if (existingJournal.status === "failed-compensated") {
      if (plan.operations.some((item) => fileHash(safePath(root, item.path)) !== item.beforeHash)) {
        throw new Error(`RECOVERY_REQUIRED: ${plan.id}`);
      }
      existingJournal = null;
    } else {
      requireMutationAllowed(context, {
        kind: "file-apply", id: plan.id, approvalRef: args.recoveryApprovalRef, now: args.now,
      });
    }
  } else {
    requireMutationAllowed(context);
  }
  validateUpdateTransition(root, plan);
  validateTypeScriptNamingTransition(root, plan);
  for (const item of plan.operations) {
    const current = fileHash(safePath(root, item.path));
    if (current !== item.beforeHash && (!existingJournal || current !== item.afterHash)) {
      if (existingJournal) throw new Error(`RECOVERY_REQUIRED: ${item.path}`);
      assertCurrentHash(safePath(root, item.path), item.beforeHash);
    }
  }

  const attempted = new Set(existingJournal?.written ?? []);
  const recoveryId = existingJournal?.recoveryId ?? randomUUID();
  const checkpoint = (status: FileApplyJournal["status"]) => {
    atomicWrite(journalFile, prettyJson(createFileApplyJournal({
      recoveryId, planHash: plan.planHash, operations, status, written: [...attempted],
    })));
  };
  checkpoint("started");
  try {
    let completedWrites = 0;
    for (const item of plan.operations) {
      const target = safePath(root, item.path);
      if (fileHash(target) === item.afterHash) continue;
      if (item.beforeHash !== null) {
        const backup = harnessPath(root, `changes/${plan.id}/before/${item.path}`);
        if (!existsSync(backup)) atomicWrite(backup, readFileSync(target, "utf8"));
        assertCurrentHash(backup, item.beforeHash);
      }
      attempted.add(item.path);
      checkpoint("started");
      atomicWrite(target, item.content);
      assertCurrentHash(target, item.afterHash);
      completedWrites += 1;
      if (args.testInterruptAfterWrites === completedWrites) throw new Error("TEST_FILE_APPLY_INTERRUPT");
    }
    const verification = checkProject(root);
    if (!verification.ok) {
      const failures = verification.results
        .filter((item) => item.status === "blocked" || item.status === "failing")
        .map((item) => `${item.id}: ${item.detail}`);
      throw new Error(`POST_APPLY_VERIFICATION_FAILED: ${failures.join("; ")}`);
    }
    if (args.testFailPostApply) throw new Error("TEST_FILE_POST_APPLY_FAILURE");
  } catch (error) {
    if (error instanceof Error && error.message === "TEST_FILE_APPLY_INTERRUPT") throw error;
    let uncompensated = false;
    for (const item of [...plan.operations].reverse()) {
      if (!attempted.has(item.path)) continue;
      const target = safePath(root, item.path);
      const current = fileHash(target);
      if (current === item.beforeHash) continue;
      if (current !== item.afterHash) { uncompensated = true; continue; }
      if (item.beforeHash === null) rmSync(target, { force: true });
      else {
        const backup = harnessPath(root, `changes/${plan.id}/before/${item.path}`);
        if (!existsSync(backup) || fileHash(backup) !== item.beforeHash) { uncompensated = true; continue; }
        atomicWrite(target, readFileSync(backup, "utf8"));
      }
    }
    checkpoint(uncompensated ? "failed-uncompensated" : "failed-compensated");
    throw error;
  }

  const change: AppliedChange = {
    schemaVersion: "2.0",
    id: plan.id,
    planHash: plan.planHash,
    appliedAt: (args.now ?? new Date()).toISOString(),
    legacyEvalSnapshotMigration: legacyEvalSnapshotMigrationReceipt(plan, readJson<PolicyDocument>(harnessPath(root, "policy.yaml"))),
    operations: plan.operations.map((item) => ({
      path: item.path,
      beforeHash: item.beforeHash,
      afterHash: item.afterHash,
      backupPath: item.beforeHash === null || item.beforeHash === item.afterHash
        ? null
        : `.harness/changes/${plan.id}/before/${item.path}`,
    })),
  };
  atomicWrite(changeFile, prettyJson(change));
  if (args.testInterruptAfterChangeReceipt) throw new Error("TEST_FILE_CHANGE_RECEIPT_INTERRUPT");
  rmSync(journalFile, { force: true });
  return change;
}

function latestChangeId(root: string): string {
  const directory = harnessPath(root, "changes");
  if (!existsSync(directory)) throw new Error("NO_CHANGES: no v2 change is available to roll back");
  const ids = readdirSync(directory).filter((entry) => existsSync(join(directory, entry, "change.json"))).sort();
  if (ids.length === 0) throw new Error("NO_CHANGES: no v2 change is available to roll back");
  return ids.at(-1)!;
}

export function rollbackChange(args: {
  projectRoot: string;
  changeId?: string;
  now?: Date;
}): { id: string; restored: string[] } | WorkspaceReceipt {
  const context = resolveProjectContext(args.projectRoot);
  const root = context.projectDir;
  const id = args.changeId ?? latestChangeId(root);
  const directory = harnessPath(root, `changes/${id}`);
  if (!existsSync(join(directory, "change.json")) && args.changeId) {
    return rollbackWorkspaceChange({
      projectRoot: root,
      changeId: args.changeId,
      now: args.now,
    });
  }
  const lock = acquireMutationLock(context);
  try {
    requireMutationAllowed(context);
    const marker = join(directory, "rolled-back.json");
    const change = readJson<AppliedChange>(join(directory, "change.json"));
    if (existsSync(marker)) return readJson<{ id: string; restored: string[] }>(marker);
    for (const item of change.operations) assertCurrentHash(safePath(root, item.path), item.afterHash);
    for (const item of [...change.operations].reverse()) {
      const target = safePath(root, item.path);
      if (item.beforeHash === item.afterHash) continue;
      if (item.beforeHash === null) {
        rmSync(target, { force: true });
      } else {
        if (!item.backupPath) throw new Error(`BACKUP_MISSING: ${item.path}`);
        const backup = safePath(root, item.backupPath);
        assertCurrentHash(backup, item.beforeHash);
        atomicWrite(target, readFileSync(backup, "utf8"));
      }
    }
    const result = { id, restored: change.operations.map((item) => item.path), rolledBackAt: (args.now ?? new Date()).toISOString() };
    atomicWrite(marker, prettyJson(result));
    return result;
  } finally {
    releaseMutationLock(lock);
  }
}

interface Manifest {
  schemaVersion: "2.0";
  compiler?: unknown;
  policyDigest: string;
  intakeHash?: string;
  discoveryHash?: string;
  outputs: Array<{ path: string; sha256: string }>;
}

export function driftProject(projectRoot: string): {
  clean: boolean;
  workspaceClean: boolean;
  sourceDrift: string[];
  outputDrift: Array<{ path: string; expected: string; actual: string | null }>;
  workspace: WorkspaceAudit | null;
} {
  const root = resolve(projectRoot);
  const intakePath = harnessPath(root, "intake.json");
  const manifestPath = harnessPath(root, "manifest.json");
  const intake = existsSync(intakePath) ? readJson<Intake>(intakePath) : null;
  const manifest = existsSync(manifestPath) ? readJson<Manifest>(manifestPath) : null;
  const sourceDrift = intake
    ? intake.sources
        .filter((source) => fileHash(safePath(root, source.path)) !== source.sha256)
        .map((source) => source.path)
    : [];
  const outputDrift = manifest
    ? manifest.outputs.flatMap((output) => {
        const actual = fileHash(safePath(root, output.path));
        return actual === output.sha256 ? [] : [{ path: output.path, expected: output.sha256, actual }];
      })
    : [];
  const workspace = existsSync(join(root, ".harness/worktree-delivery.json"))
    ? auditWorkspace(root)
    : null;
  return {
    clean: sourceDrift.length === 0 && outputDrift.length === 0,
    workspaceClean: workspace?.passing ?? true,
    sourceDrift,
    outputDrift,
    workspace,
  };
}

export function checkProject(projectRoot: string, observedDrift?: ReturnType<typeof driftProject>): {
  ok: boolean;
  policyDigest: string;
  agents: Array<{ id: string; configured: boolean; loaded: boolean; enforced: boolean; passing: boolean; status: "verified" | "failing" | "blocked" }>;
  results: EnforcementResult[];
  stackAdapters: StackAdapterResult[];
  stackCoverageComplete: boolean;
  violations: string[];
} {
  const root = resolve(projectRoot);
  const policy = readJson<PolicyDocument>(harnessPath(root, "policy.yaml"));
  const digest = hashObject(policy);
  const drift = observedDrift ?? driftProject(root);
  const agentsLoaded = ["AGENTS.md", "CLAUDE.md"].some((path) => {
    const target = join(root, path);
    return existsSync(target) && readFileSync(target, "utf8").includes(digest);
  });
  const naming = {
    typescript: policy.project.stacks.includes("typescript")
      ? checkTypeScript(root, policy.typescriptNamingBaseline)
      : null,
    python: policy.project.stacks.includes("python") ? checkPython(root) : null,
    go: policy.project.stacks.includes("go") ? checkGo(root) : null,
  };
  const violations = Object.values(naming).flatMap((result) => result?.violations ?? []);
  const results = policy.policies.map<EnforcementResult>((item) => {
    if (item.formalization === "cognitive") {
      return { id: item.id, configured: true, loaded: agentsLoaded, enforced: false, passing: true, status: "guidance", detail: "Cognitive policy is review guidance, not a hard gate." };
    }
    const checker = item.id === "typescript-naming" ? naming.typescript
      : item.id === "python-naming" ? naming.python
      : item.id === "go-naming" ? naming.go
      : null;
    if (checker) {
      const status = !checker.enforced ? "blocked" : checker.passing ? "verified" : "failing";
      return { id: item.id, configured: true, loaded: agentsLoaded, enforced: checker.enforced, passing: checker.passing, status, detail: checker.detail };
    }
    if (item.id === "generated-files-immutable") {
      return { id: item.id, configured: true, loaded: agentsLoaded, enforced: true, passing: drift.outputDrift.length === 0, status: drift.outputDrift.length === 0 ? "verified" : "failing", detail: `${drift.outputDrift.length} generated output(s) drifted` };
    }
    return { id: item.id, configured: true, loaded: agentsLoaded, enforced: false, passing: agentsLoaded, status: agentsLoaded ? "guidance" : "blocked", detail: "Loaded as a required session procedure; evidence is recorded by `context`." };
  });
  const hardResults = results.filter((item) => item.status !== "guidance");
  const hardEnforced = hardResults.every((item) => item.enforced);
  const hardPassing = hardResults.every((item) => item.passing);
  const stackAdapters = policy.project.stacks.map<StackAdapterResult>((stack) => {
    const support = stackAdapterSupport(stack);
    const checker = stack === "typescript" ? naming.typescript
      : stack === "python" ? naming.python
      : stack === "go" ? naming.go
      : null;
    const ruleId = stack === "typescript" ? "typescript-naming"
      : stack === "python" ? "python-naming"
      : stack === "go" ? "go-naming"
      : null;
    const gate = ruleId ? results.find((item) => item.id === ruleId) : null;
    const evidenceGaps = checker ? [
      ...(checker.adapterReachable ? [] : ["adapter is unreachable"]),
      ...(checker.knownBadRejected ? [] : ["known-bad fixture was not rejected"]),
      ...(gate ? [] : ["project check gate is not connected"]),
    ] : [];
    const supported = checker !== null && checker.adapterReachable && checker.knownBadRejected;
    const enforced = supported && gate?.enforced === true;
    const passing = enforced && gate?.passing === true;
    const available = support !== "none";
    return {
      stack,
      support,
      available,
      supported,
      enforced,
      passing,
      status: checker
        ? evidenceGaps.length > 0 ? "blocked" : passing ? "verified" : "failing"
        : support === "guidance" || support === "procedural" ? "guidance" : "blocked",
      evidence: {
        adapterReachable: checker?.adapterReachable ?? false,
        knownBadRejected: checker?.knownBadRejected ?? false,
        projectGateConnected: gate !== null,
      },
      evidenceGaps,
      detail: checker
        ? evidenceGaps.length > 0
          ? `Naming adapter for '${stack}' is blocked: ${evidenceGaps.join("; ")}.`
          : passing
            ? `Naming adapter for '${stack}' is supported and enforced by the project check gate.`
            : `Naming adapter for '${stack}' is supported and enforced, but the project check is failing.`
        : available
          ? `Harness provides ${support} guidance for '${stack}', not stack-specific enforced support.`
          : `No built-in adapter for '${stack}'; generic continuity policies are active, but stack-specific enforcement is unavailable.`,
    };
  });
  const agents = policy.agents.adapters.map((adapter) => {
    const path = adapter.id === "claude-code" ? "CLAUDE.md" : "AGENTS.md";
    const target = join(root, path);
    const configured = existsSync(target);
    const loaded = configured && readFileSync(target, "utf8").includes(digest);
    const enforced = loaded && hardEnforced;
    const passing = enforced && hardPassing && drift.clean;
    return {
      id: adapter.id,
      configured,
      loaded,
      enforced,
      passing,
      status: !configured || !loaded || !enforced ? "blocked" as const : passing ? "verified" as const : "failing" as const,
    };
  });
  return {
    ok: drift.clean && hardEnforced && hardPassing && agents.every((agent) => agent.passing),
    policyDigest: digest,
    agents,
    results,
    stackAdapters,
    stackCoverageComplete: stackAdapters.every((adapter) => adapter.supported && adapter.enforced),
    violations,
  };
}

export interface TrustedCommandResult {
  id: string;
  command: string[];
  status: "passed" | "failed" | "blocked";
  exitCode: number | null;
  output: string;
  outputSha256: string;
}

function executableOnPath(command: string): boolean {
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];
  return (process.env.PATH ?? "").split(delimiter).filter(Boolean).some((directory) =>
    extensions.some((extension) => {
      try {
        accessSync(join(directory, `${command}${extension}`), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    })
  );
}

export function hasExecutableFileHeader(header: Uint8Array): boolean {
  if (header.length < 2) return false;
  if (header[0] === 0x23 && header[1] === 0x21) return true;
  if (header.length < 4) return false;
  const magic = ((header[0] << 24) | (header[1] << 16) | (header[2] << 8) | header[3]) >>> 0;
  return [
    0x7f454c46, // ELF
    0xfeedface, 0xcefaedfe, // Mach-O 32-bit, both endian orders
    0xfeedfacf, 0xcffaedfe, // Mach-O 64-bit, both endian orders
    0xcafebabe, 0xbebafeca, // Mach-O fat, both endian orders
    0xcafebabf, 0xbfbafeca, // Mach-O fat 64-bit, both endian orders
    0x4d5a0000, // PE/DOS MZ (only the first two bytes are significant)
  ].includes(magic) || (header[0] === 0x4d && header[1] === 0x5a);
}

function hasRecognizedExecutableFileHeader(path: string): boolean {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, "r");
    const header = Buffer.alloc(4);
    const bytesRead = readSync(descriptor, header, 0, header.length, 0);
    return hasExecutableFileHeader(header.subarray(0, bytesRead));
  } catch {
    return false;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function executableAvailable(command: string, root: string): boolean {
  if (!command.includes("/") && !command.includes("\\")) return executableOnPath(command);
  try {
    const path = resolve(root, command);
    accessSync(path, constants.X_OK);
    return hasRecognizedExecutableFileHeader(path);
  } catch {
    return false;
  }
}

function trustedCommands(root: string, discovery: Discovery, mode: "session" | "commit" | "ci"): Array<{ id: string; command: string[] }> {
  if (mode === "session") return [];
  const selected: Array<{ id: string; command: string[] }> = [];
  const add = (id: string, command: string[] | undefined): void => {
    if (command && !selected.some((item) => JSON.stringify(item.command) === JSON.stringify(command))) selected.push({ id, command });
  };
  for (const [id, command] of Object.entries(discovery.commands)) {
    const parts = id.split(":");
    const name = parts.length >= 3 ? parts.slice(2).join(":").toLowerCase() : parts.at(-1)?.toLowerCase() ?? "";
    const commitGate = ["lint", "typecheck", "check", "format:check"].includes(name) ||
      name.startsWith("verify:") ||
      name.endsWith(":check");
    const ciGate = ["test", "build", "test:ci"].includes(name) ||
      name.startsWith("test:") ||
      name.startsWith("build:");
    if (commitGate) add(id, command);
    if (mode === "ci" && ciGate) add(id, command);
    if (mode === "ci" && (id.startsWith("eval:") || id.startsWith("eval-negative:"))) add(id, command);
  }
  if (discovery.stacks.includes("python") && existsSync(join(root, "manage.py"))) {
    add("django:check", ["python3", "manage.py", "check"]);
    add("django:migrations", ["python3", "manage.py", "makemigrations", "--check", "--dry-run"]);
    if (mode === "ci") add("django:test", ["python3", "manage.py", "test"]);
  }
  if (discovery.stacks.includes("go")) {
    const goFiles = sourceFiles(root, ".go");
    if (goFiles.length > 0) add("go:format", ["gofmt", "-l", ...goFiles]);
    add("go:vet", ["go", "vet", "./..."]);
    if (mode === "ci") add("go:test", ["go", "test", "./..."]);
  }
  if (discovery.stacks.includes("grpc") && existsSync(join(root, "buf.yaml"))) add("proto:lint", ["buf", "lint"]);
  if (["sqlc.yaml", "sqlc.yml"].some((path) => existsSync(join(root, path)))) add("sqlc:vet", ["sqlc", "vet"]);
  if (existsSync(join(root, "node_modules/.bin/prisma"))) add("prisma:validate", ["node_modules/.bin/prisma", "validate"]);
  if (discovery.stacks.includes("kubernetes")) {
    const manifests = sourceFiles(root, ".yaml").filter((path) => /^(k8s|deploy|deployment|manifests)\//u.test(path));
    const yamlManifests = [...manifests, ...sourceFiles(root, ".yml").filter((path) => /^(k8s|deploy|deployment|manifests)\//u.test(path))];
    if (yamlManifests.length > 0) add("kubernetes:schema", ["kubeconform", "-summary", "-strict", ...yamlManifests]);
  }
  return selected;
}

function runTrustedCommand(
  root: string,
  id: string,
  command: string[],
  mode: "session" | "commit" | "ci",
  expectedExitCode = 0,
  timeoutMs?: number,
): TrustedCommandResult {
  if (!executableAvailable(command[0], root)) {
    return {
      id,
      command,
      status: "blocked",
      exitCode: null,
      output: `${command[0]} is not installed`,
      outputSha256: hashObject({ stdout: "", stderr: "" }),
    };
  }
  const result = spawnSync(command[0], command.slice(1), {
    cwd: root,
    encoding: "utf8",
    timeout: timeoutMs ?? (mode === "ci" ? 15 * 60_000 : 5 * 60_000),
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, CI: "1" },
  });
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  const outputSha256 = hashObject({ stdout, stderr });
  const output = `${stdout}${stderr}`.trim().slice(-20_000);
  if (result.error) {
    const errorCode = (result.error as NodeJS.ErrnoException).code;
    return {
      id,
      command,
      status: errorCode === "ETIMEDOUT" || errorCode === "ENOBUFS" ? "failed" : "blocked",
      exitCode: null,
      output: (output || String(result.error)).slice(-20_000),
      outputSha256,
    };
  }
  const gofmtDirty = id === "go:format" && output.length > 0;
  const passed = result.status === expectedExitCode && !gofmtDirty;
  return { id, command, status: passed ? "passed" : "failed", exitCode: result.status, output, outputSha256 };
}

export function runTrustedChecks(args: {
  projectRoot: string;
  mode: "session" | "commit" | "ci";
  now?: Date;
  /** Test seam; production callers use the fixed mode-specific timeout. */
  commandTimeoutMs?: number;
}): {
  ok: boolean;
  policy: ReturnType<typeof checkProject>;
  stackAdapters: StackAdapterResult[];
  stackCoverageComplete: boolean;
  commands: TrustedCommandResult[];
  evaluations: {
    configured: boolean;
    loaded: boolean;
    enforced: boolean;
    passing: boolean;
    available: boolean;
    status: "not-configured" | "not-run" | "verified" | "failing" | "blocked";
    contractPath: string | null;
    receiptPath: string | null;
    receiptHash: string | null;
  };
  workspace: {
    configured: boolean;
    available: boolean;
    status: "not-configured" | "verified" | "failing" | "blocked";
    detail: string;
    audit: WorkspaceAudit | null;
  };
} {
  const root = resolve(args.projectRoot);
  const drift = driftProject(root);
  const policy = checkProject(root, drift);
  const policyDocument = readJson<PolicyDocument>(harnessPath(root, "policy.yaml"));
  const discovery = readJson<Discovery>(harnessPath(root, "discovery.json"));
  const evaluationEnabled = (policyDocument.project.qualityProfiles ?? [])
    .includes("eval-driven-development");
  const approvedEvalPaths = new Set(
    policyDocument.sources.filter((source) => source.kind === "eval").map((source) => source.path),
  );
  let approvedEvalContract: ReturnType<typeof readEvalContract> | null = null;
  let evalPreflightError: string | null = null;
  if (evaluationEnabled && args.mode === "ci") {
    const currentEvalPaths = evaluationSourcePaths(root);
    const sameEvalSourceSet = currentEvalPaths.length === approvedEvalPaths.size &&
      currentEvalPaths.every((path) => approvedEvalPaths.has(path));
    if (!sameEvalSourceSet) {
      evalPreflightError = "approved eval source set changed";
    } else if (drift.sourceDrift.some((path) => approvedEvalPaths.has(path))) {
      evalPreflightError = "approved eval sources drifted";
    } else {
      try {
        approvedEvalContract = readEvalContract(root, approvedEvalPaths);
      } catch (error) {
        evalPreflightError = error instanceof Error ? error.message : String(error);
      }
    }
  }
  const evaluationArgv = approvedEvalContract
    ? approvedEvalContract.suites.flatMap((suite) => [
        suite.command,
        ...(suite.negativeControl ? [suite.negativeControl.command] : []),
      ])
    : [];
  const isEvaluationArgv = (command: string[]): boolean => evaluationArgv.some((evaluation) =>
    command.length === evaluation.length && command.every((value, index) => value === evaluation[index])
  );
  const commands = evaluationEnabled && args.mode === "ci" && evalPreflightError
    ? []
    : trustedCommands(root, discovery, args.mode)
    .filter(({ id, command }) =>
      !id.startsWith("eval:") && !id.startsWith("eval-negative:") && !isEvaluationArgv(command)
    )
    .map<TrustedCommandResult>(({ id, command }) => runTrustedCommand(root, id, command, args.mode, 0, args.commandTimeoutMs));
  const workspaceConfigured = existsSync(join(root, ".harness/worktree-delivery.json"));
  const ciCannotObserveHost = args.mode === "ci" || process.env.CI === "1";
  const workspace = !workspaceConfigured
    ? {
        configured: false,
        available: true,
        status: "not-configured" as const,
        detail: "Worktree delivery governance is not configured.",
        audit: null,
      }
    : ciCannotObserveHost
      ? {
          configured: true,
          available: false,
          status: "blocked" as const,
          detail: "CI cannot observe host-local worktrees or Git common-dir leases; run the session gate locally.",
          audit: null,
        }
      : (() => {
          const audit = drift.workspace!;
          return {
            configured: true,
            available: true,
            status: audit.passing ? "verified" as const : "failing" as const,
            detail: audit.passing
              ? "Host-local worktree policies pass."
              : "Host-local worktree policies failed.",
            audit,
          };
        })();
  const workspaceGatePassing = workspace.status === "not-configured" ||
    workspace.status === "verified" ||
    workspace.status === "blocked";
  const evaluationLoaded = policy.results
    .find((item) => item.id === "eval-contract-before-implementation")?.loaded ?? false;
  let evaluations: {
    configured: boolean;
    loaded: boolean;
    enforced: boolean;
    passing: boolean;
    available: boolean;
    status: "not-configured" | "not-run" | "verified" | "failing" | "blocked";
    contractPath: string | null;
    receiptPath: string | null;
    receiptHash: string | null;
  };
  if (!evaluationEnabled) {
    evaluations = {
      configured: false,
      loaded: false,
      enforced: false,
      passing: false,
      available: true,
      status: "not-configured",
      contractPath: null,
      receiptPath: null,
      receiptHash: null,
    };
  } else if (args.mode !== "ci") {
    evaluations = {
      configured: true,
      loaded: evaluationLoaded,
      enforced: false,
      passing: false,
      available: Boolean(discovery.evaluations?.valid),
      status: "not-run",
      contractPath: EVAL_CONTRACT_PATH,
      receiptPath: null,
      receiptHash: null,
    };
  } else {
    const contract = approvedEvalContract;
    const contractVersion = contract?.schemaVersion ?? null;
    let suites: Array<{
      id: string;
      baselineOrigin: string;
      requirementIds: string[];
      ruleIds: string[];
      positive: TrustedCommandResult;
      negative: TrustedCommandResult | null;
    }> = [];
    const contractError = evalPreflightError;
    if (contract) {
      suites = contract.suites.map((suite) => ({
          id: suite.id,
          baselineOrigin: suite.baseline.origin,
          requirementIds: (suite.traceability ?? []).map((trace) => trace.requirementId),
          ruleIds: (suite.traceability ?? []).flatMap((trace) => trace.ruleIds),
          positive: runTrustedCommand(root, `eval:${suite.id}`, suite.command, args.mode, 0, args.commandTimeoutMs),
          negative: contract.schemaVersion === "1.1" && suite.negativeControl
            ? runTrustedCommand(
                root,
                `eval-negative:${suite.id}`,
                suite.negativeControl.command,
                args.mode,
                suite.negativeControl.expectedExitCode,
                args.commandTimeoutMs,
              )
            : null,
        }));
    }
    const positiveFailed = suites.some((suite) => suite.positive.status === "failed");
    const unavailable = Boolean(contractError) || suites.length === 0 || suites.some((suite) =>
      suite.positive.status === "blocked" || suite.negative === null || suite.negative.status === "blocked",
    );
    const negativeFailed = suites.some((suite) => suite.negative?.status === "failed");
    const passing = suites.length > 0 && suites.every((suite) => suite.positive.status === "passed");
    const enforced = contractVersion === "1.1" && suites.length > 0 && suites.every((suite) => suite.negative?.status === "passed");
    const available = !unavailable;
    const status = unavailable
      ? "blocked" as const
      : positiveFailed || negativeFailed
          ? "failing" as const
          : "verified" as const;
    const createdAt = (args.now ?? new Date()).toISOString();
    const receiptPath = `.harness/eval-runs/${createdAt.replace(/[:.]/gu, "-")}.json`;
    const receipt = contractError ? null : {
      schemaVersion: "1.1",
      createdAt,
      policyDigest: policy.policyDigest,
      contractSha256: policyDocument.sources.find((source) => source.path === EVAL_CONTRACT_PATH)?.sha256 ?? null,
      suites: suites.map((suite) => ({
        id: suite.id,
        baselineOrigin: suite.baselineOrigin,
        requirementIds: suite.requirementIds,
        ruleIds: suite.ruleIds,
        positive: {
          command: suite.positive.command,
          status: suite.positive.status,
          exitCode: suite.positive.exitCode,
          outputSha256: suite.positive.outputSha256,
        },
        negative: suite.negative && {
          command: suite.negative.command,
          status: suite.negative.status,
          exitCode: suite.negative.exitCode,
          outputSha256: suite.negative.outputSha256,
        },
      })),
      error: contractError,
    };
    const receiptHash = receipt ? hashObject(receipt) : null;
    if (receipt && receiptHash) atomicWrite(safePath(root, receiptPath), prettyJson({ ...receipt, receiptHash }));
    evaluations = {
      configured: true,
      loaded: evaluationLoaded,
      enforced,
      passing,
      available,
      status,
      contractPath: EVAL_CONTRACT_PATH,
      receiptPath: receipt ? receiptPath : null,
      receiptHash,
    };
  }
  if (evaluationEnabled && args.mode === "ci") {
    const gate = policy.results.find((item) => item.id === "eval-regression-gate");
    if (gate) {
      gate.configured = evaluations.configured;
      gate.loaded = evaluations.loaded;
      gate.enforced = evaluations.enforced;
      gate.passing = evaluations.passing;
      gate.status = evaluations.status === "verified"
        ? "verified"
        : evaluations.status === "failing"
          ? "failing"
          : "blocked";
      gate.detail = evaluations.status === "verified"
        ? "Every approved evaluation suite passed in CI mode."
        : `Evaluation CI gate is ${evaluations.status}.`;
    }
    policy.ok = policy.ok && evaluations.status === "verified";
  }
  return {
    ok: policy.ok &&
      commands.every((item) => item.status === "passed") &&
      workspaceGatePassing &&
      evaluations.status !== "blocked" &&
      evaluations.status !== "failing",
    policy,
    stackAdapters: policy.stackAdapters,
    stackCoverageComplete: policy.stackCoverageComplete,
    commands,
    evaluations,
    workspace,
  };
}

export function explainPolicy(projectRoot: string, policyId: string): PolicyDocument["policies"][number] {
  const root = resolve(projectRoot);
  const policy = readJson<PolicyDocument>(harnessPath(root, "policy.yaml"));
  const item = policy.policies.find((candidate) => candidate.id === policyId);
  if (!item) throw new Error(`POLICY_NOT_FOUND: ${policyId}`);
  return item;
}

export function createSessionContext(projectRoot: string, now?: Date, requestedAgent: "auto" | "portable" | "claude-code" | "codex" = "auto"): {
  policyDigest: string;
  policyPath: string;
  owner: string;
  agent: string;
  receipt: string;
  message: string;
} {
  const root = resolve(projectRoot);
  const policy = readJson<PolicyDocument>(harnessPath(root, "policy.yaml"));
  const policyDigest = hashObject(policy);
  const timestamp = (now ?? new Date()).toISOString();
  const agent = requestedAgent === "auto" ? "portable" : requestedAgent;
  const receipt = `.harness/sessions/${timestamp.replace(/[:.]/gu, "-")}-${process.pid}.json`;
  atomicWrite(safePath(root, receipt), prettyJson({ schemaVersion: "2.0", startedAt: timestamp, policyDigest, owner: policy.project.owner, agent }));
  return {
    policyDigest,
    policyPath: ".harness/generated/effective-policy.md",
    owner: policy.project.owner,
    agent,
    receipt,
    message: "Read the effective policy, then search for the existing implementation and owning module before editing code.",
  };
}

export function doctorProject(projectRoot: string, options?: { packagePath?: string; homeDirectory?: string }): Record<string, unknown> {
  const root = resolve(projectRoot);
  return {
    projectDir: root,
    exists: existsSync(root) && statSync(root).isDirectory(),
    git: executableOnPath("git"),
    githubCli: executableOnPath("gh"),
    node: executableOnPath("node"),
    python: executableOnPath("python3"),
    go: executableOnPath("go"),
    prd: existsSync(join(root, "docs/PRD.md")),
    research: markdownFiles(safePath(root, "docs/research"), root).length,
    evaluations: inspectEvaluations(root),
    skillInstallations: inspectSkillInstallations(options),
    intake: existsSync(harnessPath(root, "intake.json")),
    discovery: existsSync(harnessPath(root, "discovery.json")),
    policy: existsSync(harnessPath(root, "policy.yaml")),
    compiler: compilerVersionReport(root),
  };
}

interface GitHubCandidate {
  fullName: string;
  url: string;
  description: string | null;
  license: string | null;
  stars: number;
  updatedAt: string;
  query: string;
}

function researchQueries(root: string, requested: string[]): string[] {
  if (requested.length > 0) return [...new Set(requested.map((value) => value.trim()).filter(Boolean))].slice(0, 5);
  const prd = readFileSync(safePath(root, "docs/PRD.md"), "utf8");
  const backticks = [...prd.matchAll(/`([^`]{2,40})`/gu)].map((match) => match[1]);
  const headings = [...prd.matchAll(/^#{1,3}\s+(.{2,60})$/gmu)].map((match) => match[1]);
  return [...new Set([...backticks, ...headings])].slice(0, 3);
}

export function researchGitHub(args: { projectRoot: string; queries?: string[]; now?: Date }): { report: string; index: string; candidates: GitHubCandidate[] } {
  const root = resolve(args.projectRoot);
  if (!existsSync(safePath(root, "docs/PRD.md"))) throw new Error("PRD_REQUIRED: docs/PRD.md was not found");
  const queries = researchQueries(root, args.queries ?? []);
  if (queries.length === 0) throw new Error("RESEARCH_QUERY_REQUIRED: pass at least one --query because no stable concepts could be derived from the PRD");
  const candidates: GitHubCandidate[] = [];
  for (const query of queries) {
    const result = spawnSync("gh", ["api", "--method", "GET", "search/repositories", "-f", `q=${query}`, "-f", "per_page=10"], {
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
      throw new Error(`GITHUB_RESEARCH_BLOCKED: gh search failed for '${query}': ${result.stderr || result.error}`);
    }
    const body = JSON.parse(result.stdout) as { items?: Array<Record<string, unknown>> };
    for (const item of body.items ?? []) {
      candidates.push({
        fullName: String(item.full_name ?? ""),
        url: String(item.html_url ?? ""),
        description: item.description ? String(item.description) : null,
        license: (item.license as { spdx_id?: string } | null)?.spdx_id ?? null,
        stars: Number(item.stargazers_count ?? 0),
        updatedAt: String(item.updated_at ?? ""),
        query,
      });
    }
  }
  const uniqueCandidates = [...new Map(candidates.map((candidate) => [candidate.fullName, candidate])).values()];
  const generatedAt = (args.now ?? new Date()).toISOString();
  const date = generatedAt.slice(0, 10);
  const report = `docs/research/github-wheels-${date}.md`;
  const index = `docs/research/github-wheels-${date}.json`;
  const rows = uniqueCandidates.map((item) => `| [${item.fullName}](${item.url}) | ${item.license ?? "unknown"} | ${item.updatedAt.slice(0, 10)} | ${item.stars} | ${item.query.replaceAll("|", "\\|")} |`).join("\n");
  const markdown = [
    "# GitHub Wheel Research",
    "",
    `Generated: ${date}`,
    "",
    "This is deterministic discovery evidence, not an adoption decision. Shortlisted projects still require official-documentation, security, compatibility, and integration-cost review.",
    "",
    "## Queries",
    "",
    ...queries.map((query) => `- \`${query}\``),
    "",
    "## Candidates",
    "",
    "| Repository | License | Updated | Stars (signal only) | Query |",
    "|---|---:|---:|---:|---|",
    rows || "| None | — | — | — | — |",
    "",
    "## Required shortlist review",
    "",
    "For each shortlisted project, record official documentation, release compatibility, maintenance risk, security history, integration cost, rejection reasons, and the exact PRD/design decision it supports.",
    "",
  ].join("\n");
  atomicWrite(safePath(root, report), markdown);
  atomicWrite(safePath(root, index), prettyJson({ schemaVersion: "2.0", generatedAt, queries, candidates: uniqueCandidates }));
  return { report, index, candidates: uniqueCandidates };
}
