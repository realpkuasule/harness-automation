import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { recordHumanApproval } from "../approval/human.js";
import { createSemanticApprovalPacket } from "../approval/service.js";
import { resolveRepositoryContext } from "../repository/git.js";
import { canonicalJson, durableWriteOnce, hashObject, safePath } from "../v2/fs.js";
import { prepareQualificationManifest, saveQualificationManifest, scopeForClient, validateQualificationManifest, type QualificationManifestInput } from "./manifest.js";
import { nativeCoordinationObservers } from "./runtime.js";

const targetSchema = z.object({ clientId: z.string().min(1).max(128), projectRoot: z.string().min(1) }).strict();
const requestSchema = z.object({ manifest: z.unknown(), targets: z.array(targetSchema).min(1).max(32) }).strict();
const text = z.string().min(1).max(512).refine((value) => !/[\x00-\x1f\x7f]/u.test(value));
const confirmationSchema = z.object({ planHash: z.string().regex(/^[a-f0-9]{64}$/u), approvedBy: text,
  approvalSource: text, approvedAt: z.string().datetime() }).strict();

export function readQualificationInput(path: string): unknown {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) throw new Error("QUALIFICATION_INPUT_INVALID");
  return JSON.parse(readFileSync(path, "utf8"));
}

function saveOnce(path: string, value: unknown): void {
  try { durableWriteOnce(path, canonicalJson(value), 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  if (hashObject(readQualificationInput(path)) !== hashObject(value)) throw new Error("QUALIFICATION_PLAN_FILE_MISMATCH");
}

/** Rebuild from native, non-secret observations; a claimed binding is never its own evidence. */
function preparePlan(projectRoot: string, input: unknown) {
  const request = requestSchema.parse(input); const management = resolveRepositoryContext(projectRoot);
  const manifest = prepareQualificationManifest(request.manifest as QualificationManifestInput);
  if (!manifest.execution) throw new Error("QUALIFICATION_EXECUTION_REQUIRED");
  const cleaner = manifest.clients.find((client) => client.clientId === manifest.cleanupClientId)!;
  const publishedRefs = new Set(manifest.execution.steps.map((step) => manifest.synthetic.publications.find((item) => item.fixtureId === step.fixtureId)!.ref));
  if (manifest.refs.some((ref) => !cleaner.scope.refs.includes(ref)) || cleaner.scope.maxCleanupAttempts < publishedRefs.size) throw new Error("QUALIFICATION_CLEANUP_SCOPE_INSUFFICIENT");
  if (request.targets.length !== manifest.clients.length || new Set(request.targets.map((target) => target.clientId)).size !== request.targets.length ||
      request.targets.some((target) => !manifest.clients.some((client) => client.clientId === target.clientId))) throw new Error("QUALIFICATION_CLIENT_SCOPE_MISMATCH");
  const targets = manifest.clients.map((client) => {
    const target = request.targets.find((item) => item.clientId === client.clientId)!;
    const context = resolveRepositoryContext(resolve(management.projectDir, target.projectRoot));
    const scope = scopeForClient(manifest, client.clientId);
    nativeCoordinationObservers(context, scope.binding);
    return { clientId: client.clientId, projectRoot: context.projectDir, scope };
  });
  if (new Set(targets.map((target) => target.scope.binding.hostId)).size !== 1) throw new Error("QUALIFICATION_LOCAL_HOST_MISMATCH");
  const core = { schemaVersion: "qualification-cli-plan/1" as const, managementCommonDir: management.commonDir, manifest, targets };
  const planHash = hashObject(core);
  const packets = targets.map(({ clientId, projectRoot: targetRoot, scope }) => {
    const inputHash = hashObject(scope);
    return { clientId, packet: createSemanticApprovalPacket({ planHash, inputHash, producerIdentity: "qualification-cli",
      binding: { planHash, inputDigest: inputHash, contextDigest: hashObject({ commonDir: scope.binding.commonDir, projectRoot: targetRoot }),
        observedHash: hashObject(scope.binding), policyDigest: hashObject({ contract: core.schemaVersion, approval: "explicit-human", productionEnabled: false }) },
      actions: [{ id: scope.kind, kind: "permission-change", protected: true, reversible: true,
        summary: `Run finite synthetic publications for ${scope.binding.repository}: ${scope.refs.join(", ")}; commits <= ${scope.maxCommits}, writes <= ${scope.maxWriteAttempts}, cleanup <= ${scope.maxCleanupAttempts}; no production enablement.`,
        before: "not-authorized", after: inputHash,
        recovery: "Retain unknown refs and original receipts. Recover read-only; never replay an unresolved write." }] }) };
  });
  return { ...core, planHash, packets };
}
export type QualificationCliPlan = ReturnType<typeof preparePlan>;
const savedPlanPath = (plan: QualificationCliPlan) => safePath(plan.managementCommonDir, `harness/plans/qualification-cli-${plan.planHash}.json`);

export function planQualificationCommand(projectRoot: string, input: unknown) {
  const plan = preparePlan(projectRoot, input);
  for (const target of plan.targets) saveQualificationManifest(target.scope.binding.commonDir, plan.manifest);
  const planPath = savedPlanPath(plan); saveOnce(planPath, plan);
  return { planPath, planHash: plan.planHash, secretsRead: false, remoteWrites: 0, approved: false, productionEnabled: false,
    summary: { repository: plan.manifest.repository, repositoryId: plan.manifest.repositoryId, refs: plan.manifest.refs,
      steps: plan.manifest.execution!.steps, cleanupClientId: plan.manifest.cleanupClientId,
      clients: plan.targets.map(({ clientId, scope }) => ({ clientId, maxCommits: scope.maxCommits, maxWriteAttempts: scope.maxWriteAttempts, maxCleanupAttempts: scope.maxCleanupAttempts,
        expiresAt: scope.expiresAt, cleanupExpiresAt: scope.cleanupExpiresAt })),
      maxCommits: plan.manifest.maxCommits, maxWriteAttempts: plan.manifest.maxWriteAttempts, maxCleanupAttempts: plan.manifest.maxCleanupAttempts,
      expiresAt: plan.manifest.expiresAt, cleanupExpiresAt: plan.manifest.cleanupExpiresAt,
      content: "Synthetic empty-tree objects only; LOCAL process supervision, not full qualification or production enablement." } };
}

export function loadQualificationCliPlan(projectRoot: string, path: string): QualificationCliPlan {
  const saved = readQualificationInput(path);
  const parsed = z.object({ schemaVersion: z.literal("qualification-cli-plan/1"), managementCommonDir: z.string(), manifest: z.unknown(),
    targets: z.array(targetSchema.extend({ scope: z.unknown() })).min(1).max(32), planHash: z.string(), packets: z.array(z.unknown()).max(32) }).strict().parse(saved);
  const manifest = Object.fromEntries(Object.entries(validateQualificationManifest(parsed.manifest)).filter(([key]) => key !== "manifestHash"));
  const plan = preparePlan(projectRoot, { manifest, targets: parsed.targets.map(({ clientId, projectRoot: root }) => ({ clientId, projectRoot: root })) });
  if (hashObject(saved) !== hashObject(plan) || resolve(path) !== savedPlanPath(plan)) throw new Error("QUALIFICATION_PLAN_FILE_MISMATCH");
  return plan;
}

/** Only the explicit CLI invocation registers authority. This saved confirmation is an idempotent audit input, never a run ticket. */
export function approveQualificationCommand(plan: QualificationCliPlan, approvedHash: string, approvedBy: string, approvalSource: string) {
  if (approvedHash !== plan.planHash) throw new Error("HUMAN_APPROVAL_REQUIRED");
  text.parse(approvedBy); text.parse(approvalSource);
  const path = safePath(plan.managementCommonDir, `harness/plans/qualification-confirmation-${plan.planHash}.json`);
  const requested = confirmationSchema.parse({ planHash: plan.planHash, approvedBy, approvalSource, approvedAt: new Date().toISOString() });
  try { durableWriteOnce(path, canonicalJson(requested), 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const confirmation = confirmationSchema.parse(readQualificationInput(path));
  if (confirmation.planHash !== plan.planHash || confirmation.approvedBy !== approvedBy || confirmation.approvalSource !== approvalSource) throw new Error("HUMAN_APPROVAL_ALREADY_RECORDED");
  const registered: Array<{ clientId: string; approvalRef: string }> = [];
  try {
    for (const target of plan.targets) {
      // Reobserve immediately at each common-dir boundary; multi-repository approval is deliberately not presented as atomic.
      nativeCoordinationObservers(resolveRepositoryContext(target.projectRoot), target.scope.binding);
      const packet = plan.packets.find((item) => item.clientId === target.clientId)!.packet;
      const approvalRef = recordHumanApproval(target.scope.binding.commonDir, { packet, scope: target.scope, approvedBy,
        approvedAt: confirmation.approvedAt, source: { kind: "explicit-human", messageHash: hashObject({ planHash: plan.planHash, approvalSource }) } }, plan.planHash);
      registered.push({ clientId: target.clientId, approvalRef });
    }
    return { executionStatus: "completed" as const, planHash: plan.planHash, registered, pending: [], productionEnabled: false };
  } catch (error) {
    return { executionStatus: "partial" as const, planHash: plan.planHash, registered,
      pending: plan.targets.slice(registered.length).map((target) => target.clientId), error: error instanceof Error ? error.message : "QUALIFICATION_APPROVAL_FAILED",
      recovery: "Repeat the same approve command after resolving the reported gate; pending includes any durable unindexed approval tail." };
  }
}
