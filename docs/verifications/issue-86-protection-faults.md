# Issue #86 protection-fault verification

Run `node scripts/verify-protection-faults.mjs` only from a clean
candidate commit. It copies the package into a fresh temporary directory,
removes Harness state, uses an empty HOME and offline dependencies, then runs
baseline → one mechanical fault → restored for every listed case.

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

| Requirement IDs | Protection / fault IDs | Target test evidence |
|---|---|---|
| D-01, D-02 | actor identity and stale owner (`identity-owner`, `stale-owner`); expiry, revocation, closed writes and write budget (`expired-write`, `revoked-write`, `writes-closed`, `write-budget`); one-shot send and copied private handle (`one-shot`, `copied-private-handle`) | named authority, lease, human-approval, publication tests fail at the declared assertion location |
| W-07, D-02 | exact old-SHA CAS and preservation of another Work Item (`exact-cas`, `other-work-item`) | stale-dispatch / tree-preservation assertions fail at their declared locations |
| L-03, L-04 | exact remote-delete result and no replay after unknown result (`remote-delete`, `unknown-replay`) | porcelain and recovery-write-count assertions fail at their declared locations |
| W-06, W-13 | canonical local path, empty assets and stable directory identity (`local-canonical-path`, `local-assets`, `local-directory-identity`) | local-resource assertions fail at their declared locations, with primary assets still preserved |

The structured report, rather than this table, is the source of case-level evidence: it records the exact source SHA,
patch hash, setup and test argv, sanitized execution environment, test ID, assertion location, and output hashes.
