import { z } from "zod";

export const SESSION_WORKFLOW_SCHEMA_VERSION = "session-workflow/1.0" as const;
export const SESSION_HANDOFF_RECEIPT_SCHEMA_VERSION = "session-handoff/1.0" as const;

/** GitHub 形式的 work item：github:<owner>/<repo>#<number> */
export const WORK_ITEM_PATTERN = /^github:([^/]+)\/([^/]+)#(\d+)$/u;

export interface ParsedWorkItem {
  provider: "github";
  owner: string;
  repository: string;
  number: number;
  /** github:<owner>/<repo>#<number>，规范化后的完整形式 */
  workItem: string;
}

export function parseWorkItem(input: string): ParsedWorkItem | null {
  const match = WORK_ITEM_PATTERN.exec(input.trim());
  if (!match) return null;
  return {
    provider: "github",
    owner: match[1],
    repository: match[2],
    number: Number(match[3]),
    workItem: `github:${match[1]}/${match[2]}#${match[3]}`,
  };
}

const thresholdsSchema = z.object({
  turns: z.number().int().positive(),
  steps: z.number().int().positive(),
  llmMinutes: z.number().int().positive(),
  titleChanges: z.number().int().nonnegative(),
  retries: z.number().int().nonnegative(),
  inboxSplices: z.number().int().nonnegative(),
  inputTokens: z.number().int().positive(),
});

const templatesSchema = z.object({
  handoff: z.string().min(1),
  seed: z.string().min(1),
});

const providerProjectSchema = z.object({
  handoffDocField: z.string().min(1),
  acceptanceField: z.string().min(1),
  statusValues: z.record(z.string(), z.string().min(1)).refine(
    (values) =>
      "in-progress" in values && "ready-for-review" in values,
    "statusValues must map both in-progress and ready-for-review",
  ),
});

const seedSchema = z.object({
  constraints: z.string().min(1),
});

export const sessionWorkflowSchema = z.object({
  schemaVersion: z.literal(SESSION_WORKFLOW_SCHEMA_VERSION),
  thresholds: thresholdsSchema,
  templates: templatesSchema,
  provider: z.object({
    project: providerProjectSchema,
  }),
  seed: seedSchema,
});

export type SessionWorkflow = z.infer<typeof sessionWorkflowSchema>;

/** `session handoff` 允许的目标状态（P1 只支持 in-progress -> ready-for-review） */
export const HANDOFF_TARGET_STATUS = "ready-for-review" as const;
export const HANDOFF_FROM_STATUS = "in-progress" as const;

export interface IssueObservation {
  state: string;
  title: string;
  body: string;
  url: string;
  /** 是否 Project 看板中存在该项目映射 */
  projectItemPresent: boolean | undefined;
  /** 看板 Status 字段当前值 */
  projectStatus: string | undefined;
}

export interface HandoffDocValidation {
  exists: boolean;
  valid: boolean;
  problems: string[];
  referencedFiles: string[];
  receiptIds: string[];
  /** 校验失败时剩余占位符所在行（SEED 段除外） */
  placeholders: string[];
}

export interface SessionReceipt {
  schemaVersion: typeof SESSION_HANDOFF_RECEIPT_SCHEMA_VERSION;
  kind: "session-handoff-receipt";
  id: string;
  workItem: string;
  session: string;
  handoffDocPath: string;
  handoffDocHash: string;
  commit: string;
  receiptIds: string[];
  fromStatus: string | null;
  toStatus: string;
  at: string;
}

export interface HandoffCommitEntry {
  sha: string;
  subject: string;
}
