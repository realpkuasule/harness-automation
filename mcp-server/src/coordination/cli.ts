import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import type { ParsedArguments } from "../cli.js";
import { loadHumanAuthorization } from "../approval/human.js";
import { canonicalJson, durableWriteOnce, hashObject, safePath } from "../v2/fs.js";
import { evaluateQualificationRun } from "./evidence.js";
import { collectSettledEvidence, runLocalQualification } from "./qualification.js";
import { applyQualificationCleanup, planQualificationCleanup, recoverQualificationCleanup } from "./qualification_cleanup.js";
import { approveQualificationCommand, loadQualificationCliPlan, planQualificationCommand, readQualificationInput, type QualificationCliPlan } from "./qualification_plan.js";
import { observeQualificationRemote, readQualificationRemote } from "./qualification_remote.js";

const commands: Record<string, string[]> = {
  plan: ["input"], approve: ["plan", "approve", "approved-by", "approval-source"], run: ["plan"], "recover-cleanup": ["approval", "attempt"],
};

async function runPlan(plan: QualificationCliPlan) {
  const targets = plan.targets.map((target) => ({ clientId: target.clientId, projectRoot: target.projectRoot,
    approvalRef: plan.packets.find((item) => item.clientId === target.clientId)!.packet.packetHash }));
  // All actual receipts must exist and match the saved scope/packet before the first process starts.
  for (const [index, target] of targets.entries()) {
    const state = loadHumanAuthorization(plan.targets[index].scope.binding.commonDir, target.approvalRef);
    if (hashObject(state.approval.scope) !== hashObject(plan.targets[index].scope) || hashObject(state.approval.packet) !== hashObject(plan.packets[index].packet)) throw new Error("HUMAN_APPROVAL_REQUIRED");
  }
  const runId = randomUUID();
  const reportPath = safePath(plan.managementCommonDir, `harness/plans/qualification-report-${runId}.json`);
  const recovery = targets.map((target, index) => ({ ...target, commonDir: plan.targets[index].scope.binding.commonDir }));
  durableWriteOnce(safePath(plan.managementCommonDir, `harness/plans/qualification-start-${runId}.json`), canonicalJson({ planHash: plan.planHash, reportPath, recovery }), 0o600);
  let execution: unknown = null;
  const cleanup: Array<Awaited<ReturnType<typeof applyQualificationCleanup>>> = [];
  try {
    const result = await runLocalQualification(plan.manifest, targets); execution = result.report.execution;
    for (const ref of plan.manifest.refs) {
      // Every cleanup advances the original ledger; obtain fresh native evidence for the next ref.
      const remote = observeQualificationRemote(result.settled);
      cleanup.push(await applyQualificationCleanup(planQualificationCleanup(remote, ref)));
    }
    const remote = readQualificationRemote(observeQualificationRemote(result.settled));
    const observed = evaluateQualificationRun(plan.manifest, collectSettledEvidence(result.settled));
    const report = { ...observed, executionStatus: "completed", qualificationStatus: "incomplete", qualified: false,
      planHash: plan.planHash, execution, cleanup, remote: remote.observations, recovery,
      blockers: observed.blockers.filter((item) => !["QUALIFICATION_RUNNER_DRAIN_UNPROVEN", "QUALIFICATION_REMOTE_HISTORY_UNPROVEN"].includes(item.code)) };
    durableWriteOnce(reportPath, canonicalJson(report), 0o600);
    return { exitCode: 2, value: { ...report, reportPath } };
  } catch (error) {
    const code = error instanceof Error ? error.message : "QUALIFICATION_EXECUTION_FAILED";
    if (execution === null && error instanceof Error) execution = (error.cause as { qualificationProgress?: unknown } | undefined)?.qualificationProgress ?? null;
    const report = { executionStatus: "failed", qualificationStatus: "incomplete", qualified: false, planHash: plan.planHash,
      error: code, execution, cleanup, recovery, requiredCases: plan.manifest.requiredCases.map((id) => ({ id, status: "not-run" })) };
    try { durableWriteOnce(reportPath, canonicalJson(report), 0o600); }
    catch (recordError) { throw new AggregateError([error, recordError], "QUALIFICATION_EXECUTION_AND_REPORT_FAILED"); }
    return { exitCode: code.startsWith("ENVIRONMENT_BLOCKED:") ? 3 : 1, value: { ...report, reportPath } };
  }
}

export async function runQualificationCommand(projectRoot: string, args: ParsedArguments): Promise<{ exitCode: number; value: unknown }> {
  const action = args.positionals[1]; const names = Object.hasOwn(commands, action) ? commands[action] : undefined;
  if (args.positionals.length !== 2 || !names || args.flags.size ||
      [...args.values].some(([key, values]) => !["project", ...names].includes(key) || values.length !== 1)) throw new Error("QUALIFICATION_ARGUMENTS_INVALID");
  const required = (name: string) => { const value = args.values.get(name)?.[0]; if (!value) throw new Error(`ARGUMENT_REQUIRED: --${name}`); return value; };
  names.forEach(required);
  if (action === "plan") return { exitCode: 0, value: planQualificationCommand(projectRoot, readQualificationInput(resolve(projectRoot, required("input")))) };
  if (action === "recover-cleanup") {
    const approval = z.string().regex(/^[a-f0-9]{64}$/u).parse(required("approval"));
    const attempt = z.string().uuid().parse(required("attempt"));
    const value = await recoverQualificationCleanup(projectRoot, approval, attempt);
    return { exitCode: value.status === "applied" ? 0 : 2, value };
  }
  const plan = loadQualificationCliPlan(projectRoot, resolve(projectRoot, required("plan")));
  if (action === "approve") {
    const value = approveQualificationCommand(plan, required("approve"), required("approved-by"), required("approval-source"));
    return { exitCode: value.executionStatus === "completed" ? 0 : 1, value };
  }
  return runPlan(plan);
}
