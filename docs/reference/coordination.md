# Remote coordination (v3 foundation)

`harness-automation coordination status` reports the local configuration state. Without a separately approved, qualified production configuration, every mutation command fails closed and performs no remote write.

The implementation uses one configured internal ref and exact-old-SHA Git `--force-with-lease` CAS. It provides only `coordinated` semantics; it cannot prevent an actor from bypassing Harness with direct Git access. The v1 record schema is [coordination-v1.schema.json](../api/coordination-v1.schema.json).

[Credential registration](credentials.md) has an explicit plan/apply CLI. Registering
references alone does not qualify or enable this coordination backend. Lifecycle
handlers and production transport integration are still under development; local
primitive tests are not a completed Wave 3 qualification.

Object storage never checks out the control tree. Only the exact approved empty
genesis and subsequent `records/<hash>.json` ordinary blobs are accepted; unknown entries, malformed records and failed reads
fail closed. Current limits are 10,000 records, 64 KiB per record and 8 MiB of
record content per tree; exceeding them reports a limit, never silently truncates.
Only the selected record changes, using exact-old-SHA Git CAS. A candidate must be
recorded before push. Unknown write outcomes retain its temporary objects for
same-transaction recovery; recovery never repeats the push or restores old ownership.

History starts from a separately approved empty-tree, parentless metadata-only root
commit. Its full precomputed bytes, tree/SHA and plan hash bind the history anchor
along with the repository, endpoint and control ref; success receipts never invent
that anchor. Ordinary acquire/CAS refuses an absent ref and cannot initialize it.
New segments
are validated against checkpoints in the existing receipt/LKG store. Cold validation
resumes in bounded batches (default 1,000 commits), without a cumulative history
limit. A checkpoint cannot supply owner, generation, expiry, or write permission.
Unknown intermediate records, divergent history, or an unapproved anchor block use.

`CoordinationClock` supplies conservative Date/RTT/monotonic bounds with explicit
clock limits. It rejects stale or malformed samples and clock discontinuities;
local wall time is only an anomaly detector. Acquire/rebind and renewal handlers
now require these bounds; pending renewal retains the old expiry and grants no
write permission. Renewal stores a timely readback proof before confirming its
new expiry without changing generation. A confirmation may finish after the old
expiry only with that prior proof, before the proposed expiry, and against the
same exact reservation. Production CLI assembly is still pending; LOCAL handler
tests do not constitute LIVE lease qualification.

Handoff now has three actual handlers: source freeze, source proof, then target
acceptance. Both hosts use their own bound source transport; the target never opens
the source machine's directory. Acceptance replaces ownership in one CAS and keeps
the original expiry. Late readback cannot grant a fresh lease. Clean assets alone
are insufficient: source proof also requires verified participating-writer coverage.
The native host coverage adapter is not yet present, so native proof publication
reports `COORDINATION_SOURCE_WRITER_COVERAGE_REQUIRED`. Controlled LOCAL fixtures
exercise this boundary without claiming real Agent/editor quiescence.

Participating writes and handoff reuse the existing common-dir `apply.lock`, with
owned in-process handles and awaited callbacks. `runManagedWrite` rechecks the exact
remote tuple, identity, epoch, local branch/HEAD and expiry at the write boundary;
queued writers cannot reuse admission from before a freeze. This does not fence
external editors, direct Git, unawaited child processes or adapters not yet wired in.

The GitHub read adapter now uses the approved native credential binding and fixed
Broker-authenticated GETs for server Date and PR merge facts. Terminal claim takes
a PR number and explicit target branch, not a caller-supplied merge SHA/JSON proof.
It checks the PR's merged state, exact source head/ref/repository ID and target
ref/repository ID before CAS. An unchanged expired generation may be terminated;
drifted ownership cannot. `lastObservedHead` stays the source commit; the separate
`integration` evidence records the merge commit, provider observation and binding.
This transition grants no write or cleanup authority. Synthetic native-command
tests validate the code path, not real Keychain/GitHub access or production readiness.

The fixed HTTPS Git adapter also uses the registered `git-transport` credential
through the Broker. It accepts only isolated bare object directories, rejects
custom Git config/alternates, disables inherited global credentials and redirects,
and preserves scrubbed nonzero CAS results for recovery classification. No writer
is installed by default: a separate qualification/production authority must approve
the exact ref, candidate, expected SHA and credential binding before a push. That
native isolated-qualification authority is implemented: it binds actual actor,
installation, workspace HEAD and host-independent control epoch, reserves candidate
and attempt budgets before their side effects, and recovers unknown outcomes without
replay. Full qualification/production CLI composition is still pending; metadata
reads and descriptive scopes do not establish production enablement.

Human-approved takeover now uses the same candidate/attempt receipt mechanism.
Its exact scope includes the old six-field expectation/control SHA, target
workspace/branch/HEAD/identity/epoch, structured asset risk, and a bounded new lease.
The target observer records content hashes (not contents), staged index identity,
dirty/untracked/ignored assets and actual source-ref divergence. Missing objects,
unsupported filters/submodules/hidden index flags, truncated observations and
inventory limits fail explicitly; failures never become zero asset counts. The
current inventory limit is 4,096 entries / 128 MiB of file content. A missing local
copy of the remote source commit requires authenticated retrieval before planning.

The source machine is explicitly **not observed**, not inferred offline or clean.
Takeover preserves all old assets/history, removes superseded handoff/renewal data,
increments generation once and fixes the new deadline before candidate creation.
An unknown applied write can be recovered after approval expiry without another
push or a new deadline. Ready loses its prior-generation authority and returns to
Active. MergeArmed requires prior verified disarming; Prepared/Draft currently
require the pending Delivery mapping observer. Terminal records cannot reopen.

Isolated takeover uses an explicitly approved child scope from a fixed allocation
in its qualification run. Parent ordinary quotas permanently subtract all such
allocations. Each allocation can register only one child, including across a crash
between the durable receipt and LKG append. Revocation/expiry stops new writes but
does not prevent result recording or read-only recovery. This is local static
budget allocation, not a cross-machine shared counter. Native command fixtures
exercise the registered Broker/Git composition; real credential access, complete
DG-01 LIVE qualification, production adoption and CLI assembly remain separate.

The bounded native runtime now publishes approved genesis and source fixtures
through the same candidate/attempt guards and private bare-object helpers. Pure
planning creates no Git objects. Materialization requires a candidate slot; the
first business record consumes a separate slot and is a child of genesis. The
approved catalog distinguishes control anchors, read-only source ancestors and
exact publication rights. Source fixtures contain only approved empty-tree ancestry,
never project objects or control records. CLI/full-run assembly remains pending.

Git exit 0 alone is not CAS success: exact-ref porcelain `up to date` is recorded as
`rejected` / `COORDINATION_CAS_NOT_PERFORMED`, with no quota refund. A positive ref
update is durably recorded before readback. Recovery needs that update evidence
plus validated history to mark the attempt applied; an observed SHA alone proves
only state, not which publisher won. Rejected attempts never become applied, and
an attribution-unknown synthetic attempt remains unknown with `state-observed`
recovery output. Recovery never grants a lease or automatic cleanup ownership.
