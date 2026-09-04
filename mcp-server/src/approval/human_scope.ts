import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { hashObject } from "../v2/fs.js";
import { harnessArtifactSchema } from "../repository/artifact.js";
import { controlEpochDigest, controlEpochSchema } from "../coordination/authority.js";
import { takeoverRiskSchema } from "../coordination/takeover_record.js";
import { coordinationRecordSchema } from "../coordination/record.js";
import { syntheticObjectSchema, syntheticScopeSchema } from "../coordination/synthetic.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const text = z.string().min(1).max(512).refine((value) => !/[\x00-\x1f\x7f]/u.test(value));
const timestamp = z.string().datetime();
const count = z.number().int().nonnegative().max(4096);
const ref = z.string().regex(/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u).refine((value) => !value.includes("..") && value.split("/").every((part) => part && !part.startsWith(".") && !part.endsWith(".") && !part.endsWith(".lock")));
export const bindingSchema = z.object({
  commonDir: z.string().refine(isAbsolute),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u), repositoryId: text,
  endpointHash: digest, credentialBindingHash: digest, credentialRef: text, credentialPurpose: z.literal("git-transport"),
  actor: text, hostId: z.string().uuid(), configHash: digest,
  controlEpoch: controlEpochSchema,
  implementation: harnessArtifactSchema, runnerHash: digest,
}).strict();
const fields = { binding: bindingSchema, expiresAt: timestamp };
const expectation = z.object({ recordHash: digest, generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), owner: text, machine: text, lastObservedHead: sha, controlEpochDigest: digest }).strict();
const workItemSchema = coordinationRecordSchema.shape.workItem;
const allocationSchema = z.object({ allocationId: text, workItem: workItemSchema, controlRef: ref, sourceRef: ref, genesisSha: sha,
  maxCommits: count, maxWriteAttempts: count }).strict();
const canonicalAbsolute = text.refine((value) => isAbsolute(value) && resolve(value) === value && !value.split("/").includes(".."));
export const qualificationResourceSchema = z.object({
  resourceId: text, clientId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u), path: canonicalAbsolute,
  branch: coordinationRecordSchema.shape.branch, fixtureId: text, sourceSha: sha,
  operations: z.tuple([z.literal("import-source"), z.literal("create-once"), z.literal("observe"), z.literal("close-exact")]),
}).strict();
export const qualificationResourcesSchema = z.object({
  authorityRoot: canonicalAbsolute, commonDir: canonicalAbsolute, configHash: digest, hostBindingHash: digest,
  expiresAt: timestamp, cleanupExpiresAt: timestamp, maxConcurrent: z.number().int().min(1).max(32),
  items: z.array(qualificationResourceSchema).min(1).max(32),
}).strict();
export const humanScopeSchema = z.discriminatedUnion("kind", [
  z.object({ ...fields, kind: z.literal("qualification-run"), runId: text,
    refs: z.array(ref).min(1).max(32), operations: z.array(z.enum(["create", "cas"])).min(1).max(2),
    maxCommits: count, maxWriteAttempts: count, maxCleanupAttempts: count, cleanupExpiresAt: timestamp,
    takeoverAllocations: z.array(allocationSchema).max(32).optional(),
    localResources: qualificationResourcesSchema.optional(),
    synthetic: syntheticScopeSchema.optional(),
    manifest: z.object({ manifestHash: digest, clientId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u) }).strict().optional(),
  }).strict(),
  z.object({ ...fields, kind: z.literal("production-enable"), configBeforeHash: digest.nullable(), configAfterHash: digest,
    controlRef: ref, genesisSha: sha, genesisTree: sha, qualificationEvidenceHash: digest, maxBootstrapAttempts: count,
    genesisObject: syntheticObjectSchema.optional(),
  }).strict(),
  z.object({ ...fields, kind: z.literal("takeover"), workItem: workItemSchema, controlRef: ref, expectedControlSha: sha,
    expected: expectation, targetOwner: text, targetHostId: z.string().uuid(), newEpochDigest: digest,
    targetWorkspace: z.string().refine(isAbsolute), targetBranch: coordinationRecordSchema.shape.branch, targetHead: sha, sourceRepositoryId: text,
    newLease: z.object({ ttlMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), notAfter: timestamp }).strict(),
    assetRisk: takeoverRiskSchema, assetRiskHash: digest, transactionId: text, maxCommits: count, maxWriteAttempts: count,
    qualification: z.object({ parentApprovalRef: digest, runId: text, allocationId: text, genesisSha: sha }).strict().optional(),
  }).strict(),
]);
export type HumanScope = z.infer<typeof humanScopeSchema>;
export type HumanScopeBinding = z.infer<typeof bindingSchema>;
export const qualificationScopeSchema = humanScopeSchema.options[0];

export function checkHumanScope(scope: HumanScope): void {
  if (scope.binding.controlEpoch.coordinationConfigDigest !== scope.binding.configHash ||
      (scope.kind === "qualification-run" || scope.kind === "takeover" && scope.qualification !== undefined) !==
        (scope.binding.controlEpoch.mode === "isolated-qualification")) throw new Error("HUMAN_SCOPE_INVALID");
  if (scope.kind === "qualification-run" && (new Set(scope.refs).size !== scope.refs.length || new Set(scope.operations).size !== scope.operations.length ||
      scope.maxWriteAttempts < 1 || scope.maxCommits < 1 || Date.parse(scope.cleanupExpiresAt) < Date.parse(scope.expiresAt))) throw new Error("HUMAN_SCOPE_INVALID");
  if (scope.kind === "qualification-run") {
    const resources = scope.localResources;
    if (resources && (resources.commonDir !== scope.binding.commonDir || resources.items.length > resources.maxConcurrent ||
        Date.parse(resources.expiresAt) > Date.parse(scope.expiresAt) || Date.parse(resources.cleanupExpiresAt) > Date.parse(scope.cleanupExpiresAt) ||
        Date.parse(resources.cleanupExpiresAt) < Date.parse(resources.expiresAt) ||
        ["resourceId", "path", "branch"].some((field) => new Set(resources.items.map((item) => item[field as "resourceId" | "path" | "branch"])).size !== resources.items.length) ||
        resources.items.some((item) => !scope.refs.includes(`refs/heads/${item.branch}`) ||
          !scope.synthetic?.objects.some((object) => object.kind === "source-fixture" && object.metadata.objectId === item.fixtureId && object.commitSha === item.sourceSha)))) throw new Error("HUMAN_LOCAL_RESOURCE_SCOPE_INVALID");
    const allocations = scope.takeoverAllocations ?? [];
    if (new Set(allocations.map((value) => value.allocationId)).size !== allocations.length ||
        allocations.some((value) => !value.workItem.startsWith(`github:${scope.binding.repository}#`) ||
          !Number.isSafeInteger(Number(value.workItem.split("#")[1])) || !scope.refs.includes(value.controlRef) ||
          !scope.refs.includes(value.sourceRef) || value.controlRef === value.sourceRef || value.maxCommits < 1 || value.maxWriteAttempts < 1) ||
        allocations.reduce((sum, value) => sum + value.maxCommits, 0) > scope.maxCommits ||
        allocations.reduce((sum, value) => sum + value.maxWriteAttempts, 0) > scope.maxWriteAttempts) throw new Error("HUMAN_SCOPE_INVALID");
    if (scope.synthetic && (scope.synthetic.objects.some((plan) => plan.metadata.runId !== scope.runId) ||
        scope.synthetic.controls.some((anchor) => !scope.refs.includes(anchor.ref)) ||
        scope.synthetic.publications.some((publication) => !scope.refs.includes(publication.ref) ||
          !scope.operations.includes(publication.expected === null ? "create" : "cas")))) throw new Error("HUMAN_SCOPE_INVALID");
  }
  if (scope.kind === "takeover") {
    const { target, remote } = scope.assetRisk;
    if (!scope.workItem.startsWith(`github:${scope.binding.repository}#`) || !Number.isSafeInteger(Number(scope.workItem.split("#")[1])) ||
        scope.targetOwner !== scope.binding.actor || scope.targetHostId !== scope.binding.hostId || scope.maxWriteAttempts < 1 || scope.maxCommits < 1 ||
        scope.newEpochDigest !== controlEpochDigest(scope.binding.controlEpoch) || scope.assetRiskHash !== hashObject(scope.assetRisk) ||
        target.workspace !== scope.targetWorkspace || target.commonDir !== scope.binding.commonDir || target.actor !== scope.targetOwner || target.hostId !== scope.targetHostId ||
        target.branch !== scope.targetBranch || target.head !== scope.targetHead || remote.repositoryId !== scope.sourceRepositoryId ||
        remote.endpointHash !== scope.binding.endpointHash || remote.ref !== `refs/heads/${scope.targetBranch}` || remote.ref === scope.controlRef) throw new Error("HUMAN_SCOPE_INVALID");
  }
  if (scope.kind === "production-enable" && (scope.configAfterHash !== scope.binding.configHash || scope.genesisObject &&
      (scope.genesisObject.kind !== "control-genesis" || scope.genesisObject.commitSha !== scope.genesisSha || scope.genesisObject.treeSha !== scope.genesisTree))) throw new Error("HUMAN_SCOPE_INVALID");
}
