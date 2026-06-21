import type { RuleDecision } from "../types.js";

export interface MrTemplateConfig {
  decisions: RuleDecision[];
  projectName?: string;
}

/**
 * Generate markdown content for .gitlab/merge_request_templates/default.md
 */
export function generateMrTemplate(config: MrTemplateConfig): string {
  const { decisions, projectName } = config;
  const lines: string[] = [];

  // Title
  if (projectName) {
    lines.push(`# MR: ${projectName}`);
  } else {
    lines.push("# Merge Request");
  }
  lines.push("");

  // Section: 变更描述
  lines.push("## 变更描述");
  lines.push("");
  lines.push("<!-- 请描述此 MR 的变更内容 -->");
  lines.push("");
  lines.push("");

  // Section: 关联 Issue
  lines.push("## 关联 Issue");
  lines.push("");
  lines.push("<!-- 关联的 Issue 编号，例如: Closes #123 -->");
  lines.push("");
  lines.push("");

  // Section: 变更内容 Checklist
  lines.push("## 变更内容 Checklist");
  lines.push("");
  lines.push("<!-- 勾选已完成的项目 -->");
  lines.push("");
  lines.push("");

  // Section: 测试说明
  lines.push("## 测试说明");
  lines.push("");
  lines.push("<!-- 描述如何测试这些变更 -->");
  lines.push("");
  lines.push("");

  // Section: Screenshots
  lines.push("## Screenshots");
  lines.push("");
  lines.push("<!-- 如有 UI 变更，请附上截图 -->");
  lines.push("");
  lines.push("");

  // R021: AI Code Review section
  if (decisions.some((d) => d.ruleId === "R021")) {
    lines.push("## AI Code Review");
    lines.push("");
    lines.push("- [ ] AI Code Review 已完成");
    lines.push("- [ ] AI Review 发现的问题已处理");
    lines.push("");
    lines.push("");
  }

  // Review Checklist (always present)
  lines.push("## Review Checklist");
  lines.push("");

  // R022: secret detection
  if (decisions.some((d) => d.ruleId === "R022")) {
    lines.push("- [ ] 已检查无密钥/凭证泄露");
  }

  lines.push("- [ ] Lint 通过");
  lines.push("- [ ] 测试通过");
  lines.push("- [ ] 分支命名符合规范");
  lines.push("- [ ] MR 模板已填写完整");
  lines.push("");

  return lines.join("\n");
}
