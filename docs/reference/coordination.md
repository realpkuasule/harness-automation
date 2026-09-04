# Remote coordination (v3 foundation)

`harness-automation coordination status` reports the local configuration state. Without a separately approved, qualified production configuration, every mutation command fails closed and performs no remote write.

The implementation uses one configured internal ref and exact-old-SHA Git `--force-with-lease` CAS. It provides only `coordinated` semantics; it cannot prevent an actor from bypassing Harness with direct Git access. The v1 record schema is [coordination-v1.schema.json](../api/coordination-v1.schema.json).

[Credential registration](credentials.md) has an explicit plan/apply CLI. Registering
references alone does not qualify or enable this coordination backend. Lifecycle
handlers and production transport integration are still under development; local
primitive tests are not a completed Wave 3 qualification.

Object storage never checks out the control tree. Only `records/<hash>.json`
ordinary blobs are accepted; unknown entries, malformed records and failed reads
fail closed. Current limits are 10,000 records, 64 KiB per record and 8 MiB of
record content per tree; exceeding them reports a limit, never silently truncates.
Only the selected record changes, using exact-old-SHA Git CAS. A candidate must be
recorded before push. Unknown write outcomes retain its temporary objects for
same-transaction recovery; recovery never repeats the push or restores old ownership.

History starts from a separately trusted, metadata-only root commit. New segments
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
same exact reservation. Provider clock/CLI assembly and the full handoff protocol
are still pending; LOCAL handler tests do not constitute LIVE lease qualification.
