#!/usr/bin/env node

import { execFileSync, execSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyPlan,
  createSessionContext,
  discoverAndSave,
  doctorProject,
  driftProject,
  explainPolicy,
  intakeProject,
  packagedSkillPath,
  planProject,
  planProjectUpdate,
  researchGitHub,
  rollbackChange,
  runTrustedChecks,
} from "./v2/service.js";
import {
  DELIVERY_PROFILES,
  DOMAIN_PROFILES,
  QUALITY_PROFILES,
  normalizeStackIds,
  type DeliveryProfile,
  type DomainProfile,
  type QualityProfile,
  type Stack,
  type StackProfile,
} from "./v2/types.js";
import {
  auditWorkspace,
  integrationCheckWorkspace,
  applyWorkspaceMigration,
  parseWorkspaceAdoptionManifest,
  planWorkspaceAdoption,
  planWorkspaceAllocation,
  planWorkspaceClose,
  planWorkspaceConfiguration,
  planWorkspaceMigration,
  planWorkspaceRebind,
  planWorkspaceRecover,
  planWorkspaceRenew,
  retentionAuditWorkspace,
  reviewAndApplyWorkspacePlan,
  reviewWorkspace,
  workspaceStatus,
} from "./worktree/service.js";
import {
  WORKTREE_DELEGATABLE_OPERATIONS,
  type WorktreeApprovalPolicy,
  type WorktreeDelegatableOperation,
  type WorktreeDeliveryConfig,
  type ReviewReceiptScope,
  type WorkspacePlan,
} from "./worktree/types.js";
import { runSessionCommand } from "./session/cli.js";
import { auditGitHubGovernance } from "./github/governance.js";
import { authorizeDelivery, deliveryStatus, mergeDelivery, pushDelivery, upsertDeliveryPullRequest } from "./delivery/service.js";
import {
  createRecoveryApproval,
  inspectRecoveryState,
  quarantineInvalidEvidence,
  recordRecoveryApproval,
} from "./recovery/service.js";
import { readLkgChain } from "./receipt/service.js";
import { resolveProjectContext } from "./repository/git.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkgRoot = dirname(__dirname);
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const NC = "\x1b[0m";

function info(message: string): void { console.log(`${CYAN}ℹ${NC} ${message}`); }
function ok(message: string): void { console.log(`${GREEN}✔${NC} ${message}`); }
function warn(message: string): void { console.log(`${YELLOW}⚠${NC} ${message}`); }
function fail(message: string): void { console.error(`${RED}✘${NC} ${message}`); }

export interface ParsedArguments {
  positionals: string[];
  values: Map<string, string[]>;
  flags: Set<string>;
}

function parseArguments(argv: string[]): ParsedArguments {
  const parsed: ParsedArguments = { positionals: [], values: new Map(), flags: new Set() };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      parsed.positionals.push(value);
      continue;
    }
    const name = value.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      parsed.values.set(name, [...(parsed.values.get(name) ?? []), next]);
      index += 1;
    } else {
      parsed.flags.add(name);
    }
  }
  return parsed;
}

function value(args: ParsedArguments, name: string): string | undefined {
  return args.values.get(name)?.at(-1);
}

function required(args: ParsedArguments, name: string): string {
  const result = value(args, name);
  if (!result) throw new Error(`ARGUMENT_REQUIRED: --${name}`);
  return result;
}

function booleanOption(args: ParsedArguments, name: string): boolean | undefined {
  if (args.flags.has(name)) return true;
  const selected = value(args, name);
  if (selected === undefined) return undefined;
  if (selected === "true") return true;
  if (selected === "false") return false;
  throw new Error(`INVALID_BOOLEAN: --${name} must be true or false`);
}

function projectRoot(args: ParsedArguments): string {
  return resolve(value(args, "project") ?? process.cwd());
}

function reviewReceiptScope(args: ParsedArguments): ReviewReceiptScope {
  if (args.flags.has("receipt-scope")) throw new Error("ARGUMENT_REQUIRED: --receipt-scope");
  const selected = value(args, "receipt-scope") ?? "host-global";
  if (selected !== "host-global" && selected !== "project") {
    throw new Error("RECEIPT_SCOPE_INVALID: --receipt-scope must be host-global or project");
  }
  return selected;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function getGlobalPackagePath(): string | null {
  try {
    const root = execSync("npm root -g", { encoding: "utf8" }).trim();
    const packagePath = join(root, "@realpkuasule", "harness-automation");
    return existsSync(packagePath) ? packagePath : null;
  } catch {
    return null;
  }
}

function getMcpServerPath(packagePath: string): string {
  return join(packagePath, "dist", "index.js");
}

function getPackageVersion(packagePath: string): string {
  const manifest = JSON.parse(readFileSync(join(packagePath, "package.json"), "utf8")) as { version?: unknown };
  if (typeof manifest.version !== "string") throw new Error(`PACKAGE_VERSION_NOT_FOUND: ${packagePath}`);
  return manifest.version;
}

function getClaudeJsonPath(): string {
  return join(homedir(), ".claude.json");
}

function registerMcpViaCli(mcpServerPath: string): boolean {
  try {
    execFileSync("claude", ["mcp", "add", "--scope", "user", "harness-automation", "node", mcpServerPath], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function registerMcpViaJson(mcpServerPath: string): void {
  const configPath = getClaudeJsonPath();
  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try { config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>; } catch { config = {}; }
  }
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  servers["harness-automation"] = { command: "node", args: [mcpServerPath] };
  config.mcpServers = servers;
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function installSkill(
  source: string,
  agentHome: ".agents" | ".claude" | ".codex",
  name: "harness-automation" | "manage-worktree-delivery",
): string {
  const destination = join(homedir(), agentHome, "skills", name);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true, force: true });
  return destination;
}

function install(options: { syncGlobal: boolean }): void {
  console.log(`\n${CYAN}Harness Automation — Installer${NC}\n`);
  info("检查安装状态...");
  const localBuilt = existsSync(getMcpServerPath(pkgRoot));
  let globalPackagePath = getGlobalPackagePath();
  if (options.syncGlobal && localBuilt && resolve(globalPackagePath ?? "") !== resolve(pkgRoot)) {
    info("同步当前构建到全局 CLI ...");
    execFileSync("npm", ["install", "-g", pkgRoot], { stdio: "inherit" });
    globalPackagePath = getGlobalPackagePath();
  }
  let packagePath = localBuilt && !options.syncGlobal ? pkgRoot : globalPackagePath ?? (localBuilt ? pkgRoot : null);
  if (!packagePath) {
    info("正在全局安装 @realpkuasule/harness-automation ...");
    try {
      execFileSync("npm", ["install", "-g", "@realpkuasule/harness-automation"], { stdio: "inherit" });
      packagePath = getGlobalPackagePath();
    } catch {
      warn("全局安装失败，使用当前包路径");
      packagePath = pkgRoot;
    }
  }
  if (!packagePath) throw new Error("PACKAGE_NOT_FOUND: npm global installation did not produce a package path");
  const packageVersion = getPackageVersion(packagePath);
  ok(`包路径: ${packagePath}`);
  ok(`版本: ${packageVersion}`);

  const mcpServerPath = getMcpServerPath(packagePath);
  if (!existsSync(mcpServerPath)) throw new Error(`MCP_NOT_BUILT: ${mcpServerPath}`);
  if (registerMcpViaCli(mcpServerPath)) ok("Claude Code MCP 已注册");
  else {
    registerMcpViaJson(mcpServerPath);
    ok(`Claude Code MCP 已写入 ${getClaudeJsonPath()}`);
  }

  for (const name of ["harness-automation", "manage-worktree-delivery"] as const) {
    const skillSource = packagedSkillPath(packagePath, name);
    if (!existsSync(join(skillSource, "SKILL.md"))) {
      throw new Error(`SKILL_NOT_FOUND: ${skillSource}`);
    }
    ok(`Claude Code Skill (${name}): ${installSkill(skillSource, ".claude", name)}`);
    ok(`Codex Skill (${name}): ${installSkill(skillSource, ".codex", name)}`);
    ok(`Portable Agent Skill (${name}): ${installSkill(skillSource, ".agents", name)}`);
  }
  console.log("");
  ok(`Harness Automation v${packageVersion} 已就绪；未修改 grill-me 或任何其他 Skill`);
}

function profile(args: ParsedArguments): StackProfile | undefined {
  const selected = value(args, "profile");
  if (!selected) return undefined;
  const profiles: StackProfile[] = ["full-typescript", "python-data-ai", "go-performance", "custom"];
  if (!profiles.includes(selected as StackProfile)) {
    throw new Error(`INVALID_PROFILE: choose ${profiles.join(", ")}`);
  }
  return selected as StackProfile;
}

function stacks(args: ParsedArguments): Stack[] | undefined {
  const selected = args.values.get("stack");
  if (!selected) return undefined;
  return normalizeStackIds(selected);
}

function selectedProfiles<T extends string>(
  args: ParsedArguments,
  name: string,
  supported: readonly T[],
): T[] | undefined {
  const values = args.values.get(name);
  if (!values) return undefined;
  const selected = [...new Set(values)];
  const invalid = selected.filter((profile) => !supported.includes(profile as T));
  if (invalid.length > 0) {
    throw new Error(`INVALID_${name.replaceAll("-", "_").toUpperCase()}: ${invalid.join(", ")}`);
  }
  return selected as T[];
}

function positiveInteger(args: ParsedArguments, name: string): number | undefined {
  const selected = value(args, name);
  if (selected === undefined) return undefined;
  const number = Number(selected);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`INVALID_INTEGER: --${name} must be a positive integer`);
  }
  return number;
}

function worktreeProvider(args: ParsedArguments): WorktreeDeliveryConfig["provider"] | undefined {
  const selected = value(args, "provider");
  if (!selected) return undefined;
  if (!["none", "github", "gitlab", "jira"].includes(selected)) {
    throw new Error("INVALID_PROVIDER: choose none, github, gitlab, or jira");
  }
  if (selected === "none") return { kind: "none" };
  const projectNumber = positiveInteger(args, "project-number");
  const project = projectNumber === undefined
    ? undefined
    : {
        owner: required(args, "project-owner"),
        number: projectNumber,
        statusField: value(args, "status-field") ?? "Status",
        doneValues: args.values.get("done-value") ?? ["Done"],
      };
  return {
    kind: selected as "github" | "gitlab" | "jira",
    repository: required(args, "provider-repository"),
    project,
  };
}

function printWorkspacePlan(result: ReturnType<typeof planWorkspaceConfiguration>): void {
  printJson({
    planPath: result.path,
    planHash: result.plan.planHash,
    operation: result.plan.operation.kind,
    summary: workspacePlanSummary(result.plan),
    warnings: result.plan.warnings,
  });
}

function workspacePlanSummary(plan: WorkspacePlan): {
  goal: string;
  changes: string[];
  preserves: string[];
  risk: "low" | "medium" | "high";
} {
  const operation = plan.operation;
  const preserves = ["main", "remote refs", "other worktrees"];
  if (operation.kind === "allocate") return {
    goal: `Create an isolated workspace for ${operation.lease.workItem}`,
    changes: [`local branch ${operation.lease.branch}`, `worktree ${operation.lease.path}`, "one lease"],
    preserves,
    risk: "low",
  };
  if (operation.kind === "renew") return {
    goal: `Renew the lease heartbeat for ${operation.lease.workItem}`,
    changes: ["heartbeatAt only"],
    preserves: [...preserves, "worktree HEAD and content"],
    risk: "low",
  };
  if (operation.kind === "rebind") return {
    goal: `Bind ${operation.lease.workItem} to its observed branch`,
    changes: [`lease branch ${operation.lease.branch} -> ${operation.replacementLease.branch}`],
    preserves: [...preserves, "worktree HEAD and content"],
    risk: "medium",
  };
  if (operation.kind === "adopt") return {
    goal: `Govern ${operation.items.length} existing worktree(s)`,
    changes: [`${operation.items.length} lease(s)`],
    preserves: [...preserves, "existing worktree content"],
    risk: "medium",
  };
  if (operation.kind === "close") return {
    goal: `Close the workspace for ${operation.lease.workItem}`,
    changes: [`remove worktree ${operation.lease.path}`, "remove its lease"],
    preserves: [...preserves, `local branch ${operation.lease.branch}`],
    risk: "high",
  };
  if (operation.kind === "recover") return {
    goal: "Remove one clean detached unleased worktree",
    changes: [`remove worktree ${operation.path}`],
    preserves,
    risk: "high",
  };
  if (operation.kind === "migrate") return {
    goal: "Prepare a manual migration from a legacy flat layout",
    changes: ["plan-only; only explicit worktree migrate apply may execute it"],
    preserves: ["all checkouts", "branches", "leases", "Git state"],
    risk: "high",
  };
  return {
    goal: "Configure worktree governance and this host binding",
    changes: [operation.configPath, operation.hostBindingPath],
    preserves,
    risk: "high",
  };
}

function worktreeApproval(args: ParsedArguments): WorktreeApprovalPolicy | undefined {
  const mode = value(args, "approval-mode");
  if (mode === undefined) return undefined;
  if (mode === "manual") return { mode: "manual" };
  if (mode !== "delegated-ai") {
    throw new Error("INVALID_WORKTREE_APPROVAL_MODE: choose manual or delegated-ai");
  }
  const operations = args.values.get("delegate-operation") ?? ["allocate", "renew"];
  if (operations.some((operation) =>
    !(WORKTREE_DELEGATABLE_OPERATIONS as readonly string[]).includes(operation))) {
    throw new Error(`INVALID_WORKTREE_DELEGATED_OPERATION: choose ${WORKTREE_DELEGATABLE_OPERATIONS.join(", ")}`);
  }
  return {
    mode: "delegated-ai",
    reviewer: { kind: "claude", model: required(args, "reviewer-model") },
    allowedOperations: operations as WorktreeDelegatableOperation[],
    planTtlSeconds: positiveInteger(args, "plan-ttl-seconds") ?? 600,
    reviewerTimeoutSeconds: positiveInteger(args, "reviewer-timeout-seconds") ?? 120,
  };
}

function adoptionManifest(root: string, args: ParsedArguments) {
  const selected = args.values.get("manifest") ?? [];
  if (selected.length !== 1) {
    throw new Error("WORKTREE_ADOPT_INPUT_INVALID: pass exactly one --manifest");
  }
  try {
    const path = resolve(root, selected[0]);
    return parseWorkspaceAdoptionManifest(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("WORKTREE_ADOPT_")) throw error;
    throw new Error(`WORKTREE_ADOPT_INPUT_INVALID: ${message}`);
  }
}

function runWorktreeCommand(
  root: string,
  args: ParsedArguments,
  trailingCommand: string[],
): void {
  const action = args.positionals[0];
  switch (action) {
    case "status":
      printJson(workspaceStatus(root));
      return;
    case "audit": {
      const audit = auditWorkspace(root);
      printJson(audit);
      if (!audit.passing) process.exitCode = 2;
      return;
    }
    case "configure": {
      const selectedMode = value(args, "mode");
      if (selectedMode !== undefined && selectedMode !== "audit-only" && selectedMode !== "enforced") {
        throw new Error("INVALID_WORKTREE_MODE: choose audit-only or enforced");
      }
      printWorkspacePlan(planWorkspaceConfiguration({
        projectRoot: root,
        mode: selectedMode,
        managementBranch: value(args, "management-branch"),
        maxPersistentWorktrees: positiveInteger(args, "max-persistent"),
        leaseTtlHours: positiveInteger(args, "lease-ttl-hours"),
        reviewTtlMinutes: positiveInteger(args, "review-ttl-minutes"),
        remoteBranchRetentionDays: positiveInteger(args, "remote-retention-days"),
        remoteBranchDeletion: booleanOption(args, "remote-branch-deletion"),
        allowedRoots: args.values.get("allow-root"),
        protectedRoots: args.values.get("protect-root"),
        topology: value(args, "topology") as "container-v1" | undefined,
        workspaceContainer: value(args, "workspace-container"),
        approval: worktreeApproval(args),
        provider: worktreeProvider(args),
      }));
      return;
    }
    case "migrate":
      if (args.positionals[1] === "apply") {
        printJson(applyWorkspaceMigration({
          projectRoot: root,
          planPath: required(args, "plan"),
          approval: required(args, "approve"),
          recoveryApprovalRef: value(args, "recovery-approval"),
        }));
        return;
      }
      printWorkspacePlan(planWorkspaceMigration({
        projectRoot: root,
        workspaceContainer: required(args, "workspace-container"),
      }));
      return;
    case "allocate":
      printWorkspacePlan(planWorkspaceAllocation({
        projectRoot: root,
        workItem: required(args, "work-item"),
        branch: required(args, "branch"),
        path: value(args, "path"),
        owner: required(args, "owner"),
        thread: value(args, "thread"),
        startPoint: value(args, "start-point"),
      }));
      return;
    case "adopt": {
      const manifest = adoptionManifest(root, args);
      printWorkspacePlan(planWorkspaceAdoption({
        projectRoot: root,
        items: manifest.items,
      }));
      return;
    }
    case "close":
      printWorkspacePlan(planWorkspaceClose({
        projectRoot: root,
        workItem: required(args, "work-item"),
        acceptedCommit: required(args, "accepted-commit"),
      }));
      return;
    case "rebind":
      printWorkspacePlan(planWorkspaceRebind({
        projectRoot: root,
        workItem: required(args, "work-item"),
        branch: required(args, "branch"),
      }));
      return;
    case "renew":
      printWorkspacePlan(planWorkspaceRenew({
        projectRoot: root,
        workItem: required(args, "work-item"),
      }));
      return;
    case "recover":
      printWorkspacePlan(planWorkspaceRecover({
        projectRoot: root,
        path: required(args, "path"),
      }));
      return;
    case "apply-ai": {
      const result = reviewAndApplyWorkspacePlan({
        projectRoot: root,
        planPath: required(args, "plan"),
        intent: required(args, "intent"),
      });
      printJson(result);
      if (!result.receipt) process.exitCode = 2;
      return;
    }
    case "review": {
      const receipt = reviewWorkspace({
        projectRoot: root,
        commit: value(args, "commit") ?? "HEAD",
        command: trailingCommand,
      });
      printJson(receipt);
      if (receipt.status !== "cleaned" || receipt.exitCode !== 0) process.exitCode = 2;
      return;
    }
    case "retention-audit": {
      const audit = retentionAuditWorkspace({
        projectRoot: root,
        receiptScope: reviewReceiptScope(args),
      });
      printJson(audit);
      if (audit.staleReviews.length > 0 || audit.staleLeases.length > 0 || audit.staleLocks.length > 0 || audit.errors.length > 0) {
        process.exitCode = 2;
      }
      return;
    }
    case "integration-check": {
      const check = integrationCheckWorkspace({
        projectRoot: root,
        workItem: required(args, "work-item"),
        target: value(args, "target"),
      });
      printJson(check);
      if (!check.passing) process.exitCode = 2;
      return;
    }
    default:
      throw new Error(
        "WORKTREE_COMMAND_REQUIRED: choose configure, migrate, allocate, adopt, rebind, renew, recover, apply-ai, review, status, audit, close, retention-audit, or integration-check",
      );
  }
}

function runDeliveryCommand(root: string, args: ParsedArguments): void {
  const action = args.positionals[0];
  switch (action) {
    case "authorize": {
      const mergeMode = value(args, "merge-mode") ?? "manual";
      if (mergeMode !== "manual" && mergeMode !== "checks-green") {
        throw new Error("DELIVERY_MERGE_MODE_INVALID: choose manual or checks-green");
      }
      const result = authorizeDelivery({
        projectRoot: root,
        workItem: required(args, "work-item"),
        repository: value(args, "repository"),
        remote: value(args, "remote"),
        baseBranch: required(args, "base"),
        featureBranch: value(args, "branch"),
        allowedPaths: args.values.get("allow-path") ?? [],
        intent: required(args, "intent"),
        approvalSource: required(args, "approval-source"),
        supersedes: value(args, "supersedes"),
        retryLimit: positiveInteger(args, "retry-limit"),
        capabilities: { mergeMode },
      });
      printJson({ authorizationPath: result.path, authorization: result.authorization });
      return;
    }
    case "status":
      printJson(deliveryStatus(root, required(args, "authorization")));
      return;
    case "push":
      printJson(pushDelivery({ projectRoot: root, authorizationHash: required(args, "authorization") }));
      return;
    case "pr":
      printJson(upsertDeliveryPullRequest({
        projectRoot: root,
        authorizationHash: required(args, "authorization"),
        title: required(args, "title"),
        body: value(args, "body"),
      }));
      return;
    case "merge":
      printJson(mergeDelivery({
        projectRoot: root,
        authorizationHash: required(args, "authorization"),
        pullRequest: Number(required(args, "pull-request")),
      }));
      return;
    default:
      throw new Error("DELIVERY_COMMAND_REQUIRED: choose delivery authorize, delivery status, delivery push, delivery pr, or delivery merge");
  }
}

function usage(): void {
  console.log(`Harness Automation v2

Usage:
  harness-automation install
  harness-automation doctor [--project .]
  harness-automation research github [--project .] [--query "..."]
  harness-automation intake --owner <name> --approve-sources [--approve-typescript-naming-adoption] [--approve-weakening <sha256> --weakening-rule <id>...] [--project .]
  harness-automation discover [--project .]
  harness-automation plan [--project .] [--profile full-typescript|python-data-ai|go-performance]
  harness-automation plan --profile custom --stack <stack> [--stack <stack>...] [--project .]
  harness-automation plan [--delivery-profile worktree-delivery] [--domain-profile game-development] [--project .]
  harness-automation plan [--quality-profile eval-driven-development] [--adopt-typescript-naming] [--project .]
  harness-automation update plan --project <absolute-path> [--adopt-typescript-naming]
  harness-automation update legacy-eval-snapshot plan --project <absolute-path>
  harness-automation apply --plan <relative-path> --approve <sha256> [--recovery-approval <recovery-id>] [--project .]
  harness-automation context [--project .]
  harness-automation check [--project .] [--mode session|commit|ci]
  harness-automation drift [--project .]
  harness-automation explain <policy-id> [--project .]
  harness-automation rollback [--project .] [--change <id>] [--recovery-approval <recovery-id>]
  harness-automation recovery status [--project .]
  harness-automation recovery approve --id <finding-id> --approved-by <person> --expires-at <ISO-8601> [--project .]
  harness-automation recovery quarantine --id <finding-id> --approval <approval-id> [--project .]
  harness-automation lkg [--project .]
  harness-automation worktree status|audit [--project .]
  harness-automation worktree retention-audit [--receipt-scope host-global|project] [--project .]
  harness-automation worktree integration-check --work-item <provider:id> [--target <local-ref>] [--project .]
  harness-automation github audit --project <absolute-repository> [--organization <github-organization>]
  harness-automation worktree configure [--mode audit-only|enforced] [--management-branch <branch>] [--topology container-v1 --workspace-container <absolute-path>] [--allow-root <absolute-path>] [--approval-mode manual] [--project .]
  harness-automation worktree migrate --workspace-container <absolute-path> [--project .]
  harness-automation worktree migrate apply --plan <relative-plan-path> --approve <sha256> [--recovery-approval <recovery-id>] [--project .]
  harness-automation worktree allocate --work-item <provider:id> --branch <name> [--path <absolute-path>] --owner <name> [--project .]
  harness-automation worktree adopt --manifest <json-path> [--project .]
  harness-automation worktree review [--commit <sha>] [--project .] -- <command> [args...]
  harness-automation worktree close --work-item <provider:id> --accepted-commit <sha> [--project .]
  harness-automation worktree renew --work-item <provider:id> [--project .]
  harness-automation worktree recover --path <absolute-path> [--project .]
  harness-automation worktree apply-ai --plan <relative-path> --intent <plain-language intent> [--project .]  # legacy bindings return ReviewPending until DG-02
  harness-automation delivery authorize --work-item <github:owner/repo#issue> --base <branch> --allow-path <path-or-directory/> [--allow-path <path-or-directory/>...] --intent <approved-intent> --approval-source <immutable-user-authorization-reference> [--branch <branch>] [--repository <owner/repo>] [--remote <name>] [--merge-mode manual|checks-green] [--retry-limit <n>] [--supersedes <authorization-hash>] [--project .]
  harness-automation delivery status --authorization <sha256> [--project .]
  harness-automation delivery push --authorization <sha256> [--project .]
  harness-automation delivery pr --authorization <sha256> --title <title> [--body <body>] [--project .]
  harness-automation delivery merge --authorization <sha256> --pull-request <number> [--project .]
  harness-automation session handoff --work-item <provider:repo#issue> --session <session-id> [--to-status in-progress|ready-for-review] [--dry-run] [--project .]
  harness-automation session status [--work-item <provider:repo#issue>] [--project .]
  harness-automation session seed --work-item <provider:repo#issue> [--project .]

All workflow commands emit stable JSON. Apply requires the exact hash printed by plan.
Custom stack identifiers use lowercase kebab-case. Unknown stacks retain generic policies and report stack-specific enforcement as blocked.`);
}

function runRecoveryCommand(root: string, args: ParsedArguments): void {
  const context = resolveProjectContext(root);
  const action = args.positionals[0];
  if (action === "status") {
    printJson({ findings: inspectRecoveryState(context) });
    return;
  }
  if (action === "approve") {
    const id = required(args, "id");
    const finding = inspectRecoveryState(context).find((item) => item.id === id);
    if (!finding) throw new Error(`RECOVERY_FINDING_NOT_FOUND: ${id}`);
    const expiresAt = required(args, "expires-at");
    if (!Number.isFinite(Date.parse(expiresAt))) throw new Error("RECOVERY_APPROVAL_EXPIRY_INVALID");
    const approval = createRecoveryApproval({
      context,
      finding,
      approvedBy: required(args, "approved-by"),
      approvedAt: new Date().toISOString(),
      expiresAt,
    });
    printJson({ approval, path: recordRecoveryApproval(context, approval) });
    return;
  }
  if (action === "quarantine") {
    printJson({ path: quarantineInvalidEvidence(context, required(args, "approval"), required(args, "id")) });
    return;
  }
  throw new Error("RECOVERY_COMMAND_REQUIRED: choose recovery status, recovery approve, or recovery quarantine");
}

function printLkg(root: string): void {
  const context = resolveProjectContext(root);
  const stateDirectory = context.repository ? "harness" : ".harness";
  const receiptRoot = context.repository ? context.commonDir : context.projectDir;
  printJson({
    records: ["file-apply", "file-rollback", "workspace"].flatMap((domain) =>
      readLkgChain({ root: receiptRoot, stateDirectory, domain }).map((record) => ({ ...record, domain }))),
  });
}

function runWorkflow(argv: string[]): void {
  const separator = argv.indexOf("--");
  const workflowArguments = separator === -1 ? argv : argv.slice(0, separator);
  const trailingCommand = separator === -1 ? [] : argv.slice(separator + 1);
  const command = workflowArguments[0];
  const args = parseArguments(workflowArguments.slice(1));
  const root = projectRoot(args);
  switch (command) {
    case "doctor":
      printJson(doctorProject(root, { packagePath: pkgRoot }));
      return;
    case "research":
      if (args.positionals[0] !== "github") throw new Error("RESEARCH_PROVIDER_REQUIRED: only `research github` is available");
      printJson(researchGitHub({ projectRoot: root, queries: args.values.get("query") }));
      return;
    case "intake":
      printJson(intakeProject({
        projectRoot: root,
        owner: required(args, "owner"),
        approveSources: args.flags.has("approve-sources"),
        approveTypeScriptNamingAdoption: args.flags.has("approve-typescript-naming-adoption"),
        approveWeakening: value(args, "approve-weakening"),
        weakeningRuleIds: args.values.get("weakening-rule"),
      }));
      return;
    case "discover":
      printJson(discoverAndSave(root));
      return;
    case "plan": {
      if (["upgrade", "update"].some((name) => args.flags.has(name) || args.values.has(name))) {
        throw new Error("UPDATE_INTERFACE_INVALID: use `harness-automation update plan --project <absolute-path>`");
      }
      const result = planProject({
        projectRoot: root,
        profile: profile(args),
        stacks: stacks(args),
        deliveryProfiles: selectedProfiles<DeliveryProfile>(
          args,
          "delivery-profile",
          DELIVERY_PROFILES,
        ),
        domainProfiles: selectedProfiles<DomainProfile>(
          args,
          "domain-profile",
          DOMAIN_PROFILES,
        ),
        qualityProfiles: selectedProfiles<QualityProfile>(
          args,
          "quality-profile",
          QUALITY_PROFILES,
        ),
        adoptTypeScriptNaming: args.flags.has("adopt-typescript-naming"),
      });
      printJson({ planPath: result.path, planHash: result.plan.planHash, stacks: result.policy.project.stacks, qualityProfiles: result.policy.project.qualityProfiles ?? [], operations: result.plan.operations.map(({ path, beforeHash, afterHash }) => ({ path, beforeHash, afterHash })), commands: result.plan.commands, warnings: result.plan.warnings });
      return;
    }
    case "upgrade":
      throw new Error("UPDATE_INTERFACE_INVALID: use `harness-automation update plan --project <absolute-path>`");
    case "update": {
      const legacyEvalSnapshotMigration = args.positionals[0] === "legacy-eval-snapshot" && args.positionals[1] === "plan";
      if (!legacyEvalSnapshotMigration && args.positionals[0] !== "plan") {
        throw new Error("UPDATE_COMMAND_REQUIRED: use `update plan` or `update legacy-eval-snapshot plan`");
      }
      const replacementOptions = ["profile", "stack", "delivery-profile", "domain-profile", "quality-profile"]
        .filter((name) => args.flags.has(name) || args.values.has(name));
      if (replacementOptions.length > 0) {
        throw new Error(`UPDATE_CONFIG_INHERITED: remove ${replacementOptions.map((name) => `--${name}`).join(", ")}; update inherits applied project configuration`);
      }
      if (legacyEvalSnapshotMigration && args.flags.has("adopt-typescript-naming")) {
        throw new Error("LEGACY_EVAL_SNAPSHOT_MIGRATION_FOCUSED: run TypeScript naming adoption in a separate update plan");
      }
      const requestedProject = value(args, "project");
      if (!requestedProject || !isAbsolute(requestedProject)) {
        throw new Error("UPDATE_PROJECT_ABSOLUTE_REQUIRED: --project must be an absolute path");
      }
      const result = planProjectUpdate({
        projectRoot: root,
        adoptTypeScriptNaming: args.flags.has("adopt-typescript-naming"),
        migrateLegacyEvalSnapshot: legacyEvalSnapshotMigration,
      });
      printJson({
        status: result.status,
        planPath: result.planPath,
        planHash: result.planHash,
        compiler: result.plan?.update
          ? { from: result.plan.update.from, to: result.plan.update.to }
          : { from: result.policy.compiler ?? null, to: result.policy.compiler ?? null },
        rules: result.plan?.update?.rules ?? { added: [], removed: [], changed: [] },
        evaluations: result.plan?.update?.evaluations ?? { added: [], removed: [], changed: [] },
        adapterCoverage: result.plan?.update?.adapterCoverage ?? null,
        baseline: result.plan?.update?.baseline ?? null,
        targets: result.plan?.update?.targets ?? [],
        drift: result.plan?.update?.drift ?? null,
        weakening: result.plan?.update?.weakening ?? null,
        legacyEvalSnapshotMigration: result.plan?.legacyEvalSnapshotMigration ?? null,
        worktree: result.worktree,
        migrationRequired: result.worktree.status === "migration-required",
        warnings: result.plan?.warnings ?? [],
      });
      return;
    }
    case "apply":
      printJson(applyPlan({
        projectRoot: root,
        planPath: required(args, "plan"),
        approval: required(args, "approve"),
        recoveryApprovalRef: value(args, "recovery-approval"),
      }));
      return;
    case "context":
      {
        const requested = value(args, "agent") ?? "auto";
        if (!["auto", "portable", "claude-code", "codex"].includes(requested)) throw new Error("INVALID_AGENT: choose auto, portable, claude-code, or codex");
        printJson(createSessionContext(root, undefined, requested as "auto" | "portable" | "claude-code" | "codex"));
      }
      return;
    case "check": {
      const mode = value(args, "mode") ?? "session";
      if (!["session", "commit", "ci"].includes(mode)) throw new Error("INVALID_MODE: choose session, commit, or ci");
      const result = runTrustedChecks({ projectRoot: root, mode: mode as "session" | "commit" | "ci" });
      printJson(result);
      if (!result.ok) process.exitCode = 2;
      return;
    }
    case "drift": {
      const result = driftProject(root);
      printJson(result);
      if (!result.clean || !result.workspaceClean) process.exitCode = 2;
      return;
    }
    case "explain":
      printJson(explainPolicy(root, args.positionals[0] ?? required(args, "policy")));
      return;
    case "rollback":
      printJson(rollbackChange({
        projectRoot: root,
        changeId: value(args, "change"),
        recoveryApprovalRef: value(args, "recovery-approval"),
      }));
      return;
    case "recovery":
      runRecoveryCommand(root, args);
      return;
    case "lkg":
      printLkg(root);
      return;
    case "worktree":
      runWorktreeCommand(root, args, trailingCommand);
      return;
    case "delivery":
      runDeliveryCommand(root, args);
      return;
    case "github": {
      if (args.positionals[0] !== "audit") throw new Error("GITHUB_COMMAND_REQUIRED: choose audit");
      const report = auditGitHubGovernance({ projectRoot: root, organization: value(args, "organization") });
      printJson(report);
      if (report.status === "blocked") process.exitCode = 2;
      return;
    }
    case "session":
      runSessionCommand(root, args);
      return;
    case "help":
    case "--help":
    case "-h":
      usage();
      return;
    default:
      throw new Error(`UNKNOWN_COMMAND: ${command ?? ""}. Run harness-automation help.`);
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  try {
    if (argv.length === 0 || argv[0] === "install") install({ syncGlobal: !argv.includes("--no-global") });
    else runWorkflow(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (argv.length === 0 || argv[0] === "install") fail(message);
    else console.error(JSON.stringify({ ok: false, error: message }, null, 2));
    process.exitCode = 1;
  }
}

main();
