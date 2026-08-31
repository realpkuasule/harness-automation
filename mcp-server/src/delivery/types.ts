export const DELIVERY_AUTHORIZATION_SCHEMA_VERSION = "delivery-authorization/1.0" as const;
export const DELIVERY_RECEIPT_SCHEMA_VERSION = "delivery-receipt/1.0" as const;

export type DeliveryMergeMode = "manual" | "checks-green";

export interface DeliveryCapabilities {
  pushOwnBranch: boolean;
  upsertPullRequest: boolean;
  retryInfrastructureCi: boolean;
  controlledRebase: boolean;
  mergeMode: DeliveryMergeMode;
  closeout: boolean;
}

export interface DeliveryApprovalSource {
  source: string;
  sourceHash: string;
}

export interface DeliveryAuthorization {
  schemaVersion: typeof DELIVERY_AUTHORIZATION_SCHEMA_VERSION;
  kind: "delivery-authorization";
  id: string;
  issuedAt: string;
  approval: DeliveryApprovalSource;
  supersedes?: string;
  intent: string;
  intentHash: string;
  workItem: string;
  repository: string;
  remote: { name: string; endpointHash: string };
  baseBranch: string;
  baseHead: string;
  featureBranch: string;
  initialHead: string;
  allowedPaths: string[];
  policyHash: string;
  capabilities: DeliveryCapabilities;
  retryLimit: number;
  authorizationHash: string;
}

export type DeliveryReceiptAction = "push" | "pull-request" | "rebase" | "ci-retry" | "merge" | "closeout";

export interface DeliveryReceipt {
  schemaVersion: typeof DELIVERY_RECEIPT_SCHEMA_VERSION;
  kind: "delivery-receipt";
  id: string;
  authorizationHash: string;
  action: DeliveryReceiptAction;
  status: "applied" | "blocked";
  sequence: number;
  previousReceiptHash: string | null;
  createdAt: string;
  beforeHead: string;
  afterHead: string;
  evidence: Record<string, unknown>;
  receiptHash: string;
}

export type CiFailureClass =
  | "infrastructure"
  | "deterministic"
  | "unknown";

export interface CiFailureClassification {
  kind: CiFailureClass;
  reason: string;
}

export type CiFailureStep = "checkout" | "cache" | "runner" | "unknown";

export interface DeliveryStatus {
  authorization: DeliveryAuthorization;
  currentHead: string;
  phase: "authorized" | "executing" | "awaiting-checks" | "awaiting-merge" | "auto-merge" | "merged" | "closing" | "done" | "suspended";
  receipts: DeliveryReceipt[];
  invalidation?: string;
}
