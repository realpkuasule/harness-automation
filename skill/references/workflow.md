# Workflow and owner interaction

## Upstream handoff

Harness starts after this sequence:

1. Requirements are grilled and written to `docs/PRD.md`.
2. Reusable GitHub projects are researched under `docs/research/`.
3. The PRD and design are revised using that evidence.
4. The project owner declares the source set ready.
5. If EDD is selected, representative tasks, graders, and an implementation-before baseline are recorded under `evals/` before intake.
6. Harness compiles and verifies policy before parallel implementation begins.

When the current conversation finalizes a PRD or design, ask: “需求与设计已经达到可冻结状态，是否现在启动 Harness，在开发前建立跨会话约束？” This is a handoff prompt only. Do not edit the `grill-me` Skill.

## Question discipline

Discover facts first. Ask only decisions with material policy consequences, one at a time. State:

- the evidence recovered from the repository or approved documents;
- the recommended decision and why;
- the alternatives and migration cost;
- whether the result will be deterministic enforcement or review guidance.

The owner must explicitly approve source readiness and the exact plan hash. Other choices may be recorded as proposed policy but may not be applied.

When discovery returns `custom`, record the exact owner-approved stack list before planning. Never translate “use a preset as a baseline, but exclude some of its frameworks” into the full preset. Use `--profile custom` with repeated lowercase kebab-case `--stack` values instead, and surface selected-but-unobserved stacks in the plan warnings.

Stack identifiers are open, not a closed preset enum. If a selected stack has no built-in adapter, continue the normal plan/apply/check/rollback lifecycle with generic continuity policies. Report the stack adapter as `blocked`; do not stop Harness and do not create a parallel approval, hash-lock, drift, or rollback implementation in the target repository. Preserve stack-specific guidance outside the Harness-managed `AGENTS.md` block, and expose repository-owned deterministic gates through conventional `verify:*`, `*:check`, `test:*`, or `build:*` package scripts.

## Safe command sequence

```text
doctor
  -> research github (only when evidence is missing)
  -> intake --approve-sources
  -> discover
  -> owner decisions (only if discovery is ambiguous)
  -> plan
  -> show paths, hashes, commands, warnings
  -> exact-hash approval
  -> apply
  -> check --mode session
  -> drift
```

When `eval-driven-development` is selected, `evals/evals.json` and every referenced task/baseline/calibration file must already belong to the approved intake. Discovery exposes each suite as an `eval:<suite-id>` argv command. Only `check --mode ci` executes these commands; plan, apply, session, and commit paths remain free of paid/non-deterministic execution.

`plan` writes only a new immutable file under `.harness/plans/`. `apply` performs all precondition checks before any target is written and restores already-written targets if a later write fails.

After policy initialization, hand daily workspace lifecycle work to `manage-worktree-delivery`. Its read-only audit path does not require PRD intake. Persistent allocate/close/configure operations still use immutable plan, exact hash, drift recheck, apply, and durable receipt.

## Research evidence

The deterministic `research github` command records queries and candidate metadata. It is discovery, not a final adoption recommendation. For shortlisted candidates, use available GitHub integration and official documentation to record:

- repository and official documentation URL;
- license and release compatibility;
- maintenance and security signals;
- fit with the chosen architecture;
- integration and migration cost;
- rejection reason or the exact design decision supported.

Never treat stars as the primary criterion.

## Completion language

Report generic Harness setup completion only when apply succeeded and all required deterministic rules report `enforced: true` and `passing: true`. Apply runs session-level enforcement immediately and restores every target if that verification fails. Cognitive policies stay `guidance`; unavailable runtimes and unknown stack adapters stay `blocked`. A successful generic baseline is not full stack enforcement. Include the policy digest, change ID, verification result, blocked adapter coverage, and exact rollback command.
