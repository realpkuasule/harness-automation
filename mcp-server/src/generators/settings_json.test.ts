import { describe, it, expect } from "vitest";
import { generateSettingsJson } from "./settings_json.js";
import type { RuleDecision } from "../types.js";

function decision(ruleName: string): RuleDecision {
  return {
    ruleId: "R000",
    ruleName,
    recommendedMedium: "settings.json",
    alternativeMedia: [],
    confidence: 0.8,
    reasons: [],
    cognitiveLayerRequired: false,
    cognitiveSkillTriggers: [],
  };
}

describe("generateSettingsJson", () => {
  // 10. 空 decisions
  it("includes formatOnSave and codeActionsOnSave for empty decisions", () => {
    const result = generateSettingsJson({ decisions: [] });
    const parsed = JSON.parse(result);
    expect(parsed["editor.formatOnSave"]).toBe(true);
    expect(parsed["editor.codeActionsOnSave"]["source.fixAll"]).toBe("explicit");
  });

  // 11. consistent-naming rule
  it("adds quoteStyle for consistent-naming rule", () => {
    const result = generateSettingsJson({ decisions: [decision("consistent-naming")] });
    const parsed = JSON.parse(result);
    expect(parsed["typescript.preferences.quoteStyle"]).toBe("single");
  });

  // 12. no-console-log rule
  it("adds autoImports for no-console-log rule", () => {
    const result = generateSettingsJson({ decisions: [decision("no-console-log")] });
    const parsed = JSON.parse(result);
    expect(parsed["typescript.suggest.autoImports"]).toBe(true);
  });

  // 13. 两种规则同时存在
  it("includes both settings when both rules present", () => {
    const result = generateSettingsJson({
      decisions: [decision("consistent-naming"), decision("no-console-log")],
    });
    const parsed = JSON.parse(result);
    expect(parsed["typescript.preferences.quoteStyle"]).toBe("single");
    expect(parsed["typescript.suggest.autoImports"]).toBe(true);
    // Base settings always present
    expect(parsed["editor.formatOnSave"]).toBe(true);
  });
});
