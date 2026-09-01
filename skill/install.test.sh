#!/usr/bin/env bash
set -euo pipefail

HARNESS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d /tmp/harness-install-test-XXXXXX)"
FAKE_BIN="$TEST_ROOT/bin"
TEST_HOME="$TEST_ROOT/home"

cleanup() { rm -rf "$TEST_ROOT"; }
trap cleanup EXIT

if [[ ! -f "$HARNESS_ROOT/mcp-server/dist/cli.js" ]]; then
  echo "Build first: cd mcp-server && npm ci && npm run build" >&2
  exit 1
fi

mkdir -p "$FAKE_BIN" "$TEST_HOME"
cat > "$FAKE_BIN/claude" <<'SCRIPT'
#!/usr/bin/env bash
exit 1
SCRIPT
chmod +x "$FAKE_BIN/claude"

HOME="$TEST_HOME" PATH="$FAKE_BIN:$PATH" node "$HARNESS_ROOT/mcp-server/dist/cli.js" install --no-global >/dev/null

test -f "$TEST_HOME/.claude/skills/harness-automation/SKILL.md"
test -f "$TEST_HOME/.codex/skills/harness-automation/SKILL.md"
test -f "$TEST_HOME/.agents/skills/harness-automation/SKILL.md"
test -f "$TEST_HOME/.claude/skills/manage-worktree-delivery/SKILL.md"
test -f "$TEST_HOME/.codex/skills/manage-worktree-delivery/SKILL.md"
test -f "$TEST_HOME/.agents/skills/manage-worktree-delivery/SKILL.md"
test -f "$TEST_HOME/.codex/skills/manage-worktree-delivery/references/safety-model.md"
test -f "$TEST_HOME/.claude/skills/harness-automation/references/policy-model.md"
test -f "$TEST_HOME/.codex/skills/harness-automation/agents/openai.yaml"
test -f "$TEST_HOME/.codex/skills/harness-automation/evals/evals.json"
test -f "$TEST_HOME/.claude.json"

grep -q 'harness-automation' "$TEST_HOME/.claude.json"
grep -q 'Harness Automation' "$TEST_HOME/.codex/skills/harness-automation/SKILL.md"
grep -q 'worktree audit' "$TEST_HOME/.codex/skills/manage-worktree-delivery/SKILL.md"
grep -q '不得为版本更新、验证、打 tag、publish 或发布重试新建专用 worktree' "$TEST_HOME/.codex/skills/manage-worktree-delivery/SKILL.md"

echo "Installer test passed"
