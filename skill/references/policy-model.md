# Policy model

`.harness/policy.yaml` is the owner-approved source of truth. It currently contains JSON, which is a valid YAML 1.2 subset and keeps the compiler dependency-free and deterministic.

Each policy records:

- stable ID, owner, rationale and approved source references;
- include/exclude scope and affected boundaries;
- severity and formalization class;
- compilation targets;
- argv-based verification commands and pass criteria;
- examples and change-control requirements.

## Formalization classes

- `deterministic`: an AST checker, formatter, compiler, schema validator, contract test or trusted command can return sound pass/fail evidence.
- `procedural`: Harness can prove that a required step or artifact exists, but not the complete semantic outcome.
- `cognitive`: design/review judgment. It is loaded into agent context and never presented as a hard gate.

## Observed state

Observed state belongs in verification output, not the canonical policy:

- `configured`: target files exist with expected hashes.
- `loaded`: the Agent instruction path exposes the current policy digest.
- `enforced`: an invalid fixture is rejected by the real verifier.
- `passing`: the current repository passes that verifier.

The aggregate status is `verified`, `failing`, `blocked`, or `guidance`.

## Change control

Policy changes use the same intake/discover/plan/apply pipeline. Naming-policy changes require a migration because existing identifiers and serialized boundaries may need coordinated compatibility work. Generated targets must never be hand-edited.
