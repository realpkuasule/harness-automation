import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// ============================================================
// Types
// ============================================================

export interface ValidationFinding {
  file: string;
  type: "error" | "warning" | "info";
  message: string;
  fix?: string;
}

export interface ValidationResult {
  projectDir: string;
  findings: ValidationFinding[];
  summary: {
    errors: number;
    warnings: number;
    info: number;
    passed: boolean;
    status: "pass" | "warn" | "fail";
  };
  nextSteps: string[];
}

export interface SetupValidatorOptions {
  projectDir: string;
  /** Files to check (default: check all known files) */
  checkFiles?: string[];
  /** Skip syntax checks */
  skipSyntaxCheck?: boolean;
  /** Skip executable permission checks */
  skipPermissionCheck?: boolean;
}

// ============================================================
// Validator
// ============================================================

const MANAGED_FILES = [
  "CLAUDE.md",
  "eslint.config.js",
  ".claude/settings.json",
  ".gitignore",
  ".husky/pre-commit",
  ".husky/commit-msg",
  ".github/workflows/ci.yml",
  "package.json",
  ".harness/state.json",
];

const HARNESS_GITIGNORE_ENTRIES = [
  ".harness/state.json",
  ".harness/backups/",
];

const REQUIRED_DEV_DEPS: Record<string, string[]> = {
  "eslint.config.js": ["eslint"],
  ".husky/pre-commit": ["husky"],
  ".husky/commit-msg": ["@commitlint/cli"],
  ".github/workflows/ci.yml": [],
  "CLAUDE.md": [],
};

export class SetupValidator {
  private options: SetupValidatorOptions;

  constructor(options: SetupValidatorOptions) {
    this.options = options;
  }

  validate(): ValidationResult {
    const files = this.options.checkFiles ?? MANAGED_FILES;
    const findings: ValidationFinding[] = [];

    for (const file of files) {
      const fullPath = join(this.options.projectDir, file);
      const exists = existsSync(fullPath);

      if (!exists) {
        findings.push({
          file,
          type: "error",
          message: `File not found: ${file}`,
          fix: file === ".harness/state.json"
            ? "Run evaluate_rules first to create state"
            : `Run init_harness or generate_config to create ${file}`,
        });
        continue;
      }

      // Check file is not empty
      try {
        const content = readFileSync(fullPath, "utf-8");
        if (content.trim().length === 0) {
          findings.push({
            file,
            type: "warning",
            message: `File is empty: ${file}`,
          });
        }
      } catch {
        findings.push({
          file,
          type: "error",
          message: `Cannot read file: ${file}`,
        });
        continue;
      }

      // File-type specific checks
      if (!this.options.skipSyntaxCheck) {
        this._checkSyntax(file, fullPath, findings);
      }

      if (!this.options.skipPermissionCheck) {
        this._checkPermissions(file, fullPath, findings);
      }
    }

    // Dependency checks (across files)
    this._checkDependencies(findings);

    const errors = findings.filter((f) => f.type === "error").length;
    const warnings = findings.filter((f) => f.type === "warning").length;
    const info = findings.filter((f) => f.type === "info").length;

    const status: "pass" | "warn" | "fail" = errors > 0 ? "fail" : warnings > 0 ? "warn" : "pass";

    const nextSteps: string[] = [];
    if (errors > 0) {
      const missingFiles = findings.filter((f) => f.type === "error" && f.fix);
      for (const f of missingFiles) {
        if (f.fix) nextSteps.push(f.fix);
      }
      nextSteps.push(`修复 ${errors} 个错误后重新运行 validate_setup 确认`);
    }
    if (warnings > 0) {
      nextSteps.push(`处理 ${warnings} 个警告以提高配置质量`);
    }
    const checkedFiles = this.options.checkFiles ?? MANAGED_FILES;
    const passCount = checkedFiles.filter((f) => {
      try {
        return existsSync(join(this.options.projectDir, f));
      } catch { return false; }
    }).length;
    if (passCount > 0) {
      nextSteps.push(`${passCount} 个文件检查通过，可继续下一步操作`);
    }
    if (status === "pass") {
      nextSteps.push("所有检查通过，Harness 配置完整");
      nextSteps.push("如需调整规则介质，可使用 analyze_rule_adjustments");
    }

    return {
      projectDir: this.options.projectDir,
      findings,
      summary: {
        errors,
        warnings,
        info,
        passed: errors === 0,
        status,
      },
      nextSteps,
    };
  }

  private _checkSyntax(
    file: string,
    fullPath: string,
    findings: ValidationFinding[],
  ): void {
    const ext = file.split(".").pop();

    try {
      const content = readFileSync(fullPath, "utf-8");

      // JSON validation
      if (ext === "json") {
        JSON.parse(content);
      }

      // YAML-ish check for CI workflow
      if (file.endsWith("ci.yml") || file.endsWith(".yaml")) {
        if (!content.includes("name:") && !content.includes("jobs:")) {
          findings.push({
            file,
            type: "warning",
            message: "CI workflow may be incomplete — missing 'name:' or 'jobs:'",
          });
        }
      }

      // Shell script check for husky hooks
      if (file.startsWith(".husky/")) {
        if (!content.startsWith("#!/bin/sh") && !content.startsWith("#!/usr/bin/env")) {
          findings.push({
            file,
            type: "warning",
            message: `Hook script missing shebang: ${file}`,
            fix: `Add #!/bin/sh as first line of ${file}`,
          });
        }
      }

      // .gitignore check
      if (file === ".gitignore") {
        for (const entry of HARNESS_GITIGNORE_ENTRIES) {
          if (!content.includes(entry)) {
            findings.push({
              file,
              type: "info",
              message: `Missing .gitignore entry: ${entry}`,
              fix: `Add "${entry}" to .gitignore`,
            });
          }
        }
      }

      // CLAUDE.md check
      if (file === "CLAUDE.md") {
        if (!content.includes("## Harness")) {
          findings.push({
            file,
            type: "info",
            message: "CLAUDE.md missing Harness section marker",
          });
        }

        // Check for at least one rule section
        const hasRuleSection =
          content.includes("## 认知层规则") ||
          content.includes("## 指引规则") ||
          content.includes("## 软约束规则") ||
          content.includes("## 参考规则");
        if (!hasRuleSection) {
          findings.push({
            file,
            type: "info",
            message: "CLAUDE.md does not contain any rule section",
          });
        }

        // Check title prefix
        if (!content.startsWith("# ")) {
          findings.push({
            file,
            type: "info",
            message: "CLAUDE.md missing title (H1) header",
          });
        }
      }
    } catch (err) {
      findings.push({
        file,
        type: "error",
        message: `Syntax error in ${file}: ${err instanceof Error ? err.message : "unknown error"}`,
        fix: `Fix syntax in ${file}`,
      });
    }
  }

  private _checkPermissions(
    file: string,
    fullPath: string,
    findings: ValidationFinding[],
  ): void {
    // Only hooks need execute permission
    if (!file.startsWith(".husky/")) return;

    try {
      const mode = statSync(fullPath).mode;
      const isExecutable = (mode & 0o111) !== 0;
      if (!isExecutable) {
        findings.push({
          file,
          type: "error",
          message: `Hook is not executable: ${file}`,
          fix: `chmod +x ${fullPath}`,
        });
      }
    } catch {
      // File might have been deleted between exists check and here
      // In that case, it's already flagged
    }
  }

  /** Map ESLint rule name prefixes to npm packages */
  private static readonly ESLINT_PLUGIN_MAP: Record<string, string> = {
    "@typescript-eslint/": "@typescript-eslint/eslint-plugin",
  };

  private _checkDependencies(findings: ValidationFinding[]): void {
    const pkgPath = join(this.options.projectDir, "package.json");
    if (!existsSync(pkgPath)) return;

    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    } catch {
      return;
    }

    const deps: Record<string, string> = {
      ...(pkg.dependencies as Record<string, string> ?? {}),
      ...(pkg.devDependencies as Record<string, string> ?? {}),
    };

    // 1. Static REQUIRED_DEV_DEPS check
    for (const [file, needed] of Object.entries(REQUIRED_DEV_DEPS)) {
      for (const dep of needed) {
        if (!(dep in deps)) {
          const hasFileFor = existsSync(join(this.options.projectDir, file));
          if (hasFileFor) {
            findings.push({
              file: "package.json",
              type: "warning",
              message: `${dep} is required by ${file} but not installed`,
              fix: `npm install --save-dev ${dep}`,
            });
          }
        }
      }
    }

    // 2. Dynamic ESLint config plugin detection
    const eslintConfigPath = join(this.options.projectDir, "eslint.config.js");
    if (existsSync(eslintConfigPath)) {
      try {
        const content = readFileSync(eslintConfigPath, "utf-8");
        for (const [prefix, pkg] of Object.entries(SetupValidator.ESLINT_PLUGIN_MAP)) {
          if (content.includes(prefix) && !(pkg in deps)) {
            findings.push({
              file: "package.json",
              type: "warning",
              message: `${pkg} is required by eslint.config.js (references "${prefix}" rules) but not installed`,
              fix: `npm install --save-dev ${pkg}`,
            });
          }
        }
      } catch {
        // If the config can't be read, skip dynamic check
      }
    }
  }
}
