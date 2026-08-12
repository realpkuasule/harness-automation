# Issue #23 — atomic batch worktree adoption contract and RED plan

**Issue:** realpkuasule/harness-automation#23

**Owner:** realpkuasule

**Branch:** `codex/23-batch-worktree-adopt`

**Baseline:** accepted `v2.1.3` / `main`

**Date:** 2026-08-12
**Status:** contract-first implementation input

## Outcome

Add `worktree adopt`, a metadata-only batch operation that creates active leases
for existing persistent Git worktrees. Planning writes only the existing
immutable `.harness/plans/<id>.json` artifact. Apply may write lease and receipt
files under the Git common dir; it must never add/remove a worktree, create or
move a branch, change HEAD, touch an index or working-tree file, prune, clean,
checkout, reset, or delete a ref.

Dirty worktrees are valid adoption targets and their current evidence is
hash-bound. Detached, bare, locked, prunable, management/protected,
out-of-allowed-root, duplicate, already leased, or over-capacity targets fail
closed. The whole batch passes preflight before the first lease is written.

## Current architecture and reuse decision

The implementation already has the required transaction spine:

- `mcp-server/src/worktree/service.ts` observes canonical worktree, ref, dirty,
  lease, host-binding, configuration, and Provider state; writes immutable
  SHA-256 plans; applies under `<git-common-dir>/harness/worktree-delivery/apply.lock`;
  atomically writes files; records receipts; and guards rollback.
- `mcp-server/src/worktree/types.ts` owns the `WorkspaceOperation`,
  `WorkspacePlan`, `WorkspaceLease`, and `WorkspaceReceipt` unions.
- `mcp-server/src/worktree/provider.ts` already accepts any proposed lease list,
  loads configured GitHub Issue and Project state once per observation, and
  fails unavailable adapters closed.
- `mcp-server/src/v2/service.ts` routes any `kind: "workspace-plan"` through the
  workspace apply path and routes workspace receipt IDs through the workspace
  rollback path.
- `mcp-server/src/cli.ts` and `mcp-server/src/index.ts` are the existing CLI and
  MCP transport seams.

Therefore this issue adds one operation variant and one planner to the current
service. It does not add a batch framework, transaction class, alternate lock,
new state directory, dependency, daemon, or Provider abstraction.

One existing observation detail must be hardened for this contract: dirty
collection must use non-mutating Git observation (`--no-optional-locks`) and
`--untracked-files=all`; the adoption snapshot also hashes the per-worktree Git
index. This prevents planning from refreshing the index and distinguishes
staged/index drift that a combined working-tree patch alone cannot prove.

## Public input contract

### CLI manifest

The CLI accepts exactly one JSON manifest. Grouped repeatable flags are rejected
because optional per-item `thread` values make positional pairing ambiguous.

```json
{
  "schemaVersion": "worktree-adopt/1.0",
  "items": [
    {
      "workItem": "github:owner/repository#101",
      "owner": "alice",
      "thread": "codex-thread-101",
      "path": "/absolute/worktrees/issue-101",
      "branch": "codex/101"
    },
    {
      "workItem": "github:owner/repository#102",
      "owner": "bob",
      "path": "/absolute/worktrees/issue-102",
      "branch": "codex/102"
    }
  ]
}
```

The manifest is validated by the runtime schema and the published
`docs/api/worktree-adopt-v1.schema.json`. It is read-only input, not an apply
precondition: normalized items and every live observation are embedded in and
covered by the immutable plan hash. Items are trimmed, paths canonicalized, and
sorted by `workItem`, then path, so manifest ordering does not change a plan
when `now` and observed state are fixed.

Exact CLI flow:

```bash
harness-automation worktree adopt \
  --project /absolute/repository \
  --manifest /private/tmp/worktree-adopt.json

harness-automation apply \
  --project /absolute/repository \
  --plan .harness/plans/worktree-adopt-<id>.json \
  --approve <exact-64-character-plan-hash>

harness-automation rollback \
  --project /absolute/repository \
  --change worktree-adopt-<id>
```

Planning output remains the existing stable JSON envelope:
`planPath`, `planHash`, `operation: "adopt"`, and `warnings`.

### MCP

Add `harness_worktree_adopt`. MCP receives items directly, avoiding a transport-
local file:

```json
{
  "projectDir": "/absolute/repository",
  "items": [
    {
      "workItem": "github:owner/repository#101",
      "owner": "alice",
      "thread": "codex-thread-101",
      "path": "/absolute/worktrees/issue-101",
      "branch": "codex/101"
    }
  ]
}
```

`items` has `minItems: 1`; both the item and tool schemas use
`additionalProperties: false`. MCP and CLI call the same
`planWorkspaceAdoption` function and return the same plan summary.

## Data contract

Add these shapes in `mcp-server/src/worktree/types.ts`; names may be adjusted
only to match the file's existing naming convention, not to change semantics.

```ts
interface WorkspaceAdoptionInput {
  workItem: string;
  owner: string;
  thread?: string;
  path: string;
  branch: string;
}

interface WorkspaceAdoptionSnapshot {
  path: string;                 // canonical absolute path
  branch: string;
  head: string;
  branchHead: string;           // refs/heads/<branch>^{commit}
  indexHash: string;            // exact linked-worktree index bytes
  bare: false;
  detached: false;
  locked: false;
  prunable: false;
  dirty: boolean;
  dirtyEvidence: NonNullable<WorktreeRecord["dirtyEvidence"]>;
  dirtyPatch: NonNullable<WorktreeRecord["dirtyPatch"]>;
  snapshotHash: string;
}

interface WorkspaceAdoptionPlanItem {
  lease: WorkspaceLease;        // acceptedCommit = observed HEAD
  snapshot: WorkspaceAdoptionSnapshot;
  providerItem?: ProviderItemObservation;
  leasePath: string;            // common-dir-relative, exact file only
  beforeLeaseHash: null;        // hash-bound proof of absence
  afterLeaseHash: string;       // SHA-256 of prettyJson(lease)
}

interface WorkspaceLeaseChange {
  action: "create" | "remove" | "restore";
  workItem: string;
  path: string;
  branch: string;
  leasePath: string;
  beforeHash: string | null;
  afterHash: string | null;
}
```

Extend `WorkspaceOperation` with:

```ts
{
  kind: "adopt";
  configHash: string;
  hostBindingHash: string;
  refsHash: string;
  worktreeRegistrationHash: string;
  existingLeases: Array<{
    leasePath: string;
    sha256: string;
  }>;
  capacity: {
    limit: number;
    before: number;
    adopting: number;
    after: number;
  };
  providerHash: string;
  provider: ProviderObservation;
  items: WorkspaceAdoptionPlanItem[];
}
```

The existing top-level `WorkspacePlan.observedHash` remains authoritative and
covers configuration, host binding, all refs, all worktrees, all leases,
current Provider observation, and parse errors. The additive operation fields
make the adoption-specific approval reviewable and ensure the plan hash also
explicitly covers:

- work item, owner, optional thread, canonical path, and requested branch;
- observed HEAD and branch HEAD;
- detached/bare/locked/prunable flags;
- dirty flag, every non-ignored tracked/untracked path's status, size and
  content/symlink digest, binary patch size/digest, and index digest;
- lease-file absence and intended lease bytes/digest;
- the exact path and byte digest of every pre-existing lease;
- host-binding and portable configuration hashes;
- capacity before/requested/after/limit;
- configured Provider kind/repository/Project mapping and each Issue state,
  Project membership, configured status-field value, and URL;
- complete pre-adoption observed state, refs, and worktree registration.

For a clean target, `dirtyEvidence` is `[]` and `dirtyPatch` is the size/digest
of empty patch bytes; absence is never represented by an omitted hash field.

`WorkspaceReceipt` keeps all existing fields and adds optional fields so old
receipts remain readable:

```ts
beforeObservedHash?: string;
afterObservedHash?: string;
rollbackObservedHash?: string;
leaseChanges?: WorkspaceLeaseChange[];
compensationStatus?: "not-required" | "completed" | "failed";
rollbackAfter?: WorkspaceStatus;
```

Every successful adopt receipt requires these fields. `leaseChanges` records
each null-to-`afterLeaseHash` transition. The original apply
`afterObservedHash` is never overwritten by rollback.

## Planning preflight

`planWorkspaceAdoption` performs no Git or lease mutation and writes only the
immutable plan after every item passes:

1. Require configured `mode: "enforced"`, a loaded host binding, a non-empty
   batch, non-empty item fields, valid branches, and an error-free base
   observation. A legacy embedded binding still requires the existing
   hash-approved configure migration first.
2. Canonicalize and sort items. Reject duplicate work item, canonical path, or
   branch inside the batch.
3. Compute capacity once: `existing leases + batch size <= limit`.
4. Reject collisions with existing leases by work item, canonical path, or
   branch. Require the exact work-item lease file hash to be `null`, including
   when a malformed/unloaded file occupies that name.
5. Resolve exactly one observed worktree per path. Reject the management
   checkout, bare/detached/locked/prunable records, protected paths, paths
   outside all allowed roots, a requested branch unequal to the observed
   branch, and a local branch ref whose commit differs from observed HEAD.
   Index and state files must be regular, non-symlink files inside the Git
   common dir. Dirty patch capture disables external diff and textconv; other
   filesystem object types fail closed.
6. Observe configured Provider state for existing plus proposed leases. GitHub
   work items must name the configured repository and existing Issue number.
   When a Project is configured, the Issue must be present. Closed Issues and
   configured Done status values remain eligible because legacy migration must
   adopt them before the existing exact-hash `close` flow can retire their
   worktrees; the plan warns that close is a separate next step. `provider:none`
   remains valid; unavailable GitLab/Jira adapters remain blocked.
7. Capture index, dirty, patch, ref, registration, config, binding, capacity,
   Provider, lease-absence, and full observed hashes. Build active leases with
   `acceptedCommit = HEAD`, `workItemState = provider Issue state` when present,
   and one shared planning timestamp for `createdAt`/`heartbeatAt`.
8. Save the existing `schemaVersion: "worktree-delivery/1.0"`,
   `kind: "workspace-plan"` envelope with `operation.kind: "adopt"`.

Accepting dirty state is deliberate. Adoption protects it with metadata; it
does not declare its value, clean it, archive it, or make it safe to close.

## Exact-hash apply transaction

The adopt branch of `applyWorkspacePlan` uses the existing `apply.lock` and
this order:

1. Load and structurally validate the plan, embedded hash, exact approval, and
   repository/common-dir identity without writing.
2. Acquire the existing repository transaction lock. Perform idempotency checks
   under that lock.
3. Re-run the complete workspace and proposed-Provider observation under the
   lock using non-mutating Git reads. Compare top-level `observedHash` and every
   explicit adoption precondition: config, host binding, capacity, Provider
   Issue/Project/config, refs, registration, item path/branch/HEAD/index/dirty
   evidence/patch, and lease absence.
4. If any item differs, release the lock and fail with zero lease, worktree,
   ref, index, working-tree, or receipt writes. No item is allowed to pass
   independently.
5. Create the durable `started` receipt, then atomically write leases in sorted
   item order. After each write, verify its exact `afterLeaseHash` and record a
   step plus `leaseChanges` entry.
6. Re-observe. Assert all intended leases exist with exact hashes and the
   complete pre-existing lease set, configuration, binding, refs, registration,
   and adopted worktree snapshots remain unchanged. Record `beforeObservedHash`, `afterObservedHash`, per-item
   hashes, steps, and `compensationStatus: "not-required"`; mark applied.
7. On any failure after a lease was written, inspect only the tracked files
   created by this transaction. Remove one only if its current hash still equals
   the planned `afterLeaseHash`, in reverse order. Never remove or rewrite a
   pre-existing/changed lease. Record each compensated step and final
   `compensationStatus`. A compensation mismatch fails closed with the exact
   path and leaves the valuable worktree untouched.
8. Release the lock in `finally`.

Batch atomicity is lease-state atomicity: after success every lease exists; on
a handled failure none of this operation's unchanged new leases remains.
Receipts may expose a compensation failure, but no compensation path mutates a
worktree or ref.

## Guarded rollback

Adopt rollback runs through the existing unified `rollback --change` dispatch
and under the same `apply.lock`. It removes leases only, as one batch, after all
guards pass:

- receipt is applied, plan is the matching hash-bound adopt plan, and every
  required receipt hash/change field is valid;
- current full state equals the durable applied observation;
- every lease exists and equals its recorded `afterLeaseHash`;
- config, host binding, capacity-independent Git refs, registration, HEAD,
  branch, index, and dirty evidence still equal the applied snapshot;
- no later workspace receipt has a `leaseChanges.beforeHash` equal to an
  adopted lease's `afterLeaseHash`. Close, heartbeat, transfer, or any future
  lifecycle use must record that transition, even if that later attempt failed
  or was itself rolled back.

Any later use fails with `WORKSPACE_ROLLBACK_LATER_LIFECYCLE_USE`. Direct lease
editing/deletion or any other drift fails with the existing `WORKSPACE_DRIFT`
or `WORKSPACE_ROLLBACK_UNSAFE` guard. After full preflight, rollback removes the
exact lease files in reverse order. A partial removal failure recreates only
leases removed by that rollback from their hash-bound plan bytes. It never
touches an adopted worktree. The receipt retains apply hashes and adds
`rollbackObservedHash`/`rollbackAfter` before becoming `rolled-back`.

`leaseChanges` must also be populated by current allocate/close lease mutations
so later-use detection is durable and future lifecycle operations have one
small extension point. Legacy receipts without it remain readable; they cannot
postdate a newly created adoption lease.

## Stable error codes

Messages may add detail after `:`, but these prefixes are contract-stable.

| Code | Trigger |
|---|---|
| `WORKTREE_ADOPT_INPUT_INVALID` | Manifest/MCP item shape, blank field, or unknown field is invalid |
| `WORKTREE_ADOPT_BATCH_EMPTY` | No items supplied |
| `DUPLICATE_ADOPT_WORK_ITEM` | Batch repeats a work item |
| `DUPLICATE_ADOPT_PATH` | Batch repeats a canonical path |
| `DUPLICATE_ADOPT_BRANCH` | Batch repeats a branch |
| `DUPLICATE_WORK_ITEM_LEASE` | Existing lease owns the work item |
| `DUPLICATE_WORKTREE_PATH` | Existing lease owns the path |
| `DUPLICATE_WORKTREE_BRANCH` | Existing lease owns the branch |
| `WORKTREE_CAPACITY_EXCEEDED` | Existing plus requested leases exceed configured capacity |
| `WORKTREE_NOT_FOUND` | Path is not exactly one registered worktree |
| `WORKTREE_MANAGEMENT_CHECKOUT` | Target is the configured management checkout |
| `WORKTREE_BARE` / `WORKTREE_DETACHED` | Target is not a branch-attached persistent worktree |
| `WORKTREE_LOCKED` / `WORKTREE_PRUNABLE` | Git reports unsafe registration state |
| `WORKTREE_PROTECTED_PATH` / `WORKTREE_PATH_NOT_ALLOWED` | Canonical host binding rejects the path |
| `WORKTREE_BRANCH_MISMATCH` | Requested, observed, or local-ref branch/HEAD differs |
| `PROVIDER_WORK_ITEM_INVALID` | GitHub item does not identify the configured repo/Issue |
| `PROVIDER_PROJECT_ITEM_REQUIRED` | Configured Project does not contain the Issue |
| `PROVIDER_UNAVAILABLE` | Configured adapter/Issue/Project observation is unavailable |
| `PLAN_TAMPERED` / `APPROVAL_MISMATCH` / `PROJECT_MISMATCH` | Existing exact-plan guards fail |
| `WORKSPACE_LOCKED` | Another lifecycle transaction holds `apply.lock` |
| `WORKSPACE_DRIFT` | Any plan-bound apply/rollback observation changed |
| `WORKTREE_ADOPT_POSTCONDITION_FAILED` | Lease or preservation assertion fails after writes |
| `WORKTREE_ADOPT_COMPENSATION_FAILED` | A newly written lease cannot be safely removed |
| `WORKSPACE_ROLLBACK_LATER_LIFECYCLE_USE` | A later receipt consumed/changed an adopted lease |
| `WORKSPACE_ROLLBACK_UNSAFE` | Current lease/worktree state cannot be safely reversed |

Existing configuration/host-binding/plan/receipt errors retain their current
codes. Transport validation errors must be normalized to the input code rather
than leaking a raw Zod or `JSON.parse` message.

## RED matrix

Write these tests first and confirm they fail for the missing behavior rather
than fixture/setup errors.

| Test surface | RED case | GREEN assertion |
|---|---|---|
| `worktree/service.test.ts` | plans a clean two-item batch | one immutable adopt plan; worktree/ref/index/bytes/lease counts unchanged |
| `worktree/service.test.ts` | adopts dirty tracked, staged, untracked, renamed, deleted, conflict/symlink evidence | plan succeeds; evidence, patch and index hashes are present and apply changes only lease metadata |
| `worktree/service.test.ts` | plan-hash sensitivity table | fixed-time hash changes for work item, owner, thread, path, branch, HEAD, index, dirty bytes/status/patch, lease absence, binding, config/capacity, Issue and Project state |
| `worktree/service.test.ts` | unsafe planning table | stable rejection for empty/duplicate issue/path/branch, existing lease collision, detached, bare, locked, prunable, management/protected/out-of-root, branch mismatch, missing target, and over-capacity |
| `worktree/provider.test.ts` | prospective GitHub batch | validates configured repository, all Issues, Project membership/custom status field and active state; none/unavailable behavior unchanged |
| `worktree/service.test.ts` | apply drift table | approval/config/binding/provider/lease/path/branch/HEAD/index/dirty/ref drift produces zero leases and no receipt |
| `worktree/service.test.ts` | second lease write or postcondition fails | only this operation's already-created unchanged leases are compensated; pre-existing/changed leases and all worktrees remain untouched |
| `worktree/service.test.ts` | successful batch apply and replay | exact leases exist, receipt hashes/steps/changes/status are durable, worktree bytes/porcelain/refs/index are identical, replay is idempotent |
| `worktree/service.test.ts` | rollback success | removes exactly all adopted leases, preserves worktrees/refs/bytes, records rollback observation, and is idempotent |
| `worktree/service.test.ts` | rollback guard table | changed/missing lease, workspace drift, later close attempt/use, or mismatched plan/receipt refuses zero-write rollback |
| `worktree/service.test.ts` | rollback removal failure | recreates only leases removed by that rollback; reports compensation failure without touching worktrees |
| `v2/service.test.ts` | unified adopt apply/rollback | `kind: workspace-plan` and receipt ID dispatch through existing v2 entry points; legacy file plans still dispatch unchanged |
| `v2/cli.test.ts` | manifest CLI flow | validates manifest, plans batch, applies exact hash, rolls back by change ID, and prints stable JSON |
| `v2/mcp.test.ts` | MCP schema and call | tool is listed; item schema is strict; call returns the same plan contract |
| schema/runtime test | published manifest contract | schema and runtime agree on version, required fields, non-empty batch, absolute path, and rejected extras |
| legacy fixtures | v2.1.3 configure/allocate/close plans and receipts | unchanged 1.0 plan hashes load/apply/rollback with existing semantics |
| static docs/Skill test | command and safety wording | shipped Skill/reference expose manifest planning, exact hash apply, dirty acceptance, metadata-only mutation, and guarded rollback |

Failure injection should reuse the current atomic-write test seam or Vitest
module spy. Do not add a production storage interface solely for tests.

## Implementation paths and order

Keep one source-code writer across the transaction service and transports.

1. **Contract and RED**
   - `docs/api/worktree-adopt-v1.schema.json` (new manifest schema)
   - `mcp-server/src/worktree/types.ts`
   - `mcp-server/src/worktree/service.test.ts`
   - `mcp-server/src/worktree/provider.test.ts`
   - `mcp-server/src/v2/service.test.ts`
   - `mcp-server/src/v2/cli.test.ts`
   - `mcp-server/src/v2/mcp.test.ts`
2. **Minimum service GREEN**
   - `mcp-server/src/worktree/service.ts`
   - `mcp-server/src/worktree/provider.ts` only for configured-repository and
     active Project/Issue validation that cannot stay in the planner
3. **Existing transport wiring**
   - `mcp-server/src/cli.ts`
   - `mcp-server/src/index.ts`
   - `mcp-server/src/v2/service.ts` only if additive receipt dispatch typing is
     required; do not create a second apply/rollback path
4. **User and Agent contract**
   - `docs/design/worktree-delivery.md`
   - `docs/reference/worktree-delivery.md`
   - `skills/manage-worktree-delivery/SKILL.md`
   - `skills/manage-worktree-delivery/references/safety-model.md`
   - `README.md`
   - `CHANGELOG.jsonl` referencing Issue #23

Do not edit generated `dist/`, application-independent legacy task-board code,
dependency manifests/lockfiles for feature implementation, the user's untracked
`.harness/plans/`, or any Auto-Demo repository/worktree.

## Compatibility and migration

- Keep `schemaVersion: "worktree-delivery/1.0"` for workspace plans/receipts.
  Add `operation.kind: "adopt"`; do not reinterpret or reserialize the three
  existing operation shapes when verifying their embedded hashes.
- `loadWorkspacePlan` continues to accept all v2.1.3 configure/allocate/close
  plans. Adopt validation is strict only when `kind === "adopt"`.
- The aggregate `workspaceStatus.observedHash` retains v2.1.3 Git status and
  Provider ordering semantics. Exact nested untracked evidence and sorted
  Provider items are adoption-operation data only.
- New receipt fields are additive/optional for readers and required only on a
  new adopt receipt. Existing receipts and lease JSON remain valid.
- Existing leases are never rewritten. There is no automatic scan/adoption.
  Operators explicitly prepare a manifest, review the complete plan hash, and
  apply it.
- Legacy configs with embedded host roots remain audit-readable but adoption is
  blocked until the existing configure migration produces a host binding.
- CLI/MCP additions do not alter configure, allocate, review, status, audit,
  close, retention, file-plan apply, or legacy rollback routing.
- A patch npm release happens only after merge/independent review and the full
  prepublish gate succeeds. Per repository guardrails, request an OTP only after
  `prepublishOnly` (or equivalent) has completed successfully, then publish
  immediately; versioning is not part of this feature diff.

## Non-goals

- No `git worktree add/remove/prune/repair`, checkout, branch/ref creation,
  movement or deletion, remote deletion, index refresh, stash, reset, clean,
  commit, push, dirty cleanup, archive, patch export, or automatic close.
- No inference of work item, owner, thread, path, or branch from directory
  names, commits, Agents, GitHub assignees, or Auto-Demo state.
- No automatic adoption of every orphan reported by audit and no partial-batch
  success mode.
- No Provider credentials, hosted control plane, background heartbeat, new
  GitLab/Jira adapter, Codex Thread adapter, queue, database, or dependency.
- No claim that dirty content is valuable, licensed, accepted, backed up, or
  safe to remove. Adoption only gives it a governed persistent lease.
- No inspection or modification of `/Users/zhichao/codex/auto-demo` or any of
  its worktrees.

## Risks and constraints

- The transaction lock serializes Harness lifecycle writers, not arbitrary Git,
  filesystem, or remote Provider actors. Lock-held re-observation plus
  postcondition verification detects their drift; a remote change immediately
  after the final Provider read remains an unavoidable point-in-time boundary.
- Dirty evidence covers Git-visible tracked and non-ignored untracked paths.
  Ignored artifacts are intentionally not catalogued, but the operation has no
  code path that writes inside an adopted worktree.
- Index-byte hashing may fail closed on harmless stat-cache changes. That is the
  correct tradeoff for an exact adoption approval; regenerate the plan rather
  than weakening the guard.
- A killed process between lease write and compensation can leave a `started`
  receipt and partial new leases. Re-running apply must inspect that receipt and
  either complete only when all hashes match or report recovery-required; it
  must never assume ownership of an unknown lease.
- Receipt deletion outside Harness can erase later-use evidence. This is
  equivalent to direct governance-state tampering and remains outside the
  threat model; current lease/full-state hash guards still fail most such cases.

## Verification and completion

```bash
cd /Users/zhichao/codex/harness-automation/mcp-server
npm test
npx tsc --noEmit
npm run lint
npm run prepublishOnly
npm pack --dry-run --json

cd /Users/zhichao/codex/harness-automation
python3 -m unittest discover -s scripts/tests
bash skill/install.test.sh
git diff --check
```

Completion requires a requirement-by-requirement audit plus independent review:

- plan is reviewable and hash-sensitive to every required local/Provider input;
- planning changes no worktree/ref/index/lease state;
- apply performs one lock-held all-batch preflight and preserves every adopted
  worktree while producing either all intended leases or no safe new leases;
- receipt and compensation evidence is durable and hash-specific;
- rollback removes only unused, unchanged leases created by this adoption;
- CLI, MCP, runtime types, schema, docs, Skill, and tests agree;
- v2.1.3 plans/receipts and all existing lifecycle commands still pass;
- no Auto-Demo path was read or changed;
- full prepublish validation passes before any npm OTP request.
