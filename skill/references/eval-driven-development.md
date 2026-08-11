# Eval-driven development

Use this quality profile only when success includes non-deterministic AI or
agent behavior that normal tests cannot fully specify. Deterministic projects
keep their existing type, unit, integration, and contract gates.

## Sequence

```text
approved PRD/design
  -> define representative eval tasks and graders
  -> record an honest pre-implementation or adoption baseline
  -> owner approves sources with intake
  -> discover
  -> plan --quality-profile eval-driven-development
  -> exact-hash apply
  -> implement with normal TDD
  -> check --mode ci runs the approved eval runners
```

For a new behavior, `pre-implementation` means the evidence was actually
captured before implementation. For an existing eval system, use `adoption` to
freeze the current accepted commit. Do not infer, reconstruct, backdate, or
rename legacy evidence as pre-implementation. If requirements, traceability,
tasks, baseline evidence, calibration evidence, `runnerSources`, known-bad fixture/control, or
targets change, run intake and plan again because the old approval is no longer
valid.

## Minimal contract

Create `evals/evals.json`. Every task, evidence, fixture, and `runnerSources`
entry is repo-relative and enters intake approval and drift checks; runner
sources may include a top-level manifest such as `pyproject.toml`:

```json
{
  "$schema": "../docs/api/eval-contract-v1.schema.json",
  "schemaVersion": "1.1",
  "suites": [
    {
      "id": "answer-quality",
      "kind": "capability",
      "owner": "project-owner",
      "description": "Answer representative support questions correctly.",
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
        { "id": "outcome-tests", "kind": "code", "role": "gate" },
        { "id": "rubric-judge", "kind": "model", "role": "guidance" }
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

Commands are argv arrays. Shell interpreters such as `sh -c`, `bash -c`,
PowerShell, and `cmd` are rejected. The project runner owns credentials, model
calls, retries, metric calculation, and the decision to exit successfully when
the approved threshold is met. The negative control is project-owned and must
reject its known-bad fixture with exactly `expectedExitCode`; it is an
enforcement proof, not a quality score. Intake hashes every ordinary file under
`evals/` and `docs/evals/`, and every explicitly declared `runnerSources`
manifest or runner input, fixtures, and non-JSON datasets.

## Observations and rule changes

`passing` means the positive suite runner exited `0`. `enforced` means the
negative control rejected its fixture with the exact approved non-zero exit
code. A suite can be passing but unenforced, or enforced but failing; CI is
verified only when both are true. Legacy `1.0` contracts stay readable: a missing
origin reports `legacy-unknown`, while a supplied origin remains intact. They
cannot claim enforced, even if they already carry optional hardened fields, until
migrated to `1.1`.

For a natural-language add/modify/delete request, trace an approved
Requirement ID to its suite and stable rule IDs, then show the task, known-bad
fixture, runner, baseline origin, target impact, and lost coverage. Make only
the smallest project-owned source edit, run the deterministic contract and
control locally, then repeat `intake -> discover -> plan -> exact-hash apply ->
check --mode ci -> drift`.

Deletion, threshold reduction, grader demotion, task/fixture removal, broader
exclusions, or unclear coverage impact is a weakening. Before editing, obtain
explicit project-owner approval that names every affected Requirement ID and
rule ID. A generic “continue” is not approval. Harness does not provide a
generic eval CRUD CLI, generate project eval code, host datasets, or call model
Providers.

## Graders and metrics

Prefer outcome tests, exact state checks, schemas, static analysis, and other
code graders. Use a model grader for subjective criteria only. A model grader
with `role: "gate"` must include a repository-relative `calibrationEvidence`
file recording comparison with human judgment; otherwise keep it as guidance.

- `pass-at-1`: first-attempt success, useful for coding/user-facing tasks.
- `pass-rate`: successful trials divided by total trials.
- `pass-all-trials`: reliability where every configured trial must succeed.

Harness validates the contract and runs the approved command. It does not infer
whether the runner calculated a metric correctly; that runner remains normal
project code and needs its own tests.
