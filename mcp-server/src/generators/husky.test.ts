import { describe, it, expect } from "vitest";
import { generateHuskyConfig } from "./husky.js";
import type { RuleDecision } from "../types.js";

function decision(ruleName: string, medium: RuleDecision["recommendedMedium"]): RuleDecision {
  return {
    ruleId: "R000",
    ruleName,
    recommendedMedium: medium,
    alternativeMedia: [],
    confidence: 0.8,
    reasons: [],
    cognitiveLayerRequired: false,
    cognitiveSkillTriggers: [],
  };
}

describe("generateHuskyConfig", () => {
  // 14. 无 linter 和 hook rules
  it("returns empty object when no relevant rules", () => {
    const result = generateHuskyConfig({ decisions: [decision("no-console-log", "settings.json")] });
    expect(result).toEqual({});
  });

  // 15. 有 linter rules（recommendedMedium === "linter"）
  it("adds eslint to pre-commit when linter rules exist", () => {
    const result = generateHuskyConfig({
      decisions: [decision("no-console-log", "linter")],
    });
    expect(result["pre-commit"]).toBeDefined();
    expect(result["pre-commit"]).toContain("npx eslint . --max-warnings=0");
  });

  // 16. 有 hook rules
  it("creates both pre-commit and commit-msg for hook rules", () => {
    const result = generateHuskyConfig({
      decisions: [decision("commit-message-convention", "hook")],
    });
    expect(result["pre-commit"]).toBeDefined();
    expect(result["commit-msg"]).toBeDefined();
    expect(result["commit-msg"]).toContain("npx --no -- commitlint --edit $1");
  });

  // 17. existingHooks 合并
  it("preserves existing hooks and adds missing ones", () => {
    const result = generateHuskyConfig({
      decisions: [decision("no-console-log", "linter")],
      existingHooks: { "pre-commit": "#!/bin/sh\necho custom" },
    });
    expect(result["pre-commit"]).toBe("#!/bin/sh\necho custom");
    expect(result["commit-msg"]).toBeDefined();
  });

  // 18. 返回全部 hooks 的 shebang 格式
  it("all hooks have proper shebang and husky setup", () => {
    const result = generateHuskyConfig({
      decisions: [decision("no-console-log", "linter"), decision("commit-message-convention", "hook")],
    });
    for (const script of Object.values(result)) {
      expect(script.startsWith("#!/bin/sh")).toBe(true);
      expect(script).toContain('_/husky.sh');
    }
  });
});
