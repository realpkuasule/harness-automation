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

const suiteSchema = z.object({
  id: z.string().regex(ID),
  kind: z.enum(["capability", "regression"]),
  owner: z.string().trim().min(1),
  description: z.string().trim().min(1),
  command: z.array(z.string().min(1)).min(1),
  tasks: z.array(repositoryPath).min(1),
  baseline: z.object({
    score: z.number().min(0).max(1),
    trials: z.number().int().min(1),
    evidence: repositoryPath,
  }).strict(),
  target: z.object({
    metric: z.enum(["pass-rate", "pass-at-1", "pass-all-trials"]),
    threshold: z.number().min(0).max(1),
    trials: z.number().int().min(1),
  }).strict(),
  graders: z.array(graderSchema).min(1),
}).strict();

const contractSchema = z.object({
  $schema: z.string().optional(),
  schemaVersion: z.literal("1.0"),
  suites: z.array(suiteSchema).min(1),
}).strict();

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
  return [...new Set(output)].sort();
}

function referencedPaths(contract: EvalContract): string[] {
  return [...new Set(contract.suites.flatMap((suite) => [
    ...suite.tasks,
    suite.baseline.evidence,
    ...suite.graders.flatMap((grader) => grader.calibrationEvidence ? [grader.calibrationEvidence] : []),
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
  const contract = result.data as EvalContract;
  const suiteIds = new Set<string>();
  for (const suite of contract.suites) {
    if (suiteIds.has(suite.id)) throw new Error(`EVAL_SUITE_DUPLICATE: ${suite.id}`);
    suiteIds.add(suite.id);
    if (SHELLS.has(basename(suite.command[0]).toLowerCase())) {
      throw new Error(`EVAL_COMMAND_SHELL_FORBIDDEN: ${suite.id}`);
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
  if (!existsSync(safePath(root, EVAL_CONTRACT_PATH))) {
    return { configured: false, valid: false, contractPath: null, suites: [], errors: [] };
  }
  try {
    const contract = readEvalContract(root);
    return {
      configured: true,
      valid: true,
      contractPath: EVAL_CONTRACT_PATH,
      suites: contract.suites.map(({ id, kind, command }) => ({ id, kind, command })),
      errors: [],
    };
  } catch (error) {
    return {
      configured: true,
      valid: false,
      contractPath: EVAL_CONTRACT_PATH,
      suites: [],
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}
