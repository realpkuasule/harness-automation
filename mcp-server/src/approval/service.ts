import { existsSync, readdirSync } from "node:fs";
import { hashObject, safePath } from "../v2/fs.js";
import { appendLkgRecord, appendReceiptEvent, readLkgChain, readReceiptChain } from "../receipt/service.js";

export type RiskClass = "read-only" | "ordinary-reversible" | "human-required" | "protected";
export type ApprovalState = "Approved" | "ReviewPending" | "NeedsHuman";
export const APPROVAL_ACTION_KINDS = ["read", "write", "adopt", "rebind", "recover", "rollback", "migration", "weakening", "permission-change", "protected"] as const;
export type ApprovalActionKind = typeof APPROVAL_ACTION_KINDS[number];

export interface SemanticApprovalBinding {
  planHash: string;
  contextDigest: string;
  inputDigest: string;
  policyDigest: string;
  observedHash: string;
  actionDigest: string;
}

export interface SemanticApprovalPacket {
  schemaVersion: "semantic-approval/1.0";
  kind: "semantic-approval";
  planHash: string;
  inputHash: string;
  binding: SemanticApprovalBinding;
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
  packetHash: string;
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
  packet: SemanticApprovalPacket;
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
  return Boolean(packet && typeof packet === "object" && packet.binding &&
    typeof packet.binding === "object" && Array.isArray(packet.actions)) &&
    packet.schemaVersion === "semantic-approval/1.0" && packet.kind === "semantic-approval" &&
    packet.packetHash === hashObject(packetWithoutHash(packet)) &&
    packet.planHash === packet.binding.planHash && packet.inputHash === packet.binding.inputDigest &&
    packet.binding.actionDigest === hashObject(packet.actions) &&
    [packet.binding.planHash, packet.binding.contextDigest, packet.binding.inputDigest,
      packet.binding.policyDigest, packet.binding.observedHash, packet.binding.actionDigest]
      .every((digest) => /^[a-f0-9]{64}$/u.test(digest)) &&
    new Set(packet.actions.map((action) => action.id)).size === packet.actions.length &&
    packet.actions.every((action) => Boolean(action.id && action.summary && action.recovery) &&
      (APPROVAL_ACTION_KINDS as readonly string[]).includes(action.kind)) &&
    packet.risk === classifyRisk(packet.actions);
}

export function classifyRisk(actions: SemanticApprovalPacket["actions"]): RiskClass {
  if (actions.some((action) => action.protected || ["protected", "permission-change"].includes(action.kind))) return "protected";
  if (actions.some((action) => !action.reversible || ["adopt", "rebind", "recover", "rollback", "migration", "weakening"].includes(action.kind))) return "human-required";
  return actions.length === 0 ? "read-only" : "ordinary-reversible";
}

export function createSemanticApprovalPacket(input: Omit<SemanticApprovalPacket, "schemaVersion" | "kind" | "risk" | "packetHash" | "binding"> & {
  binding: Omit<SemanticApprovalBinding, "actionDigest">;
}): SemanticApprovalPacket {
  const packet: SemanticApprovalPacket = {
    schemaVersion: "semantic-approval/1.0", kind: "semantic-approval", ...input,
    binding: { ...input.binding, actionDigest: hashObject(input.actions) },
    risk: classifyRisk(input.actions), packetHash: "",
  };
  packet.packetHash = hashObject(packetWithoutHash(packet));
  return packet;
}

function validVerdict(packet: SemanticApprovalPacket, adapter: ReviewerAdapter, verdict: ReviewerVerdict): boolean {
  return Boolean(verdict && typeof verdict === "object" && Array.isArray(verdict.reasonCodes)) &&
    verdict.schemaVersion === "reviewer-verdict/1.0" && verdict.packetHash === packet.packetHash &&
    verdict.planHash === packet.planHash &&
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

function validApprovalReceipt(receipt: ApprovalAttemptReceipt, packetHash: string, sequence: number): boolean {
  return receipt.schemaVersion === "approval-attempt/3.0" && receipt.kind === "approval-attempt" &&
    receipt.id === `approval-${packetHash.slice(0, 16)}-${sequence}` && receipt.packetHash === packetHash &&
    receipt.packetHash === receipt.packet.packetHash && validSemanticApprovalPacket(receipt.packet) &&
    receipt.attempt === sequence && [1, 2].includes(receipt.attempt) &&
    ["Approved", "ReviewPending", "NeedsHuman"].includes(receipt.state) &&
    (receipt.verdict ? validVerdict(receipt.packet, { identity: receipt.verdict.reviewerIdentity, review: () => receipt.verdict! }, receipt.verdict) : receipt.state !== "Approved") &&
    receipt.receiptHash === hashObject(approvalReceiptWithoutHash(receipt));
}

function approvalReceipts(commonDir: string): ApprovalAttemptReceipt[] {
  const legacyDirectory = safePath(commonDir, "harness/approvals");
  if (existsSync(legacyDirectory) && readdirSync(legacyDirectory).length > 0) throw new Error("APPROVAL_HISTORY_MIGRATION_REQUIRED");
  const directory = safePath(commonDir, "harness/receipts/approval");
  if (!existsSync(directory)) return [];
  try {
    const lkg = readLkgChain({ root: commonDir, domain: "approval" });
    const receipts: ApprovalAttemptReceipt[] = [];
    for (const packetHash of readdirSync(directory)) {
      if (!/^[a-f0-9]{64}$/u.test(packetHash)) throw new Error("APPROVAL_HISTORY_TAMPERED");
      const events = readReceiptChain<ApprovalAttemptReceipt>({ root: commonDir, domain: "approval", transactionId: packetHash });
      const records = lkg.filter((record) => record.transactionId === packetHash);
      if (events.length !== records.length || events.length > 2) throw new Error("APPROVAL_HISTORY_TAMPERED");
      for (const event of events) {
        if (!validApprovalReceipt(event.snapshot, packetHash, event.sequence) ||
            !records.some((record) => record.sequence === event.sequence && record.receiptEventHash === event.eventHash &&
              record.planHash === event.snapshot.packet.planHash && record.observedHash === packetHash)) {
          throw new Error("APPROVAL_HISTORY_TAMPERED");
        }
        receipts.push(event.snapshot);
      }
    }
    return receipts;
  } catch {
    throw new Error("APPROVAL_HISTORY_TAMPERED");
  }
}

/** The mutation caller derives attempts from append-only history; callers cannot reset it. */
export function reviewSemanticApprovalWithHistory(args: {
  commonDir: string;
  packet: SemanticApprovalPacket;
  adapter?: ReviewerAdapter;
}): ApprovalResult {
  const prior = approvalReceipts(args.commonDir).filter((receipt) =>
    receipt.packetHash === args.packet.packetHash && receipt.verdict !== undefined);
  if (prior.length >= 2) return { state: "NeedsHuman", code: "REVIEWER_ATTEMPT_LIMIT", packet: args.packet };
  const attempt = (prior.length + 1) as 1 | 2;
  const result = reviewSemanticApproval({ packet: args.packet, adapter: args.adapter, attempt });
  // Only a verifier response consumes one of the two bounded re-review attempts.
  // Missing configuration, self-review, and malformed packets must remain repairable.
  if (!result.verdict) return result;
  const receipt: ApprovalAttemptReceipt = {
    schemaVersion: "approval-attempt/3.0", kind: "approval-attempt", id: `approval-${args.packet.packetHash.slice(0, 16)}-${attempt}`,
    packetHash: args.packet.packetHash, packet: args.packet, attempt, state: result.state, ...(result.code ? { code: result.code } : {}),
    ...(result.verdict ? { verdict: result.verdict } : {}), receiptHash: "",
  };
  receipt.receiptHash = hashObject(approvalReceiptWithoutHash(receipt));
  const event = appendReceiptEvent({ root: args.commonDir, domain: "approval", transactionId: args.packet.packetHash, snapshot: receipt });
  appendLkgRecord({
    root: args.commonDir,
    domain: "approval",
    transactionId: args.packet.packetHash,
    appliedReceiptEventHash: event.eventHash,
    planHash: args.packet.planHash,
    observedHash: args.packet.packetHash,
  });
  return result;
}
