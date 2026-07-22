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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyPlan,
  createSessionContext,
  discoverAndSave,
  doctorProject,
  driftProject,
  explainPolicy,
  intakeProject,
  planProject,
  researchGitHub,
  rollbackChange,
  runTrustedChecks,
} from "./v2/service.js";
import { SUPPORTED_STACKS, type Stack, type StackProfile } from "./v2/types.js";

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

interface ParsedArguments {
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

function projectRoot(args: ParsedArguments): string {
  return resolve(value(args, "project") ?? process.cwd());
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

function getSkillSource(packagePath: string): string {
  const built = join(packagePath, "dist", "skill");
  return existsSync(built) ? built : join(packagePath, "skill");
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

function installSkill(source: string, agentHome: ".agents" | ".claude" | ".codex"): string {
  const destination = join(homedir(), agentHome, "skills", "harness-automation");
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
  ok(`包路径: ${packagePath}`);

  const mcpServerPath = getMcpServerPath(packagePath);
  if (!existsSync(mcpServerPath)) throw new Error(`MCP_NOT_BUILT: ${mcpServerPath}`);
  if (registerMcpViaCli(mcpServerPath)) ok("Claude Code MCP 已注册");
  else {
    registerMcpViaJson(mcpServerPath);
    ok(`Claude Code MCP 已写入 ${getClaudeJsonPath()}`);
  }

  const skillSource = getSkillSource(packagePath);
  if (!existsSync(join(skillSource, "SKILL.md"))) throw new Error(`SKILL_NOT_FOUND: ${skillSource}`);
  ok(`Claude Code Skill: ${installSkill(skillSource, ".claude")}`);
  ok(`Codex Skill: ${installSkill(skillSource, ".codex")}`);
  ok(`Portable Agent Skill: ${installSkill(skillSource, ".agents")}`);
  console.log("");
  ok("Harness Automation v2 已就绪；未修改 grill-me 或任何其他 Skill");
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
  const invalid = selected.filter((item) => !SUPPORTED_STACKS.includes(item as Stack));
  if (invalid.length > 0) {
    throw new Error(`INVALID_STACK: ${invalid.join(", ")}; choose ${SUPPORTED_STACKS.join(", ")}`);
  }
  return [...new Set(selected)] as Stack[];
}

function usage(): void {
  console.log(`Harness Automation v2

Usage:
  harness-automation install
  harness-automation doctor [--project .]
  harness-automation research github [--project .] [--query "..."]
  harness-automation intake --owner <name> --approve-sources [--project .]
  harness-automation discover [--project .]
  harness-automation plan [--project .] [--profile full-typescript|python-data-ai|go-performance]
  harness-automation plan --profile custom --stack <stack> [--stack <stack>...] [--project .]
  harness-automation apply --plan <relative-path> --approve <sha256> [--project .]
  harness-automation context [--project .]
  harness-automation check [--project .] [--mode session|commit|ci]
  harness-automation drift [--project .]
  harness-automation explain <policy-id> [--project .]
  harness-automation rollback [--project .] [--change <id>]

All workflow commands emit stable JSON. Apply requires the exact hash printed by plan.`);
}

function runWorkflow(argv: string[]): void {
  const command = argv[0];
  const args = parseArguments(argv.slice(1));
  const root = projectRoot(args);
  switch (command) {
    case "doctor":
      printJson(doctorProject(root));
      return;
    case "research":
      if (args.positionals[0] !== "github") throw new Error("RESEARCH_PROVIDER_REQUIRED: only `research github` is available");
      printJson(researchGitHub({ projectRoot: root, queries: args.values.get("query") }));
      return;
    case "intake":
      printJson(intakeProject({ projectRoot: root, owner: required(args, "owner"), approveSources: args.flags.has("approve-sources") }));
      return;
    case "discover":
      printJson(discoverAndSave(root));
      return;
    case "plan": {
      const result = planProject({ projectRoot: root, profile: profile(args), stacks: stacks(args) });
      printJson({ planPath: result.path, planHash: result.plan.planHash, stacks: result.policy.project.stacks, operations: result.plan.operations.map(({ path, beforeHash, afterHash }) => ({ path, beforeHash, afterHash })), commands: result.plan.commands, warnings: result.plan.warnings });
      return;
    }
    case "apply":
      printJson(applyPlan({ projectRoot: root, planPath: required(args, "plan"), approval: required(args, "approve") }));
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
      if (!result.clean) process.exitCode = 2;
      return;
    }
    case "explain":
      printJson(explainPolicy(root, args.positionals[0] ?? required(args, "policy")));
      return;
    case "rollback":
      printJson(rollbackChange({ projectRoot: root, changeId: value(args, "change") }));
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
