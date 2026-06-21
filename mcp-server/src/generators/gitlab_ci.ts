import type { RuleDecision } from "../types.js";
import { generateAiReviewJob } from "./ai_review.js";

export interface GitlabCiConfig {
  decisions: RuleDecision[];
  techStack?: string;
  nodeVersion?: string;
  projectPhase?: string;
  includeAiReview?: boolean;
  image?: string;
}

/**
 * Generate a .gitlab-ci.yml workflow from rule decisions.
 *
 * Logic:
 * - If projectPhase is "prototype" AND no decisions have recommendedMedium "ci", return empty string
 * - Otherwise generate a .gitlab-ci.yml with dynamically built stages array:
 *   * lint stage (when linter_error/linter_warn/linter decisions exist)
 *   * test stage (when R007 test-before-merge exists)
 *   * security stage (when R022 secret-detection exists) — includes GitLab security templates via `include:` directive
 *   * ai-review stage (when R021 ai-code-review exists) — uses generateAiReviewJob output
 *   * build stage (unless prototype phase)
 * - Include: Security/SAST, Security/Secret-Detection, Security/Dependency-Scanning templates
 * - Each stage has appropriate `rules:` for merge_request_event and main branch
 * - Default image: node:22-alpine
 */
export function generateGitlabCiWorkflow(config: GitlabCiConfig): string {
  // Prototype phase: skip CI unless explicitly requested via ci medium rules
  if (
    config.projectPhase === "prototype" &&
    !config.decisions.some((d) => d.recommendedMedium === "ci")
  ) {
    return "";
  }

  const hasLinter = config.decisions.some(
    (d) =>
      d.recommendedMedium === "linter_error" ||
      d.recommendedMedium === "linter_warn" ||
      d.recommendedMedium === "linter",
  );

  const hasTest = config.decisions.some(
    (d) => d.ruleId === "R007" || d.ruleName === "test-before-merge",
  );

  const hasSecurity = config.decisions.some(
    (d) => d.ruleId === "R022" || d.ruleName === "secret-detection",
  );

  const hasAiReview = config.decisions.some(
    (d) => d.ruleId === "R021" || d.ruleName === "ai-code-review",
  );

  const isPrototype = config.projectPhase === "prototype";

  const image = config.image || "node:22-alpine";
  const lines: string[] = [];

  lines.push(`image: ${image}`);
  lines.push("");

  // Build stages array dynamically based on which rules are present
  const stages: string[] = [];
  if (hasLinter) stages.push("lint");
  if (hasTest) stages.push("test");
  if (hasSecurity) stages.push("security");
  if (hasAiReview) stages.push("ai-review");
  if (!isPrototype) stages.push("build");

  // No stages to generate
  if (stages.length === 0) return "";

  lines.push("stages:");
  for (const stage of stages) {
    lines.push(`  - ${stage}`);
  }
  lines.push("");

  // Include GitLab security templates when R022 secret-detection is present
  if (hasSecurity) {
    lines.push("include:");
    lines.push("  - template: Security/SAST.gitlab-ci.yml");
    lines.push("  - template: Security/Secret-Detection.gitlab-ci.yml");
    lines.push("  - template: Security/Dependency-Scanning.gitlab-ci.yml");
    lines.push("");
  }

  // Lint stage (when linter_error/linter_warn/linter decisions exist)
  if (hasLinter) {
    lines.push("lint:");
    lines.push("  stage: lint");
    lines.push("  script:");
    lines.push("    - npm ci");
    lines.push("    - npx eslint .");
    lines.push("  rules:");
    lines.push("    - if: $CI_PIPELINE_SOURCE == 'merge_request_event'");
    lines.push("    - if: $CI_COMMIT_BRANCH == 'main'");
    lines.push("");
  }

  // Test stage (when R007 test-before-merge exists)
  if (hasTest) {
    lines.push("test:");
    lines.push("  stage: test");
    lines.push("  script:");
    lines.push("    - npm ci");
    lines.push("    - npm test");
    lines.push("  rules:");
    lines.push("    - if: $CI_PIPELINE_SOURCE == 'merge_request_event'");
    lines.push("    - if: $CI_COMMIT_BRANCH == 'main'");
    lines.push("");
  }

  // Security stage (when R022 secret-detection exists)
  if (hasSecurity) {
    lines.push("security:");
    lines.push("  stage: security");
    lines.push("  script:");
    lines.push('    - echo "Running security checks..."');
    lines.push("  rules:");
    lines.push("    - if: $CI_PIPELINE_SOURCE == 'merge_request_event'");
    lines.push("    - if: $CI_COMMIT_BRANCH == 'main'");
    lines.push("");
  }

  // AI review stage (when R021 ai-code-review exists) — uses generateAiReviewJob output
  if (hasAiReview) {
    const aiReviewOutput = generateAiReviewJob({ decisions: config.decisions });
    if (aiReviewOutput) {
      lines.push(aiReviewOutput);
      lines.push("");
    }
  }

  // Build stage (unless prototype phase)
  if (!isPrototype) {
    lines.push("build:");
    lines.push("  stage: build");
    lines.push("  script:");
    lines.push("    - npm ci");
    lines.push("    - npm run build");
    lines.push("  rules:");
    lines.push("    - if: $CI_PIPELINE_SOURCE == 'merge_request_event'");
    lines.push("    - if: $CI_COMMIT_BRANCH == 'main'");
    lines.push("");
  }

  return lines.join("\n");
}
