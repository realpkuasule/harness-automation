# Worktree Delivery CLI Reference

## Read-only commands

```bash
harness-automation worktree status --project .
harness-automation worktree audit --project .
harness-automation worktree retention-audit --project .
harness-automation worktree retention-audit --project . --receipt-scope project
harness-automation worktree integration-check --project . --work-item github:owner/repository#24 [--target main]
```

These commands require only Git. They do not require PRD intake and create no
worktree. Retention audit reports expired review receipts, lease heartbeats,
lifecycle locks, and remote branches; it deletes none of them. Stale reviews,
leases, locks, or parse errors return exit 2; old remote branches alone return 0.
Review receipt scope defaults to `host-global`. Project scope still reads the
host-global receipt directory, validates every receipt fail-closed, and includes
only receipts whose normalized `projectDir` and `commonDir` both match the
audited project. Valid excluded receipts are counted and never modified.

`integration-check` accepts one existing lease and a local target ref (default:
the management branch). It does not fetch, merge, rebase, checkout, alter a
conflict, or run tests. It reports HEADs, merge-base, ahead/behind, dirty and
unpushed evidence, current/forecast conflicts, blockers, warnings, and an
observed hash. Behind is a warning; dirty, unresolved conflict, unpushed work,
mapping drift, or a forecast conflict return `blocked` and exit 2. Mergeability
uses isolated `git merge-tree --write-tree --name-only -z`, with generated
objects confined to a cleaned OS temporary object directory.

## Configure

For new managed projects, use the explicit container topology. `--project` must
be the existing Git checkout at `<workspace-container>/main`; the container is
not a Git repository and `worktrees/` may be absent while the plan is created:

```bash
harness-automation worktree configure \
  --project /absolute/container/main \
  --mode enforced \
  --management-branch main \
  --topology container-v1 \
  --workspace-container /absolute/container
```

The approved configure apply creates only the exact empty
`/absolute/container/worktrees` directory when it was absent. It records the
canonical container, management checkout, persistent root, protected roots,
and Git common-dir in the plan and receipt. Allocation paths must then be
direct children such as `/absolute/container/worktrees/24`; planning creates
neither that directory, a branch, a worktree, nor a lease. The `main/` checkout
and its `.git` directory are always protected.

The older `--allow-root` form remains for existing flat layouts. It is rejected
when container topology is selected, so a container cannot silently degrade to
a shared parent directory.

```bash
harness-automation worktree configure \
  --project . \
  --mode audit-only|enforced \
  --management-branch main \
  --allow-root /absolute/parent \
  [--protect-root /absolute/protected] \
  [--max-persistent 2] \
  [--lease-ttl-hours 72] \
  [--review-ttl-minutes 120] \
  [--remote-retention-days 1] \
  [--remote-branch-deletion true|false]
```

GitHub Provider example:

```bash
harness-automation worktree configure \
  --project . \
  --mode enforced \
  --management-branch main \
  --allow-root /absolute/parent \
  --provider github \
  --provider-repository owner/repository \
  --project-owner owner \
  --project-number 2 \
  --status-field Workflow \
  --done-value Done
```

`--done-value` may repeat. GitLab and Jira currently report `blocked`.
GitHub Issue metadata uses REST. A configured Project adds one batched GraphQL
request per provider observation, independent of the number of leases; without
a Project mapping, worktree commands use no GraphQL. Allocation and adoption
bind the pending work items into that observation so an Issue missing from the
configured Project is rejected before a plan is written. GraphQL exhaustion is
reported as `GITHUB_GRAPHQL_RATE_LIMITED` and never bypasses a mutation gate.
`--management-branch` identifies the one persistent management checkout without
putting a host-specific path in repository policy. Enforced audit fails closed
when that branch has zero or multiple observed checkouts. A detached Review
checkout is exempt only while it is the command checkout; persistent task
worktrees still require leases.

The approved plan writes portable policy to
`.harness/worktree-delivery.json` and host-specific canonical roots to
`<git-common-dir>/harness/worktree-delivery/host-binding.json`. The plan hash
covers both. On a new host, run configure again to approve that host's roots;
omitted portable options preserve the existing repository policy. For a new
configuration the defaults are 2 persistent worktrees, a 72-hour lease,
one-day stale feature-branch audit, and merged branch deletion enabled.
Omitted options preserve explicit existing settings.
Existing v1 configurations without `managementBranch` retain the legacy
command-checkout behavior until an approved configure plan adds the selector.

### Legacy migration preflight

Existing flat layouts are never moved automatically. Generate an independently
hash-bound preflight first:

```bash
harness-automation worktree migrate \
  --project /absolute/legacy-checkout \
  --workspace-container /absolute/new-container
```

It records management checkout, host binding and lease hashes, refs, registered
worktrees, dirty/unique/unpushed evidence, and all referenced paths, together
with the target `main/` and `worktrees/` mapping. Only the explicit command
below may execute that exact plan; generic `apply` rejects migration plans:

```bash
harness-automation worktree migrate apply \
  --project /absolute/legacy-checkout \
  --plan .harness/plans/<migration-plan>.json \
  --approve <exact-sha256>
```

The first executor supports exactly one primary legacy checkout with no lease
or persistent worktree. It never resets, cleans, prunes, removes, or pushes.
An interrupted migration leaves a durable receipt; rerun the same explicit
command from `<container>/main` with the same plan and hash to resume only when
the recorded post-move state still matches. Rollback is deliberately refused.
No GitHub Team plan or configuration is involved.

### Lease renewal after normal commits

`harness-automation worktree renew` may renew a clean, attached worktree that
remains on its leased branch after normal commits advance that branch. Its
exact-hash plan binds the observed branch, path, current HEAD, and prior lease
hash; apply rechecks all of them and updates only `acceptedCommit` and
`heartbeatAt`. Detached, locked, prunable, path/branch-mismatched, HEAD-drifted,
or lease-hash-drifted worktrees fail closed without modifying Git refs or the
worktree.

### Delegated AI authorization

Per-plan human approval remains mandatory. New `delegated-ai` bindings are
rejected with `DG02_REVIEWER_CONFIGURATION_REQUIRED` until DG-02 can persist a
human-approved Provider, model, credential reference, private-content scope,
and trust decision. Existing legacy bindings remain parseable for audit and can
be reconfigured to `manual`; `worktree apply-ai` returns `ReviewPending` without
invoking a reviewer or changing worktree state.

This local mode separates normal execution from model review but is not a
security boundary against a malicious process running as the same OS user.
Use a separately protected local broker if that stronger threat model matters.

## Allocate

```bash
harness-automation worktree allocate \
  --project /absolute/container/main \
  --work-item github:owner/repository#24 \
  --branch codex/24-description \
  --owner owner \
  [--thread thread-id] \
  [--start-point HEAD]
```

For container-v1, the path is derived as `<container>/worktrees/24`; an explicit
path is accepted only when it is exactly that canonical path. The branch must
contain the case-sensitive work-item ID as a complete `/`, `.`, `_`, or `-`
segment. Legacy-flat allocation continues to require its explicit absolute
`--path`; existing and adopted paths are never renamed or moved. This writes
only a plan. In manual mode apply it with:

```bash
harness-automation apply \
  --project . \
  --plan .harness/plans/<plan>.json \
  --approve <exact-sha256>
```

## Adopt existing worktrees

Prepare one strict manifest for worktrees that already existed before delivery
governance was enabled:

```json
{
  "schemaVersion": "worktree-adopt/1.0",
  "items": [
    {
      "workItem": "github:owner/repository#24",
      "owner": "owner",
      "thread": "optional-thread-id",
      "path": "/absolute/parent/existing-issue-24",
      "branch": "issue-24"
    }
  ]
}
```

Generate the immutable plan, then apply its exact hash through the same command
shown above:

```bash
harness-automation worktree adopt \
  --project . \
  --manifest /absolute/path/worktree-adopt.json
```

Planning and drift failure create no lease. Successful apply writes only the
new leases and receipt under the Git common dir. The plan binds configuration,
host binding, capacity, Provider Issue/Project state, path, branch, HEAD, index,
dirty evidence and binary patch digest. Dirty worktrees are accepted and left
unchanged; detached, locked, prunable, management/protected/out-of-root,
duplicate, and over-capacity targets are rejected. Completed Provider items
may be adopted so their existing worktrees can immediately pass through a
separate normal `close` plan; adoption never closes them implicitly.

Adoption rollback removes only unchanged leases created by that receipt. It is
refused after a later lifecycle operation used a lease and never removes a
worktree, branch, ref, index, or working-tree file.

## Temporary Review

```bash
harness-automation worktree review \
  --project . \
  --commit <sha> \
  -- npm test
```

The `--` separator is required. Everything after it is passed as argv without a
shell.

Exit status `2` means the review command failed, cleanup was blocked, or the
temporary worktree became dirty. Inspect the returned `path`, `receiptPath`,
`dirtyEvidence`, and `dirtyPatch`.

## Close

```bash
harness-automation worktree close \
  --project . \
  --work-item github:owner/repository#24 \
  --accepted-commit <sha>
```

Close planning fails if HEAD is dirty or differs from Accepted Commit. With the
new default enabled, it also requires the local management branch to match its
remote, the exact feature ref to be unchanged, and deterministic merge proof.
Ordinary merges use ancestry; GitHub squash merges require one exact merged PR
whose repository, head branch/SHA, base repository, and base branch all match.
The resolved push endpoint must be unique, is hash-bound into the plan, and must
identify that same GitHub repository; `pushurl` and URL rewrites cannot redirect
observation or deletion to another repository.
Apply removes the worktree and lease, then deletes the local ref with
`git update-ref` compare-and-swap and the remote ref with an exact
`--force-with-lease`. It never performs the merge itself. A missing, ambiguous,
unmerged, or drifted observation blocks cleanup without deleting either ref.
If the client cannot determine whether a remote deletion succeeded, the durable
receipt reports `WORKTREE_CLOSE_RECOVERY_REQUIRED` and automatic compensation
stops rather than recreating only the local state.
Explicit existing `remoteBranchDeletion: false` configurations keep the legacy
branch-preserving close behavior.

## Drift and check

```bash
harness-automation drift --project .
harness-automation check --project . --mode session
```

`drift` returns `workspaceClean` and the complete workspace audit when
configured. Status reports the host binding's configured/source/hash fields.
Missing or legacy embedded bindings block enforced allocation. Session checks
gate on the local audit. CI reports the host-local gate as unavailable.

## Recovery

```bash
harness-automation rollback --project . --change <receipt-id>
```

Configuration rollback restores both the repository policy and host binding;
configuration and close rollback are refused after observed-state drift.
Close receipts that deleted branch refs are not automatically rollbackable;
the receipt retains the accepted SHA for a separate owner-approved recovery.
Allocation rollback does not remove a potentially valuable worktree; generate
a new close plan instead.

Never bypass a blocked result with force flags. Use the reported dirty evidence
to prepare a separate, owner-approved rescue or disposition plan.
