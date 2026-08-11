import { spawnSync } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, lstatSync, openSync, readSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join, relative, resolve } from "node:path";
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
  Discovery,
  DeliveryProfile,
  DomainProfile,
  EnforcementResult,
  FileOperation,
  Intake,
  PolicyDocument,
  QualityProfile,
  SourceSnapshot,
  Stack,
  StackAdapterResult,
  StackProfile,
} from "./types.js";
import { hasBuiltInStackAdapter, stackAdapterSupport } from "./types.js";
import { EVAL_CONTRACT_PATH, evaluationSourcePaths, inspectEvaluations, readEvalContract } from "./evals.js";
import { checkGo, checkPython, checkTypeScript } from "./verifier.js";
import {
  applyWorkspacePlan,
  auditWorkspace,
  rollbackWorkspaceChange,
} from "../worktree/service.js";
import type { WorkspaceAudit, WorkspaceReceipt } from "../worktree/types.js";

const HARNESS_DIR = ".harness";
const PACKAGE_ROOT = resolve(join(fileURLToPath(new URL(".", import.meta.url)), "../.."));
const SKILL_NAMES = ["harness-automation", "manage-worktree-delivery"] as const;

export type SkillName = typeof SKILL_NAMES[number];

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

export function planProject(args: {
  projectRoot: string;
  profile?: StackProfile;
  stacks?: Stack[];
  deliveryProfiles?: DeliveryProfile[];
  domainProfiles?: DomainProfile[];
  qualityProfiles?: QualityProfile[];
  now?: Date;
}): { plan: ChangePlan; path: string; policy: PolicyDocument } {
  const root = resolve(args.projectRoot);
  const intakeFile = harnessPath(root, "intake.json");
  const discoveryFile = harnessPath(root, "discovery.json");
  if (!existsSync(intakeFile)) throw new Error("INTAKE_REQUIRED: run intake first");
  if (!existsSync(discoveryFile)) throw new Error("DISCOVERY_REQUIRED: run discover first");
  const intake = readJson<Intake>(intakeFile);
  const discovery = readJson<Discovery>(discoveryFile);
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
    owner: intake.owner,
    intake,
    discovery,
    profile: args.profile,
    stacks: args.stacks,
    deliveryProfiles: args.deliveryProfiles,
    domainProfiles: args.domainProfiles,
    qualityProfiles,
  });
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
    compiler: "harness-automation@2",
    policyDigest,
    outputs: operations.map(({ path, afterHash }) => ({ path, sha256: afterHash })),
  };
  operations.push(operation(root, ".harness/manifest.json", prettyJson(manifest)));

  const createdAt = (args.now ?? new Date()).toISOString();
  const seed = hashObject({
    intake: fileHash(intakeFile),
    discovery: fileHash(discoveryFile),
    profile: args.profile ?? discovery.profile,
    stacks: args.stacks ?? null,
    deliveryProfiles: args.deliveryProfiles ?? [],
    domainProfiles: args.domainProfiles ?? [],
    qualityProfiles,
  });
  const id = `${createdAt.replace(/[:.]/gu, "-")}-${seed.slice(0, 12)}`;
  const draft: ChangePlan = {
    schemaVersion: "2.0",
    id,
    createdAt,
    projectDir: root,
    intakeHash: fileHash(intakeFile) ?? "",
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
    ],
    planHash: "",
  };
  draft.planHash = hashObject(withoutHash(draft));
  const path = `.harness/plans/${id}.json`;
  atomicWrite(safePath(root, path), prettyJson(draft));
  return { plan: draft, path, policy };
}

function validatePlan(root: string, plan: ChangePlan, approval: string): void {
  const computed = hashObject(withoutHash(plan));
  if (computed !== plan.planHash) throw new Error("PLAN_TAMPERED: plan content does not match its embedded hash");
  if (approval !== plan.planHash) throw new Error(`APPROVAL_MISMATCH: expected exact plan hash ${plan.planHash}`);
  if (resolve(plan.projectDir) !== root) throw new Error("PROJECT_MISMATCH: plan belongs to another project directory");
  assertCurrentHash(harnessPath(root, "intake.json"), plan.intakeHash);
  assertCurrentHash(harnessPath(root, "discovery.json"), plan.discoveryHash);
  for (const source of plan.sourceHashes) assertCurrentHash(safePath(root, source.path), source.sha256);
}

export function applyPlan(args: {
  projectRoot: string;
  planPath: string;
  approval: string;
  now?: Date;
}): AppliedChange | WorkspaceReceipt {
  const root = resolve(args.projectRoot);
  const candidate = readJson<{ kind?: string }>(safePath(root, args.planPath));
  if (candidate.kind === "workspace-plan") return applyWorkspacePlan(args);
  return applyFilePlan(args);
}

function applyFilePlan(args: {
  projectRoot: string;
  planPath: string;
  approval: string;
  now?: Date;
}): AppliedChange {
  const root = resolve(args.projectRoot);
  const plan = readJson<ChangePlan>(safePath(root, args.planPath));
  validatePlan(root, plan, args.approval);
  const changeFile = harnessPath(root, `changes/${plan.id}/change.json`);
  if (existsSync(changeFile)) {
    const existing = readJson<AppliedChange>(changeFile);
    if (existing.planHash === plan.planHash && existing.operations.every((item) => fileHash(safePath(root, item.path)) === item.afterHash)) {
      return existing;
    }
    throw new Error(`CHANGE_ID_CONFLICT: ${plan.id} was already applied but repository outputs have drifted`);
  }
  for (const item of plan.operations) assertCurrentHash(safePath(root, item.path), item.beforeHash);

  const originals = plan.operations.map((item) => ({
    item,
    content: item.beforeHash === null ? null : readFileSync(safePath(root, item.path), "utf8"),
  }));
  const written: typeof originals = [];
  try {
    for (const original of originals) {
      const { item, content } = original;
      if (content !== null) {
        atomicWrite(harnessPath(root, `changes/${plan.id}/before/${item.path}`), content);
      }
      atomicWrite(safePath(root, item.path), item.content);
      assertCurrentHash(safePath(root, item.path), item.afterHash);
      written.push(original);
    }
    const verification = checkProject(root);
    if (!verification.ok) {
      const failures = verification.results
        .filter((item) => item.status === "blocked" || item.status === "failing")
        .map((item) => `${item.id}: ${item.detail}`);
      throw new Error(`POST_APPLY_VERIFICATION_FAILED: ${failures.join("; ")}`);
    }
  } catch (error) {
    for (const { item, content } of written.reverse()) {
      const target = safePath(root, item.path);
      if (content === null) rmSync(target, { force: true });
      else atomicWrite(target, content);
    }
    throw error;
  }

  const change: AppliedChange = {
    schemaVersion: "2.0",
    id: plan.id,
    planHash: plan.planHash,
    appliedAt: (args.now ?? new Date()).toISOString(),
    operations: plan.operations.map((item) => ({
      path: item.path,
      beforeHash: item.beforeHash,
      afterHash: item.afterHash,
      backupPath: item.beforeHash === null ? null : `.harness/changes/${plan.id}/before/${item.path}`,
    })),
  };
  atomicWrite(changeFile, prettyJson(change));
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
  const root = resolve(args.projectRoot);
  const id = args.changeId ?? latestChangeId(root);
  const directory = harnessPath(root, `changes/${id}`);
  if (!existsSync(join(directory, "change.json")) && args.changeId) {
    return rollbackWorkspaceChange({
      projectRoot: root,
      changeId: args.changeId,
      now: args.now,
    });
  }
  const marker = join(directory, "rolled-back.json");
  const change = readJson<AppliedChange>(join(directory, "change.json"));
  if (existsSync(marker)) return readJson<{ id: string; restored: string[] }>(marker);
  for (const item of change.operations) assertCurrentHash(safePath(root, item.path), item.afterHash);
  for (const item of [...change.operations].reverse()) {
    const target = safePath(root, item.path);
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
}

interface Manifest {
  schemaVersion: "2.0";
  policyDigest: string;
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

export function checkProject(projectRoot: string): {
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
  const drift = driftProject(root);
  const agentsLoaded = ["AGENTS.md", "CLAUDE.md"].some((path) => {
    const target = join(root, path);
    return existsSync(target) && readFileSync(target, "utf8").includes(digest);
  });
  const naming = {
    typescript: policy.project.stacks.includes("typescript") ? checkTypeScript(root) : null,
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
    const available = support !== "none";
    return {
      stack,
      support,
      available,
      status: available ? "available" : "blocked",
      detail: available
        ? `Harness provides ${support} policy support for '${stack}'.`
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
    stackCoverageComplete: stackAdapters.every((adapter) => adapter.available),
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
  const policy = checkProject(root);
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
    } else if (driftProject(root).sourceDrift.some((path) => approvedEvalPaths.has(path))) {
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
          const audit = auditWorkspace(root);
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
