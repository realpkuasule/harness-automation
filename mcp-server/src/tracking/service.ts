import { readFileSync } from "node:fs";
import { join } from "node:path";
import { commandJson } from "../worktree/provider.js";
import { resolveRepositoryContext, runGit } from "../repository/git.js";
import { githubEndpointRepository } from "../repository/remote.js";
import { scrubSensitive } from "../credentials/service.js";

export interface GitHubTrackingProject {
  owner: string;
  number: number;
  statusField: string;
  defaultStatus: string;
  priorityField: string;
  defaultPriority: string;
}

export interface GitHubTrackingConfig {
  mode: "github";
  repository: string;
  project?: GitHubTrackingProject;
}

export interface GitHubWorkItem {
  id: string;
  number: number;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED";
  url: string;
  updatedAt: string;
  projectItemId?: string;
  projectStatus?: string;
  projectPriority?: string;
}

interface CommandResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

export type GitHubTrackingRequest = (root: string, args: string[]) => CommandResult;
type GitHubTrackingWait = (milliseconds: number) => void;

interface PreparedProjectWrite {
  projectId: string;
  updates: Array<{
    name: string;
    selected: string;
    field: { id: string; options: Map<string, string> };
  }>;
}

const defaultRequest: GitHubTrackingRequest = (root, args) => commandJson(root, "gh", args);
const projectReadbackDelays = [0, 250, 500, 1_000, 2_000] as const;
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
const defaultWait: GitHubTrackingWait = (milliseconds) => {
  if (milliseconds > 0) Atomics.wait(waitBuffer, 0, 0, milliseconds);
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`GITHUB_TRACKING_RESPONSE_INVALID: ${field}`);
  return value;
}

function integer(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) throw new Error(`GITHUB_TRACKING_RESPONSE_INVALID: ${field}`);
  return Number(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function page(connection: unknown, name: string): { nodes: unknown[]; hasNextPage: boolean; endCursor?: string } {
  const value = record(connection);
  const nodes = value.nodes;
  const info = record(value.pageInfo);
  if (!Array.isArray(nodes) || typeof info.hasNextPage !== "boolean") {
    throw new Error(`GITHUB_TRACKING_PAGINATION_INCOMPLETE: ${name}`);
  }
  const endCursor = optionalString(info.endCursor);
  if (info.hasNextPage && !endCursor) {
    throw new Error(`GITHUB_TRACKING_PAGINATION_INCOMPLETE: ${name} omitted endCursor`);
  }
  return { nodes, hasNextPage: info.hasNextPage, ...(endCursor ? { endCursor } : {}) };
}

function nextPageCursor(
  current: { hasNextPage: boolean; endCursor?: string },
  seen: Set<string>,
  name: string,
): string | undefined {
  if (!current.hasNextPage) return undefined;
  const cursor = current.endCursor;
  if (!cursor || seen.has(cursor)) {
    throw new Error(`GITHUB_TRACKING_PAGINATION_INCOMPLETE: ${name} repeated cursor`);
  }
  seen.add(cursor);
  return cursor;
}

function configuredString(value: unknown, field: string, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`GITHUB_TRACKING_CONFIG_INVALID: ${field}`);
  }
  return value.trim();
}

function requestJson(
  root: string,
  args: string[],
  request: GitHubTrackingRequest,
  operation: string,
): unknown {
  const response = request(root, args);
  if (!response.ok) throw new Error(`GITHUB_TRACKING_${operation}_FAILED: ${scrubSensitive(response.error ?? "unknown error").slice(0, 500)}`);
  return response.value;
}

function graphql(
  root: string,
  query: string,
  variables: Record<string, string | number | undefined>,
  request: GitHubTrackingRequest,
  operation: string,
): Record<string, unknown> {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [name, value] of Object.entries(variables)) {
    if (value !== undefined) args.push(typeof value === "number" ? "-F" : "-f", `${name}=${value}`);
  }
  const value = record(requestJson(root, args, request, operation));
  const errors = value.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const detail = errors.map((entry) => optionalString(record(entry).message) ?? "unknown GraphQL error").join("; ");
    throw new Error(`GITHUB_TRACKING_${operation}_FAILED: ${scrubSensitive(detail).slice(0, 500)}`);
  }
  const data = value.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`GITHUB_TRACKING_RESPONSE_INVALID: ${operation} omitted data`);
  }
  return data as Record<string, unknown>;
}

function repositoryFrom(data: Record<string, unknown>, expected: string): Record<string, unknown> {
  const repository = record(data.repository);
  if (
    !repository.id ||
    string(repository.nameWithOwner, "repository.nameWithOwner").toLowerCase() !== expected.toLowerCase()
  ) {
    throw new Error(`GITHUB_TRACKING_REPOSITORY_MISMATCH: expected ${expected}`);
  }
  return repository;
}

function projectFrom(data: Record<string, unknown>, config: GitHubTrackingProject): Record<string, unknown> {
  const owner = record(data.repositoryOwner);
  if (owner.__typename !== "Organization" && owner.__typename !== "User") {
    throw new Error(`GITHUB_TRACKING_PROJECT_OWNER_MISSING: ${config.owner}`);
  }
  const project = record(owner.projectV2);
  if (typeof project.id !== "string") {
    throw new Error(`GITHUB_TRACKING_PROJECT_MISSING: ${config.owner}#${config.number}`);
  }
  return project;
}

function parseIssue(value: unknown): GitHubWorkItem {
  const issue = record(value);
  const state = string(issue.state, "issue.state");
  if (state !== "OPEN" && state !== "CLOSED") throw new Error("GITHUB_TRACKING_RESPONSE_INVALID: issue.state");
  return {
    id: string(issue.id, "issue.id"),
    number: integer(issue.number, "issue.number"),
    title: string(issue.title, "issue.title"),
    body: typeof issue.body === "string" ? issue.body : "",
    state,
    url: string(issue.url, "issue.url"),
    updatedAt: string(issue.updatedAt, "issue.updatedAt"),
  };
}

function projectFieldValue(value: unknown): string | undefined {
  const field = record(value);
  return optionalString(field.name) ?? optionalString(field.text) ?? optionalString(field.title) ?? optionalString(field.date);
}

function projectSelection(connection: string): string {
  return `
    repositoryOwner(login: $projectOwner) {
      __typename
      ... on Organization { projectV2(number: $projectNumber) { id ${connection} } }
      ... on User { projectV2(number: $projectNumber) { id ${connection} } }
    }`;
}

function listProjectItems(
  root: string,
  config: GitHubTrackingConfig,
  request: GitHubTrackingRequest,
): Map<number, { itemId: string; status?: string; priority?: string }> {
  const project = config.project;
  const items = new Map<number, { itemId: string; status?: string; priority?: string }>();
  if (!project) return items;
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  do {
    const connection = `items(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        content { ... on Issue { number repository { nameWithOwner } } }
        status: fieldValueByName(name: $statusField) {
          ... on ProjectV2ItemFieldSingleSelectValue { name }
          ... on ProjectV2ItemFieldTextValue { text }
        }
        priority: fieldValueByName(name: $priorityField) {
          ... on ProjectV2ItemFieldSingleSelectValue { name }
          ... on ProjectV2ItemFieldTextValue { text }
        }
      }
    }`;
    const query = `query($projectOwner: String!, $projectNumber: Int!, $statusField: String!, $priorityField: String!, $cursor: String) {
      ${projectSelection(connection)}
    }`;
    const data = graphql(root, query, {
      projectOwner: project.owner,
      projectNumber: project.number,
      statusField: project.statusField,
      priorityField: project.priorityField,
      cursor,
    }, request, "PROJECT_QUERY");
    const selected = projectFrom(data, project);
    const current = page(selected.items, "project.items");
    for (const raw of current.nodes) {
      const item = record(raw);
      const content = record(item.content);
      const repository = optionalString(record(content.repository).nameWithOwner);
      if (!repository || repository.toLowerCase() !== config.repository.toLowerCase()) continue;
      const number = integer(content.number, "project.item.issue.number");
      if (items.has(number)) throw new Error(`GITHUB_TRACKING_PROJECT_MAPPING_AMBIGUOUS: issue #${number}`);
      items.set(number, {
        itemId: string(item.id, "project.item.id"),
        status: projectFieldValue(item.status),
        priority: projectFieldValue(item.priority),
      });
    }
    cursor = nextPageCursor(current, seenCursors, "project.items");
  } while (cursor);
  return items;
}

function listProjectFields(
  root: string,
  config: GitHubTrackingProject,
  request: GitHubTrackingRequest,
): { projectId: string; fields: Map<string, { id: string; options: Map<string, string> }> } {
  const fields = new Map<string, { id: string; options: Map<string, string> }>();
  let projectId: string | undefined;
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  do {
    const connection = `fields(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        __typename
        ... on ProjectV2SingleSelectField { id name options { id name } }
        ... on ProjectV2Field { id name }
      }
    }`;
    const query = `query($projectOwner: String!, $projectNumber: Int!, $cursor: String) {
      ${projectSelection(connection)}
    }`;
    const data = graphql(root, query, {
      projectOwner: config.owner,
      projectNumber: config.number,
      cursor,
    }, request, "PROJECT_FIELDS_QUERY");
    const selected = projectFrom(data, config);
    const selectedId = string(selected.id, "project.id");
    if (projectId && projectId !== selectedId) throw new Error("GITHUB_TRACKING_PROJECT_ID_DRIFT");
    projectId = selectedId;
    const current = page(selected.fields, "project.fields");
    for (const raw of current.nodes) {
      const field = record(raw);
      const name = optionalString(field.name);
      const id = optionalString(field.id);
      if (!name || !id) continue;
      if (fields.has(name)) throw new Error(`GITHUB_TRACKING_PROJECT_FIELD_AMBIGUOUS: ${name}`);
      const options = new Map<string, string>();
      if (field.__typename === "ProjectV2SingleSelectField") {
        if (!Array.isArray(field.options)) throw new Error(`GITHUB_TRACKING_RESPONSE_INVALID: field ${name} options`);
        for (const rawOption of field.options) {
          const option = record(rawOption);
          const optionName = string(option.name, `field ${name} option name`);
          if (options.has(optionName)) throw new Error(`GITHUB_TRACKING_PROJECT_OPTION_AMBIGUOUS: ${name}/${optionName}`);
          options.set(optionName, string(option.id, `field ${name} option id`));
        }
      }
      fields.set(name, { id, options });
    }
    cursor = nextPageCursor(current, seenCursors, "project.fields");
  } while (cursor);
  if (!projectId) throw new Error(`GITHUB_TRACKING_PROJECT_MISSING: ${config.owner}#${config.number}`);
  return { projectId, fields };
}

export function loadGitHubTrackingConfig(projectRoot: string): { root: string; config: GitHubTrackingConfig } {
  const context = resolveRepositoryContext(projectRoot);
  const path = join(context.projectDir, ".github", "project-workflow.json");
  let source: unknown;
  try {
    source = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`GITHUB_TRACKING_CONFIG_INVALID: ${error instanceof Error ? error.message : String(error)}`);
  }
  const value = record(source);
  const repository = optionalString(value.repo)?.trim();
  const workflow = record(value.workflow);
  if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error("GITHUB_TRACKING_CONFIG_INVALID: repo must be owner/name");
  }
  if (workflow.sourceOfTruth !== "github-issues-project") {
    throw new Error("GITHUB_TRACKING_MODE_REQUIRED: configured sourceOfTruth is not github-issues-project");
  }
  const observedRepository = githubEndpointRepository(
    runGit(context.projectDir, ["remote", "get-url", "origin"]).trim(),
    "origin",
  );
  if (observedRepository.toLowerCase() !== repository.toLowerCase()) {
    throw new Error(`GITHUB_TRACKING_REPOSITORY_MISMATCH: configured ${repository}, observed ${observedRepository}`);
  }
  const rawProject = value.project;
  if (rawProject === undefined || rawProject === null) return { root: context.projectDir, config: { mode: "github", repository } };
  const project = record(rawProject);
  const owner = optionalString(project.owner)?.trim();
  const number = project.number;
  if (!owner || !Number.isInteger(number) || Number(number) < 1) {
    throw new Error("GITHUB_TRACKING_CONFIG_INVALID: project owner/number");
  }
  const configured: GitHubTrackingProject = {
    owner,
    number: Number(number),
    statusField: configuredString(project.statusField, "project.statusField", "Status"),
    defaultStatus: configuredString(project.defaultStatus, "project.defaultStatus", "Todo"),
    priorityField: configuredString(project.priorityField, "project.priorityField", "Priority"),
    defaultPriority: configuredString(project.defaultPriority, "project.defaultPriority", "medium"),
  };
  return { root: context.projectDir, config: { mode: "github", repository, project: configured } };
}

export function listGitHubWorkItems(args: {
  root: string;
  config: GitHubTrackingConfig;
  request?: GitHubTrackingRequest;
}): { mode: "github"; repository: string; repositoryId: string; items: GitHubWorkItem[] } {
  const request = args.request ?? defaultRequest;
  const issues: GitHubWorkItem[] = [];
  const issueNumbers = new Set<number>();
  let repositoryId: string | undefined;
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  do {
    const query = `query($owner: String!, $name: String!, $cursor: String) {
      repository(owner: $owner, name: $name) {
        id nameWithOwner
        issues(first: 100, after: $cursor, orderBy: {field: CREATED_AT, direction: ASC}) {
          pageInfo { hasNextPage endCursor }
          nodes { id number title body state url updatedAt }
        }
      }
    }`;
    const [owner, name] = args.config.repository.split("/", 2);
    const data = graphql(args.root, query, { owner, name, cursor }, request, "ISSUE_LIST");
    const repository = repositoryFrom(data, args.config.repository);
    const selectedId = string(repository.id, "repository.id");
    if (repositoryId && repositoryId !== selectedId) throw new Error("GITHUB_TRACKING_REPOSITORY_ID_DRIFT");
    repositoryId = selectedId;
    const current = page(repository.issues, "repository.issues");
    for (const node of current.nodes) {
      const issue = parseIssue(node);
      if (issueNumbers.has(issue.number)) {
        throw new Error(`GITHUB_TRACKING_ISSUE_MAPPING_AMBIGUOUS: issue #${issue.number}`);
      }
      issueNumbers.add(issue.number);
      issues.push(issue);
    }
    cursor = nextPageCursor(current, seenCursors, "repository.issues");
  } while (cursor);
  if (!repositoryId) throw new Error("GITHUB_TRACKING_RESPONSE_INVALID: repository.id");
  const projectItems = listProjectItems(args.root, args.config, request);
  return {
    mode: "github",
    repository: args.config.repository,
    repositoryId,
    items: issues.map((issue) => {
      const project = projectItems.get(issue.number);
      return project ? {
        ...issue,
        projectItemId: project.itemId,
        ...(project.status ? { projectStatus: project.status } : {}),
        ...(project.priority ? { projectPriority: project.priority } : {}),
      } : issue;
    }),
  };
}

export function readGitHubWorkItem(args: {
  root: string;
  config: GitHubTrackingConfig;
  issue: number;
  request?: GitHubTrackingRequest;
}): GitHubWorkItem {
  if (!Number.isInteger(args.issue) || args.issue < 1) throw new Error("GITHUB_TRACKING_ISSUE_INVALID");
  const request = args.request ?? defaultRequest;
  const value = requestJson(args.root, ["api", "--method", "GET", `repos/${args.config.repository}/issues/${args.issue}`], request, "ISSUE_READ");
  const issue = record(value);
  if (issue.pull_request !== undefined) throw new Error(`GITHUB_TRACKING_WORK_ITEM_NOT_ISSUE: #${args.issue}`);
  const parsed = parseIssue({
    ...issue,
    id: issue.node_id,
    url: issue.html_url ?? issue.url,
    updatedAt: issue.updated_at,
    state: typeof issue.state === "string" ? issue.state.toUpperCase() : issue.state,
  });
  if (parsed.number !== args.issue) throw new Error(`GITHUB_TRACKING_READBACK_MISMATCH: expected issue #${args.issue}`);
  const project = listProjectItems(args.root, args.config, request).get(args.issue);
  return project ? {
    ...parsed,
    projectItemId: project.itemId,
    ...(project.status ? { projectStatus: project.status } : {}),
    ...(project.priority ? { projectPriority: project.priority } : {}),
  } : parsed;
}

function addProjectItem(
  root: string,
  projectId: string,
  contentId: string,
  request: GitHubTrackingRequest,
): void {
  const mutation = `mutation($projectId: ID!, $contentId: ID!) {
    addProjectV2ItemById(input: {projectId: $projectId, contentId: $contentId}) { item { id } }
  }`;
  graphql(root, mutation, { projectId, contentId }, request, "PROJECT_ITEM_ADD");
}

function setProjectField(
  root: string,
  projectId: string,
  itemId: string,
  fieldName: string,
  field: { id: string; options: Map<string, string> },
  selected: string,
  request: GitHubTrackingRequest,
): void {
  const optionId = field.options.get(selected);
  if (!optionId) {
    throw new Error(`GITHUB_TRACKING_PROJECT_OPTION_MISSING: ${fieldName}/${selected}`);
  }
  const mutation = `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
    updateProjectV2ItemFieldValue(input: {
      projectId: $projectId, itemId: $itemId, fieldId: $fieldId,
      value: {singleSelectOptionId: $optionId}
    }) { projectV2Item { id } }
  }`;
  graphql(root, mutation, { projectId, itemId, fieldId: field.id, optionId }, request, "PROJECT_FIELD_UPDATE");
}

function prepareProjectWrite(
  root: string,
  config: GitHubTrackingConfig,
  values: { status?: string; priority?: string },
  request: GitHubTrackingRequest,
): PreparedProjectWrite | undefined {
  const project = config.project;
  if (!project) {
    if (values.status !== undefined || values.priority !== undefined) {
      throw new Error("GITHUB_TRACKING_PROJECT_NOT_CONFIGURED");
    }
    return undefined;
  }
  const metadata = listProjectFields(root, project, request);
  const updates = ([
    [project.statusField, values.status],
    [project.priorityField, values.priority],
  ] as const).flatMap(([name, selected]) => {
    if (selected === undefined) return [];
    const field = metadata.fields.get(name);
    if (!field) throw new Error(`GITHUB_TRACKING_PROJECT_FIELD_MISSING: ${name}`);
    if (!field.options.has(selected)) {
      throw new Error(`GITHUB_TRACKING_PROJECT_OPTION_MISSING: ${name}/${selected}`);
    }
    return [{ name, selected, field }];
  });
  return { projectId: metadata.projectId, updates };
}

function partialMutationError(issue: number, completed: string[], error: unknown): Error {
  const detail = scrubSensitive(error instanceof Error ? error.message : String(error)).slice(0, 500);
  return new Error(
    `GITHUB_TRACKING_PARTIAL_MUTATION: issue #${issue}; completed=${completed.join(",")}; inspect the existing Issue and Project item before retrying; ${detail}`,
  );
}

function readProjectItemAfterMutation(
  root: string,
  config: GitHubTrackingConfig,
  issue: number,
  request: GitHubTrackingRequest,
  wait: GitHubTrackingWait,
  matches: (item: { itemId: string; status?: string; priority?: string }) => boolean,
): { itemId: string; status?: string; priority?: string } {
  for (const delay of projectReadbackDelays) {
    wait(delay);
    const item = listProjectItems(root, config, request).get(issue);
    if (item && matches(item)) return item;
  }
  throw new Error(
    `GITHUB_TRACKING_READBACK_TIMEOUT: issue #${issue}; remote Project mutation succeeded but its result is not yet verifiable; inspect the existing Issue and Project item before retrying`,
  );
}

function writeProject(
  root: string,
  config: GitHubTrackingConfig,
  issue: GitHubWorkItem,
  values: { status?: string; priority?: string },
  request: GitHubTrackingRequest,
  wait: GitHubTrackingWait,
  prepared: PreparedProjectWrite | undefined,
  completed: string[],
): GitHubWorkItem {
  const project = config.project;
  if (!project) {
    return issue;
  }
  if (!prepared) throw new Error("GITHUB_TRACKING_PROJECT_PREFLIGHT_REQUIRED");
  let item = listProjectItems(root, config, request).get(issue.number);
  if (!item) {
    addProjectItem(root, prepared.projectId, issue.id, request);
    completed.push("project:item-add");
    item = readProjectItemAfterMutation(
      root,
      config,
      issue.number,
      request,
      wait,
      () => true,
    );
  }
  for (const update of prepared.updates) {
    setProjectField(root, prepared.projectId, item.itemId, update.name, update.field, update.selected, request);
    completed.push(`project:field:${update.name}`);
  }
  const readback = readProjectItemAfterMutation(
    root,
    config,
    issue.number,
    request,
    wait,
    (candidate) =>
      (values.status === undefined || candidate.status === values.status) &&
      (values.priority === undefined || candidate.priority === values.priority),
  );
  return {
    ...issue,
    projectItemId: readback.itemId,
    ...(readback.status ? { projectStatus: readback.status } : {}),
    ...(readback.priority ? { projectPriority: readback.priority } : {}),
  };
}

export function createGitHubWorkItem(args: {
  root: string;
  config: GitHubTrackingConfig;
  title: string;
  body?: string;
  status?: string;
  priority?: string;
  request?: GitHubTrackingRequest;
  wait?: GitHubTrackingWait;
}): GitHubWorkItem {
  const title = args.title.trim();
  if (!title) throw new Error("GITHUB_TRACKING_TITLE_REQUIRED");
  const body = args.body ?? "";
  const request = args.request ?? defaultRequest;
  const values = {
    status: args.status ?? args.config.project?.defaultStatus,
    priority: args.priority ?? args.config.project?.defaultPriority,
  };
  const prepared = prepareProjectWrite(args.root, args.config, values, request);
  const completed: string[] = [];
  let number: number | undefined;
  try {
    const created = record(requestJson(args.root, [
      "api", "--method", "POST", `repos/${args.config.repository}/issues`,
      "-f", `title=${title}`, "-f", `body=${body}`,
    ], request, "ISSUE_CREATE"));
    number = integer(created.number, "created issue.number");
    completed.push("issue:create");
    const readback = readGitHubWorkItem({ root: args.root, config: { ...args.config, project: undefined }, issue: number, request });
    const createdId = optionalString(created.node_id);
    if (
      (createdId !== undefined && readback.id !== createdId) ||
      readback.title !== title ||
      readback.body !== body ||
      readback.state !== "OPEN"
    ) {
      throw new Error(`GITHUB_TRACKING_READBACK_MISMATCH: issue #${number}`);
    }
    return writeProject(args.root, args.config, readback, values, request, args.wait ?? defaultWait, prepared, completed);
  } catch (error) {
    if (number !== undefined && completed.length > 0) throw partialMutationError(number, completed, error);
    throw error;
  }
}

export function updateGitHubWorkItem(args: {
  root: string;
  config: GitHubTrackingConfig;
  issue: number;
  title?: string;
  body?: string;
  state?: "open" | "closed";
  status?: string;
  priority?: string;
  request?: GitHubTrackingRequest;
  wait?: GitHubTrackingWait;
}): GitHubWorkItem {
  if (!Number.isInteger(args.issue) || args.issue < 1) throw new Error("GITHUB_TRACKING_ISSUE_INVALID");
  const request = args.request ?? defaultRequest;
  const issueUpdates = [args.title, args.body, args.state].some((value) => value !== undefined);
  if (!issueUpdates && args.status === undefined && args.priority === undefined) {
    throw new Error("GITHUB_TRACKING_UPDATE_REQUIRED");
  }
  if (args.title !== undefined && !args.title.trim()) throw new Error("GITHUB_TRACKING_TITLE_REQUIRED");
  const values = { status: args.status, priority: args.priority };
  const prepared = prepareProjectWrite(args.root, args.config, values, request);
  const completed: string[] = [];
  try {
    if (issueUpdates) {
      const requestArgs = ["api", "--method", "PATCH", `repos/${args.config.repository}/issues/${args.issue}`];
      if (args.title !== undefined) requestArgs.push("-f", `title=${args.title.trim()}`);
      if (args.body !== undefined) requestArgs.push("-f", `body=${args.body}`);
      if (args.state !== undefined) requestArgs.push("-f", `state=${args.state}`);
      requestJson(args.root, requestArgs, request, "ISSUE_UPDATE");
      completed.push("issue:update");
    }
    const readback = readGitHubWorkItem({ root: args.root, config: { ...args.config, project: undefined }, issue: args.issue, request });
    if (
      (args.title !== undefined && readback.title !== args.title.trim()) ||
      (args.body !== undefined && readback.body !== args.body) ||
      (args.state !== undefined && readback.state !== args.state.toUpperCase())
    ) {
      throw new Error(`GITHUB_TRACKING_READBACK_MISMATCH: issue #${args.issue}`);
    }
    return writeProject(
      args.root,
      args.config,
      readback,
      values,
      request,
      args.wait ?? defaultWait,
      prepared,
      completed,
    );
  } catch (error) {
    if (completed.length > 0) throw partialMutationError(args.issue, completed, error);
    throw error;
  }
}
