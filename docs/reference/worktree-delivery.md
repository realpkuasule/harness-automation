# Worktree Delivery CLI Reference

## Read-only commands

```bash
harness-automation worktree status --project .
harness-automation worktree audit --project .
harness-automation worktree retention-audit --project .
```

These commands require only Git. They do not require PRD intake and create no
worktree. Retention audit reports expired review receipts, lease heartbeats,
lifecycle locks, and remote branches; it deletes none of them.

## Configure

```bash
harness-automation worktree configure \
  --project . \
  --mode audit-only|enforced \
  --management-branch main \
  --allow-root /absolute/parent \
  [--protect-root /absolute/protected] \
  [--max-persistent 4] \
  [--lease-ttl-hours 168] \
  [--review-ttl-minutes 120] \
  [--remote-retention-days 14]
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
`--management-branch` identifies the one persistent management checkout without
putting a host-specific path in repository policy. Enforced audit fails closed
when that branch has zero or multiple observed checkouts. A detached Review
checkout is exempt only while it is the command checkout; persistent task
worktrees still require leases.

The approved plan writes portable policy to
`.harness/worktree-delivery.json` and host-specific canonical roots to
`<git-common-dir>/harness/worktree-delivery/host-binding.json`. The plan hash
covers both. On a new host, run configure again to approve that host's roots;
omitted portable options preserve the existing repository policy.
Existing v1 configurations without `managementBranch` retain the legacy
command-checkout behavior until an approved configure plan adds the selector.

## Allocate

```bash
harness-automation worktree allocate \
  --project . \
  --work-item github:owner/repository#24 \
  --branch issue-24 \
  --path /absolute/parent/issue-24 \
  --owner owner \
  [--thread thread-id] \
  [--start-point HEAD]
```

This writes only a plan. Apply it with:

```bash
harness-automation apply \
  --project . \
  --plan .harness/plans/<plan>.json \
  --approve <exact-sha256>
```

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

Close planning fails if HEAD is dirty, differs from Accepted Commit, or has no
remote reference. Applying the plan preserves local and remote branches.

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
Allocation rollback does not remove a potentially valuable worktree; generate
a new close plan instead.

Never bypass a blocked result with force flags. Use the reported dirty evidence
to prepare a separate, owner-approved rescue or disposition plan.
