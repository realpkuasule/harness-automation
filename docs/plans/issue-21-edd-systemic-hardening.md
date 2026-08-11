# Issue #21 — EDD systemic hardening contract and RED plan

**Issue:** realpkuasule/harness-automation#21
**Owner:** realpkuasule
**Branch:** `codex/21-edd-systemic-hardening`
**Date:** 2026-08-11
**Status:** contract-first implementation input

## Outcome

Make Eval-driven development evidence honest and continuous across sessions:

1. trace an approved Requirement ID to the suite and project-owned rule that
   verifies it;
2. report `passing` only from the normal suite and `enforced` only after a
   project-owned known-bad control is rejected;
3. admit an existing eval system with an explicit adoption baseline without
   pretending that it is pre-implementation evidence;
4. let the Skill translate natural-language add/modify/delete requests into
   auditable source changes and the existing intake/plan/hash/apply workflow;
5. let `doctor` detect stale or missing installed Skill copies without writing
   to the host.

The change remains an extension of the existing policy compiler. Harness does
not become an eval runner platform, dataset host, model Provider, or generic
Eval CRUD generator.

## Current-state diagnosis

- `docs/api/eval-contract-v1.schema.json` and `mcp-server/src/v2/evals.ts`
  accept only `schemaVersion: "1.0"`. A suite has no Requirement ID mapping,
  negative control, or declared baseline origin.
- `mcp-server/src/v2/service.ts` currently sets evaluation `enforced` whenever
  the positive CI runner is not blocked. A successful runner can therefore be
  both `passing: true` and `enforced: true` without rejecting a known-invalid
  fixture. This contradicts the repository's documented observed-state model.
- A missing negative control cannot be distinguished from a passing one because
  neither the discovery model nor the receipt records it.
- `doctorProject` checks tools and repository artifacts only. The installer
  copies two packaged Skills to `.claude`, `.codex`, and `.agents`, but no
  read-only command compares those copies with the package that owns the
  running CLI.
- The Skill requires an implementation-before baseline and correctly forbids
  reconstruction, but it has no honest entry path for a repository that already
  has production code and evals.

## Contract decisions

### 1. Backward-compatible Eval Contract v1 extension

Keep `docs/api/eval-contract-v1.schema.json`; do not introduce a v2 contract.
The parser accepts both minor versions:

- `1.0`: legacy shape, still readable and discoverable; optional hardened fields
  remain readable, and only a missing baseline origin is normalized to
  `legacy-unknown`;
- `1.1`: hardened shape, required for new or migrated EDD enforcement.

The following fields are optional while reading a `1.0` contract and required
for every suite in a `1.1` contract:

```json
{
  "schemaVersion": "1.1",
  "suites": [
    {
      "id": "answer-quality",
      "kind": "capability",
      "owner": "project-owner",
      "description": "Answer approved support requests correctly.",
      "command": ["python3", "evals/run.py"],
      "runnerSources": ["evals/run.py", "pyproject.toml"],
      "tasks": ["evals/tasks.jsonl"],
      "traceability": [
        {
          "requirementId": "PRD-AI-004",
          "ruleIds": ["answer-cites-approved-source"]
        }
      ],
      "baseline": {
        "origin": "pre-implementation",
        "score": 0.35,
        "trials": 3,
        "evidence": "evals/baselines/initial.json"
      },
      "target": {
        "metric": "pass-rate",
        "threshold": 0.85,
        "trials": 5
      },
      "graders": [
        { "id": "outcome-tests", "kind": "code", "role": "gate" }
      ],
      "negativeControl": {
        "command": ["python3", "evals/run_negative.py"],
        "fixture": "evals/fixtures/known-bad-answer.json",
        "expectedExitCode": 1
      }
    }
  ]
}
```

Semantics:

- `traceability` is the validated Requirement ID → containing suite ID →
  `ruleIds` mapping. Requirement IDs are non-empty stable project IDs. Rule IDs
  use the existing lower-kebab stable-ID convention. The same requirement may
  be covered by more than one suite; duplicate mappings inside one suite are
  rejected.
- `baseline.origin` is exactly `pre-implementation` or `adoption`.
  `pre-implementation` means the evidence was captured before the feature was
  implemented. `adoption` freezes observed behavior when Harness first takes
  ownership of an existing eval system. Harness records the owner's declaration
  and hashes its evidence; it does not claim to prove historical timing.
- A legacy `1.0` baseline without `origin` is reported as `legacy-unknown`, never
  silently re-labelled `pre-implementation`.
- `runnerSources` is a required non-empty 1.1 list of repo-relative runner or
  manifest inputs. It is optional for readable 1.0 contracts, but all declared
  entries are included in intake approval, immutable plan snapshots, and drift
  checks. A 1.0 contract cannot claim enforced even if it already declares it.
- `negativeControl` is project-owned. Its fixture and declared runner inputs
  are repository-relative, enter intake hashing, and are drift-protected like
  the positive runner and tasks.
- `negativeControl.command` is subject to the same argv, repository-path, shell
  prohibition, executable-availability, timeout, and receipt rules as the
  positive command. `expectedExitCode` is an exact integer from 1 through 255;
  any other exit code, signal, timeout, or spawn error is not enforcement proof.
- Suite, grader, traceability, and rule IDs are checked for duplicates at their
  applicable scope. Every referenced fixture/evidence path must exist, remain
  inside the repository, and belong to the approved eval source set.

The 1.0 compatibility promise is parse/read compatibility, not a false success
promise. A 1.0 contract can still be discovered, planned, and migrated without
automatic rewriting, but cannot report `enforced: true` until it supplies a
valid project-owned negative control. New contract examples and Skill guidance
emit 1.1.

### 2. Passing and enforcement are independent observations

For each suite in `check --mode ci`:

- `passing` is true only when the positive suite command exits `0`;
- `enforced` is true only when the negative-control command exits with its exact
  approved `expectedExitCode`;
- `available` is true only when both required commands can be launched;
- aggregate `passing` and `enforced` are `every(...)` across all suites.

Aggregate status is deterministic:

| Observation | Status | CI gate |
|---|---|---|
| Positive passes and negative control is rejected exactly | `verified` | pass |
| Positive runner fails | `failing` | fail |
| Negative control runs but is accepted, crashes, times out, or exits unexpectedly | `failing` | fail |
| Legacy/missing negative control or a required executable is unavailable | `blocked` | fail |
| Session/commit mode | `not-run` | does not execute evals |

The evaluation receipt keeps the current no-transcript rule. It adds, per
suite, separate positive and negative observations containing only argv, status,
exit code, and output SHA-256. It also records `baselineOrigin`, Requirement IDs,
rule IDs, contract SHA-256, policy digest, timestamp, and receipt hash. It never
stores environment variables, credentials, raw output, model transcripts, or
fixture contents.

The `eval-regression-gate` policy result copies these independent booleans. A
positive failure may therefore be `enforced: true, passing: false`; an accepted
known-bad fixture may be `enforced: false, passing: true`. Only both true is
`verified`.

### 3. Existing eval-system adoption

The Skill offers two honest paths before owner-approved intake:

- New behavior: capture a real `pre-implementation` baseline before feature
  implementation begins.
- Existing behavior: capture an `adoption` baseline from the current accepted
  commit and label all output and receipts accordingly.

The Skill must not infer the path from Git history or wording. It asks only when
the repository evidence does not establish whether implementation already
exists. It must never reconstruct or backdate a pre-implementation baseline.
Changing origin, evidence, tasks, runner, target, graders, traceability, or
negative control invalidates the old source approval and plan.

## Natural-language Eval change protocol

This is Skill orchestration over project-owned files, not a new CLI CRUD API.
When the owner asks in natural language to add, modify, weaken, or delete an
Eval rule, the Skill must:

1. read the approved PRD/design, current contract, referenced task/fixture
   sources, runner, policy digest, and owning Requirement IDs;
2. resolve or propose stable `requirementId`, `suite.id`, and `ruleIds`, reusing
   existing IDs instead of creating aliases;
3. show the semantic delta: files, covered requirements, positive task, known-bad
   fixture, runner/gate, baseline origin, target effect, and lost coverage;
4. make the smallest project-owned source edit that expresses the approved
   rule and leave model/provider implementation to the project runner;
5. run the repository's smallest deterministic contract/runner tests, including
   the known-bad control, before asking the owner to freeze the new sources;
6. because eval sources changed, run owner-approved `intake`, `discover`, create
   a new immutable `plan`, display its full hash, require exact-hash approval,
   then `apply`, `check --mode ci`, and `drift`.

Deletion, threshold reduction, grader demotion, task/fixture removal, broader
exclusions, or any change whose coverage impact is ambiguous is a weakening.
Before editing, the Skill must obtain explicit project-owner approval that names
the affected Requirement IDs and rule IDs. “继续” or approval of an unrelated
plan is not sufficient. Additions and clear strengthenings still require normal
source-readiness and exact-plan-hash approval, but not the extra weakening
confirmation.

The Skill does not invent Requirement IDs when the approved product documents
have no stable requirement identity. It reports that gap and asks the owner to
name or approve one before the contract is frozen.

## Read-only Skill installation diagnosis

Extend `harness-automation doctor` with a `skillInstallations` observation for
both packaged Skills:

- `harness-automation`;
- `manage-worktree-delivery`.

For each Skill, compute one canonical SHA-256 directory digest from sorted POSIX
relative file paths plus each regular file's SHA-256. Use the exact packaged
source selected by the running CLI (normally `dist/skill` and
`dist/manage-worktree-delivery`), then compare it with:

- `~/.claude/skills/<name>`;
- `~/.codex/skills/<name>`;
- `~/.agents/skills/<name>`.

Do not follow symlinks or hash files outside the selected Skill root. Report a
symlink as `blocked`, a missing target as `missing`, a different digest as
`stale`, and an equal digest as `current`. The output includes the package
version/path, source digest, target path/digest, per-target status, aggregate
`inSync`, and the repair hint `harness-automation install`.

`doctor` is strictly diagnostic: it does not create directories, copy Skills,
run npm, register MCP, or call `install`. The explicit install command remains
the only repair path. CLI and MCP must use the same observation logic. Tests
inject temporary package/home roots and never read or write the developer's
actual home directories.

## Deterministic evals versus stochastic EDD

The name of a script is not a product classification. Discovering `eval`,
`evals`, `test:eval`, or a similar command must not automatically enable EDD or
claim Harness management.

- A deterministic business rule fully specified by types, schemas, unit,
  integration, replay, contract, or static-analysis tests stays a normal
  repository gate even if the project calls it an “eval”.
- Use `eval-driven-development` only when accepted behavior contains
  non-deterministic Agent, generation, retrieval, or model judgment that normal
  tests cannot fully specify, and the owner selects the quality profile.
- The EDD positive runner may evaluate stochastic behavior, but the
  negative-control proof itself must have a deterministic expected exit code.
- `doctor`/discovery may report a conventional eval script as an unmanaged
  candidate. This is advisory only: it does not execute it, generate a contract,
  change a quality profile, or set `configured`, `enforced`, or `passing`.

## RED acceptance tests

Write the tests first and confirm each fails for the intended missing behavior,
not from a malformed fixture.

### `mcp-server/src/v2/evals.test.ts`

1. **`accepts legacy 1.0 without inventing hardened evidence`**
   - Arrange the current 1.0 contract.
   - Assert parsing succeeds, baseline origin is observed as `legacy-unknown`,
     and no negative-control command appears.
2. **`loads 1.1 requirement traceability, adoption origin, runner sources, and negative control`**
   - Arrange two Requirement mappings and an adoption baseline.
   - Assert stable IDs, fixture, command, exact exit code, and referenced-source
     approval are retained, including a declared runner/manifest source.
3. **`rejects malformed hardened contracts deterministically`**
   - Table cases: duplicate trace mapping, duplicate rule ID, empty requirement
     ID, missing fixture, unapproved fixture, shell negative command, zero
     expected exit code, missing 1.1 origin, missing runner sources, and missing
     1.1 negative control.
   - Assert stable `EVAL_*` error prefixes.
4. **`does not relabel legacy baseline evidence as pre-implementation`**
   - Assert all read/discovery output uses `legacy-unknown` until the owner
     migrates the contract.

### `mcp-server/src/v2/service.test.ts`

5. **`separates positive passing from negative enforcement`**
   - Four table rows: `(positive 0, negative expected)`, `(positive nonzero,
     negative expected)`, `(positive 0, negative 0)`, and `(positive 0,
     negative unexpected nonzero)`.
   - Assert independent booleans, aggregate status, `policy.ok`, and
     `eval-regression-gate` exactly match the table above.
6. **`legacy contract can pass but cannot claim enforcement`**
   - Run an existing 1.0 positive command that exits 0.
   - Assert `passing: true`, `enforced: false`, `status: blocked`, and overall CI
     failure. This is the regression test for the current false claim.
7. **`blocks enforcement when a negative control cannot launch`**
   - Assert `available: false`, `enforced: false`, `status: blocked`, with no
     fallback to the positive runner result.
8. **`writes hash-only positive and negative receipt evidence`**
   - Assert both command observations, trace IDs, baseline origin, and receipt
     hash exist; assert stdout, stderr, secrets, transcript, and fixture contents
     do not occur in serialized receipt JSON.
9. **`executes neither positive nor negative eval commands outside CI mode`**
   - Assert session, commit, plan, and apply leave marker files absent and return
     `not-run` where applicable.
10. **`source drift covers traceability, adoption evidence, negative fixtures, and runner sources`**
    - Mutate each after planning and assert the existing source-drift guard
      rejects apply/check without partially updating generated targets.

### `mcp-server/src/v2/cli.test.ts` (or the smallest existing CLI test seam)

11. **`doctor reports current missing and stale skill copies without writing`**
    - Use temporary package/home roots containing equal, absent, and modified
      directory trees across all three agent homes and both Skill names.
    - Assert canonical digests, per-target status, `inSync`, and repair hint.
    - Snapshot tree paths/bytes before and after; assert byte-identical state.
12. **`doctor treats skill symlinks as blocked and never follows them`**
    - Point an installed Skill entry outside the temporary home.
    - Assert the external file is not read or changed and status is `blocked`.
13. **`doctor does not auto-adopt a conventional eval script`**
    - Add an `evals` package script without an Eval Contract or selected quality
      profile.
    - Assert any candidate is advisory and EDD remains unconfigured/unloaded/
      unenforced.

### Skill behavior evals and documentation assertions

14. Add portable Skill cases for:
    - adopting an existing eval system with `baseline.origin: adoption`;
    - adding a rule with Requirement/suite/rule traceability and a known-bad
      control;
    - refusing deletion/weakening until the owner explicitly approves named
      lost coverage;
    - re-running intake/discover/plan/exact-hash apply after any eval-source
      change;
    - keeping a deterministic project eval as a normal gate rather than forcing
      EDD.
15. Static tests assert the shipped Skill and EDD reference contain the same
    baseline-origin, weakening-approval, and passing/enforced semantics.

## Implementation sequence and path ownership

One source-code writer owns these paths in order; do not split overlapping
contract/service work across concurrent agents.

1. Contract and RED: `docs/api/eval-contract-v1.schema.json`,
   `mcp-server/src/v2/types.ts`, `mcp-server/src/v2/evals.test.ts`, and
   `mcp-server/src/v2/service.test.ts`.
2. Minimum GREEN parser/runtime: `mcp-server/src/v2/evals.ts`,
   `mcp-server/src/v2/service.ts`, and only the existing discovery/policy paths
   required to carry the new observations.
3. Read-only digest diagnosis: reuse Node `fs`, `path`, and `crypto` plus the
   existing Skill-source selection and SHA-256 helpers. Modify
   `mcp-server/src/cli.ts`, `mcp-server/src/v2/service.ts`, and their current
   tests; extract a shared helper only if that is the shortest way to prevent
   installer/doctor source-path drift.
4. Skill protocol and examples: `skill/SKILL.md`,
   `skill/references/eval-driven-development.md`, `skill/evals/evals.json`, and
   their existing static tests.
5. User contract and migration notes: `README.md`, relevant API/reference docs,
   and `CHANGELOG.jsonl` linked to Issue #21.

Do not edit the user's untracked `.harness/plans/` directory. Do not add a new
dependency, database, daemon, Provider adapter, hosted service, credential
store, generated Eval code, or automatic home-directory repair.

## Compatibility and migration

- Existing non-EDD projects and stack/delivery/domain profiles are unchanged.
- Existing 1.0 Eval Contracts remain readable and their positive commands may
  still run in CI, but the result is explicitly unenforced and blocking until a
  hardened 1.1 negative control and runnerSources declaration are approved. No
  file is auto-migrated.
- Migration is: assign stable Requirement/rule IDs, declare the honest baseline
  origin, add one known-bad fixture/runner per suite, update to `1.1`, run the
  project's control locally, then owner-approved intake → discover → plan →
  exact-hash apply → CI check → drift.
- Existing pre-implementation evidence can retain that origin when the owner
  can attest it. Otherwise migrate to `adoption`; never infer or backdate it.
- Receipt consumers must tolerate the additive positive/negative and
  traceability fields. Existing top-level fields and status vocabulary remain.
- `doctor` adds JSON fields only. It does not change install behavior, and stale
  copies remain usable until the user explicitly runs the repair command.

## Explicit non-goals

- No `eval add|modify|delete` CLI and no natural-language-to-code generator.
- No GitHub/GitLab/Jira or model Provider adapter.
- No hosted datasets, graders, trials, retry/statistics engine, transcript
  storage, secret management, or paid eval execution outside project CI.
- No inference that an npm script name, existing test, or model grader is EDD.
- No automatic rewriting of 1.0 contracts, automatic Skill installation, or
  deletion of stale Skill directories.
- No claim that a negative exit code proves semantic quality beyond the exact
  owner-approved known-bad control.

## Verification and completion evidence

```bash
cd /Users/zhichao/codex/harness-automation/mcp-server
npm test
npx tsc --noEmit
npm run lint
npm run prepublishOnly
npm pack --dry-run --json

cd /Users/zhichao/codex/harness-automation
python3 -m unittest discover -s scripts/tests
bash skill/install.test.sh
git diff --check
```

Completion requires a requirement-by-requirement audit, not only green tests:

- schema and runtime both accept 1.0 and validate 1.1 identically;
- a green legacy positive runner is observed as passing but not enforced;
- each 1.1 suite rejects its project-owned negative control exactly;
- adoption is visible in contract, discovery/policy output, and receipt without
  any pre-implementation claim;
- natural-language deletion/weakening cannot proceed without named owner
  approval and all eval-source changes traverse the full hash workflow;
- `doctor` detects equal, missing, stale, and symlinked copies for both Skills in
  all three agent homes and produces zero filesystem changes;
- deterministic business gates remain outside EDD unless the owner explicitly
  selects the quality profile;
- packaging contains the updated Skill/reference/schema artifacts;
- tracked worktree changes are limited to Issue #21 scope, with the user's
  existing `.harness/plans/` left untouched.
