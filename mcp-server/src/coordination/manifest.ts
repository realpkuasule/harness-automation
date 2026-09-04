import { lstatSync, realpathSync } from "node:fs";
import { z } from "zod";
import { bindingSchema, checkHumanScope, qualificationScopeSchema, type HumanScope } from "../approval/human_scope.js";
import { canonicalJson, durableWriteOnce, hashObject, readJson, safePath } from "../v2/fs.js";
import { syntheticScopeSchema } from "./synthetic.js";

const id = qualificationScopeSchema.shape.manifest.unwrap().shape.clientId;
const digest = bindingSchema.shape.endpointHash;
const ref = qualificationScopeSchema.shape.refs.element;
const count = z.number().int().nonnegative().max(4096 * 32);
const definition = qualificationScopeSchema.omit({ manifest: true }).extend({ synthetic: syntheticScopeSchema });
export const qualificationCaseSchema = z.enum(["dg01-identity-scope", "dg01-cas", "dg01-objects-history", "dg01-time-renew", "dg01-late-renew",
  "dg01-recovery", "dg01-handoff", "dg01-drain", "dg01-terminal", "dg01-cli-gates", "dg01-human-budget"]);
const inputSchema = z.object({
  schemaVersion: z.literal("qualification-run-manifest/1"), runId: id,
  repository: bindingSchema.shape.repository, repositoryId: bindingSchema.shape.repositoryId, endpointHash: digest,
  refs: qualificationScopeSchema.shape.refs, synthetic: syntheticScopeSchema,
  requiredCases: z.array(qualificationCaseSchema).min(1).max(qualificationCaseSchema.options.length),
  clients: z.array(z.object({ clientId: id, scope: definition }).strict()).min(1).max(32), cleanupClientId: id,
  maxCommits: count, maxWriteAttempts: count, maxCleanupAttempts: count,
  expiresAt: qualificationScopeSchema.shape.expiresAt, cleanupExpiresAt: qualificationScopeSchema.shape.cleanupExpiresAt,
  sameShaPublicationNegativeControl: z.object({ caseId: z.literal("dg01-cas"), fixtureId: id, ref,
    expected: z.string().regex(/^[a-f0-9]{40}$/u).nullable(),
    publications: z.array(z.object({ clientId: id, transactionId: id }).strict()).length(2),
  }).strict().optional(),
  execution: z.object({ kind: z.literal("local-synthetic-publication/1"),
    steps: z.array(z.object({ stepId: id, clientId: id, operation: z.enum(["bootstrap", "publish-source"]), fixtureId: id, transactionId: id }).strict()).min(1).max(4096),
  }).strict().optional(),
}).strict();
const manifestSchema = inputSchema.extend({ manifestHash: digest });
export type QualificationManifest = z.infer<typeof manifestSchema>;
export type QualificationManifestInput = z.infer<typeof inputSchema>;
const MAX_BYTES = 16 * 1024 * 1024;

/** Static upper bounds only. No Git objects, approvals, counters or runtime authority are created here. */
export function prepareQualificationManifest(input: QualificationManifestInput): QualificationManifest {
  const value = inputSchema.parse(input);
  const invalid = () => { throw new Error("QUALIFICATION_MANIFEST_INVALID"); };
  const cleanup = value.clients.find((client) => client.clientId === value.cleanupClientId);
  const resourceRefs = new Set([...value.synthetic.controls, ...value.synthetic.publications].map((item) => item.ref));
  if (!cleanup || cleanup.scope.maxCleanupAttempts < 1 || new Set(value.clients.map((client) => client.clientId)).size !== value.clients.length ||
      new Set(value.clients.map((client) => hashObject([client.scope.binding.hostId, client.scope.binding.commonDir]))).size !== value.clients.length ||
      new Set(value.refs).size !== value.refs.length || value.refs.length !== resourceRefs.size || value.refs.some((name) => !resourceRefs.has(name)) ||
      new Set(value.requiredCases).size !== value.requiredCases.length || Date.parse(value.cleanupExpiresAt) < Date.parse(value.expiresAt) ||
      value.synthetic.objects.some((plan) => plan.metadata.runId !== value.runId)) invalid();
  const publications = new Map<string, Array<{ clientId: string; transactionId: string }>>();
  const allocations = new Set<string>();
  for (const client of value.clients) {
    const scope = client.scope; checkHumanScope(scope);
    if (scope.runId !== value.runId || scope.binding.repository !== value.repository || scope.binding.repositoryId !== value.repositoryId ||
        scope.binding.endpointHash !== value.endpointHash || scope.refs.some((name) => !value.refs.includes(name)) ||
        Date.parse(scope.expiresAt) > Date.parse(value.expiresAt) || Date.parse(scope.cleanupExpiresAt) > Date.parse(value.cleanupExpiresAt) ||
        client.clientId !== value.cleanupClientId && scope.maxCleanupAttempts !== 0 ||
        hashObject(scope.synthetic.objects) !== hashObject(value.synthetic.objects) || hashObject(scope.synthetic.controls) !== hashObject(value.synthetic.controls)) invalid();
    for (const field of ["maxCommits", "maxWriteAttempts"] as const) {
      if (scope[field] - (scope.takeoverAllocations ?? []).reduce((sum, allocation) => sum + allocation[field], 0) < scope.synthetic.publications.length) invalid();
    }
    for (const allocation of scope.takeoverAllocations ?? []) {
      const anchor = value.synthetic.controls.find((item) => item.ref === allocation.controlRef);
      if (allocations.has(allocation.allocationId) || !value.synthetic.publications.some((item) => item.ref === allocation.sourceRef) ||
          value.synthetic.objects.find((plan) => plan.metadata.objectId === anchor?.fixtureId)?.commitSha !== allocation.genesisSha) invalid();
      allocations.add(allocation.allocationId);
    }
    for (const publication of scope.synthetic.publications) {
      const canonical = value.synthetic.publications.find((item) => item.fixtureId === publication.fixtureId);
      if (!canonical || canonical.ref !== publication.ref || canonical.expected !== publication.expected) invalid();
      const owners = publications.get(publication.fixtureId) ?? [];
      owners.push({ clientId: client.clientId, transactionId: publication.transactionId }); publications.set(publication.fixtureId, owners);
    }
  }
  for (const field of ["maxCommits", "maxWriteAttempts", "maxCleanupAttempts"] as const) {
    // Child allocations are already contained in each parent's total, never added a second time.
    if (value.clients.reduce((sum, client) => sum + client.scope[field], 0) > value[field]) invalid();
  }
  const negative = value.sameShaPublicationNegativeControl;
  if (negative && (!value.requiredCases.includes(negative.caseId) ||
      new Set(negative.publications.map((item) => item.clientId)).size !== 2 || new Set(negative.publications.map((item) => item.transactionId)).size !== 2 ||
      !value.synthetic.publications.some((item) => item.fixtureId === negative.fixtureId && item.ref === negative.ref && item.expected === negative.expected))) invalid();
  for (const publication of value.synthetic.publications) {
    const owners = publications.get(publication.fixtureId) ?? [];
    if (negative?.fixtureId === publication.fixtureId) {
      if (owners.length !== 2 || owners.some((owner) => !negative.publications.some((item) => hashObject(item) === hashObject(owner)))) invalid();
    } else if (owners.length !== 1 || owners[0].transactionId !== publication.transactionId) invalid();
  }
  if (value.execution) {
    const steps = value.execution.steps; const seen = new Set<string>(); const published = new Set<string>(); const heads = new Map<string, string>();
    if (!value.synthetic.controls.length || new Set(steps.map((step) => step.stepId)).size !== steps.length) invalid();
    for (const step of steps) {
      const client = value.clients.find((item) => item.clientId === step.clientId);
      const publication = client?.scope.synthetic.publications.find((item) => item.fixtureId === step.fixtureId && item.transactionId === step.transactionId);
      const plan = value.synthetic.objects.find((item) => item.metadata.objectId === step.fixtureId);
      if (!publication || !plan || (step.operation === "bootstrap") !== (plan.kind === "control-genesis") ||
          seen.has(step.fixtureId) || (heads.get(publication.ref) ?? null) !== publication.expected ||
          plan.parents.some((parent) => !published.has(parent))) invalid();
      if (negative?.fixtureId === step.fixtureId) throw new Error("QUALIFICATION_RUNNER_CONCURRENCY_UNSUPPORTED");
      seen.add(step.fixtureId); published.add(plan!.commitSha); heads.set(publication!.ref, plan!.commitSha);
    }
  }
  if (Buffer.byteLength(canonicalJson(value)) > MAX_BYTES) invalid();
  return { ...value, manifestHash: hashObject(value) };
}

export function validateQualificationManifest(input: unknown): QualificationManifest {
  const { manifestHash, ...value } = manifestSchema.parse(input);
  const manifest = prepareQualificationManifest(value);
  if (manifest.manifestHash !== manifestHash) throw new Error("QUALIFICATION_MANIFEST_HASH_MISMATCH");
  return manifest;
}
export function scopeForClient(input: QualificationManifest, clientId: string): Extract<HumanScope, { kind: "qualification-run" }> {
  const manifest = validateQualificationManifest(input); const client = manifest.clients.find((value) => value.clientId === clientId);
  if (!client) throw new Error("QUALIFICATION_CLIENT_UNKNOWN");
  return { ...client.scope, manifest: { manifestHash: manifest.manifestHash, clientId } };
}
const manifestPath = (commonDir: string, hash: string) => safePath(realpathSync(commonDir), `harness/plans/qualification-${digest.parse(hash)}.json`);
export function loadQualificationManifest(commonDir: string, hash: string): QualificationManifest {
  const path = manifestPath(commonDir, hash); const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error("QUALIFICATION_MANIFEST_INVALID");
  const manifest = validateQualificationManifest(readJson<unknown>(path));
  if (manifest.manifestHash !== hash) throw new Error("QUALIFICATION_MANIFEST_HASH_MISMATCH"); return manifest;
}
/** Immutable input in the existing plan state directory; saving it grants no permission. */
export function saveQualificationManifest(commonDir: string, input: QualificationManifest): QualificationManifest {
  const manifest = validateQualificationManifest(input); const path = manifestPath(commonDir, manifest.manifestHash);
  try { durableWriteOnce(path, canonicalJson(manifest)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  return loadQualificationManifest(commonDir, manifest.manifestHash);
}
export function assertQualificationManifestScope(commonDir: string, scope: HumanScope): void {
  if (scope.kind !== "qualification-run" || !scope.manifest) return;
  const manifest = loadQualificationManifest(commonDir, scope.manifest.manifestHash);
  if (hashObject(scopeForClient(manifest, scope.manifest.clientId)) !== hashObject(scope)) throw new Error("QUALIFICATION_CLIENT_SCOPE_MISMATCH");
}
