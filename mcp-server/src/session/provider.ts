import { commandJson } from "../worktree/provider.js";
import type { WorktreeDeliveryConfig } from "../worktree/types.js";
import type { ParsedWorkItem } from "./types.js";

/**
 * session 命令组的 GitHub provider 适配：复用 worktree 命令组同一 `gh` CLI 凭据通道
 * （gh auth），不引入任何新凭据机制。只做 issue 读取、评论追加与 ProjectV2 字段更新。
 */

export function readIssue(
  root: string,
  workItem: ParsedWorkItem,
): { state: string; title: string; body: string; url: string } {
  const result = commandJson(root, "gh", [
    "api",
    "--method",
    "GET",
    `repos/${workItem.owner}/${workItem.repository}/issues/${workItem.number}`,
  ]);
  if (!result.ok) {
    throw new Error(`GITHUB_ISSUE_QUERY_FAILED: ${result.error ?? "unknown error"}`);
  }
  const value = result.value as Record<string, unknown>;
  if (value.pull_request !== undefined) {
    throw new Error(`GITHUB_WORK_ITEM_NOT_ISSUE: ${workItem.workItem}`);
  }
  return {
    state: String(value.state ?? "UNKNOWN").toUpperCase(),
    title: typeof value.title === "string" ? value.title : "",
    body: typeof value.body === "string" ? value.body : "",
    url: typeof value.html_url === "string"
      ? value.html_url
      : typeof value.url === "string"
        ? value.url
        : `https://github.com/${workItem.owner}/${workItem.repository}/issues/${workItem.number}`,
  };
}

interface ProjectFieldRead {
  present: boolean;
  value?: string;
}

/** 读取 issue 在指定 Project 上的字段值（文本或单选）。 */
export function readProjectField(
  root: string,
  repository: string,
  project: NonNullable<WorktreeDeliveryConfig["provider"]["project"]>,
  issueNumber: number,
  fieldName: string,
): ProjectFieldRead {
  const [owner, name] = repository.split("/", 2);
  const query = `query($owner: String!, $name: String!, $projectNumber: Int!, $issueNumber: Int!, $field: String!) {
    repository(owner: $owner, name: $name) {
      issue(number: $issueNumber) {
        projectItems(first: 100) {
          nodes {
            project { number owner { __typename ... on User { login } ... on Organization { login } } }
            fieldValues(first: 20) {
              nodes {
                ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } }
                ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } }
              }
            }
          }
        }
      }
    }
  }`;
  const result = commandJson(root, "gh", [
    "api", "graphql", "-f", `query=${query}`,
    "-f", `owner=${owner}`, "-f", `name=${name}`,
    "-f", `projectNumber=${project.number}`,
    "-f", `issueNumber=${issueNumber}`,
    "-f", `field=${fieldName}`,
  ]);
  if (!result.ok) {
    throw new Error(`GITHUB_PROJECT_QUERY_FAILED: ${result.error ?? "unknown error"}`);
  }
  const value = result.value as { data?: { repository?: { issue?: { projectItems?: { nodes?: Array<{
    project?: { number?: number; owner?: { login?: string } };
    fieldValues?: { nodes?: Array<{ text?: string; name?: string; field?: { name?: string } }> };
  }> } } } } };
  const issue = value.data?.repository?.issue;
  if (!issue) return { present: false };
  const node = issue.projectItems?.nodes?.find((candidate) =>
    candidate.project?.number === project.number &&
    candidate.project.owner?.login?.toLowerCase() === project.owner.toLowerCase(),
  );
  if (!node) return { present: false };
  const field = node.fieldValues?.nodes?.find((candidate) =>
    candidate.field?.name === fieldName,
  );
  if (!field) return { present: false };
  return { present: true, value: field.text ?? field.name };
}

interface ProjectFieldUpdate {
  fieldName: string;
  applied: boolean;
  error?: string;
}

interface ProjectWriteContext {
  projectId: string;
  itemId: string;
  field: {
    id: string;
    kind: "text" | "single-select";
    options: Array<{ id: string; name: string }>;
  };
}

function projectWriteContext(
  root: string,
  repository: string,
  project: NonNullable<WorktreeDeliveryConfig["provider"]["project"]>,
  issueNumber: number,
  fieldName: string,
): ProjectWriteContext {
  const [owner, name] = repository.split("/", 2);
  const query = `query($owner: String!, $name: String!, $projectNumber: Int!, $issueNumber: Int!, $field: String!) {
    repository(owner: $owner, name: $name) {
      issue(number: $issueNumber) {
        projectItems(first: 100) {
          nodes {
            id
            project { number owner { __typename ... on User { login } ... on Organization { login } } }
          }
        }
      }
      projectV2(number: $projectNumber) {
        id
        fields(first: 100) {
          nodes {
            __typename
            ... on ProjectV2Field { id name }
            ... on ProjectV2SingleSelectField { id name options { id name } }
          }
        }
      }
    }
  }`;
  const result = commandJson(root, "gh", [
    "api", "graphql", "-f", `query=${query}`,
    "-f", `owner=${owner}`, "-f", `name=${name}`,
    "-f", `projectNumber=${project.number}`,
    "-f", `issueNumber=${issueNumber}`,
    "-f", `field=${fieldName}`,
  ]);
  if (!result.ok) {
    throw new Error(`GITHUB_PROJECT_QUERY_FAILED: ${result.error ?? "unknown error"}`);
  }
  const value = result.value as { data?: { repository?: {
    issue?: { projectItems?: { nodes?: Array<{ id?: string; project?: { number?: number; owner?: { login?: string } } }> } };
    projectV2?: { id?: string; fields?: { nodes?: Array<{
      __typename?: string;
      id?: string;
      name?: string;
      options?: Array<{ id?: string; name?: string }>;
    }> } };
  } } };
  const repositoryValue = value.data?.repository;
  const itemNode = repositoryValue?.issue?.projectItems?.nodes?.find((candidate) =>
    candidate.project?.number === project.number &&
    candidate.project.owner?.login?.toLowerCase() === project.owner.toLowerCase(),
  );
  const projectNode = repositoryValue?.projectV2;
  if (!projectNode?.id || !itemNode?.id) {
    throw new Error(`GITHUB_PROJECT_MAPPING_MISSING: issue #${issueNumber} is not present in project #${project.number}`);
  }
  const fieldNode = projectNode.fields?.nodes?.find((candidate) => candidate.name === fieldName);
  if (!fieldNode?.id) {
    throw new Error(`GITHUB_PROJECT_FIELD_MISSING: project #${project.number} has no field "${fieldName}"`);
  }
  const kind = fieldNode.__typename === "ProjectV2SingleSelectField" ? "single-select" : "text";
  return {
    projectId: projectNode.id,
    itemId: itemNode.id,
    field: {
      id: fieldNode.id,
      kind,
      options: (fieldNode.options ?? []).map((option) => ({
        id: option.id ?? "",
        name: option.name ?? "",
      })),
    },
  };
}

/** 更新 issue 在 Project 看板上的字段（文本或单选），返回逐字段结果。 */
export function updateProjectField(
  root: string,
  repository: string,
  project: NonNullable<WorktreeDeliveryConfig["provider"]["project"]>,
  issueNumber: number,
  fieldName: string,
  fieldValue: string,
): ProjectFieldUpdate {
  try {
    const context = projectWriteContext(root, repository, project, issueNumber, fieldName);
    const valueInput = context.field.kind === "single-select"
      ? (() => {
          const option = context.field.options.find((candidate) => candidate.name === fieldValue);
          if (!option) {
            throw new Error(
              `GITHUB_PROJECT_OPTION_MISSING: field "${fieldName}" has no option "${fieldValue}"` +
              ` (available: ${context.field.options.map((candidate) => candidate.name).join(", ") || "none"})`,
            );
          }
          return `{ singleSelectOptionId: "${option.id}" }`;
        })()
      : `{ text: ${JSON.stringify(fieldValue)} }`;
    const mutation = `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
      updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: $value }) {
        clientMutationId
      }
    }`;
    const result = commandJson(root, "gh", [
      "api", "graphql", "-f", `query=${mutation}`,
      "-f", `projectId=${context.projectId}`,
      "-f", `itemId=${context.itemId}`,
      "-f", `fieldId=${context.field.id}`,
      "-F", `value=${valueInput}`,
    ]);
    if (!result.ok) {
      return { fieldName, applied: false, error: `GITHUB_PROJECT_UPDATE_FAILED: ${result.error ?? "unknown error"}` };
    }
    const errors = (result.value as { errors?: Array<{ message?: string }> }).errors;
    if (Array.isArray(errors) && errors.length > 0) {
      const detail = errors.map((error) => error.message ?? "unknown GraphQL error").join("; ");
      return { fieldName, applied: false, error: `GITHUB_PROJECT_UPDATE_FAILED: ${detail}` };
    }
    return { fieldName, applied: true };
  } catch (error) {
    return { fieldName, applied: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 向 issue 追加 receipts 评论；body 为确定性 JSON 列表（回执 id 列表）。 */
export function appendReceiptsComment(
  root: string,
  workItem: ParsedWorkItem,
  receiptIds: string[],
): { applied: boolean; error?: string } {
  try {
    const result = commandJson(root, "gh", [
      "api",
      "--method",
      "POST",
      `repos/${workItem.owner}/${workItem.repository}/issues/${workItem.number}/comments`,
      "-f",
      `body=${JSON.stringify(receiptIds)}`,
    ]);
    if (!result.ok) {
      return { applied: false, error: `GITHUB_ISSUE_COMMENT_FAILED: ${result.error ?? "unknown error"}` };
    }
    return { applied: true };
  } catch (error) {
    return { applied: false, error: error instanceof Error ? error.message : String(error) };
  }
}
