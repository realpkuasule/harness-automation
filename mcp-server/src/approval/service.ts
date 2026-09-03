import { existsSync, readdirSync } from "node:fs";
import { durableWriteOnce, hashObject, prettyJson, readJson, safePath } from "../v2/fs.js";

export type RiskClass = "read-only" | "ordinary-reversible" | "human-required" | "protected";
export type ApprovalState = "Approved" | "ReviewPending" | "NeedsHuman";
export const APPROVAL_ACTION_KINDS = ["read", "write", "adopt", "rebind", "recover", "rollback", "migration", "weakening", "permission-change", "protected"] as const;
export type ApprovalActionKind = typeof APPROVAL_ACTION_KINDS[number];

export interface SemanticApprovalPacket {
  schemaVersion: "semantic-approval/1.0";
  kind: "semantic-approval";
  planHash: string;
  inputHash: string;
  producerIdentity: string;
  actions: Array<{
    id: string;
    kind: ApprovalActionKind;
    summary: string;
    before: string;
    after: string;
    reversible: boolean;
    protected?: boolean;
    recovery: string;
  }>;
  risk: RiskClass;
  packetHash: string;
}

export interface ReviewerVerdict {
  schemaVersion: "reviewer-verdict/1.0";
  planHash: string;
  inputHash: string;
  reviewerIdentity: string;
  verdict: "approve" | "reject" | "needs-human";
  reasonCodes: string[];
}

export interface ReviewerAdapter {
  identity: string;
  review(packet: SemanticApprovalPacket, attempt: 1 | 2): ReviewerVerdict;
}

export interface ApprovalResult {
  state: ApprovalState;
  code?: "DG02_REVIEWER_CONFIGURATION_REQUIRED" | "REVIEWER_SELF_REVIEW" | "REVIEWER_INVALID" | "REVIEWER_REJECTED" | "REVIEWER_ATTEMPT_LIMIT" | "HUMAN_APPROVAL_REQUIRED";
  packet: SemanticApprovalPacket;
  verdict?: ReviewerVerdict;
}

interface ApprovalAttemptReceipt {
  schemaVersion: "approval-attempt/3.0";
  kind: "approval-attempt";
  id: string;
  packetHash: string;
  attempt: 1 | 2;
  state: ApprovalState;
  code?: ApprovalResult["code"];
  verdict?: ReviewerVerdict;
  receiptHash: string;
}

function packetWithoutHash(packet: SemanticApprovalPacket): Omit<SemanticApprovalPacket, "packetHash"> {
  const copy: Partial<SemanticApprovalPacket> = { ...packet };
  delete copy.packetHash;
  return copy as Omit<SemanticApprovalPacket, "packetHash">;
}

export function validSemanticApprovalPacket(packet: SemanticApprovalPacket): boolean {
  return packet.schemaVersion === "semantic-approval/1.0" && packet.kind === "semantic-approval" &&
    packet.packetHash === hashObject(packetWithoutHash(packet)) &&
    packet.actions.every((action) => (APPROVAL_ACTION_KINDS as readonly string[]).includes(action.kind)) &&
    packet.risk === classifyRisk(packet.actions);
}

export function classifyRisk(actions: SemanticApprovalPacket["actions"]): RiskClass {
  if (actions.some((action) => action.protected || ["protected", "permission-change"].includes(action.kind))) return "protected";
  if (actions.some((action) => !action.reversible || ["adopt", "rebind", "recover", "rollback", "migration", "weakening"].includes(action.kind))) return "human-required";
  return actions.length === 0 ? "read-only" : "ordinary-reversible";
}

export function createSemanticApprovalPacket(input: Omit<SemanticApprovalPacket, "schemaVersion" | "kind" | "risk" | "packetHash">): SemanticApprovalPacket {
  const packet: SemanticApprovalPacket = {
    schemaVersion: "semantic-approval/1.0", kind: "semantic-approval", ...input,
    risk: classifyRisk(input.actions), packetHash: "",
  };
  packet.packetHash = hashObject(packetWithoutHash(packet));
  return packet;
}

function validVerdict(packet: SemanticApprovalPacket, adapter: ReviewerAdapter, verdict: ReviewerVerdict): boolean {
  return verdict.schemaVersion === "reviewer-verdict/1.0" && verdict.planHash === packet.planHash &&
    verdict.inputHash === packet.inputHash && verdict.reviewerIdentity === adapter.identity &&
    verdict.reviewerIdentity !== packet.producerIdentity && verdict.reasonCodes.length > 0;
}

export function reviewSemanticApproval(args: {
  packet: SemanticApprovalPacket;
  adapter?: ReviewerAdapter;
  attempt?: 1 | 2 | 3;
}): ApprovalResult {
  const { packet } = args;
  if (!validSemanticApprovalPacket(packet)) {
    return { state: "NeedsHuman", code: "HUMAN_APPROVAL_REQUIRED", packet };
  }
  if (packet.risk === "read-only") return { state: "Approved", packet };
  if (packet.risk === "human-required" || packet.risk === "protected") {
    return { state: "NeedsHuman", code: "HUMAN_APPROVAL_REQUIRED", packet };
  }
  if ((args.attempt ?? 1) > 2) return { state: "NeedsHuman", code: "REVIEWER_ATTEMPT_LIMIT", packet };
  const attempt: 1 | 2 = args.attempt === 2 ? 2 : 1;
  if (!args.adapter) return { state: "ReviewPending", code: "DG02_REVIEWER_CONFIGURATION_REQUIRED", packet };
  if (args.adapter.identity === packet.producerIdentity) {
    return { state: "NeedsHuman", code: "REVIEWER_SELF_REVIEW", packet };
  }
  let verdict: ReviewerVerdict;
  try {
    verdict = args.adapter.review(packet, attempt);
  } catch {
    return { state: "ReviewPending", code: "DG02_REVIEWER_CONFIGURATION_REQUIRED", packet };
  }
  if (!validVerdict(packet, args.adapter, verdict)) {
    return { state: "NeedsHuman", code: "REVIEWER_INVALID", packet };
  }
  if (verdict.verdict === "approve") return { state: "Approved", packet, verdict };
  return verdict.verdict === "needs-human"
    ? { state: "NeedsHuman", code: "HUMAN_APPROVAL_REQUIRED", packet, verdict }
    : { state: "ReviewPending", code: "REVIEWER_REJECTED", packet, verdict };
}

function approvalReceiptWithoutHash(receipt: ApprovalAttemptReceipt): Omit<ApprovalAttemptReceipt, "receiptHash"> {
  const copy: Partial<ApprovalAttemptReceipt> = { ...receipt };
  delete copy.receiptHash;
  return copy as Omit<ApprovalAttemptReceipt, "receiptHash">;
}

function approvalReceipts(commonDir: string): ApprovalAttemptReceipt[] {
  const directory = safePath(commonDir, "harness/approvals");
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((name) => name.endsWith(".json")).map((name) => {
    const receipt = readJson<ApprovalAttemptReceipt>(safePath(directory, name));
    if (receipt.schemaVersion !== "approval-attempt/3.0" || receipt.kind !== "approval-attempt" ||
        receipt.receiptHash !== hashObject(approvalReceiptWithoutHash(receipt))) throw new Error("APPROVAL_HISTORY_TAMPERED");
    return receipt;
  });
}

/** The mutation caller derives attempts from append-only history; callers cannot reset it. */
export function reviewSemanticApprovalWithHistory(args: {
  commonDir: string;
  packet: SemanticApprovalPacket;
  adapter?: ReviewerAdapter;
}): ApprovalResult {
  const prior = approvalReceipts(args.commonDir).filter((receipt) => receipt.packetHash === args.packet.packetHash);
  if (prior.length >= 2) return { state: "NeedsHuman", code: "REVIEWER_ATTEMPT_LIMIT", packet: args.packet };
  const attempt = (prior.length + 1) as 1 | 2;
  const result = reviewSemanticApproval({ packet: args.packet, adapter: args.adapter, attempt });
  const receipt: ApprovalAttemptReceipt = {
    schemaVersion: "approval-attempt/3.0", kind: "approval-attempt", id: `approval-${args.packet.packetHash.slice(0, 16)}-${attempt}`,
    packetHash: args.packet.packetHash, attempt, state: result.state, ...(result.code ? { code: result.code } : {}),
    ...(result.verdict ? { verdict: result.verdict } : {}), receiptHash: "",
  };
  receipt.receiptHash = hashObject(approvalReceiptWithoutHash(receipt));
  try {
    durableWriteOnce(safePath(args.commonDir, `harness/approvals/${receipt.id}.json`), prettyJson(receipt));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("APPROVAL_HISTORY_CONFLICT");
    throw error;
  }
  return result;
}
