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
omitted portable options preserve the existing repository policy.
Existing v1 configurations without `managementBranch` retain the legacy
command-checkout behavior until an approved configure plan adds the selector.

### Legacy migration preflight

Existing flat layouts are never moved, renamed, deleted, or reconfigured into a
container automatically. Generate an independently hash-bound, plan-only
preflight instead:

```bash
harness-automation worktree migrate \
  --project /absolute/legacy-checkout \
  --workspace-container /absolute/new-container
```

It records management checkout, host binding and lease hashes, refs, registered
worktrees, dirty/unique/unpushed evidence, and all referenced paths, together
with the target `main/` and `worktrees/` mapping. `apply` deliberately rejects
this operation: a future dedicated migration executor must receive a separate
exact-hash approval. No GitHub Team plan or configuration is involved.

### Delegated AI authorization

Per-plan human approval remains the default. A host may instead delegate selected
operations once through the same exact-hash configure transaction:

```bash
harness-automation worktree configure \
  --project . \
  --approval-mode delegated-ai \
  --reviewer-model <pinned-claude-model> \
  --delegate-operation allocate \
  --delegate-operation renew
```

The delegation is host-local. It uses the already authenticated Claude Code CLI
in safe mode with no tools or session persistence; credentials are never stored
in policy, plans, decisions, or receipts. After generating a worktree plan, ask
the reviewer to decide and apply it without copying the plan hash:

```bash
harness-automation worktree apply-ai \
  --project . \
  --plan .harness/plans/<plan>.json \
  --intent "Create one isolated workspace for GitHub Issue #113."
```

The reviewer emits `approve`, `deny`, or `abstain`. Its durable decision binds
the exact plan, intent, host policy, repository observation, reviewer model, and
TTL. Apply still rechecks deterministic preconditions under the repository lock
and writes the normal lifecycle receipt. Missing, expired, malformed,
out-of-scope, or uncertain decisions make zero lifecycle writes. Delegated
`close` and `recover` additionally require zero dirty, ignored, unique, and
unpushed evidence. `configure` and rollback cannot be delegated.

This local mode separates normal execution from model review but is not a
security boundary against a malicious process running as the same OS user.
Use a separately protected local broker if that stronger threat model matters.

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

This writes only a plan. In manual mode apply it with:

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
