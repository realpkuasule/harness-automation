import { createHash } from "node:crypto";
import { z } from "zod";
import { hashObject, sha256 } from "../v2/fs.js";
import { coordinationRecordSchema } from "./record.js";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const gitSha = z.string().regex(/^[a-f0-9]{40}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const coordinationCommitSubjectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("coordination-record"), workItem: coordinationRecordSchema.shape.workItem, recordHash: digest }).strict(),
  z.object({ kind: z.literal("control-genesis"), objectPlanHash: digest, fixtureId: id }).strict(),
  z.object({ kind: z.literal("source-fixture"), objectPlanHash: digest, fixtureId: id }).strict(),
]);
export type CoordinationCommitSubject = z.infer<typeof coordinationCommitSubjectSchema>;
const metadataSchema = z.object({ runId: id, objectId: id, seconds: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict();
const objectShape = z.object({
  schemaVersion: z.literal("synthetic-object/1"), objectFormat: z.literal("sha1"),
  kind: z.enum(["control-genesis", "source-fixture"]), metadata: metadataSchema, parents: z.array(gitSha).max(1),
  treeSha: gitSha, commitText: z.string().max(2048), commitSha: gitSha, commitBytesSha256: digest, objectPlanHash: digest,
}).strict();
export type SyntheticObjectPlan = z.infer<typeof objectShape>;

function objectHash(type: "tree" | "commit", bytes: string): string {
  return createHash("sha1").update(`${type} ${Buffer.byteLength(bytes)}\0`).update(bytes).digest("hex");
}
const emptyTree = objectHash("tree", "");
function commitText(kind: SyntheticObjectPlan["kind"], metadata: z.infer<typeof metadataSchema>, parents: string[]): string {
  const identity = `Harness Coordination <coordination@harness.invalid> ${metadata.seconds} +0000`;
  return `tree ${emptyTree}\n${parents.map((parent) => `parent ${parent}\n`).join("")}author ${identity}\ncommitter ${identity}\n\nharness ${kind} ${metadata.runId} ${metadata.objectId}\n`;
}

export const syntheticObjectSchema = objectShape.superRefine((plan, context) => {
  const text = commitText(plan.kind, plan.metadata, plan.parents);
  if (plan.kind === "control-genesis" && plan.parents.length || plan.treeSha !== emptyTree || plan.commitText !== text ||
      plan.commitSha !== objectHash("commit", text) || plan.commitBytesSha256 !== sha256(text) ||
      plan.objectPlanHash !== hashObject({ ...plan, objectPlanHash: undefined })) context.addIssue({ code: "custom", message: "SYNTHETIC_OBJECT_PLAN_INVALID" });
});

/** Pure computation: no Git object, temporary directory, wall-clock read or credential access. */
export function prepareSyntheticObject(kind: SyntheticObjectPlan["kind"], fixedMetadata: z.infer<typeof metadataSchema>, parents: string[] = []): SyntheticObjectPlan {
  const metadata = metadataSchema.parse(fixedMetadata); const text = commitText(kind, metadata, parents);
  const plan: SyntheticObjectPlan = { schemaVersion: "synthetic-object/1", objectFormat: "sha1", kind, metadata, parents: [...parents], treeSha: emptyTree,
    commitText: text, commitSha: objectHash("commit", text), commitBytesSha256: sha256(text), objectPlanHash: "" };
  plan.objectPlanHash = hashObject({ ...plan, objectPlanHash: undefined }); return syntheticObjectSchema.parse(plan);
}

/** A complete approved synthetic source graph cannot borrow project or control ancestry. */
export function validateSourceFixtureGraph(input: unknown): SyntheticObjectPlan[] {
  const plans = z.array(syntheticObjectSchema).min(1).max(4096).parse(input);
  const bySha = new Map(plans.map((plan) => [plan.commitSha, plan]));
  if (bySha.size !== plans.length || new Set(plans.map((plan) => plan.metadata.objectId)).size !== plans.length ||
      new Set(plans.map((plan) => plan.metadata.runId)).size !== 1) throw new Error("SYNTHETIC_SOURCE_GRAPH_INVALID");
  const verified = new Set<string>();
  for (const plan of plans) {
    const visited = new Set<string>(); let current: SyntheticObjectPlan | undefined = plan;
    while (current && !verified.has(current.commitSha)) {
      if (current.kind !== "source-fixture" || visited.has(current.commitSha)) throw new Error("SYNTHETIC_SOURCE_GRAPH_INVALID");
      visited.add(current.commitSha); const parent: string | undefined = current.parents[0];
      if (parent && !bySha.has(parent)) throw new Error("SYNTHETIC_SOURCE_GRAPH_INVALID");
      current = parent ? bySha.get(parent) : undefined;
    }
    for (const sha of visited) verified.add(sha);
  }
  return plans;
}
