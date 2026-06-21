import type { RuleDecision } from "../types.js";

export interface TeamOnboardingConfig {
  decisions: RuleDecision[];
  projectName?: string;
  gitProvider?: string;
}

/**
 * Generate the content of `scripts/onboard.sh` — an idempotent
 * onboarding script that sets up a developer environment for the project.
 *
 * Sections:
 *   1. set -euo pipefail
 *   2. Color definitions
 *   3. Prerequisite checks (node, npm, git)
 *   4. Dependency installation (npm install)
 *   5. Git hooks setup (husky)
 *   6. Gitleaks install (when R022 is active)
 *   7. Dual-remote config (when gitProvider === "both")
 *   8. Verification (linter + summary)
 *   9. Onboarding complete
 */
export function generateTeamOnboarding(config: TeamOnboardingConfig): string {
  const { decisions, projectName, gitProvider } = config;

  const hasR022 = decisions.some((d) => d.ruleId === "R022");
  const isDualRemote = gitProvider === "both";
  const name = projectName ?? "this project";

  const lines: string[] = [];

  // ---- Shebang & strict mode ----
  lines.push("#!/usr/bin/env bash");
  lines.push("");
  lines.push("set -euo pipefail");
  lines.push("");

  // ---- Color definitions ----
  lines.push("# Color definitions");
  lines.push('GREEN="\\033[0;32m"');
  lines.push('YELLOW="\\033[1;33m"');
  lines.push('RED="\\033[0;31m"');
  lines.push('NC="\\033[0m" # No Color');
  lines.push("");

  // ---- Prerequisite checks ----
  lines.push('echo -e "${GREEN}========================================${NC}"');
  lines.push(`echo -e "\${GREEN}  Onboarding script for ${name}\${NC}"`);
  lines.push('echo -e "${GREEN}========================================${NC}"');
  lines.push("echo");
  lines.push('echo -e "${YELLOW}Checking prerequisites...${NC}"');
  lines.push("");
  lines.push("# Check node");
  lines.push("if ! command -v node &> /dev/null; then");
  lines.push('  echo -e "${RED}node is not installed. Please install Node.js >= 18.${NC}"');
  lines.push("  exit 1");
  lines.push("fi");
  lines.push('echo -e "  ${GREEN}✓${NC} node $(node --version)"');
  lines.push("");
  lines.push("# Check npm");
  lines.push("if ! command -v npm &> /dev/null; then");
  lines.push('  echo -e "${RED}npm is not installed. Please install npm.${NC}"');
  lines.push("  exit 1");
  lines.push("fi");
  lines.push('echo -e "  ${GREEN}✓${NC} npm $(npm --version)"');
  lines.push("");
  lines.push("# Check git");
  lines.push("if ! command -v git &> /dev/null; then");
  lines.push('  echo -e "${RED}git is not installed. Please install git.${NC}"');
  lines.push("  exit 1");
  lines.push("fi");
  lines.push('echo -e "  ${GREEN}✓${NC} git $(git --version | cut -d" " -f3)"');
  lines.push("");
  lines.push('echo -e "${GREEN}All prerequisites satisfied.${NC}"');
  lines.push("echo");

  // ---- Dependency installation ----
  lines.push('echo -e "${YELLOW}Installing dependencies...${NC}"');
  lines.push("");
  lines.push("# Only run npm install if node_modules does not exist (idempotent)");
  lines.push("if [ ! -d \"node_modules\" ]; then");
  lines.push("  npm install");
  lines.push('  echo -e "  ${GREEN}✓${NC} Dependencies installed"');
  lines.push("else");
  lines.push('  echo -e "  ${GREEN}✓${NC} Dependencies already installed (node_modules exists)"');
  lines.push("fi");
  lines.push("echo");

  // ---- Git hooks setup ----
  lines.push('echo -e "${YELLOW}Setting up Git hooks...${NC}"');
  lines.push("");
  lines.push("# Set up husky (idempotent — safe to run multiple times)");
  lines.push("if [ -d \"node_modules/husky\" ]; then");
  lines.push("  npx husky");
  lines.push('  echo -e "  ${GREEN}✓${NC} Git hooks configured"');
  lines.push("else");
  lines.push('  echo -e "  ${YELLOW}⚠${NC} husky not found in node_modules — skipping hook setup"');
  lines.push("fi");
  lines.push("echo");

  // ---- Gitleaks (R022 secret-detection) ----
  if (hasR022) {
    lines.push('echo -e "${YELLOW}Installing Gitleaks...${NC}"');
    lines.push("");
    lines.push("# Check if gitleaks is already installed (idempotent)");
    lines.push("if command -v gitleaks &> /dev/null; then");
    lines.push('  echo -e "  ${GREEN}✓${NC} gitleaks already installed ($(gitleaks version 2>&1 | head -1))"');
    lines.push("else");
    lines.push('  echo -e "  ${YELLOW}⚠${NC} gitleaks is not installed."');
    lines.push("  echo");
    lines.push('  echo "  To install gitleaks:"');
    lines.push('  echo "    macOS:   brew install gitleaks"');
    lines.push('  echo "    Linux:   curl -sSfL https://git.io/gitleaks | sh -s -- -b /usr/local/bin"');
    lines.push('  echo "    Docker:  docker run --rm -v \$(pwd):/repo zricethezav/gitleaks detect"');
    lines.push("  echo");
    lines.push("fi");
    lines.push("echo");
  }

  // ---- Dual remote configuration ----
  if (isDualRemote) {
    lines.push('echo -e "${YELLOW}Configuring dual remote...${NC}"');
    lines.push("");
    lines.push("# Add GitHub remote if not already configured (idempotent)");
    lines.push("if ! git remote get-url github &> /dev/null; then");
    lines.push('  echo -e "  ${YELLOW}⚠${NC} No github remote configured."');
    lines.push('  echo "  Set up your GitHub remote with:"');
    lines.push('  echo "    git remote add github https://github.com/<org>/<repo>.git"');
    lines.push("else");
    lines.push('  echo -e "  ${GREEN}✓${NC} GitHub remote: $(git remote get-url github)"');
    lines.push("fi");
    lines.push("");
    lines.push("# Add GitLab remote if not already configured (idempotent)");
    lines.push("if ! git remote get-url gitlab &> /dev/null; then");
    lines.push('  echo -e "  ${YELLOW}⚠${NC} No gitlab remote configured."');
    lines.push('  echo "  Set up your GitLab remote with:"');
    lines.push('  echo "    git remote add gitlab https://gitlab.com/<org>/<repo>.git"');
    lines.push("else");
    lines.push('  echo -e "  ${GREEN}✓${NC} GitLab remote: $(git remote get-url gitlab)"');
    lines.push("fi");
    lines.push("echo");
  }

  // ---- Verification ----
  lines.push('echo -e "${YELLOW}Verifying setup...${NC}"');
  lines.push("");
  lines.push("# Run linter check if eslint is configured");
  lines.push("if [ -f \"node_modules/.bin/eslint\" ] && [ -f \".eslintrc.js\" -o -f \".eslintrc.cjs\" -o -f \".eslintrc.json\" -o -f \".eslintrc.yaml\" -o -f \".eslintrc.yml\" -o -f \".eslintrc\" ]; then");
  lines.push("  npx eslint --max-warnings=0 . 2>&1 || true");
  lines.push('  echo -e "  ${GREEN}✓${NC} Linter check completed"');
  lines.push("else");
  lines.push('  echo -e "  ${YELLOW}⚠${NC} ESLint not configured — skipping linter check"');
  lines.push("fi");
  lines.push("");
  lines.push("# Summary");
  lines.push('echo -e "${GREEN}========================================${NC}"');
  lines.push('echo -e "${GREEN}  Setup verification complete${NC}"');
  lines.push('echo -e "${GREEN}========================================${NC}"');
  lines.push("echo");

  // ---- Onboarding complete ----
  lines.push('echo -e "${GREEN}✓ Onboarding complete!${NC}"');
  lines.push("echo");
  lines.push('echo "Next steps:"');
  lines.push('echo "  1. Review the project CLAUDE.md for coding conventions"');
  lines.push('echo "  2. Check .husky/ for pre-commit and commit-msg hooks"');
  if (hasR022) {
    lines.push('echo "  3. Verify gitleaks is configured (see .gitleaks.toml)"');
  }
  lines.push('echo "  4. Run \'npm test\' to ensure everything works"');
  lines.push("echo");
  lines.push('echo -e "${GREEN}Happy coding!${NC}"');

  return lines.join("\n") + "\n";
}
