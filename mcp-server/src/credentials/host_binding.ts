import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { hostname } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { z } from "zod";
import { atomicWrite, fileHash, safePath, hashObject } from "../v2/fs.js";
import { appendLkgRecord, appendReceiptEvent, readReceiptChain, readLkgChain } from "../receipt/service.js";
import { acquireMutationLock, releaseMutationLock } from "../recovery/service.js";
import type { CredentialRef, CredentialResolver } from "./service.js";

export const CREDENTIAL_HOST_BINDING_PATH = "harness/credentials/host-binding.json";

export interface CredentialHostBinding {
  schemaVersion: "credential-host-binding/1.0";
  commonDir: string;
  hostId: string;
  repository: string;
  repositoryId: string;
  endpointHash: string;
  credentials: Array<CredentialRef & { keychainService: string; keychainAccount: string }>;
  bindingHash: string;
}
export interface CredentialBindingPlan {
  schemaVersion: "credential-binding-plan/1.0";
  beforeHash: string | null;
  beforeLkgHash: string | null;
  worktreeBindingHash: string | null;
  createdAt: string;
  expiresAt: string;
  binding: CredentialHostBinding;
  planHash: string;
}

const DOMAIN = "credential-binding";
const text = z.string().min(1).max(512).refine((value) => !/[\x00-\x1f\x7f]/u.test(value));
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const credential = z.object({
  id: text, purpose: z.enum(["git-transport", "github-api", "github-admin", "reviewer"]),
  hostId: text, repository: text, identity: text, scopes: z.array(text).max(64),
  expiresAt: z.string().datetime(), envVar: text, keychainService: text, keychainAccount: text,
}).strict().refine((ref) => ref.envVar === ({ "git-transport": "HARNESS_GIT_TOKEN", "github-api": "GH_TOKEN", "github-admin": "GH_TOKEN", reviewer: "HARNESS_REVIEWER_TOKEN" })[ref.purpose]);
const bindingSchema = z.object({
  schemaVersion: z.literal("credential-host-binding/1.0"), commonDir: text, hostId: text,
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u), repositoryId: text,
  endpointHash: digest, credentials: z.array(credential).min(1).max(32), bindingHash: digest,
}).strict();
const planSchema = z.object({
  schemaVersion: z.literal("credential-binding-plan/1.0"), beforeHash: digest.nullable(),
  beforeLkgHash: digest.nullable(), worktreeBindingHash: digest.nullable(),
  createdAt: z.string().datetime(), expiresAt: z.string().datetime(), binding: bindingSchema, planHash: digest,
}).strict();

function withoutHash(binding: CredentialHostBinding): Omit<CredentialHostBinding, "bindingHash"> { const copy = { ...binding }; delete (copy as Partial<CredentialHostBinding>).bindingHash; return copy; }
function withoutPlanHash(plan: CredentialBindingPlan): Omit<CredentialBindingPlan, "planHash"> { const copy = { ...plan }; delete (copy as Partial<CredentialBindingPlan>).planHash; return copy; }

function statePath(commonDir: string, relative: string): string {
  if (realpathSync(commonDir) !== commonDir) throw new Error("CREDENTIAL_COMMON_DIR_INVALID");
  let current = commonDir;
  for (const part of relative.split("/")) {
    current = join(current, part);
    // lstat also rejects dangling links; existsSync alone would miss them.
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw new Error("SYMLINK_TARGET_REJECTED: credential state");
    if (stat && process.getuid && stat.uid !== process.getuid()) throw new Error("CREDENTIAL_STATE_OWNER_INVALID");
  }
  return safePath(commonDir, relative);
}

function checkedBinding(commonDir: string, input: unknown, current = true): CredentialHostBinding {
  const parsed = bindingSchema.safeParse(input);
  if (!parsed.success) throw new Error("CREDENTIAL_HOST_BINDING_INVALID");
  const binding = parsed.data;
  if (binding.commonDir !== realpathSync(commonDir) || (current && binding.hostId !== hostname()) ||
      binding.bindingHash !== hashObject(withoutHash(binding)) ||
      new Set(binding.credentials.map((ref) => ref.id)).size !== binding.credentials.length ||
      binding.credentials.some((ref) => ref.repository !== binding.repository || ref.hostId !== binding.hostId || (current && Date.parse(ref.expiresAt) <= Date.now()))) {
    throw new Error("CREDENTIAL_HOST_BINDING_INVALID");
  }
  return binding;
}

function checkedPlan(commonDir: string, input: unknown, current = true): CredentialBindingPlan {
  const parsed = planSchema.safeParse(input);
  if (!parsed.success || parsed.data.planHash !== hashObject(withoutPlanHash(parsed.data))) throw new Error("CREDENTIAL_BINDING_PLAN_STALE");
  checkedBinding(commonDir, parsed.data.binding, current);
  return parsed.data;
}

function authority(commonDir: string) {
  statePath(commonDir, `harness/lkg/${DOMAIN}/records`);
  const lkg = readLkgChain({ root: commonDir, domain: DOMAIN }).at(-1);
  if (!lkg) return null;
  statePath(commonDir, `harness/receipts/${DOMAIN}/${lkg.transactionId}/events`);
  const event = readReceiptChain<{ plan: CredentialBindingPlan }>({ root: commonDir, domain: DOMAIN, transactionId: lkg.transactionId })
    .find((item) => item.eventHash === lkg.receiptEventHash);
  // Historical validity is distinct from present permission: expiry must not block replacement.
  const plan = checkedPlan(commonDir, event?.snapshot.plan, false);
  if (lkg.planHash !== plan.planHash || lkg.transactionId !== plan.planHash || lkg.observedHash !== plan.binding.bindingHash) throw new Error("CREDENTIAL_HOST_BINDING_INVALID");
  return { lkg, plan };
}

function privateProjection(commonDir: string): string {
  const path = statePath(commonDir, CREDENTIAL_HOST_BINDING_PATH);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || (stat.mode & 0o077) !== 0)) throw new Error("CREDENTIAL_STATE_PERMISSIONS_INVALID");
  return path;
}

function writeProjection(commonDir: string, binding: CredentialHostBinding): void {
  const directory = statePath(commonDir, "harness/credentials");
  mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
  const path = privateProjection(commonDir);
  atomicWrite(path, `${JSON.stringify(binding, null, 2)}\n`); chmodSync(path, 0o600);
}

export function planCredentialHostBinding(commonDir: string, binding: Omit<CredentialHostBinding, "bindingHash">): CredentialBindingPlan {
  const complete: CredentialHostBinding = { ...binding, bindingHash: "" }; complete.bindingHash = hashObject(withoutHash(complete));
  checkedBinding(commonDir, complete);
  const now = Date.now();
  const plan: CredentialBindingPlan = {
    schemaVersion: "credential-binding-plan/1.0", beforeHash: fileHash(privateProjection(commonDir)),
    beforeLkgHash: authority(commonDir)?.lkg.recordHash ?? null,
    worktreeBindingHash: fileHash(statePath(commonDir, "harness/worktree-delivery/host-binding.json")),
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 15 * 60_000).toISOString(),
    binding: complete, planHash: "",
  };
  plan.planHash = hashObject(withoutPlanHash(plan)); return plan;
}

export function applyCredentialHostBinding(commonDir: string, plan: CredentialBindingPlan, approval: string): CredentialHostBinding {
  plan = checkedPlan(commonDir, plan);
  if (approval !== plan.planHash) throw new Error("CREDENTIAL_BINDING_PLAN_STALE");
  statePath(commonDir, "harness/worktree-delivery/apply.lock");
  const lock = acquireMutationLock({ projectDir: commonDir, commonDir, repository: true });
  try {
    const current = authority(commonDir);
    const path = privateProjection(commonDir);
    const projectionHash = fileHash(path);
    if (current?.plan.planHash === plan.planHash) {
      if (projectionHash !== null && projectionHash !== plan.beforeHash && hashObject(JSON.parse(readFileSync(path, "utf8"))) !== hashObject(plan.binding)) throw new Error("CREDENTIAL_BINDING_PLAN_STALE");
      writeProjection(commonDir, plan.binding); return plan.binding;
    }
    const now = Date.now();
    if (Date.parse(plan.createdAt) > now || Date.parse(plan.expiresAt) <= now || Date.parse(plan.expiresAt) - Date.parse(plan.createdAt) > 15 * 60_000 ||
        plan.beforeHash !== projectionHash || plan.beforeLkgHash !== (current?.lkg.recordHash ?? null) ||
        plan.worktreeBindingHash !== fileHash(statePath(commonDir, "harness/worktree-delivery/host-binding.json"))) throw new Error("CREDENTIAL_BINDING_PLAN_STALE");
    for (const relative of [`harness/receipts/${DOMAIN}`, `harness/lkg/${DOMAIN}`]) {
      const directory = statePath(commonDir, relative); mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
    }
    const event = appendReceiptEvent({ root: commonDir, domain: DOMAIN, transactionId: plan.planHash, snapshot: { plan } });
    appendLkgRecord({ root: commonDir, domain: DOMAIN, transactionId: plan.planHash, appliedReceiptEventHash: event.eventHash, planHash: plan.planHash, observedHash: plan.binding.bindingHash });
    writeProjection(commonDir, plan.binding); return plan.binding;
  } finally { releaseMutationLock(lock); }
}

export function loadCredentialHostBinding(commonDir: string, expected: { repository: string; repositoryId: string; endpointHash: string }): CredentialHostBinding {
  const path = privateProjection(commonDir);
  const current = authority(commonDir);
  if (!current) throw new Error("CREDENTIAL_HOST_BINDING_UNCONFIGURED");
  const binding = checkedBinding(commonDir, current.plan.binding);
  if (binding.repository !== expected.repository || binding.repositoryId !== expected.repositoryId || binding.endpointHash !== expected.endpointHash ||
      (existsSync(path) && hashObject(JSON.parse(readFileSync(path, "utf8"))) !== hashObject(binding))) throw new Error("CREDENTIAL_HOST_BINDING_INVALID");
  return binding;
}

/** Fixed macOS Keychain resolver: each read revalidates the current registered binding. */
export function macOSKeychainResolver(binding: CredentialHostBinding): CredentialResolver {
  const { commonDir, repository, repositoryId, endpointHash, bindingHash } = binding;
  return { resolve(ref) {
    const current = loadCredentialHostBinding(commonDir, { repository, repositoryId, endpointHash });
    if (current.bindingHash !== bindingHash) throw new Error("CREDENTIAL_BINDING_STALE");
    const registered = current.credentials.find((item) => item.id === ref.id);
    const fields: Array<keyof CredentialRef> = ["id", "purpose", "hostId", "repository", "identity", "scopes", "expiresAt", "envVar"];
    if (!registered || fields.some((field) => hashObject(registered[field]) !== hashObject(ref[field]))) throw new Error("CREDENTIAL_REF_UNREGISTERED");
    if (process.platform !== "darwin") throw new Error("CREDENTIAL_OS_ADAPTER_UNAVAILABLE");
    const result = spawnSync("security", ["find-generic-password", "-s", registered.keychainService, "-a", registered.keychainAccount, "-w"], {
      encoding: "utf8", maxBuffer: 16 * 1024, timeout: 10_000, env: { PATH: process.env.PATH },
    });
    if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("ENVIRONMENT_BLOCKED: SECURITY_TOOL_UNAVAILABLE");
    if (result.status !== 0 || !result.stdout.trim()) throw new Error("CREDENTIAL_KEYCHAIN_ACCESS_DENIED");
    return { ref: registered, secret: result.stdout.trim() };
  } };
}
