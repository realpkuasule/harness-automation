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
  --allow-root /absolute/parent \
  --provider github \
  --provider-repository owner/repository \
  --project-owner owner \
  --project-number 2 \
  --status-field Workflow \
  --done-value Done
```

`--done-value` may repeat. GitLab and Jira currently report `blocked`.

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
configured. Session checks gate on the local audit. CI reports the host-local
gate as unavailable.

## Recovery

```bash
harness-automation rollback --project . --change <receipt-id>
```

Configuration and close rollback are refused after observed-state drift.
Allocation rollback does not remove a potentially valuable worktree; generate
a new close plan instead.

Never bypass a blocked result with force flags. Use the reported dirty evidence
to prepare a separate, owner-approved rescue or disposition plan.
