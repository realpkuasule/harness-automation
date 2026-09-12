# Coordination runtime checkpoint — Issue #86

This is implementation documentation, not production enablement or complete DG-01
qualification. Normal coordination CLI mutations remain gated while the full
transfer/takeover, qualification runner and adoption paths are unfinished.

- `approval/human.ts` stores fixed-purpose human tickets, candidate reservations,
  write attempts and outcomes in the existing receipt/LKG service. Every commit
  generation consumes a slot before Git runs; every network retry consumes a new
  attempt. Unknown outcomes block further writes and never refund either budget.
- `coordination/authorization.ts` connects those reservations to the Store and
  credential-bound transport. A successful push without exact history readback
  remains unknown. Recovery fetches validated remote history without replaying a
  push. It can record historical success only with durable positive evidence of
  that attempt's ref update, without restoring ownership or lease time. Same-SHA
  state alone cannot promote an unknown attempt; complete up-to-date/no-op output
  is rejected and remains rejected across process recovery.
- `coordination/handoff_record.ts` defines the strict transfer attachment without a
  new lifecycle state. An unaccepted handoff blocks ordinary writes, renew and
  rebind. A verified merge can still terminate that exact frozen generation; the
  pending attachment is superseded, with its evidence retained in Git history.
  Record shape and hashes alone are not native transfer or drain evidence.
- Recovery, worktree Apply and coordination now share one `apply.lock` acquisition
  implementation. Its opaque in-process handle cannot be imported from a path or
  JSON. Explicit `...Locked` quota/receipt calls borrow it without reacquiring it;
  ordinary nested acquisition still fails. Async owners await their operation before
  release. A checkout rename relocates only the same lock/common-dir identities and
  invalidates the old handle. Unknown owners, stale locks and failed releases remain
  recovery gates, not automatic cleanup candidates.
- `coordination/runtime.ts` assembles the actual native host binding, Keychain
  resolver, credential Broker, HTTPS Git transport, GitHub server clock and lifecycle
  handlers for a bounded qualification ticket. It does not require a pre-existing
  write PASS, create credentials, enable production or grant permission beyond the
  ticket. The finite multi-client publication path is described below; the complete
  qualification case runner and production adoption remain pending.
- `coordination/synthetic.ts` precomputes strict empty-tree descriptors without
  writing objects. The approved catalog binds control anchors and exact publication
  rights separately from read-only ancestors. `store.bootstrap` and
  `publication.runApprovedSourceFixture` share private object helpers and the same
  candidate/attempt receipts; neither accepts arbitrary CLI refs or object bytes.
  History v2 binds the complete approved genesis descriptor and endpoint. Ordinary
  CAS never bootstraps, and no other empty control commit is valid.
- `coordination/authority.ts` binds lifecycle proposals and Store dispatch to the
  same observed actor, installation, repository and control epoch. Acquire/rebind
  use the actual local branch and HEAD; knowing another owner's expected tuple is
  not authority. Direct Store calls cannot manufacture an authorized operation.
  The versioned epoch binds protocol, mode, coordination config and the actual
  policy-file digest (or explicit absence), excluding machine-specific fields.
  Qualification approves that isolated snapshot; it does not adopt production
  policy or make `configHash` alone a control epoch.
- `repository/artifact.ts` separates source and installed-package identity. Source
  qualification requires the actual clean Harness checkout's HEAD/tree. Installed
  packages verify `dist/runtime-manifest.json` against current runtime bytes; build
  generates this manifest. Both bind resolved dependency package identities and
  Node/platform/architecture. A changed dependency produces a different digest and
  cannot reuse the previous qualification. This is integrity binding, not a signed
  software-supply-chain attestation or resistance to a malicious same-UID actor.
- `coordination/qualification_plan.ts` validates native bindings and saves immutable
  manifests, target scopes and semantic packets in existing common-dir plan storage.
  Core plan hashing precedes packet derivation, avoiding a self-reference. Explicit
  CLI approval alone records human receipts; a saved confirmation is only a stable
  retry input, including after partial multi-common-dir registration.
- `coordination/cli.ts` awaits the fixed local runner, native remote observation and
  bounded cleanup in one process. Each deletion gets fresh cohort evidence. Runner,
  collector and cleanup handles are process-private and cannot be imported from JSON.
  On operation failure, a fixed cooperative abort can prove actual process-group
  drain while retaining the original error and completed prefix. Only that private
  settlement permits exact cleanup of a known published subset; absent refs use
  zero writes. Unknown launches, invalid IPC/identity, residual descendants or
  unresolved candidates/attempts still block cleanup. Safe cleanup never changes
  failed execution to PASS. Pre-dispatch accounting and positive-result recovery
  still use the original approval-human receipt/LKG.
  Complete finite execution returns `2` / qualification `incomplete`, not PASS.
  See [CLI usage and limits](../reference/coordination.md#finite-local-qualification-cli).
- Synthetic publication shares private prepare/dispatch boundaries. Normal
  bootstrap/source publication invokes them consecutively; fixed same-SHA workers
  prepare independently before ordered sends. No dispatch lock spans supervisor
  waiting, and the private preparation cannot be serialized, swapped or replayed.
- Store CAS and lifecycle acquire also share prepare/dispatch boundaries. A
  preparation owns its copied proposal and original parent, reserves candidate
  quota but no network attempt, and is single-use within the original instance.
  Dispatch rechecks retained objects and the original native authority/Broker
  guards; it does not change parents or preempt the actual Git stale rejection.
  The fixed two-client acquire execution profile is not yet wired in.
- `coordination/same_sha.ts` verifies real candidate/attempt facts and the narrow
  read-only rejected-recovery operation. The supervisor checks both prepared
  receipts before sending, verifies update/no-op outcomes, closes ordinary writes,
  then starts a fresh read-only process and checks unchanged original chain heads.
  `qualification_remote.observedQualificationCases` combines actual settlement,
  receipt facts and current approved remote history for four partial assertions.
  An aborted run with a declared resource phase additionally maps
  `dg01-acquire-contention/bounded-cleanup-authority`: it requires a proven drain, every
  publication step completed, the resource step not completed, and every publication ref
  gone from the remote afterwards. It reports `passed` only on those native facts, `failed`
  when a publication ref survived cleanup, and leaves the assertion not-run when the facts
  merely do not add up. A mapping failure is recorded as `caseError` in the failure report
  rather than changing the run's verdict.
  `qualification_cases.ts` retains the full fixed per-group assertion inventory, and
  `recordQualificationSubassertion` refuses unknown ids and never overwrites a recorded
  failure; neither a manifest nor a passed subset can delete missing coverage or grant
  production authority.
- Qualification `localResources` bind exact source fixtures, new paths/branches,
  authority/common-dir, local policy hashes, finite windows and capacity. The
  admission primitive shares worktree-delivery's path rules and local inventory,
  without invoking a Provider or copying credentials. One existing human receipt
  reserves the entire local batch under `apply.lock`; status/audit and normal
  allocation include those reservations. Closure/revocation do not refund them,
  and damaged receipt/LKG evidence is an error, not zero occupied capacity.
  `approval/human_resources.ts` now owns only pure event schemas/reduction; the
  original human ledger records import/create starts, positive ownership, partial
  progress and release/retain facts. The native creation primitive imports verified
  approved bytes, exclusively creates a directory, records exact-absent branch
  creation and uses non-force `worktree add --no-checkout`. Original checkout
  HEAD/index/files stay unchanged. Unknown creation results never confer ownership;
  even a fully observed registration after a nonzero add still preserves failure.
  Read-only observation rechecks directory identity, Git backlinks, exact synthetic
  head, all workspace assets and the original bounded registration metadata.
  Native close is implemented for every ownership phase. `reserved` reads the path and the ref
  and releases only on a real absence; a leftover directory retains as
  `QUALIFICATION_RESOURCE_OWNERSHIP_UNPROVEN` instead of returning its capacity slot.
  `mkdir-owned` and `add-started` close through the same checks minus worktree removal, using a
  non-recursive rmdir for an unregistered directory and retaining as
  `QUALIFICATION_RESOURCE_DIRECTORY_NOT_EMPTY` when anything unexpected is inside. Every failure
  path records a `retained` fact carrying its reason and evidence hash, so the last ownership
  phase, its evidence and the occupied capacity survive the refusal. An already-absent branch
  counts as removed rather than as `BRANCH_DELETE_FAILED`: git reports that case as
  "unable to resolve reference", which the previous stderr match never caught. Scoped workspace
  runtime and acquire profile execution remain pending. Existing publication profiles reject
  resource descriptors instead of silently allocating them. Per-worktree configuration is
  explicitly unsupported for these fixed fixtures; Harness does not copy or rewrite it.

Artifact inventory uses Node's package search paths, not dependency execution.
Type-only packages, hidden/redirected package exports and dependencies sharing a
name with a Node built-in are covered by regression tests. npm aliases bind to the
explicitly declared target package name, including scoped names. Package inspection does
not require a Harness Git clone and never substitutes the target project's HEAD.

All current qualification integration tests use disposable local Git repositories
and synthetic native GitHub/Keychain commands. They do not establish GitHub LIVE
qualification or production writer coverage.
