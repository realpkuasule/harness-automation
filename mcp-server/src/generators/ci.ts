import type { RuleDecision } from "../types.js";

export interface CiConfig {
  decisions: RuleDecision[];
  /** e.g. "typescript" */
  techStack?: string;
  /** Node version for CI matrix */
  nodeVersion?: string;
}

/**
 * Generate a GitHub Actions workflow from rule decisions.
 */
export function generateCiWorkflow(config: CiConfig): string {
  const hasCiRules = config.decisions.some(
    (d) => d.recommendedMedium === "ci",
  );

  if (!hasCiRules && !config.techStack) return "";

  const nodeVer = config.nodeVersion || "18";
  const lines: string[] = [];

  lines.push("name: Harness CI");
  lines.push("");
  lines.push("on:");
  lines.push("  push:");
  lines.push("    branches: [main, master]");
  lines.push("  pull_request:");
  lines.push("    branches: [main, master]");
  lines.push("");
  lines.push("jobs:");
  lines.push("  check:");
  lines.push("    runs-on: ubuntu-latest");
  lines.push("    strategy:");
  lines.push("      matrix:");
  lines.push(`        node-version: [${nodeVer}]`);
  lines.push("");
  lines.push("    steps:");
  lines.push("      - uses: actions/checkout@v4");
  lines.push("      - name: Use Node.js ${{ matrix.node-version }}");
  lines.push("        uses: actions/setup-node@v4");
  lines.push("        with:");
  lines.push("          node-version: ${{ matrix.node-version }}");
  lines.push("          cache: 'npm'");
  lines.push("");
  lines.push("      - run: npm ci");
  lines.push("");

  // ESLint check
  if (config.decisions.some((d) => d.recommendedMedium === "linter")) {
    lines.push("      - name: Lint check");
    lines.push("        run: npx eslint . --max-warnings=0");
    lines.push("");
  }

  // Test
  if (config.decisions.some((d) => d.ruleName === "test-before-merge")) {
    lines.push("      - name: Run tests");
    lines.push("        run: npm test");
    lines.push("");
  }

  // Dependency lock check
  if (config.decisions.some((d) => d.ruleName === "dependency-lock")) {
    lines.push("      - name: Check dependency lock");
    lines.push("        run: |");
    lines.push("          if [ -f package-lock.json ]; then");
    lines.push("            npx lockfile-lint --path package-lock.json --allowed-hosts npm");
    lines.push("          fi");
    lines.push("");
  }

  // Build
  lines.push("      - name: Build check");
  lines.push("        run: npm run build --if-present");
  lines.push("");

  lines.push("      - name: Summary");
  lines.push("        run: echo \"✅ All checks passed\"");

  return lines.join("\n");
}
