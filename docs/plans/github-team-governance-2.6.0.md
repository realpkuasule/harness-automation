# Issue #36 — GitHub Team governance and read-only audit plan

**Issue:** realpkuasule/harness-automation#36

**Optional audit organization:** `xiaozhiaixue`

**Owner:** realpkuasule

**Baseline:** `v2.5.0` / `7a288358c4cadf952c11f9e16795f2a03c60ddba`

**Date:** 2026-08-22

**Status:** implementation input; every remote mutation remains human-gated

## Outcome

Keep `realpkuasule/harness-automation` as the one canonical repository, use its
native public-repository rules as the enforcement plane, and add one read-only
`harness-automation github audit` command that reports deterministic governance
drift without modifying GitHub or the checkout.

The upgrade has two deliverables:

1. a native repository governance baseline for
   `realpkuasule/harness-automation`;
2. a v2.6.0 repository/organization audit that can also observe the paid
   `xiaozhiaixue` organization and its repositories.

The harness must not become a second GitHub permissions database or a generic
remote-settings manager. GitHub owns identities, teams, repository access,
rulesets, review decisions, Actions permissions, environments, and audit logs.
Harness observes those facts and fails closed when a requested audit cannot
prove them.

## Observed baseline

The following facts were observed on 2026-08-22 through read-only GitHub API,
Git, and repository inspection:

- `xiaozhiaixue` is on the GitHub Team plan and owns 21 repositories: 15
  private and 6 public.
- Organization two-factor authentication is required and base repository
  permission is `none`.
- All 21 organization repositories currently report zero effective rulesets,
  including inherited organization rulesets, and an unprotected default
  branch.
- The only observed organization team is `engineering`, with two members. It
  does not yet have access to `harness-automation`; its observed direct access
  to five other repositories is `pull`.
- `realpkuasule/harness-automation` is a user-owned public repository. The Team
  organization cannot apply organization teams or organization rulesets to it,
  but GitHub provides repository rulesets for public repositories without a
  Team transfer.
- Its `main` branch has no branch protection or repository ruleset.
- Repository Actions are enabled with `allowed_actions: all` and no required
  full-SHA pinning.
- There is no CODEOWNERS file or deployment environment.
- Dependabot alerts and security updates are disabled.
- The `v2.5.0` baseline has failed Linux, Windows, and publish checks. Publish
  stopped during tests and never reached `npm publish`.
- Repository development tracking is healthy but remains bound to
  `realpkuasule/harness-automation` and personal Project #2.
- The repository has only one collaborator: `realpkuasule` with Admin. This is
  the approved solo-maintainer baseline; no independent reviewer will be
  added, so reviewer-dependent protections must remain disabled.
- The Git common dir contains only historical worktree receipts. There is no
  active host binding or lease affected by this upgrade.
- Existing repository owner references, Project mappings, npm metadata,
  work-item IDs, schema identifiers, and historical records remain canonical
  and require no migration.

The live sources for these facts include:

- `.github/project-workflow.json`;
- `.github/workflows/ci.yml` and `.github/workflows/publish.yml`;
- `mcp-server/package.json`;
- `mcp-server/src/worktree/provider.ts`;
- `mcp-server/src/v2/service.ts::doctorProject`;
- `docs/reference/worktree-delivery.md`.

## Product decisions

### 1. GitHub remains the enforcement plane

Use GitHub's native repository rulesets, status checks, tag protections,
Actions settings, and environment boundaries for this public repository. The
approved solo-maintainer baseline does not require CODEOWNERS or approving
reviews. Use Team organization rules only for repositories actually owned by
`xiaozhiaixue`. Harness does not emulate or override either layer.

### 2. Fix CI before enforcing required checks

The ruleset may be created in Disabled mode while CI is red, but it must not be
activated until both Linux and Windows checks pass on the target `main` commit
and on a representative pull request. GitHub rulesets are available for public
repositories, but Evaluate enforcement is an Enterprise feature and is not
part of this personal/Team rollout.

Current failures that require implementation work include:

- Linux retention-audit exit-code behavior;
- Linux large-binary adoption test timeout;
- Windows path normalization and migration postconditions;
- Windows delegated-AI decision/receipt assertions;
- Windows recovery assertions.

The publish workflow failure is downstream of the same test failures. It is
not evidence of an npm authentication failure.

### 3. Keep the personal repository and Project canonical

`realpkuasule/harness-automation` remains the only writable source repository.
Personal Project #2 remains the development source of truth, and
`.github/project-workflow.json`, npm package identity, repository URLs, Issue
references, work-item IDs, and published JSON Schema `$id` values remain
unchanged.

This avoids a migration that is not required to protect a public repository.
The limitation is explicit: organization teams cannot own code in a
user-owned repository, and the approved solo-maintainer baseline intentionally
does not add individual collaborators, CODEOWNERS, or required reviews.

### 4. Require one canonical repository; do not add a dual mirror

Do not create `xiaozhiaixue/harness-automation` in v2.6.0. Two repositories
would split Issues, pull requests, releases, Actions settings, secrets, rules,
and provider mapping; Git mirroring would copy refs but not those GitHub
objects. Direct developer pushes to two remotes can also partially succeed and
create divergence.

If a demonstrated backup or distribution requirement later justifies a second
repository, handle it in a separate issue as a one-way read-only mirror from
the canonical repository. It must never be a second writable source of truth.

### 5. Keep organization transfer optional and separate

A future transfer remains available if the organization later needs
`engineering` team ownership, centralized organization rulesets, or unified
repository permissions. It is not an implementation or release prerequisite
for v2.6.0 and must have its own inventory, compatibility review, human
approval, and migration plan.

### 6. v2.6.0 adds audit, not remote apply

The first product release adds a deterministic read-only command. It does not
add `github configure`, a GitHub mutation plan/apply path, a daemon, webhook,
scheduler, remote state cache, or dependency.

If multiple organizations later show recurring configuration drift that native
organization rulesets cannot centralize, a separate issue may add export of an
importable ruleset JSON. Direct REST mutation remains out of scope until that
need is demonstrated.

### 7. GitHub Actions is not a Harness prerequisite

The `harness-automation` Skill and its v2 CLI must not require a target project
to use GitHub Actions or any hosted CI provider. `check --mode ci` names a
verification depth: it executes discovered repository-owned test/build/eval
argv locally wherever the caller chooses to run it. It is not a GitHub Actions
integration contract.

The v2 plan/apply path must not create or edit `.github/workflows/**`,
`.gitlab-ci.yml`, or another CI configuration unless a future separately
approved plan explicitly introduces that capability. Existing CI may invoke
the CLI, but the CLI must also work from a developer machine or any other CI
system. The Actions hardening below governs this repository's own existing
build and release workflows only; it must not become a target-project blocker.

The legacy v1 MCP handlers are omitted from the default tool list, but the
current call handler still accepts a direct `init_harness` request by name; that
legacy path can generate `.github/workflows/ci.yml`. Close this compatibility
gap in v2.6.0: when `HARNESS_ENABLE_LEGACY_V1` is not exactly `1`, both listing
and direct invocation of every legacy v1 tool must fail closed. Preserve the
existing behavior only behind that explicit opt-in and document that it is not
used by the current Skill.

## Native GitHub rollout

### Phase G0 — restore green CI

1. Add regression tests that reproduce each current Linux/Windows failure.
2. Fix the shared implementation causes, not just the workflow symptoms.
3. Keep the existing two required candidate check names stable:
   `build-and-test (ubuntu-latest)` and
   `build-and-test (windows-latest)`.
4. Run the repository's complete test, lint, build, and prepublish validation.
5. Push a normal branch/PR and observe both checks passing before any ruleset
   starts requiring them.

### Phase G1 — encode the solo-maintainer baseline

Keep the repository owner as its only collaborator. Do not add an independent
reviewer or `.github/CODEOWNERS`, and do not enable required approving reviews,
required CODEOWNER review, or last-push approval. The audit must report this as
the approved baseline, not as drift or a reduced-security warning.

Do not grant `xiaozhiaixue/engineering` repository authority indirectly: an
organization team cannot govern a repository owned by a personal account.

### Phase G2 — preflight and activate repository rulesets

Create repository-level rulesets on `realpkuasule/harness-automation`. Target
the default branch and configure:

- require a pull request before merge with zero required approvals;
- require all review conversations to be resolved;
- block force pushes;
- block branch deletion;
- require linear history and squash merge for normal pull requests;
- after Phase G0 is green, require the Linux and Windows checks named above;
- grant no bypass to AI actors or ordinary Write users;
- retain only an explicit repository-owner emergency bypass.

Start in Disabled mode. Run at least one complete pull request through the
intended checks and owner-only merge flow, then compare the disabled ruleset's
normalized API representation with this plan. Activate it only after required
checks, the zero-approval pull-request path, release commits, and the emergency
disable path have been demonstrated. Post-activation observations are
supplementary and are not a substitute for the pre-activation evidence.

Create a separate repository `refs/tags/v*` ruleset that prevents update or
deletion of release tags. Tag creation stays bound to the approved release
procedure; do not enable automatic tagging.

### Phase G3 — harden Actions and releases

Repository changes:

- add explicit least-privilege workflow permissions;
- pin third-party and GitHub-authored Actions to full commit SHAs;
- update the workflow runtime from Node.js 20 to a supported version after
  verifying the package's declared Node compatibility separately;
- enable Dependabot alerts and security updates;
- add a minimal weekly Dependabot update configuration only if the initial
  alert triage proves useful;
- configure an `npm-release` environment with tag deployment restrictions and
  no required reviewer.

Do not change `xiaozhiaixue` organization-wide Actions policy in this issue.
The new audit may report organization drift, but any rollout across the 21
organization repositories requires a separately approved issue and inventory.

These Actions and environment changes apply only to this repository's existing
CI and npm release workflows. The GitHub audit may observe Actions settings in
other repositories, but absence of GitHub Actions is not a Harness blocker.

## v2.6.0 read-only CLI contract

Add:

```bash
harness-automation github audit \
  --project /absolute/repository \
  [--organization xiaozhiaixue]
```

Without `--organization`, derive the remote repository from the checkout and
audit that repository. A user-owned repository remains auditable and receives
a warning that organization-level Team controls cannot target it.

With `--organization`, enumerate the accessible repositories and summarize
their effective governance. Pagination is mandatory. A missing organization
administration scope must be reported as unavailable evidence; the command
must never run `gh auth refresh`, open a browser, or expand token permissions.

Stable output includes:

- schema version and audit scope;
- repository owner type, visibility, repository ID, default branch and HEAD;
- effective repository and inherited organization rulesets;
- branch/tag protection, required PR/review/check settings and bypass actors
  when observable;
- CODEOWNERS existence, syntax availability, owner resolution and explicit
  Write access when observable;
- latest required-check names and conclusions;
- Actions allowlist, full-SHA requirement, workflow token permissions and
  unpinned `uses:` entries;
- environment names, deployment branch/tag policy, and available protection
  rules;
- configured Issue/Project owner, number, fields, item mapping availability and
  drift;
- capability/plan limitations;
- `blockers`, `warnings`, `unavailable`, overall `status`, and `observedHash`.

The observed hash covers the normalized report excluding timestamps and the
hash field itself. Sort repositories, rulesets, checks, owners, blockers,
warnings, and unavailable evidence so repeated observations of the same state
produce the same hash.

### Exit behavior

- exit 0: all deterministic baseline requirements pass; warnings alone are
  allowed;
- exit 2: a deterministic blocker exists or the explicitly requested audit
  scope cannot be observed completely;
- exit 1: invalid CLI input or an unexpected runtime failure prevents a valid
  report.

Deterministic blockers include an unprotected default branch, a missing
approved PR/check rule, force-push/deletion permission, a declared required
check missing from the effective rule, an unpinned Action when SHA pinning is
required by that repository's approved policy, or Issue/Project mapping drift.
Missing CODEOWNERS, approving reviews, Actions workflows, or deployment
environments are observations rather than blockers unless an explicit approved
policy requires them.

Warnings include a behind or currently failing check whose configuration is
otherwise present, optional Dependabot settings, unavailable paid add-ons, and
features that require Enterprise rather than Team.

### Zero-side-effect contract

The command may execute only read-only Git and `gh api`/`gh project view`
operations. It must not:

- write a plan, receipt, cache, config, Git ref, index, worktree file, Issue,
  Project item, review, ruleset, permission, environment, secret, or Actions
  setting;
- fetch, checkout, merge, rebase, push, tag, transfer, or publish;
- refresh GitHub authentication or request a broader scope;
- silently treat a 403/404 or truncated page as an empty compliant result.

## Existing implementation to reuse

- `mcp-server/src/worktree/provider.ts::commandJson` already executes bounded
  `gh` JSON calls and reports failures without storing credentials.
- `mcp-server/src/v2/fs.ts::hashObject` and the existing sorted/hash-bound plan
  patterns provide deterministic hashing.
- `mcp-server/src/cli.ts` owns CLI routing and exit-code behavior.
- `scripts/github_tracker.py` remains the Issue/Project workflow helper and is
  called only for its existing responsibility.
- Existing fake-`gh` tests in worktree/session code provide the pattern for
  deterministic, network-free tests.

Do not add an SDK, HTTP client, cache, GitHub manager class, provider registry,
or alternate state directory.

## Expected implementation files

The minimum expected product diff is:

- `mcp-server/src/github/governance.ts` — read-only observation,
  normalization, blockers/warnings and hashing;
- `mcp-server/src/github/governance.test.ts` — fake-`gh` contract tests;
- `mcp-server/src/cli.ts` and its focused CLI test — command routing and exit
  codes;
- `mcp-server/src/index.ts` and its focused MCP test — reject direct legacy v1
  tool calls unless the existing compatibility opt-in is enabled;
- `README.md` and one CLI/design reference;
- `skill/SKILL.md` and `skills/manage-worktree-delivery/SKILL.md` plus the
  directly relevant references;
- repository governance files such as workflow changes and optional Dependabot
  configuration; do not add `.github/CODEOWNERS`.

Files may be reduced if the existing CLI test or documentation already covers
the contract. Do not create a separate MCP tool in v2.6.0 unless a real MCP
consumer is identified during implementation.

## Test plan

### CI repair

- reproduce and fix every current Linux/Windows failure;
- verify retention-audit parse errors return exit 2 in a packaged CLI process;
- make large-binary observation deterministic without an arbitrary 5-second
  success assumption;
- verify Windows canonical paths, migration postconditions, delegated-AI
  decision evidence, and recover plans.

### GitHub audit targeted tests

- user-owned public repository warning;
- organization-owned public and private repository observations;
- inherited organization ruleset plus repository ruleset aggregation;
- protected and unprotected default branches;
- missing/invalid CODEOWNERS, an individual without explicit Write, and
  organization-team observations, all non-blocking for the solo baseline;
- required check present, absent, passing and failing;
- absent/pinned/unpinned Actions and least-privilege workflow permissions,
  proving that no Actions workflow is a generic Harness prerequisite;
- v2 plan operations never create or edit CI configuration; legacy v1 mutating
  MCP tools are omitted from listing and reject direct calls without explicit
  compatibility opt-in, while opt-in compatibility remains covered;
- environment availability differences for public/private Team repositories;
- Issue/Project mapping success, drift, pagination and rate-limit failures;
- 403/404/invalid JSON/truncated pagination fail closed;
- stable ordering and `observedHash` determinism;
- zero repository and remote writes on success and every failure path;
- exit 0/1/2 CLI behavior.

All product tests use fake `gh` executables or injected command results. No test
calls live GitHub.

### Full validation

From `mcp-server`:

```bash
npm test
npm run lint
npm run build
npm run prepublishOnly
```

Also run the Python tracker tests, `python3 scripts/github_tracker.py doctor`,
a real read-only audit against the personal repository and `xiaozhiaixue`, and
`git diff --check`.

## Human gates and manual actions

The implementation agent must stop at each gate and report the exact evidence
needed. Automatic continuation is not approval.

| Gate | Required human action | Why it cannot be inferred |
|---|---|---|
| H0 — start implementation | Explicitly authorize implementation of Issue #36 | This document alone authorizes planning, not code or remote mutations |
| H1 — ruleset activation | Review the Disabled ruleset, green representative PR, zero-approval owner merge, and emergency-disable evidence, then explicitly approve switching it to Active | Evaluate mode is not available on this plan, and activation can block every future merge |
| H2 — optional organization audit authority | Only if complete organization-level audit evidence is required, run/approve `gh auth refresh -h github.com -s admin:org` or provide equivalent fine-grained read authority | The current token cannot inspect every organization setting, and scope expansion must be voluntary |
| H3 — release | After all validation passes, explicitly authorize version bump, release commit, tag, push and npm publish; provide npm OTP only if npm requests one at publish time | Repository implementation approval is not release approval |

The user does **not** need to manually fix code, update links, author ruleset
JSON, run tests, or edit documentation. The agent can prepare those changes and
evidence. The user must retain activation, credential, and release decisions
listed above.

## Compatibility and plan limitations

- Existing `worktree-delivery` behavior, defaults, leases, receipts, delegated
  AI allowlist, and deterministic blockers do not change.
- Existing user-owned or GitLab/Jira projects remain supported. GitHub Team is
  not a prerequisite for local worktree governance.
- GitHub Actions is not a prerequisite for skill intake, planning, apply,
  context, checking, drift, worktree delivery, or session handoff. `--mode ci`
  remains provider-neutral and can run locally or in any CI system.
- Legacy v1 may retain provider-specific CI generation only behind
  `HARNESS_ENABLE_LEGACY_V1=1`; without that opt-in, direct calls as well as tool
  discovery must reject the legacy path.
- `realpkuasule/harness-automation`, personal Project #2, published JSON Schema
  identities, work-item IDs, repository URLs, and the npm package name remain
  stable.
- No second same-name repository or mirror is created. A future one-way mirror
  or organization transfer requires a separate issue and explicit proof of
  need.
- GitHub Team does not include private-repository merge queues, private
  environment required reviewers, custom repository/organization roles,
  audit-log API access, ruleset Evaluate enforcement, GitHub Code Security, or
  GitHub Secret Protection. These must not be reported as included baseline
  capabilities.
- No existing organization repository is automatically configured or migrated.
  Expansion beyond `harness-automation` requires a separate observed rollout.

## Acceptance criteria

The plan is complete only when:

1. Issue #36 remains the tracked implementation source of truth.
2. Linux and Windows CI are green before required checks become active.
3. The personal repository and Project remain canonical, with no owner, URL,
   package, schema, work-item, lease, or Project migration.
4. The owner remains the only collaborator; no CODEOWNERS or independent
   reviewer is added, review-dependent rules remain disabled, and the audit
   treats that configuration as the approved baseline.
5. The repository default-branch and release-tag rulesets are active only after
   Disabled-state preflight evidence and human approval.
6. This repository's Actions use least privilege and full-SHA pins; Dependabot
   is enabled without making Actions a target-project prerequisite, and legacy
   v1 direct calls cannot bypass the explicit compatibility opt-in.
7. `harness-automation github audit` satisfies its output, exit-code,
   authentication, pagination, hashing and zero-side-effect contracts.
8. Targeted and full validation pass locally and in this repository's existing
   GitHub Actions.
9. Documentation and both shipped skills explain the Team boundary,
   solo-maintainer baseline, provider-neutral CI mode, and human gates without
   promising Enterprise/add-on features.
10. The implementation is one or more reviewable Conventional Commits with no
    automatic version bump, tag, push, publish, repository transfer, mirror,
    ruleset activation, or organization-wide rollout.

## Rollback and failure handling

- A ruleset rollout starts Disabled and may be returned to Disabled rather than
  deleted.
- If an active ruleset blocks legitimate work, the human repository owner may
  disable it after capturing the available ruleset and API evidence; the agent
  must not use emergency bypass autonomously.
- The personal repository and Project are not transferred or mirrored, so no
  ownership rollback path is needed in this issue.
- If provider mapping, Actions secrets, or CI is unavailable, stop before
  ruleset activation and release.
- Audit failures create no local or remote state and preserve GitHub stdout,
  stderr, endpoint category and status code in sanitized diagnostics without
  credentials.
