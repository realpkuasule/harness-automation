# Issue #38 — GitHub governance remediation and self-hosted Actions plan

**Issue:** realpkuasule/harness-automation#38

**Owner:** realpkuasule

**Canonical repository:** realpkuasule/harness-automation

**Canonical project:** personal Project #2

**Repository baseline:** `7279bedaa43cfba3f59ab192cd6789ccad43651a`

**Repository audit baseline:** `97e158c535a7b8a1e458d7c5c108334fb3838d7003dcadecf93f46bf1ff0444b`

**Date:** 2026-08-22

**Status:** approved implementation plan; every remote mutation remains human-gated

## Relationship to the 2.6.0 plan

This plan is the approved remediation and runner amendment to
`docs/plans/github-team-governance-2.6.0.md`. Decisions in that plan remain in
force unless this document explicitly changes them.

The material amendment is:

- trusted repository Actions default to repository-level self-hosted runners;
- untrusted public-fork, external-contributor, and Dependabot code must never
  run on a persistent self-hosted runner;
- required check names describe the tested platform rather than a hosted image;
- runner registration and health become prerequisites to workflow migration
  and ruleset activation.

This amendment does not make GitHub Actions or self-hosted runners a requirement
for projects governed by Harness. It applies only to this repository's own
existing Actions workflows.

## Approved outcome

Keep `realpkuasule/harness-automation` as the one canonical public repository
and personal Project #2 as the development source of truth. Protect `main` and
release tags with repository rulesets, route trusted CI and releases to
repository-specific self-hosted runners, isolate untrusted pull-request code on
GitHub-hosted runners, and complete the previously approved Actions and release
hardening.

Do not transfer or mirror the repository. Do not add an independent reviewer,
CODEOWNERS, required approvals, organization authority, a runner manager,
autoscaler, daemon, scheduler, or second state store.

## Observed baseline

The following facts were observed through the existing read-only audit, `gh`,
Git, and repository inspection:

- the repository is public, user-owned, and has `main` as its default branch;
- repository rulesets are empty and `main` has no branch protection;
- the latest `build-and-test (ubuntu-latest)` and
  `build-and-test (windows-latest)` checks both succeeded;
- personal Project #2 is configured and observable;
- Actions are enabled, all Actions are allowed, and full-SHA pinning is not
  required by repository settings;
- both workflows declare least-privilege `contents: read`, use Node.js 24, and
  pin `actions/checkout` and `actions/setup-node` to full commit SHAs;
- no deployment environment exists;
- Dependabot alerts and Dependabot security updates are disabled;
- merge commits, rebase merges, and squash merges are all currently allowed;
- the repository currently has zero registered self-hosted runners;
- `.github/workflows/ci.yml` uses `ubuntu-latest` and `windows-latest`;
- `.github/workflows/publish.yml` uses `ubuntu-latest`;
- the accessible `xiaozhiaixue` repository list is observable, but organization
  rulesets are unavailable to the current token without `admin:org`.

The repository audit currently exits `2` with these deterministic blockers:

- `DEFAULT_BRANCH_UNPROTECTED: main`;
- `PULL_REQUEST_RULE_MISSING: main`;
- `REQUIRED_CHECK_RULE_MISSING: main`;
- `FORCE_PUSH_ALLOWED: main`;
- `BRANCH_DELETION_ALLOWED: main`.

`USER_OWNED_REPOSITORY: organization Team controls do not apply` is a warning,
not a blocker or a reason to transfer the repository.

## Self-hosted runner security boundary

GitHub warns that public-repository forks can submit workflow changes that run
dangerous code on a self-hosted machine, and that self-hosted runners do not
provide a clean ephemeral environment for every job. Therefore "self-hosted by
default" means trusted code by default, not untrusted code without isolation.

Official references:

- https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/add-runners
- https://docs.github.com/en/actions/reference/security/secure-use

### Trusted jobs

The following may use this repository's self-hosted runners:

- pushes to protected `main` after merge;
- pull requests whose head repository is this repository and whose author is
  the repository owner;
- release jobs triggered by an approved `v*` tag after the `npm-release`
  environment gate.

An AI coding agent does not receive a ruleset bypass. A branch pushed with the
owner's existing GitHub identity follows the same pull-request and required
check rules as any other owner branch.

### Untrusted jobs

The following must not run on a persistent self-hosted runner:

- forks of this public repository;
- pull requests from external contributors;
- Dependabot or another bot proposing dependency or workflow changes;
- any workflow using `pull_request_target` to execute pull-request code.

These jobs use GitHub-hosted isolation or remain unexecuted until a separately
approved safe path exists. They must retain the same semantic required-check
names when a GitHub-hosted fallback is used.

The workflow must make the trust decision before checkout or execution. It must
not rely only on manual workflow approval, because approval does not make
untrusted code safe for a persistent host.

## Required runner topology

Because this is a user-owned repository, runners used by another personal
repository are not automatically shareable. A machine that already hosts a
`vfx-parser` runner may host another runner process, but the new process must be
registered separately to `realpkuasule/harness-automation` with a distinct
installation directory, service name, work directory, and labels.

Before editing workflow `runs-on`, register and observe all of these runners:

| Purpose | Required labels | Requirement |
|---|---|---|
| Linux CI | `self-hosted`, `Linux`, `X64`, `harness-ci` | repository-specific, online, idle |
| Windows CI | `self-hosted`, `Windows`, `X64`, `harness-ci` | native Windows, not WSL, online, idle |
| npm release | `self-hosted`, `Linux`, `X64`, `harness-release` | dedicated release host or isolated runner instance |

macOS/ARM64 may be added later as an additional compatibility check, but it
does not replace native Windows coverage and is not required to clear the
current governance blockers.

### Host requirements

Each runner must:

- use a dedicated unprivileged OS account;
- have no personal SSH keys, browser profiles, shell history, cloud credentials,
  or unrelated project secrets;
- use a repository-specific runner directory and work directory;
- run a supported Actions runner version as a managed service;
- have Node.js 24, npm, Git, and the tools already required by the workflow;
- have outbound network access only as required by GitHub, npm installation,
  and the repository tests;
- not grant passwordless sudo or mount personal workspaces;
- expose no npm release credential to CI runners;
- be observable through the repository runner API before workflow migration.

Do not add a runner autoscaler, ARC, webhook, daemon, cleanup framework, or
custom runner inventory database. Three explicit runner instances and GitHub's
native runner inventory are sufficient for this repository.

## Phase R0 — issue and immutable preflight evidence

Issue #38 is the implementation source of truth and starts `In Progress` with
high priority.

Before any remote write:

1. rerun the repository-only governance audit;
2. record repository HEAD, audit `observedHash`, rulesets, branch protection,
   Actions permissions, environments, and runner inventory;
3. verify the latest Linux and Windows checks still pass;
4. verify Issue #38 and personal Project #2 mapping;
5. stop if repository ownership, default branch, Project mapping, workflow
   check identity, or worktree state has drifted.

The optional organization audit is not part of this gate. Do not refresh GitHub
authentication or request `admin:org`.

## Phase R1 — manual runner registration gate

Runner registration changes GitHub and host state and requires explicit
approval. Registration tokens are short-lived credentials and must not be
printed in logs, plans, comments, or receipts.

Required human actions:

1. approve generation of repository runner registration tokens;
2. run the GitHub-provided registration commands on the selected Linux,
   Windows, and release hosts;
3. install each runner as a service under its dedicated account;
4. report the runner names and the non-secret labels shown by GitHub.

The implementation agent may then perform a read-only runner inventory check.
It must stop unless all required label combinations are online and not busy.

No workflow may be changed to require a label that has no online runner.

## Phase R2 — workflow migration

Migration occurs in a normal owner branch and pull request while no required
ruleset is active.

### CI workflow

Replace image-oriented check identity with stable platform identity:

- `build-and-test (linux-x64)`;
- `build-and-test (windows-x64)`.

For a trusted owner push or same-repository owner pull request:

- Linux uses `[self-hosted, Linux, X64, harness-ci]`;
- Windows uses `[self-hosted, Windows, X64, harness-ci]`.

For an untrusted fork, external contributor, or Dependabot pull request:

- Linux uses `ubuntu-latest`;
- Windows uses `windows-latest`;
- check names remain `build-and-test (linux-x64)` and
  `build-and-test (windows-x64)`.

Prefer one matrix job whose runner target is selected from trusted event facts,
so self-hosted and hosted paths cannot drift into different test suites. Do not
duplicate assertions or lower coverage, lint, build, or test gates.

The Windows-specific Vitest grouping remains intact and executes on native
Windows. The Linux job continues to run full coverage, lint, type checking, and
build as currently configured.

The workflow must continue using `pull_request`, never `pull_request_target`,
for code execution.

### Publish workflow

Change the publish job to
`[self-hosted, Linux, X64, harness-release]` only after the release runner and
`npm-release` environment both exist.

Retain:

- `v*` tag trigger;
- `contents: read` workflow permissions;
- test, lint, build, and `prepublishOnly` ordering;
- full-SHA Action pins;
- explicit npm authorization and OTP rules.

Add `environment: npm-release`. Do not tag or publish to test this migration.
The next separately approved release provides the first end-to-end publish
evidence.

### Required repository changes

The minimum expected tracked diff is:

- `.github/workflows/ci.yml`;
- `.github/workflows/publish.yml`;
- the directly relevant CLI/README/design references if they name the old
  hosted check contexts;
- `CHANGELOG.jsonl` through `scripts/changelog.py`, referencing Issue #38.

Do not add dependencies, a runner manager, generated runner configuration, host
credentials, or machine-specific paths to the repository.

## Phase R3 — workflow validation before rulesets

Run targeted workflow and test checks locally, then complete repository
validation:

```bash
cd /Users/zhichao/codex/harness-automation/mcp-server
CI=1 npm test
npm run lint
npm run build
npm run prepublishOnly
```

Also run Python tracker tests and `git diff --check`.

Push only after explicit approval. Use one representative owner pull request to
prove:

- Linux/X64 ran on the expected `harness-ci` self-hosted runner;
- Windows/X64 ran on the expected native Windows `harness-ci` runner;
- both new check names concluded `success`;
- no approval was required;
- the pull request was squash-mergeable;
- no release job, tag, or npm publication occurred.

If a safe disposable fork test is available, separately prove that the same
check names route to GitHub-hosted runners. Do not create an untrusted fork test
that targets self-hosted labels. Absence of a fork test is recorded as
`unavailable`, not silently inferred as passing.

## Phase G2 — Disabled repository rulesets

Only after Phase R3 succeeds may the implementation agent request approval to
create rulesets. Creation and activation are separate human gates.

### Default-branch ruleset

Create `main-governance` with:

- target: branch;
- include: `~DEFAULT_BRANCH`;
- enforcement: `disabled`;
- no exclusions;
- owner/repository-administrator emergency bypass only;
- no AI, bot, ordinary Write user, team, or broad actor bypass.

Rules:

- require a pull request before merge;
- required approving reviews: `0`;
- require all review conversations to be resolved;
- do not require CODEOWNER review, last-push approval, or stale-review dismissal;
- allow only squash merge for normal pull requests;
- require `build-and-test (linux-x64)`;
- require `build-and-test (windows-x64)`;
- require checks against the latest default branch;
- require linear history;
- block branch deletion;
- block force push/non-fast-forward updates.

Do not require signed commits, deployments, merge queues, independent reviewers,
or Enterprise-only Evaluate enforcement.

### Release-tag ruleset

Create `release-tags-v` with:

- target: tag;
- include: `refs/tags/v*`;
- enforcement: `disabled`;
- owner/repository-administrator emergency bypass only;
- block update of an existing matching tag;
- block deletion of a matching tag;
- allow creation through the separately approved release procedure.

### Disabled-state verification

Read back both normalized rulesets and compare every target, condition, rule,
check context, bypass actor, and enforcement field with this plan.

The repository audit is expected to remain blocked while enforcement is
Disabled. Do not switch to Active to make preflight output green.

## Phase G3 — Actions and release hardening

After the self-hosted workflows pass, request separate approval for each remote
setting group.

### Actions policy

- keep Actions enabled;
- change allowed Actions from `all` to `selected`;
- allow GitHub-owned Actions required by the workflows;
- require full commit SHA pins;
- keep default workflow permissions at `read`;
- keep workflow pull-request approval capability disabled.

Rerun the representative pull request under the hardened settings. If an
Action is rejected, preserve exact evidence and stop. Do not silently restore
`allowed_actions: all`.

### npm release environment

Create `npm-release` with:

- selected tag deployment policy `v*`;
- no ordinary branch deployment;
- no required reviewer in the approved solo-maintainer baseline;
- no wait timer.

Repository secrets cannot be read and migrated automatically. If the owner
later chooses to move `NPM_TOKEN` from repository scope to environment scope,
the owner must enter it manually at a separate credential gate.

### Dependabot

1. enable Dependabot alerts after separate approval;
2. triage existing alerts;
3. enable Dependabot security updates after triage;
4. do not add `.github/dependabot.yml` unless the observed alert volume proves
   that scheduled update pull requests are useful.

Dependabot pull requests remain untrusted for runner routing and must use
GitHub-hosted isolation.

Secret scanning, push protection, GitHub Code Security, and organization-wide
Actions policy are outside this issue.

## Phase G4 — activation human gate

Before activation, present:

- both Disabled ruleset IDs and normalized configurations;
- representative pull request URL and squash-merge evidence;
- exact self-hosted runner names and labels used by the Linux and Windows jobs;
- both required check conclusions;
- Actions permission readback;
- `npm-release` environment readback if configured;
- the owner emergency-disable procedure;
- confirmation that no tag, publish, transfer, mirror, reviewer, or CODEOWNERS
  change occurred.

Activation requires an exact approval naming both ruleset IDs. "Continue" or
approval of this plan is not activation approval.

Activate `main-governance` and `release-tags-v` independently. Immediately read
back each ruleset after mutation.

## Phase G5 — acceptance and closeout

Run the repository-only audit:

```bash
node mcp-server/dist/cli.js github audit \
  --project /Users/zhichao/codex/harness-automation
```

Required result:

- exit `0`;
- `status: pass`;
- `blockers: []`;
- `unavailable: []` for repository scope;
- required checks are `build-and-test (linux-x64)` and
  `build-and-test (windows-x64)` and both latest conclusions are `success`;
- Project #2 remains available;
- active rulesets block deletion and non-fast-forward updates;
- a new `observedHash` is recorded.

The audit does not currently prove runner provenance. Supplement it with a
read-only workflow-run jobs observation recording runner names and labels for
the representative run. Do not add a new runner manager or audit parser in this
issue; add product support later only if repeated manual evidence becomes a
real maintenance problem.

An audit with `--organization xiaozhiaixue` may continue to exit `2` because
organization ruleset evidence is unavailable. That does not block repository
acceptance. Do not request `admin:org` unless a future, separately approved
organization-wide audit requires it.

Record the repository-significant change with `scripts/changelog.py`, link Issue
#38, attach the final evidence in the Issue, set Project status to Done, and
close the Issue only after all approved phases are complete.

No version bump, tag, push, npm publish, or skill-sync is implied by closeout.

## Human gates

| Gate | Human action | Agent boundary |
|---|---|---|
| H0 — plan implementation | Approve implementation of Issue #38 | Planning approval alone does not authorize remote writes |
| H1 — runner registration | Approve tokens and register three repository-specific runner instances | Agent does not expose tokens or configure personal hosts without approval |
| H2 — workflow push | Approve pushing the workflow migration branch | No automatic push or PR |
| H3 — remote hardening | Approve Actions, environment, and Dependabot setting groups separately | No bundled GitHub mutation approval |
| H4 — ruleset creation | Approve creation in Disabled state | Disabled creation is not activation |
| H5 — ruleset activation | Name both ruleset IDs and approve Active enforcement | Agent stops before activation |
| H6 — credentials | Re-enter `NPM_TOKEN` only if environment scoping is chosen | Secrets cannot be migrated by observation |
| H7 — release | Separately approve version, release commit, tag, push, npm publish, and skill-sync | Issue #38 completion is not release approval |

## Failure handling and rollback

- If a required runner is offline, keep the hosted workflow and stop before
  migration; do not weaken tests or remove Windows coverage.
- If a workflow queues indefinitely, restore the prior workflow in a normal
  corrective commit after approval; do not activate rulesets.
- If untrusted code is observed on a self-hosted runner, stop the runner service,
  treat the host as compromised, rotate exposed credentials, and do not reuse
  the work directory as evidence of cleanliness.
- Before activation, correct the Disabled ruleset in place rather than deleting
  and recreating it.
- If an Active ruleset blocks legitimate work, capture its API representation
  and check evidence, then the human owner may approve returning it to Disabled.
- If required check names drift, repair the workflow or update the ruleset under
  a new explicit approval; do not remove the check gate.
- If the Actions allowlist blocks a pinned required Action, add only that exact
  reviewed Action or revert the setting after explicit approval.
- If the release environment blocks publishing, stop the release. Do not delete
  or overwrite a tag and do not bypass prepublish validation.
- If Dependabot creates unacceptable noise, disable security updates after
  approval while retaining alerts for triage.
- Never force push, delete a protected branch, update/delete a release tag, use
  an emergency bypass autonomously, or delete a ruleset as rollback.

## Non-goals

- repository transfer or a second `xiaozhiaixue/harness-automation` repository;
- Git mirroring or dual writable remotes;
- organization rulesets, teams, runner groups, or `admin:org` expansion;
- independent reviewer, CODEOWNERS, or required approvals;
- self-hosted execution of public-fork, external, or Dependabot code;
- `pull_request_target` execution of pull-request code;
- runner autoscaling, ARC, webhooks, daemons, cron, launchd, or a runner state DB;
- automatic merge, push, tag, release, npm publish, or skill-sync;
- a new dependency or GitHub settings manager;
- changes to Harness's provider-neutral CI contract for governed projects.

## Acceptance criteria

The remediation is complete only when:

1. Issue #38 is the tracked source of truth and all remote mutations have exact
   human approvals.
2. Linux/X64 and native Windows/X64 trusted checks run on the registered
   repository self-hosted runners and succeed without reducing any gate.
3. The release workflow targets the isolated `harness-release` runner and the
   `npm-release` environment, without publishing during migration.
4. Untrusted fork, external, and Dependabot code is provably excluded from
   persistent self-hosted runners.
5. The two stable required checks are `build-and-test (linux-x64)` and
   `build-and-test (windows-x64)`.
6. The owner-only zero-approval squash pull-request flow succeeds.
7. Default-branch and `v*` tag rulesets are Active only after their independent
   activation gate.
8. Repository-only governance audit exits `0` with no blockers or unavailable
   evidence and records a new `observedHash`.
9. The canonical repository, Project, npm identity, schemas, work-items,
   reviewer model, and provider-neutral Harness behavior remain unchanged.
10. No release, tag, version bump, transfer, mirror, organization rollout, or
    skill-sync occurs without a later explicit authorization.
