# Issue #86 protection-fault verification

Run `node mcp-server/scripts/verify-protection-faults.mjs` only from a clean
candidate commit. It copies the package into a fresh temporary directory,
removes Harness state, uses an empty HOME and offline dependencies, then runs
baseline → one mechanical fault → restored for every listed case.

`copied-private-handle` is one structural fault model with two adjacent substitutions: it makes the private
preparation registry enumerable and then uses that erroneous fallback. A one-line lookup substitution cannot
obtain a `WeakMap` value and is correctly classified as an unrelated runtime failure instead of coverage.

Each case is valid only when baseline and restored pass and the mutant fails
the one named test at its predefined assertion prefix and source location. The JSON report records the candidate SHA, exact patch hash,
argv, structured Vitest result, sanitized execution hashes and one of `correctly-caught`, `survived`,
`invalid-injection`, or `unable-to-execute`. A matching exit code, test name, or error text alone is insufficient:
the failure must also point at the named assertion location. The built-in `--self-test` proves that a same-exit,
same-prefix failure at another assertion location is rejected. Only `correctly-caught` is
acceptance evidence; a timeout, dependency error, skipped test, or a different
failed test is not a caught protection.

The current bounded matrix covers actor identity, expiry, exact old-SHA CAS,
stale owner, one-shot dispatch, preservation of another Work Item, and exact
remote-delete output. Local resource ownership/asset and unknown-result replay
remain covered by their focused native tests; do not claim a fault was caught
until it is added as a similarly reachable single-fault case.
