import { existsSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import { atomicWrite, hashObject, prettyJson, readJson, safePath, sha256 } from "../v2/fs.js";
import { commandJson } from "../worktree/provider.js";
import { loadWorktreeConfig } from "../worktree/config.js";
import { runGit, runGitCommand } from "../repository/git.js";
import { githubEndpointRepository, remotePushEndpoint, remoteRefHead } from "../repository/remote.js";
import { readLatestReceiptEvent } from "../receipt/service.js";
import { deliveryPrepareJournalSchema, type DeliveryPrepareJournal } from "./prepare.js";
import {
  DELIVERY_AUTHORIZATION_SCHEMA_VERSION,
  DELIVERY_RECEIPT_SCHEMA_VERSION,
  type CiFailureClassification,
  type CiFailureStep,
  type DeliveryAuthorization,
  type DeliveryCapabilities,
  type DeliveryReceipt,
  type DeliveryReceiptAction,
  type DeliveryStatus,
} from "./types.js";

function git(root: string, args: string[], allowFailure = false): string {
  return runGit(root, args, { allowFailure, fallbackError: true }).trim();
}

function repositoryRoot(root: string): string {
  return resolve(git(root, ["rev-parse", "--show-toplevel"]));
}

function commonDir(root: string): string {
  return resolve(git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
}

function currentBranch(root: string): string {
  const branch = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], true);
  if (!branch) throw new Error("DELIVERY_DETACHED_HEAD");
  return branch;
}

function featureWorktree(root: string, branch: string): string {
  const blocks = git(root, ["worktree", "list", "--porcelain"])
    .split("\n\n").filter(Boolean);
  const expected = `refs/heads/${branch}`;
  const matches = blocks.map((block) => {
    const values = new Map(block.split("\n").map((line) => {
      const separator = line.indexOf(" ");
      return separator === -1 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 1)];
    }));
    return { path: values.get("worktree"), branch: values.get("branch") };
  }).filter((item) => item.branch === expected && item.path);
  if (matches.length !== 1) throw new Error(`DELIVERY_FEATURE_WORKTREE_UNAVAILABLE: ${branch}`);
  return resolve(matches[0].path!);
}

function commit(root: string, ref: string): string {
  return git(root, ["rev-parse", "--verify", `${ref}^{commit}`]);
}

function isAncestor(root: string, ancestor: string, descendant: string): boolean {
  const result = runGitCommand(root, ["merge-base", "--is-ancestor", ancestor, descendant], process.env);
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    throw new Error(`GIT_COMMAND_FAILED: git merge-base --is-ancestor: ${(result.stderr || result.error || "unknown error").trim()}`);
  }
  return result.status === 0;
}

function normalizePath(value: string): string {
  const trimmed = value.trim().replaceAll("\\", "/");
  if (!trimmed || trimmed === "." || trimmed.startsWith("/") || trimmed.split("/").includes("..")) {
    throw new Error(`DELIVERY_ALLOWED_PATH_INVALID: ${value}`);
  }
  return trimmed.endsWith("/") ? trimmed.replace(/\/+$/u, "/") : trimmed;
}

function authorizationPath(common: string, hash: string): string {
  return safePath(common, `harness/worktree-delivery/receipts/delivery-authorization-${hash}.json`);
}

function receiptDirectory(common: string): string {
  return safePath(common, "harness/worktree-delivery/receipts");
}

function receiptPath(common: string, id: string): string {
  return safePath(common, `harness/worktree-delivery/receipts/${id}.json`);
}

function coordinationBlock(common: string, workItem: string): boolean {
  const directory = safePath(common, "harness/delivery-prepare/journals");
  if (!existsSync(directory)) return false;
  for (const name of readdirSync(directory).filter((entry) => /^prepare-[a-f0-9]{24}\.json$/u.test(entry)).sort()) {
    const transactionId = name.slice(0, -".json".length);
    const projection = readJson<unknown>(join(directory, name));
    const parsedProjection = deliveryPrepareJournalSchema.safeParse(projection);
    if (!parsedProjection.success) throw new Error("DELIVERY_PREPARE_JOURNAL_INVALID");
    const event = readLatestReceiptEvent<DeliveryPrepareJournal>({
      root: common,
      domain: "delivery-prepare",
      transactionId,
      compatibilitySnapshot: parsedProjection.data,
    });
    if (!event) continue;
    const latest = deliveryPrepareJournalSchema.parse(event.snapshot);
    const unhashed = { ...latest };
    delete (unhashed as Partial<DeliveryPrepareJournal>).journalHash;
    if (latest.journalHash !== hashObject(unhashed)) throw new Error("DELIVERY_PREPARE_JOURNAL_INVALID");
    if (latest.workItem === workItem && latest.outcome === "CoordinationBackendRequired" && latest.blocked) return true;
  }
  return false;
}

function assertLegacyCoordinationAllowed(root: string, workItem: string): void {
  if (coordinationBlock(commonDir(root), workItem)) throw new Error("CoordinationBackendRequired");
}

function withoutAuthorizationHash(authorization: DeliveryAuthorization): Omit<DeliveryAuthorization, "authorizationHash"> {
  const copy = { ...authorization };
  delete (copy as Partial<DeliveryAuthorization>).authorizationHash;
  return copy;
}

function withoutReceiptHash(receipt: DeliveryReceipt): Omit<DeliveryReceipt, "receiptHash"> {
  const copy = { ...receipt };
  delete (copy as Partial<DeliveryReceipt>).receiptHash;
  return copy;
}

const shaSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const commitSchema = z.string().regex(/^[a-f0-9]{40,64}$/u);
const branchSchema = z.string().min(1).max(255).refine((value) => !value.startsWith("-") && !value.includes(".."));
const pathSchema = z.string().min(1).max(4_096);
const capabilitiesSchema = z.object({
  pushOwnBranch: z.boolean(),
  upsertPullRequest: z.boolean(),
  retryInfrastructureCi: z.boolean(),
  controlledRebase: z.boolean(),
  mergeMode: z.enum(["manual", "checks-green"]),
  closeout: z.boolean(),
}).strict();
const authorizationSchema = z.object({
  schemaVersion: z.literal(DELIVERY_AUTHORIZATION_SCHEMA_VERSION),
  kind: z.literal("delivery-authorization"),
  id: z.string().min(1).max(255),
  issuedAt: z.string().datetime(),
  approval: z.object({ source: z.string().min(1).max(4_096), sourceHash: shaSchema }).strict(),
  supersedes: shaSchema.optional(),
  intent: z.string().min(1).max(16_384),
  intentHash: shaSchema,
  workItem: z.string().regex(/^github:[^/\s]+\/[^#\s]+#\d+$/u),
  repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/u),
  remote: z.object({ name: z.string().min(1), endpointHash: shaSchema }).strict(),
  baseBranch: branchSchema,
  baseHead: commitSchema,
  featureBranch: branchSchema,
  initialHead: commitSchema,
  allowedPaths: z.array(pathSchema).min(1).max(256),
  policyHash: shaSchema,
  capabilities: capabilitiesSchema,
  retryLimit: z.number().int().min(0).max(2),
  authorizationHash: shaSchema,
}).strict();
const receiptSchema = z.object({
  schemaVersion: z.literal(DELIVERY_RECEIPT_SCHEMA_VERSION),
  kind: z.literal("delivery-receipt"),
  id: z.string().min(1).max(255),
  authorizationHash: shaSchema,
  action: z.enum(["push", "pull-request", "rebase", "ci-retry", "merge", "closeout"]),
  status: z.enum(["applied", "blocked"]),
  sequence: z.number().int().positive(),
  previousReceiptHash: shaSchema.nullable(),
  createdAt: z.string().datetime(),
  beforeHead: commitSchema,
  afterHead: commitSchema,
  evidence: z.record(z.unknown()),
  receiptHash: shaSchema,
}).strict();

function ensureAuthorization(input: unknown): DeliveryAuthorization {
  const parsed = authorizationSchema.safeParse(input);
  if (!parsed.success) throw new Error("DELIVERY_AUTHORIZATION_INVALID");
  const authorization = parsed.data;
  if (
    authorization.intentHash !== sha256(authorization.intent) ||
    authorization.approval.sourceHash !== sha256(authorization.approval.source) ||
    !/^[a-f0-9]{64}$/u.test(authorization.authorizationHash) ||
    authorization.authorizationHash !== hashObject(withoutAuthorizationHash(authorization)) ||
    authorization.workItem.toLowerCase() !== `github:${authorization.repository.toLowerCase()}#${authorization.workItem.split("#").at(-1)}` ||
    authorization.baseBranch === authorization.featureBranch ||
    authorization.allowedPaths.some((path) => normalizePath(path) !== path) ||
    [...authorization.allowedPaths].sort().join("\0") !== authorization.allowedPaths.join("\0") ||
    new Set(authorization.allowedPaths).size !== authorization.allowedPaths.length
  ) throw new Error("DELIVERY_AUTHORIZATION_INVALID");
  return authorization;
}

function changedPaths(root: string, base: string, head: string): string[] {
  const output = git(root, ["diff", "--name-only", `${base}...${head}`]);
  return output ? output.split("\n").filter(Boolean) : [];
}

function requireCleanWorktree(root: string): void {
  const dirty = git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (dirty) throw new Error(`DELIVERY_WORKTREE_DIRTY: ${dirty.split("\n")[0]}`);
}

function observedEndpoint(root: string, authorization: DeliveryAuthorization): { value: string; hash: string } {
  const endpoint = remotePushEndpoint(root, authorization.remote.name);
  if (endpoint.hash !== authorization.remote.endpointHash ||
      githubEndpointRepository(endpoint.value, authorization.remote.name).toLowerCase() !== authorization.repository) {
    throw new Error("DELIVERY_REMOTE_ENDPOINT_DRIFT");
  }
  return endpoint;
}

function objectValue(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

function stringValue(value: unknown, key: string): string | null {
  const candidate = objectValue(value, key);
  return typeof candidate === "string" ? candidate : null;
}

function numberValue(value: unknown, key: string): number | null {
  const candidate = objectValue(value, key);
  return typeof candidate === "number" && Number.isSafeInteger(candidate) ? candidate : null;
}

function githubApi(root: string, args: string[]): unknown {
  const result = commandJson(root, "gh", ["api", ...args]);
  if (!result.ok) throw new Error(`DELIVERY_GITHUB_QUERY_FAILED: ${result.error ?? "unknown error"}`);
  return result.value;
}

interface PullRequestEvidence {
  number: number;
  url: string;
  state: "open" | "closed";
  merged: boolean;
  mergeable: boolean | null;
  head: string;
}

function exactPullRequest(root: string, authorization: DeliveryAuthorization, number: number): PullRequestEvidence {
  const value = githubApi(root, ["--method", "GET", `repos/${authorization.repository}/pulls/${number}`]);
  const head = objectValue(value, "head");
  const base = objectValue(value, "base");
  const headRepository = stringValue(head, "repo") ? null : stringValue(objectValue(head, "repo"), "full_name");
  const baseRepository = stringValue(base, "repo") ? null : stringValue(objectValue(base, "repo"), "full_name");
  const state = stringValue(value, "state");
  const pullNumber = numberValue(value, "number");
  const headRef = stringValue(head, "ref");
  const headSha = stringValue(head, "sha");
  const baseRef = stringValue(base, "ref");
  const merged = objectValue(value, "merged") === true;
  const mergeableValue = objectValue(value, "mergeable");
  if (pullNumber !== number || !headRef || !headSha || !baseRef || !state || !["open", "closed"].includes(state) ||
      headRepository?.toLowerCase() !== authorization.repository || baseRepository?.toLowerCase() !== authorization.repository ||
      headRef !== authorization.featureBranch || baseRef !== authorization.baseBranch) {
    throw new Error("DELIVERY_PULL_REQUEST_MAPPING_DRIFT");
  }
  if (mergeableValue !== true && mergeableValue !== false && mergeableValue !== null) {
    throw new Error("DELIVERY_PULL_REQUEST_EVIDENCE_INVALID");
  }
  const url = stringValue(value, "html_url");
  if (!url) throw new Error("DELIVERY_PULL_REQUEST_EVIDENCE_INVALID");
  return { number, url, state: state as "open" | "closed", merged, mergeable: mergeableValue, head: headSha };
}

function openPullRequest(root: string, authorization: DeliveryAuthorization): PullRequestEvidence | null {
  const [owner] = authorization.repository.split("/", 1);
  const query = new URLSearchParams({ state: "open", base: authorization.baseBranch, head: `${owner}:${authorization.featureBranch}`, per_page: "100" });
  const values = githubApi(root, ["--method", "GET", `repos/${authorization.repository}/pulls?${query.toString()}`]);
  if (!Array.isArray(values)) throw new Error("DELIVERY_PULL_REQUEST_EVIDENCE_INVALID");
  if (values.length > 1) throw new Error("DELIVERY_PULL_REQUEST_AMBIGUOUS");
  if (values.length === 0) return null;
  const number = numberValue(values[0], "number");
  if (!number) throw new Error("DELIVERY_PULL_REQUEST_EVIDENCE_INVALID");
  return exactPullRequest(root, authorization, number);
}

function pathAllowed(path: string, allowed: string[]): boolean {
  return allowed.some((scope) => scope.endsWith("/")
    ? path.startsWith(scope)
    : path === scope);
}

function currentBaseHead(root: string, authorization: DeliveryAuthorization): string {
  const remoteRef = `refs/remotes/${authorization.remote.name}/${authorization.baseBranch}`;
  return git(root, ["show-ref", "--verify", "--hash", remoteRef], true) ||
    commit(root, authorization.baseBranch);
}

function currentPolicyHash(root: string): string {
  const loaded = loadWorktreeConfig(root);
  return hashObject({ configured: loaded.configured, config: loaded.config, legacyBinding: loaded.legacyBinding });
}

function readReceipts(common: string, authorizationHash: string): DeliveryReceipt[] {
  const directory = receiptDirectory(common);
  if (!existsSync(directory)) return [];
  const receipts = readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => readJson<unknown>(join(directory, name)))
    .filter((receipt): receipt is Record<string, unknown> =>
      Boolean(receipt) && typeof receipt === "object" && (receipt as Record<string, unknown>).kind === "delivery-receipt")
    .filter((receipt) => receipt.authorizationHash === authorizationHash)
    .map((receipt) => {
      const parsed = receiptSchema.safeParse(receipt);
      if (!parsed.success || parsed.data.receiptHash !== hashObject(withoutReceiptHash(parsed.data))) {
        throw new Error(`DELIVERY_RECEIPT_INVALID: ${basename(receiptPath(common, String(receipt.id ?? "unknown")))}`);
      }
      return parsed.data;
    });
  const ordered = [...receipts].sort((left, right) => left.sequence - right.sequence);
  for (let index = 0; index < ordered.length; index += 1) {
    const receipt = ordered[index];
    const previous = ordered[index - 1];
    if (receipt.sequence !== index + 1 || receipt.previousReceiptHash !== (previous?.receiptHash ?? null)) {
      throw new Error("DELIVERY_RECEIPT_CHAIN_INVALID");
    }
  }
  return ordered;
}

export function authorizeDelivery(options: {
  projectRoot: string;
  workItem: string;
  repository?: string;
  remote?: string;
  baseBranch: string;
  featureBranch?: string;
  allowedPaths: string[];
  intent: string;
  approvalSource: string;
  supersedes?: string;
  capabilities?: Partial<DeliveryCapabilities>;
  retryLimit?: number;
  now?: Date;
}): { authorization: DeliveryAuthorization; path: string } {
  const root = repositoryRoot(options.projectRoot);
  const remote = options.remote?.trim() || "origin";
  const endpoint = remotePushEndpoint(root, remote);
  const observedRepository = githubEndpointRepository(endpoint.value, remote).toLowerCase();
  const repository = (options.repository?.trim() || observedRepository).toLowerCase();
  if (repository !== observedRepository) throw new Error("DELIVERY_REMOTE_REPOSITORY_MISMATCH");
  if (!/^github:[^/]+\/[^#]+#\d+$/u.test(options.workItem.trim()) ||
      !options.workItem.toLowerCase().startsWith(`github:${repository}#`)) {
    throw new Error(`DELIVERY_WORK_ITEM_REPOSITORY_MISMATCH: ${options.workItem}`);
  }
  assertLegacyCoordinationAllowed(root, options.workItem.trim());
  const baseBranch = options.baseBranch.trim();
  const featureBranch = options.featureBranch?.trim() || currentBranch(root);
  if (!baseBranch || !featureBranch || baseBranch === featureBranch) throw new Error("DELIVERY_BRANCH_INVALID");
  if (currentBranch(root) !== featureBranch) throw new Error("DELIVERY_FEATURE_BRANCH_NOT_CHECKED_OUT");
  const intent = options.intent.trim();
  if (!intent) throw new Error("DELIVERY_INTENT_REQUIRED");
  const approvalSource = options.approvalSource.trim();
  if (!approvalSource) throw new Error("DELIVERY_APPROVAL_SOURCE_REQUIRED");
  if (options.supersedes && !/^[a-f0-9]{64}$/u.test(options.supersedes)) {
    throw new Error("DELIVERY_SUPERSEDES_HASH_INVALID");
  }
  const allowedPaths = [...new Set(options.allowedPaths.map(normalizePath))].sort();
  const capabilities: DeliveryCapabilities = {
    pushOwnBranch: true,
    upsertPullRequest: true,
    retryInfrastructureCi: true,
    controlledRebase: true,
    mergeMode: "manual",
    closeout: true,
    ...options.capabilities,
  };
  const issuedAt = (options.now ?? new Date()).toISOString();
  const authorization: DeliveryAuthorization = {
    schemaVersion: DELIVERY_AUTHORIZATION_SCHEMA_VERSION,
    kind: "delivery-authorization",
    id: `delivery-${options.workItem.trim().split("#").at(-1)}-${sha256(`${options.workItem}\n${featureBranch}\n${issuedAt}`).slice(0, 12)}`,
    issuedAt,
    approval: { source: approvalSource, sourceHash: sha256(approvalSource) },
    supersedes: options.supersedes,
    intent,
    intentHash: sha256(intent),
    workItem: options.workItem.trim(),
    repository,
    remote: { name: remote, endpointHash: endpoint.hash },
    baseBranch,
    baseHead: commit(root, baseBranch),
    featureBranch,
    initialHead: commit(root, "HEAD"),
    allowedPaths,
    policyHash: currentPolicyHash(root),
    capabilities,
    retryLimit: options.retryLimit ?? 2,
    authorizationHash: "",
  };
  authorization.authorizationHash = hashObject(withoutAuthorizationHash(authorization));
  const path = authorizationPath(commonDir(root), authorization.authorizationHash);
  if (existsSync(path)) {
    const existing = ensureAuthorization(readJson<DeliveryAuthorization>(path));
    if (existing.authorizationHash !== authorization.authorizationHash) throw new Error("DELIVERY_AUTHORIZATION_CONFLICT");
    return { authorization: existing, path };
  }
  atomicWrite(path, prettyJson(authorization));
  return { authorization, path };
}

export function loadDeliveryAuthorization(projectRoot: string, authorizationHash: string): DeliveryAuthorization {
  const root = repositoryRoot(projectRoot);
  if (!/^[a-f0-9]{64}$/u.test(authorizationHash)) throw new Error("DELIVERY_AUTHORIZATION_HASH_INVALID");
  const path = authorizationPath(commonDir(root), authorizationHash);
  if (!existsSync(path)) throw new Error(`DELIVERY_AUTHORIZATION_NOT_FOUND: ${authorizationHash}`);
  return ensureAuthorization(readJson<DeliveryAuthorization>(path));
}

export function latestDeliveryAuthorization(projectRoot: string, workItem: string): DeliveryAuthorization | null {
  const root = repositoryRoot(projectRoot);
  const directory = receiptDirectory(commonDir(root));
  if (!existsSync(directory)) return null;
  const values = readdirSync(directory)
    .filter((name) => name.startsWith("delivery-authorization-") && name.endsWith(".json"))
    .map((name) => readJson<DeliveryAuthorization>(join(directory, name)))
    .filter((authorization) => authorization.workItem === workItem)
    .map(ensureAuthorization);
  if (values.length <= 1) return values[0] ?? null;
  const superseded = new Set(values.flatMap((authorization) => authorization.supersedes ? [authorization.supersedes] : []));
  const live = values.filter((authorization) => !superseded.has(authorization.authorizationHash));
  if (live.length !== 1) throw new Error("DELIVERY_AUTHORIZATION_AMBIGUOUS");
  const selected = live[0];
  const predecessors = new Set(values.map((authorization) => authorization.authorizationHash));
  if (selected.supersedes && !predecessors.has(selected.supersedes)) {
    throw new Error("DELIVERY_AUTHORIZATION_SUPERSEDES_UNKNOWN");
  }
  return selected;
}

export function deliveryStatus(projectRoot: string, authorizationHash: string): DeliveryStatus {
  const root = repositoryRoot(projectRoot);
  const authorization = loadDeliveryAuthorization(root, authorizationHash);
  const featureRoot = featureWorktree(root, authorization.featureBranch);
  const currentHead = commit(featureRoot, "HEAD");
  const receipts = readReceipts(commonDir(root), authorization.authorizationHash);
  let invalidation: string | undefined;
  if (coordinationBlock(commonDir(root), authorization.workItem)) invalidation = "CoordinationBackendRequired";
  else if (currentBranch(featureRoot) !== authorization.featureBranch) invalidation = "DELIVERY_FEATURE_BRANCH_DRIFT";
  else if (remotePushEndpoint(root, authorization.remote.name).hash !== authorization.remote.endpointHash) invalidation = "DELIVERY_REMOTE_ENDPOINT_DRIFT";
  else if (currentPolicyHash(root) !== authorization.policyHash) invalidation = "DELIVERY_POLICY_DRIFT";
  else {
    const outOfScope = changedPaths(featureRoot, currentBaseHead(featureRoot, authorization), currentHead)
      .filter((path) => !pathAllowed(path, authorization.allowedPaths));
    if (outOfScope.length > 0) invalidation = `DELIVERY_SCOPE_DRIFT: ${outOfScope.join(", ")}`;
  }
  const last = receipts.at(-1);
  const phase: DeliveryStatus["phase"] = invalidation
    ? "suspended"
    : last?.action === "closeout" && last.status === "applied"
      ? "done"
      : last?.action === "merge" && last.status === "applied"
        ? "closing"
        : receipts.some((receipt) => receipt.action === "pull-request")
          ? "awaiting-checks"
          : "executing";
  return { authorization, currentHead, phase, receipts, invalidation };
}

function writeDeliveryReceipt(options: {
  projectRoot: string;
  authorizationHash: string;
  action: DeliveryReceiptAction;
  beforeHead: string;
  afterHead: string;
  evidence: Record<string, unknown>;
  status?: "applied" | "blocked";
  now?: Date;
}): DeliveryReceipt {
  const root = repositoryRoot(options.projectRoot);
  const status = deliveryStatus(root, options.authorizationHash);
  if (status.invalidation) throw new Error(status.invalidation);
  const expectedBefore = status.receipts.at(-1)?.afterHead ?? status.authorization.initialHead;
  const featureRoot = featureWorktree(root, status.authorization.featureBranch);
  if (!isAncestor(featureRoot, expectedBefore, options.beforeHead) || options.afterHead !== commit(featureRoot, "HEAD")) {
    throw new Error("DELIVERY_RECEIPT_HEAD_CHAIN_INVALID");
  }
  const receipt: DeliveryReceipt = {
    schemaVersion: DELIVERY_RECEIPT_SCHEMA_VERSION,
    kind: "delivery-receipt",
    id: `delivery-${options.action}-${sha256(JSON.stringify({ authorizationHash: options.authorizationHash, action: options.action, sequence: status.receipts.length + 1, beforeHead: options.beforeHead, afterHead: options.afterHead, evidence: options.evidence })).slice(0, 16)}`,
    authorizationHash: options.authorizationHash,
    action: options.action,
    status: options.status ?? "applied",
    sequence: status.receipts.length + 1,
    previousReceiptHash: status.receipts.at(-1)?.receiptHash ?? null,
    createdAt: (options.now ?? new Date()).toISOString(),
    beforeHead: options.beforeHead,
    afterHead: options.afterHead,
    evidence: options.evidence,
    receiptHash: "",
  };
  receipt.receiptHash = hashObject(withoutReceiptHash(receipt));
  const path = receiptPath(commonDir(root), receipt.id);
  if (existsSync(path)) return readJson<DeliveryReceipt>(path);
  atomicWrite(path, prettyJson(receipt));
  return receipt;
}

export function pushDelivery(options: {
  projectRoot: string;
  authorizationHash: string;
  now?: Date;
}): DeliveryReceipt {
  const root = repositoryRoot(options.projectRoot);
  const status = deliveryStatus(root, options.authorizationHash);
  if (status.invalidation) throw new Error(status.invalidation);
  if (!status.authorization.capabilities.pushOwnBranch) throw new Error("DELIVERY_PUSH_NOT_AUTHORIZED");
  const featureRoot = featureWorktree(root, status.authorization.featureBranch);
  requireCleanWorktree(featureRoot);
  const endpoint = observedEndpoint(root, status.authorization);
  const ref = `refs/heads/${status.authorization.featureBranch}`;
  const beforeHead = commit(featureRoot, "HEAD");
  const remoteBefore = remoteRefHead(root, endpoint.value, status.authorization.remote.name, ref);
  const lastPush = [...status.receipts].reverse().find((receipt) => receipt.action === "push");
  if (remoteBefore && remoteBefore !== beforeHead &&
      (!lastPush || remoteBefore !== lastPush.afterHead || !isAncestor(featureRoot, remoteBefore, beforeHead))) {
    throw new Error(`DELIVERY_REMOTE_BRANCH_DRIFT: ${ref}`);
  }
  git(featureRoot, ["push", endpoint.value, `HEAD:${ref}`]);
  const remoteAfter = remoteRefHead(root, endpoint.value, status.authorization.remote.name, ref);
  if (remoteAfter !== beforeHead) throw new Error(`DELIVERY_PUSH_VERIFICATION_FAILED: ${ref}`);
  return writeDeliveryReceipt({
    projectRoot: root,
    authorizationHash: options.authorizationHash,
    action: "push",
    beforeHead,
    afterHead: beforeHead,
    evidence: { remote: status.authorization.remote.name, endpointHash: endpoint.hash, ref, remoteBefore, remoteAfter },
    now: options.now,
  });
}

export function upsertDeliveryPullRequest(options: {
  projectRoot: string;
  authorizationHash: string;
  title: string;
  body?: string;
  now?: Date;
}): DeliveryReceipt {
  const root = repositoryRoot(options.projectRoot);
  const status = deliveryStatus(root, options.authorizationHash);
  if (status.invalidation) throw new Error(status.invalidation);
  if (!status.authorization.capabilities.upsertPullRequest) throw new Error("DELIVERY_PULL_REQUEST_NOT_AUTHORIZED");
  const featureRoot = featureWorktree(root, status.authorization.featureBranch);
  requireCleanWorktree(featureRoot);
  observedEndpoint(root, status.authorization);
  const head = commit(featureRoot, "HEAD");
  let pull = openPullRequest(root, status.authorization);
  if (!pull) {
    const title = options.title.trim();
    if (!title) throw new Error("DELIVERY_PULL_REQUEST_TITLE_REQUIRED");
    const created = githubApi(root, [
      "--method", "POST", `repos/${status.authorization.repository}/pulls`,
      "--raw-field", `head=${status.authorization.featureBranch}`,
      "--raw-field", `base=${status.authorization.baseBranch}`,
      "--raw-field", `title=${title}`,
      "--raw-field", `body=${options.body ?? ""}`,
    ]);
    const number = numberValue(created, "number");
    if (!number) throw new Error("DELIVERY_PULL_REQUEST_CREATE_UNVERIFIED");
    pull = exactPullRequest(root, status.authorization, number);
  }
  if (pull.state !== "open" || pull.head !== head) throw new Error("DELIVERY_PULL_REQUEST_HEAD_DRIFT");
  return writeDeliveryReceipt({
    projectRoot: root,
    authorizationHash: options.authorizationHash,
    action: "pull-request",
    beforeHead: head,
    afterHead: head,
    evidence: { number: pull.number, url: pull.url, head: pull.head, base: status.authorization.baseBranch },
    now: options.now,
  });
}

function requiredChecks(root: string, authorization: DeliveryAuthorization, pull: PullRequestEvidence): Array<{ name: string; state: string }> {
  const result = commandJson(root, "gh", [
    "pr", "checks", String(pull.number), "--repo", authorization.repository, "--required", "--json", "name,state",
  ]);
  if (!result.ok || !Array.isArray(result.value) || result.value.length === 0) {
    throw new Error(`DELIVERY_REQUIRED_CHECK_EVIDENCE_UNAVAILABLE: ${result.error ?? "missing required checks"}`);
  }
  const checks = result.value.map((check) => ({ name: stringValue(check, "name"), state: stringValue(check, "state") }));
  if (checks.some((check) => !check.name || !check.state)) throw new Error("DELIVERY_REQUIRED_CHECK_EVIDENCE_INVALID");
  return checks as Array<{ name: string; state: string }>;
}

export function mergeDelivery(options: {
  projectRoot: string;
  authorizationHash: string;
  pullRequest: number;
  now?: Date;
}): DeliveryReceipt {
  const root = repositoryRoot(options.projectRoot);
  const status = deliveryStatus(root, options.authorizationHash);
  if (status.invalidation) throw new Error(status.invalidation);
  if (status.authorization.capabilities.mergeMode !== "checks-green") throw new Error("DELIVERY_MERGE_REQUIRES_HUMAN_GATE");
  const featureRoot = featureWorktree(root, status.authorization.featureBranch);
  requireCleanWorktree(featureRoot);
  observedEndpoint(root, status.authorization);
  const head = commit(featureRoot, "HEAD");
  const pull = exactPullRequest(root, status.authorization, options.pullRequest);
  if (pull.state !== "open" || pull.head !== head || pull.mergeable !== true) throw new Error("DELIVERY_PULL_REQUEST_NOT_MERGEABLE");
  const checks = requiredChecks(root, status.authorization, pull);
  if (checks.some((check) => check.state !== "SUCCESS")) throw new Error("DELIVERY_REQUIRED_CHECKS_NOT_GREEN");
  const merged = githubApi(root, [
    "--method", "PUT", `repos/${status.authorization.repository}/pulls/${pull.number}/merge`,
    "--raw-field", `sha=${head}`,
    "--raw-field", "merge_method=squash",
  ]);
  if (objectValue(merged, "merged") !== true) throw new Error("DELIVERY_MERGE_UNVERIFIED");
  const verified = exactPullRequest(root, status.authorization, pull.number);
  if (verified.state !== "closed" || !verified.merged || verified.head !== head) throw new Error("DELIVERY_MERGE_VERIFICATION_FAILED");
  return writeDeliveryReceipt({
    projectRoot: root,
    authorizationHash: options.authorizationHash,
    action: "merge",
    beforeHead: head,
    afterHead: head,
    evidence: { number: verified.number, url: verified.url, head, checks },
    now: options.now,
  });
}

export function classifyCiFailure(log: string, step: CiFailureStep = "unknown"): CiFailureClassification {
  const value = log.toLowerCase();
  if (/assertionerror|expected .* to |coverage .*<|lint|typecheck|typescript error|build failed|test timed out|vitest-worker.*timeout|eperm|gocache|spawn(?:sync)? gh enoent/u.test(value)) {
    return { kind: "deterministic", reason: "test, quality gate, path, permission, or toolchain failure" };
  }
  const checkoutTransport = step === "checkout" && /failed to connect to github\.com|connection reset|network is unreachable|tls handshake timeout/u.test(value);
  const cacheTransport = step === "cache" && /(?:download|restore).*(?:timeout|failed|reset)/u.test(value);
  const runnerTransport = step === "runner" && /runner.*(?:offline|lost)|github.*5\d\d/u.test(value);
  if (checkoutTransport || cacheTransport || runnerTransport) {
    return { kind: "infrastructure", reason: "transient network, runner, service, or cache transport failure" };
  }
  return { kind: "unknown", reason: "failure does not have a safe infrastructure signature" };
}

export function canRetryCi(options: {
  authorization: DeliveryAuthorization;
  currentHead: string;
  runHead: string;
  runId: string;
  workflow: string;
  job: string;
  requiredCheck: string;
  step: CiFailureStep;
  attempt: number;
  failedLog: string;
}): { retry: boolean; reason: string } {
  if (!options.authorization.capabilities.retryInfrastructureCi) return { retry: false, reason: "DELIVERY_CI_RETRY_NOT_AUTHORIZED" };
  if (!options.runId || !options.workflow || !options.job || !options.requiredCheck || options.step === "unknown") {
    return { retry: false, reason: "DELIVERY_CI_EVIDENCE_INCOMPLETE" };
  }
  if (options.runHead !== options.currentHead) return { retry: false, reason: "DELIVERY_CI_HEAD_DRIFT" };
  const classification = classifyCiFailure(options.failedLog, options.step);
  if (classification.kind !== "infrastructure") return { retry: false, reason: `DELIVERY_CI_${classification.kind.toUpperCase()}` };
  if (options.attempt >= options.authorization.retryLimit + 1) return { retry: false, reason: "DELIVERY_CI_RETRY_EXHAUSTED" };
  return { retry: true, reason: classification.reason };
}
