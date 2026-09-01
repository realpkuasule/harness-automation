# Effective Engineering Policy

Policy digest: `83c535d6a9cb39cffe97788e156980926adee861d3ebc4e98c65f76f20c79789`
Owner: zhichao
Stack: typescript

This file is generated. Change `.harness/policy.yaml`, obtain owner approval, and recompile instead of editing this file.

## Stack adapter coverage

- `typescript`: built-in deterministic support.

## 1. Single implementation owner (single-implementation-owner)

Before implementation, search for an existing implementation and record the owning module; do not create a parallel implementation of the same capability.

- Severity: error
- Formalization: procedural
- Verify with: `harness-automation context --project .`
## 2. Contract-first interface changes (contract-first-change)

Change shared API, RPC, schema, database, or queue contracts before changing consumers; update compatibility tests in the same change.

- Severity: error
- Formalization: cognitive
- Verify with: owner review
## 3. Generated files are immutable (generated-files-immutable)

Never edit generated code or Harness compiler outputs directly; change their source and regenerate them.

- Severity: error
- Formalization: procedural
- Verify with: `harness-automation drift --project .`
## 4. TypeScript naming (typescript-naming)

Use camelCase for variables, functions, parameters, methods, and local properties; PascalCase for classes, interfaces, types, enums, React components, and exported Zod schemas; UPPER_SNAKE_CASE is allowed for module constants, imported constants, and static readonly class constants. Node __dirname/__filename and the exact unused-parameter placeholder _ are allowed.

- Severity: error
- Formalization: deterministic
- Verify with: `harness-automation check --project .`
## 5. Evaluation contract before implementation (eval-contract-before-implementation)

Define Requirement/rule traceability, representative tasks, graders, an honest pre-implementation or adoption baseline, a known-bad control, and an explicit target in evals/evals.json before enforcing an evaluated capability.

- Severity: error
- Formalization: procedural
- Verify with: owner review
## 6. Evaluation regression gate (eval-regression-gate)

Run every approved evaluation suite and project-owned known-bad control in CI; passing and enforcement are independent and delivery is rejected unless both succeed.

- Severity: error
- Formalization: deterministic
- Verify with: `node evals/run_npm_release_policy.mjs`
## 7. Evaluation evidence provenance (eval-evidence-provenance)

Keep evaluation tasks, baselines, and grader calibration evidence in approved repository sources protected by SHA-256 drift checks.

- Severity: error
- Formalization: procedural
- Verify with: owner review
## 8. Model grader calibration (eval-judge-calibration)

Treat model graders as guidance unless human calibration evidence is recorded; only calibrated model graders may participate in a hard gate.

- Severity: error
- Formalization: cognitive
- Verify with: owner review
