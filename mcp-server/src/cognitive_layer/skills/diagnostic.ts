import type { RuleDefinition } from "../../types.js";

export interface DiagnosticInput {
  rule: RuleDefinition;
  codePattern?: string;
  contextDescription?: string;
}

export interface DiagnosticResult {
  skillType: "diagnostic";
  analysis: string;
  severity: "low" | "medium" | "high";
  rootCause: string;
  fixSuggestion: string;
  relatedRules: string[];
}

export function executeDiagnostic(input: DiagnosticInput): DiagnosticResult {
  const { rule, codePattern, contextDescription } = input;

  const severity = rule.cost >= 4 ? "high" : rule.cost >= 2 ? "medium" : "low";

  const analysis = codePattern
    ? `检测到 "${rule.name}" 模式：${codePattern}。${contextDescription ? `上下文：${contextDescription}。` : ""}该规则 ${rule.formalizable ? "可自动化检查" : "需要人工审查"}，建议通过 ${rule.recommendedMedium} 介质实施约束。`
    : `规则 "${rule.name}"（${rule.description}）的诊断为：${rule.formalizable ? "该规则可以形式化为自动化检查规则" : "该规则需要认知层支持，不适合纯自动化检查"}。`;

  return {
    skillType: "diagnostic",
    analysis,
    severity,
    rootCause: rule.description,
    fixSuggestion: rule.formalizable
      ? `配置 ${rule.recommendedMedium} 自动检查规则 "${rule.name}"`
      : `在 CLAUDE.md 中添加 "${rule.name}" 规则的认知指引，配合人工 Code Review`,
    relatedRules: [],
  };
}
