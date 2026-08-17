import { spawnSync } from "node:child_process";
import type {
  ProviderItemObservation,
  ProviderObservation,
  WorktreeDeliveryConfig,
  WorkspaceLease,
} from "./types.js";

export function commandJson(cwd: string, command: string, args: string[]): {
  ok: boolean;
  value?: unknown;
  error?: string;
} {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30_000,
  });
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      error: `${result.stderr ?? result.stdout ?? result.error ?? ""}`.trim() ||
        `${command} exited ${result.status ?? "without status"}`,
    };
  }
  try {
    return { ok: true, value: JSON.parse(result.stdout) as unknown };
  } catch {
    return { ok: false, error: `${command} returned invalid JSON` };
  }
}

function workItems(
  leases: WorkspaceLease[],
  additionalWorkItems: string[],
): string[] {
  return [...new Set([
    ...leases.map((lease) => lease.workItem),
    ...additionalWorkItems,
  ])];
}

function issueNumber(workItem: string, repository: string): number | null {
  const prefix = `github:${repository}#`;
  if (!workItem.startsWith(prefix)) return null;
  const value = workItem.slice(prefix.length);
  return /^\d+$/u.test(value) ? Number(value) : null;
}

function projectFieldValue(node: unknown): string | undefined {
  if (!node || typeof node !== "object") return undefined;
  const value = node as Record<string, unknown>;
  for (const key of ["name", "text", "title", "date"]) {
    if (typeof value[key] === "string") return value[key];
  }
  return undefined;
}

function ownerLogin(node: unknown): string | undefined {
  if (!node || typeof node !== "object") return undefined;
  const login = (node as Record<string, unknown>).login;
  return typeof login === "string" ? login : undefined;
}

function graphQlRateLimitError(root: string, error: string): string {
  if (!/rate limit|rate_limit|API rate limit exceeded/iu.test(error)) {
    return `GITHUB_PROJECT_QUERY_FAILED: ${error}`;
  }
  const rateLimit = commandJson(root, "gh", ["api", "rate_limit"]);
  const resources = rateLimit.value && typeof rateLimit.value === "object"
    ? (rateLimit.value as Record<string, unknown>).resources
    : undefined;
  const graphQl = resources && typeof resources === "object"
    ? (resources as Record<string, unknown>).graphql
    : undefined;
  const reset = graphQl && typeof graphQl === "object"
    ? (graphQl as Record<string, unknown>).reset
    : undefined;
  const resetAt = typeof reset === "number" && Number.isFinite(reset)
    ? `; resetAt=${new Date(reset * 1000).toISOString()}`
    : "";
  return `GITHUB_GRAPHQL_RATE_LIMITED${resetAt}: ${error}`;
}

function projectItems(
  root: string,
  repository: string,
  project: NonNullable<WorktreeDeliveryConfig["provider"]["project"]>,
  numbers: number[],
): { values: Map<number, { present: boolean; status?: string }>; error?: string } {
  const values = new Map<number, { present: boolean; status?: string }>();
  if (numbers.length === 0) return { values };
  const [owner, name] = repository.split("/", 2);
  const selections = numbers.map((number, index) => `
    issue${index}: issue(number: ${number}) {
      projectItems(first: 100, includeArchived: true) {
        pageInfo { hasNextPage }
        nodes {
          project {
            number
            owner {
              __typename
              ... on User { login }
              ... on Organization { login }
            }
          }
          configuredField: fieldValueByName(name: $statusField) {
            __typename
            ... on ProjectV2ItemFieldSingleSelectValue { name }
            ... on ProjectV2ItemFieldTextValue { text }
            ... on ProjectV2ItemFieldIterationValue { title }
            ... on ProjectV2ItemFieldDateValue { date }
          }
        }
      }
    }`).join("\n");
  const query = `query($owner: String!, $name: String!, $statusField: String!) {
    repository(owner: $owner, name: $name) {${selections}
    }
  }`;
  const result = commandJson(root, "gh", [
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
    "-f",
    `statusField=${project.statusField}`,
  ]);
  if (!result.ok) {
    return { values, error: graphQlRateLimitError(root, result.error ?? "unknown error") };
  }
  const errors = result.value && typeof result.value === "object"
    ? (result.value as Record<string, unknown>).errors
    : undefined;
  if (Array.isArray(errors) && errors.length > 0) {
    const detail = errors.map((error) =>
      error && typeof error === "object" && typeof (error as Record<string, unknown>).message === "string"
        ? (error as Record<string, unknown>).message
        : "unknown GraphQL error").join("; ");
    return { values, error: graphQlRateLimitError(root, detail) };
  }
  const data = result.value && typeof result.value === "object"
    ? (result.value as Record<string, unknown>).data
    : undefined;
  const repositoryValue = data && typeof data === "object"
    ? (data as Record<string, unknown>).repository
    : undefined;
  if (!repositoryValue || typeof repositoryValue !== "object") {
    return { values, error: "GITHUB_PROJECT_QUERY_FAILED: GraphQL response omitted repository" };
  }
  numbers.forEach((number, index) => {
    const issue = (repositoryValue as Record<string, unknown>)[`issue${index}`];
    if (!issue || typeof issue !== "object") return;
    const connection = issue && typeof issue === "object"
      ? (issue as Record<string, unknown>).projectItems
      : undefined;
    const nodes = connection && typeof connection === "object"
      ? (connection as Record<string, unknown>).nodes
      : undefined;
    const pageInfo = connection && typeof connection === "object"
      ? (connection as Record<string, unknown>).pageInfo
      : undefined;
    if (
      !Array.isArray(nodes) ||
      !pageInfo ||
      typeof pageInfo !== "object" ||
      typeof (pageInfo as Record<string, unknown>).hasNextPage !== "boolean"
    ) return;
    const match = Array.isArray(nodes) ? nodes.find((candidate) => {
      if (!candidate || typeof candidate !== "object") return false;
      const candidateProject = (candidate as Record<string, unknown>).project;
      if (!candidateProject || typeof candidateProject !== "object") return false;
      const record = candidateProject as Record<string, unknown>;
      return record.number === project.number &&
        ownerLogin(record.owner)?.toLowerCase() === project.owner.toLowerCase();
    }) : undefined;
    if (
      match === undefined &&
      (pageInfo as Record<string, unknown>).hasNextPage === true
    ) {
      return;
    }
    values.set(number, {
      present: match !== undefined,
      status: match && typeof match === "object"
        ? projectFieldValue((match as Record<string, unknown>).configuredField)
        : undefined,
    });
  });
  const missing = numbers.find((number) => !values.has(number));
  if (missing !== undefined) {
    const issue = (repositoryValue as Record<string, unknown>)[
      `issue${numbers.indexOf(missing)}`
    ];
    const connection = issue && typeof issue === "object"
      ? (issue as Record<string, unknown>).projectItems
      : undefined;
    const pageInfo = connection && typeof connection === "object"
      ? (connection as Record<string, unknown>).pageInfo
      : undefined;
    if (
      pageInfo &&
      typeof pageInfo === "object" &&
      (pageInfo as Record<string, unknown>).hasNextPage === true
    ) {
      return {
        values,
        error: `GITHUB_PROJECT_MAPPING_TRUNCATED: Issue #${missing} has more than 100 Project items`,
      };
    }
    return {
      values,
      error: `GITHUB_PROJECT_QUERY_FAILED: GraphQL response omitted Issue #${missing} Project items`,
    };
  }
  return { values };
}

export function observeProvider(
  root: string,
  config: WorktreeDeliveryConfig,
  observedLeases: WorkspaceLease[],
  additionalWorkItems: string[] = [],
): ProviderObservation {
  if (config.provider.kind === "none") {
    return { kind: "none", configured: false, available: true, items: [] };
  }
  if (config.provider.kind !== "github") {
    return {
      kind: config.provider.kind,
      configured: true,
      available: false,
      items: [],
      error: `${config.provider.kind} adapter is not installed`,
    };
  }
  const repository = config.provider.repository?.trim();
  if (!repository || !/^[^/]+\/[^/]+$/u.test(repository)) {
    return {
      kind: "github",
      configured: true,
      available: false,
      items: [],
      error: "GitHub provider requires repository",
    };
  }
  const requested = workItems(observedLeases, additionalWorkItems);
  const numbered = requested.map((workItem) => ({
    workItem,
    number: issueNumber(workItem, repository),
  }));
  const invalid = numbered.find((item) => item.number === null);
  if (invalid) {
    return {
      kind: "github",
      configured: true,
      available: false,
      items: [],
      error: `GitHub work item must match github:${repository}#<number>: ${invalid.workItem}`,
    };
  }

  const items: ProviderItemObservation[] = [];
  for (const item of numbered) {
    const issue = commandJson(root, "gh", [
      "api",
      "--method",
      "GET",
      `repos/${repository}/issues/${item.number}`,
    ]);
    if (!issue.ok) {
      return {
        kind: "github",
        configured: true,
        available: false,
        items,
        error: `GITHUB_ISSUE_QUERY_FAILED: ${issue.error}`,
      };
    }
    const value = issue.value as Record<string, unknown>;
    if (value.pull_request !== undefined) {
      return {
        kind: "github",
        configured: true,
        available: false,
        items,
        error: `GITHUB_WORK_ITEM_NOT_ISSUE: ${item.workItem}`,
      };
    }
    items.push({
      workItem: item.workItem,
      state: String(value.state ?? "UNKNOWN").toUpperCase(),
      url: typeof value.html_url === "string"
        ? value.html_url
        : typeof value.url === "string"
          ? value.url
          : undefined,
    });
  }

  const project = config.provider.project;
  if (!project) {
    return { kind: "github", configured: true, available: true, items };
  }
  const observedProject = projectItems(
    root,
    repository,
    project,
    numbered.map((item) => item.number as number),
  );
  for (const [index, item] of numbered.entries()) {
    const value = observedProject.values.get(item.number as number);
    items[index].projectItemPresent = value?.present;
    items[index].projectStatus = value?.status;
  }
  if (observedProject.error) {
    return {
      kind: "github",
      configured: true,
      available: false,
      items,
      error: observedProject.error,
    };
  }
  return { kind: "github", configured: true, available: true, items };
}
