import { describe, it, expect } from "vitest";
import { generateMrTemplate } from "./gitlab_mr_template.js";
import type { RuleDecision } from "../types.js";

const baseDecision: RuleDecision = {
  ruleId: "R001",
  ruleName: "branch-naming",
  recommendedMedium: "hook",
  alternativeMedia: ["claude_md"],
  confidence: 0.9,
  reasons: ["formalizable"],
  cognitiveLayerRequired: false,
  cognitiveSkillTriggers: [],
};

function makeDecision(overrides?: Partial<RuleDecision>): RuleDecision {
  return { ...baseDecision, ...overrides };
}

describe("generateMrTemplate", () => {
  // Test 1: generates template with all required sections
  it("generates template with all required sections", () => {
    const result = generateMrTemplate({
      decisions: [makeDecision({ ruleId: "R001" })],
    });

    expect(result).toContain("## 变更描述");
    expect(result).toContain("## 关联 Issue");
    expect(result).toContain("## 变更内容 Checklist");
    expect(result).toContain("## 测试说明");
    expect(result).toContain("## Screenshots");
    expect(result).toContain("## Review Checklist");
    expect(result).toContain("[ ] Lint 通过");
    expect(result).toContain("[ ] 测试通过");
    expect(result).toContain("[ ] 分支命名符合规范");
    expect(result).toContain("[ ] MR 模板已填写完整");
  });

  // Test 2: includes AI review checkbox when R021 is active
  it("includes AI review checkbox when R021 is active", () => {
    const result = generateMrTemplate({
      decisions: [
        makeDecision({ ruleId: "R001" }),
        makeDecision({ ruleId: "R021", ruleName: "ai-code-review", recommendedMedium: "ci" }),
      ],
    });

    expect(result).toContain("## AI Code Review");
    expect(result).toContain("[ ] AI Code Review 已完成");
    expect(result).toContain("[ ] AI Review 发现的问题已处理");
  });

  // Test 3: includes secret detection checkbox when R022 is active
  it("includes secret detection checkbox when R022 is active", () => {
    const result = generateMrTemplate({
      decisions: [
        makeDecision({ ruleId: "R001" }),
        makeDecision({ ruleId: "R022", ruleName: "secret-detection", recommendedMedium: "hook" }),
      ],
    });

    expect(result).toContain("[ ] 已检查无密钥/凭证泄露");
  });

  // Test 4: produces valid markdown format
  it("produces valid markdown format", () => {
    const result = generateMrTemplate({
      decisions: [makeDecision({ ruleId: "R001" })],
    });

    // All headings should start with ##
    const headingMatches = result.match(/^## /gm);
    expect(headingMatches).not.toBeNull();
    expect(headingMatches!.length).toBeGreaterThanOrEqual(6);

    // Checkboxes use [ ] format
    expect(result.match(/\[ \] /g)).not.toBeNull();

    // No orphaned/unmatched brackets
    const openBrackets = (result.match(/\[/g) || []).length;
    const closeBrackets = (result.match(/\]/g) || []).length;
    expect(openBrackets).toBe(closeBrackets);
  });

  // Test 5: does not include AI review section when R021 is not active
  it("does not include AI review section when R021 is not active", () => {
    const result = generateMrTemplate({
      decisions: [makeDecision({ ruleId: "R001" })],
    });

    expect(result).not.toContain("## AI Code Review");
    expect(result).not.toContain("AI Code Review 已完成");
  });

  // Test 6: does not include secret detection checkbox when R022 is not active
  it("does not include secret detection checkbox when R022 is not active", () => {
    const result = generateMrTemplate({
      decisions: [makeDecision({ ruleId: "R001" })],
    });

    expect(result).not.toContain("已检查无密钥/凭证泄露");
  });

  // Test 7: includes projectName in template when provided
  it("includes projectName in the title when provided", () => {
    const result = generateMrTemplate({
      decisions: [makeDecision({ ruleId: "R001" })],
      projectName: "my-awesome-project",
    });

    expect(result).toContain("my-awesome-project");
  });

  // Test 8: handles empty decisions gracefully
  it("handles empty decisions gracefully", () => {
    const result = generateMrTemplate({
      decisions: [],
    });

    // Still has all required sections
    expect(result).toContain("## 变更描述");
    expect(result).toContain("## Review Checklist");
    expect(result).toContain("[ ] Lint 通过");
  });
});
