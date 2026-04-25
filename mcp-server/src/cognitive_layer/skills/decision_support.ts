import type { RuleDefinition, RuleMedium } from "../../types.js";

export interface DecisionSupportInput {
  rule: RuleDefinition;
  currentMedium?: RuleMedium;
  candidateMedia?: RuleMedium[];
  context?: {
    projectPhase?: string;
    teamSize?: string;
    techStack?: string[];
  };
}

export interface DecisionSupportResult {
  skillType: "decision-support";
  tradeoffs: Array<{ medium: RuleMedium; pros: string[]; cons: string[] }>;
  recommendation: {
    medium: RuleMedium;
    reason: string;
    confidence: number;
  };
  alternatives: Array<{ medium: RuleMedium; reason: string }>;
}

const MEDIUM_LABELS: Partial<Record<RuleMedium, string>> = {
  "claude.md": "CLAUDE.md 认知指引",
  "settings.json": "编辑器软约束",
  linter: "Linter 自动检查",
  linter_warn: "Linter 警告",
  linter_error: "Linter 错误拦截",
  "linter+hook": "Linter 拦截 + Hook 双重检查",
  claude_md: "CLAUDE.md 认知指引",
  settings: "编辑器软约束",
  hook: "Git Hook 提交检查",
  ci: "CI 流水线检查",
  none: "不约束",
};

export function executeDecisionSupport(input: DecisionSupportInput): DecisionSupportResult {
  const { rule, candidateMedia, context } = input;

  const mediaToEvaluate: RuleMedium[] = candidateMedia ?? [
    rule.recommendedMedium,
    ...rule.alternativeMedium,
  ];

  const tradeoffs = mediaToEvaluate.map((medium) => {
    const pros: string[] = [];
    const cons: string[] = [];

    switch (medium) {
      case "linter":
      case "linter_warn":
        pros.push("实时反馈，IDE 集成");
        pros.push("自动化程度高，无需人工干预");
        if (rule.feedbackSpeed <= 2) pros.push("匹配规则的快速反馈需求");
        cons.push("仅适用于可形式化的规则");
        if (!rule.formalizable) cons.push("该规则不可完全形式化");
        break;
      case "linter_error":
        pros.push("实时反馈，IDE 错误拦截");
        pros.push("强制执行，不可绕过");
        if (rule.formalizable) pros.push("匹配规则的可形式化特性");
        cons.push("可能阻断开发流程");
        break;
      case "linter+hook":
        pros.push("IDE 实时反馈 + 提交前双重拦截");
        pros.push("最高级别的自动化约束");
        cons.push("约束强度大，可能影响开发体验");
        break;
      case "hook":
        pros.push("提交前拦截，防止不合规代码入库");
        pros.push("团队级强制执行");
        cons.push("可能影响开发体验（增加提交等待时间）");
        if (rule.frequency >= 4) cons.push("高频触发规则可能导致 CI 阻塞");
        break;
      case "ci":
        pros.push("在 CI 流水线中执行，不影响本地开发");
        pros.push("适合代价较高的检查");
        if (rule.cost >= 3) pros.push("匹配规则的高实施成本");
        cons.push("反馈延迟较大");
        cons.push("问题发现较晚，修复成本高");
        break;
      case "claude.md":
      case "claude_md":
        pros.push("适用所有规则类型（包括非形式化规则）");
        pros.push("提供上下文和认知指引");
        if (!rule.formalizable) pros.push("该规则不可形式化，适合认知指引");
        cons.push("无自动执行能力");
        cons.push("依赖开发者的自觉性");
        break;
      case "settings.json":
      case "settings":
        pros.push("轻量级软约束");
        pros.push("IDE 内可见，开发体验影响小");
        cons.push("约束力弱，可被忽略");
        cons.push("仅适用于编辑器内的规则");
        break;
      case "none":
        pros.push("无约束，开发体验最佳");
        cons.push("规则不强制执行，依赖自觉");
        cons.push("无法保证合规性");
        break;
    }

    return { medium, pros, cons };
  });

  /** Check if a medium is a linter variant (error, warn, or old-style linter) */
  const isLinter = (m: RuleMedium) => m === "linter" || m === "linter_warn" || m === "linter_error" || m === "linter+hook";
  /** Check if a medium is a cognitive/doc variant */
  const isCognitive = (m: RuleMedium) => m === "claude.md" || m === "claude_md";

  // Score each medium based on rule characteristics
  const scored = mediaToEvaluate.map((m) => {
    let score = 0;
    if (m === rule.recommendedMedium) score += 2;
    if (rule.alternativeMedium.includes(m)) score += 1;
    if (rule.formalizable && (isLinter(m) || m === "hook")) score += 1;
    if (!rule.formalizable && isCognitive(m)) score += 2;
    if (rule.cost >= 3 && m === "ci") score += 1;
    if (rule.feedbackSpeed <= 2 && isLinter(m)) score += 1;

    // Context-based adjustments
    if (context?.projectPhase === "prototype" && isLinter(m)) score -= 1;
    if (context?.projectPhase === "mature" && isCognitive(m)) score += 1;
    if (context?.teamSize === "solo" && m === "ci") score -= 1;
    if (context?.teamSize === "large" && m === "ci") score += 1;

    return { medium: m, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];

  return {
    skillType: "decision-support",
    tradeoffs,
    recommendation: {
      medium: best.medium,
      reason: `基于规则特征和项目上下文分析，"${rule.name}" 最适合通过 ${MEDIUM_LABELS[best.medium]} 实施约束`,
      confidence: Math.min(1, 0.5 + best.score * 0.1),
    },
    alternatives: scored.slice(1).map((s) => ({
      medium: s.medium,
      reason: `备选方案，评分 ${s.score}（${MEDIUM_LABELS[s.medium]}）`,
    })),
  };
}
