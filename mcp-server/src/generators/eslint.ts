import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RuleDecision } from "../types.js";

export interface EslintConfig {
  decisions: RuleDecision[];
  existingConfig?: Record<string, unknown>;
  /** Project directory for reading package.json (ESM detection) */
  projectDir?: string;
}

/**
 * Generate ESLint Flat Config from rule decisions.
 * Outputs CommonJS module.exports = [...] or ESM export default [...] format
 * depending on the project's package.json "type" field.
 * Handles merging with existing config.
 * Phase 7: Always generates full framework config (files, languageOptions, plugins).
 * No longer maps no-process-env (rule doesn't exist in standard ESLint).
 * naming-convention includes Prisma aggregate field exemptions.
 */
export function generateEslintConfig(config: EslintConfig): string {
  const linterRules = config.decisions.filter(
    (d) => d.recommendedMedium === "linter_warn" || d.recommendedMedium === "linter_error" || d.recommendedMedium === "linter",
  );

  // Build rules map from decisions
  const rules: Record<string, unknown> = {};

  for (const rule of linterRules) {
    const severity = rule.recommendedMedium === "linter_error" ? "error" : "warn";
    switch (rule.ruleName) {
      case "no-console-log":
        rules["no-console"] = [severity, { allow: ["warn", "error"] }];
        break;
      case "no-direct-fetch":
        rules["no-restricted-imports"] = [severity, { patterns: ["node-fetch"] }];
        break;
      case "no-magic-numbers":
        rules["@typescript-eslint/no-magic-numbers"] = [severity, { ignore: [0, 1], ignoreEnums: true, ignoreReadonlyClassProperties: true }];
        break;
      case "type-annotations":
        rules["@typescript-eslint/explicit-function-return-type"] = [severity];
        break;
      case "consistent-naming":
        rules["@typescript-eslint/naming-convention"] = [
          severity,
          { selector: "variable", format: ["camelCase", "UPPER_CASE"] },
          { selector: "function", format: ["camelCase"] },
          { selector: "class", format: ["PascalCase"] },
          { selector: "interface", format: ["PascalCase"] },
          { selector: "typeAlias", format: ["PascalCase"] },
          { selector: "enum", format: ["PascalCase"] },
          { selector: "property", format: ["camelCase", "PascalCase", "snake_case", "UPPER_CASE"], filter: { regex: "^(_count|_sum|_avg|_min|_max)$", match: false } },
        ];
        break;
      case "no-debugger":
        rules["no-debugger"] = ["error"]; // always error regardless of medium
        break;
      case "no-large-files":
        rules["max-lines"] = [severity, { max: 300 }];
        break;
      default:
        break;
    }
  }

  // Build flat config array: prepend existing configs, then the generated framework object
  const prepend: unknown[] = [];

  // If existingConfig provided, prepend its config objects
  const existing = config.existingConfig;
  if (existing) {
    if (Array.isArray(existing)) {
      prepend.push(...existing);
    } else {
      prepend.push(existing);
    }
  }

  // Detect ESM from project's package.json
  let isEsm = false;
  if (config.projectDir) {
    try {
      const pkgPath = join(config.projectDir, "package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      isEsm = pkg.type === "module";
    } catch {
      // Default to CJS
    }
  }

  // Placeholder for variable references that should appear unquoted in output
  const varRef = (name: string) => `__VAR_REF__${name}__`;

  const frameworkConfig = {
    files: ["**/*.{js,jsx,ts,tsx}"],
    languageOptions: {
      parser: varRef("tsparser"),
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": varRef("tseslint"),
    },
    rules,
  };

  const configArray = [...prepend, frameworkConfig];

  // Build JSON with placeholder replacement to unquote variable references
  const configJson = JSON.stringify(configArray, null, 2)
    .replace(/"__VAR_REF__(\w+)__"/g, "$1");

  if (isEsm) {
    return `import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

export default ${configJson};\n`;
  }

  return `const tseslint = require("@typescript-eslint/eslint-plugin");
const tsparser = require("@typescript-eslint/parser");

module.exports = ${configJson};\n`;
}
