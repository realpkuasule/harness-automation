import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, readJson, safePath, sha256 } from "../v2/fs.js";
import { observeProvider } from "../worktree/provider.js";
import { loadWorktreeConfig } from "../worktree/config.js";
import { runGitCommand } from "../repository/git.js";
import { deliveryStatus, latestDeliveryAuthorization } from "../delivery/service.js";
import type { WorktreeDeliveryConfig } from "../worktree/types.js";
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
  return safePath(projectRoot, `docs/HANDOFF-${workItem.number}.md`);
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
  workItem: ParsedWorkItem,
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
  if (!parsed) throw new Error(`SESSION_WORK_ITEM_INVALID: expected github:<owner>/<repo>#<number>, got ${input}`);
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

function assertRepositoryMatch(config: WorktreeDeliveryConfig, workItem: ParsedWorkItem): void {
  const repository = config.provider.kind === "github" ? config.provider.repository?.trim().toLowerCase() : undefined;
  const expected = `${workItem.owner}/${workItem.repository}`.toLowerCase();
  if (repository !== expected) {
    throw new Error(`SESSION_WORK_ITEM_REPOSITORY_MISMATCH: ${workItem.workItem} does not belong to configured repository ${repository ?? "none"}`);
  }
}

/** `session seed`：仅渲染 seed prompt，不落盘、不流转。 */
export function sessionSeed(options: SessionCommandOptions): { ok: true; seed: string } {
  const root = options.projectRoot;
  const workItem = parsedWorkItem(options.workItem);
  const loaded = loadSessionWorkflow(root);
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
