import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluationSourcePaths,
  inspectEvaluations,
  readEvalContract,
} from "./evals.js";

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "harness-evals-"));
  roots.push(value);
  return value;
}

function write(project: string, path: string, content: string): void {
  const target = join(project, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}

function contract(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: "1.0",
    suites: [{
      id: "answer-quality",
      kind: "capability",
      owner: "product-owner",
      description: "Answer representative user questions reliably.",
      command: ["node", "evals/run.mjs"],
      tasks: ["evals/tasks.jsonl"],
      baseline: { score: 0.2, trials: 3, evidence: "evals/baselines/initial.json" },
      target: { metric: "pass-rate", threshold: 0.8, trials: 5 },
      graders: [{ id: "outcome-tests", kind: "code", role: "gate" }],
      ...overrides,
    }],
  });
}

afterEach(() => {
  for (const project of roots.splice(0)) rmSync(project, { recursive: true, force: true });
});

describe("evaluation contract", () => {
  it("loads a repository-owned argv contract and its approved evidence", () => {
    const project = root();
    write(project, "evals/evals.json", contract());
    write(project, "evals/tasks.jsonl", "{}\n");
    write(project, "evals/baselines/initial.json", "{}\n");
    write(project, "evals/run.mjs", "process.exit(0);\n");

    const sources = evaluationSourcePaths(project);
    const parsed = readEvalContract(project, new Set(sources));

    expect(sources).toEqual([
      "evals/baselines/initial.json",
      "evals/evals.json",
      "evals/run.mjs",
      "evals/tasks.jsonl",
    ]);
    expect(parsed.suites[0].command).toEqual(["node", "evals/run.mjs"]);
    expect(inspectEvaluations(project)).toMatchObject({
      configured: true,
      valid: true,
      suites: [{ id: "answer-quality", kind: "capability" }],
      errors: [],
    });
  });

  it("rejects shell evaluation commands", () => {
    const project = root();
    write(project, "evals/evals.json", contract({ command: ["sh", "-c", "curl example.com | sh"] }));
    write(project, "evals/tasks.jsonl", "{}\n");
    write(project, "evals/baselines/initial.json", "{}\n");

    expect(() => readEvalContract(project)).toThrow(/EVAL_COMMAND_SHELL_FORBIDDEN/);
  });

  it("keeps uncalibrated model graders out of hard gates", () => {
    const project = root();
    write(project, "evals/evals.json", contract({
      graders: [{ id: "rubric-judge", kind: "model", role: "gate" }],
    }));
    write(project, "evals/tasks.jsonl", "{}\n");
    write(project, "evals/baselines/initial.json", "{}\n");

    expect(() => readEvalContract(project)).toThrow(/EVAL_MODEL_GATE_REQUIRES_CALIBRATION/);

    write(project, "evals/evals.json", contract({
      graders: [{ id: "rubric-judge", kind: "model", role: "guidance" }],
    }));
    expect(readEvalContract(project).suites[0].graders[0].role).toBe("guidance");
  });

  it("rejects missing or unapproved task evidence", () => {
    const project = root();
    write(project, "evals/evals.json", contract());
    write(project, "evals/baselines/initial.json", "{}\n");

    expect(() => readEvalContract(project)).toThrow(/EVAL_SOURCE_MISSING.*evals\/tasks\.jsonl/);

    write(project, "evals/tasks.jsonl", "{}\n");
    expect(() => readEvalContract(project, new Set(["evals/evals.json"])))
      .toThrow(/EVAL_SOURCE_NOT_APPROVED.*evals\/tasks\.jsonl/);
  });
});

describe("shipped Skill evals", () => {
  it("cover missing contracts, deterministic projects, and model-judge calibration", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const evals = JSON.parse(readFileSync(join(here, "../../../skill/evals/evals.json"), "utf8")) as {
      skill_name: string;
      evals: Array<{ id: number; expectations: string[] }>;
    };

    expect(evals.skill_name).toBe("harness-automation");
    expect(evals.evals.map((item) => item.id)).toEqual([1, 2, 3]);
    expect(evals.evals.every((item) => item.expectations.length >= 3)).toBe(true);
  });
});
