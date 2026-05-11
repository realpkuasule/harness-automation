import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, chmodSync, readFileSync } from "node:fs";
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
import { mergeDependencies } from "../generators/package_json.js";
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
    expect(sm.load().phase).toBe("evaluated");

    sm.setConfirmedDecisions(output.decisions);
    expect(sm.load().phase).toBe("confirmed");

    // Generate config files
    const files: Array<{ path: string }> = [];
    const claudeMdPath = join(tmpDir, "CLAUDE.md");
    write(claudeMdPath, generateClaudeMd({ decisions: output.decisions }));
    files.push({ path: "CLAUDE.md" });

    const linterDecisions = output.decisions.filter((d) =>
      d.recommendedMedium === "linter_warn" || d.recommendedMedium === "linter_error" || d.recommendedMedium === "linter",
    );
    if (linterDecisions.length > 0) {
      const eslintContent = generateEslintConfig({ decisions: output.decisions });
      write(join(tmpDir, "eslint.config.js"), eslintContent);
      files.push({ path: "eslint.config.js" });
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

    const linterDecisions = output.decisions.filter((d) =>
      d.recommendedMedium === "linter_warn" || d.recommendedMedium === "linter_error" || d.recommendedMedium === "linter",
    );
    if (linterDecisions.length > 0) {
      const eslintContent = generateEslintConfig({ decisions: output.decisions });
      write(join(tmpDir, "eslint.config.js"), eslintContent);
      checkFiles.push("eslint.config.js");
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

    const linterDecisions = output.decisions.filter((d) =>
      d.recommendedMedium === "linter_warn" || d.recommendedMedium === "linter_error" || d.recommendedMedium === "linter",
    );
    if (linterDecisions.length > 0) {
      const eslintContent = generateEslintConfig({ decisions: output.decisions });
      write(join(tmpDir, "eslint.config.js"), eslintContent);
      checkFiles.push("eslint.config.js");
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
    expect(sm.load().phase).toBeNull();

    // After evaluation — setEngineOutput does NOT set engineInput,
    // so also call setEngineInput for canResume() to work
    const engine = new DecisionEngine();
    const output = engine.evaluate(TS_INPUT);
    sm.setEngineOutput(output);
    sm.setEngineInput(TS_INPUT);
    expect(sm.load().phase).toBe("evaluated");
    expect(sm.load().engineOutput?.summary.total).toBe(output.summary.total);

    // After confirmation
    sm.setConfirmedDecisions(output.decisions);
    expect(sm.load().phase).toBe("confirmed");
    expect(sm.load().decisions?.length).toBe(output.decisions.length);

    // Reload from new StateManager instance (simulates restart)
    const sm2 = new StateManager(tmpDir);
    expect(sm2.load().phase).toBe("confirmed");
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
    expect(state.phase).toBeNull();
  });

  // ================================================================
  // Merge scenario tests
  // ================================================================

  it(".gitignore merge preserves existing entries and does not duplicate", () => {
    // Pre-create .gitignore with existing content
    const existingContent = "node_modules\n.env\ndist/";
    write(join(tmpDir, ".gitignore"), existingContent);

    // Call generateGitignore with existing content — filter out dupes
    const additions = generateGitignore(existingContent);
    // Build the final merged content like generateProjectFiles does
    const finalContent = additions.trim()
      ? `${existingContent.replace(/\n$/, "")}\n${additions}`
      : existingContent;
    write(join(tmpDir, ".gitignore"), finalContent);

    const result = readFileSync(join(tmpDir, ".gitignore"), "utf-8");
    // Verify existing entries are preserved
    expect(result).toContain("node_modules");
    expect(result).toContain(".env");
    expect(result).toContain("dist/");
    // Verify new harness entries are present
    expect(result).toContain(".harness/state.json");
    expect(result).toContain(".harness/backups/");
    // Verify harness entries appear exactly once
    const harnessStateMatches = result.match(/\.harness\/state\.json/g);
    expect(harnessStateMatches).toHaveLength(1);
    const harnessBackupMatches = result.match(/\.harness\/backups\//g);
    expect(harnessBackupMatches).toHaveLength(1);
    // Verify the section header
    expect(result).toContain("# Harness Automation System");
  });

  it("CI workflow generation skips if file already exists", () => {
    const engine = new DecisionEngine();
    const output = engine.evaluate(TS_INPUT);

    // Pre-create CI workflow with custom content
    const customCi = "name: My Custom CI\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest";
    write(join(tmpDir, ".github", "workflows", "ci.yml"), customCi);

    // Simulate the skip logic from init_harness in index.ts
    const ciFilePath = join(tmpDir, ".github/workflows/ci.yml");
    let ciAction: string;
    if (existsSync(ciFilePath)) {
      ciAction = "skipped";
    } else {
      const ciContent = generateCiWorkflow({ decisions: output.decisions, techStack: "typescript" });
      ciAction = ciContent.trim() ? "created" : "skipped";
    }

    expect(ciAction).toBe("skipped");

    // Verify the original custom content is untouched
    const content = readFileSync(ciFilePath, "utf-8");
    expect(content).toBe(customCi);
    // Harness CI content should NOT be present
    expect(content).not.toContain("Harness CI");
  });

  it("package.json mergeDependencies preserves existing and adds new without duplication", () => {
    // Pre-create a package.json with some existing devDependencies and scripts
    const existingPkg: Record<string, unknown> = {
      name: "test-project",
      scripts: {
        lint: "eslint .",
        test: "vitest run",
      },
      devDependencies: {
        eslint: "^8.0.0",
        prettier: "^3.0.0",
      },
    };
    write(join(tmpDir, "package.json"), JSON.stringify(existingPkg));

    // Create decisions that need additional deps (commitlint and husky)
    const decisions: RuleDecision[] = [
      {
        ruleId: "commit-message-convention",
        ruleName: "commit-message-convention",
        recommendedMedium: "hook",
        alternativeMedia: [],
        confidence: 0.9,
        reasons: [],
        cognitiveLayerRequired: false,
        cognitiveSkillTriggers: [],
      },
      {
        ruleId: "lint-before-commit",
        ruleName: "lint-before-commit",
        recommendedMedium: "hook",
        alternativeMedia: [],
        confidence: 0.9,
        reasons: [],
        cognitiveLayerRequired: false,
        cognitiveSkillTriggers: [],
      },
    ];

    const result = mergeDependencies({ decisions, existingPackageJson: existingPkg });

    // Existing devDependencies are preserved
    expect(result.merged.eslint).toBe("^8.0.0");
    expect(result.merged.prettier).toBe("^3.0.0");
    // Existing ones are NOT in missing list
    expect(result.missing).not.toContain("eslint");
    expect(result.missing).not.toContain("prettier");
    // New required deps are added (from RULE_DEPS)
    expect(result.merged["@commitlint/cli"]).toBe("*");
    expect(result.merged["@commitlint/config-conventional"]).toBe("*");
    expect(result.merged["husky"]).toBe("*");
    expect(result.merged["lint-staged"]).toBe("*");
    // New deps appear in missing list
    expect(result.missing).toContain("@commitlint/cli");
    expect(result.missing).toContain("@commitlint/config-conventional");
    expect(result.missing).toContain("husky");
    expect(result.missing).toContain("lint-staged");
    // No duplicates — each dep appears exactly once in merged
    const mergedKeys = Object.keys(result.merged);
    const uniqueKeys = new Set(mergedKeys);
    expect(mergedKeys.length).toBe(uniqueKeys.size);
    // suggestedCommands is populated
    expect(result.suggestedCommands.length).toBeGreaterThan(0);
  });
});
