#!/usr/bin/env bash
# ============================================================
# Install Script Test
# Tests skill/install.sh in a temporary project directory.
# ============================================================
set -euo pipefail

HARNESS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_SCRIPT="$HARNESS_ROOT/skill/install.sh"
TEST_DIR=$(mktemp -d /tmp/harness-install-test-XXXXXX)

PASS=0
FAIL=0

cleanup() {
  rm -rf "$TEST_DIR"
}

trap cleanup EXIT

# === Test 1: Non-Git directory warning ===
echo "--- Test 1: Non-Git directory ---"
OUTPUT=$("$INSTALL_SCRIPT" --dir "$TEST_DIR" <<< "n" 2>&1 || true)
if echo "$OUTPUT" | grep -q "Git 仓库"; then
  echo "  ✅ Warns about non-Git repo"
  PASS=$((PASS + 1))
else
  echo "  ❌ Should warn about missing Git repo"
  echo "     Output: $OUTPUT"
  FAIL=$((FAIL + 1))
fi

# === Test 2: Install in Git repo ===
echo "--- Test 2: Install in Git repo ---"
cd "$TEST_DIR"
git init -q
git config user.email "test@test.com"
git config user.name "Test"
mkdir -p src
echo "console.log('test');" > src/index.js
git add -A
git commit -q -m "initial"

OUTPUT=$("$INSTALL_SCRIPT" --dir "$TEST_DIR" <<< "y" 2>&1) || true

# Check .claude/settings.json exists
if [[ -f "$TEST_DIR/.claude/settings.json" ]]; then
  echo "  ✅ .claude/settings.json created"
  PASS=$((PASS + 1))
else
  echo "  ❌ .claude/settings.json missing"
  FAIL=$((FAIL + 1))
fi

# Check it contains harness-automation config
if grep -q "harness-automation" "$TEST_DIR/.claude/settings.json"; then
  echo "  ✅ settings.json contains harness-automation config"
  PASS=$((PASS + 1))
else
  echo "  ❌ harness-automation not found in settings.json"
  FAIL=$((FAIL + 1))
fi

# Check valid JSON
if python3 -c "import json; json.load(open('$TEST_DIR/.claude/settings.json'))" 2>/dev/null; then
  echo "  ✅ settings.json is valid JSON"
  PASS=$((PASS + 1))
else
  echo "  ❌ settings.json is not valid JSON"
  FAIL=$((FAIL + 1))
fi

# Check .harness/rules.json exists
if [[ -f "$TEST_DIR/.harness/rules.json" ]]; then
  echo "  ✅ .harness/rules.json created"
  PASS=$((PASS + 1))
else
  echo "  ❌ .harness/rules.json missing"
  FAIL=$((FAIL + 1))
fi

# === Test 3: Merge with existing settings.json ===
echo "--- Test 3: Merge with existing settings ---"
# Add an existing MCP server config
python3 -c "
import json
with open('$TEST_DIR/.claude/settings.json') as f:
    existing = json.load(f)
existing['mcpServers']['existing-tool'] = {'command': 'node', 'args': ['/path/to/tool.js']}
with open('$TEST_DIR/.claude/settings.json', 'w') as f:
    json.dump(existing, f, indent=2)
"

OUTPUT=$("$INSTALL_SCRIPT" --dir "$TEST_DIR" <<< "y" 2>&1) || true

# Check both configs exist
if grep -q "existing-tool" "$TEST_DIR/.claude/settings.json" && grep -q "harness-automation" "$TEST_DIR/.claude/settings.json"; then
  echo "  ✅ Both MCP server configs preserved after merge"
  PASS=$((PASS + 1))
else
  echo "  ❌ Merge failed - existing config not preserved"
  FAIL=$((FAIL + 1))
fi

# === Test 4: Missing build directory ===
echo "--- Test 4: Missing build ---"
HARNESS_PATH="/nonexistent/path" OUTPUT=$("$INSTALL_SCRIPT" --dir "$TEST_DIR" <<< "y" 2>&1 || true)
if echo "$OUTPUT" | grep -q "构建产物"; then
  echo "  ✅ Reports missing build when HARNESS_PATH is wrong"
  PASS=$((PASS + 1))
else
  echo "  ❌ Should report missing build"
  FAIL=$((FAIL + 1))
fi

# === Summary ===
echo ""
echo "=========================="
echo "Results: $PASS passed, $FAIL failed"
echo "=========================="
if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
