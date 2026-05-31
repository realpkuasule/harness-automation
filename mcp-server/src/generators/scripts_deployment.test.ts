import { describe, it, expect } from "vitest";
import { generateScriptsDeployment } from "./scripts_deployment.js";

describe("generateScriptsDeployment", () => {
  it("returns task.py and TASK.json when includeTaskBoard is true", () => {
    const result = generateScriptsDeployment({ includeTaskBoard: true, includeChangelog: false });
    expect(result.scripts.length).toBe(1);
    expect(result.scripts[0].path).toBe("scripts/task.py");
    expect(result.scripts[0].executable).toBe(true);
    expect(result.dataFiles.length).toBe(1);
    expect(result.dataFiles[0].path).toBe("TASK.json");
    // Verify TASK.json template structure
    const parsed = JSON.parse(result.dataFiles[0].content);
    expect(parsed).toEqual({ tasks: [] });
  });

  it("returns changelog.py and CHANGELOG.jsonl when includeChangelog is true", () => {
    const result = generateScriptsDeployment({ includeTaskBoard: false, includeChangelog: true });
    expect(result.scripts.length).toBe(1);
    expect(result.scripts[0].path).toBe("scripts/changelog.py");
    expect(result.scripts[0].executable).toBe(true);
    expect(result.dataFiles.length).toBe(1);
    expect(result.dataFiles[0].path).toBe("CHANGELOG.jsonl");
    expect(result.dataFiles[0].content).toBe("");
  });

  it("returns both when both flags are true (default)", () => {
    const result = generateScriptsDeployment();
    expect(result.scripts.length).toBe(2);
    expect(result.dataFiles.length).toBe(2);
  });

  it("script content is non-empty and contains python shebang", () => {
    const result = generateScriptsDeployment();
    for (const script of result.scripts) {
      expect(script.content.length).toBeGreaterThan(0);
      expect(script.content).toContain("#!/usr/bin/env python3");
    }
  });

  it("returns empty when both flags are false", () => {
    const result = generateScriptsDeployment({ includeTaskBoard: false, includeChangelog: false });
    expect(result.scripts.length).toBe(0);
    expect(result.dataFiles.length).toBe(0);
  });

  it("script paths use forward slashes for cross-platform compatibility", () => {
    const result = generateScriptsDeployment();
    for (const script of result.scripts) {
      expect(script.path).not.toContain("\\");
    }
  });
});
