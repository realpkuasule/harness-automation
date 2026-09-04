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
  Reports retain partial progress without claiming drain; pre-dispatch accounting
  and positive-result recovery still use the original approval-human receipt/LKG.
  Complete finite execution returns `2` / qualification `incomplete`, not PASS.
  See [CLI usage and limits](../reference/coordination.md#finite-local-qualification-cli).
- Synthetic publication shares private prepare/dispatch boundaries. Normal
  bootstrap/source publication invokes them consecutively; fixed same-SHA workers
  prepare independently before ordered sends. No dispatch lock spans supervisor
  waiting, and the private preparation cannot be serialized, swapped or replayed.
- `coordination/same_sha.ts` verifies real candidate/attempt facts and the narrow
  read-only rejected-recovery operation. The supervisor checks both prepared
  receipts before sending, verifies update/no-op outcomes, closes ordinary writes,
  then starts a fresh read-only process and checks unchanged original chain heads.
  `qualification_remote.observedQualificationCases` combines actual settlement,
  receipt facts and current approved remote history for four partial assertions.
  `qualification_cases.ts` retains the full fixed per-group assertion inventory;
  neither a manifest nor a passed subset can delete missing coverage or grant
  production authority.

Artifact inventory uses Node's package search paths, not dependency execution.
Type-only packages, hidden/redirected package exports and dependencies sharing a
name with a Node built-in are covered by regression tests. npm aliases bind to the
explicitly declared target package name, including scoped names. Package inspection does
not require a Harness Git clone and never substitutes the target project's HEAD.

All current qualification integration tests use disposable local Git repositories
and synthetic native GitHub/Keychain commands. They do not establish GitHub LIVE
qualification or production writer coverage.
