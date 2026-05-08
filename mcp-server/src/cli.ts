#!/usr/bin/env node

import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkgRoot = dirname(__dirname);

const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const NC = "\x1b[0m";

function info(msg: string) {
  console.log(`${CYAN}ℹ${NC} ${msg}`);
}
function ok(msg: string) {
  console.log(`${GREEN}✔${NC} ${msg}`);
}
function warn(msg: string) {
  console.log(`${YELLOW}⚠${NC} ${msg}`);
}
function err(msg: string) {
  console.error(`${RED}✘${NC} ${msg}`);
}

function getGlobalPackagePath(): string | null {
  try {
    const root = execSync("npm root -g", { encoding: "utf-8" }).trim();
    const pkgPath = join(root, "@realpkuasule", "harness-automation");
    if (existsSync(pkgPath)) return pkgPath;
    return null;
  } catch {
    return null;
  }
}

function getMcpServerPath(pkgPath: string): string {
  return join(pkgPath, "dist", "index.js");
}

function getSkillSrc(pkgPath: string): string {
  // Try dist/skill.md first (copied during build), then skill/SKILL.md
  const fromDist = join(pkgPath, "dist", "skill.md");
  if (existsSync(fromDist)) return fromDist;
  return join(pkgPath, "skill", "SKILL.md");
}

function getClaudeJsonPath(): string {
  return join(homedir(), ".claude.json");
}

function registerMcpViaCli(mcpServerPath: string): boolean {
  try {
    execSync(
      `claude mcp add --scope user harness-automation node "${mcpServerPath}"`,
      { stdio: "pipe" }
    );
    return true;
  } catch {
    return false;
  }
}

function registerMcpViaJson(mcpServerPath: string): void {
  const configPath = getClaudeJsonPath();
  let config: Record<string, unknown> = {};

  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      config = {};
    }
  }

  if (!config.mcpServers) {
    config.mcpServers = {};
  }

  const servers = config.mcpServers as Record<string, unknown>;
  servers["harness-automation"] = {
    command: "node",
    args: [mcpServerPath],
  };

  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

function main(): void {
  console.log("");
  console.log(
    `${CYAN}╔══════════════════════════════════════════╗${NC}`
  );
  console.log(
    `${CYAN}║   Harness Automation — Installer         ║${NC}`
  );
  console.log(
    `${CYAN}╚══════════════════════════════════════════╝${NC}`
  );
  console.log("");

  // Step 1: Ensure global installation
  info("检查安装状态...");
  let pkgPath = getGlobalPackagePath();

  if (!pkgPath) {
    info("正在全局安装 @realpkuasule/harness-automation ...");
    try {
      execSync("npm install -g @realpkuasule/harness-automation", {
        stdio: "inherit",
      });
      pkgPath = getGlobalPackagePath();
      if (!pkgPath) {
        err("全局安装后仍未找到包路径，请手动运行:");
        err("  npm install -g @realpkuasule/harness-automation");
        process.exit(1);
      }
    } catch {
      warn("全局安装失败，尝试使用当前路径...");
      pkgPath = pkgRoot;
    }
  }

  ok(`包路径: ${pkgPath}`);

  const mcpServerPath = getMcpServerPath(pkgPath);

  if (!existsSync(mcpServerPath)) {
    err(`MCP Server 未找到: ${mcpServerPath}`);
    err("请确认包已正确安装并构建");
    process.exit(1);
  }

  // Step 2: Register MCP server
  info("注册 MCP Server 到 Claude Code ...");

  if (registerMcpViaCli(mcpServerPath)) {
    ok("MCP Server 已通过 claude CLI 注册（作用域: user）");
  } else {
    info("claude CLI 不可用，直接写入配置文件...");
    try {
      registerMcpViaJson(mcpServerPath);
      ok(`MCP Server 已写入 ${getClaudeJsonPath()}`);
    } catch {
      err("写入配置文件失败，请手动运行:");
      err(
        `  claude mcp add --scope user harness-automation node "${mcpServerPath}"`
      );
      process.exit(1);
    }
  }

  // Step 3: Install SKILL.md
  info("安装 Skill ...");
  const skillSrc = getSkillSrc(pkgPath);
  const skillDir = join(homedir(), ".claude", "skills", "harness-automation");
  const skillDest = join(skillDir, "SKILL.md");

  if (!existsSync(skillSrc)) {
    warn(`Skill 文件未找到: ${skillSrc}，跳过 Skill 安装`);
  } else {
    mkdirSync(skillDir, { recursive: true });
    copyFileSync(skillSrc, skillDest);
    ok(`Skill 已安装到 ${skillDest}`);
  }

  // Step 4: Done
  console.log("");
  console.log(
    `${GREEN}╔══════════════════════════════════════════╗${NC}`
  );
  console.log(
    `${GREEN}║  安装完成！                              ║${NC}`
  );
  console.log(
    `${GREEN}╚══════════════════════════════════════════╝${NC}`
  );
  console.log("");
  ok("Harness Automation 已就绪");
  info("重新启动 Claude Code 后，在项目中使用触发短语:");
  console.log('   "给我的项目建立约束体系"');
  console.log('   "初始化约束"');
  console.log('   "检查项目约束"');
  console.log("");
}

main();
