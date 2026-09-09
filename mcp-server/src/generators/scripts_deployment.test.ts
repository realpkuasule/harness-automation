import { describe, it, expect } from "vitest";
import { generateScriptsDeployment } from "./scripts_deployment.js";

describe("generateScriptsDeployment", () => {
  it("returns task.py, its shared helper, and the legacy root TASK.json", () => {
    const result = generateScriptsDeployment({ includeTaskBoard: true, includeChangelog: false });
    expect(result.scripts.map((script) => script.path)).toEqual(["scripts/local_tracking.py", "scripts/task.py"]);
    expect(result.scripts.find((script) => script.path === "scripts/task.py")?.executable).toBe(true);
    expect(result.scripts.find((script) => script.path === "scripts/local_tracking.py")?.executable).toBe(false);
    expect(result.dataFiles.map((file) => file.path)).toEqual(["TASK.json"]);
    const parsed = JSON.parse(result.dataFiles[0].content);
    expect(parsed.meta).toBeDefined();
    expect(parsed.meta.description).toContain("Task board");
    expect(parsed.tasks).toBeInstanceOf(Array);
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks[0]).toMatchObject({
      id: "P0-0",
      phase: 0,
      status: "_template_",
      priority: "medium",
      blockedBy: [],
      blocks: [],
      relatedFiles: [],
      createdBy: "harness-automation",
      updatedBy: "harness-automation",
    });
    expect(parsed.tasks[0].createdAt).toBeDefined();
    expect(parsed.tasks[0].updatedAt).toBeDefined();
  });

  it("returns changelog.py, its shared helper, and the legacy root CHANGELOG.jsonl", () => {
    const result = generateScriptsDeployment({ includeTaskBoard: false, includeChangelog: true });
    expect(result.scripts.map((script) => script.path)).toEqual(["scripts/local_tracking.py", "scripts/changelog.py"]);
    expect(result.scripts.find((script) => script.path === "scripts/changelog.py")?.executable).toBe(true);
    expect(result.dataFiles.map((file) => file.path)).toEqual(["CHANGELOG.jsonl"]);
    const parsed = JSON.parse(result.dataFiles[0].content.trim());
    expect(parsed).toMatchObject({ type: "milestone", phase: 0 });
    expect(parsed.timestamp).toBeDefined();
    expect(parsed.description).toContain("CHANGELOG.jsonl");
  });

  it("returns both when both flags are true (default)", () => {
    const result = generateScriptsDeployment();
    expect(result.scripts.map((script) => script.path)).toEqual([
      "scripts/local_tracking.py",
      "scripts/task.py",
      "scripts/changelog.py",
    ]);
    expect(result.dataFiles.map((file) => file.path)).toEqual(["TASK.json", "CHANGELOG.jsonl"]);
    for (const file of result.dataFiles) expect(file.content.trim()).toBeTruthy();
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
