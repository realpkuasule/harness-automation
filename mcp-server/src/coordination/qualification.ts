import { z } from "zod";
import { closeQualificationWritesLocked } from "../approval/human.js";
import { withMutationLock } from "../recovery/service.js";
import { resolveRepositoryContext } from "../repository/git.js";
import { hashObject } from "../v2/fs.js";
import { abandonClientProcess, readClientSettlement, runClientStep, settleClientProcess, startClientProcess, type ClientProcess } from "./client_process.js";
import { collectClientEvidence, evaluateQualificationRun, readVerifiedClientEvidence, type EvidenceLock, type VerifiedClientEvidence } from "./evidence.js";
import { qualificationSteps, validateQualificationManifest, type QualificationManifest } from "./manifest.js";
import { sameShaClientFacts } from "./same_sha.js";
import { nativeCoordinationObservers } from "./runtime.js";
import { createQualificationWorkspaceLocked, reserveQualificationWorkspacesLocked } from "../worktree/qualification.js";

const targetSchema = z.object({ clientId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u), projectRoot: z.string().min(1), approvalRef: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
export type QualificationClientTarget = z.infer<typeof targetSchema>;
export type SettledQualification = Readonly<{ kind: "settled-local-qualification" }>;
type Settlement = { manifestHash: string; clients: ClientProcess[]; evidence: VerifiedClientEvidence[]; steps: Array<{ stepId: string; resultHash: string }>;
  executionStatus: "completed" | "aborted"; executionError: string | null };
const settled = new WeakMap<SettledQualification, Settlement>();

export function readSettledQualification(handle: SettledQualification) {
  const state = settled.get(handle); if (!state) throw new Error("QUALIFICATION_RUNNER_DRAIN_UNPROVEN");
  return { manifestHash: state.manifestHash, instances: state.clients.map(readClientSettlement), steps: structuredClone(state.steps), evidence: [...state.evidence],
    executionStatus: state.executionStatus, executionError: state.executionError };
}

/** Settlement fixes the closed run prefix, not a permanently frozen LKG head that its own cleanup would advance. */
export function collectSettledEvidence(handle: SettledQualification, held?: EvidenceLock): VerifiedClientEvidence[] {
  const proof = readSettledQualification(handle);
  return proof.evidence.map((baseline) => {
    const before = readVerifiedClientEvidence(baseline);
    const current = collectClientEvidence(before.projectRoot, before.approvalRef, before.clientId === held?.clientId ? held.lock : undefined);
    const after = readVerifiedClientEvidence(current);
    if (before.manifestHash !== after.manifestHash || before.clientId !== after.clientId || before.chains.length !== after.chains.length ||
        hashObject(before.lkg) !== hashObject(after.lkg.slice(0, before.lkg.length))) throw new Error("QUALIFICATION_EVIDENCE_DRIFT");
    for (const original of before.chains) {
      const chain = after.chains.find((value) => value.approvalRef === original.approvalRef);
      if (!chain || hashObject(original.receipts) !== hashObject(chain.receipts.slice(0, original.receipts.length))) throw new Error("QUALIFICATION_EVIDENCE_DRIFT");
      for (const receipt of chain.receipts.slice(original.receipts.length)) {
        const event = receipt.snapshot as { kind?: string; attempt?: { operation?: string }; outcome?: { attemptId?: string } };
        if (event.kind === "reserved" && event.attempt?.operation === "cleanup") continue;
        if (event.kind === "outcome" && chain.state.attempts.some((attempt) => attempt.operation === "cleanup" && attempt.attemptId === event.outcome?.attemptId)) continue;
        throw new Error("QUALIFICATION_EVIDENCE_DRIFT");
      }
    }
    return current;
  });
}

/** Fixed finite publications only; native bindings and pristine authorizations are checked for all clients before spawning. */
export async function runLocalQualification(input: QualificationManifest, inputTargets: QualificationClientTarget[]) {
  const manifest = validateQualificationManifest(input); const targets = z.array(targetSchema).min(1).max(32).parse(inputTargets);
  if (!manifest.execution) throw new Error("QUALIFICATION_EXECUTION_REQUIRED");
  // Fail closed rather than run a publication-and-fixtures sequence that silently skips the
  // contention this profile exists to prove. Same stance as rejecting undeclared resource
  // descriptors: an unexecutable profile is refused, never quietly reduced.
  if (manifest.execution.kind === "local-acquire-contention/1") throw new Error("QUALIFICATION_ACQUIRE_EXECUTION_UNSUPPORTED");
  if (targets.length !== manifest.clients.length || new Set(targets.map((target) => target.clientId)).size !== targets.length ||
      targets.some((target) => !manifest.clients.some((client) => client.clientId === target.clientId))) throw new Error("QUALIFICATION_CLIENT_EVIDENCE_MISMATCH");
  const prepared = targets.map((target) => {
    const facts = readVerifiedClientEvidence(collectClientEvidence(target.projectRoot, target.approvalRef)); const scope = facts.chains[0].state.approval.scope;
    if (facts.manifestHash !== manifest.manifestHash || facts.clientId !== target.clientId) throw new Error("QUALIFICATION_CLIENT_SCOPE_MISMATCH");
    if (facts.chains.length !== 1 || facts.chains[0].state.writesClosed || facts.chains[0].state.revoked ||
        facts.chains[0].state.candidates.length || facts.chains[0].state.attempts.length) throw new Error("QUALIFICATION_RUN_ALREADY_STARTED");
    return { ...target, projectRoot: facts.projectRoot, bindingHash: hashObject(scope.binding), hostId: facts.origin.hostId };
  });
  if (new Set(prepared.map((target) => target.hostId)).size !== 1) throw new Error("QUALIFICATION_LOCAL_HOST_MISMATCH");
  const clients = new Map<string, ClientProcess>(); const supervised: ClientProcess[] = [];
  const steps: Settlement["steps"] = []; const launchRequestedClients: string[] = [];
  const closeClientWrites = async () => {
    const evidence: VerifiedClientEvidence[] = [];
    for (const target of prepared) {
      const context = resolveRepositoryContext(target.projectRoot);
      evidence.push(await withMutationLock(context, (lock) => {
        closeQualificationWritesLocked(lock, context.commonDir, target.approvalRef);
        return collectClientEvidence(context.projectDir, target.approvalRef, lock);
      }));
    }
    return evidence;
  };
  // The plan's fixed order is publication first, then fixture allocation: one locked
  // reservation for the whole approved batch, then one exact creation per resource, all in
  // this parent process. A failure anywhere in the batch surfaces as an ordinary run failure,
  // so it takes the same cooperative abort and settlement path as a failed publication.
  const runResourceStep = (target: typeof prepared[number]): Promise<string> => withMutationLock(
    resolveRepositoryContext(target.projectRoot),
    (lock) => {
      const context = resolveRepositoryContext(target.projectRoot);
      // Borrow the lock this step already holds; collecting without it would re-acquire nested.
      const facts = readVerifiedClientEvidence(collectClientEvidence(context.projectDir, target.approvalRef, lock));
      const scope = facts.chains[0].state.approval.scope;
      if (scope.kind !== "qualification-run" || !scope.localResources) throw new Error("HUMAN_LOCAL_RESOURCE_SCOPE_REQUIRED");
      const clock = nativeCoordinationObservers(context, scope.binding).provider.serverClock();
      reserveQualificationWorkspacesLocked(lock, context.projectDir, target.approvalRef, scope.binding, clock);
      const created = scope.localResources.items.map((item) =>
        hashObject(createQualificationWorkspaceLocked(lock, context.projectDir, target.approvalRef, item.resourceId)));
      return hashObject({ resourceStep: target.clientId, created });
    });
  const recordSettlement = (evidence: VerifiedClientEvidence[], executionStatus: Settlement["executionStatus"], executionError: string | null) => {
    const handle: SettledQualification = Object.freeze({ kind: "settled-local-qualification" });
    supervised.forEach(readClientSettlement);
    settled.set(handle, { manifestHash: manifest.manifestHash, clients: [...supervised], evidence, steps: structuredClone(steps), executionStatus, executionError });
    return handle;
  };
  try {
    for (const target of prepared) {
      launchRequestedClients.push(target.clientId);
      const client = await startClientProcess({ ...target, manifestHash: manifest.manifestHash });
      clients.set(target.clientId, client); supervised.push(client);
    }
    const scheduled = qualificationSteps(manifest);
    if (manifest.execution.kind === "local-same-sha-publication/1") {
      // Each actual client finishes its original expected-ref read/materialization before either can send.
      for (const step of scheduled) {
        const target = prepared.find((item) => item.clientId === step.clientId)!;
        const resultHash = await runClientStep(clients.get(step.clientId)!, step.stepId, "prepare");
        if (resultHash !== hashObject(sameShaClientFacts(target.projectRoot, target.approvalRef, "prepared"))) throw new Error("QUALIFICATION_SAME_SHA_EVIDENCE_INVALID");
        steps.push({ stepId: `${step.stepId}-prepare`, resultHash });
      }
      for (const target of prepared) sameShaClientFacts(target.projectRoot, target.approvalRef, "prepared");
      for (const [index, step] of scheduled.entries()) {
        const target = prepared.find((item) => item.clientId === step.clientId)!;
        const resultHash = await runClientStep(clients.get(step.clientId)!, step.stepId, "dispatch");
        if (resultHash !== hashObject(sameShaClientFacts(target.projectRoot, target.approvalRef, index === 0 ? "updated" : "no-op"))) throw new Error("QUALIFICATION_SAME_SHA_EVIDENCE_INVALID");
        steps.push({ stepId: `${step.stepId}-dispatch`, resultHash });
      }
    } else {
      for (const step of scheduled) steps.push({ stepId: step.stepId, resultHash: await runClientStep(clients.get(step.clientId)!, step.stepId) });
      const resourceStep = manifest.execution.kind === "local-synthetic-publication/1" ? manifest.execution.resourceStep : undefined;
      if (resourceStep) {
        const target = prepared.find((item) => item.clientId === resourceStep.clientId);
        if (!target) throw new Error("QUALIFICATION_CLIENT_UNKNOWN");
        steps.push({ stepId: resourceStep.stepId, resultHash: await runResourceStep(target) });
      }
    }
    // No parent holds apply.lock while waiting for a child which needs that same lock.
    for (const client of clients.values()) await settleClientProcess(client);
    const evidence = await closeClientWrites();
    if (manifest.execution.kind === "local-same-sha-publication/1") {
      const target = prepared.find((item) => item.clientId === scheduled[1].clientId)!;
      const before = sameShaClientFacts(target.projectRoot, target.approvalRef, "no-op");
      launchRequestedClients.push(target.clientId);
      const reader = await startClientProcess({ ...target, manifestHash: manifest.manifestHash, role: "rejected-recovery", attemptId: before.attemptId! });
      supervised.push(reader);
      const resultHash = await runClientStep(reader, "rejected-restart", "recover-rejected");
      const after = sameShaClientFacts(target.projectRoot, target.approvalRef, "no-op");
      if (hashObject(before) !== hashObject(after) || resultHash !== hashObject({ before, after, result: "rejected-unchanged" })) throw new Error("QUALIFICATION_RESTART_EVIDENCE_INVALID");
      await settleClientProcess(reader); steps.push({ stepId: "rejected-restart", resultHash });
    }
    const handle = recordSettlement(evidence, "completed", null);
    const proof = readSettledQualification(handle); const observed = evaluateQualificationRun(manifest, evidence);
    return { settled: handle, evidence, report: { ...observed,
      execution: { kind: manifest.execution.kind, steps: proof.steps, instances: proof.instances, drainCoverage: "this-run-native-process-groups-only" },
      blockers: observed.blockers.filter((item) => item.code !== "QUALIFICATION_RUNNER_DRAIN_UNPROVEN") } };
  } catch (error) {
    const code = error instanceof Error ? error.message : "QUALIFICATION_EXECUTION_FAILED";
    let abortedSettlement: SettledQualification | undefined; let abortError: string | null = null;
    try {
      // A failed launch without a returned owned handle is unknown, never an inferred zero-process start.
      if (launchRequestedClients.length !== supervised.length) throw new Error("QUALIFICATION_PROCESS_DRAIN_UNPROVEN");
      for (const client of supervised) await settleClientProcess(client, "abort");
      abortedSettlement = recordSettlement(await closeClientWrites(), "aborted", code);
    } catch (failure) {
      abortError = failure instanceof Error ? failure.message : "QUALIFICATION_ABORT_FAILED";
      supervised.forEach(abandonClientProcess);
    }
    throw new Error(code, {
      cause: { error, abortedSettlement, qualificationProgress: { kind: manifest.execution.kind, steps: structuredClone(steps),
        launchRequestedClients, readyClients: [...clients.keys()], executionStatus: abortedSettlement ? "aborted" : "failed", executionError: code, abortError,
        instances: abortedSettlement ? readSettledQualification(abortedSettlement).instances : [],
        drainCoverage: abortedSettlement ? "this-run-native-process-groups-only" : "unproven" } },
    });
  }
}
