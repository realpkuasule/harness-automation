# Project Governance Update Design

## Decision summary

- Issue: `realpkuasule/harness-automation#69`.
- Formal interface: `harness-automation update plan --project <absolute-path>`.
- `upgrade plan`, `plan --upgrade`, `plan --update`, and an MCP update tool are deliberately absent, so there is one public entry point.
- Update planning is a thin orchestration path around the existing v2 compiler and file-plan lifecycle. `apply`, receipt, rollback and worktree execution remain unchanged owners.
- A current no-op returns without creating a plan. A non-empty candidate writes exactly one immutable policy plan under `.harness/plans/`.
- Weakening approval and TypeScript naming adoption remain typed evidence in intake; a normal plan-hash approval cannot substitute for either.

## Existing owners to reuse

| Responsibility | Existing owner | Update use |
|---|---|---|
| source approval and hashing | `v2/service.ts`: `intakeProject`, `ensureApprovedSources` | Validate current intake and approved bytes before planning |
| repository discovery | `v2/discovery.ts`: `discoverProject` | Recompute an in-memory observation and reject semantic drift |
| policy compilation | `v2/policy.ts`: `compilePolicy` | Compile the candidate from inherited configuration |
| target rendering | `v2/service.ts`: `operation`, `renderEffectivePolicy`, managed-block upsert | Produce the same file operations as ordinary plan |
| canonical hashing | `v2/fs.ts`: `hashObject`, `withoutHash`, `fileHash` | Hash the complete update plan and every target |
| apply transaction | `v2/service.ts`: `applyPlan` / `applyFilePlan` | Validate and apply the update plan with no new executor |
| receipt and rollback | `v2/service.ts`: `AppliedChange`, `rollbackChange` | Preserve history and restore exact before bytes |
| worktree observation/config plan | `worktree/service.ts`: `workspaceStatus`, `loadConfig`, `planWorkspaceConfiguration` | Read compatibility and, only when lossless, emit a separate workspace plan |

`v2/service.ts` is the owning orchestration module. No new `update/` subsystem is warranted.

## Compiler identity and compatibility

The compiler identity is a value object used identically in policy and manifest:

```ts
interface CompilerIdentity {
  package: "@realpkuasule/harness-automation";
  version: string; // exact package.json semver, e.g. 2.8.1
}
```

New policy and manifest output records this object. Readers accept legacy policy without the field and legacy manifest strings such as `harness-automation@2`, but never convert them into a guessed version.

Doctor derives one of four states without network access:

| State | Deterministic condition |
|---|---|
| `unconfigured` | policy or manifest is absent, with no complete compiled project state |
| `legacy-version-unknown` | compiled state exists but either artifact lacks a parseable exact compiler identity |
| `current` | policy and manifest identities agree and equal the local package identity |
| `stale` | exact identity exists but differs from local, or policy and manifest exact identities disagree |

An inconsistency is included in diagnostics; it is never collapsed to `current`.

The current policy schema remains backward-readable. `project.profile` and root `compiler` are optional while reading legacy policy and always present in newly compiled policy. Legacy profile inheritance uses the stored discovery profile only; it is never inferred from a similar-looking stack set. If no trustworthy stored profile exists, planning fails with a re-intake/discover action.

## Planning algorithm

`planProjectUpdate` is the canonical service alias over the existing orchestration and performs these steps in order:

1. Resolve the absolute project root and read policy, manifest, intake and discovery. Missing policy is `HARNESS_INITIALIZATION_REQUIRED`; a policy with incomplete applied state fails separately.
2. Read the current compiler identity from the executing package metadata.
3. Validate intake shape and each approved source hash using the existing source guard.
4. Re-run `discoverProject` in memory with the stored `generatedAt`, then compare its canonical semantic hash with `.harness/discovery.json`. Also require discovery to be no older than intake. Any mismatch fails before a plan file is written and points to `intake` then `discover` as applicable.
5. Extract one inherited configuration from existing policy: owner, profile, stacks, deliveryProfiles, domainProfiles, qualityProfiles, phase and every recognized explicit project option. Missing arrays normalize only for legacy absence; present values are copied exactly. Unknown explicit fields fail closed instead of being dropped.
6. Invoke the existing compiler with that configuration and the current approved intake/discovery. Restore inherited phase/name fields that are not compiler choices. Apply the existing naming-baseline transition: multiset intersection for preserve/shrink; expansion only when the existing fresh adoption-intake contract is explicitly selected.
7. Add the exact compiler identity, render the same policy/generated/managed targets and manifest, and build normal `FileOperation` entries containing all before/after hashes.
8. Compare policies by stable rule ID and compute the semantic diff. Persist and compare canonical EDD suite semantics (target, tasks, graders, traceability and known-bad control). A legacy policy without this snapshot may inherit it only when its eval source hashes exactly match the current approved set; otherwise planning fails closed. Bind the weakening digest to the before/after policy digests, rule/eval diff, reasons and rule IDs. Compare baseline, sources, compiler/schema and adapter coverage separately.
9. Read worktree status only when `.harness/worktree-delivery.json` exists. Never invoke allocate, adopt, close, migrate apply, `git worktree add/remove`, checkout or branch commands.
10. If the candidate has no semantic, identity or target-hash change, return `{status:"current", planPath:null, planHash:null}` without writing a policy plan. Companion configuration or migration reporting is independent and cannot create an empty policy plan.
11. Otherwise embed the complete update metadata into the existing file plan, compute its normal full `planHash`, and atomically write one `.harness/plans/<id>.json`.

The plan command never executes verification argv. Those commands remain reported as planned evidence and run through existing check modes after apply.

## Plan contract

New `ChangePlan` files write optional `update` metadata. The apply reader also accepts the 2.8.1 preview's `upgrade` envelope, but rejects a plan containing both; the only public command is `update plan`, and the same executor remains authoritative:

```ts
interface UpdateMetadata {
  from: { compiler: CompilerIdentity | null; compilerStatus: "exact" | "legacy-version-unknown"; schemaVersion: string };
  to: { compiler: CompilerIdentity; schemaVersion: string };
  inherited: {
    owner: string;
    profile: StackProfile;
    stacks: Stack[];
    deliveryProfiles: DeliveryProfile[];
    domainProfiles: DomainProfile[];
    qualityProfiles: QualityProfile[];
    phase: PolicyDocument["project"]["phase"];
  };
  drift: {
    intake: { expected: string; actual: string; clean: boolean };
    discovery: { expected: string; actual: string; clean: boolean };
    sources: Array<{ path: string; expected: string; actual: string | null; clean: boolean }>;
  };
  rules: {
    added: string[];
    removed: string[];
    changed: Array<{ ruleId: string; fields: SemanticFieldChange[] }>;
  };
  evaluations: {
    added: string[];
    removed: string[];
    changed: Array<{ suiteId: string; fields: SemanticFieldChange[] }>;
  };
  adapterCoverage: { before: string[]; after: string[]; added: string[]; removed: string[] };
  baseline: { before: string[]; after: string[]; added: string[]; removed: string[] } | null;
  targets: Array<{ path: string; beforeHash: string | null; afterHash: string }>;
  weakening: { detected: boolean; ruleIds: string[]; reasons: WeakeningReason[]; digest: string; approved: boolean };
  worktree: WorktreeUpdateStatus;
  migrationRequired: boolean;
}
```

All arrays are deduplicated and sorted before hashing. `targets` is derived from `operations`, not independently authored. The apply validator recomputes the outer plan hash, from/to compiler and policy digests, inherited configuration, intake/discovery/source drift, semantic diff, adapter coverage, worktree status and weakening digest; a companion workspace plan is independently hash-checked. Any mismatch is rejected before target writes.

## Semantic diff and weakening

Rules align only by `PolicyRule.id`. The canonical semantic projection contains `status`, `severity`, `formalization`, `scope.include`, `scope.exclude`, `scope.boundaries`, normalized targets (`kind`, `adapter`, `configPath`, argv) and verification (argv, criteria, timeout). Title, statement, rationale, source refs, examples and change-control changes are reported but do not alone prove weakening.

The following deterministic transitions are weakening:

- active rule removed or changed to proposed/disabled;
- severity `error→warn/info` or `warn→info`;
- formalization `deterministic→procedural/cognitive` or `procedural→cognitive`;
- an old verification argv or target adapter tuple is absent from the candidate;
- include coverage is narrowed, exclude coverage is expanded, or a boundary is removed;
- `approvalRequired` changes true→false;
- TypeScript naming baseline adds fingerprints (also governed by its stricter adoption contract).
- an EDD suite is removed, its target threshold/trials decrease, its target metric changes, or a task, gate grader, traceability rule ID, or known-bad control is removed/changed.

Unclear scope transformations are reported as weakening rather than guessed safe. Added rules, higher severity, stronger formalization, more verifiers, wider includes, smaller excludes and baseline shrink are not weakening.

Weakening approval is stored in the existing intake as `{digest, ruleIds}` after the owner explicitly approves both. The intake CLI requires the digest plus repeated rule IDs; the next discovery and update plan must reproduce exactly the same sorted IDs and digest. The approval intake must also be newer than the currently applied manifest intake. A mismatch leaves `weakening.approved=false`. `applyFilePlan` rejects an unapproved weakening update before any target write. Exact plan-hash approval remains separately required.

## Adoption baseline

The update path calls the same fingerprint parser, multiset intersection and transition validator as ordinary planning/apply:

- exact old fingerprints still observed are preserved;
- fixed fingerprints disappear from the candidate baseline;
- no ordinary update path can add a fingerprint;
- expansion or replacement requires a fresh `--approve-typescript-naming-adoption` intake and the existing explicit adoption selection on update planning;
- parse errors have null fingerprints and always block adoption.

There is no update waiver, ignore list or baseline reset.

## Worktree compatibility

The policy plan contains observation only:

- `not-configured`: no worktree config; no workspace plan.
- `compatible`: config and host binding parse under the current schemas; explicit values are unchanged.
- `configuration-plan-required`: legacy config can be rewritten losslessly by calling existing `planWorkspaceConfiguration` with every observed config and host-binding value explicitly supplied. The returned workspace plan path/hash is separate and is not applied by policy `apply`.
- `migration-required`: compatibility requires a directory/topology move. Report the exact existing `harness-automation worktree migrate --workspace-container <absolute-path> --project <absolute-path>` planning action, but do not select a container or execute it.

Invalid/unknown schema fails closed with `WORKTREE_UPDATE_BLOCKED` and writes neither plan; it is not a fifth stable status.

Before emitting a lossless configuration plan, compare every explicit config, provider, path and approval value in the planned JSON against the observed values. Any dropped or default-substituted value is `blocked`. The policy plan never contains a workspace operation and cannot change Git topology.

## Minimum implementation file set

| File | Required change |
|---|---|
| `mcp-server/src/v2/types.ts` | compiler identity, persisted profile, upgrade diff/weakening metadata and doctor status types |
| `mcp-server/src/v2/policy.ts` | emit current compiler identity and persisted profile from existing compiler path |
| `mcp-server/src/v2/service.ts` | current identity reader, inheritance, drift guard, semantic diff, `planProjectUpdate`, no-op, apply weakening validation, doctor version status; reuse existing apply/rollback |
| `mcp-server/src/cli.ts` | route and document only `update plan`; parse no replacement profile flags |
| `docs/api/harness-policy-v2.schema.json` | document exact compiler identity, persisted profile and EDD semantic snapshot while retaining legacy-read compatibility in code |
| `mcp-server/src/v2/service.test.ts` | service acceptance matrix, including exact apply/rollback and zero-worktree assertions |
| `mcp-server/src/v2/cli.test.ts` | one public command and stable JSON/no-op behavior |
| `mcp-server/src/worktree/service.test.ts` | only the lossless legacy-config workspace-plan and topology-migration boundary cases; production worktree service should remain unchanged if existing APIs suffice |
| `skill/SKILL.md` and `docs/reference/reference.md` | operator workflow, owner gates and doctor statuses |
| `CHANGELOG.jsonl` | issue-linked repository-significant feature entry |

Do not add an `update/` directory, new storage root, second plan schema, second receipt type, new rollback code, MCP tool, dependency, migration framework or npm release worktree.

## Requirement-to-evidence matrix

| Acceptance | Authoritative evidence |
|---|---|
| 1. current/no-op | recursive inventory + no plan + worktree list unchanged |
| 2. legacy major | fixed-time deterministic plan; old version remains unknown |
| 3. inheritance | fixture fills owner/profile/stacks/all profiles/phase; candidate deep-equals |
| 4. added rule | semantic diff identifies it; apply makes the rule effective |
| 5. weakening | table tests cover every transition; apply rejects absent/mismatched intake digest and IDs |
| 6. source/discovery drift | mutate each source class and discovered manifest/command; fail with plan inventory unchanged |
| 7. baseline ratchet | preserve, shrink, expansion rejection, fresh adoption and parse-error fixtures |
| 8. hash/tamper/atomicity | wrong hash and all precondition drift fail before writes; injected write failure restores prior bytes |
| 9. rollback | byte-for-byte policy, manifest, generated files and managed blocks |
| 10. worktree preservation | explicit-value deep equality and exact porcelain path set before/after |
| 11. topology boundary | migrationRequired + existing command only; no directory rename |
| 12. doctor | four isolated fixtures prove statuses and no network/writes |
| 13. self-bootstrap | fresh owner intake/discover, real full-hash gate, existing apply, session/CI check and clean drift |

## Self-bootstrap gate

After implementation tests pass, update this PRD/design/research source set through a fresh owner-approved intake and discovery. Run the new update command in the existing primary/management checkout, present its complete hash, and stop. Only zhichao's exact approval of that hash permits existing `apply`; then run `check --mode session`, the required commit/CI checks, and `drift`. Any weakening requires its separate typed intake approval before the plan-hash gate.
