import { describe, it, expect } from "vitest";
import { generateGitlabSettings } from "./gitlab_settings.js";
import type { RuleDecision } from "../types.js";

const baseDecision: RuleDecision = {
  ruleId: "R001",
  ruleName: "protected-branches",
  recommendedMedium: "ci",
  alternativeMedia: ["hook", "claude.md"],
  confidence: 0.9,
  reasons: ["formalizable"],
  cognitiveLayerRequired: false,
  cognitiveSkillTriggers: [],
};

function makeDecision(overrides?: Partial<RuleDecision>): RuleDecision {
  return { ...baseDecision, ...overrides };
}

describe("generateGitlabSettings", () => {
  const config = {
    decisions: [makeDecision()],
    projectUrl: "https://gitlab.com/myorg/myproject",
    projectId: "12345",
  };

  // 1. generates script with curl commands
  it("generates shell script with curl commands referencing GitLab API v4", () => {
    const output = generateGitlabSettings(config);
    expect(output.script.content).toContain("curl");
    expect(output.script.content).toContain("api/v4");
    expect(output.script.path).toBe("scripts/gitlab-configure.sh");
  });

  // 2. generates documentation markdown with setting explanations
  it("generates markdown documentation explaining GitLab settings", () => {
    const output = generateGitlabSettings(config);
    expect(output.doc.content).toContain("# GitLab Settings");
    expect(output.doc.content).toContain("Protected Branches");
    expect(output.doc.content).toContain("Push Rules");
    expect(output.doc.content).toContain("Merge Request Approvals");
    expect(output.doc.content).toContain("Security Features");
    expect(output.doc.path).toBe("docs/gitlab-settings.md");
  });

  // 3. script has proper shebang and set -euo pipefail
  it("script starts with shebang and set -euo pipefail", () => {
    const output = generateGitlabSettings(config);
    const lines = output.script.content.split("\n");
    expect(lines[0].trim()).toBe("#!/bin/bash");
    expect(output.script.content).toContain("set -euo pipefail");
  });

  // 4. script.executable is true
  it("script has executable flag set to true", () => {
    const output = generateGitlabSettings(config);
    expect(output.script.executable).toBe(true);
  });

  // 5. always generates outputs regardless of decisions being empty
  it("generates both outputs even when decisions array is empty", () => {
    const output = generateGitlabSettings({ decisions: [] });
    expect(output.script).toBeDefined();
    expect(output.doc).toBeDefined();
    expect(output.script.content).toContain("curl");
    expect(output.doc.content).toContain("# GitLab Settings");
  });

  // 6. curl commands are commented out in the script
  it("has curl commands commented out with explanations", () => {
    const output = generateGitlabSettings(config);
    expect(output.script.content).toContain("#");
    // At least one commented-out curl line
    expect(output.script.content).toMatch(/#.*curl/);
  });

  // 7. doc includes Web UI configuration alternative
  it("doc explains how to configure via GitLab Web UI", () => {
    const output = generateGitlabSettings(config);
    expect(output.doc.content).toContain("Web UI");
    expect(output.doc.content).toContain("Settings");
  });

  // 8. doc includes recommended values
  it("doc includes recommended values for team collaboration", () => {
    const output = generateGitlabSettings(config);
    expect(output.doc.content).toContain("Recommended");
    expect(output.doc.content).toContain("team");
  });
});
