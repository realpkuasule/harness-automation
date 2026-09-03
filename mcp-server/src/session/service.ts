import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { atomicWrite, hashObject, readJson, safePath, sha256 } from "../v2/fs.js";
import { readLatestReceiptEvent, readLkgChain, readReceiptChain } from "../receipt/service.js";
import {
  deliveryPrepareJournalSchema,
  localBoardSchema,
  type DeliveryPrepareJournal,
} from "../delivery/prepare.js";
import { observeProvider } from "../worktree/provider.js";
import { loadWorktreeConfig } from "../worktree/config.js";
import { runGitCommand } from "../repository/git.js";
import { deliveryStatus, latestDeliveryAuthorization } from "../delivery/service.js";
import type { WorkspaceLease, WorktreeDeliveryConfig } from "../worktree/types.js";
import {
  appendReceiptsComment,
  readIssue,
  readProjectField,
  updateProjectField,
} from "./provider.js";
import {
  loadSessionWorkflow,
  readTemplate,
  renderTemplate,
  type LoadedWorkflow,
} from "./templates.js";
import {
  HANDOFF_FROM_STATUS,
  HANDOFF_CONTINUATION_STATUS,
  HANDOFF_REVIEW_STATUS,
  SESSION_HANDOFF_RECEIPT_SCHEMA_VERSION,
  parseWorkItem,
  type HandoffCommitEntry,
  type HandoffDocValidation,
  type GitHubParsedWorkItem,
  type LocalParsedWorkItem,
  type ParsedWorkItem,
  type SessionReceipt,
} from "./types.js";

const SEED_SECTION_HEADING = "## SEED（由 CLI 确定性生成，勿手改）";

const HANDOFF_SECTIONS = [
  "## 目标与验收标准",
  "## 已完成（附 commit / 回执）",
  "## 当前状态（跑通什么、依赖什么、密钥位置）",
  "## 已知问题与未决项",
  "## 下一步建议（编号列表，供新会话认领）",
  "## 引用文件（路径列表，新会话必须读）",
  SEED_SECTION_HEADING,
] as const;

const REFERENCE_SECTION = "## 引用文件（路径列表，新会话必须读）";
const COMPLETED_SECTION = "## 已完成（附 commit / 回执）";

function git(root: string, args: string[]): string {
  const result = runGitCommand(root, args, process.env);
  if (result.status !== 0) {
    throw new Error(`GIT_REPOSITORY_REQUIRED: git ${args.join(" ")} failed (${result.stderr.trim() || result.status})`);
  }
  return result.stdout;
}

function gitCommonDir(root: string): string {
  return git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();
}

function headCommit(root: string): string {
  return git(root, ["rev-parse", "HEAD"]).trim();
}

function commitsSince(root: string, sinceSha: string | null): HandoffCommitEntry[] {
  const range = sinceSha ? `${sinceSha}..HEAD` : "HEAD";
  const output = git(root, ["log", `--format=%h %s`, range]);
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const space = line.indexOf(" ");
      return {
        sha: space === -1 ? line : line.slice(0, space),
        subject: space === -1 ? "" : line.slice(space + 1),
      };
    });
}

interface SectionBlock {
  heading: string;
  lines: string[];
}

function splitSections(content: string): SectionBlock[] {
  const sections: SectionBlock[] = [];
  let current: SectionBlock | null = null;
  for (const line of content.split("\n")) {
    const heading = line.trim();
    if (heading.startsWith("## ")) {
      current = { heading, lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return sections;
}

function receiptLibrary(projectRoot: string, commonDir: string): Map<string, string> {
  const entries = new Map<string, string>();
  const directories = [
    safePath(commonDir, "harness/session-handoff/receipts"),
    safePath(commonDir, "harness/worktree-delivery/receipts"),
    safePath(projectRoot, ".harness/sessions"),
    safePath(projectRoot, ".harness/eval-runs"),
  ];
  for (const directory of directories) {
    if (!existsSync(directory) || !lstatSync(directory).isDirectory()) continue;
    for (const name of readdirSync(directory)) {
      if (!name.endsWith(".json")) continue;
      const path = join(directory, name);
      if (!lstatSync(path).isFile()) continue;
      entries.set(name.slice(0, -".json".length), path);
    }
  }
  const prepareReceipts = safePath(commonDir, "harness/receipts/delivery-prepare");
  if (existsSync(prepareReceipts) && lstatSync(prepareReceipts).isDirectory()) {
    for (const transactionId of readdirSync(prepareReceipts).sort()) {
      if (!/^prepare-[a-f0-9]{24}$/u.test(transactionId)) continue;
      for (const event of readReceiptChain({ root: commonDir, domain: "delivery-prepare", transactionId })) {
        entries.set(event.eventHash, safePath(prepareReceipts, `${transactionId}/events/${String(event.sequence).padStart(12, "0")}.json`));
      }
    }
  }
  for (const record of readLkgChain({ root: commonDir, domain: "delivery-prepare" })) {
    entries.set(record.recordHash, safePath(commonDir, `harness/lkg/delivery-prepare/records/${String(record.sequence).padStart(12, "0")}.json`));
  }
  return entries;
}

function validateDocContent(
  projectRoot: string,
  commonDir: string,
  content: string,
): Omit<HandoffDocValidation, "exists"> {
  const problems: string[] = [];
  const referencedFiles: string[] = [];
  const receiptIds: string[] = [];
  const placeholders: string[] = [];
  const sections = splitSections(content);
  const headings = new Map(sections.map((section) => [section.heading, section]));

  for (const expected of HANDOFF_SECTIONS) {
    if (!headings.has(expected)) problems.push(`MISSING_SECTION: ${expected}`);
  }
  for (const section of sections) {
    if (section.heading === SEED_SECTION_HEADING) continue;
    for (const line of section.lines) {
      if (/\{\{[^{}]*\}\}/u.test(line)) {
        const placeholder = line.trim();
        placeholders.push(placeholder);
        problems.push(`UNFILLED_PLACEHOLDER: ${placeholder}`);
      }
    }
  }
  const referenceSection = headings.get(REFERENCE_SECTION);
  if (referenceSection) {
    for (const raw of referenceSection.lines) {
      const line = raw.trim();
      if (!line || line.startsWith(">") || line.startsWith("#")) continue;
      if (/\{\{[^{}]*\}\}/u.test(line)) continue;
      referencedFiles.push(line);
      try {
        const path = safePath(projectRoot, line);
        if (!existsSync(path) || !lstatSync(path).isFile()) {
          problems.push(`MISSING_REFERENCE_FILE: ${line}`);
        }
      } catch (error) {
        problems.push(`INVALID_REFERENCE_PATH: ${line} (${error instanceof Error ? error.message : String(error)})`);
      }
    }
    if (referencedFiles.length === 0) {
      problems.push(`MISSING_REFERENCE_FILE: ${REFERENCE_SECTION} 必须列出至少一个仓库内文件`);
    }
  }
  const completedSection = headings.get(COMPLETED_SECTION);
  const library = receiptLibrary(projectRoot, commonDir);
  if (completedSection) {
    for (const raw of completedSection.lines) {
      for (const match of raw.matchAll(/(?:回执|receipt)\s*[:：]\s*([A-Za-z0-9][A-Za-z0-9._-]*)/gu)) {
        const id = match[1];
        receiptIds.push(id);
        if (!library.has(id)) problems.push(`UNKNOWN_RECEIPT: ${id}`);
      }
    }
  }
  return {
    valid: problems.length === 0,
    problems,
    referencedFiles: [...new Set(referencedFiles)],
    receiptIds: [...new Set(receiptIds)],
    placeholders,
  };
}

function validateHandoffDoc(
  projectRoot: string,
  commonDir: string,
  path: string,
): HandoffDocValidation {
  if (!existsSync(path)) {
    return {
      exists: false,
      valid: false,
      problems: [`SESSION_HANDOFF_DOC_MISSING: ${path}`],
      referencedFiles: [],
      receiptIds: [],
      placeholders: [],
    };
  }
  const content = readFileSync(path, "utf8");
  return { exists: true, ...validateDocContent(projectRoot, commonDir, content) };
}

function handoffDocPath(projectRoot: string, workItem: ParsedWorkItem): string {
  return safePath(projectRoot, workItem.provider === "github"
    ? `docs/HANDOFF-${workItem.number}.md`
    : `docs/HANDOFF-local-${workItem.id}.md`);
}

function withSeedSection(content: string, seed: string): string {
  const lines = content.split("\n");
  const index = lines.findIndex((line) => line.trim() === SEED_SECTION_HEADING);
  if (index === -1) return content;
  return [...lines.slice(0, index + 1), seed].join("\n");
}

type SeedValues = {
  projectName: string;
  repoUrl: string;
  goal: string;
  acceptance: string;
  handoffPath: string;
  constraints: string;
};

function renderSeed(loaded: LoadedWorkflow, values: SeedValues): string {
  return renderTemplate(readTemplate(loaded, "seed"), values);
}

function acceptanceValue(
  loaded: LoadedWorkflow,
  root: string,
  config: WorktreeDeliveryConfig,
  workItem: GitHubParsedWorkItem,
  body: string,
  url: string,
): string {
  const project = config.provider.kind === "github" ? config.provider.project : undefined;
  if (project) {
    try {
      const read = readProjectField(
        root,
        `${workItem.owner}/${workItem.repository}`,
        project,
        workItem.number,
        loaded.workflow.provider.project.acceptanceField,
      );
      if (read.present && read.value && read.value.trim()) return read.value.trim();
    } catch {
      // 看板字段读取失败时回退到 issue body 解析，不影响确定性。
    }
  }
  const lines = body.split("\n");
  const headingIndex = lines.findIndex((line) => /^#{2,3}\s*验收标准/u.test(line.trim()));
  if (headingIndex !== -1) {
    const collected: string[] = [];
    for (const line of lines.slice(headingIndex + 1)) {
      if (/^#{1,3}\s/u.test(line.trim())) break;
      collected.push(line);
    }
    const value = collected.join("\n").trim();
    if (value) return value;
  }
  return `（issue 未配置结构化验收字段，见 ${url}）`;
}

function sessionReceiptsDir(commonDir: string): string {
  return safePath(commonDir, "harness/session-handoff/receipts");
}

function lastReceiptFor(
  projectRoot: string,
  commonDir: string,
  workItem: string,
): { receipt: SessionReceipt; path: string } | null {
  const directory = sessionReceiptsDir(commonDir);
  if (!existsSync(directory) || !lstatSync(directory).isDirectory()) return null;
  let latest: { receipt: SessionReceipt; path: string } | null = null;
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".json")) continue;
    const path = join(directory, name);
    try {
      if (!lstatSync(path).isFile()) continue;
      const receipt = readJson<SessionReceipt>(path);
      if (receipt.kind !== "session-handoff-receipt" || receipt.workItem !== workItem) continue;
      if (!latest || receipt.at > latest.receipt.at) latest = { receipt, path };
    } catch {
      continue;
    }
  }
  return latest;
}

export interface SessionCommandOptions {
  projectRoot: string;
  workItem?: string;
  session?: string;
  toStatus?: string;
  dryRun?: boolean;
}

function parseSessionId(session: string | undefined): string {
  if (!session) throw new Error("ARGUMENT_REQUIRED: --session");
  if (!/^[A-Za-z0-9._-]{1,200}$/u.test(session)) {
    throw new Error("SESSION_ID_INVALID: --session must be 1-200 chars of [A-Za-z0-9._-]");
  }
  return session;
}

function parsedWorkItem(input: string | undefined): ParsedWorkItem {
  if (!input) throw new Error("ARGUMENT_REQUIRED: --work-item");
  const parsed = parseWorkItem(input);
  if (!parsed) throw new Error(`SESSION_WORK_ITEM_INVALID: expected github:<owner>/<repo>#<number> or local:<id>, got ${input}`);
  return parsed;
}

function githubProviderConfig(root: string): {
  configured: boolean;
  config: WorktreeDeliveryConfig;
} {
  const loaded = loadWorktreeConfig(root);
  if (!loaded.configured || loaded.config.provider.kind !== "github") {
    throw new Error("SESSION_PROVIDER_UNSUPPORTED: session commands require a GitHub provider in .harness/worktree-delivery.json");
  }
  return { configured: true, config: loaded.config };
}

function providerProject(
  config: WorktreeDeliveryConfig,
): NonNullable<WorktreeDeliveryConfig["provider"]["project"]> {
  const project = config.provider.kind === "github" ? config.provider.project : undefined;
  if (!project) {
    throw new Error("SESSION_PROJECT_CONFIG_REQUIRED: provider project mapping is required for issue field updates and status transitions");
  }
  return project;
}

function assertRepositoryMatch(config: WorktreeDeliveryConfig, workItem: GitHubParsedWorkItem): void {
  const repository = config.provider.kind === "github" ? config.provider.repository?.trim().toLowerCase() : undefined;
  const expected = `${workItem.owner}/${workItem.repository}`.toLowerCase();
  if (repository !== expected) {
    throw new Error(`SESSION_WORK_ITEM_REPOSITORY_MISMATCH: ${workItem.workItem} does not belong to configured repository ${repository ?? "none"}`);
  }
}

interface LocalSessionEvidence {
  task: ReturnType<typeof localBoardSchema.parse>["tasks"][number];
  lease: WorkspaceLease;
  worktree: LocalWorktreeEvidence;
  journal: DeliveryPrepareJournal;
  receiptEventHash: string;
  lkgRecordHash: string;
}

interface LocalWorktreeEvidence {
  path: string;
  branch: string;
  head: string;
  dirty: boolean;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
}

function localLease(commonDir: string, workItem: LocalParsedWorkItem): WorkspaceLease {
  const path = safePath(commonDir, `harness/worktree-delivery/leases/${sha256(workItem.workItem)}.json`);
  if (!existsSync(path) || !lstatSync(path).isFile()) throw new Error(`SESSION_LOCAL_LEASE_INVALID: ${workItem.workItem}`);
  const lease = readJson<Partial<WorkspaceLease>>(path);
  const required = ["workItem", "branch", "path", "owner", "acceptedCommit", "createdAt", "heartbeatAt", "status"] as const;
  if (lease.schemaVersion !== "1.0" || lease.workItem !== workItem.workItem ||
      required.some((key) => typeof lease[key] !== "string") ||
      !["active", "review", "done"].includes(String(lease.status)) ||
      !Number.isFinite(Date.parse(String(lease.createdAt))) || !Number.isFinite(Date.parse(String(lease.heartbeatAt)))) {
    throw new Error(`SESSION_LOCAL_LEASE_INVALID: ${workItem.workItem}`);
  }
  return lease as WorkspaceLease;
}

function localWorktree(root: string, lease: WorkspaceLease): LocalWorktreeEvidence {
  type Entry = Omit<LocalWorktreeEvidence, "dirty">;
  const entries: Entry[] = [];
  let current: Entry | null = null;
  for (const token of git(root, ["worktree", "list", "--porcelain", "-z"]).split("\0")) {
    if (!token) {
      if (current) entries.push(current);
      current = null;
      continue;
    }
    const separator = token.indexOf(" ");
    const key = separator === -1 ? token : token.slice(0, separator);
    const value = separator === -1 ? "" : token.slice(separator + 1);
    if (key === "worktree") {
      if (current) entries.push(current);
      current = { path: value, branch: "", head: "", bare: false, detached: false, locked: false, prunable: false };
    } else if (!current) {
      throw new Error("SESSION_LOCAL_WORKTREE_INVALID");
    } else if (key === "HEAD") current.head = value;
    else if (key === "branch") current.branch = value.replace(/^refs\/heads\//u, "");
    else if (key === "bare") current.bare = true;
    else if (key === "detached") current.detached = true;
    else if (key === "locked") current.locked = true;
    else if (key === "prunable") current.prunable = true;
  }
  if (current) entries.push(current);
  const matches = entries.filter((entry) => resolve(entry.path) === resolve(lease.path) && entry.branch === lease.branch);
  if (matches.length !== 1) throw new Error(`SESSION_LOCAL_WORKTREE_INVALID: ${lease.workItem}`);
  return {
    ...matches[0],
    dirty: git(lease.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).length > 0,
  };
}

function localSessionEvidence(root: string, workItem: LocalParsedWorkItem): LocalSessionEvidence {
  const commonDir = gitCommonDir(root);
  const boardPath = safePath(commonDir, "harness/local-tracking/TASK.json");
  if (!existsSync(boardPath)) throw new Error(`SESSION_LOCAL_TASK_NOT_FOUND: ${workItem.workItem}`);
  const board = localBoardSchema.parse(readJson<unknown>(boardPath));
  const tasks = board.tasks.filter((task) => task.id === workItem.id && task.status !== "deleted");
  if (tasks.length !== 1) throw new Error(`SESSION_LOCAL_TASK_INVALID: ${workItem.workItem}`);

  const lease = localLease(commonDir, workItem);
  if (lease.status !== "active") throw new Error(`SESSION_LOCAL_LEASE_INVALID: ${workItem.workItem}`);
  const worktree = localWorktree(root, lease);
  if (worktree.detached || worktree.bare || worktree.locked || worktree.prunable) {
    throw new Error(`SESSION_LOCAL_WORKTREE_INVALID: ${workItem.workItem}`);
  }
  const ancestry = runGitCommand(lease.path, ["merge-base", "--is-ancestor", lease.acceptedCommit, worktree.head], process.env);
  if (ancestry.error || ancestry.status !== 0) throw new Error(`SESSION_LOCAL_HEAD_DRIFT: ${workItem.workItem}`);

  const journals = safePath(commonDir, "harness/delivery-prepare/journals");
  const prepared: Array<{ journal: DeliveryPrepareJournal; receiptEventHash: string }> = [];
  if (existsSync(journals) && lstatSync(journals).isDirectory()) {
    for (const name of readdirSync(journals).filter((entry) => /^prepare-[a-f0-9]{24}\.json$/u.test(entry)).sort()) {
      const transactionId = name.slice(0, -".json".length);
      const projection = deliveryPrepareJournalSchema.parse(readJson<unknown>(join(journals, name)));
      const event = readLatestReceiptEvent<DeliveryPrepareJournal>({
        root: commonDir,
        domain: "delivery-prepare",
        transactionId,
        compatibilitySnapshot: projection,
      });
      if (!event) continue;
      const journal = deliveryPrepareJournalSchema.parse(event.snapshot);
      const unhashed = { ...journal };
      delete (unhashed as Partial<DeliveryPrepareJournal>).journalHash;
      if (journal.journalHash !== hashObject(unhashed)) throw new Error("SESSION_LOCAL_PREPARE_INVALID");
      if (journal.workItem === workItem.workItem && journal.state === "Prepared" && journal.outcome === "PreparedNotOpened") {
        prepared.push({ journal, receiptEventHash: event.eventHash });
      }
    }
  }
  if (prepared.length !== 1) throw new Error(`SESSION_LOCAL_PREPARE_INVALID: ${workItem.workItem}`);
  const evidence = prepared[0];
  if (evidence.journal.branch !== lease.branch || resolve(evidence.journal.path ?? "") !== resolve(lease.path)) {
    throw new Error(`SESSION_LOCAL_BINDING_DRIFT: ${workItem.workItem}`);
  }
  const lkg = readLkgChain({ root: commonDir, domain: "delivery-prepare" })
    .filter((record) => record.transactionId === evidence.journal.transactionId && record.receiptEventHash === evidence.receiptEventHash);
  if (lkg.length !== 1) throw new Error(`SESSION_LOCAL_LKG_INVALID: ${workItem.workItem}`);
  return {
    task: tasks[0],
    lease,
    worktree,
    journal: evidence.journal,
    receiptEventHash: evidence.receiptEventHash,
    lkgRecordHash: lkg[0].recordHash,
  };
}

function localSeed(root: string, loaded: LoadedWorkflow, workItem: LocalParsedWorkItem): { seed: string; evidence: LocalSessionEvidence } {
  const evidence = localSessionEvidence(root, workItem);
  const path = `docs/HANDOFF-local-${workItem.id}.md`;
  const seed = renderSeed(loaded, {
    projectName: basename(root),
    repoUrl: `local:${root}`,
    goal: evidence.task.title,
    acceptance: evidence.task.description.replace(/\n\n<!-- harness-automation:delivery-prepare:[^>]+ -->\s*$/u, ""),
    handoffPath: path,
    constraints: loaded.workflow.seed.constraints,
  });
  return {
    evidence,
    seed: `${seed}\n\n【本地持久证据】TASK ${workItem.workItem}\n分支：${evidence.lease.branch}\n路径：${evidence.lease.path}\nHEAD：${evidence.worktree.head}\nPrepare 回执：${evidence.receiptEventHash}\nLKG：${evidence.lkgRecordHash}`,
  };
}

/** `session seed`：仅渲染 seed prompt，不落盘、不流转。 */
export function sessionSeed(options: SessionCommandOptions): { ok: true; seed: string } {
  const root = options.projectRoot;
  const workItem = parsedWorkItem(options.workItem);
  const loaded = loadSessionWorkflow(root);
  if (workItem.provider === "local") return { ok: true, seed: localSeed(root, loaded, workItem).seed };
  const authorization = latestDeliveryAuthorization(root, workItem.workItem);
  const configured = loadWorktreeConfig(root);
  if (configured.config.provider.kind === "github") assertRepositoryMatch(configured.config, workItem);
  let issue: { title: string; body: string; url: string };
  try {
    issue = readIssue(root, workItem);
  } catch (error) {
    if (!authorization) throw error;
    issue = {
      title: authorization.intent,
      body: "",
      url: `https://github.com/${workItem.owner}/${workItem.repository}/issues/${workItem.number}`,
    };
  }
  const handoffPath = `docs/HANDOFF-${workItem.number}.md`;
  const acceptance = acceptanceValue(loaded, root, configured.config, workItem, issue.body, issue.url);
  const seed = renderSeed(loaded, {
    projectName: workItem.repository,
    repoUrl: `https://github.com/${workItem.owner}/${workItem.repository}`,
    goal: issue.title,
    acceptance,
    handoffPath,
    constraints: loaded.workflow.seed.constraints,
  });
  const delivery = authorization ? deliveryStatus(root, authorization.authorizationHash) : null;
  const authorizationBlock = delivery
    ? `\n\n【交付授权】${delivery.authorization.authorizationHash}\n阶段：${delivery.phase}${delivery.invalidation ? `\n暂停原因：${delivery.invalidation}` : ""}`
    : "\n\n【交付授权】未找到有效授权回执；在执行外部交付动作前先取得一次覆盖完整工作流的授权。";
  return { ok: true, seed: `${seed}${authorizationBlock}` };
}

/** `session status`：只读。`--work-item` 缺省时扫描 docs/HANDOFF-*.md。 */
export function sessionStatus(options: SessionCommandOptions): {
  ok: true;
  project: string;
  workflow: { source: string; path: string };
  items: Array<Record<string, unknown>>;
} {
  const root = options.projectRoot;
  const loaded = loadSessionWorkflow(root);
  let items: ParsedWorkItem[];
  if (options.workItem) {
    items = [parsedWorkItem(options.workItem)];
  } else {
    items = [];
    const docsDir = safePath(root, "docs");
    if (existsSync(docsDir) && lstatSync(docsDir).isDirectory()) {
      for (const name of readdirSync(docsDir).sort()) {
        const localMatch = /^HANDOFF-local-([A-Za-z0-9][A-Za-z0-9._-]*)\.md$/u.exec(name);
        if (localMatch) {
          items.push(parseWorkItem(`local:${localMatch[1]}`) as ParsedWorkItem);
          continue;
        }
        const match = /^HANDOFF-(\d+)\.md$/u.exec(name);
        if (!match) continue;
        try {
          const config = githubProviderConfig(root);
          const repository = config.config.provider.kind === "github"
            ? config.config.provider.repository?.trim()
            : undefined;
          if (!repository) continue;
          items.push(parseWorkItem(`github:${repository}#${match[1]}`) as ParsedWorkItem);
        } catch {
          continue;
        }
      }
    }
  }
  const commonDir = ((): string | null => {
    try { return gitCommonDir(root); } catch { return null; }
  })();
  const statuses = items.map((workItem) => {
    const docPath = handoffDocPath(root, workItem);
    const doc = commonDir
      ? validateHandoffDoc(root, commonDir, docPath)
      : { exists: existsSync(docPath), valid: false, problems: ["GIT_REPOSITORY_REQUIRED"], referencedFiles: [], receiptIds: [], placeholders: [] };
    const last = commonDir ? lastReceiptFor(root, commonDir, workItem.workItem) : null;
    if (workItem.provider === "local") {
      try {
        const evidence = localSessionEvidence(root, workItem);
        return {
          workItem: workItem.workItem,
          task: {
            available: true,
            title: evidence.task.title,
            description: evidence.task.description,
            status: evidence.task.status,
            priority: evidence.task.priority,
          },
          workspace: {
            branch: evidence.lease.branch,
            path: evidence.lease.path,
            head: evidence.worktree.head,
            dirty: evidence.worktree.dirty,
          },
          prepare: {
            transactionId: evidence.journal.transactionId,
            outcome: evidence.journal.outcome,
            receiptEventHash: evidence.receiptEventHash,
            lkgRecordHash: evidence.lkgRecordHash,
          },
          handoffDoc: { path: docPath, ...doc },
          lastReceipt: last ? {
            id: last.receipt.id,
            at: last.receipt.at,
            commit: last.receipt.commit,
            handoffDocHash: last.receipt.handoffDocHash,
          } : null,
          delivery: null,
        };
      } catch (error) {
        return {
          workItem: workItem.workItem,
          task: { available: false, error: error instanceof Error ? error.message : String(error) },
          handoffDoc: { path: docPath, ...doc },
          lastReceipt: null,
          delivery: null,
        };
      }
    }
    let delivery: Record<string, unknown> | null = null;
    try {
      const authorization = latestDeliveryAuthorization(root, workItem.workItem);
      if (authorization) {
        const status = deliveryStatus(root, authorization.authorizationHash);
        delivery = {
          authorizationHash: authorization.authorizationHash,
          phase: status.phase,
          invalidation: status.invalidation,
          receipts: status.receipts.map((receipt) => receipt.id),
        };
      }
    } catch (error) {
      delivery = { error: error instanceof Error ? error.message : String(error) };
    }
    let issue: Record<string, unknown>;
    try {
      const observed = readIssue(root, workItem);
      let projectStatus: string | undefined;
      let projectItemPresent: boolean | undefined;
      try {
        const config = githubProviderConfig(root);
        const project = config.config.provider.kind === "github" ? config.config.provider.project : undefined;
        if (project) {
          const observation = observeProvider(root, config.config, [], [workItem.workItem]);
          if (observation.kind === "github" && observation.available) {
            projectStatus = observation.items[0]?.projectStatus;
            projectItemPresent = observation.items[0]?.projectItemPresent;
          }
        }
      } catch {
        // 看板读取失败不影响 issue 基本信息展示。
      }
      issue = {
        available: true,
        state: observed.state,
        title: observed.title,
        url: observed.url,
        projectStatus,
        projectItemPresent,
      };
    } catch (error) {
      issue = { available: false, error: error instanceof Error ? error.message : String(error) };
    }
    return {
      workItem: workItem.workItem,
      issue,
      handoffDoc: {
        path: docPath,
        ...doc,
      },
      lastReceipt: last
        ? {
            id: last.receipt.id,
            at: last.receipt.at,
            commit: last.receipt.commit,
            handoffDocHash: last.receipt.handoffDocHash,
          }
        : null,
      delivery,
    };
  });
  return {
    ok: true,
    project: root,
    workflow: { source: loaded.source, path: loaded.workflowPath },
    items: statuses,
  };
}

export interface SessionHandoffResult {
  ok: true;
  phase: "draft" | "ready";
  dryRun: boolean;
  handoffDocPath: string;
  seed: string;
  receipt?: {
    id: string;
    handoffDocHash: string;
    commit: string;
    fromStatus: string | null;
    toStatus: string;
  };
  issueUpdates?: {
    receiptsComment: { planned: boolean; receiptIds: string[] };
    fields: string[];
  };
  nextSteps: string[];
}

function statusName(value: string | undefined | null): string | null {
  return value && value.trim() ? value.trim() : null;
}

/** 看板显示名 -> 协议状态名（kebab）；未映射时原样返回，由流转校验给出明确拒绝。 */
function normalizeStatus(display: string | null, statusValues: Record<string, string>): string | null {
  const value = statusName(display);
  if (!value) return null;
  for (const [kebab, label] of Object.entries(statusValues)) {
    if (label === value) return kebab;
  }
  return value;
}

/** 协议状态名 -> 看板显示名；未映射时原样返回（写入将因选项缺失而失败）。 */
function displayStatus(kebab: string, statusValues: Record<string, string>): string {
  return statusValues[kebab] ?? kebab;
}

function localSessionHandoff(
  options: SessionCommandOptions,
  workItem: LocalParsedWorkItem,
  sessionId: string,
  toStatus: string,
  loaded: LoadedWorkflow,
): SessionHandoffResult {
  const root = options.projectRoot;
  const dryRun = options.dryRun === true;
  const { seed, evidence } = localSeed(root, loaded, workItem);
  const repositoryPath = resolve(git(root, ["rev-parse", "--show-toplevel"]).trim());
  if (repositoryPath !== resolve(evidence.lease.path) || currentBranchForSession(root) !== evidence.lease.branch) {
    throw new Error(`SESSION_LOCAL_BINDING_DRIFT: ${workItem.workItem}`);
  }
  const docPath = handoffDocPath(root, workItem);
  const relativeDocPath = `docs/HANDOFF-local-${workItem.id}.md`;
  const commonDir = gitCommonDir(root);
  const lastReceipt = lastReceiptFor(root, commonDir, workItem.workItem);
  const commit = headCommit(root);

  if (!existsSync(docPath)) {
    const completed = commitsSince(root, lastReceipt?.receipt.commit ?? null)
      .map((entry) => `- ${entry.sha} ${entry.subject}`.trimEnd())
      .join("\n");
    const draft = renderTemplate(readTemplate(loaded, "handoff"), {
      issueNumber: workItem.workItem,
      goal: evidence.task.title,
      acceptance: evidence.task.description,
      completed,
      seed,
    });
    if (!dryRun) atomicWrite(docPath, draft);
    return {
      ok: true,
      phase: "draft",
      dryRun,
      handoffDocPath: docPath,
      seed,
      nextSteps: [
        "填充交接文档各内容段，并引用 Prepare 回执或 LKG",
        `重新运行 session handoff --work-item ${workItem.workItem} --session ${sessionId}`,
      ],
    };
  }

  const existing = readFileSync(docPath, "utf8");
  const initialValidation = validateDocContent(root, commonDir, existing);
  if (!initialValidation.valid) throw new Error(`SESSION_HANDOFF_DOC_INVALID: ${initialValidation.problems.join("; ")}`);
  const content = withSeedSection(existing, seed);
  const finalValidation = validateDocContent(root, commonDir, content);
  if (!finalValidation.valid) throw new Error(`SESSION_HANDOFF_DOC_INVALID: ${finalValidation.problems.join("; ")}`);
  if (!finalValidation.receiptIds.includes(evidence.receiptEventHash) && !finalValidation.receiptIds.includes(evidence.lkgRecordHash)) {
    throw new Error("SESSION_LOCAL_PREPARE_EVIDENCE_REQUIRED");
  }
  const handoffDocHash = sha256(content);
  const receiptId = `handoff-local-${workItem.id}-${handoffDocHash.slice(0, 12)}`;
  const fromStatus = evidence.task.status === "in_progress" ? "in-progress" : evidence.task.status;
  const receiptPreview = { id: receiptId, handoffDocHash, commit, fromStatus, toStatus };
  if (dryRun) {
    return {
      ok: true,
      phase: "ready",
      dryRun: true,
      handoffDocPath: docPath,
      seed,
      receipt: receiptPreview,
      nextSteps: [`去掉 --dry-run 执行本地交接：session handoff --work-item ${workItem.workItem} --session ${sessionId}`],
    };
  }

  atomicWrite(docPath, content);
  const receipt: SessionReceipt = {
    schemaVersion: SESSION_HANDOFF_RECEIPT_SCHEMA_VERSION,
    kind: "session-handoff-receipt",
    id: receiptId,
    workItem: workItem.workItem,
    session: sessionId,
    handoffDocPath: relativeDocPath,
    handoffDocHash,
    commit,
    receiptIds: finalValidation.receiptIds,
    fromStatus,
    toStatus,
    at: new Date().toISOString(),
  };
  const receiptPath = safePath(commonDir, `harness/session-handoff/receipts/${receiptId}.json`);
  if (!existsSync(receiptPath)) atomicWrite(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return {
    ok: true,
    phase: "ready",
    dryRun: false,
    handoffDocPath: docPath,
    seed,
    receipt: receiptPreview,
    nextSteps: ["新会话从本地 TASK、lease、Prepare 回执与 LKG 恢复，不以聊天摘要覆盖持久证据"],
  };
}

function currentBranchForSession(root: string): string {
  return git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).trim();
}

/** `session handoff`：两阶段。文档缺失时生成模板骨架（不流转）；文档齐备时校验、回执、issue 更新。 */
export function sessionHandoff(options: SessionCommandOptions): SessionHandoffResult {
  const root = options.projectRoot;
  const dryRun = options.dryRun === true;
  const workItem = parsedWorkItem(options.workItem);
  const sessionId = parseSessionId(options.session);
  const toStatus = options.toStatus ?? HANDOFF_CONTINUATION_STATUS;
  if (toStatus !== HANDOFF_CONTINUATION_STATUS && toStatus !== HANDOFF_REVIEW_STATUS) {
    throw new Error(`SESSION_TO_STATUS_UNSUPPORTED: choose ${HANDOFF_CONTINUATION_STATUS} or explicit ${HANDOFF_REVIEW_STATUS}`);
  }
  const loaded = loadSessionWorkflow(root);
  if (workItem.provider === "local") return localSessionHandoff(options, workItem, sessionId, toStatus, loaded);
  const config = githubProviderConfig(root);
  assertRepositoryMatch(config.config, workItem);
  const project = providerProject(config.config);
  const observation = observeProvider(root, config.config, [], [workItem.workItem]);
  if (observation.kind === "github" && !observation.available) {
    throw new Error(`SESSION_PROVIDER_UNAVAILABLE: ${observation.error ?? "GitHub provider unavailable"}`);
  }
  const issue = readIssue(root, workItem);
  const acceptance = acceptanceValue(loaded, root, config.config, workItem, issue.body, issue.url);
  const seedValues: SeedValues = {
    projectName: workItem.repository,
    repoUrl: `https://github.com/${workItem.owner}/${workItem.repository}`,
    goal: issue.title,
    acceptance,
    handoffPath: `docs/HANDOFF-${workItem.number}.md`,
    constraints: loaded.workflow.seed.constraints,
  };
  const seed = renderSeed(loaded, seedValues);
  const docPath = handoffDocPath(root, workItem);
  const commonDir = gitCommonDir(root);
  const lastReceipt = lastReceiptFor(root, commonDir, workItem.workItem);
  const commit = headCommit(root);

  if (!existsSync(docPath)) {
    const commits = commitsSince(root, lastReceipt?.receipt.commit ?? null);
    const completed = commits
      .map((entry) => `- ${entry.sha} ${entry.subject}`.trimEnd())
      .join("\n");
    const draft = renderTemplate(readTemplate(loaded, "handoff"), {
      issueNumber: String(workItem.number),
      goal: issue.title,
      acceptance,
      completed,
      seed,
    });
    if (!dryRun) atomicWrite(docPath, draft);
    return {
      ok: true,
      phase: "draft",
      dryRun,
      handoffDocPath: docPath,
      seed,
      nextSteps: [
        "填充交接文档各内容段（当前状态/已知问题/下一步建议/引用文件）",
        "在「已完成（附 commit / 回执）」中追加本次引用的 harness 回执 id（格式：回执: <id>）",
        `重新运行 session handoff 完成校验、回执与 issue 流转（dry-run 预览: ${dryRun ? "本次未写入任何文件" : "已生成骨架"})`,
      ],
    };
  }

  const existing = readFileSync(docPath, "utf8");
  const initialValidation = validateDocContent(root, commonDir, existing);
  if (!initialValidation.valid) {
    throw new Error(`SESSION_HANDOFF_DOC_INVALID: ${initialValidation.problems.join("; ")}`);
  }
  const content = withSeedSection(existing, seed);
  const finalValidation = validateDocContent(root, commonDir, content);
  if (!finalValidation.valid) {
    throw new Error(`SESSION_HANDOFF_DOC_INVALID: ${finalValidation.problems.join("; ")}`);
  }
  const handoffDocHash = sha256(content);
  const receiptId = `handoff-${workItem.number}-${handoffDocHash.slice(0, 12)}`;
  const observedItem = observation.kind === "github" ? observation.items[0] : undefined;
  const fromStatus = normalizeStatus(
    observedItem?.projectStatus ?? null,
    loaded.workflow.provider.project.statusValues,
  );
  const receiptPreview = {
    id: receiptId,
    handoffDocHash,
    commit,
    fromStatus,
    toStatus,
  };

  if (dryRun) {
    return {
      ok: true,
      phase: "ready",
      dryRun: true,
      handoffDocPath: docPath,
      seed,
      receipt: receiptPreview,
      issueUpdates: {
        receiptsComment: { planned: true, receiptIds: [receiptId, ...finalValidation.receiptIds] },
        fields: [
          ...(toStatus === HANDOFF_REVIEW_STATUS ? [`${project.statusField} -> ${toStatus}`] : []),
          `${loaded.workflow.provider.project.handoffDocField} -> docs/HANDOFF-${workItem.number}.md`,
        ],
      },
      nextSteps: [`去掉 --dry-run 执行交接：node <skill>/scripts/run.mjs session handoff --work-item ${workItem.workItem} --session ${sessionId}`],
    };
  }

  if (observedItem?.projectItemPresent !== true) {
    throw new Error(`SESSION_TRANSITION_REFUSED: issue #${workItem.number} is not present on project #${project.number}; no transition applied`);
  }
  if (fromStatus?.toLowerCase() !== HANDOFF_FROM_STATUS) {
    throw new Error(`SESSION_TRANSITION_REFUSED: expected status ${HANDOFF_FROM_STATUS}, found ${fromStatus ?? "unknown"}; no evidence for this transition`);
  }

  atomicWrite(docPath, content);
  const receipt: SessionReceipt = {
    schemaVersion: SESSION_HANDOFF_RECEIPT_SCHEMA_VERSION,
    kind: "session-handoff-receipt",
    id: receiptId,
    workItem: workItem.workItem,
    session: sessionId,
    handoffDocPath: `docs/HANDOFF-${workItem.number}.md`,
    handoffDocHash,
    commit,
    receiptIds: finalValidation.receiptIds,
    fromStatus,
    toStatus,
    at: new Date().toISOString(),
  };
  const receiptPath = safePath(commonDir, `harness/session-handoff/receipts/${receiptId}.json`);
  atomicWrite(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  const commentReceiptIds = [receiptId, ...finalValidation.receiptIds];
  const comment = appendReceiptsComment(root, workItem, commentReceiptIds);
  const statusValues = loaded.workflow.provider.project.statusValues;
  const fields = [
    ...(toStatus === HANDOFF_REVIEW_STATUS ? [updateProjectField(
      root,
      `${workItem.owner}/${workItem.repository}`,
      project,
      workItem.number,
      project.statusField,
      displayStatus(toStatus, statusValues),
    )] : []),
    updateProjectField(
      root,
      `${workItem.owner}/${workItem.repository}`,
      project,
      workItem.number,
      loaded.workflow.provider.project.handoffDocField,
      `docs/HANDOFF-${workItem.number}.md`,
    ),
  ];
  const failures: string[] = [];
  if (!comment.applied) failures.push(comment.error ?? "GITHUB_ISSUE_COMMENT_FAILED");
  for (const field of fields) {
    if (!field.applied) failures.push(field.error ?? `GITHUB_PROJECT_UPDATE_FAILED: ${field.fieldName}`);
  }
  if (failures.length > 0) {
    throw new Error(
      `SESSION_ISSUE_UPDATE_FAILED: ${failures.join("; ")}. 交接文档与本地回执已落盘（${receiptPath}），修正后重跑同命令可幂等重试。`,
    );
  }

  return {
    ok: true,
    phase: "ready",
    dryRun: false,
    handoffDocPath: docPath,
    seed,
    receipt: receiptPreview,
    issueUpdates: {
      receiptsComment: { planned: false, receiptIds: commentReceiptIds },
      fields: fields.map((field) => field.fieldName),
    },
    nextSteps: [
      "新会话使用本命令输出的 seed prompt（或交接文档文末 SEED 段）开工",
      `回执已写入 ${receiptPath}`,
    ],
  };
}
