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
  push, and can record historical success without restoring ownership or lease time.
- `coordination/handoff_record.ts` defines the strict transfer attachment without a
  new lifecycle state. An unaccepted handoff blocks ordinary writes, renew and
  rebind. A verified merge can still terminate that exact frozen generation; the
  pending attachment is superseded, with its evidence retained in Git history.
  Record shape and hashes alone are not native transfer or drain evidence.
- `coordination/runtime.ts` assembles the actual native host binding, Keychain
  resolver, credential Broker, HTTPS Git transport, GitHub server clock and lifecycle
  handlers for a bounded qualification ticket. It does not require a pre-existing
  write PASS, create credentials, enable production or grant permission beyond the
  ticket. Multi-client run manifests and the complete CLI runner are still pending.
- `repository/artifact.ts` separates source and installed-package identity. Source
  qualification requires the actual clean Harness checkout's HEAD/tree. Installed
  packages verify `dist/runtime-manifest.json` against current runtime bytes; build
  generates this manifest. Both bind resolved dependency package identities and
  Node/platform/architecture. A changed dependency produces a different digest and
  cannot reuse the previous qualification. This is integrity binding, not a signed
  software-supply-chain attestation or resistance to a malicious same-UID actor.

Artifact inventory uses Node's package search paths, not dependency execution.
Type-only packages, hidden/redirected package exports and dependencies sharing a
name with a Node built-in are covered by regression tests. npm aliases bind to the
explicitly declared target package name, including scoped names. Package inspection does
not require a Harness Git clone and never substitutes the target project's HEAD.

All current qualification integration tests use disposable local Git repositories
and synthetic native GitHub/Keychain commands. They do not establish GitHub LIVE
qualification or production writer coverage.
