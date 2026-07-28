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

export interface WorktreeDeliveryConfig {
  schemaVersion: "1.0";
  mode: "audit-only" | "enforced";
  maxPersistentWorktrees: number;
  leaseTtlHours: number;
  reviewTtlMinutes: number;
  remoteBranchRetentionDays: number;
  allowedRoots: string[];
  protectedRoots: string[];
  remoteBranchDeletion: false;
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

export interface WorktreeRecord {
  path: string;
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
  policies: WorkspacePolicyResult[];
}

export type WorkspaceOperation =
  | {
      kind: "configure";
      configPath: ".harness/worktree-delivery.json";
      beforeHash: string | null;
      afterHash: string;
      content: string;
    }
  | {
      kind: "allocate";
      lease: WorkspaceLease;
      startPoint: string;
      createBranch: boolean;
    }
  | {
      kind: "close";
      lease: WorkspaceLease;
      expectedHead: string;
      expectedLeaseHash: string;
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
  before: WorkspaceStatus;
  after?: WorkspaceStatus;
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

export interface RetentionAudit {
  schemaVersion: "1.0";
  projectDir: string;
  checkedAt: string;
  reviewTtlMinutes: number;
  remoteBranchRetentionDays: number;
  remoteDeletionEnabled: false;
  staleReviews: ReviewReceipt[];
  staleLeases: Array<WorkspaceLease & { ageHours: number }>;
  staleLocks: Array<{ path: string; ageMinutes: number }>;
  remoteBranches: Array<{ ref: string; committedAt: string; ageDays: number }>;
  errors: string[];
}
