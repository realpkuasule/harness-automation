import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendReceiptsComment,
  readIssue,
  readProjectField,
  updateProjectField,
} from "./provider.js";
import { parseWorkItem } from "./types.js";
import type { WorktreeDeliveryConfig } from "../worktree/types.js";

const directories: string[] = [];
const originalPath = process.env.PATH;
const originalMode = process.env.HARNESS_TEST_GH_MODE;
const originalLog = process.env.HARNESS_TEST_GH_LOG;

function directory(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-session-provider-"));
  directories.push(root);
  return root;
}

function project(): NonNullable<WorktreeDeliveryConfig["provider"]["project"]> {
  return { owner: "example", number: 2, statusField: "Status", doneValues: ["Done"] };
}

function installGh(root: string): void {
  const script = `const fs = require("node:fs");
const mode = process.env.HARNESS_TEST_GH_MODE;
const graphql = process.argv.includes("graphql");
const logFile = process.env.HARNESS_TEST_GH_LOG;
const bodyArg = process.argv.find((v) => v.startsWith("body="));
if (logFile) {
  const calls = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, "utf8")) : [];
  calls.push({ graphql, body: bodyArg ? bodyArg.slice(5) : null });
  fs.writeFileSync(logFile, JSON.stringify(calls));
}
if (!graphql) {
  const rest = process.argv.find((v) => v.includes("repos/example/project/issues/"));
  if (process.argv.includes("--method") && process.argv.includes("POST")) {
    if (mode === "fail-comment") { process.stderr.write("comment denied"); process.exit(1); }
    process.stdout.write(JSON.stringify({ id: 99, html_url: "https://github.com/example/project/issues/24#issuecomment-1" }));
    process.exit(0);
  }
  if (rest) {
    if (mode === "fail-issue") { process.stderr.write("issue unavailable"); process.exit(1); }
    process.stdout.write(JSON.stringify({
      number: 24,
      state: "open",
      title: "实现登录",
      body: "## 验收标准\\n能登录\\n## 其他\\n",
      html_url: "https://github.com/example/project/issues/24",
      ...(mode === "pr" ? { pull_request: { url: "https://api.github.com/example/project/pulls/24" } } : {})
    }));
    process.exit(0);
  }
  process.stderr.write("unknown rest call"); process.exit(1);
}
const query = process.argv.find((v) => v.startsWith("query="))?.slice(6) ?? "";
if (query.includes("fieldValues(first: 20)")) {
  process.stdout.write(JSON.stringify({ data: { repository: { issue: { projectItems: { nodes: [{
    project: { number: 2, owner: { __typename: "User", login: "example" } },
    fieldValues: { nodes: mode === "no-acceptance-field" ? [] : [
      { text: "验收标准文本", field: { name: "Acceptance Criteria" } }
    ] }
  }] } } } } }));
  process.exit(0);
}
if (query.includes("projectV2(number:")) {
  if (mode === "fail-write-context") { process.stderr.write("project unavailable"); process.exit(1); }
  process.stdout.write(JSON.stringify({ data: { repository: {
    issue: { projectItems: { nodes: [
      { id: "PVTI_1", project: { number: 2, owner: { __typename: "User", login: "example" } } }
    ] } },
    projectV2: { id: "PVT_1", fields: { nodes: [
      { __typename: "ProjectV2SingleSelectField", id: "F_STATUS", name: "Status", options: [
        { id: "OPT_IN_PROGRESS", name: "In Progress" },
        { id: "OPT_READY", name: "Ready for Review" }
      ] },
      { __typename: "ProjectV2Field", id: "F_HANDOFF", name: "Handoff Doc" }
    ] } }
  } } }));
  process.exit(0);
}
if (query.includes("updateProjectV2ItemFieldValue")) {
  if (mode === "fail-mutation") { process.stderr.write("mutation rejected"); process.exit(1); }
  process.stdout.write(JSON.stringify({ data: { updateProjectV2ItemFieldValue: { clientMutationId: "1" } } }));
  process.exit(0);
}
process.stderr.write("unknown graphql query"); process.exit(1);`;
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const ghPath = join(bin, "gh");
  writeFileSync(ghPath, `#!/usr/bin/env node\n${script}`, "utf8");
  chmodSync(ghPath, 0o755);
  process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
}

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
  process.env.PATH = originalPath;
  if (originalMode === undefined) delete process.env.HARNESS_TEST_GH_MODE;
  else process.env.HARNESS_TEST_GH_MODE = originalMode;
  if (originalLog === undefined) delete process.env.HARNESS_TEST_GH_LOG;
  else process.env.HARNESS_TEST_GH_LOG = originalLog;
});

function ghLog(root: string): Array<{ graphql: boolean; body: string | null }> {
  return JSON.parse(readFileSync(join(root, "gh-log.json"), "utf8"));
}

describe("session provider", () => {
  it("reads an issue through the gh channel", () => {
    const root = directory();
    installGh(root);
    const issue = readIssue(root, parseWorkItem("github:example/project#24")!);
    expect(issue).toMatchObject({ state: "OPEN", title: "实现登录", url: "https://github.com/example/project/issues/24" });
  });

  it("rejects unreachable issues and pull requests", () => {
    const root = directory();
    installGh(root);
    process.env.HARNESS_TEST_GH_MODE = "fail-issue";
    expect(() => readIssue(root, parseWorkItem("github:example/project#24")!))
      .toThrow(/GITHUB_ISSUE_QUERY_FAILED/);
    process.env.HARNESS_TEST_GH_MODE = "pr";
    expect(() => readIssue(root, parseWorkItem("github:example/project#24")!))
      .toThrow(/GITHUB_WORK_ITEM_NOT_ISSUE/);
  });

  it("reads a project field value and tolerates absence", () => {
    const root = directory();
    installGh(root);
    expect(readProjectField(root, "example/project", project(), 24, "Acceptance Criteria"))
      .toEqual({ present: true, value: "验收标准文本" });
    process.env.HARNESS_TEST_GH_MODE = "no-acceptance-field";
    expect(readProjectField(root, "example/project", project(), 24, "Acceptance Criteria"))
      .toEqual({ present: false });
  });

  it("updates a text field and a single-select field via GraphQL mutations", () => {
    const root = directory();
    installGh(root);
    process.env.HARNESS_TEST_GH_LOG = join(root, "gh-log.json");
    expect(updateProjectField(root, "example/project", project(), 24, "Handoff Doc", "docs/HANDOFF-24.md"))
      .toEqual({ fieldName: "Handoff Doc", applied: true });
    expect(updateProjectField(root, "example/project", project(), 24, "Status", "Ready for Review"))
      .toEqual({ fieldName: "Status", applied: true });
    const log = ghLog(root);
    expect(log.filter((call) => call.graphql).length).toBe(4);
  });

  it("reports a missing single-select option and query failures", () => {
    const root = directory();
    installGh(root);
    expect(updateProjectField(root, "example/project", project(), 24, "Status", "No Such Option"))
      .toMatchObject({ fieldName: "Status", applied: false, error: expect.stringContaining("GITHUB_PROJECT_OPTION_MISSING") });
    process.env.HARNESS_TEST_GH_MODE = "fail-write-context";
    expect(updateProjectField(root, "example/project", project(), 24, "Handoff Doc", "docs/HANDOFF-24.md"))
      .toMatchObject({ applied: false, error: expect.stringContaining("GITHUB_PROJECT_QUERY_FAILED") });
    process.env.HARNESS_TEST_GH_MODE = "fail-mutation";
    expect(updateProjectField(root, "example/project", project(), 24, "Handoff Doc", "docs/HANDOFF-24.md"))
      .toMatchObject({ applied: false, error: expect.stringContaining("GITHUB_PROJECT_UPDATE_FAILED") });
  });

  it("appends a deterministic receipts comment and reports failures", () => {
    const root = directory();
    installGh(root);
    process.env.HARNESS_TEST_GH_LOG = join(root, "gh-log.json");
    const workItem = parseWorkItem("github:example/project#24")!;
    expect(appendReceiptsComment(root, workItem, ["handoff-24-abc", "worktree-123"]))
      .toEqual({ applied: true });
    expect(ghLog(root)[0]).toEqual({ graphql: false, body: JSON.stringify(["handoff-24-abc", "worktree-123"]) });
    process.env.HARNESS_TEST_GH_MODE = "fail-comment";
    expect(appendReceiptsComment(root, workItem, ["handoff-24-abc"]))
      .toMatchObject({ applied: false, error: expect.stringContaining("GITHUB_ISSUE_COMMENT_FAILED") });
  });
});
