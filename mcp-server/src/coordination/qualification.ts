import { z } from "zod";
import { closeQualificationWritesLocked } from "../approval/human.js";
import { withMutationLock } from "../recovery/service.js";
import { resolveRepositoryContext } from "../repository/git.js";
import { hashObject } from "../v2/fs.js";
import { abandonClientProcess, readClientSettlement, runClientStep, settleClientProcess, startClientProcess, type ClientProcess } from "./client_process.js";
import { collectClientEvidence, evaluateQualificationRun, readVerifiedClientEvidence, type VerifiedClientEvidence } from "./evidence.js";
import { validateQualificationManifest, type QualificationManifest } from "./manifest.js";

const targetSchema = z.object({ clientId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u), projectRoot: z.string().min(1), approvalRef: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
export type QualificationClientTarget = z.infer<typeof targetSchema>;
export type SettledQualification = Readonly<{ kind: "settled-local-qualification" }>;
type Settlement = { manifestHash: string; clients: ClientProcess[]; evidence: VerifiedClientEvidence[]; steps: Array<{ stepId: string; resultHash: string }> };
const settled = new WeakMap<SettledQualification, Settlement>();

export function readSettledQualification(handle: SettledQualification) {
  const state = settled.get(handle); if (!state) throw new Error("QUALIFICATION_RUNNER_DRAIN_UNPROVEN");
  return { manifestHash: state.manifestHash, instances: state.clients.map(readClientSettlement), steps: structuredClone(state.steps), evidence: [...state.evidence] };
}

/** Fixed finite publications only; native bindings and pristine authorizations are checked for all clients before spawning. */
export async function runLocalQualification(input: QualificationManifest, inputTargets: QualificationClientTarget[]) {
  const manifest = validateQualificationManifest(input); const targets = z.array(targetSchema).min(1).max(32).parse(inputTargets);
  if (!manifest.execution) throw new Error("QUALIFICATION_EXECUTION_REQUIRED");
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
  const clients = new Map<string, ClientProcess>(); const steps: Settlement["steps"] = [];
  try {
    for (const target of prepared) clients.set(target.clientId, await startClientProcess({ ...target, manifestHash: manifest.manifestHash }));
    for (const step of manifest.execution.steps) steps.push({ stepId: step.stepId, resultHash: await runClientStep(clients.get(step.clientId)!, step.stepId) });
    // No parent holds apply.lock while waiting for a child which needs that same lock.
    for (const client of clients.values()) await settleClientProcess(client);
    const evidence: VerifiedClientEvidence[] = [];
    for (const target of prepared) {
      const context = resolveRepositoryContext(target.projectRoot);
      evidence.push(await withMutationLock(context, (lock) => {
        closeQualificationWritesLocked(lock, context.commonDir, target.approvalRef);
        return collectClientEvidence(context.projectDir, target.approvalRef, lock);
      }));
    }
    const handle: SettledQualification = Object.freeze({ kind: "settled-local-qualification" });
    settled.set(handle, { manifestHash: manifest.manifestHash, clients: [...clients.values()], evidence, steps });
    const proof = readSettledQualification(handle); const observed = evaluateQualificationRun(manifest, evidence);
    return { settled: handle, evidence, report: { ...observed,
      execution: { kind: manifest.execution.kind, steps: proof.steps, instances: proof.instances, drainCoverage: "this-run-native-process-groups-only" },
      blockers: observed.blockers.filter((item) => item.code !== "QUALIFICATION_RUNNER_DRAIN_UNPROVEN") } };
  } catch (error) { clients.forEach(abandonClientProcess); throw error; }
}
