#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# Harness Automation — Install Script
# ============================================================
# Installs @realpkuasule/harness-automation as a Claude Code MCP server.
# Can be run from the target project directory or with --dir <path>.
#
# Usage:
#   ./skill/install.sh                      # run from target project dir
#   ./skill/install.sh --dir /path/to/project
#   HARNESS_PATH=/opt/harness ./skill/install.sh --dir /path/to/project
# ============================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}ℹ${NC} $1"; }
ok()    { echo -e "${GREEN}✔${NC} $1"; }
warn()  { echo -e "${YELLOW}⚠${NC} $1"; }
err()   { echo -e "${RED}✘${NC} $1"; }

# --- Parse args ---
TARGET_DIR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) TARGET_DIR="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: install.sh [--dir /path/to/project]"
      echo ""
      echo "Installs @realpkuasule/harness-automation as a Claude Code MCP server."
      echo "If --dir is omitted, uses the current working directory."
      exit 0
      ;;
    *) err "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ -z "$TARGET_DIR" ]]; then
  TARGET_DIR="$(pwd)"
fi

HARNESS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HARNESS_ROOT="${HARNESS_PATH:-$HARNESS_ROOT}"

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║   Harness Automation — Installer         ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}"
echo ""

# --- Step 1: Check target directory ---
info "检查目标目录: $TARGET_DIR"
if [[ ! -d "$TARGET_DIR" ]]; then
  err "目录不存在: $TARGET_DIR"
  exit 1
fi
cd "$TARGET_DIR"

# --- Step 2: Check Git repository ---
info "检查 Git 仓库..."
if ! git rev-parse --is-inside-work-tree &>/dev/null; then
  warn "目标目录不是一个 Git 仓库"
  warn "Harness 依赖 Git 进行版本控制。是否继续？（y/N）"
  read -r response
  if [[ ! "$response" =~ ^[Yy]$ ]]; then
    info "安装已取消"
    exit 0
  fi
else
  ok "Git 仓库已检测到"
fi

# --- Step 3: Check dist ---
info "检查构建产物..."
HARNESS_MCP="$HARNESS_ROOT/mcp-server/dist/index.js"
if [[ ! -f "$HARNESS_MCP" ]]; then
  err "未找到构建产物: $HARNESS_MCP"
  err "请先运行: cd $HARNESS_ROOT/mcp-server && npm run build"
  exit 1
fi
ok "构建产物已找到: $HARNESS_MCP"

# --- Step 4: Register MCP server via claude CLI ---
info "注册 MCP server..."
if command -v claude &>/dev/null; then
  if claude mcp add --scope user harness-automation node "$HARNESS_MCP" 2>/dev/null; then
    ok "MCP server 已通过 claude CLI 注册（作用域: user）"
  else
    warn "claude mcp add 失败，尝试直接写入配置文件..."
    goto_fallback=true
  fi
else
  info "未找到 claude 命令，直接写入配置文件..."
  goto_fallback=true
fi

if [[ "${goto_fallback:-false}" == "true" ]]; then
  # Fallback: write ~/.claude.json directly
  CLAUDE_JSON="$HOME/.claude.json"
  python3 -c "
import json, sys

MCP_NAME = 'harness-automation'
MCP_CMD = 'node'
MCP_ARGS = ['$HARNESS_MCP']

try:
    with open('$CLAUDE_JSON') as f:
        config = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    config = {}

if 'mcpServers' not in config:
    config['mcpServers'] = {}
config['mcpServers'][MCP_NAME] = {
    'command': MCP_CMD,
    'args': MCP_ARGS
}

with open('$CLAUDE_JSON', 'w') as f:
    json.dump(config, f, indent=2, ensure_ascii=False)

print('ok')
  " 2>/dev/null && ok "MCP server 已写入 ~/.claude.json" || {
    err "写入失败，请手动运行:"
    err "  claude mcp add --scope user harness-automation node $HARNESS_MCP"
  }
fi

# --- Step 5: Install SKILL.md ---
info "安装 Harness Automation Skill..."
SKILL_DIR="$HOME/.claude/skills/harness-automation"
mkdir -p "$SKILL_DIR"
if [[ -f "$HARNESS_ROOT/skill/SKILL.md" ]]; then
  cp "$HARNESS_ROOT/skill/SKILL.md" "$SKILL_DIR/SKILL.md"
  ok "Skill 已安装到 $SKILL_DIR"
else
  warn "未找到 skill/SKILL.md，跳过 Skill 安装"
fi

# --- Step 6: Copy rules.json to .harness/ ---
info "复制规则数据库..."
HARNESS_DATA_DIR="$TARGET_DIR/.harness"
mkdir -p "$HARNESS_DATA_DIR"
RULES_SRC="$(dirname "$HARNESS_MCP")/rules.json"
if [[ -f "$RULES_SRC" ]]; then
  cp "$RULES_SRC" "$HARNESS_DATA_DIR/rules.json"
  ok "规则数据库已复制到 .harness/rules.json"
fi

# --- Done ---
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  安装完成！                              ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════╝${NC}"
echo ""
ok "Harness Automation 已就绪"
echo "   MCP 配置: ~/.claude.json（或 ~/.claude/mcp.json）"
echo "   Skill: $SKILL_DIR/SKILL.md"
echo "   规则: $HARNESS_DATA_DIR/rules.json"
echo ""
info "重新启动 Claude Code 后生效"
info "在目标项目中使用触发短语:"
echo "   \"给我的项目建立约束体系\""
echo ""
