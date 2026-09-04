# Issue #86 protection-fault verification

Run `node mcp-server/scripts/verify-protection-faults.mjs` only from a clean
candidate commit. It copies the package into a fresh temporary directory,
removes Harness state, uses an empty HOME and offline dependencies, then runs
baseline → one mechanical fault → restored for every listed case.

Each case is valid only when baseline and restored pass and the mutant fails
the named test. The JSON report records the candidate SHA, exact patch hash,
argv, sanitized execution hashes and one of `correctly-caught`, `survived`,
`invalid-injection`, or `unable-to-execute`. Only `correctly-caught` is
acceptance evidence; a timeout, dependency error, skipped test, or a different
failed test is not a caught protection.

The current bounded matrix covers actor identity, expiry, exact old-SHA CAS,
stale owner, one-shot dispatch, preservation of another Work Item, and exact
remote-delete output. Local resource ownership/asset and unknown-result replay
remain covered by their focused native tests; do not claim a fault was caught
until it is added as a similarly reachable single-fault case.
