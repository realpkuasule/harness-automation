import { z } from "zod";
import { hashObject } from "../v2/fs.js";
import { appendLkgRecord, appendReceiptEvent, readLkgChain, readReceiptChain } from "../receipt/service.js";
import { syntheticObjectSchema } from "./synthetic.js";

const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const anchorSchema = z.object({
  validationVersion: z.literal("coordination-history/2"), genesis: syntheticObjectSchema.refine((plan) => plan.kind === "control-genesis"),
  endpointHash: z.string().regex(/^[a-f0-9]{64}$/u),
  repository: z.string().min(1), repositoryId: z.string().min(1), controlRef: z.string().startsWith("refs/heads/"),
}).strict();
export type CoordinationHistoryAnchor = z.infer<typeof anchorSchema>;
const stateSchema = z.object({
  anchor: anchorSchema, targetSha: sha, baseSha: sha, nextSha: sha.nullable(), verifiedTip: sha.nullable(),
}).strict();
type HistoryState = z.infer<typeof stateSchema>;
export interface ControlCommit { parents: string[]; treeSha: string; }
export type HistoryCheck = (head: string, readValidatedCommit: (sha: string) => ControlCommit, isAncestor: (ancestor: string, descendant: string) => boolean) => void;

export function coordinationHistoryCheck(commonDir: string, anchor: CoordinationHistoryAnchor): HistoryCheck {
  return (head, readValidatedCommit, isAncestor) => {
    const checked = validateCoordinationHistory({ commonDir, anchor, head, readValidatedCommit, isAncestor });
    if (checked.status !== "verified") throw new Error("COORDINATION_HISTORY_VALIDATION_PENDING");
  };
}

/** A validation checkpoint is a rebuildable receipt, never owner/generation/time authority. */
export function validateCoordinationHistory(args: {
  commonDir: string;
  anchor: CoordinationHistoryAnchor;
  head: string;
  readValidatedCommit: (sha: string) => ControlCommit;
  isAncestor: (ancestor: string, descendant: string) => boolean;
  batchSize?: number;
}): { status: "verified" | "pending"; verifiedTip: string | null; inspected: number } {
  const { anchor, head, readValidatedCommit, isAncestor } = args;
  if (!anchorSchema.safeParse(anchor).success || !sha.safeParse(head).success) throw new Error("COORDINATION_HISTORY_ANCHOR_INVALID");
  const budget = args.batchSize ?? 1_000;
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > 10_000) throw new Error("COORDINATION_HISTORY_BUDGET_INVALID");
  const contextHash = hashObject(anchor);
  const domain = `coordination-history-${contextHash.slice(0, 16)}`;
  const root = args.commonDir;
  const lkg = readLkgChain({ root, domain }).at(-1);
  let prior: HistoryState | undefined;
  if (lkg) {
    const event = readReceiptChain<HistoryState>({ root, domain, transactionId: lkg.transactionId }).find((item) => item.eventHash === lkg.receiptEventHash);
    const parsed = stateSchema.safeParse(event?.snapshot);
    if (!parsed.success || hashObject(parsed.data.anchor) !== contextHash || lkg.planHash !== contextHash || lkg.observedHash !== hashObject(parsed.data)) throw new Error("COORDINATION_HISTORY_CHECKPOINT_INVALID");
    prior = parsed.data;
  } else {
    const genesis = readValidatedCommit(anchor.genesis.commitSha);
    if (genesis.parents.length !== 0 || genesis.treeSha !== anchor.genesis.treeSha) throw new Error("COORDINATION_HISTORY_GENESIS_INVALID");
  }
  const trusted = prior?.verifiedTip ?? anchor.genesis.commitSha;
  if (!isAncestor(trusted, head) || (prior?.nextSha && !isAncestor(prior.targetSha, head))) throw new Error("COORDINATION_HISTORY_DISCONTINUITY");
  if (prior?.verifiedTip === head && prior.nextSha === null) return { status: "verified", verifiedTip: head, inspected: 0 };
  let state: HistoryState = prior?.nextSha ? { ...prior } : { anchor, targetSha: head, baseSha: trusted, nextSha: head, verifiedTip: prior?.verifiedTip ?? null };
  let inspected = 0;
  while (state.nextSha !== state.baseSha && inspected < budget) {
    if (!state.nextSha) throw new Error("COORDINATION_HISTORY_CHECKPOINT_INVALID");
    const commit = readValidatedCommit(state.nextSha);
    if (commit.parents.length !== 1 || !sha.safeParse(commit.parents[0]).success || !sha.safeParse(commit.treeSha).success) throw new Error("COORDINATION_HISTORY_DISCONTINUITY");
    state.nextSha = commit.parents[0]; inspected++;
  }
  if (state.nextSha === state.baseSha) {
    state.verifiedTip = state.targetSha;
    state.nextSha = null;
    if (state.targetSha !== head) state = { anchor, targetSha: head, baseSha: state.targetSha, nextSha: head, verifiedTip: state.targetSha };
  }
  const transactionId = `${contextHash.slice(0, 16)}-${state.targetSha}`;
  const event = appendReceiptEvent({ root, domain, transactionId, snapshot: state });
  appendLkgRecord({ root, domain, transactionId, appliedReceiptEventHash: event.eventHash, planHash: contextHash, observedHash: hashObject(state) });
  return { status: state.nextSha === null ? "verified" : "pending", verifiedTip: state.verifiedTip, inspected };
}
