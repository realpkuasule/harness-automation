# Eval-driven development

Use this quality profile only when success includes non-deterministic AI or
agent behavior that normal tests cannot fully specify. Deterministic projects
keep their existing type, unit, integration, and contract gates.

## Sequence

```text
approved PRD/design
  -> define representative eval tasks and graders
  -> run and record the pre-implementation baseline
  -> owner approves sources with intake
  -> discover
  -> plan --quality-profile eval-driven-development
  -> exact-hash apply
  -> implement with normal TDD
  -> check --mode ci runs the approved eval runners
```

Do not reconstruct a baseline after implementation. If requirements, tasks,
baseline evidence, calibration evidence, or targets change, run intake and plan
again because the old approval is no longer valid.

## Minimal contract

Create `evals/evals.json` and keep every referenced file under `evals/` or
`docs/evals/`:

```json
{
  "$schema": "../docs/api/eval-contract-v1.schema.json",
  "schemaVersion": "1.0",
  "suites": [
    {
      "id": "answer-quality",
      "kind": "capability",
      "owner": "project-owner",
      "description": "Answer representative support questions correctly.",
      "command": ["python3", "evals/run.py"],
      "tasks": ["evals/tasks.jsonl"],
      "baseline": {
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
      ]
    }
  ]
}
```

Commands are argv arrays. Shell interpreters such as `sh -c`, `bash -c`,
PowerShell, and `cmd` are rejected. The project runner owns credentials, model
calls, retries, metric calculation, and the decision to exit successfully when
the approved threshold is met. Intake hashes every ordinary file under `evals/`
and `docs/evals/`, including runner source and non-JSON datasets.

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
