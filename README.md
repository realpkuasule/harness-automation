# Harness Automation

[![CI](https://github.com/realpkuasule/harness-automation/actions/workflows/ci.yml/badge.svg)](https://github.com/realpkuasule/harness-automation/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@realpkuasule/harness-automation)](https://www.npmjs.com/package/@realpkuasule/harness-automation)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[中文文档](README.zh-CN.md)

Harness Automation is a **repository-native policy compiler for AI coding projects**. It compiles confirmed engineering decisions into stable cross-session, cross-agent context and executable checks, so every new coding session keeps working like the same clear-headed engineer.

It is not about "generating more rule files". It guarantees three things:

- PRD, design, and research evidence are traceable, hash-pinned policy inputs;
- Rules that can be formalized are enforced by real checkers; rules that cannot are explicitly labeled as review guidance;
- Every change is first compiled into an immutable plan, and is atomically applied and precisely rolled back only after the project owner approves its exact hash.

The typical adoption point is the first week when a project moves into multi-person, multi-session parallel development. Harness targets the three most common failure modes:

- Sessions build duplicate capabilities because nobody searched the existing implementation first;
- Interface contracts drift inside local implementations until callers and implementers diverge;
- Naming boundaries such as `camelCase` vs `snake_case` cause repeated rework.

## When to use

Recommended flow:

```text
Requirements clarification / grill-me
  -> docs/PRD.md
  -> GitHub research (docs/research/)
  -> PRD and design finalized
  -> Harness intake / discover / plan / apply / check
  -> Multi-person, multi-agent parallel development
```

Harness does not modify or replace `grill-me`; it consumes the repository artifacts left by it and the design flow.

## Supported stacks

| Profile | Combination | Naming boundaries |
|---|---|---|
| `full-typescript` | NestJS + Prisma + tRPC + Next.js | TS/JSON camelCase; PostgreSQL snake_case; explicit Prisma mapping |
| `python-data-ai` | Django + Pydantic + PostgreSQL + Celery + React/TS + K8s | Python snake_case; JSON/TS camelCase; explicit Pydantic aliases |
| `go-performance` | Go + sqlc/ent + PostgreSQL + gRPC + K8s + TS frontend | Go mixedCaps; Proto/DB snake_case; Proto JSON/TS camelCase |
| `custom` | Owner-approved exact stack identifiers | Only available adapters are compiled; no implicit inheritance from the closest preset |

Code naming for TypeScript, Python, and Go is verified by AST checkers. Database, RPC, API, and generated-code boundaries keep their own idioms, converted explicitly through schema/compiler.

`custom` accepts lowercase kebab-case stack identifiers. `typescript`, `python`, `go`, `postgresql`, `grpc`, and `kubernetes` have built-in adapters; unknown stacks such as `csharp`, `godot`, or `rust` still flow through the complete plan/apply/check/rollback loop, but stack-level enforcement is honestly reported as `blocked`. For example, `custom + typescript` never implicitly adds NestJS, Prisma, tRPC, Next.js, or PostgreSQL.

## Install

Requires Node.js 18 or newer. Two steps: install the global CLI, then wire the same Skill and the optional MCP server into your local coding agents.

```bash
npm install -g @realpkuasule/harness-automation@latest
harness-automation install
```

Verify:

```bash
npm list -g @realpkuasule/harness-automation --depth=0
harness-automation help
```

`harness-automation doctor --project .` also compares, read-only, the two Skills bundled in the CLI against the installed copies under `~/.claude`, `~/.codex`, and `~/.agents`; when it reports `missing`, `stale`, or `blocked`, run `harness-automation install` to repair. Doctor itself never writes to host directories.

`harness-automation install` deploys:

- `~/.claude/skills/harness-automation/`;
- `~/.codex/skills/harness-automation/`;
- `~/.agents/skills/harness-automation/`;
- `manage-worktree-delivery/` in the same locations;
- the optional Claude Code MCP server.

Start a new coding-agent session after installing so the agent rediscovers the Skills. The CLI is the authoritative baseline for every agent; even agents without a dedicated MCP get the full flow through repository files plus the CLI.

From source:

```bash
cd mcp-server
npm ci
npm run build
cd ..
./skill/install.sh
```

## Quick start

Prepare these inputs:

- `docs/PRD.md`;
- GitHub / official-docs research evidence under `docs/research/`;
- optional design documents under `docs/design/`.

Then:

```bash
# Read-only preflight
harness-automation doctor --project .

# Deterministic GitHub candidate discovery when research evidence is missing
harness-automation research github --project . --query "<concept>"

# The project owner confirms upstream artifacts are finalized
harness-automation intake --project . --owner <owner> --approve-sources

# Automatic discovery of repository facts and agent capabilities
harness-automation discover --project .

# Generate a plan only; target files are not modified
harness-automation plan --project . --profile full-typescript

# Existing TypeScript naming debt requires an explicit owner-approved intake snapshot
harness-automation intake --project . --owner <owner> --approve-sources \
  --approve-typescript-naming-adoption
harness-automation discover --project .

# The matching rule-bound fingerprints then enter the immutable, hash-approved plan
harness-automation plan --project . --profile full-typescript --adopt-typescript-naming

# When no full preset matches, the owner approves the exact stacks; --stack is repeatable
harness-automation plan --project . --profile custom \
  --stack typescript \
  --stack postgresql

# Stacks without built-in adapters do not block Harness
harness-automation plan --project . --profile custom \
  --stack csharp \
  --stack godot

# delivery/domain/quality profiles are orthogonal to the tech stack and can be added independently
harness-automation plan --project . --profile custom \
  --stack csharp \
  --stack godot \
  --delivery-profile worktree-delivery \
  --domain-profile game-development \
  --quality-profile eval-driven-development

# After the owner reviews the plan, approve with the full hash from its output
harness-automation apply --project . \
  --plan .harness/plans/<plan>.json \
  --approve <sha256>

# Verify real execution state and drift
harness-automation check --project . --mode session
harness-automation drift --project .
```

The `plan` JSON output contains the final stacks, target files, before/after hashes, verification commands, warnings, and the complete `planHash`. The project owner must review all of it before handing that hash to `apply`.

### Update an applied Harness project

Run the currently installed CLI against the existing project; it inherits the applied owner, profile, stacks, orthogonal profiles, phase, and adoption baseline:

```bash
harness-automation update plan --project /absolute/path/to/project
```

`current` means the policy and manifest contain the same exact local compiler version and no semantic or target hash changes are needed. A non-empty result is a normal immutable plan and uses the existing exact-hash `apply`, receipt, and rollback commands. The update command does not query npm, install a package, run project commands, or create/move worktrees. Missing `.harness/policy.yaml` returns `HARNESS_INITIALIZATION_REQUIRED`. Worktree status is one of `not-configured`, `compatible`, `configuration-plan-required`, or `migration-required`; a companion workspace plan has its own hash and never forces an empty policy plan.

If the plan reports weakening, the owner must bind the exact weakening digest and every listed rule ID into a fresh intake, rediscover, and plan again before the ordinary plan-hash gate can apply it:

```bash
harness-automation intake --project /absolute/path/to/project --owner <owner> --approve-sources \
  --approve-weakening <weakening-sha256> \
  --weakening-rule <rule-id>
harness-automation discover --project /absolute/path/to/project
harness-automation update plan --project /absolute/path/to/project
```

`doctor` reports the offline compiler state as `current`, `stale`, `legacy-version-unknown`, or `unconfigured`.

## Session handoff (v2.2.0)

Long sessions should be cut when they should be cut — the recovery cost is near zero because the handoff artifacts are on disk. The `session` command group executes handoffs, receipts, and issue transitions deterministically, with no AI involvement. Protocol: [Session Handoff design](docs/designs/session-handoff.md), [session workflow reference](skill/references/session-workflow.md).

Issue state machine:

```text
backlog ──(claim: worktree lease exists + seed generated)──▶ in-progress
in-progress ──(continuation handoff: doc + validation + receipt)──▶ in-progress
in-progress ──(explicit delivery review: doc + validation + receipt)──▶ ready-for-review
ready-for-review ──(accepted-commit exists)──▶ done
any state ──(humans only)──▶ backlog (reopen)
```

Every automatic transition must carry evidence (commit sha / receipt ids / check results); missing evidence means the transition is refused.

```bash
# Handoff: two-phase. With the doc missing it only renders the template skeleton
# (no issue writes, no transitions); fill in the content sections, then run the
# same command again to validate, receipt, update the issue, and render the seed.
harness-automation session handoff \
  --project <project-dir> \
  --work-item github:owner/repository#24 \
  --session <current-session-id> \
  [--to-status in-progress|ready-for-review] \
  [--dry-run]

# Read-only state: issue, board fields, handoff doc validation, latest receipt
harness-automation session status \
  --project <project-dir> \
  [--work-item github:owner/repository#24]

# Render only the seed prompt (no writes, no transitions; for manual copy-paste)
harness-automation session seed \
  --project <project-dir> \
  --work-item github:owner/repository#24
```

- Output is stable JSON. `--dry-run` performs zero writes (read-only `gh` checks included) and its output is byte-for-byte reproducible — no timestamps, no randomness.
- The handoff document `docs/HANDOFF-<issue>.md` is validated by the CLI: required sections present, no unfilled `{{...}}` placeholders outside the SEED section, referenced file paths exist, and receipt ids cited under "已完成" resolve in the harness receipt library. Failure refuses the handoff without leaving a half-written state.
- The handoff receipt is written to `<git-common-dir>/harness/session-handoff/receipts/handoff-<issue>-<docHash12>.json`; its id is derived from the document hash, so re-running with an unchanged document is idempotent.
- Issue writes reuse the existing `gh` credential channel and the provider mapping in `.harness/worktree-delivery.json`; no new credential mechanism is introduced.
- Template references, field names, and the status display-name mapping live in `.harness/session-workflow.yaml`. A project file is used when present; otherwise package-distributed defaults are used read-only. The CLI has no runtime session metrics or thresholds: those fields were removed because no P1 consumer exists. Policy changes go through the normal plan-hash approval flow — never through the CLI or a plugin.

## Eval-driven development

For non-deterministic product behavior — agents, generation, retrieval, or model judgment — the EDD quality profile can be enabled. Plain deterministic projects keep their existing type, unit, integration, and contract gates.

Before enabling, create `evals/evals.json` with stable Requirement ID → suite → rule ID traceability, representative tasks, targets, graders, cross-stack argv runners, explicit repo-relative `runnerSources`, and a project-owned known-bad negative control. New behavior records a real `pre-implementation` baseline; adopting an existing eval system records an honest `adoption` baseline — never backfill history. `1.0` stays readable (a missing origin is reported as `legacy-unknown`, and even new fields cannot claim `enforced`); `1.1` requires and validates traceability, baseline origin, runnerSources, and negative control. See [Eval Contract v1](docs/api/eval-contract-v1.schema.json) and the [EDD workflow](skill/references/eval-driven-development.md). Then re-intake and plan:

```bash
harness-automation intake --project . --owner <owner> --approve-sources
harness-automation discover --project .
harness-automation plan --project . --profile custom \
  --stack typescript \
  --quality-profile eval-driven-development
```

Eval runners execute only in CI mode:

```bash
harness-automation check --project . --mode ci
```

Harness reports `passing` (positive suites succeed) and `enforced` (known-bad controls are rejected with the expected exit code) independently; CI passes only when both hold. Receipts keep argv, exit status, and output SHA-256 only. A plain deterministic test script named `evals` stays an ordinary gate — Harness is advisory and never auto-enables EDD. It does not call model providers directly, stores no credentials or raw transcripts, and never lets an uncalibrated model grader become a hard gate.

## Worktree delivery governance

Plain Git repositories can run read-only checks without a PRD or a provider:

```bash
harness-automation worktree status --project .
harness-automation worktree audit --project .
harness-automation worktree retention-audit --project .
harness-automation worktree integration-check --project . --work-item github:owner/repository#24 [--target main]
```

Configuring, allocating, adopting existing worktrees, and closing produce plans by default:

```bash
harness-automation worktree configure \
  --project . \
  --mode enforced \
  --management-branch main \
  --allow-root /absolute/worktree-parent

harness-automation worktree allocate \
  --project /absolute/container/main \
  --work-item github:owner/repository#24 \
  --branch codex/24-description \
  --owner <owner>

harness-automation worktree adopt \
  --project . \
  --manifest /absolute/path/worktree-adopt.json

harness-automation worktree close \
  --project . \
  --work-item github:owner/repository#24 \
  --accepted-commit <sha>
```

All plans emitted by these commands are executed through the unified `apply --plan ... --approve <sha256>`. New configurations default to 2 persistent worktrees, a 72-hour lease, and short-lived branches: close requires deterministic merge evidence, then deletes the exact local and upstream feature refs with SHA compare-and-swap. The one-day read-only audit catches stale feature branches that remain for any reason and excludes management branches; it is not a normal grace period. Explicit existing values remain unchanged. For container-v1, allocation derives `<persistentWorktreeRoot>/<work-item-id>` and requires a branch containing that case-sensitive ID as a complete segment; legacy-flat still requires `--path`, and existing/adopted paths never move or rename. `integration-check` is read-only: it uses an isolated native merge-tree result, reports dirty/unpushed/conflict evidence, and never fetches, merges, rebases, checks out, or runs tests. Behind is a warning; dirty, unresolved or predicted conflict, unpushed work, and mapping drift block. `adopt` only batch-creates leases for worktrees already registered in the manifest; it accepts and hash-pins dirty content but never adds/removes worktrees, switches branches, or touches HEAD/index/working-tree files. Any drift or failure stops before writing, or compensates only the leases created by this run. `status`, `audit`, retention audits, integration checks, and planning create zero worktrees. `.harness/worktree-delivery.json` holds portable policy only; allowed and protected roots are host bindings stored in the Git common dir. The configuration plan hash covers both, and each new machine must approve its own host binding.

Temporary review uses detached HEAD and OS temp directories, never creating local branches:

```bash
harness-automation worktree review --project . --commit <sha> -- npm test
```

Clean review checkouts are reclaimed immediately; uncommitted content returns `blocked` with exact paths, file sizes, SHA-256, a binary patch digest, and a durable receipt. Harness never merges automatically. After an externally completed merge, ordinary merges use ancestry proof and GitHub squash merges use the exact merged PR head/base/SHA before branch cleanup.

## New-session onboarding

Every new coding session runs before touching code:

```bash
harness-automation context --project . --agent codex
```

`--agent` accepts `auto`, `portable`, `claude-code`, or `codex`. Then:

1. Read `.harness/generated/effective-policy.md`;
2. Search the existing implementation to avoid duplicate work;
3. Confirm the owning module, shared contracts, and naming boundaries;
4. Run `harness-automation check --project . --mode session` before finishing;
5. Use `--mode commit` before committing; CI uses `--mode ci`.

## Safety model

- `plan` is the default write boundary; it only adds `.harness/plans/*.json`.
- `apply` requires the full plan SHA-256 and re-validates the PRD, design, research, discovery snapshot, and every target file.
- Writes use temp-file + rename; mid-flight failures restore files already written.
- Agent instruction files are maintained only inside marked blocks; content outside the blocks is never touched.
- Commands appearing in the PRD are never auto-executed; dependencies, migrations, repo settings, and existing CI are never auto-installed, auto-run, or overwritten.
- Rollback refuses to overwrite files modified by humans or agents after the apply, and only deletes files created by the change.

## GitHub governance audit

```bash
harness-automation github audit --project /absolute/repository [--organization xiaozhiaixue]
```

This is a read-only observation of the checkout's GitHub repository. It reports branch/ruleset and check evidence, CODEOWNERS, Actions and environment facts, the configured Issue/Project mapping, deterministic blockers, warnings, unavailable evidence, and a stable `observedHash`. Exit `0` permits warnings; exit `2` means a blocker or an explicitly requested scope could not be read; exit `1` means invalid input or a runtime error.

The command never fetches, writes GitHub settings, changes token scopes, or modifies the checkout. It does not require target repositories to use GitHub Actions: `check --mode ci` remains a provider-neutral local command depth. See [GitHub governance audit reference](docs/reference/github-governance.md).

## Repository state

```text
.harness/
  intake.json                  approved inputs and their SHA-256
  discovery.json               repository facts, evidence, capabilities
  policy.yaml                  single policy source (YAML 1.2 subset as JSON)
  manifest.json                compiler, policy, and output hashes
  plans/                       immutable change plans
  changes/                     apply and per-file rollback records
  sessions/                    local new-session receipts (ignored by VCS)
  generated/
    effective-policy.md        cross-agent effective policy
    check_python_naming.py     AST gate for the Python profile
    check_go_naming.go         AST gate for the Go profile
```

`AGENTS.md` is the portable adapter. When Claude Code is discovered, Harness writes the same policy summary into `CLAUDE.md`. Future or unknown DeepSeek/GLM coding agents default to `AGENTS.md + CLI`; no hook or MCP capability is invented based on a brand name.

## Verification semantics

`harness-automation check` reports separately:

- `configured`: the target configuration exists;
- `loaded`: the agent can discover the current policy summary;
- `enforced`: real checkers reject known-invalid fixtures;
- `passing`: the current codebase passes the checks.

`stackAdapters` additionally reports per-stack built-in adapter coverage, and `stackCoverageComplete` summarizes whether everything is covered. Writing something into an instruction file is not the same as enforced. Design-judgment rules always show as `guidance`; missing runtimes or adapters show as `blocked`. A generic Harness baseline can apply successfully to an unknown stack, but that does not mean the language has gained deterministic enforcement.

## CLI and MCP

v2 CLI commands: `doctor`, `research github`, `github audit`, `intake`, `discover`, `plan`, `update plan`, `apply`, `context`, `check`, `drift`, `explain`, `rollback`, plus `worktree configure|allocate|adopt|review|status|audit|close|retention-audit|integration-check` and `session handoff|status|seed`. `plan` supports orthogonal `deliveryProfile`, `domainProfile`, and `qualityProfile`. `check --mode commit|ci` runs the trusted project gates visible in the plan; EDD runners execute only in CI mode and report `blocked` when a runtime is missing. When CI cannot observe host-local worktrees, workspace enforcement is reported honestly as unavailable.

The MCP server exposes the same service layer, including the core `harness_*` tools and the matching `harness_worktree_*` tools. The CLI remains the portable baseline for Claude Code, Codex, and DeepSeek/GLM agents.

Legacy v1 handlers are kept for migrating existing callers but are not exposed to agents by default. Both discovery and direct invocation require the process-start opt-in `HARNESS_ENABLE_LEGACY_V1=1`; otherwise they fail closed. The current Skill never uses `init_harness`, `generate_config`, placeholder AI review, or pseudo A/B paths.

## Development

```bash
cd mcp-server
npm ci
npm run build
npm test
npm run lint
```

Designs and formal policy schemas:

- [Session Handoff design](docs/designs/session-handoff.md)
- [Harness Skill v2 design](docs/design/harness-skill-v2.md)
- [Worktree Delivery design](docs/design/worktree-delivery.md)
- [Policy v2 JSON Schema](docs/api/harness-policy-v2.schema.json)
- [Eval Contract v1 JSON Schema](docs/api/eval-contract-v1.schema.json)
- [Worktree Delivery v1 JSON Schema](docs/api/worktree-delivery-v1.schema.json)
- [Worktree Host Binding v1 JSON Schema](docs/api/worktree-host-binding-v1.schema.json)
- [Worktree Adopt v1 JSON Schema](docs/api/worktree-adopt-v1.schema.json)
- [Skill](skill/SKILL.md)
- [Worktree Skill](skills/manage-worktree-delivery/SKILL.md)

## Repository workflow

Development of this repository itself is tracked with GitHub Issues and a configured GitHub Project.

- Active tracking: GitHub Issues / GitHub Project
- Historical archive: `TASK.json`
- Changelog: `CHANGELOG.jsonl`

Repository workflow commands:

```bash
python3 scripts/github_tracker.py doctor
python3 scripts/github_tracker.py summary
python3 scripts/github_tracker.py list --state open
python3 scripts/github_tracker.py show 123
python3 scripts/github_tracker.py create --title "Title" --body "Details" --priority high
python3 scripts/github_tracker.py status 123 "In Progress"
python3 scripts/github_tracker.py priority 123 critical
python3 scripts/github_tracker.py close 123 --comment "Done"
python3 scripts/changelog.py add feat 11 "Describe change" --issue realpkuasule/harness-automation#123
```

The project configuration lives in `.github/project-workflow.json`; see [GitHub Issue / Project Workflow](docs/development/github-project-workflow.md).

## License

MIT
