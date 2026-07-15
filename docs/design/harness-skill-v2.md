# Harness Skill v2 — Engineering Continuity

**Status:** implemented in 2.0.0-beta.1
**Date:** 2026-07-16
**Scope:** redesign the Harness skill and the deterministic runtime it orchestrates

## 1. Product contract

Harness gives a repository a persistent engineering identity. It moves stable
engineering decisions out of temporary AI conversations and compiles them into
context and executable controls that survive new sessions, different agents,
and parallel development.

The product promise is:

> Every new coding session should continue with the same engineering judgment,
> even when the model, agent runtime, or human operator changes.

Harness does not promise identical code. It promises that every session receives
the same effective policies, deterministic policies are actually enforced, and
changes to established policies are explicit and reviewable.

## 2. Locked decisions

The following decisions were confirmed during product discovery:

- Primary user: the person who creates the project, clarifies requirements, and
  invokes Harness. This person is the project owner and policy approver.
- Team: 5–10 people using multiple coding agents and fresh sessions.
- Activation point: after requirement grilling, GitHub wheel research, and PRD /
  design finalization; before implementation begins.
- Required PRD path: `docs/PRD.md`.
- Research directory: `docs/research/`.
- Agent strategy: capability-based and vendor-neutral. Unknown future DeepSeek
  Coder and GLM Coder runtimes use the portable adapter until their real
  instruction, hook, and MCP capabilities are published.
- Real v1 stack paths:
  1. NestJS + Prisma + tRPC + Next.js, all TypeScript.
  2. Python + Django + Pydantic + PostgreSQL + Celery + React/TypeScript + K8s.
  3. Go + sqlc or ent + PostgreSQL + gRPC + K8s + TypeScript frontend.

## 3. End-to-end workflow

```text
grill-me
  -> docs/PRD.md
  -> GitHub wheel research in docs/research/
  -> PRD and design revision
  -> owner declares the design ready
  -> Harness intake
  -> repository and policy discovery
  -> focused owner decisions
  -> immutable plan
  -> owner approval
  -> atomic apply
  -> enforcement verification
  -> development may begin
```

Harness consumes upstream artifacts. It does not own requirement grilling or
product design. When required research is missing, it may run the GitHub
research workflow before continuing.

### 3.1 Intake

`harness intake` must:

1. Require `docs/PRD.md`.
2. Discover design documents under `docs/design/` and common root-level design
   filenames.
3. Discover research artifacts under `docs/research/`.
4. Hash every accepted source with SHA-256.
5. Ask the project owner to confirm that the source set represents the approved
   design.
6. Write `.harness/intake.json` only after confirmation.

An intake remains valid only while the source hashes remain unchanged. A changed
PRD or design invalidates all unexecuted plans.

### 3.2 GitHub wheel research

`harness research github` must produce evidence that can be consumed by later
steps, not an unstructured chat summary.

The deterministic discovery path is:

1. Derive search concepts from the PRD and design.
2. Use authenticated GitHub CLI or GitHub Search API for repository discovery.
3. Use the connected GitHub integration, when available, for deeper inspection
   of known candidates.
4. Read official documentation and relevant source for shortlisted projects.
5. Record queries, candidate URLs, license, maintenance signals, release state,
   ecosystem fit, integration cost, security considerations, and rejection
   reasons.
6. Write a Markdown report and machine-readable index under `docs/research/`.

Stars may be recorded but must not be the primary selection criterion. A design
decision may cite a dependency only when the research report contains supporting
evidence.

### 3.3 Discover

`harness discover` must inspect facts rather than ask the user:

- manifests, lockfiles, build tools, workspaces, and package boundaries;
- existing linters, formatters, type checkers, tests, schemas, and generators;
- database, RPC, API, queue, and deployment boundaries;
- existing `AGENTS.md`, `CLAUDE.md`, agent-specific rules, hooks, and CI;
- naming patterns at each boundary, including code, JSON, database, and proto;
- commands already defined by the repository;
- policy conflicts and duplicated instructions.

Discovery writes `.harness/discovery.json`. It must distinguish observed facts
from inferred recommendations and include confidence and evidence paths.

### 3.4 Decide

The Skill asks only about high-impact decisions that cannot be recovered safely
from the repository or approved documents. Questions are asked one at a time,
with a recommendation and its evidence.

Typical decisions include:

- casing at each data boundary;
- API and RPC compatibility policy;
- source of truth for schemas and generated code;
- module ownership and allowed imports;
- required type-check, test, migration, and build gates;
- whether a missing enforcement dependency may be installed.

The project owner is the only approver. AI recommendations never become policy
without owner approval.

### 3.5 Plan and apply

`harness plan` produces an immutable JSON plan containing:

- input source and discovery hashes;
- proposed policy changes;
- exact file patch operations;
- dependencies to add or remove;
- commands that will be executed;
- unmanaged conflicts and semantic-loss warnings;
- rollback operations;
- the SHA-256 hash of the canonical plan representation.

`harness apply --plan <path> --approve <hash>` must reject execution when the
hash, an input file precondition, or an approved source hash differs.

### 3.6 Verify

`harness check` must separate four results:

- `configured`: the target configuration exists;
- `loaded`: an agent or tool can discover the expected policy;
- `enforced`: an executable verifier rejects a known invalid fixture;
- `passing`: the current repository passes the verifier.

A policy is not reported as enforced merely because text was written to an
agent instruction file.

## 4. Skill and runtime architecture

```text
skill/SKILL.md
  -> user interaction and approval boundaries only
  -> calls deterministic scripts or CLI with --json

skill/scripts/
  -> stable wrappers and preflight helpers

skill/references/
  -> policy model, stack adapter, agent adapter, and workflow references

harness CLI / MCP
  -> two transports over one application service

core application service
  -> intake, research, discover, plan, apply, check, drift, rollback

adapters
  -> agent runtimes, language stacks, contracts, Git, CI, and K8s
```

The CLI and MCP server must call the same service layer. They must not contain
separate implementations of planning, writing, backup, or validation.

The CLI is the portable baseline because every coding agent can run commands.
MCP is an optional richer transport, not the product boundary.

## 5. Canonical repository state

```text
.harness/
  intake.json                 approved source set and hashes
  discovery.json              observed repository facts
  policy.yaml                 owner-approved policy source of truth
  manifest.json               compiler version, targets, and output hashes
  plans/                      immutable proposed change sets
  changes/                    applied change and rollback manifests
  sessions/                   local, ignored session receipts
  generated/
    effective-policy.md       portable agent context
    verification.json         current enforcement evidence
```

Generated agent files, lint configuration, hooks, and CI are compiler targets.
They are never the source of truth.

## 6. Policy model

The machine-readable schema lives at
`docs/api/harness-policy-v2.schema.json`. Each policy includes:

- stable ID, statement, rationale, owner, and source references;
- file, module, API, database, or deployment scope;
- formalization class and severity;
- agent and enforcement targets;
- executable verification and pass criteria;
- valid and invalid examples;
- approval and migration requirements.

### 6.1 Formalization classes

`deterministic`
: A linter, formatter, compiler, schema validator, contract test, hook, CI gate,
  or trusted command can return pass/fail evidence.

`procedural`
: A script can prove that a required artifact or step exists, ran, and produced
  an expected result.

`cognitive`
: The rule guides design judgment but does not have a sound automatic verifier.
  It is compiled into scoped agent context and may be evaluated, but it is never
  called a hard constraint.

### 6.2 Enforcement states

`proposed -> approved -> configured -> verified`

The canonical policy records only whether a policy is proposed, active, or
disabled. The generated manifest records the observed enforcement state. If an
adapter is missing, the manifest reports `blocked`; if the rule has no sound
verifier, it reports `guidance`. Keeping observed state out of `policy.yaml`
prevents verification from mutating the owner-approved source of truth.

## 7. Agent adapters

### 7.1 Portable adapter

The portable target is `AGENTS.md` plus
`.harness/generated/effective-policy.md`. The root instruction file contains a
small managed block with:

- current policy digest;
- command for session preflight;
- instruction not to edit generated policy targets directly;
- pointers to scoped policy and verification commands.

### 7.2 Claude Code

Generate or safely merge `CLAUDE.md` so it imports the portable instructions and
contains only Claude-specific additions. Never duplicate the complete policy in
both files.

### 7.3 Codex

Use root and nested `AGENTS.md` files according to effective scope. Emit an
adapter verification showing which instruction files should be visible from
each working directory.

### 7.4 Future DeepSeek and GLM agents

Use the portable adapter until the runtime publishes stable instruction loading,
hook, permission, and MCP behavior. Add support through a capability descriptor,
not a model-name conditional.

### 7.5 Session continuity

`harness session start --agent auto` returns the effective policy digest and
creates a local session receipt. Native session hooks invoke it automatically.
When a runtime has no hook support, the managed instruction block requires the
agent to run it before implementation; deterministic commit and CI checks remain
the backstop.

## 8. Stack adapters

Every adapter has four responsibilities: discovery, planning, compilation, and
verification. It reports capabilities individually instead of returning a
single misleading `supported: true` value.

### 8.1 Full-stack TypeScript

Target profile: NestJS + Prisma + tRPC + Next.js.

Required capability areas:

- TypeScript strictness and project-reference awareness;
- scope-aware naming rules for identifiers and serialized data;
- formatter and linter integration selected from existing repository tools;
- package-boundary and restricted-import enforcement;
- test and build commands discovered from package scripts;
- Prisma schema validation and generated-client consistency;
- tRPC and frontend/backend type compatibility through compiler checks;
- migration and secret checks before merge.

The adapter must understand workspaces and must not assume one root package.

### 8.2 Python, Django, and React

Target profile: Django + Pydantic + PostgreSQL + Celery + React/TypeScript + K8s.

Required capability areas:

- Python naming, formatting, import, and static-analysis enforcement;
- type checker selection based on repository evidence or owner decision;
- Django system checks, tests, and unapplied-migration detection;
- Pydantic boundary and serialization contract tests;
- Celery task-name, payload, and retry-policy checks where formalizable;
- Python/backend and React/frontend casing conversion at an explicit boundary;
- independent reuse of the TypeScript frontend adapter;
- Kubernetes delivery checks from the deployment adapter.

The adapter must not generate ESLint or npm CI for Python-only modules.

### 8.3 Go, gRPC, and TypeScript frontend

Target profile: Go + sqlc or ent + PostgreSQL + gRPC + K8s + TypeScript.

Required capability areas:

- formatting, vetting, static analysis, and tests using the detected Go module;
- Go mixed-cap naming conventions and package-boundary checks;
- proto lint and breaking-change checks when the project has a proto toolchain;
- generated-code consistency for sqlc or ent;
- schema and migration checks for PostgreSQL;
- explicit conversion between proto fields, database columns, Go identifiers,
  and frontend JSON;
- independent reuse of the TypeScript frontend adapter;
- Kubernetes delivery checks from the deployment adapter.

### 8.4 Kubernetes delivery

Detect raw manifests, Helm, and Kustomize separately. Select validators from
existing repository tools or an owner-approved plan. Verify syntax, schema,
policy, secret exposure, immutable image references, and deployment overlays
only when a sound validator is configured.

## 9. CLI contract

```text
harness doctor
harness intake [--project DIR] [--json]
harness research github [--project DIR] [--json]
harness discover [--project DIR] [--json]
harness plan [--project DIR] [--json]
harness apply --plan FILE --approve SHA256 [--json]
harness check [--mode session|commit|ci] [--json]
harness context [--agent auto|portable|claude|codex] [--json]
harness drift [--project DIR] [--json]
harness explain POLICY_ID [--json]
harness rollback --change-set ID [--json]
```

All commands have stable JSON output and meaningful exit codes. Human-readable
output is a view over the same structured result.

No command infers approval from an interactive `yes`. Approval is bound to a
plan hash and the owner identity recorded by the Skill.

## 10. Skill design

The final `SKILL.md` should remain below 250 lines and contain only:

- trigger and upstream readiness conditions;
- the five-stage orchestration flow;
- rules for asking owner decisions one at a time;
- approval and safety boundaries;
- routing to stack and agent references;
- required command invocations and result handling;
- completion criteria.

Detailed schemas, adapter rules, examples, and command output formats belong in
`references/`. Repeated filesystem or JSON work belongs in `scripts/`.

The description must trigger when users:

- finalize a PRD or design and are about to implement;
- ask to establish repository engineering rules;
- need consistency across new coding-agent sessions;
- want to inspect, update, validate, or roll back engineering policy;
- report different agents interpreting the same repository differently.

## 11. Safety invariants

1. Default every mutation workflow to plan-only.
2. Bind apply to the exact approved plan hash.
3. Require current-file hashes before patching.
4. Use atomic writes and retain a change manifest.
5. Roll back only files and managed sections owned by the selected change set.
6. Never represent a skipped file with empty content.
7. Never overwrite unmanaged configuration sections.
8. Make repeated apply idempotent.
9. Do not install dependencies, execute migrations, or change CI without the
   approved plan listing the action.
10. Never execute commands copied from PRD or research text. Commands originate
    from trusted adapters or existing repository scripts.
11. Redact secrets from discovery, plans, logs, and session receipts.
12. Treat a failed verification as a failed apply unless the approved plan
    explicitly marks the verifier advisory.

These invariants are release blockers. They directly replace the current backup
and rollback behavior that can lose nested or pre-existing files.

## 12. Verification and cross-session evaluation

### 12.1 Fixture repositories

Maintain realistic fixture projects for all three stack paths. Each fixture must
contain valid and intentionally invalid cases for naming, boundary conversion,
contract drift, test gates, generated code, and deployment configuration.

### 12.2 Adapter contract tests

For every adapter:

1. Discover the fixture correctly.
2. Produce a deterministic plan.
3. Apply without touching unmanaged content.
4. Reject known invalid fixtures.
5. Pass valid fixtures.
6. Re-apply with no diff.
7. Roll back to byte-identical input.

### 12.3 Fresh-session evaluation

Run equivalent small implementation tasks in clean sessions with portable,
Claude, and Codex adapters. Evaluate policy invariants, contract compatibility,
and required verification—not superficial source similarity.

Report:

- first-pass deterministic-policy conformance;
- violations by policy and adapter;
- missing or stale policy digest;
- manual corrections caused by cross-session interpretation differences;
- false positives and false negatives from each verifier.

Do not call this an A/B test unless assignments, sampling, and statistical
analysis are real.

## 13. Implementation sequence

### P0 — Trust and single source

- Extract one core application service for CLI and MCP.
- Replace unsafe write, backup, and rollback logic.
- Establish policy, plan, manifest, and change-set schemas.
- Make `skill/SKILL.md` the only authored Skill source; generate all packaged
  and installed copies from it.

### P1 — Portable flow and TypeScript

- Implement intake, discover, plan, apply, check, drift, and rollback.
- Implement portable, Claude, and Codex adapters.
- Implement full-stack TypeScript adapter and fixtures.
- Replace the current installer-only CLI with subcommands while preserving an
  explicit `harness install` command.

### P2 — Python and mixed frontend

- Implement Django, Pydantic, Celery, PostgreSQL, and React/TypeScript adapters.
- Add boundary-specific casing and contract fixtures.

### P3 — Go, gRPC, data generation, and K8s

- Implement Go, proto, sqlc/ent, PostgreSQL, TypeScript, and K8s adapters.
- Add generated-code and breaking-contract verification.

### P4 — Research and measured continuity

- Implement structured GitHub wheel research.
- Implement session receipts and fresh-session evaluation.
- Add real policy-effect telemetry only after the event collection contract is
  validated.

## 14. Completion criteria

The v2 Skill is complete only when:

- PRD/design intake and owner approval are traceable by hash;
- each of the three stack paths has a real fixture and executable verifier;
- portable, Claude, and Codex sessions receive the same policy digest;
- deterministic policies reject known invalid code;
- generated targets and existing repository files merge without data loss;
- plan/apply is idempotent and rollback is byte-identical;
- packaged and installed Skill copies are generated from one source;
- forward tests in fresh sessions satisfy declared policy invariants.
