# Contract-first TDD/EDD integration plan

**Issue:** realpkuasule/harness-automation#19

**Owner:** realpkuasule

**Status:** implementation approved by the user

**Date:** 2026-08-09

## Outcome

Add an opt-in, stack-neutral `eval-driven-development` quality profile. Harness
must freeze evaluation intent before implementation, discover project-owned eval
runners, execute them only in CI mode, and report evidence without becoming a
hosted evaluation platform.

Harness itself will use contract tests first, RED behavior tests second, and the
repository test suite as its regression eval.

## Product boundary

- EDD is optional for target repositories and orthogonal to stack, delivery, and
  domain profiles.
- A project enables it with `--quality-profile eval-driven-development`.
- The project owns its tasks, graders, datasets, credentials, and runner.
- Harness owns contract validation, approved-source hashing, policy compilation,
  argv execution, observed state, drift protection, and a local immutable run
  receipt.
- Harness does not host datasets, call a model provider directly, calculate
  provider-specific statistics, or require paid evals during plan/apply/session/
  commit checks.

## Public contract

### CLI

```text
harness-automation plan \
  --profile custom \
  --stack typescript \
  --quality-profile eval-driven-development

harness-automation check --mode ci
```

`plan` rejects an enabled EDD profile unless the approved source set includes a
valid `evals/evals.json`. `check --mode ci` runs each approved suite command as
argv and returns its command result plus an evaluation receipt path and hash.

### MCP

`harness_plan.qualityProfiles` accepts only `eval-driven-development`. MCP and
CLI continue to call the same service layer.

### Policy document

`project.qualityProfiles` is optional for backward compatibility and contains:

```json
["eval-driven-development"]
```

Stable policy IDs:

- `eval-contract-before-implementation` — procedural: the owner-approved eval
  contract, task sources, baseline, and target exist before implementation.
- `eval-regression-gate` — deterministic when the project runner exits according
  to its approved target; execution occurs only in CI mode.
- `eval-evidence-provenance` — procedural: suite inputs and baseline/calibration
  evidence are approved and hash-protected.
- `eval-judge-calibration` — cognitive guidance: a model grader cannot be a hard
  gate without recorded human calibration evidence.

### Eval contract

`evals/evals.json` follows `docs/api/eval-contract-v1.schema.json` and contains:

- `schemaVersion: "1.0"`;
- one or more uniquely identified capability or regression suites;
- portable argv `command` with no shell string;
- approved relative task paths;
- an implementation-before baseline with score, trial count, and evidence path;
- target metric, threshold, and trial count;
- code/model/human graders and their gate/guidance role;
- calibration evidence for every model grader used as a gate.

All contract, runner, task, baseline, and calibration files under `evals/` or
`docs/evals/` are included in intake SHA-256 snapshots. Referenced paths must be
relative, remain inside the repository, exist, and belong to the approved eval
source set.

## Contract-first implementation order

1. Extend the policy schema and add the eval-contract schema.
2. Add TypeScript contract types and constants.
3. Add RED tests for schema-visible CLI/MCP behavior and invalid contracts.
4. Add RED service tests for profile orthogonality, source drift, CI-only
   execution, failure propagation, and receipts.
5. Implement the minimum parser, discovery, compiler, and service changes.
6. Update Skill instructions, references, README, and changelog.
7. Run full validation and inspect the final diff against this contract.

## TDD matrix

| Contract | RED evidence | Passing evidence |
|---|---|---|
| Quality profile is orthogonal | service policy test | unchanged stack/delivery/domain arrays plus quality array |
| Missing contract is rejected | plan test | `EVAL_CONTRACT_REQUIRED` |
| Unsafe or malformed contract is rejected | eval parser tests | stable validation error |
| Model gate requires calibration | eval parser test | guidance accepted; uncalibrated gate rejected |
| Eval runner is CI-only | trusted-check test | absent in session/commit, present in CI |
| Failing eval blocks CI | trusted-check test | `ok: false`, failed command |
| Successful eval produces evidence | trusted-check test | immutable receipt path/hash and command evidence |
| Contract/task drift invalidates apply | existing precondition test extension | `SOURCE_DRIFT`/stale precondition |
| CLI and MCP share enum | CLI/MCP tests | both expose/accept the same profile |
| Existing profiles remain valid | existing suite | no regressions in plan/apply/check/rollback |

## EDD cases for the Skill

The shipped Skill eval set covers:

1. an AI feature project with no eval contract — stop before planning and explain
   the required contract;
2. a deterministic non-AI project — do not force EDD;
3. a project using an uncalibrated model judge — keep it as guidance, not a hard
   gate.

These cases are stored as portable eval prompts. Repository tests validate their
shape; live cross-model execution remains manual/dogfood because it is paid and
non-deterministic.

## Conflict self-check and resolution

| Conflict | Resolution |
|---|---|
| Contract-first requires evals before implementation, while EDD is optional | Require the contract only when the owner selects the quality profile |
| Intake happens before profile selection | Intake automatically snapshots eval sources when present; plan enforces their presence only for EDD |
| TDD needs fast RED/GREEN while agent evals can be slow or paid | Unit/contract tests run locally; project eval commands run only in CI mode |
| Deterministic policy status vs stochastic graders | Harness gates only on the approved runner exit status; uncalibrated model graders are guidance |
| Language-neutral product vs package-manager scripts | Contract stores argv directly; no npm-only convention is required |
| Eval evidence vs secrets and large transcripts | Receipt stores hashes/status/argv, not environment variables or raw transcripts |
| New field vs existing v2 repositories | `qualityProfiles` and discovery evaluation metadata are optional when reading old state |
| Eval commands vs recursive Harness commands | Only commands parsed from the eval contract receive `eval:<suite>` IDs; policy verification commands are not executed generically |
| Apply verification vs paid evaluation | Apply validates the contract and generated policy only; it never runs eval suites |

## Planned paths

- `docs/api/harness-policy-v2.schema.json`
- `docs/api/eval-contract-v1.schema.json`
- `mcp-server/src/v2/types.ts`
- `mcp-server/src/v2/evals.ts`
- `mcp-server/src/v2/evals.test.ts`
- `mcp-server/src/v2/discovery.ts`
- `mcp-server/src/v2/policy.ts`
- `mcp-server/src/v2/service.ts`
- `mcp-server/src/v2/service.test.ts`
- `mcp-server/src/v2/cli.test.ts`
- `mcp-server/src/v2/mcp.test.ts`
- `mcp-server/src/cli.ts`
- `mcp-server/src/index.ts`
- `skill/SKILL.md`
- `skill/references/workflow.md`
- `skill/references/policy-model.md`
- `skill/evals/evals.json`
- `mcp-server/package.json`
- `README.md`
- `CHANGELOG.jsonl`

## Acceptance commands

```bash
cd mcp-server
npm test
npx tsc --noEmit
npm run lint
npm run prepublishOnly
npm pack --dry-run --json
cd ..
python3 -m unittest discover -s scripts/tests
git diff --check
```

Completion also requires a requirement-by-requirement diff audit, clean tracked
worktree state apart from the user's existing `.harness/plans/`, and Issue #19
updated with verification evidence.
