# Worktree Delivery Dogfood

- Issue: [#6](https://github.com/realpkuasule/harness-automation/issues/6)
- Baseline: `bcda44377fb6ab61a383cdc156dd5bd24da077bd`
- Date: 2026-07-28

## Verified

- Unconfigured `status`, `audit`, and `retention-audit` created zero worktrees.
- Exact-hash configuration apply produced a durable `applied` receipt.
- Configured audit reported `configured`, `loaded`, `enforced`, and `passing`
  as `true`.
- Drift reported `clean=true` and `workspaceClean=true`.
- A detached temporary review ran `node --version`, created no branch, exited
  successfully, and was immediately removed.
- Allocation rejected a branch already checked out in another worktree.
- Exact-hash allocation created one clean persistent worktree and one lease for
  Issue #6.
- A second allocation for Issue #6 was rejected with
  `DUPLICATE_WORK_ITEM_LEASE`.
- Exact-hash close removed only the persistent worktree and lease. The local
  Issue branch and remote refs remained.
- Receipt-checked rollback removed the host-specific dogfood configuration and
  restored the unconfigured audit-only baseline.
- GitHub API exhaustion reported the Provider as unavailable and changed
  `passing` to `false`.
- The focused worktree/provider suite passed 23 tests and the full suite passed
  457 tests across 36 files; lint completed with the repository's existing
  warning-only baseline.
- No command deleted a local or remote branch.

## Evidence

| Operation | Result |
| --- | --- |
| Configure plan | `7dd890d70315232f90b8575ac8462d6337f793b4bc862e58d08de9814df0dea5` |
| Configure receipt | `worktree-configure-2026-07-28T11-02-00-467Z-8f0266adcf07` |
| Temporary review | `review-2026-07-28T11-09-01-817Z-aa93b655debd`, `cleaned` |
| Allocate plan | `220c6717ab3f78dbfaa767c5f9ab5ed819be73740d8c281de386d7aa4f0f8ec2` |
| Allocate receipt | `worktree-allocate-2026-07-28T11-11-09-743Z-11d2e7286ea6` |
| Close plan | `dd0b91e0c10c842cdbf6838620900119fdee4905c169fc17159d2c77f0e38853` |
| Close receipt | `worktree-close-2026-07-28T11-21-17-480Z-a938131fc5cc` |
| Persistent path | `<host-worktree-root>/issue-6` |
| Work item | `github:realpkuasule/harness-automation#6` |

## Release blockers

1. [#7](https://github.com/realpkuasule/harness-automation/issues/7):
   `gh project item-list` flattens `Status` as `status`, but the Provider
   performs a case-sensitive lookup. The Project item is found while
   `projectStatus` remains missing, weakening Done-residual enforcement.
2. [#8](https://github.com/realpkuasule/harness-automation/issues/8):
   repository configuration requires absolute host paths for `allowedRoots`
   and `protectedRoots`. The generated file therefore embeds one developer's
   machine path even though the design says project configuration belongs in
   the repository. A portable repository policy needs a deterministic
   host-local override or path-template contract before release.

## Release recommendation

Do not publish the worktree capability yet. Fix #7 and #8 under their own
governed work items, then repeat this dogfood flow and full prepublish
validation.
