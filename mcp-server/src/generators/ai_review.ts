import type { RuleDecision } from "../types.js";

export interface AiReviewConfig {
  decisions: RuleDecision[];
  provider?: string;
}

/**
 * Generate a GitLab CI job YAML snippet for AI code review.
 * Only includes the job if a decision matches ruleId "R021" or ruleName "ai-code-review".
 */
export function generateAiReviewJob(config: AiReviewConfig): string {
  const hasAiReview = config.decisions.some(
    (d) => d.ruleId === "R021" || d.ruleName === "ai-code-review",
  );

  if (!hasAiReview) {
    return "";
  }

  const lines: string[] = [];

  // Provider comment if specified
  if (config.provider) {
    lines.push(`# AI review provider: ${config.provider}`);
  }

  lines.push("ai-code-review:");
  lines.push("  stage: ai-review");
  lines.push("  image: node:22-alpine");
  lines.push("  rules:");
  lines.push("    - if: $CI_PIPELINE_SOURCE == 'merge_request_event'");
  lines.push("  variables:");
  lines.push("    AI_REVIEW_API_KEY: $AI_REVIEW_API_KEY");
  lines.push("  script:");
  lines.push("    - echo 'Running AI code review...'");
  lines.push("  allow_failure: true");
  lines.push("  artifacts:");
  lines.push("    paths:");
  lines.push("      - ai-review-report.md");
  lines.push("    expire_in: 30 days");

  return lines.join("\n");
}
