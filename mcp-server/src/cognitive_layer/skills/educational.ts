import type { RuleDefinition } from "../../types.js";

export interface EducationalInput {
  rule: RuleDefinition;
  topic?: string;
  experienceLevel?: "beginner" | "intermediate" | "advanced";
}

export interface EducationalResult {
  skillType: "educational";
  explanation: string;
  bestPractices: string[];
  examples: string[];
  learningResources: string[];
}

export function executeEducational(input: EducationalInput): EducationalResult {
  const { rule, topic, experienceLevel = "intermediate" } = input;

  const displayName = topic ?? rule.name;

  const depth = experienceLevel === "beginner" ? "基础" : experienceLevel === "advanced" ? "深入" : "标准";

  return {
    skillType: "educational",
    explanation: `[${depth}] "${displayName}"（${rule.description}）\n\n该规则属于 "${rule.category}" 类别，实施成本 ${rule.cost}/5，触发频率 ${rule.frequency}/5。推荐通过 ${rule.recommendedMedium} 介质进行约束。`,
    bestPractices: [
      `优先使用 ${rule.recommendedMedium} 自动执行该规则`,
      `在代码审查中重点关注 "${rule.name}" 相关模式`,
      `定期评估规则的有效性，必要时调整介质（当前替代方案：${rule.alternativeMedium.join("、")}）`,
    ],
    examples: [
      `规则应用示例：${rule.description}`,
      rule.formalizable
        ? `自动化检查配置示例：通过 ${rule.recommendedMedium} 实现自动检测`
        : `认知检查示例：在 CLAUDE.md 中添加该规则的手动检查指引`,
    ],
    learningResources: [
      `规则文档：${rule.name}`,
      rule.formalizable
        ? `相关 linter 配置参考（${rule.recommendedMedium}）`
        : `设计文档 §${rule.category} 章节`,
    ],
  };
}
