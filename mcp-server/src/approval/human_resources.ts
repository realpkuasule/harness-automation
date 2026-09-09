import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { hashObject } from "../v2/fs.js";
import type { SyntheticObjectPlan } from "../coordination/synthetic.js";
import { qualificationResourceSchema, type HumanScope } from "./human_scope.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const sha = qualificationResourceSchema.shape.sourceSha;
const identitySchema = z.object({ device: z.number().int().nonnegative(), inode: z.number().int().positive(), birthtimeMs: z.number().nonnegative(),
  parentDevice: z.number().int().nonnegative(), parentInode: z.number().int().positive(), parentBirthtimeMs: z.number().nonnegative() }).strict();
export const resourceFactSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("import-started"), graphHash: digest, commits: z.array(sha).min(1).max(4096) }).strict(),
  z.object({ type: z.literal("import-result"), status: z.enum(["imported", "failed", "unknown"]), evidenceHash: digest }).strict(),
  z.object({ type: z.literal("create-started") }).strict(),
  z.object({ type: z.literal("mkdir-owned"), identity: identitySchema }).strict(),
  z.object({ type: z.literal("branch-created"), head: sha }).strict(),
  z.object({ type: z.literal("add-started") }).strict(),
  z.object({ type: z.literal("ready"), gitDir: z.string().refine(isAbsolute), evidenceHash: digest }).strict(),
  z.object({ type: z.literal("released"), evidenceHash: digest }).strict(),
  z.object({ type: z.literal("retained"), reason: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u), evidenceHash: digest }).strict(),
]);
export const resourceEventSchema = z.object({ kind: z.literal("qualification-resource"), resourceId: qualificationResourceSchema.shape.resourceId,
  observedAt: z.string().datetime(), fact: resourceFactSchema }).strict();
export type ResourceFact = z.infer<typeof resourceFactSchema>;
export type ResourceState = { phase: "reserved" | "mkdir-owned" | "add-started" | "ready" | "released";
  importStarted?: true; importResult?: "imported" | "failed" | "unknown"; createStarted?: true;
  identity?: z.infer<typeof identitySchema>; branchCreated?: string; gitDir?: string; evidenceHash?: string;
  retained?: { reason: string; evidenceHash: string } };

/** Approved parent-first bytes only. No filesystem, Git, ledger, clock or credential access. */
export function qualificationSourceGraph(scope: HumanScope, resourceId: string): SyntheticObjectPlan[] {
  if (scope.kind !== "qualification-run") throw new Error("HUMAN_LOCAL_RESOURCE_SCOPE_REQUIRED");
  const resource = scope.localResources?.items.find((item) => item.resourceId === resourceId);
  if (!resource || !scope.synthetic) throw new Error("HUMAN_LOCAL_RESOURCE_SCOPE_REQUIRED");
  const bySha = new Map(scope.synthetic.objects.map((plan) => [plan.commitSha, plan])); const graph: SyntheticObjectPlan[] = [];
  let current: string | undefined = resource.sourceSha; const visited = new Set<string>();
  while (current) {
    const plan = bySha.get(current);
    if (!plan || plan.kind !== "source-fixture" || visited.has(current)) throw new Error("SYNTHETIC_SOURCE_GRAPH_INVALID");
    visited.add(current); graph.push(plan); current = plan.parents[0];
  }
  return graph.reverse();
}

export function startsResourceOperation(fact: ResourceFact): boolean {
  return fact.type === "import-started" || fact.type === "create-started" || fact.type === "add-started";
}

/** Validates history, never supplies native ownership/deletion authority from recorded JSON. */
export function reduceResourceFact(scope: HumanScope, resourceId: string, previous: ResourceState, fact: ResourceFact,
  writesClosed: boolean, revoked: boolean): ResourceState {
  const invalid = (): never => { throw new Error("HUMAN_LOCAL_RESOURCE_HISTORY_INVALID"); };
  if (scope.kind !== "qualification-run" || !scope.localResources) return invalid();
  const resource = scope.localResources.items.find((item) => item.resourceId === resourceId);
  if (!resource || previous.phase === "released" || startsResourceOperation(fact) && (writesClosed || revoked)) return invalid();
  const next = structuredClone(previous);
  switch (fact.type) {
    case "import-started": {
      if (next.importStarted || next.phase !== "reserved" && next.phase !== "mkdir-owned" || next.branchCreated) return invalid();
      const graph = qualificationSourceGraph(scope, resourceId);
      if (fact.graphHash !== hashObject(graph.map((plan) => plan.objectPlanHash)) || hashObject(fact.commits) !== hashObject(graph.map((plan) => plan.commitSha))) return invalid();
      next.importStarted = true; break;
    }
    case "import-result":
      if (!next.importStarted || next.importResult) return invalid();
      next.importResult = fact.status; next.evidenceHash = fact.evidenceHash; break;
    case "create-started":
      if (next.createStarted || next.phase !== "reserved" || next.importResult !== "imported") return invalid();
      next.createStarted = true; break;
    case "mkdir-owned":
      if (!next.createStarted || next.phase !== "reserved") return invalid();
      next.identity = fact.identity; next.phase = "mkdir-owned"; break;
    case "branch-created":
      if (next.phase !== "mkdir-owned" || next.branchCreated || next.importResult !== "imported" || fact.head !== resource.sourceSha) return invalid();
      next.branchCreated = fact.head; break;
    case "add-started":
      if (next.phase !== "mkdir-owned" || !next.branchCreated) return invalid();
      next.phase = "add-started"; break;
    case "ready":
      if (next.phase !== "add-started" || dirname(fact.gitDir) !== join(scope.binding.commonDir, "worktrees")) return invalid();
      next.phase = "ready"; next.gitDir = fact.gitDir; next.evidenceHash = fact.evidenceHash; break;
    case "retained": next.retained = { reason: fact.reason, evidenceHash: fact.evidenceHash }; break;
    case "released":
      if (!writesClosed) throw new Error("HUMAN_QUALIFICATION_WRITES_OPEN");
      next.phase = "released"; next.evidenceHash = fact.evidenceHash; delete next.retained; break;
  }
  return next;
}
