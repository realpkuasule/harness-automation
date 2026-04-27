#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# Harness Automation — Install Script
# ============================================================
# Installs @realpkuasule/harness-automation as a Claude Code MCP server in
# the target project. Can be run from the target project
# directory or with --dir <path>.
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
NC='\033[0m' # No Color

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
      echo "Installs @realpkuasule/harness-automation as a Claude Code MCP server in the target project."
      echo "If --dir is omitted, uses the current working directory."
      exit 0
      ;;
    *) err "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ -z "$TARGET_DIR" ]]; then
  TARGET_DIR="$(pwd)"
fi

# Resolve @realpkuasule/harness-automation root (where this script lives)
HARNESS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Allow override via env var
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

# --- Step 3: Check @realpkuasule/harness-automation dist ---
info "检查 @realpkuasule/harness-automation 构建产物..."

HARNESS_MCP="$HARNESS_ROOT/mcp-server/dist/index.js"
if [[ ! -f "$HARNESS_MCP" ]]; then
  err "未找到构建产物: $HARNESS_MCP"
  err "请先在 @realpkuasule/harness-automation 项目目录中运行: cd mcp-server && npm run build"
  exit 1
fi
ok "构建产物已找到: $HARNESS_MCP"

# --- Step 4: Setup .claude/settings.json ---
info "配置 Claude Code MCP server..."

CLAUDE_DIR="$TARGET_DIR/.claude"
CLAUDE_SETTINGS="$CLAUDE_DIR/settings.json"

mkdir -p "$CLAUDE_DIR"

MCP_CONFIG='{
  "mcpServers": {
    "harness-automation": {
      "command": "node",
      "args": ["'$HARNESS_MCP'"]
    }
  }
}'

if [[ -f "$CLAUDE_SETTINGS" ]]; then
  # Merge with existing settings
  EXISTING=$(cat "$CLAUDE_SETTINGS")
  # Use Python for safe JSON merge
  python3 -c "
import json, sys
existing = json.loads(sys.stdin.read())
# Merge mcpServers
if 'mcpServers' not in existing:
    existing['mcpServers'] = {}
existing['mcpServers']['harness-automation'] = {
    'command': 'node',
    'args': ['$HARNESS_MCP']
}
print(json.dumps(existing, indent=2, ensure_ascii=False))
" <<< "$EXISTING" > "$CLAUDE_SETTINGS"
  ok "已有 .claude/settings.json，已合并 @realpkuasule/harness-automation 配置"
else
  echo "$MCP_CONFIG" > "$CLAUDE_SETTINGS"
  ok "已创建 .claude/settings.json"
fi

# --- Step 5: Copy rules.json to .harness/ ---
info "复制规则数据库..."

HARNESS_DATA_DIR="$TARGET_DIR/.harness"
mkdir -p "$HARNESS_DATA_DIR"

if [[ -f "$HARNESS_MCP" ]]; then
  # rules.json is in the same directory as dist/index.js
  RULES_SRC="$(dirname "$HARNESS_MCP")/rules.json"
  if [[ -f "$RULES_SRC" ]]; then
    cp "$RULES_SRC" "$HARNESS_DATA_DIR/rules.json"
    ok "规则数据库已复制到 .harness/rules.json"
  fi
fi

# --- Done ---
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  安装完成！                              ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════╝${NC}"
echo ""
ok "Harness Automation MCP Server 已配置到以下位置:"
echo "   项目: $TARGET_DIR"
echo "   配置: $CLAUDE_SETTINGS"
echo "   规则: $HARNESS_DATA_DIR/rules.json"
echo ""
info "在目标项目中使用 Claude Code 时，触发短语:"
echo "   \"给我的项目建立约束体系\""
echo "   \"初始化约束\""
echo "   \"检查项目约束\""
echo ""
info "要测试是否配置成功，在目标项目中运行:"
echo "   Claude Code 中输入任何触发短语即可自动启动工作流"
echo ""
