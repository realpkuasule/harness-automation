# Agent adapters

## Portable baseline

Every coding agent receives:

- a small Harness-managed block in root `AGENTS.md`;
- `.harness/generated/effective-policy.md` with the complete compiled policy;
- `harness-automation context --project .` at session start;
- `harness-automation check --project .` before completion.

This path assumes only repository file access and command execution. It is the fallback for future DeepSeek Coder, GLM Coder and unknown runtimes.

## Claude Code

When `CLAUDE.md` or `.claude/` is discovered, Harness places the same digest-bearing managed block in `CLAUDE.md`. MCP can expose richer commands, but the CLI remains authoritative. Existing Claude content outside the managed markers is preserved.

## Codex

Codex reads the portable `AGENTS.md` path. The Skill is installed under the Codex skills directory, and all deterministic operations go through the same CLI service as Claude Code.

## Capability reporting

Adapters are capability-based: root/scoped instructions, imports, hooks, MCP and structured output. Do not infer support from a vendor name alone. For each target report configured, loaded, enforced and passing separately. An unverified future runtime uses only the portable capability set.
