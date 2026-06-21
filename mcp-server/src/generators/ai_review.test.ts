import { describe, it, expect } from "vitest";
import { generateAiReviewJob } from "./ai_review.js";
import type { RuleDecision } from "../types.js";

const baseDecision: RuleDecision = {
  ruleId: "R021",
  ruleName: "ai-code-review",
  recommendedMedium: "ci",
  alternativeMedia: ["hook", "claude.md"],
  confidence: 0.8,
  reasons: ["formalizable"],
  cognitiveLayerRequired: false,
  cognitiveSkillTriggers: [],
};

function makeDecision(overrides?: Partial<RuleDecision>): RuleDecision {
  return { ...baseDecision, ...overrides };
}

describe("generateAiReviewJob", () => {
  it("generates valid YAML CI job snippet with ai-code-review: and stage", () => {
    const result = generateAiReviewJob({
      decisions: [makeDecision()],
    });
    expect(result).toContain("ai-code-review:");
    expect(result).toContain("stage: ai-review");
    expect(result).toContain("image: node:22-alpine");
  });

  it("includes merge request pipeline rules", () => {
    const result = generateAiReviewJob({
      decisions: [makeDecision()],
    });
    expect(result).toContain("merge_request_event");
  });

  it("references CI variable for API key", () => {
    const result = generateAiReviewJob({
      decisions: [makeDecision()],
    });
    expect(result).toContain("$AI_REVIEW_API_KEY");
  });

  it("returns empty string when R021 is not present", () => {
    const result = generateAiReviewJob({
      decisions: [
        makeDecision({ ruleId: "R001", ruleName: "no-console-log" }),
      ],
    });
    expect(result).toBe("");
  });

  it("supports provider parameter in comments", () => {
    const result = generateAiReviewJob({
      decisions: [makeDecision()],
      provider: "openai",
    });
    expect(result).toContain("openai");
  });

  it("has allow_failure: true", () => {
    const result = generateAiReviewJob({
      decisions: [makeDecision()],
    });
    expect(result).toContain("allow_failure: true");
  });

  it("saves artifacts with ai-review-report.md and 30 day expiry", () => {
    const result = generateAiReviewJob({
      decisions: [makeDecision()],
    });
    expect(result).toContain("ai-review-report.md");
    expect(result).toContain("expire_in: 30 days");
  });

  it("matches by ruleName when ruleId is not R021", () => {
    const result = generateAiReviewJob({
      decisions: [
        makeDecision({ ruleId: "R999", ruleName: "ai-code-review" }),
      ],
    });
    expect(result).toContain("ai-code-review:");
  });
});
