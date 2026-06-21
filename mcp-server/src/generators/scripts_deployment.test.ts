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
    // Verify TASK.json template structure with rich fields
    const parsed = JSON.parse(result.dataFiles[0].content);
    expect(parsed.meta).toBeDefined();
    expect(parsed.meta.description).toContain("Task board");
    expect(parsed.tasks).toBeInstanceOf(Array);
    expect(parsed.tasks.length).toBe(1);
    const t = parsed.tasks[0];
    expect(t.id).toBe("P0-0");
    expect(t.phase).toBe(0);
    expect(t.status).toBe("_template_");
    expect(t.priority).toBe("medium");
    expect(t.blockedBy).toEqual([]);
    expect(t.blocks).toEqual([]);
    expect(t.relatedFiles).toEqual([]);
    expect(t.createdAt).toBeDefined();
    expect(t.updatedAt).toBeDefined();
    expect(t.createdBy).toBe("harness-automation");
    expect(t.updatedBy).toBe("harness-automation");
  });

  it("returns changelog.py and CHANGELOG.jsonl when includeChangelog is true", () => {
    const result = generateScriptsDeployment({ includeTaskBoard: false, includeChangelog: true });
    expect(result.scripts.length).toBe(1);
    expect(result.scripts[0].path).toBe("scripts/changelog.py");
    expect(result.scripts[0].executable).toBe(true);
    expect(result.dataFiles.length).toBe(1);
    expect(result.dataFiles[0].path).toBe("CHANGELOG.jsonl");
    // CHANGELOG.jsonl contains a valid JSONL entry (one line with a milestone)
    const content = result.dataFiles[0].content;
    expect(content).toBeTruthy();
    expect(content.trim()).toBeTruthy();
    const parsed = JSON.parse(content.trim());
    expect(parsed.type).toBe("milestone");
    expect(parsed.phase).toBe(0);
    expect(parsed.timestamp).toBeDefined();
    expect(parsed.description).toContain("CHANGELOG.jsonl");
  });

  it("returns both when both flags are true (default)", () => {
    const result = generateScriptsDeployment();
    expect(result.scripts.length).toBe(2);
    expect(result.dataFiles.length).toBe(2);
    const paths = result.dataFiles.map((d) => d.path);
    expect(paths).toContain("TASK.json");
    expect(paths).toContain("CHANGELOG.jsonl");
    // Both data files have content
    for (const df of result.dataFiles) {
      expect(df.content).toBeTruthy();
    }
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
