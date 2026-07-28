import { spawnSync } from "node:child_process";
import type {
  ProviderItemObservation,
  ProviderObservation,
  WorktreeDeliveryConfig,
  WorkspaceLease,
} from "./types.js";

function commandJson(cwd: string, command: string, args: string[]): {
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

function findIssueNumber(node: unknown): number | null {
  if (Array.isArray(node)) {
    for (const value of node) {
      const found = findIssueNumber(value);
      if (found !== null) return found;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  const object = node as Record<string, unknown>;
  if (typeof object.number === "number") return object.number;
  for (const value of Object.values(object)) {
    const found = findIssueNumber(value);
    if (found !== null) return found;
  }
  return null;
}

function findConfiguredField(node: unknown, fieldName: string): string | undefined {
  if (Array.isArray(node)) {
    for (const value of node) {
      const found = findConfiguredField(value, fieldName);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!node || typeof node !== "object") return undefined;
  const object = node as Record<string, unknown>;
  const direct = object[fieldName];
  if (typeof direct === "string") return direct;
  const field = object.field;
  if (field && typeof field === "object") {
    const fieldObject = field as Record<string, unknown>;
    if (fieldObject.name === fieldName || fieldObject.title === fieldName) {
      for (const key of ["name", "optionName", "text", "value"]) {
        if (typeof object[key] === "string" && object[key] !== fieldName) {
          return object[key] as string;
        }
      }
    }
  }
  for (const value of Object.values(object)) {
    const found = findConfiguredField(value, fieldName);
    if (found !== undefined) return found;
  }
  return undefined;
}

function projectItems(
  root: string,
  config: WorktreeDeliveryConfig,
): { items: unknown[]; error?: string } {
  const project = config.provider.project;
  if (!project) return { items: [] };
  const result = commandJson(root, "gh", [
    "project",
    "item-list",
    String(project.number),
    "--owner",
    project.owner,
    "--limit",
    "1000",
    "--format",
    "json",
  ]);
  if (!result.ok) return { items: [], error: result.error };
  if (Array.isArray(result.value)) return { items: result.value };
  if (result.value && typeof result.value === "object") {
    const items = (result.value as Record<string, unknown>).items;
    if (Array.isArray(items)) return { items };
  }
  return { items: [] };
}

export function observeProvider(
  root: string,
  config: WorktreeDeliveryConfig,
  observedLeases: WorkspaceLease[],
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
  if (!repository) {
    return {
      kind: "github",
      configured: true,
      available: false,
      items: [],
      error: "GitHub provider requires repository",
    };
  }
  const project = projectItems(root, config);
  if (project.error) {
    return {
      kind: "github",
      configured: true,
      available: false,
      items: [],
      error: project.error,
    };
  }
  const items: ProviderItemObservation[] = [];
  for (const lease of observedLeases) {
    const match = lease.workItem.match(/#(\d+)$/u);
    if (!match) {
      return {
        kind: "github",
        configured: true,
        available: false,
        items,
        error: `GitHub work item must end with #<number>: ${lease.workItem}`,
      };
    }
    const number = Number(match[1]);
    const issue = commandJson(root, "gh", [
      "issue",
      "view",
      String(number),
      "--repo",
      repository,
      "--json",
      "number,state,title,url",
    ]);
    if (!issue.ok) {
      return {
        kind: "github",
        configured: true,
        available: false,
        items,
        error: issue.error,
      };
    }
    const issueValue = issue.value as Record<string, unknown>;
    const projectItem = project.items.find((item) => findIssueNumber(item) === number);
    items.push({
      workItem: lease.workItem,
      state: String(issueValue.state ?? "UNKNOWN"),
      projectItemPresent: config.provider.project ? projectItem !== undefined : undefined,
      projectStatus: config.provider.project && projectItem
        ? findConfiguredField(projectItem, config.provider.project.statusField)
        : undefined,
      url: typeof issueValue.url === "string" ? issueValue.url : undefined,
    });
  }
  return { kind: "github", configured: true, available: true, items };
}
