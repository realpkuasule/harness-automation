import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { observeProvider } from "./provider.js";
import type { WorktreeDeliveryConfig, WorkspaceLease } from "./types.js";

const directories: string[] = [];
const originalPath = process.env.PATH;
const originalMode = process.env.HARNESS_TEST_GH_MODE;

function directory(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-provider-"));
  directories.push(root);
  return root;
}

function config(
  provider: WorktreeDeliveryConfig["provider"],
): WorktreeDeliveryConfig {
  return {
    schemaVersion: "1.0",
    mode: "enforced",
    maxPersistentWorktrees: 4,
    leaseTtlHours: 168,
    reviewTtlMinutes: 120,
    remoteBranchRetentionDays: 14,
    allowedRoots: ["/tmp"],
    protectedRoots: ["/"],
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
  const executable = join(root, "gh");
  writeFileSync(executable, `#!/usr/bin/env node
const command = process.argv[2];
const mode = process.env.HARNESS_TEST_GH_MODE;
if (mode === "invalid-json") {
  process.stdout.write("not-json");
  process.exit(0);
}
if (mode === "fail-project" && command === "project") {
  process.stderr.write("project unavailable");
  process.exit(1);
}
if (mode === "fail-issue" && command === "issue") {
  process.stderr.write("issue unavailable");
  process.exit(1);
}
if (command === "project") {
  process.stdout.write(JSON.stringify({
    items: mode === "project-missing" ? [] : mode === "flattened" ? [{
      content: { number: 24 },
      status: "In Progress"
    }] : [{
      content: { number: 24 },
      fieldValues: [{ field: { name: "Workflow" }, name: "Done" }]
    }]
  }));
} else if (command === "issue") {
  process.stdout.write(JSON.stringify({
    number: 24,
    state: "OPEN",
    title: "Fixture",
    url: "https://github.com/example/project/issues/24"
  }));
} else {
  process.stderr.write("unexpected command");
  process.exit(2);
}
`, "utf8");
  chmodSync(executable, 0o755);
  process.env.PATH = `${root}:${originalPath ?? ""}`;
}

afterEach(() => {
  process.env.PATH = originalPath;
  if (originalMode === undefined) delete process.env.HARNESS_TEST_GH_MODE;
  else process.env.HARNESS_TEST_GH_MODE = originalMode;
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

  it("loads configured Project fields without hard-coded status names", () => {
    const root = directory();
    installGh(root);
    const observation = observeProvider(root, config({
      kind: "github",
      repository: "example/project",
      project: {
        owner: "example",
        number: 2,
        statusField: "Workflow",
        doneValues: ["Done"],
      },
    }), [lease()]);

    expect(observation).toMatchObject({
      kind: "github",
      configured: true,
      available: true,
      items: [{
        workItem: "github:example/project#24",
        state: "OPEN",
        projectStatus: "Done",
        url: "https://github.com/example/project/issues/24",
      }],
    });
  });

  it("reports when an Issue is absent from the configured Project", () => {
    const root = directory();
    installGh(root);
    process.env.HARNESS_TEST_GH_MODE = "project-missing";

    expect(observeProvider(root, config({
      kind: "github",
      repository: "example/project",
      project: {
        owner: "example",
        number: 2,
        statusField: "Workflow",
        doneValues: ["Done"],
      },
    }), [lease()])).toMatchObject({
      available: true,
      items: [{ projectItemPresent: false, projectStatus: undefined }],
    });
  });

  it("loads flattened Project fields case-insensitively", () => {
    const root = directory();
    installGh(root);
    process.env.HARNESS_TEST_GH_MODE = "flattened";

    expect(observeProvider(root, config({
      kind: "github",
      repository: "example/project",
      project: {
        owner: "example",
        number: 2,
        statusField: "Status",
        doneValues: ["Done"],
      },
    }), [lease()])).toMatchObject({
      available: true,
      items: [{ projectStatus: "In Progress" }],
    });
  });

  it("fails closed on Project, Issue, work-item, and JSON errors", () => {
    const root = directory();
    installGh(root);
    const github = config({
      kind: "github",
      repository: "example/project",
      project: {
        owner: "example",
        number: 2,
        statusField: "Workflow",
        doneValues: ["Done"],
      },
    });

    process.env.HARNESS_TEST_GH_MODE = "fail-project";
    expect(observeProvider(root, github, [lease()])).toMatchObject({
      available: false,
      error: "project unavailable",
    });

    process.env.HARNESS_TEST_GH_MODE = "fail-issue";
    expect(observeProvider(root, config({
      kind: "github",
      repository: "example/project",
    }), [lease()])).toMatchObject({
      available: false,
      error: "issue unavailable",
    });

    process.env.HARNESS_TEST_GH_MODE = "invalid-json";
    expect(observeProvider(root, github, [lease()])).toMatchObject({
      available: false,
      error: "gh returned invalid JSON",
    });

    delete process.env.HARNESS_TEST_GH_MODE;
    expect(observeProvider(root, github, [lease("github:example/project")]))
      .toMatchObject({
        available: false,
        error: "GitHub work item must end with #<number>: github:example/project",
      });
  });
});
