import type { ErrorMessageTemplate, ErrorSuggestion } from "../types.js";
import { getAllTemplates, getTemplateById, findTemplatesByScenario } from "./templates.js";

export interface ErrorContext {
  ruleId?: string;
  ruleName?: string;
  scenario?: string;
  actualCode?: string;
  language?: string;
  fileName?: string;
  lineNumber?: number;
}

function renderTemplate(template: ErrorMessageTemplate, context: ErrorContext): string {
  const { structure } = template;

  const parts = [
    `❌ 问题：${structure.why}`,
    `✅ 建议：${structure.whatInstead}`,
    `📖 参考：${structure.reference}`,
    `💡 学习：${structure.learningTip}`,
  ];

  if (context.actualCode) {
    parts.splice(1, 0, `🔍 代码：\`${context.actualCode}\``);
  }

  if (context.fileName && context.lineNumber) {
    parts.unshift(`📍 位置：${context.fileName}:${context.lineNumber}`);
  } else if (context.fileName) {
    parts.unshift(`📍 文件：${context.fileName}`);
  }

  return parts.join("\n");
}

export function generateErrorSuggestion(
  context: ErrorContext,
): ErrorSuggestion[] {
  const suggestions: ErrorSuggestion[] = [];

  // Try exact ruleId match first
  if (context.ruleId) {
    const template = getTemplateById(context.ruleId);
    if (template) {
      suggestions.push({
        templateId: template.id,
        renderedMessage: renderTemplate(template, context),
        confidence: 0.95,
      });
    }
  }

  // Try scenario-based matching
  if (context.scenario) {
    const scenarioTemplates = findTemplatesByScenario(context.scenario);
    for (const t of scenarioTemplates) {
      // Skip if already added via exact match
      if (suggestions.some((s) => s.templateId === t.id)) continue;

      const confidence = t.applicableScenarios.some(
        (s) => s.toLowerCase() === context.scenario!.toLowerCase(),
      )
        ? 0.85
        : 0.6;

      suggestions.push({
        templateId: t.id,
        renderedMessage: renderTemplate(t, context),
        confidence,
      });
    }
  }

  // Try ruleName-based fuzzy match
  if (context.ruleName && !context.ruleId) {
    const nameMatch = getAllTemplates().filter((t) => {
      const nameWords = t.name.toLowerCase().replace(/[^a-z0-9]/g, " ").split(/\s+/);
      const ruleWords = context.ruleName!.toLowerCase().replace(/[^a-z0-9]/g, " ").split(/\s+/);
      return ruleWords.some((w) => nameWords.includes(w));
    });
    for (const t of nameMatch) {
      if (suggestions.some((s) => s.templateId === t.id)) continue;
      suggestions.push({
        templateId: t.id,
        renderedMessage: renderTemplate(t, context),
        confidence: 0.5,
      });
    }
  }

  // Sort by confidence descending
  suggestions.sort((a, b) => b.confidence - a.confidence);

  return suggestions;
}
