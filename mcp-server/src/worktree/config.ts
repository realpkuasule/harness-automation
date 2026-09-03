import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { fileHash, readJson, safePath } from "../v2/fs.js";
import {
  WORKTREE_DELEGATABLE_OPERATIONS,
  WORKTREE_SCHEMA_VERSION,
  type WorktreeApprovalPolicy,
  type WorktreeDeliveryConfig,
  type WorktreeHostBinding,
  type WorktreeHostBindingObservation,
} from "./types.js";

function defaultConfig(): WorktreeDeliveryConfig {
  return {
    schemaVersion: WORKTREE_SCHEMA_VERSION,
    mode: "audit-only",
    maxPersistentWorktrees: 2,
    leaseTtlHours: 72,
    reviewTtlMinutes: 120,
    remoteBranchRetentionDays: 1,
    remoteBranchDeletion: true,
    provider: { kind: "none" },
  };
}

const uniqueAbsolutePaths = z.array(z.string().min(1)).min(1)
  .refine((paths) => paths.every(isAbsolute), "must contain only absolute paths")
  .refine((paths) => new Set(paths).size === paths.length, "must contain unique paths");

const providerSchema = z.object({
  kind: z.enum(["none", "github", "gitlab", "jira"]),
  repository: z.string().min(1).optional(),
  project: z.object({
    owner: z.string().min(1),
    number: z.number().int().positive(),
    statusField: z.string().min(1),
    doneValues: z.array(z.string().min(1)).min(1)
      .refine((values) => new Set(values).size === values.length, "must be unique"),
  }).strict().optional(),
}).strict().superRefine((provider, context) => {
  if (provider.kind !== "none" && !provider.repository?.trim()) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["repository"],
      message: "is required for configured providers",
    });
  }
});

const worktreeConfigShape = {
  schemaVersion: z.literal(WORKTREE_SCHEMA_VERSION),
  mode: z.enum(["audit-only", "enforced"]),
  managementBranch: z.string().trim().min(1).optional(),
  maxPersistentWorktrees: z.number().int().positive(),
  leaseTtlHours: z.number().int().positive(),
  reviewTtlMinutes: z.number().int().positive(),
  remoteBranchRetentionDays: z.number().int().positive(),
  remoteBranchDeletion: z.boolean(),
  provider: providerSchema,
};

const worktreeConfigSchema = z.object(worktreeConfigShape).strict();
const legacyWorktreeConfigSchema = z.object({
  ...worktreeConfigShape,
  allowedRoots: uniqueAbsolutePaths,
  protectedRoots: uniqueAbsolutePaths,
}).strict();
const hostBindingSchema = z.object({
  schemaVersion: z.literal(WORKTREE_SCHEMA_VERSION),
  allowedRoots: uniqueAbsolutePaths,
  protectedRoots: uniqueAbsolutePaths,
  topology: z.object({
    kind: z.literal("container-v1"),
    workspaceContainer: z.string().min(1).refine(isAbsolute, "must be absolute"),
    managementCheckout: z.string().min(1).refine(isAbsolute, "must be absolute"),
    persistentWorktreeRoot: z.string().min(1).refine(isAbsolute, "must be absolute"),
  }).strict().optional(),
  approval: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("manual") }).strict(),
    z.object({
      mode: z.literal("delegated-ai"),
      reviewer: z.object({
        kind: z.literal("claude"),
        model: z.string().trim().min(1),
      }).strict(),
      allowedOperations: z.array(z.enum(WORKTREE_DELEGATABLE_OPERATIONS)).min(1)
        .refine((operations) => new Set(operations).size === operations.length, "must be unique"),
      planTtlSeconds: z.number().int().min(30).max(3600),
      reviewerTimeoutSeconds: z.number().int().min(10).max(600),
    }).strict(),
  ]).optional(),
}).strict();

export function validWorktreeConfig(input: unknown): WorktreeDeliveryConfig {
  const parsed = worktreeConfigSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`WORKTREE_CONFIG_INVALID: ${issue.path.join(".") || "config"} ${issue.message}`);
  }
  return parsed.data;
}

export function validWorktreeHostBinding(input: unknown): WorktreeHostBinding {
  const parsed = hostBindingSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`WORKTREE_HOST_BINDING_INVALID: ${issue.path.join(".") || "binding"} ${issue.message}`);
  }
  return { ...parsed.data, approval: parsed.data.approval ?? { mode: "manual" } };
}

export function loadWorktreeConfig(root: string): {
  configured: boolean;
  config: WorktreeDeliveryConfig;
  legacyBinding?: WorktreeHostBinding;
} {
  const path = join(root, ".harness", "worktree-delivery.json");
  if (!existsSync(path)) return { configured: false, config: defaultConfig() };
  const input = readJson<unknown>(path);
  const portable = worktreeConfigSchema.safeParse(input);
  if (portable.success) return { configured: true, config: portable.data };
  const legacy = legacyWorktreeConfigSchema.safeParse(input);
  if (legacy.success) {
    const { allowedRoots, protectedRoots, ...config } = legacy.data;
    return {
      configured: true,
      config,
      legacyBinding: {
        schemaVersion: WORKTREE_SCHEMA_VERSION,
        allowedRoots,
        protectedRoots,
        approval: { mode: "manual" },
      },
    };
  }
  return { configured: true, config: validWorktreeConfig(input) };
}

export const HOST_BINDING_PATH = "harness/worktree-delivery/host-binding.json" as const;

export function worktreeHostBindingFile(commonDir: string): string {
  return safePath(commonDir, HOST_BINDING_PATH);
}

function defaultHostBinding(root: string, commonDir: string): WorktreeHostBinding {
  return {
    schemaVersion: WORKTREE_SCHEMA_VERSION,
    allowedRoots: [],
    protectedRoots: [root, commonDir, resolve("/")],
    approval: { mode: "manual" },
  };
}

export function loadWorktreeHostBinding(
  root: string,
  commonDir: string,
  legacyBinding?: WorktreeHostBinding,
): WorktreeHostBindingObservation {
  const path = worktreeHostBindingFile(commonDir);
  if (legacyBinding) {
    return {
      ...legacyBinding,
      configured: false,
      loaded: true,
      source: "legacy-config",
      path,
      hash: fileHash(path),
    };
  }
  if (existsSync(path)) {
    const binding = validWorktreeHostBinding(readJson<unknown>(path));
    return {
      ...binding,
      configured: true,
      loaded: true,
      source: "host-local",
      path,
      hash: fileHash(path),
    };
  }
  return {
    ...defaultHostBinding(root, commonDir),
    configured: false,
    loaded: true,
    source: "default",
    path,
    hash: null,
  };
}

export type { WorktreeApprovalPolicy };
