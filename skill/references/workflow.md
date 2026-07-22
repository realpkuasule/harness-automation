# Workflow and owner interaction

## Upstream handoff

Harness starts after this sequence:

1. Requirements are grilled and written to `docs/PRD.md`.
2. Reusable GitHub projects are researched under `docs/research/`.
3. The PRD and design are revised using that evidence.
4. The project owner declares the source set ready.
5. Harness compiles and verifies policy before parallel implementation begins.

When the current conversation finalizes a PRD or design, ask: “需求与设计已经达到可冻结状态，是否现在启动 Harness，在开发前建立跨会话约束？” This is a handoff prompt only. Do not edit the `grill-me` Skill.

## Question discipline

Discover facts first. Ask only decisions with material policy consequences, one at a time. State:

- the evidence recovered from the repository or approved documents;
- the recommended decision and why;
- the alternatives and migration cost;
- whether the result will be deterministic enforcement or review guidance.

The owner must explicitly approve source readiness and the exact plan hash. Other choices may be recorded as proposed policy but may not be applied.

When discovery returns `custom`, record the exact owner-approved stack list before planning. Never translate “use a preset as a baseline, but exclude some of its frameworks” into the full preset. Use `--profile custom` with repeated `--stack` values instead, and surface selected-but-unobserved stacks in the plan warnings.

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

`plan` writes only a new immutable file under `.harness/plans/`. `apply` performs all precondition checks before any target is written and restores already-written targets if a later write fails.

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

Report completion only when apply succeeded and all deterministic rules report `enforced: true` and `passing: true`. Apply runs session-level enforcement immediately and restores every target if that verification fails. Cognitive policies stay `guidance`; unavailable runtimes stay `blocked`. Include the policy digest, change ID, verification result, and exact rollback command.
