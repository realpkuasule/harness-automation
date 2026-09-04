import { fileURLToPath } from "node:url";
import { loadHumanAuthorization } from "../approval/human.js";
import { resolveRepositoryContext } from "../repository/git.js";
import { hashObject } from "../v2/fs.js";
import { clientCommandSchema } from "./client_process.js";
import { loadQualificationManifest, qualificationSteps } from "./manifest.js";
import { createQualificationRuntime, observeCoordinationBinding } from "./runtime.js";
import { loadCoordinationConfig } from "./service.js";
import { dispatchSyntheticPublication, type SyntheticPreparation } from "./publication.js";
import { sameShaClientFacts, verifyRejectedRestart } from "./same_sha.js";

// Forward fixed codes, including genuine capability gaps, never raw command output or secret-bearing error details.
function failureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^(ENVIRONMENT_BLOCKED: [A-Z][A-Z0-9_]{0,127}|[A-Z][A-Z0-9_]{0,127})(?::|$)/u.exec(message)?.[1] ?? "QUALIFICATION_CLIENT_FAILED";
}

function main(): void {
  const [projectRoot, approvalRef, manifestHash, clientId, nonce, role = "writer", attemptId, ...extra] = process.argv.slice(2);
  if (extra.length || !process.send || !process.connected) throw new Error("QUALIFICATION_SUPERVISOR_REQUIRED");
  if (!["writer", "rejected-recovery"].includes(role) || (role === "writer") === Boolean(attemptId)) throw new Error("QUALIFICATION_PROCESS_ROLE_INVALID");
  clientCommandSchema.parse({ type: "stop", nonce });
  const context = resolveRepositoryContext(projectRoot); const state = loadHumanAuthorization(context.commonDir, approvalRef); const scope = state.approval.scope;
  if (scope.kind !== "qualification-run" || scope.manifest?.manifestHash !== manifestHash || scope.manifest.clientId !== clientId || !scope.synthetic) throw new Error("QUALIFICATION_CLIENT_SCOPE_MISMATCH");
  if (role === "writer" && (state.writesClosed || state.revoked || state.candidates.length || state.attempts.length)) throw new Error("QUALIFICATION_RUN_ALREADY_STARTED");
  const manifest = loadQualificationManifest(context.commonDir, manifestHash); if (!manifest.execution) throw new Error("QUALIFICATION_EXECUTION_REQUIRED");
  const binding = observeCoordinationBinding(context.projectDir, loadCoordinationConfig(context.projectDir)?.remote ?? "origin", scope.binding.repositoryId, scope.binding.credentialRef);
  if (hashObject(binding) !== hashObject(scope.binding)) throw new Error("HUMAN_AUTHORIZATION_BINDING_MISMATCH");
  const steps = qualificationSteps(manifest).filter((step) => step.clientId === clientId); let next = 0; let stopped = false; let quiescent = false; let stopRequested = false;
  let prepared: SyntheticPreparation | undefined; let recoveryDone = false;
  if (role === "rejected-recovery") {
    const facts = sameShaClientFacts(projectRoot, approvalRef, "no-op");
    if (!facts.writesClosed || facts.attemptId !== attemptId) throw new Error("QUALIFICATION_RESTART_EVIDENCE_INVALID");
  }
  const send = (message: object) => process.send!({ ...message, nonce });
  process.on("disconnect", () => process.exit(1));
  process.on("message", async (input: unknown) => {
    let recoverable = false;
    try {
      const command = clientCommandSchema.parse(input);
      if (command.nonce !== nonce) throw new Error("QUALIFICATION_PROCESS_PROTOCOL_INVALID");
      if (command.type === "exit") { if (!quiescent) throw new Error("QUALIFICATION_PROCESS_PROTOCOL_INVALID"); process.exit(0); }
      if (command.type === "stop" || command.type === "abort-stop") {
        if (stopRequested || command.type === "stop" && (stopped || (role === "writer" ? next !== steps.length : !recoveryDone))) throw new Error("QUALIFICATION_STEPS_INCOMPLETE");
        stopRequested = true; stopped = true; prepared = undefined;
        if (import.meta.url.endsWith(".ts")) await (await import("./client_source_loader.js")).stopSourceLoader();
        quiescent = true; send({ type: "quiescent" }); return;
      }
      if (role === "rejected-recovery") {
        if (stopped || recoveryDone || command.type !== "recover-rejected" || command.stepId !== "rejected-restart") throw new Error("QUALIFICATION_PROCESS_ROLE_INVALID");
        recoverable = true;
        const result = verifyRejectedRestart(projectRoot, approvalRef, attemptId!); recoveryDone = true;
        send({ type: "result", stepId: command.stepId, resultHash: hashObject(result) }); return;
      }
      const step = steps[next];
      if (stopped || !step || step.stepId !== command.stepId) throw new Error("QUALIFICATION_STEP_ORDER_MISMATCH");
      const publication = scope.synthetic!.publications.find((item) => item.fixtureId === step.fixtureId && item.transactionId === step.transactionId);
      if (!publication) throw new Error("HUMAN_SYNTHETIC_SCOPE_REQUIRED");
      const controlRef = step.operation === "bootstrap" ? publication.ref : scope.synthetic!.controls[0]?.ref;
      if (!controlRef) throw new Error("COORDINATION_RUN_GENESIS_REQUIRED");
      if (manifest.execution!.kind === "local-same-sha-publication/1") {
        if (command.type === "prepare" && !prepared) {
          recoverable = true;
          prepared = createQualificationRuntime(projectRoot, approvalRef, controlRef).prepareBootstrap();
          send({ type: "result", stepId: step.stepId, resultHash: hashObject(sameShaClientFacts(projectRoot, approvalRef, "prepared")) }); return;
        }
        if (command.type !== "dispatch" || !prepared) throw new Error("QUALIFICATION_STEP_ORDER_MISMATCH");
        recoverable = true;
        const index = manifest.sameShaPublicationNegativeControl!.publications.findIndex((item) => item.clientId === clientId);
        try { dispatchSyntheticPublication(prepared); if (index !== 0) throw new Error("QUALIFICATION_SAME_SHA_EVIDENCE_INVALID"); }
        catch (error) { if (index !== 1 || !(error instanceof Error) || error.message !== "COORDINATION_CAS_NOT_PERFORMED") throw error; }
        const result = sameShaClientFacts(projectRoot, approvalRef, index === 0 ? "updated" : "no-op");
        next++; send({ type: "result", stepId: step.stepId, resultHash: hashObject(result) }); return;
      }
      if (command.type !== "step") throw new Error("QUALIFICATION_STEP_ORDER_MISMATCH");
      recoverable = true;
      const runtime = createQualificationRuntime(projectRoot, approvalRef, controlRef);
      const result = step.operation === "bootstrap" ? runtime.bootstrap() : runtime.sourceFixture(step.fixtureId);
      next++; send({ type: "result", stepId: step.stepId, resultHash: hashObject(result) });
    } catch (error) {
      stopped = true; send({ type: "failure", code: failureCode(error), ...(recoverable ? { recoverable: true } : {}) });
    }
  });
  send({ type: "ready", pid: process.pid, bindingHash: hashObject(binding) });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) {
    const nonce = process.argv[6];
    if (process.send && process.connected && clientCommandSchema.safeParse({ type: "stop", nonce }).success) {
      process.send({ type: "failure", nonce, code: failureCode(error) }, () => process.exit(1));
    } else { process.exitCode = 1; if (process.connected) process.disconnect(); }
  }
}
