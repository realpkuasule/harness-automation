export const COORDINATION_SCHEMA_VERSION = "github-coordination/1.0" as const;

export type CoordinationLifecycle = "Admitted" | "Prepared" | "Active" | "Draft" | "Ready" | "MergeArmed" | "Integrated" | "Closing" | "Closed" | "Abandoned";

export interface CoordinationRecord {
  schemaVersion: typeof COORDINATION_SCHEMA_VERSION;
  repository: string;
  repositoryId: string;
  workItem: string;
  branch: string;
  sourceRepositoryId: string;
  owner: string;
  machine: string;
  sessionRef?: string;
  generation: number;
  controlEpochDigest: string;
  createdAt: string;
  expiresAt: string | null;
  lastObservedHead: string;
  lifecycleState: CoordinationLifecycle;
  renewal?: { transactionId: string; proposedExpiresAt: string; reservedAt: string; observedBeforeExpiryAt?: string };
  closeOwnerGeneration?: number;
  transactionId: string;
  recordHash: string;
}

export interface CoordinationConfig {
  schemaVersion: "coordination-config/1.0";
  enabled: boolean;
  repository: string;
  repositoryId: string;
  remote: string;
  controlRef: string;
  qualificationEvidenceHash?: string;
}

export interface CoordinationExpected {
  recordHash?: string | null;
  generation?: number;
  owner?: string;
  machine?: string;
  controlEpochDigest?: string;
  lastObservedHead?: string;
}
