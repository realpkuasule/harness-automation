import { describe, it, expect } from "vitest";
import { generateGitignore } from "./gitignore.js";

describe("generateGitignore", () => {
  // 24. 空 existingContent
  it("contains .harness/state.json when no existing content", () => {
    const result = generateGitignore();
    expect(result).toContain(".harness/state.json");
    expect(result).toContain(".harness/backups/");
    expect(result).toContain("Harness Automation System");
  });

  // 25. existing 已含 harness 条目
  it("does not duplicate entries when already present", () => {
    const existing = "# Harness Automation System\n.harness/state.json\n.harness/backups/";
    const result = generateGitignore(existing);
    // Should only return empty lines (separators)
    const nonEmpty = result.split("\n").filter((l) => l.trim() !== "");
    expect(nonEmpty.length).toBe(0);
  });

  // 26. 多次调用输出一致
  it("produces consistent output across multiple calls", () => {
    const a = generateGitignore();
    const b = generateGitignore();
    expect(a).toBe(b);
  });
});
