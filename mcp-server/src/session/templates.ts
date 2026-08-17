import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { safePath } from "../v2/fs.js";
import {
  sessionWorkflowSchema,
  type SessionWorkflow,
} from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));

/** 包内默认模板目录：dist/session/templates（构建后）或 src/session/templates（tsx 直跑） */
export function packagedTemplatesDir(): string {
  return join(here, "templates");
}

export interface LoadedWorkflow {
  source: "project" | "package-default";
  workflowPath: string;
  workflow: SessionWorkflow;
  templatesDir: string;
}

function parseWorkflowFile(path: string): SessionWorkflow {
  const raw = readFileSync(path, "utf8");
  const parsed = parseYaml(raw);
  const result = sessionWorkflowSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`SESSION_WORKFLOW_INVALID: ${path}: ${detail}`);
  }
  return result.data;
}

/**
 * 加载 session 工作流策略：项目 `.harness/session-workflow.yaml` 优先，
 * 缺失或非法时报错（不静默回退）；项目文件不存在时使用包内默认值（只读，绝不写回项目）。
 */
export function loadSessionWorkflow(projectRoot: string): LoadedWorkflow {
  const projectPath = safePath(projectRoot, ".harness/session-workflow.yaml");
  if (existsSync(projectPath)) {
    const workflow = parseWorkflowFile(projectPath);
    return {
      source: "project",
      workflowPath: projectPath,
      workflow,
      templatesDir: dirname(projectPath),
    };
  }
  const defaultPath = join(packagedTemplatesDir(), "session-workflow.yaml");
  if (!existsSync(defaultPath)) {
    throw new Error(`SESSION_WORKFLOW_DEFAULT_MISSING: ${defaultPath}`);
  }
  const workflow = parseWorkflowFile(defaultPath);
  return {
    source: "package-default",
    workflowPath: defaultPath,
    workflow,
    templatesDir: dirname(defaultPath),
  };
}

export function templatePath(loaded: LoadedWorkflow, name: "handoff" | "seed"): string {
  return resolve(loaded.templatesDir, loaded.workflow.templates[name]);
}

export function readTemplate(loaded: LoadedWorkflow, name: "handoff" | "seed"): string {
  const path = templatePath(loaded, name);
  if (!existsSync(path)) {
    throw new Error(`SESSION_TEMPLATE_MISSING: ${path}`);
  }
  return readFileSync(path, "utf8");
}

/** 确定性模板渲染：仅替换 {{key}} 占位符；未知占位符原样保留（由校验拒绝）。 */
export function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/gu, (match, key: string) =>
    key in values ? values[key] : match,
  );
}
