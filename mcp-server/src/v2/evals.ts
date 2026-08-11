import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import { z } from "zod";
import { safePath } from "./fs.js";
import type { EvalContract, EvaluationDiscovery } from "./types.js";

export const EVAL_CONTRACT_PATH = "evals/evals.json";

const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const SHELLS = new Set(["bash", "cmd", "cmd.exe", "fish", "powershell", "pwsh", "sh", "zsh"]);
const repositoryPath = z.string().min(1).refine(
  (value) => !isAbsolute(value) && !value.split(/[\\/]/u).includes(".."),
  "must be a repository-relative path",
);

const graderSchema = z.object({
  id: z.string().regex(ID),
  kind: z.enum(["code", "model", "human"]),
  role: z.enum(["gate", "guidance"]),
  calibrationEvidence: repositoryPath.optional(),
}).strict();

const baselineSchema = z.object({
  score: z.number().min(0).max(1),
  trials: z.number().int().min(1),
  evidence: repositoryPath,
}).strict();

const hardenedBaselineSchema = baselineSchema.extend({
  origin: z.enum(["pre-implementation", "adoption"]),
}).strict();

const suiteFields = {
  id: z.string().regex(ID),
  kind: z.enum(["capability", "regression"]),
  owner: z.string().trim().min(1),
  description: z.string().trim().min(1),
  command: z.array(z.string().min(1)).min(1),
  tasks: z.array(repositoryPath).min(1).superRefine((paths, context) => {
    if (new Set(paths).size !== paths.length) context.addIssue({ code: "custom", message: "must not contain duplicate paths" });
  }),
  target: z.object({
    metric: z.enum(["pass-rate", "pass-at-1", "pass-all-trials"]),
    threshold: z.number().min(0).max(1),
    trials: z.number().int().min(1),
  }).strict(),
  graders: z.array(graderSchema).min(1),
};

const runnerSourcesSchema = z.array(repositoryPath).min(1).superRefine((paths, context) => {
  if (new Set(paths).size !== paths.length) context.addIssue({ code: "custom", message: "must not contain duplicate paths" });
});

const traceabilitySchema = z.object({
  requirementId: z.string().trim().min(1),
  ruleIds: z.array(z.string().regex(ID)).min(1),
}).strict();
const negativeControlSchema = z.object({
  command: z.array(z.string().min(1)).min(1),
  fixture: repositoryPath,
  expectedExitCode: z.number().int().min(1).max(255),
}).strict();
const legacySuiteSchema = z.object({
  ...suiteFields,
  baseline: baselineSchema.extend({ origin: z.enum(["pre-implementation", "adoption"]).optional() }).strict(),
  runnerSources: runnerSourcesSchema.optional(),
  traceability: z.array(traceabilitySchema).min(1).optional(),
  negativeControl: negativeControlSchema.optional(),
}).strict();
const hardenedSuiteSchema = z.object({
  ...suiteFields,
  baseline: hardenedBaselineSchema,
  runnerSources: runnerSourcesSchema,
  traceability: z.array(traceabilitySchema).min(1),
  negativeControl: negativeControlSchema,
}).strict();

const legacyContractSchema = z.object({
  $schema: z.string().optional(),
  schemaVersion: z.literal("1.0"),
  suites: z.array(legacySuiteSchema).min(1),
}).strict();
const hardenedContractSchema = z.object({
  $schema: z.string().optional(),
  schemaVersion: z.literal("1.1"),
  suites: z.array(hardenedSuiteSchema).min(1),
}).strict();
const contractSchema = z.union([legacyContractSchema, hardenedContractSchema]);

export function evaluationSourcePaths(root: string): string[] {
  const output: string[] = [];
  const visit = (directory: string): void => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        output.push(relative(root, path).replaceAll("\\", "/"));
      }
    }
  };
  visit(safePath(root, "evals"));
  visit(safePath(root, "docs/evals"));
  try {
    for (const suite of readEvalContract(root).suites) output.push(...(suite.runnerSources ?? []));
  } catch {
    // Contract validation produces the actionable error elsewhere; preserve discovery for valid source trees.
  }
  return [...new Set(output)].sort();
}

function referencedPaths(contract: EvalContract): string[] {
  return [...new Set(contract.suites.flatMap((suite) => [
    ...suite.tasks,
    suite.baseline.evidence,
    ...(suite.runnerSources ?? []),
    ...suite.graders.flatMap((grader) => grader.calibrationEvidence ? [grader.calibrationEvidence] : []),
    ...(suite.negativeControl ? [suite.negativeControl.fixture] : []),
  ]))];
}

export function readEvalContract(
  root: string,
  approvedPaths?: ReadonlySet<string>,
): EvalContract {
  const path = safePath(root, EVAL_CONTRACT_PATH);
  if (!existsSync(path)) throw new Error(`EVAL_CONTRACT_REQUIRED: ${EVAL_CONTRACT_PATH}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`EVAL_CONTRACT_INVALID: ${String(error)}`);
  }
  const result = contractSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`EVAL_CONTRACT_INVALID: ${detail}`);
  }
  const contract: EvalContract = result.data.schemaVersion === "1.0"
    ? {
        ...result.data,
        suites: result.data.suites.map((suite) => ({
          ...suite,
          baseline: { ...suite.baseline, origin: suite.baseline.origin ?? "legacy-unknown" as const },
        })),
      }
    : result.data as EvalContract;
  const suiteIds = new Set<string>();
  for (const suite of contract.suites) {
    if (suiteIds.has(suite.id)) throw new Error(`EVAL_SUITE_DUPLICATE: ${suite.id}`);
    suiteIds.add(suite.id);
    if (SHELLS.has(basename(suite.command[0]).toLowerCase())) {
      throw new Error(`EVAL_COMMAND_SHELL_FORBIDDEN: ${suite.id}`);
    }
    if (suite.negativeControl && SHELLS.has(basename(suite.negativeControl.command[0]).toLowerCase())) {
      throw new Error(`EVAL_NEGATIVE_COMMAND_SHELL_FORBIDDEN: ${suite.id}`);
    }
    const requirementIds = new Set<string>();
    const ruleIds = new Set<string>();
    for (const trace of suite.traceability ?? []) {
      if (requirementIds.has(trace.requirementId)) {
        throw new Error(`EVAL_TRACEABILITY_DUPLICATE: ${suite.id}/${trace.requirementId}`);
      }
      requirementIds.add(trace.requirementId);
      for (const ruleId of trace.ruleIds) {
        if (ruleIds.has(ruleId)) throw new Error(`EVAL_RULE_ID_DUPLICATE: ${suite.id}/${ruleId}`);
        ruleIds.add(ruleId);
      }
    }
    const graderIds = new Set<string>();
    for (const grader of suite.graders) {
      if (graderIds.has(grader.id)) throw new Error(`EVAL_GRADER_DUPLICATE: ${suite.id}/${grader.id}`);
      graderIds.add(grader.id);
      if (grader.kind === "model" && grader.role === "gate" && !grader.calibrationEvidence) {
        throw new Error(`EVAL_MODEL_GATE_REQUIRES_CALIBRATION: ${suite.id}/${grader.id}`);
      }
    }
  }
  for (const source of referencedPaths(contract)) {
    if (!existsSync(safePath(root, source))) throw new Error(`EVAL_SOURCE_MISSING: ${source}`);
    if (approvedPaths && !approvedPaths.has(source)) throw new Error(`EVAL_SOURCE_NOT_APPROVED: ${source}`);
  }
  return contract;
}

export function inspectEvaluations(root: string): EvaluationDiscovery {
  const unmanagedCandidates = (() => {
    const manifest = safePath(root, "package.json");
    if (!existsSync(manifest)) return [];
    try {
      const scripts = (JSON.parse(readFileSync(manifest, "utf8")) as { scripts?: Record<string, unknown> }).scripts ?? {};
      return Object.keys(scripts)
        .filter((name) => /^(?:eval|evals|test:eval(?:s)?)$/iu.test(name))
        .map((name) => `npm:.:${name}`)
        .sort();
    } catch {
      return [];
    }
  })();
  if (!existsSync(safePath(root, EVAL_CONTRACT_PATH))) {
    return { configured: false, valid: false, contractPath: null, suites: [], errors: [], unmanagedCandidates };
  }
  try {
    const contract = readEvalContract(root);
    return {
      configured: true,
      valid: true,
      contractPath: EVAL_CONTRACT_PATH,
      suites: contract.suites.map(({ id, kind, command, baseline, runnerSources, traceability, negativeControl }) => ({
        id,
        kind,
        command,
        baseline,
        runnerSources,
        traceability,
        negativeControl,
      })),
      errors: [],
      unmanagedCandidates,
    };
  } catch (error) {
    return {
      configured: true,
      valid: false,
      contractPath: EVAL_CONTRACT_PATH,
      suites: [],
      errors: [error instanceof Error ? error.message : String(error)],
      unmanagedCandidates,
    };
  }
}
