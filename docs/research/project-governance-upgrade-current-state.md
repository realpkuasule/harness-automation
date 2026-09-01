# Project Governance Update: Current-State Evidence

Date: 2026-09-01
Issue: `realpkuasule/harness-automation#69`

This is repository evidence, not an external library survey. The requested capability is an orchestration of mechanisms already owned by this repository; adding a third-party migration or workflow dependency would duplicate those mechanisms.

## Findings

| Concern | Current evidence | Consequence |
|---|---|---|
| explicit profile preservation | `planProject` accepts profiles as caller arguments; absent delivery/domain/quality arrays become `[]`. Legacy `PolicyDocument.project` may not persist `profile`. | The update planner must inherit from policy/discovery and must not route missing CLI flags to empty arrays. |
| compiler identity | `.harness/manifest.json` records `"compiler": "harness-automation@2"`; policy records no compiler identity. Package metadata is `@realpkuasule/harness-automation` with an exact semver. | Legacy state is unknowable, while new output can use the executing package metadata without network access. |
| source approval | `ensureApprovedSources` compares every intake source SHA-256 to repository bytes and ordinary plans bind `intakeHash`, `discoveryHash` and `sourceHashes`. | Update planning invokes this before writing a plan and retains the same preconditions. |
| discovery | `discoverProject` is a pure repository inspection; `discoverAndSave` is the wrapper that writes `.harness/discovery.json`. | Update can recompute discovery in memory and reject semantic drift without mutating discovery. |
| immutable file plan | `ChangePlan` contains project/intake/discovery/source hashes, all file operations, commands, warnings and a canonical SHA-256. | Update metadata can be embedded in this plan; a second plan envelope is unnecessary. |
| exact apply and atomicity | `applyPlan` routes non-workspace plans to `applyFilePlan`; it verifies embedded/full approval hashes, all inputs and target before hashes, writes atomically, runs `checkProject`, and restores written targets on failure. | Update uses this executor unchanged except for validating update-specific weakening evidence. |
| receipts/rollback | Applied file plans persist `.harness/changes/<id>/change.json` plus exact before bytes; `rollbackChange` refuses drift and restores in reverse order. | Existing receipt and rollback already meet update history/recovery needs. |
| naming adoption | Current code binds sorted stable fingerprints to `typescript-naming` and an intake hash, intersects an old baseline with observed violations by default, and requires fresh explicit intake for expansion. | Update should call the same transition, not create waivers or another baseline file. |
| doctor | `doctorProject` reports prerequisites and skill-install versions but no project compiler status. | Add a local policy/manifest versus package comparison with four explicit states. |
| worktree configuration | `loadConfig` recognizes portable and legacy config shapes; `workspaceStatus` is read-only; `planWorkspaceConfiguration` produces exact-hash `workspace-plan`; `planWorkspaceMigration` is a distinct read-only topology plan. | Update can observe status and create a separate lossless configuration plan using existing APIs. It must never call migration apply or worktree lifecycle operations. |
| EDD semantics | Discovery previously omitted suite targets, tasks and graders, while policy stored only generic eval rules. | The compiler now persists a canonical EDD snapshot so update/apply can identify threshold and known-bad weakening; unprovable legacy history fails closed. |
| self-bootstrap state | Effective policy and the four owner-approved TypeScript naming fingerprints already exist. | The update must preserve this baseline and validate through the existing post-apply check rather than reset Harness. |
| repository worktrees | At inspection the repository had four registered worktrees, including the primary checkout and pre-existing release/issue worktrees. | Acceptance compares the exact path set before and after planning/apply; the update itself may not alter it. |

## Reuse decision

The smallest safe architecture adds one service orchestration alias and one CLI route. It reuses current compiler, file operations, canonical hash, apply transaction, receipts, rollback, baseline ratchet and workspace plan. One policy field stores EDD semantics that otherwise cannot be recovered. No package dependency, migration framework, storage tree, approval database, MCP surface or npm release mechanism is justified.

## Risks that tests must expose

1. Defaulting omitted arrays to `[]` silently removes policy profiles.
2. Treating a legacy major compiler string as an exact version produces false `current` status.
3. Comparing stored discovery bytes only to their own hash misses repository changes after discovery.
4. A semantic diff that compares policy object hashes only cannot identify weakening rule IDs.
5. Reusing normal plan-hash approval as weakening approval collapses two distinct owner decisions.
6. Calling workspace configuration with omitted fields can substitute defaults for explicit stored values.
7. Generating a no-op plan violates the required zero-write current path.
8. Development of the feature changes approved sources; self-bootstrap must therefore perform a fresh intake/discover before generating the final update plan.
9. Worktree companion/migration status must not turn an otherwise current policy into an empty policy plan.
10. A manifest policy digest must be checked against the actual policy bytes; self-declared digest metadata is not evidence.

## Excluded alternatives

- Reinitializing or deleting `.harness`: destroys history and violates the objective.
- Copying current defaults into old projects: loses explicit policy decisions.
- A standalone update executor: duplicates exact-hash apply, rollback and receipts.
- An npm/registry updater: confuses CLI installation with project governance compilation and requires network/credentials.
- Automatic topology migration: combines policy compilation with destructive filesystem movement.
