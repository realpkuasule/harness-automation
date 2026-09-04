import { fileURLToPath } from "node:url";
import { loadHumanAuthorization } from "../approval/human.js";
import { resolveRepositoryContext } from "../repository/git.js";
import { hashObject } from "../v2/fs.js";
import { clientCommandSchema } from "./client_process.js";
import { loadQualificationManifest } from "./manifest.js";
import { createQualificationRuntime, observeCoordinationBinding } from "./runtime.js";
import { loadCoordinationConfig } from "./service.js";

function main(): void {
  const [projectRoot, approvalRef, manifestHash, clientId, nonce, ...extra] = process.argv.slice(2);
  if (extra.length || !process.send || !process.connected) throw new Error("QUALIFICATION_SUPERVISOR_REQUIRED");
  clientCommandSchema.parse({ type: "stop", nonce });
  const context = resolveRepositoryContext(projectRoot); const state = loadHumanAuthorization(context.commonDir, approvalRef); const scope = state.approval.scope;
  if (scope.kind !== "qualification-run" || scope.manifest?.manifestHash !== manifestHash || scope.manifest.clientId !== clientId || !scope.synthetic) throw new Error("QUALIFICATION_CLIENT_SCOPE_MISMATCH");
  if (state.writesClosed || state.revoked || state.candidates.length || state.attempts.length) throw new Error("QUALIFICATION_RUN_ALREADY_STARTED");
  const manifest = loadQualificationManifest(context.commonDir, manifestHash); if (!manifest.execution) throw new Error("QUALIFICATION_EXECUTION_REQUIRED");
  const binding = observeCoordinationBinding(context.projectDir, loadCoordinationConfig(context.projectDir)?.remote ?? "origin", scope.binding.repositoryId, scope.binding.credentialRef);
  if (hashObject(binding) !== hashObject(scope.binding)) throw new Error("HUMAN_AUTHORIZATION_BINDING_MISMATCH");
  const steps = manifest.execution.steps.filter((step) => step.clientId === clientId); let next = 0; let stopped = false; let quiescent = false;
  const send = (message: object) => process.send!({ ...message, nonce });
  process.on("disconnect", () => process.exit(1));
  process.on("message", async (input: unknown) => {
    try {
      const command = clientCommandSchema.parse(input);
      if (command.nonce !== nonce) throw new Error("QUALIFICATION_PROCESS_PROTOCOL_INVALID");
      if (command.type === "exit") { if (!quiescent) throw new Error("QUALIFICATION_PROCESS_PROTOCOL_INVALID"); process.exit(0); }
      if (command.type === "stop") {
        if (stopped || next !== steps.length) throw new Error("QUALIFICATION_STEPS_INCOMPLETE"); stopped = true;
        if (import.meta.url.endsWith(".ts")) await (await import("./client_source_loader.js")).stopSourceLoader();
        quiescent = true; send({ type: "quiescent" }); return;
      }
      const step = steps[next];
      if (stopped || !step || step.stepId !== command.stepId) throw new Error("QUALIFICATION_STEP_ORDER_MISMATCH");
      const publication = scope.synthetic!.publications.find((item) => item.fixtureId === step.fixtureId && item.transactionId === step.transactionId);
      if (!publication) throw new Error("HUMAN_SYNTHETIC_SCOPE_REQUIRED");
      const controlRef = step.operation === "bootstrap" ? publication.ref : scope.synthetic!.controls[0]?.ref;
      if (!controlRef) throw new Error("COORDINATION_RUN_GENESIS_REQUIRED");
      const runtime = createQualificationRuntime(projectRoot, approvalRef, controlRef);
      const result = step.operation === "bootstrap" ? runtime.bootstrap() : runtime.sourceFixture(step.fixtureId);
      next++; send({ type: "result", stepId: step.stepId, resultHash: hashObject(result) });
    } catch (error) {
      stopped = true; const message = error instanceof Error ? error.message.split(":")[0] : "";
      send({ type: "failure", code: /^[A-Z][A-Z0-9_]{0,127}$/u.test(message) ? message : "QUALIFICATION_CLIENT_FAILED" });
    }
  });
  send({ type: "ready", pid: process.pid, bindingHash: hashObject(binding) });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch { process.exitCode = 1; if (process.connected) process.disconnect(); }
}
