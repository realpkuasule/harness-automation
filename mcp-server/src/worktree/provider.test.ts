import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { observeProvider } from "./provider.js";
import type { WorktreeDeliveryConfig, WorkspaceLease } from "./types.js";

const directories: string[] = [];
const originalPath = process.env.PATH;
const originalMode = process.env.HARNESS_TEST_GH_MODE;
const originalCountFile = process.env.HARNESS_TEST_GH_COUNT_FILE;

function directory(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-provider-"));
  directories.push(root);
  return root;
}

function config(provider: WorktreeDeliveryConfig["provider"]): WorktreeDeliveryConfig {
  return {
    schemaVersion: "1.0",
    mode: "enforced",
    maxPersistentWorktrees: 4,
    leaseTtlHours: 168,
    reviewTtlMinutes: 120,
    remoteBranchRetentionDays: 14,
    remoteBranchDeletion: false,
    provider,
  };
}

function lease(workItem = "github:example/project#24"): WorkspaceLease {
  return {
    schemaVersion: "1.0",
    workItem,
    branch: "issue-24",
    path: "/tmp/issue-24",
    owner: "owner",
    acceptedCommit: "abc123",
    createdAt: "2026-01-01T00:00:00.000Z",
    heartbeatAt: "2026-01-01T00:00:00.000Z",
    status: "active",
  };
}

function installGh(root: string): void {
  const script = `const fs = require("node:fs");
const mode = process.env.HARNESS_TEST_GH_MODE;
const graphql = process.argv.includes("graphql");
const rateLimit = process.argv.includes("rate_limit");
if (process.env.HARNESS_TEST_GH_COUNT_FILE) {
  const file = process.env.HARNESS_TEST_GH_COUNT_FILE;
  const calls = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
  calls.push(graphql ? "graphql" : "rest");
  fs.writeFileSync(file, JSON.stringify(calls));
}
if (mode === "invalid-json") {
  process.stdout.write("not-json");
  process.exit(0);
}
if (rateLimit) {
  process.stdout.write(JSON.stringify({ resources: { graphql: { reset: 1786644346 } } }));
  process.exit(0);
}
if (mode === "fail-project" && graphql) {
  process.stderr.write("API rate limit exceeded for GraphQL");
  process.exit(1);
}
if (mode === "fail-issue" && !graphql) {
  process.stderr.write("issue unavailable");
  process.exit(1);
}
if (graphql) {
  const nodes = ["project-missing", "truncated"].includes(mode) ? [] : [{
    project: {
      number: 2,
      owner: { __typename: mode === "organization" ? "Organization" : "User", login: "example" }
    },
    configuredField: {
      __typename: "ProjectV2ItemFieldSingleSelectValue",
      name: mode === "flattened" ? "In Progress" : "Done"
    }
  }];
  process.stdout.write(JSON.stringify({
    data: { repository: mode === "missing-alias" ? {} : {
      issue0: { projectItems: mode === "null-connection" ? null : {
        nodes,
        ...(mode === "missing-pageinfo" ? {} : {
          pageInfo: { hasNextPage: mode === "truncated" }
        })
      } },
      issue1: { projectItems: { nodes, pageInfo: { hasNextPage: false } } }
    } },
    ...(mode === "partial-error" ? { errors: [{ message: "Project field unavailable" }] } : {})
  }));
} else if (process.argv.some((value) => value.includes("repos/example/project/issues/"))) {
  const path = process.argv.find((value) => value.includes("repos/example/project/issues/"));
  process.stdout.write(JSON.stringify({
    number: Number(path.split("/").at(-1)),
    state: "open",
    title: "Fixture",
    html_url: "https://github.com/example/project/issues/24",
    ...(mode === "pull-request" ? { pull_request: { url: "https://api.github.test/pulls/24" } } : {})
  }));
} else {
  process.stderr.write("unexpected command");
  process.exit(2);
}
`;
  if (process.platform === "win32") {
    writeFileSync(join(root, "gh.js"), script, "utf8");
    writeFileSync(join(root, "gh.cmd"), "@node \"%~dp0gh.js\" %*\r\n", "utf8");
  } else {
    const executable = join(root, "gh");
    writeFileSync(executable, `#!/usr/bin/env node\n${script}`, "utf8");
    chmodSync(executable, 0o755);
  }
  process.env.PATH = `${root}${delimiter}${originalPath ?? ""}`;
}

afterEach(() => {
  process.env.PATH = originalPath;
  if (originalMode === undefined) delete process.env.HARNESS_TEST_GH_MODE;
  else process.env.HARNESS_TEST_GH_MODE = originalMode;
  if (originalCountFile === undefined) delete process.env.HARNESS_TEST_GH_COUNT_FILE;
  else process.env.HARNESS_TEST_GH_COUNT_FILE = originalCountFile;
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("worktree provider adapters", () => {
  it("keeps the no-provider baseline available", () => {
    expect(observeProvider("/tmp", config({ kind: "none" }), [])).toEqual({
      kind: "none",
      configured: false,
      available: true,
      items: [],
    });
  });

  it.each(["gitlab", "jira"] as const)("reports an uninstalled %s adapter as blocked", (kind) => {
    expect(observeProvider("/tmp", config({ kind, repository: "example/project" }), []))
      .toMatchObject({ kind, configured: true, available: false });
  });

  it("requires a repository for GitHub", () => {
    expect(observeProvider("/tmp", config({ kind: "github" }), []))
      .toMatchObject({ available: false, error: "GitHub provider requires repository" });
  });

  it("loads a configured Project field without hard-coding its name", () => {
    const root = directory();
    installGh(root);
    expect(observeProvider(root, config({
      kind: "github",
      repository: "example/project",
      project: { owner: "example", number: 2, statusField: "Workflow", doneValues: ["Done"] },
    }), [lease()])).toMatchObject({
      kind: "github",
      configured: true,
      available: true,
      items: [{
        workItem: "github:example/project#24",
        state: "OPEN",
        projectItemPresent: true,
        projectStatus: "Done",
        url: "https://github.com/example/project/issues/24",
      }],
    });
  });

  it("supports an Organization-owned Project", () => {
    const root = directory();
    installGh(root);
    process.env.HARNESS_TEST_GH_MODE = "organization";
    expect(observeProvider(root, config({
      kind: "github",
      repository: "example/project",
      project: { owner: "example", number: 2, statusField: "Status", doneValues: ["Done"] },
    }), [lease()])).toMatchObject({
      available: true,
      items: [{ projectItemPresent: true, projectStatus: "Done" }],
    });
  });

  it("reports when an Issue is absent from the configured Project", () => {
    const root = directory();
    installGh(root);
    process.env.HARNESS_TEST_GH_MODE = "project-missing";
    expect(observeProvider(root, config({
      kind: "github",
      repository: "example/project",
      project: { owner: "example", number: 2, statusField: "Workflow", doneValues: ["Done"] },
    }), [lease()])).toMatchObject({
      available: true,
      items: [{ projectItemPresent: false, projectStatus: undefined }],
    });
  });

  it("uses REST for Issues and one GraphQL request for all Project mappings", () => {
    const root = directory();
    installGh(root);
    const countFile = join(root, "calls.json");
    process.env.HARNESS_TEST_GH_COUNT_FILE = countFile;
    const observation = observeProvider(root, config({
      kind: "github",
      repository: "example/project",
      project: { owner: "example", number: 2, statusField: "Status", doneValues: ["Done"] },
    }), [lease()], ["github:example/project#25", "github:example/project#24"]);

    expect(observation.items.map((item) => item.workItem)).toEqual([
      "github:example/project#24",
      "github:example/project#25",
    ]);
    expect(JSON.parse(readFileSync(countFile, "utf8"))).toEqual([
      "rest",
      "rest",
      "graphql",
    ]);
  });

  it("does not use GraphQL when no Project mapping is configured", () => {
    const root = directory();
    installGh(root);
    const countFile = join(root, "calls.json");
    process.env.HARNESS_TEST_GH_COUNT_FILE = countFile;
    process.env.HARNESS_TEST_GH_MODE = "fail-project";

    expect(observeProvider(root, config({
      kind: "github",
      repository: "example/project",
    }), [lease()])).toMatchObject({ available: true, items: [{ state: "OPEN" }] });
    expect(JSON.parse(readFileSync(countFile, "utf8"))).toEqual(["rest"]);
  });

  it("rejects a pull request number where an Issue work item is required", () => {
    const root = directory();
    installGh(root);
    process.env.HARNESS_TEST_GH_MODE = "pull-request";
    expect(observeProvider(root, config({
      kind: "github",
      repository: "example/project",
    }), [lease()])).toMatchObject({
      available: false,
      error: "GITHUB_WORK_ITEM_NOT_ISSUE: github:example/project#24",
    });
  });

  it("fails closed on an HTTP-200 partial GraphQL response", () => {
    const root = directory();
    installGh(root);
    process.env.HARNESS_TEST_GH_MODE = "partial-error";
    expect(observeProvider(root, config({
      kind: "github",
      repository: "example/project",
      project: { owner: "example", number: 2, statusField: "Status", doneValues: ["Done"] },
    }), [lease()])).toMatchObject({
      available: false,
      error: expect.stringContaining("GITHUB_PROJECT_QUERY_FAILED"),
    });
  });

  it.each([
    ["missing-alias", "omitted Issue #24"],
    ["null-connection", "omitted Issue #24"],
    ["missing-pageinfo", "omitted Issue #24"],
    ["truncated", "GITHUB_PROJECT_MAPPING_TRUNCATED"],
  ])("fails closed on incomplete Project mapping: %s", (mode, error) => {
    const root = directory();
    installGh(root);
    process.env.HARNESS_TEST_GH_MODE = mode;
    expect(observeProvider(root, config({
      kind: "github",
      repository: "example/project",
      project: { owner: "example", number: 2, statusField: "Status", doneValues: ["Done"] },
    }), [lease()])).toMatchObject({
      available: false,
      error: expect.stringContaining(error),
    });
  });

  it("fails closed with stable diagnostics on Project, Issue, work-item, and JSON errors", () => {
    const root = directory();
    installGh(root);
    const github = config({
      kind: "github",
      repository: "example/project",
      project: { owner: "example", number: 2, statusField: "Workflow", doneValues: ["Done"] },
    });

    process.env.HARNESS_TEST_GH_MODE = "fail-project";
    expect(observeProvider(root, github, [lease()])).toMatchObject({
      available: false,
      error: expect.stringContaining("GITHUB_GRAPHQL_RATE_LIMITED"),
    });
    expect(observeProvider(root, github, [lease()]).error).toContain("resetAt=");

    process.env.HARNESS_TEST_GH_MODE = "fail-issue";
    expect(observeProvider(root, config({ kind: "github", repository: "example/project" }), [lease()]))
      .toMatchObject({
        available: false,
        error: expect.stringContaining("GITHUB_ISSUE_QUERY_FAILED"),
      });

    process.env.HARNESS_TEST_GH_MODE = "invalid-json";
    expect(observeProvider(root, github, [lease()])).toMatchObject({
      available: false,
      error: expect.stringContaining("returned invalid JSON"),
    });

    delete process.env.HARNESS_TEST_GH_MODE;
    expect(observeProvider(root, github, [lease("github:example/project")])).toMatchObject({
      available: false,
      error: expect.stringContaining("must match github:example/project#<number>"),
    });
  });
});
