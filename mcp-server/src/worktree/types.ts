export const WORKTREE_SCHEMA_VERSION = "1.0" as const;

export const WORKTREE_POLICY_IDS = [
  "workspace.issue-single-persistent-lease",
  "workspace.mapping-consistency",
  "workspace.root-denylist",
  "workspace.capacity-budget",
  "workspace.lease-ttl",
  "workspace.clean-before-close",
  "workspace.unique-commits-protected",
  "workspace.done-no-persistent-worktree",
  "workspace.review-temporary-detached",
  "workspace.review-ttl",
  "workspace.zero-new-worktree-management",
  "workspace.cleanup-exact-hash",
  "workspace.cleanup-receipt",
  "workspace.remote-delete-disabled",
] as const;

export type WorktreePolicyId = typeof WORKTREE_POLICY_IDS[number];

export const WORKTREE_DELEGATABLE_OPERATIONS = [
  "allocate",
  "adopt",
  "close",
  "rebind",
  "renew",
  "recover",
] as const;

export type WorktreeDelegatableOperation = typeof WORKTREE_DELEGATABLE_OPERATIONS[number];

export type WorktreeApprovalPolicy =
  | { mode: "manual" }
  | {
      mode: "delegated-ai";
      reviewer: { kind: "claude"; model: string };
      allowedOperations: WorktreeDelegatableOperation[];
      planTtlSeconds: number;
      reviewerTimeoutSeconds: number;
    };

export interface WorktreeContainerTopology {
  kind: "container-v1";
  workspaceContainer: string;
  managementCheckout: string;
  persistentWorktreeRoot: string;
}

export interface WorkspaceTopology {
  kind: "container-v1" | "legacy-flat";
  workspaceContainer?: string;
  managementCheckout: string;
  persistentWorktreeRoot?: string;
  allowedRoots: string[];
  protectedRoots: string[];
  commonDir: string;
  worktreeTopLevels: string[];
}

export interface WorktreeDeliveryConfig {
  schemaVersion: "1.0";
  mode: "audit-only" | "enforced";
  managementBranch?: string;
  maxPersistentWorktrees: number;
  leaseTtlHours: number;
  reviewTtlMinutes: number;
  remoteBranchRetentionDays: number;
  remoteBranchDeletion: boolean;
  provider: {
    kind: "none" | "github" | "gitlab" | "jira";
    repository?: string;
    project?: {
      owner: string;
      number: number;
      statusField: string;
      doneValues: string[];
    };
  };
}

export interface WorktreeHostBinding {
  schemaVersion: "1.0";
  allowedRoots: string[];
  protectedRoots: string[];
  topology?: WorktreeContainerTopology;
  approval: WorktreeApprovalPolicy;
}

export interface WorktreeHostBindingObservation extends WorktreeHostBinding {
  configured: boolean;
  loaded: boolean;
  source: "host-local" | "legacy-config" | "default";
  path: string;
  hash: string | null;
}

export interface WorkspaceLease {
  schemaVersion: "1.0";
  workItem: string;
  branch: string;
  path: string;
  owner: string;
  thread?: string;
  workItemState?: string;
  acceptedCommit: string;
  createdAt: string;
  heartbeatAt: string;
  status: "active" | "review" | "done";
}

export interface WorkspaceBranchCleanup {
  branch: string;
  localRef: string;
  expectedHead: string;
  branchConfig: Array<{ key: string; value: string }>;
  managementBranch: string;
  managementHead: string;
  proof:
    | { kind: "ancestry" }
    | { kind: "github-pr"; number: number; mergedAt: string };
  remote: {
    name: string;
    ref: string;
    expectedHead: string | null;
    endpointHash: string;
  };
}

export interface WorkspaceAdoptionInput {
  workItem: string;
  owner: string;
  thread?: string;
  path: string;
  branch: string;
}

export interface WorkspaceAdoptionManifest {
  schemaVersion: "worktree-adopt/1.0";
  items: WorkspaceAdoptionInput[];
}

export interface WorktreeRecord {
  path: string;
  gitTopLevel?: string;
  head: string;
  branch: string | null;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
  dirty?: boolean;
  dirtyEvidence?: Array<{
    path: string;
    status: string;
    size: number;
    sha256: string;
  }>;
  dirtyPatch?: {
    size: number;
    sha256: string;
  };
  uniqueCommits?: number;
  unpushedCommits?: number;
}

export interface WorkspaceAdoptionSnapshot {
  path: string;
  branch: string;
  head: string;
  branchHead: string;
  indexHash: string;
  bare: false;
  detached: false;
  locked: false;
  prunable: false;
  dirty: boolean;
  dirtyEvidence: NonNullable<WorktreeRecord["dirtyEvidence"]>;
  dirtyPatch: NonNullable<WorktreeRecord["dirtyPatch"]>;
  snapshotHash: string;
}

export interface WorkspaceAdoptionPlanItem {
  lease: WorkspaceLease;
  snapshot: WorkspaceAdoptionSnapshot;
  providerItem?: ProviderItemObservation;
  leasePath: string;
  beforeLeaseHash: null;
  afterLeaseHash: string;
}

export interface WorkspaceLeaseChange {
  action: "create" | "remove" | "restore" | "update";
  workItem: string;
  path: string;
  branch: string;
  leasePath: string;
  beforeHash: string | null;
  afterHash: string | null;
}

export interface WorkspaceStatus {
  schemaVersion: "1.0";
  projectDir: string;
  commonDir: string;
  configured: boolean;
  loaded: boolean;
  enforced: boolean;
  passing: boolean;
  mode: "audit-only" | "enforced";
  config: WorktreeDeliveryConfig;
  hostBinding: WorktreeHostBindingObservation;
  topology: WorkspaceTopology;
  capacity: { limit: number; used: number; available: number };
  worktrees: WorktreeRecord[];
  leases: WorkspaceLease[];
  provider: ProviderObservation;
  errors: string[];
  observedHash: string;
}

export interface ProviderItemObservation {
  workItem: string;
  state: string;
  projectItemPresent?: boolean;
  projectStatus?: string;
  url?: string;
}

export interface ProviderObservation {
  kind: WorktreeDeliveryConfig["provider"]["kind"];
  configured: boolean;
  available: boolean;
  items: ProviderItemObservation[];
  error?: string;
}

export interface WorkspacePolicyResult {
  id: WorktreePolicyId;
  configured: boolean;
  loaded: boolean;
  enforced: boolean;
  passing: boolean;
  status: "verified" | "failing" | "blocked" | "guidance";
  detail: string;
  evidence: string[];
}

export interface WorkspaceAudit {
  schemaVersion: "1.0";
  configured: boolean;
  loaded: boolean;
  enforced: boolean;
  passing: boolean;
  observedHash: string;
  topology: WorkspaceTopology;
  capacity: { limit: number; used: number; available: number };
  policies: WorkspacePolicyResult[];
}

export interface WorkspaceIntegrationCheck {
  schemaVersion: "worktree-integration-check/1.0";
  projectDir: string;
  commonDir: string;
  workItem: string;
  workItemId: string;
  source: { path: string; branch: string; head: string; unpushedCommits: number };
  target: { ref: string; head: string; source: "explicit-local-ref" | "management-branch" };
  mergeBase: string;
  ahead: number;
  behind: number;
  clean: boolean;
  currentConflicts: Array<{ path: string; status: string }>;
  mergeable: boolean;
  conflictingPaths: string[];
  blockers: Array<{
    code: "WORKTREE_INTEGRATION_DIRTY" | "WORKTREE_INTEGRATION_CONFLICTED" |
      "WORKTREE_INTEGRATION_UNPUSHED" | "WORKTREE_INTEGRATION_MERGE_CONFLICT";
    detail: string;
  }>;
  warnings: Array<{ code: "WORKTREE_INTEGRATION_BEHIND"; detail: string }>;
  status: "ready" | "warning" | "blocked";
  passing: boolean;
  observedHash: string;
}

export type WorkspaceOperation =
  | {
      kind: "configure";
      configPath: ".harness/worktree-delivery.json";
      beforeHash: string | null;
      afterHash: string;
      content: string;
      hostBindingPath: "harness/worktree-delivery/host-binding.json";
      beforeHostBindingHash: string | null;
      afterHostBindingHash: string;
      hostBindingContent: string;
      topology: WorkspaceTopology;
      providerObservationBound?: true;
      providerObservation?: ProviderObservation;
      allowedRoot?: { path: string; before: "absent" | "empty" };
    }
  | {
      kind: "migrate";
      topology: WorkspaceTopology;
      preflight: {
        configHash: string;
        hostBindingHash: string | null;
        afterHostBindingHash: string;
        afterHostBindingContent: string;
        refsHash: string;
        worktreeRegistrationHash: string;
        leaseHashes: Array<{ path: string; sha256: string }>;
        referencePaths: string[];
        managementCheckout: string;
        commonDir: string;
        targetContainerState: "absent" | "empty";
        targetMainState: "absent";
        targetWorktreesState: "absent";
        leases: Array<{ workItem: string; path: string; branch: string }>;
        worktrees: Array<{
          path: string;
          branch: string | null;
          head: string;
          dirty: boolean;
          dirtyEvidence: Array<{ path: string; status: string; size: number; sha256: string }>;
          dirtyPatch: { size: number; sha256: string };
          uniqueCommits: number;
          unpushedCommits: number;
        }>;
      };
      manualSteps: string[];
    }
  | {
      kind: "allocate";
      lease: WorkspaceLease;
      startPoint: string;
      createBranch: boolean;
      providerObservationBound?: true;
    }
  | {
      kind: "adopt";
      configHash: string;
      hostBindingHash: string;
      refsHash: string;
      worktreeRegistrationHash: string;
      existingLeases: Array<{ leasePath: string; sha256: string }>;
      capacity: {
        limit: number;
        before: number;
        adopting: number;
        after: number;
      };
      providerHash: string;
      provider: ProviderObservation;
      providerObservationBound?: true;
      items: WorkspaceAdoptionPlanItem[];
    }
  | {
      kind: "close";
      lease: WorkspaceLease;
      expectedHead: string;
      expectedLeaseHash: string;
      ignoredPathCount?: number;
      ignoredPathsHash?: string;
      branchCleanup?: WorkspaceBranchCleanup;
    }
  | {
      kind: "rebind";
      lease: WorkspaceLease;
      replacementLease: WorkspaceLease;
      expectedHead: string;
      expectedLeaseHash: string;
      afterLeaseHash: string;
    }
  | {
      kind: "renew";
      lease: WorkspaceLease;
      replacementLease: WorkspaceLease;
      expectedHead: string;
      expectedLeaseHash: string;
      afterLeaseHash: string;
    }
  | {
      kind: "recover";
      path: string;
      removePath: string;
      expectedHead: string;
      dirtyEvidence: Array<{ path: string; status: string; size: number; sha256: string }>;
      dirtyPatch: { size: number; sha256: string };
    };

export interface WorkspacePlan {
  schemaVersion: "worktree-delivery/1.0";
  kind: "workspace-plan";
  id: string;
  createdAt: string;
  projectDir: string;
  commonDir: string;
  observedHash: string;
  operation: WorkspaceOperation;
  warnings: string[];
  planHash: string;
}

export interface WorkspaceAiDecision {
  schemaVersion: "worktree-ai-decision/1.0";
  kind: "workspace-ai-decision";
  id: string;
  planHash: string;
  intent: string;
  intentHash: string;
  policyHash: string;
  projectDir: string;
  commonDir: string;
  observedHash: string;
  operation: WorktreeDelegatableOperation;
  reviewer: { kind: "claude"; model: string };
  verdict: "approve" | "deny" | "abstain";
  reasonCodes: string[];
  summary: string;
  issuedAt: string;
  expiresAt: string;
  decisionHash: string;
}

export interface WorkspaceAiReviewResult {
  status?: "ReviewPending" | "NeedsHuman";
  code?: string;
  decisionPath?: string;
  decision?: WorkspaceAiDecision;
  receipt?: WorkspaceReceipt;
}

export interface WorkspaceReceipt {
  schemaVersion: "worktree-delivery/1.0";
  kind: "workspace-receipt";
  id: string;
  planHash: string;
  operation: WorkspaceOperation["kind"];
  status: "started" | "applied" | "failed" | "rolled-back";
  startedAt: string;
  completedAt?: string;
  steps: Array<{ id: string; status: "applied" | "failed" | "compensated"; detail: string }>;
  error?: string;
  backupContent?: string | null;
  backupHostBindingContent?: string | null;
  before: WorkspaceStatus;
  after?: WorkspaceStatus;
  beforeObservedHash?: string;
  afterObservedHash?: string;
  rollbackObservedHash?: string;
  rollbackAfter?: WorkspaceStatus;
  leaseChanges?: WorkspaceLeaseChange[];
  compensationStatus?: "not-required" | "completed" | "failed";
  createdDirectories?: string[];
  migration?: {
    sourceProjectDir: string;
    targetProjectDir: string;
    sourceCommonDir: string;
    targetCommonDir: string;
    recoveryState: "before-move" | "after-move" | "complete" | "failed";
  };
  authorizationMode?: "manual" | "delegated-ai";
  authorizationDecisionHash?: string;
  authorizationPolicyHash?: string;
  authorizationReviewer?: { kind: "claude"; model: string };
}

export interface ReviewReceipt {
  schemaVersion: "worktree-delivery/1.0";
  kind: "review-receipt";
  id: string;
  projectDir: string;
  commonDir: string;
  commit: string;
  path: string;
  receiptPath: string;
  command: string[];
  createdAt: string;
  completedAt?: string;
  status: "starting" | "active" | "cleaned" | "blocked" | "failed";
  detached: boolean;
  dirty: boolean;
  exitCode: number | null;
  output: string;
  dirtyEvidence?: WorktreeRecord["dirtyEvidence"];
  dirtyPatch?: WorktreeRecord["dirtyPatch"];
  error?: string;
}

export type ReviewReceiptScope = "host-global" | "project";

export interface RetentionAudit {
  schemaVersion: "1.0";
  projectDir: string;
  checkedAt: string;
  receiptScope: ReviewReceiptScope;
  excludedReviewReceiptCount: number;
  reviewTtlMinutes: number;
  remoteBranchRetentionDays: number;
  remoteDeletionEnabled: boolean;
  staleReviews: ReviewReceipt[];
  staleLeases: Array<WorkspaceLease & { ageHours: number }>;
  staleLocks: Array<{ path: string; ageMinutes: number }>;
  remoteBranches: Array<{ ref: string; committedAt: string; ageDays: number }>;
  errors: string[];
}
