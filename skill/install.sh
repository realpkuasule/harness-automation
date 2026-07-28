#!/usr/bin/env bash
set -euo pipefail

HARNESS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="${PWD}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)
      TARGET_DIR="$2"
      shift 2
      ;;
    --help|-h)
      echo "Usage: skill/install.sh [--dir /path/to/project]"
      echo "Builds the local package and installs the same Harness Skill for Claude Code and Codex."
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

if [[ ! -d "$TARGET_DIR" ]]; then
  echo "Target directory does not exist: $TARGET_DIR" >&2
  exit 1
fi

if [[ ! -f "$HARNESS_ROOT/mcp-server/dist/cli.js" ]]; then
  echo "Build output not found; run: cd $HARNESS_ROOT/mcp-server && npm ci && npm run build" >&2
  exit 1
fi

node "$HARNESS_ROOT/mcp-server/dist/cli.js" install

echo "Harness installed. It did not modify the target project or the grill-me Skill."
echo "Run: harness-automation doctor --project $TARGET_DIR"
