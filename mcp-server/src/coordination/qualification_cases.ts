import type { QualificationManifest } from "./manifest.js";

// Fixed acceptance inventory from Issue #86 §7. A selected group never loses its unexecuted assertions.
const assertions = {
  "dg01-identity-scope": ["actor-repository-credential", "distinct-installation-identity", "readonly-no-installation-created", "wrong-repository-id", "fork-source-mapping", "endpoint-rewrite", "multiple-push-urls", "secret-leak-prevention", "ambient-credential-rejected"],
  "dg01-cas": ["dual-acquire-single-winner", "stale-sha", "stale-generation", "stale-owner", "stale-head", "stale-epoch", "stale-record-hash", "other-work-items-preserved", "same-sha-update", "same-sha-noop-rejected", "same-sha-unique-winner"],
  "dg01-acquire-contention": ["dual-contention-single-winner", "stale-tuple-rebind-rejected", "per-transaction-differentiator", "bounded-cleanup-authority", "verifier-report-subassertion"],
  "dg01-objects-history": ["no-checkout", "unknown-path-mode", "symlink", "truncation", "read-failure-not-absent", "source-ancestor-rejected", "broken-chain", "unknown-intermediate-version", "cold-cache-resume", "long-history-batches", "checkpoint-not-authority"],
  "dg01-time-renew": ["timely-renew-same-generation", "expiry-boundary", "second-resolution-date", "round-trip-delay", "stale-time", "missing-time", "backward-time", "local-clock-jump", "suspend", "timeout-no-extension"],
  "dg01-late-renew": ["late-reservation-no-write-authority", "new-process-no-unproven-extension", "timely-proof-recovery", "takeover-competing-confirmation", "terminal-competing-confirmation", "unconfirmed-expiry-no-authority"],
  "dg01-recovery": ["cache-loss-preserves-remote", "crash-exact-candidate-history", "advanced-ref-no-repeat", "new-generation-no-repeat", "transaction-content-drift", "unknown-outcome-no-replay", "http-401", "http-403", "http-5xx", "old-sha-not-success", "rejected-restart-not-upgraded"],
  "dg01-handoff": ["target-fetch-exact-head", "single-cas-keeps-expiry", "frozen-write", "frozen-renew", "frozen-rebind", "forged-source-facts", "target-identity", "late-accept", "dirty-assets", "untracked-assets", "ignored-assets", "unique-commits", "unpushed-commits", "offline-assets", "asset-approval-drift", "old-generation-no-reauthorization"],
  "dg01-drain": ["inflight-writer-drained", "queued-writer-frozen", "cached-admission-invalidated", "uncovered-entrypoint", "missing-host-drain-proof", "borrowed-lock-no-reacquisition"],
  "dg01-terminal": ["exact-merge-after-expiry", "new-generation-rejected", "epoch-drift", "identity-drift", "claim-no-ttl-write-authority", "no-cleanup-token", "no-branch-worktree-deletion"],
  "dg01-cli-gates": ["native-handler-entrypoint", "unconfigured-zero-mutation", "unqualified-zero-mutation", "unapproved-enable-zero-mutation", "unknown-fields", "forged-approval", "forged-merge-evidence", "safe-mode-readonly-recovery"],
  "dg01-human-budget": ["first-bounded-write-not-production", "wrong-purpose", "wrong-ref", "wrong-actor", "wrong-repository", "wrong-endpoint", "wrong-hash", "expiry", "budget-exhaustion", "concurrent-quota", "unknown-recovery-no-replay-count", "retry-charged", "adopted-config-outlives-apply-ticket"],
} satisfies Record<QualificationManifest["requiredCases"][number], string[]>;

export function requiredQualificationCases(ids: QualificationManifest["requiredCases"]) {
  return ids.map((id) => ({ id, status: "not-run" as "not-run" | "incomplete",
    subassertions: assertions[id].map((name) => ({ id: name, status: "not-run" as "not-run" | "passed", evidenceHash: null as string | null })) }));
}
