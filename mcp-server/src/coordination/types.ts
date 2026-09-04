import type { CoordinationHandoff } from "./handoff_record.js";

export const COORDINATION_SCHEMA_VERSION = "github-coordination/1.0" as const;

export type CoordinationLifecycle = "Admitted" | "Prepared" | "Active" | "Draft" | "Ready" | "MergeArmed" | "Integrated" | "Closing" | "Closed" | "Abandoned";

export interface RenewalProof {
  transactionId: string;
  reservationControlSha: string;
  reservationRecordHash: string;
  oldExpiresAt: string;
  proposedExpiresAt: string;
  serverDate: string;
  roundTripMs: number;
  elapsedMs: number;
  observedUpperBoundAt: string;
  proofHash: string;
}

export interface MergeEvidence {
  pullRequestNumber: number;
  pullRequestId: string;
  integratedSourceHead: string;
  integratedCommit: string;
  headRef: string;
  headRepositoryId: string;
  baseRef: string;
  baseRepositoryId: string;
  mergedAt: string;
  observedAt: string;
  observer: string;
  hostId: string;
  credentialBindingHash: string;
  evidenceHash: string;
}

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
  renewal?: { transactionId: string; proposedExpiresAt: string; reservedAt: string };
  renewalConfirmation?: RenewalProof;
  integration?: MergeEvidence;
  handoff?: CoordinationHandoff;
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
