# Issue #86 protection-fault verification

Run `node scripts/verify-protection-faults.mjs` only from a clean
candidate commit. It copies the package into a fresh temporary directory,
removes Harness state, uses an empty HOME, a real per-run temporary directory
and offline dependencies, then runs baseline → one mechanical fault → restored
for every listed case. The temporary directory matters: with `TMPDIR` unset,
`os.tmpdir()` returns `/tmp`, which is a symlink to `/private/tmp` on macOS,
and the harness correctly refuses a worktree whose parent is a symlink — so any
case that allocates a worktree would die as `WORKTREE_PATH_PARENT_NOT_DIRECTORY`
before its fault could be exercised.

`copied-private-handle` is one structural fault model with two adjacent substitutions: it makes the private
preparation registry enumerable and then uses that erroneous fallback. A one-line lookup substitution cannot
obtain a `WeakMap` value and is correctly classified as an unrelated runtime failure instead of coverage.

Each case is valid only when baseline and restored complete normally with exit
`0`, and the mutant completes normally with exit `1` while failing the one
named test at its predefined assertion prefix and source location. The JSON
report records the candidate SHA, exact patch hash, argv, structured Vitest
result, sanitized execution hashes and one of `correctly-caught`, `survived`,
`invalid-injection`, `unrelated-failure`, or `unable-to-execute`. A matching
exit code, test name, or error text alone is insufficient:
the failure must also point at the named assertion location. The built-in `--self-test` proves that a same-exit,
same-prefix failure at another assertion location is rejected, and that a
passing JSON report with a nonzero exit or a timed-out mutant is not accepted.
Only `correctly-caught` is acceptance evidence; a timeout, dependency error,
skipped test, or a different failed test is not a caught protection.

An assertion location is anchored to the assertion's own source text rather than
to a line number, and the runner resolves it to lines before any sandbox is built.
Any line carrying the anchor is an acceptable proof, because the run executes one
named test by name, so the stack line can only come from that test. An anchor that
matches nothing stops the run as `PROTECTION_FAULT_ANCHOR_STALE`, and one that
matches more than eight lines stops it as `PROTECTION_FAULT_ANCHOR_AMBIGUOUS`;
neither can silently pass. This replaced pinned line numbers, which every edit
above an assertion invalidated.

| Requirement IDs | Protection / fault IDs | Target test evidence |
|---|---|---|
| D-01, D-02 | actor identity and stale owner (`identity-owner`, `stale-owner`); expiry, revocation, closed writes and write budget (`expired-write`, `revoked-write`, `writes-closed`, `write-budget`); one-shot send and copied private handle (`one-shot`, `copied-private-handle`) | named authority, lease, human-approval, publication tests fail at the declared assertion location |
| W-07, D-02 | exact old-SHA CAS and preservation of another Work Item (`exact-cas`, `other-work-item`) | stale-dispatch / tree-preservation assertions fail at their declared locations |
| L-03, L-04 | exact remote-delete result and no replay after unknown result (`remote-delete`, `unknown-replay`) | porcelain and recovery-write-count assertions fail at their declared locations |
| W-06, W-13 | canonical local path, empty assets and stable directory identity (`local-canonical-path`, `local-assets`, `local-directory-identity`) | local-resource assertions fail at their declared locations, with primary assets still preserved |
| D-01 | scope binding between the approved `localResources` and the runtime workspace context (`local-runtime-context-leak`) | the binding-drift assertion fails at its declared location with `HUMAN_AUTHORIZATION_BINDING_MISMATCH` |
| W-07 | two local writers competing for one control ref resolve to one winner (`local-acquire-contention`) | the contention assertion fails at its declared location with `COORDINATION_CAS_CONFLICT` for the loser |
| L-03 | a local branch advanced past its recorded source SHA is retained rather than deleted (`local-close-branch-drift`) | the exact-SHA retention assertion fails at its declared location |
| L-02 | the disposable ignored set cannot change between the approved plan and close (`local-disposable-drift`) | the disposed count and hash recheck fails at its declared location with `WORKSPACE_DRIFT: ignored close content changed` |


The structured report, rather than this table, is the source of case-level evidence: it records the exact source SHA,
patch hash, setup and test argv, sanitized execution environment, test ID, the resolved assertion locations, and output hashes.
