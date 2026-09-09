import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createGitHubWorkItem,
  listGitHubWorkItems,
  loadGitHubTrackingConfig,
  readGitHubWorkItem,
  updateGitHubWorkItem,
  type GitHubTrackingConfig,
  type GitHubTrackingRequest,
} from "./service.js";

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "harness-tracking-"));
  roots.push(value);
  return value;
}

function variable(args: string[], name: string): string | undefined {
  return args.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

function query(args: string[]): string {
  return variable(args, "query") ?? "";
}

function issue(number: number, title = `Issue ${number}`): Record<string, unknown> {
  return {
    id: `ISSUE_${number}`,
    node_id: `ISSUE_${number}`,
    number,
    title,
    body: "body",
    state: "OPEN",
    url: `https://api.github.test/issues/${number}`,
    html_url: `https://github.test/issues/${number}`,
    updatedAt: "2026-09-03T00:00:00Z",
    updated_at: "2026-09-03T00:00:00Z",
  };
}

function project(
  id: string,
  connection: string,
  value: unknown,
  ownerType: "Organization" | "User" = "Organization",
): Record<string, unknown> {
  return {
    data: {
      repositoryOwner: { __typename: ownerType, projectV2: { id, [connection]: value } },
    },
  };
}

const config: GitHubTrackingConfig = {
  mode: "github",
  repository: "example/repository",
  project: {
    owner: "example",
    number: 2,
    statusField: "Status",
    defaultStatus: "Todo",
    priorityField: "Priority",
    defaultPriority: "medium",
  },
};

afterEach(() => {
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("GitHub tracking", () => {
  it.each(["Organization", "User"] as const)("reads every Issue and %s-owned Project cursor page", (ownerType) => {
    const requests: string[] = [];
    const request: GitHubTrackingRequest = (_root, args) => {
      const document = query(args);
      const cursor = variable(args, "cursor");
      requests.push(`${document.includes("issues(first") ? "issues" : "project"}:${cursor ?? "first"}`);
      if (document.includes("issues(first")) {
        const nodes = cursor ? [issue(2)] : [issue(1)];
        return { ok: true, value: { data: { repository: {
          id: "REPO_1", nameWithOwner: "example/repository",
          issues: { nodes, pageInfo: { hasNextPage: !cursor, endCursor: cursor ? null : "ISSUES_2" } },
        } } } };
      }
      const number = cursor ? 2 : 1;
      return { ok: true, value: project("PROJECT_1", "items", {
        nodes: [{
          id: `ITEM_${number}`,
          content: { number, repository: { nameWithOwner: "example/repository" } },
          status: { name: number === 1 ? "Todo" : "Done" },
          priority: { name: "medium" },
        }],
        pageInfo: { hasNextPage: !cursor, endCursor: cursor ? null : "PROJECT_2" },
      }, ownerType) };
    };

    const result = listGitHubWorkItems({ root: root(), config, request });

    expect(result.repositoryId).toBe("REPO_1");
    expect(result.items).toEqual([
      expect.objectContaining({ number: 1, projectItemId: "ITEM_1", projectStatus: "Todo" }),
      expect.objectContaining({ number: 2, projectItemId: "ITEM_2", projectStatus: "Done" }),
    ]);
    expect(requests).toEqual(["issues:first", "issues:ISSUES_2", "project:first", "project:PROJECT_2"]);
  });

  it("creates an Issue, adds it to Project, updates fields, and verifies readback", () => {
    let added = false;
    let pendingItemReads = 1;
    let status = "";
    let priority = "";
    const waits: number[] = [];
    const request: GitHubTrackingRequest = (_root, args) => {
      const document = query(args);
      const endpoint = args[3];
      if (args.includes("POST") && endpoint === "repos/example/repository/issues") {
        return { ok: true, value: { number: 3 } };
      }
      if (args.includes("GET") && endpoint === "repos/example/repository/issues/3") {
        return { ok: true, value: issue(3, "New") };
      }
      if (document.includes("fields(first")) {
        const cursor = variable(args, "cursor");
        return { ok: true, value: project("PROJECT_1", "fields", {
          nodes: cursor
            ? [{ __typename: "ProjectV2SingleSelectField", id: "FIELD_PRIORITY", name: "Priority", options: [{ id: "HIGH", name: "high" }] }]
            : [{ __typename: "ProjectV2SingleSelectField", id: "FIELD_STATUS", name: "Status", options: [{ id: "TODO", name: "Todo" }] }],
          pageInfo: { hasNextPage: !cursor, endCursor: cursor ? null : "FIELDS_2" },
        }) };
      }
      if (document.includes("items(first")) {
        let visible = added;
        if (visible && pendingItemReads > 0) {
          pendingItemReads -= 1;
          visible = false;
        }
        return { ok: true, value: project("PROJECT_1", "items", {
          nodes: visible ? [{
            id: "ITEM_3",
            content: { number: 3, repository: { nameWithOwner: "example/repository" } },
            status: status ? { name: status } : null,
            priority: priority ? { name: priority } : null,
          }] : [],
          pageInfo: { hasNextPage: false, endCursor: null },
        }) };
      }
      if (document.includes("addProjectV2ItemById")) {
        added = true;
        return { ok: true, value: { data: { addProjectV2ItemById: { item: { id: "ITEM_3" } } } } };
      }
      if (document.includes("updateProjectV2ItemFieldValue")) {
        if (variable(args, "fieldId") === "FIELD_STATUS") status = "Todo";
        if (variable(args, "fieldId") === "FIELD_PRIORITY") priority = "high";
        return { ok: true, value: { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "ITEM_3" } } } } };
      }
      return { ok: false, error: `unexpected request: ${args.join(" ")}` };
    };

    const result = createGitHubWorkItem({
      root: root(),
      config,
      title: "New",
      body: "body",
      priority: "high",
      request,
      wait: (milliseconds) => waits.push(milliseconds),
    });

    expect(result).toMatchObject({ number: 3, title: "New", projectItemId: "ITEM_3", projectStatus: "Todo", projectPriority: "high" });
    expect(waits).toEqual([0, 250, 0]);
  });

  it("updates Issue and Project only after exact readback", () => {
    let title = "Old";
    let status = "Todo";
    let pendingStatusReads = 0;
    const waits: number[] = [];
    const request: GitHubTrackingRequest = (_root, args) => {
      const document = query(args);
      const endpoint = args[3];
      if (args.includes("PATCH") && endpoint === "repos/example/repository/issues/4") {
        title = variable(args, "title") ?? title;
        return { ok: true, value: issue(4, title) };
      }
      if (args.includes("GET") && endpoint === "repos/example/repository/issues/4") {
        return { ok: true, value: issue(4, title) };
      }
      if (document.includes("fields(first")) {
        return { ok: true, value: project("PROJECT_1", "fields", {
          nodes: [{ __typename: "ProjectV2SingleSelectField", id: "FIELD_STATUS", name: "Status", options: [{ id: "DONE", name: "Done" }] }],
          pageInfo: { hasNextPage: false, endCursor: null },
        }) };
      }
      if (document.includes("items(first")) {
        const visibleStatus = pendingStatusReads > 0 ? "Todo" : status;
        if (pendingStatusReads > 0) pendingStatusReads -= 1;
        return { ok: true, value: project("PROJECT_1", "items", {
          nodes: [{ id: "ITEM_4", content: { number: 4, repository: { nameWithOwner: "example/repository" } }, status: { name: visibleStatus }, priority: null }],
          pageInfo: { hasNextPage: false, endCursor: null },
        }) };
      }
      if (document.includes("updateProjectV2ItemFieldValue")) {
        status = "Done";
        pendingStatusReads = 1;
        return { ok: true, value: { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "ITEM_4" } } } } };
      }
      return { ok: false, error: "unexpected" };
    };

    expect(updateGitHubWorkItem({
      root: root(),
      config,
      issue: 4,
      title: "Updated",
      status: "Done",
      request,
      wait: (milliseconds) => waits.push(milliseconds),
    }))
      .toMatchObject({ title: "Updated", projectStatus: "Done" });
    expect(waits).toEqual([0, 250]);
  });

  it("bounds Project readback retries after a successful partial mutation", () => {
    let added = false;
    let itemReads = 0;
    const waits: number[] = [];
    const request: GitHubTrackingRequest = (_root, args) => {
      const document = query(args);
      const endpoint = args[3];
      if (args.includes("POST") && endpoint === "repos/example/repository/issues") {
        return { ok: true, value: { number: 8 } };
      }
      if (args.includes("GET") && endpoint === "repos/example/repository/issues/8") {
        return { ok: true, value: issue(8, "Eventually consistent") };
      }
      if (document.includes("fields(first")) {
        return { ok: true, value: project("PROJECT_1", "fields", {
          nodes: [
            { __typename: "ProjectV2SingleSelectField", id: "FIELD_STATUS", name: "Status", options: [{ id: "TODO", name: "Todo" }] },
            { __typename: "ProjectV2SingleSelectField", id: "FIELD_PRIORITY", name: "Priority", options: [{ id: "MEDIUM", name: "medium" }] },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        }) };
      }
      if (document.includes("items(first")) {
        itemReads += 1;
        return { ok: true, value: project("PROJECT_1", "items", {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        }) };
      }
      if (document.includes("addProjectV2ItemById")) {
        added = true;
        return { ok: true, value: { data: { addProjectV2ItemById: { item: { id: "ITEM_8" } } } } };
      }
      return { ok: false, error: "unexpected" };
    };

    expect(() => createGitHubWorkItem({
      root: root(),
      config,
      title: "Eventually consistent",
      body: "body",
      request,
      wait: (milliseconds) => waits.push(milliseconds),
    })).toThrow(/PARTIAL_MUTATION: issue #8; completed=issue:create,project:item-add;.*READBACK_TIMEOUT/);
    expect(added).toBe(true);
    expect(itemReads).toBe(6);
    expect(waits).toEqual([0, 250, 500, 1_000, 2_000]);
  });

  it("fails closed on API failure, malformed pagination, and readback mismatch", () => {
    const directory = root();
    const unavailable: GitHubTrackingRequest = () => ({ ok: false, error: "HTTP 503" });
    expect(() => createGitHubWorkItem({ root: directory, config: { ...config, project: undefined }, title: "No fallback", request: unavailable }))
      .toThrow(/GITHUB_TRACKING_ISSUE_CREATE_FAILED/);
    expect(() => listGitHubWorkItems({
      root: directory,
      config: { ...config, project: undefined },
      request: () => ({ ok: true, value: { data: { repository: { id: "R", nameWithOwner: config.repository, issues: { nodes: [], pageInfo: { hasNextPage: true } } } } } }),
    })).toThrow(/GITHUB_TRACKING_PAGINATION_INCOMPLETE/);

    expect(() => listGitHubWorkItems({
      root: directory,
      config: { ...config, project: undefined },
      request: () => ({ ok: true, value: { data: { repository: {
        id: "R", nameWithOwner: config.repository,
        issues: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "SAME" } },
      } } } }),
    })).toThrow(/repeated cursor/);

    const mismatch: GitHubTrackingRequest = (_root, args) => {
      if (args.includes("POST")) return { ok: true, value: { number: 5 } };
      return { ok: true, value: issue(5, "Different") };
    };
    expect(() => createGitHubWorkItem({ root: directory, config: { ...config, project: undefined }, title: "Expected", request: mismatch }))
      .toThrow(/PARTIAL_MUTATION: issue #5; completed=issue:create;.*READBACK_MISMATCH/);

    const projectFailure: GitHubTrackingRequest = (_root, args) => {
      if (args.includes("POST")) return { ok: true, value: { number: 6 } };
      if (args.includes("GET")) return { ok: true, value: issue(6, "Project failure") };
      return { ok: false, error: "GraphQL unavailable" };
    };
    expect(() => createGitHubWorkItem({ root: directory, config, title: "Project failure", body: "body", request: projectFailure }))
      .toThrow(/GITHUB_TRACKING_PROJECT_FIELDS_QUERY_FAILED/);
    let invalidUpdateRequests = 0;
    expect(() => updateGitHubWorkItem({
      root: directory,
      config,
      issue: 0,
      title: "Never written",
      request: () => {
        invalidUpdateRequests += 1;
        return { ok: false, error: "must not run" };
      },
    })).toThrow(/GITHUB_TRACKING_ISSUE_INVALID/);
    expect(invalidUpdateRequests).toBe(0);
    expect(existsSync(join(directory, "harness", "local-tracking"))).toBe(false);
  });

  it("preflights Project options and reports only evidenced partial mutations", () => {
    const directory = root();
    const fields = (): ReturnType<GitHubTrackingRequest> => ({ ok: true, value: project("PROJECT_1", "fields", {
      nodes: [
        { __typename: "ProjectV2SingleSelectField", id: "FIELD_STATUS", name: "Status", options: [{ id: "TODO", name: "Todo" }] },
        { __typename: "ProjectV2SingleSelectField", id: "FIELD_PRIORITY", name: "Priority", options: [{ id: "MEDIUM", name: "medium" }] },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    }) });

    let mutations = 0;
    expect(() => createGitHubWorkItem({
      root: directory,
      config,
      title: "Invalid option",
      priority: "missing",
      request: (_root, args) => {
        if (query(args).includes("fields(first")) return fields();
        mutations += 1;
        return { ok: false, error: "must not mutate" };
      },
    })).toThrow(/PROJECT_OPTION_MISSING: Priority\/missing/);
    expect(mutations).toBe(0);

    let createError: Error | undefined;
    try {
      createGitHubWorkItem({
        root: directory,
        config,
        title: "Created remotely",
        request: (_root, args) => {
          if (query(args).includes("fields(first")) return fields();
          if (args.includes("POST")) return { ok: true, value: { number: 9 } };
          return { ok: false, error: "Authorization: Bearer create-secret" };
        },
      });
    } catch (error) {
      createError = error as Error;
    }
    expect(createError?.message).toMatch(/PARTIAL_MUTATION: issue #9; completed=issue:create; inspect the existing Issue/);
    expect(createError?.message).not.toContain("create-secret");

    let updateError: Error | undefined;
    try {
      updateGitHubWorkItem({
        root: directory,
        config: { ...config, project: undefined },
        issue: 10,
        title: "Updated remotely",
        request: (_root, args) => args.includes("PATCH")
          ? { ok: true, value: issue(10, "Updated remotely") }
          : { ok: false, error: "GH_TOKEN=update-secret" },
      });
    } catch (error) {
      updateError = error as Error;
    }
    expect(updateError?.message).toMatch(/PARTIAL_MUTATION: issue #10; completed=issue:update; inspect the existing Issue/);
    expect(updateError?.message).not.toContain("update-secret");

    let fieldMutation = 0;
    let fieldError: Error | undefined;
    try {
      updateGitHubWorkItem({
        root: directory,
        config,
        issue: 11,
        status: "Todo",
        priority: "medium",
        request: (_root, args) => {
          const document = query(args);
          if (document.includes("fields(first")) return fields();
          if (args.includes("GET")) return { ok: true, value: issue(11) };
          if (document.includes("items(first")) return { ok: true, value: project("PROJECT_1", "items", {
            nodes: [{ id: "ITEM_11", content: { number: 11, repository: { nameWithOwner: config.repository } }, status: null, priority: null }],
            pageInfo: { hasNextPage: false, endCursor: null },
          }) };
          if (document.includes("updateProjectV2ItemFieldValue")) {
            fieldMutation += 1;
            return fieldMutation === 1
              ? { ok: true, value: { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "ITEM_11" } } } } }
              : { ok: false, error: "Authorization: Bearer field-secret" };
          }
          return { ok: false, error: "unexpected" };
        },
      });
    } catch (error) {
      fieldError = error as Error;
    }
    expect(fieldError?.message).toMatch(/PARTIAL_MUTATION: issue #11; completed=project:field:Status;/);
    expect(fieldError?.message).not.toContain("project:field:Priority");
    expect(fieldError?.message).not.toContain("field-secret");

    expect(() => updateGitHubWorkItem({
      root: directory,
      config: { ...config, project: undefined },
      issue: 12,
      title: "Unknown outcome",
      request: () => ({ ok: false, error: "HTTP 503" }),
    })).toThrow(/^GITHUB_TRACKING_ISSUE_UPDATE_FAILED:/);
  });

  it("fails closed on ambiguous or malformed provider responses", () => {
    const directory = root();
    const listed = (value: unknown): (() => unknown) => () => listGitHubWorkItems({
      root: directory,
      config: { ...config, project: undefined },
      request: () => ({ ok: true, value }),
    });
    const repository = (issues: unknown): Record<string, unknown> => ({
      data: { repository: { id: "REPO_1", nameWithOwner: config.repository, issues } },
    });
    const onePage = (nodes: unknown[]): Record<string, unknown> => ({
      nodes,
      pageInfo: { hasNextPage: false, endCursor: null },
    });

    expect(listed({ errors: [{ message: "GraphQL denied" }] })).toThrow(/ISSUE_LIST_FAILED/);
    expect(listed({ errors: [{}] })).toThrow(/unknown GraphQL error/);
    expect(listed({ data: null })).toThrow(/omitted data/);
    expect(listed({ data: { repository: { id: "R", nameWithOwner: "other/repository" } } }))
      .toThrow(/REPOSITORY_MISMATCH/);
    expect(listed(repository({ nodes: "not-an-array", pageInfo: { hasNextPage: false } })))
      .toThrow(/PAGINATION_INCOMPLETE/);
    expect(listed(repository({ nodes: [], pageInfo: {} }))).toThrow(/PAGINATION_INCOMPLETE/);
    expect(listed(repository(onePage([{ ...issue(7), state: "MERGED" }])))).toThrow(/issue.state/);
    expect(listed(repository(onePage([{ ...issue(7), state: 3 }])))).toThrow(/issue.state/);
    expect(listed(repository(onePage([{ ...issue(7), number: 0 }])))).toThrow(/issue.number/);
    expect(listed(repository(onePage([{ ...issue(7), number: "7" }])))).toThrow(/issue.number/);
    expect(listed(repository(onePage([issue(7), issue(7)])))).toThrow(/ISSUE_MAPPING_AMBIGUOUS/);
    const nullBody = listed(repository(onePage([{ ...issue(7), body: null }])))() as ReturnType<typeof listGitHubWorkItems>;
    expect(nullBody).toMatchObject({
      items: [expect.objectContaining({ number: 7, body: "" })],
    });
    expect(() => listGitHubWorkItems({
      root: directory,
      config: { ...config, project: undefined },
      request: () => ({ ok: false }),
    })).toThrow(/unknown error/);

    expect(() => readGitHubWorkItem({
      root: directory,
      config: { ...config, project: undefined },
      issue: 7,
      request: () => ({ ok: true, value: { ...issue(7), pull_request: {} } }),
    })).toThrow(/WORK_ITEM_NOT_ISSUE/);
    expect(() => readGitHubWorkItem({
      root: directory,
      config: { ...config, project: undefined },
      issue: 7,
      request: () => ({ ok: true, value: issue(8) }),
    })).toThrow(/READBACK_MISMATCH/);

    const withProject = (projectValue: unknown): (() => unknown) => () => listGitHubWorkItems({
      root: directory,
      config,
      request: (_root, args) => query(args).includes("issues(first")
        ? { ok: true, value: repository(onePage([issue(7)])) }
        : { ok: true, value: projectValue },
    });
    expect(withProject({ data: { repositoryOwner: null } }))
      .toThrow(/PROJECT_OWNER_MISSING/);
    expect(withProject({ data: { repositoryOwner: { __typename: "Enterprise", projectV2: null } } }))
      .toThrow(/PROJECT_OWNER_MISSING/);
    expect(withProject({ data: { repositoryOwner: { __typename: "User", projectV2: null } } }))
      .toThrow(/PROJECT_MISSING/);
    expect(withProject(project("PROJECT_1", "items", onePage([
      { id: "ITEM_1", content: { number: 7, repository: { nameWithOwner: config.repository } } },
      { id: "ITEM_2", content: { number: 7, repository: { nameWithOwner: config.repository } } },
    ])))).toThrow(/PROJECT_MAPPING_AMBIGUOUS/);
    const skipped = withProject(project("PROJECT_1", "items", onePage([
      { id: "DRAFT", content: {} },
      { id: "FOREIGN", content: { number: 7, repository: { nameWithOwner: "other/repository" } } },
    ])))() as ReturnType<typeof listGitHubWorkItems>;
    expect(skipped.items).toEqual([expect.objectContaining({ number: 7 })]);
    expect("projectItemId" in skipped.items[0]).toBe(false);
  });

  it("loads only an explicitly configured GitHub tracking mode", () => {
    const directory = root();
    execFileSync("git", ["init", "-b", "main"], { cwd: directory });
    execFileSync("git", ["remote", "add", "origin", "git@github.com:example/repository.git"], { cwd: directory });
    mkdirSync(join(directory, ".github"));
    const path = join(directory, ".github", "project-workflow.json");
    const writeConfig = (value: unknown): void => writeFileSync(path, JSON.stringify(value));
    writeConfig({
      repo: "example/repository",
      workflow: { sourceOfTruth: "local-only" },
    });

    expect(() => loadGitHubTrackingConfig(directory)).toThrow(/GITHUB_TRACKING_MODE_REQUIRED/);
    writeConfig({ repo: "example/repository", workflow: { sourceOfTruth: "github-issues-project" } });
    expect(loadGitHubTrackingConfig(directory).config).toEqual({ mode: "github", repository: "example/repository" });
    writeConfig({
      repo: "example/repository",
      project: { owner: "example", number: 2 },
      workflow: { sourceOfTruth: "github-issues-project" },
    });
    expect(loadGitHubTrackingConfig(directory).config.project).toMatchObject({
      statusField: "Status",
      defaultStatus: "Todo",
      priorityField: "Priority",
      defaultPriority: "medium",
    });
    writeConfig({
      repo: "example/repository",
      project: { owner: "example", number: 2, statusField: 3 },
      workflow: { sourceOfTruth: "github-issues-project" },
    });
    expect(() => loadGitHubTrackingConfig(directory)).toThrow(/project.statusField/);
    writeConfig({
      repo: "example/repository",
      project: { owner: "", number: 0 },
      workflow: { sourceOfTruth: "github-issues-project" },
    });
    expect(() => loadGitHubTrackingConfig(directory)).toThrow(/project owner\/number/);
    writeConfig({ repo: "other/repository", workflow: { sourceOfTruth: "github-issues-project" } });
    expect(() => loadGitHubTrackingConfig(directory)).toThrow(/REPOSITORY_MISMATCH/);
    writeFileSync(path, "{not json");
    expect(() => loadGitHubTrackingConfig(directory)).toThrow(/CONFIG_INVALID/);
  });
});
