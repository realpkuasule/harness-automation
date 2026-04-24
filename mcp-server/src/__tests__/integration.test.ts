import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { DecisionEngine } from "../engine.js";
import { StateManager } from "../state.js";
import { generateClaudeMd } from "../generators/claude_md.js";
import { generateEslintConfig } from "../generators/eslint.js";
import { generateSettingsJson } from "../generators/settings_json.js";
import { generateGitignore } from "../generators/gitignore.js";
import { generateCiWorkflow } from "../generators/ci.js";
import { generateHuskyConfig } from "../generators/husky.js";
import { SetupValidator } from "../validators/setup_validator.js";
import type { RuleDecision } from "../types.js";

function write(path: string, content: string) {
  const parent = dirname(path);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  writeFileSync(path, content, "utf-8");
}

describe("integration: full harness flow", () => {
  let tmpDir: string;
  const TS_INPUT = {
    projectDir: "",
    projectPhase: "early" as const,
    teamSize: "small" as const,
    techStack: ["typescript" as const],
  };
  const PY_INPUT = {
    projectDir: "",
    projectPhase: "growth" as const,
    teamSize: "medium" as const,
    techStack: ["python" as const],
  };
  const GO_INPUT = {
    projectDir: "",
    projectPhase: "mature" as const,
    teamSize: "large" as const,
    techStack: ["go" as const, "generic" as const],
  };

  beforeEach(() => {
    tmpDir = join(tmpdir(), `harness-int-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    TS_INPUT.projectDir = tmpDir;
    PY_INPUT.projectDir = tmpDir;
    GO_INPUT.projectDir = tmpDir;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ================================================================
  // Full flow: evaluate → confirm → generate → validate
  // ================================================================

  it("completes full flow for TypeScript project", () => {
    const engine = new DecisionEngine();
    const output = engine.evaluate(TS_INPUT);
    expect(output.decisions.length).toBeGreaterThan(0);

    const sm = new StateManager(tmpDir);
    sm.setEngineInput(TS_INPUT);
    sm.setEngineOutput(output);
    expect(sm.load().status).toBe("evaluated");

    sm.setConfirmedDecisions(output.decisions);
    expect(sm.load().status).toBe("confirmed");

    // Generate config files
    const files: Array<{ path: string }> = [];
    const claudeMdPath = join(tmpDir, "CLAUDE.md");
    write(claudeMdPath, generateClaudeMd({ decisions: output.decisions }));
    files.push({ path: "CLAUDE.md" });

    const linterDecisions = output.decisions.filter((d) => d.recommendedMedium === "linter");
    if (linterDecisions.length > 0) {
      write(join(tmpDir, "eslint.config.json"), generateEslintConfig({ decisions: output.decisions }));
      files.push({ path: "eslint.config.json" });
    }

    write(join(tmpDir, ".claude", "settings.json"), generateSettingsJson({ decisions: output.decisions }));
    files.push({ path: ".claude/settings.json" });

    const gitignoreAdditions = generateGitignore();
    if (gitignoreAdditions.trim()) {
      write(join(tmpDir, ".gitignore"), gitignoreAdditions);
      files.push({ path: ".gitignore" });
    }

    write(join(tmpDir, "package.json"), JSON.stringify({ devDependencies: { eslint: "^8.0.0" } }));
    files.push({ path: "package.json" });

    // Validate only generated files
    const validator = new SetupValidator({ projectDir: tmpDir, checkFiles: files.map((f) => f.path) });
    const result = validator.validate();
    expect(result.summary.passed).toBe(true);
  });

  it("completes full flow for Python project", () => {
    const engine = new DecisionEngine();
    const output = engine.evaluate(PY_INPUT);
    expect(output.decisions.length).toBeGreaterThan(0);

    const sm = new StateManager(tmpDir);
    sm.setEngineInput(PY_INPUT);
    sm.setEngineOutput(output);
    sm.setConfirmedDecisions(output.decisions);

    const checkFiles = ["CLAUDE.md", ".claude/settings.json", "package.json"];
    write(join(tmpDir, "CLAUDE.md"), generateClaudeMd({ decisions: output.decisions }));
    write(join(tmpDir, ".claude", "settings.json"), generateSettingsJson({ decisions: output.decisions }));

    const linterDecisions = output.decisions.filter((d) => d.recommendedMedium === "linter");
    if (linterDecisions.length > 0) {
      write(join(tmpDir, "eslint.config.json"), generateEslintConfig({ decisions: output.decisions }));
      checkFiles.push("eslint.config.json");
    }

    const gitignoreAdditions = generateGitignore();
    if (gitignoreAdditions.trim()) {
      write(join(tmpDir, ".gitignore"), gitignoreAdditions);
      checkFiles.push(".gitignore");
    }

    write(join(tmpDir, "package.json"), JSON.stringify({ devDependencies: {} }));

    const validator = new SetupValidator({ projectDir: tmpDir, checkFiles });
    const result = validator.validate();
    expect(result.summary.passed).toBe(true);
  });

  it("completes full flow for Go project", () => {
    const engine = new DecisionEngine();
    const output = engine.evaluate(GO_INPUT);
    expect(output.decisions.length).toBeGreaterThan(0);

    const sm = new StateManager(tmpDir);
    sm.setEngineInput(GO_INPUT);
    sm.setEngineOutput(output);
    sm.setConfirmedDecisions(output.decisions);

    const checkFiles = ["CLAUDE.md", ".claude/settings.json", "package.json"];
    write(join(tmpDir, "CLAUDE.md"), generateClaudeMd({ decisions: output.decisions }));
    write(join(tmpDir, ".claude", "settings.json"), generateSettingsJson({ decisions: output.decisions }));

    const linterDecisions = output.decisions.filter((d) => d.recommendedMedium === "linter");
    if (linterDecisions.length > 0) {
      write(join(tmpDir, "eslint.config.json"), generateEslintConfig({ decisions: output.decisions }));
      checkFiles.push("eslint.config.json");
    }

    const gitignoreAdditions = generateGitignore();
    if (gitignoreAdditions.trim()) {
      write(join(tmpDir, ".gitignore"), gitignoreAdditions);
      checkFiles.push(".gitignore");
    }

    write(join(tmpDir, "package.json"), JSON.stringify({ devDependencies: {} }));

    const validator = new SetupValidator({ projectDir: tmpDir, checkFiles });
    const result = validator.validate();
    expect(result.summary.passed).toBe(true);
  });

  // ================================================================
  // init_harness-style flow (with Husky + CI)
  // ================================================================

  it("generates Husky hooks and CI workflow alongside core config", () => {
    const engine = new DecisionEngine();
    const output = engine.evaluate(TS_INPUT);

    // Core files
    write(join(tmpDir, "CLAUDE.md"), generateClaudeMd({ decisions: output.decisions }));
    write(join(tmpDir, ".claude", "settings.json"), generateSettingsJson({ decisions: output.decisions }));
    write(join(tmpDir, "package.json"), JSON.stringify({ devDependencies: { husky: "^9.0.0", eslint: "^8.0.0" } }));
    write(join(tmpDir, ".gitignore"), generateGitignore());

    // Husky hooks
    const huskyHooks = generateHuskyConfig({ decisions: output.decisions });
    for (const [hookName, hookContent] of Object.entries(huskyHooks)) {
      write(join(tmpDir, ".husky", hookName), hookContent);
      chmodSync(join(tmpDir, ".husky", hookName), 0o755);
    }

    // CI workflow
    const ciContent = generateCiWorkflow({ decisions: output.decisions, techStack: "typescript" });
    if (ciContent.trim()) {
      write(join(tmpDir, ".github", "workflows", "ci.yml"), ciContent);
    }

    // Verify files exist
    expect(existsSync(join(tmpDir, ".husky", "pre-commit"))).toBe(true);
    expect(existsSync(join(tmpDir, ".husky", "commit-msg"))).toBe(true);
    expect(existsSync(join(tmpDir, ".github", "workflows", "ci.yml"))).toBe(true);

    // Validate only init_harness-style files
    const checkFiles = [
      "CLAUDE.md", ".claude/settings.json", ".gitignore",
      ".husky/pre-commit", ".husky/commit-msg", ".github/workflows/ci.yml",
      "package.json",
    ];
    const validator = new SetupValidator({ projectDir: tmpDir, checkFiles });
    const result = validator.validate();
    expect(result.summary.passed).toBe(true);
  });

  // ================================================================
  // State persistence across steps
  // ================================================================

  it("persists state across multiple operations", () => {
    const sm = new StateManager(tmpDir);

    // Initial state
    expect(sm.load().status).toBeNull();

    // After evaluation — setEngineOutput does NOT set engineInput,
    // so also call setEngineInput for canResume() to work
    const engine = new DecisionEngine();
    const output = engine.evaluate(TS_INPUT);
    sm.setEngineOutput(output);
    sm.setEngineInput(TS_INPUT);
    expect(sm.load().status).toBe("evaluated");
    expect(sm.load().engineOutput?.summary.total).toBe(output.summary.total);

    // After confirmation
    sm.setConfirmedDecisions(output.decisions);
    expect(sm.load().status).toBe("confirmed");
    expect(sm.load().decisions?.length).toBe(output.decisions.length);

    // Reload from new StateManager instance (simulates restart)
    const sm2 = new StateManager(tmpDir);
    expect(sm2.load().status).toBe("confirmed");
    expect(sm2.canResume()).toBe(true);
  });

  // ================================================================
  // Error handling
  // ================================================================

  it("handles evaluate with no tech stack gracefully", () => {
    const engine = new DecisionEngine();
    const output = engine.evaluate({
      projectDir: tmpDir,
      projectPhase: "early",
      teamSize: "solo",
      techStack: [],
    });

    // Empty tech stack returns zero decisions but is handled gracefully
    expect(output).toBeDefined();
    expect(output.decisions).toEqual([]);
    expect(output.summary.total).toBe(0);
  });

  it("handles generate_config with empty decisions", () => {
    const emptyDecisions: RuleDecision[] = [];

    const claudeMd = generateClaudeMd({ decisions: emptyDecisions });
    expect(claudeMd).toBeTruthy();
    expect(claudeMd.length).toBeGreaterThan(0);

    const settings = generateSettingsJson({ decisions: emptyDecisions });
    expect(settings).toBeTruthy();

    const eslint = generateEslintConfig({ decisions: emptyDecisions });
    expect(eslint).toBeTruthy();
  });

  it("state reflects dryRun — does not persist", () => {
    const engine = new DecisionEngine();
    engine.evaluate({ ...TS_INPUT, dryRun: true });

    // State should not be saved (dry run)
    const stateManager = new StateManager(tmpDir);
    const state = stateManager.load();
    expect(state.status).toBeNull();
  });
});
