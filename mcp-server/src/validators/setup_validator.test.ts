import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SetupValidator } from "./setup_validator.js";

describe("SetupValidator", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `harness-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    mkdirSync(join(tmpDir, ".vscode"), { recursive: true });
    mkdirSync(join(tmpDir, ".husky"), { recursive: true });
    mkdirSync(join(tmpDir, ".github", "workflows"), { recursive: true });
    mkdirSync(join(tmpDir, ".harness"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function write(file: string, content: string) {
    const dir = join(tmpDir, file);
    const parent = dir.substring(0, dir.lastIndexOf("/"));
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
    writeFileSync(join(tmpDir, file), content, "utf-8");
  }

  it("reports missing files as errors", () => {
    const validator = new SetupValidator({ projectDir: tmpDir });
    const result = validator.validate();

    const missing = result.findings.filter((f) => f.type === "error");
    expect(missing.length).toBeGreaterThan(0);
    expect(missing.some((f) => f.message.includes("not found"))).toBe(true);
    expect(result.summary.passed).toBe(false);
  });

  it("passes when all managed files exist with valid content", () => {
    write("CLAUDE.md", "# Project\n## Harness\nSome rules.");
    write("eslint.config.js", "{}");
    write(".claude/settings.json", '{"editor.formatOnSave": true}');
    write(".gitignore", "node_modules\n.harness/state.json\n.harness/backups/");
    write(".husky/pre-commit", "#!/bin/sh\nnpm run lint");
    write(".husky/commit-msg", "#!/bin/sh\nnpx commitlint --edit $1");
    chmodSync(join(tmpDir, ".husky/pre-commit"), 0o755);
    chmodSync(join(tmpDir, ".husky/commit-msg"), 0o755);
    write(".github/workflows/ci.yml", "name: CI\njobs:\n  test:\n    runs-on: ubuntu-latest");
    write("package.json", JSON.stringify({ devDependencies: { eslint: "^8.0.0", husky: "^9.0.0" } }));
    write(".harness/state.json", JSON.stringify({ status: "generated", projectDir: tmpDir }));

    const validator = new SetupValidator({ projectDir: tmpDir });
    const result = validator.validate();

    expect(result.summary.passed).toBe(true);
    expect(result.summary.errors).toBe(0);
  });

  it("detects empty files as warnings", () => {
    write("CLAUDE.md", "");
    write(".harness/state.json", JSON.stringify({ status: "generated", projectDir: tmpDir }));

    const validator = new SetupValidator({ projectDir: tmpDir, checkFiles: ["CLAUDE.md", ".harness/state.json"] });
    const result = validator.validate();

    expect(result.findings.some((f) => f.type === "warning" && f.message.includes("empty"))).toBe(true);
  });

  it("detects JSON syntax errors in .json files", () => {
    write(".harness/state.json", "{ invalid json");

    const validator = new SetupValidator({
      projectDir: tmpDir,
      checkFiles: [".harness/state.json"],
    });
    const result = validator.validate();

    expect(result.findings.some((f) => f.type === "error" && f.message.includes("Syntax error"))).toBe(true);
  });

  it("detects missing husky shebang", () => {
    write(".husky/pre-commit", "npm run lint");
    write(".harness/state.json", JSON.stringify({ status: "generated", projectDir: tmpDir }));

    const validator = new SetupValidator({
      projectDir: tmpDir,
      checkFiles: [".husky/pre-commit", ".harness/state.json"],
    });
    const result = validator.validate();

    expect(result.findings.some((f) => f.type === "warning" && f.message.includes("shebang"))).toBe(true);
  });

  it("detects missing .gitignore entries", () => {
    write(".gitignore", "node_modules");
    write(".harness/state.json", JSON.stringify({ status: "generated", projectDir: tmpDir }));

    const validator = new SetupValidator({
      projectDir: tmpDir,
      checkFiles: [".gitignore", ".harness/state.json"],
    });
    const result = validator.validate();

    expect(result.findings.some((f) => f.type === "info" && f.message.includes(".gitignore"))).toBe(true);
  });

  it("detects missing dev dependencies", () => {
    write("eslint.config.js", "{}");
    write("package.json", JSON.stringify({ devDependencies: {} }));
    write(".harness/state.json", JSON.stringify({ status: "generated", projectDir: tmpDir }));

    const validator = new SetupValidator({
      projectDir: tmpDir,
      checkFiles: ["eslint.config.js", "package.json", ".harness/state.json"],
    });
    const result = validator.validate();

    expect(result.findings.some((f) => f.type === "warning" && f.message.includes("eslint"))).toBe(true);
  });

  it("skips syntax check when skipSyntaxCheck is true", () => {
    write("eslint.config.js", "{ invalid }");
    write(".harness/state.json", JSON.stringify({ status: "generated", projectDir: tmpDir }));

    const validator = new SetupValidator({
      projectDir: tmpDir,
      checkFiles: ["eslint.config.js", ".harness/state.json"],
      skipSyntaxCheck: true,
    });
    const result = validator.validate();

    expect(result.findings.every((f) => !f.message.includes("Syntax error"))).toBe(true);
  });

  it("works with custom checkFiles list", () => {
    write(".harness/state.json", JSON.stringify({ status: "generated", projectDir: tmpDir }));

    const validator = new SetupValidator({
      projectDir: tmpDir,
      checkFiles: [".harness/state.json"],
    });
    const result = validator.validate();

    expect(result.summary.passed).toBe(true);
    expect(result.findings.length).toBe(0);
  });

  // ================================================================
  // P7-12 Enhanced checks
  // ================================================================

  describe("P7-12 enhanced checks", () => {
    it("detects unknown ESLint rule names as warnings", () => {
      // eslint.config.js with a known rule and an unknown rule
      write("eslint.config.js", JSON.stringify({
        rules: {
          "no-console": "error",
          "made-up-rule": "warn",
        },
      }));
      write("package.json", JSON.stringify({ devDependencies: { eslint: "^8.0.0" } }));
      write(".harness/state.json", JSON.stringify({ status: "generated", projectDir: tmpDir }));

      const validator = new SetupValidator({
        projectDir: tmpDir,
        checkFiles: ["eslint.config.js", "package.json", ".harness/state.json"],
      });
      const result = validator.validate();

      const unknownRuleFindings = result.findings.filter(
        (f) => f.message.includes("Unknown ESLint rule") && f.message.includes("made-up-rule"),
      );
      expect(unknownRuleFindings.length).toBeGreaterThan(0);
      expect(unknownRuleFindings[0].type).toBe("warning");
      // Known rules should not trigger the finding
      expect(result.findings.filter((f) => f.message.includes("no-console"))).toHaveLength(0);
    });

    it("does not flag standard ESLint config keys as unknown rules", () => {
      // Full generated ESLint config with framework keys (files, languageOptions, etc.)
      write("eslint.config.js", [
        'const tseslint = require("@typescript-eslint/eslint-plugin");',
        'const tsparser = require("@typescript-eslint/parser");',
        '',
        'module.exports = [',
        '  {',
        '    files: ["**/*.{js,jsx,ts,tsx}"],',
        '    languageOptions: {',
        '      parser: tsparser,',
        '      parserOptions: {',
        '        ecmaVersion: "latest",',
        '        sourceType: "module",',
        '      },',
        '    },',
        '    plugins: {',
        '      "@typescript-eslint": tseslint,',
        '    },',
        '    rules: {',
        '      "no-console": ["warn"],',
        '      "no-debugger": ["error"],',
        '    },',
        '  },',
        '];',
      ].join("\n"));
      write("package.json", JSON.stringify({ devDependencies: { eslint: "^8.0.0" } }));
      write(".harness/state.json", JSON.stringify({ status: "generated", projectDir: tmpDir }));

      const validator = new SetupValidator({
        projectDir: tmpDir,
        checkFiles: ["eslint.config.js", "package.json", ".harness/state.json"],
      });
      const result = validator.validate();

      // Should NOT flag config keys (files, languageOptions, etc.) as unknown rules
      const unknownRuleFindings = result.findings.filter(
        (f) => f.message.includes("Unknown ESLint rule"),
      );
      expect(unknownRuleFindings).toHaveLength(0);
    });

    it("detects @typescript-eslint plugin dependency from eslint config", () => {
      // eslint.config.js referencing @typescript-eslint rules but plugin not in deps
      write("eslint.config.js", `export default { rules: { "@typescript-eslint/no-magic-numbers": "error" } };`);
      write("package.json", JSON.stringify({ devDependencies: { eslint: "^8.0.0" } }));
      write(".harness/state.json", JSON.stringify({ status: "generated", projectDir: tmpDir }));

      const validator = new SetupValidator({
        projectDir: tmpDir,
        checkFiles: ["eslint.config.js", "package.json", ".harness/state.json"],
      });
      const result = validator.validate();

      const pluginFindings = result.findings.filter(
        (f) => f.message.includes("@typescript-eslint/eslint-plugin"),
      );
      expect(pluginFindings.length).toBeGreaterThan(0);
      expect(pluginFindings[0].type).toBe("warning");
    });

    it("does not flag @typescript-eslint plugin when it is installed", () => {
      write("eslint.config.js", `export default { rules: { "@typescript-eslint/naming-convention": "error" } };`);
      write("package.json", JSON.stringify({
        devDependencies: {
          eslint: "^8.0.0",
          "@typescript-eslint/eslint-plugin": "^7.0.0",
        },
      }));
      write(".harness/state.json", JSON.stringify({ status: "generated", projectDir: tmpDir }));

      const validator = new SetupValidator({
        projectDir: tmpDir,
        checkFiles: ["eslint.config.js", "package.json", ".harness/state.json"],
      });
      const result = validator.validate();

      const pluginFindings = result.findings.filter(
        (f) => f.message.includes("@typescript-eslint/eslint-plugin"),
      );
      expect(pluginFindings).toHaveLength(0);
    });

    it("detects lint-staged duplication in package.json and .lintstagedrc.json", () => {
      write("package.json", JSON.stringify({
        devDependencies: { eslint: "^8.0.0" },
        "lint-staged": {
          "*.{js,ts}": ["eslint --fix"],
        },
      }));
      write(".lintstagedrc.json", JSON.stringify({
        "*.{js,ts}": ["eslint --fix"],
      }));
      write(".harness/state.json", JSON.stringify({ status: "generated", projectDir: tmpDir }));

      const validator = new SetupValidator({
        projectDir: tmpDir,
        checkFiles: ["package.json", ".lintstagedrc.json", ".harness/state.json"],
      });
      const result = validator.validate();

      const dupFindings = result.findings.filter(
        (f) => f.message.includes("lint-staged config is duplicated"),
      );
      expect(dupFindings.length).toBeGreaterThan(0);
      expect(dupFindings[0].type).toBe("info");
    });

    it("does not flag lint-staged when only package.json has it", () => {
      write("package.json", JSON.stringify({
        devDependencies: { eslint: "^8.0.0" },
        "lint-staged": {
          "*.{js,ts}": ["eslint --fix"],
        },
      }));
      write(".harness/state.json", JSON.stringify({ status: "generated", projectDir: tmpDir }));

      const validator = new SetupValidator({
        projectDir: tmpDir,
        checkFiles: ["package.json", ".harness/state.json"],
      });
      const result = validator.validate();

      const dupFindings = result.findings.filter(
        (f) => f.message.includes("lint-staged config is duplicated"),
      );
      expect(dupFindings).toHaveLength(0);
    });

    it("does not flag lint-staged when only .lintstagedrc.json has it", () => {
      write("package.json", JSON.stringify({
        devDependencies: { eslint: "^8.0.0" },
      }));
      write(".lintstagedrc.json", JSON.stringify({
        "*.{js,ts}": ["eslint --fix"],
      }));
      write(".harness/state.json", JSON.stringify({ status: "generated", projectDir: tmpDir }));

      const validator = new SetupValidator({
        projectDir: tmpDir,
        checkFiles: ["package.json", ".lintstagedrc.json", ".harness/state.json"],
      });
      const result = validator.validate();

      const dupFindings = result.findings.filter(
        (f) => f.message.includes("lint-staged config is duplicated"),
      );
      expect(dupFindings).toHaveLength(0);
    });
  });
});
