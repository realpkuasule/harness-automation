import { z } from "zod";

export const SESSION_WORKFLOW_SCHEMA_VERSION = "session-workflow/1.0" as const;
export const SESSION_HANDOFF_RECEIPT_SCHEMA_VERSION = "session-handoff/1.0" as const;
export const SESSION_ADMISSION_SCHEMA_VERSION = "session-admission/1.0" as const;

/** `read-only` also covers non-code work; intent is supplied by the host/agent, not guessed from prose. */
export const SESSION_INTENTS = ["read-only", "continue", "new-code", "unclear"] as const;
export type SessionIntent = typeof SESSION_INTENTS[number];

export const SESSION_ADMISSION_DECISIONS = [
  "read-only",
  "continue",
  "prepare-required",
  "unclear",
] as const;
export type SessionAdmissionDecision = typeof SESSION_ADMISSION_DECISIONS[number];

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const gitObjectSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);

export const sessionAdmissionFactsSchema = z.object({
  policyDigest: digestSchema,
  contextReceipt: z.string().regex(/^\.harness\/sessions\/[A-Za-z0-9._-]+\.json$/u),
  contextReceiptHash: digestSchema,
  repository: z.string().min(1),
  commonDir: z.string().min(1),
  cwd: z.string().min(1),
  branch: z.string().min(1).nullable(),
  head: gitObjectSchema,
  configFingerprint: digestSchema,
  leaseFingerprint: digestSchema.nullable(),
  workItem: z.string().min(1).nullable(),
  leaseWorkItem: z.string().min(1).nullable(),
  managementCheckout: z.boolean(),
}).strict();

export const sessionAdmissionRecordSchema = z.object({
  schemaVersion: z.literal(SESSION_ADMISSION_SCHEMA_VERSION),
  kind: z.literal("session-admission"),
  session: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
  intent: z.enum(SESSION_INTENTS),
  decision: z.enum(SESSION_ADMISSION_DECISIONS),
  enforcement: z.literal("managed-commands-only"),
  managedWriteAllowed: z.boolean(),
  facts: sessionAdmissionFactsSchema,
  factsFingerprint: digestSchema,
  reasonCodes: z.array(z.string().min(1)).min(1),
  recordedAt: z.string().datetime(),
}).strict();

export type SessionAdmissionFacts = z.infer<typeof sessionAdmissionFactsSchema>;
export type SessionAdmissionRecord = z.infer<typeof sessionAdmissionRecordSchema>;

export interface SessionAdmissionResult extends SessionAdmissionRecord {
  reused: boolean;
  receiptSequence: number;
  receiptEventHash: string;
}

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
  templates: templatesSchema,
  provider: z.object({
    project: providerProjectSchema,
  }),
  seed: seedSchema,
});

export type SessionWorkflow = z.infer<typeof sessionWorkflowSchema>;

/** Normal handoffs continue delivery; review is an explicit separate intent. */
export const HANDOFF_CONTINUATION_STATUS = "in-progress" as const;
export const HANDOFF_REVIEW_STATUS = "ready-for-review" as const;
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
