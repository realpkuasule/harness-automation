import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  RuleDefinition,
  RuleDecision,
  RuleConflict,
  EngineInput,
  EngineOutput,
  RuleMedium,
  ProjectPhase,
  TeamSize,
} from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// Rule Loading
// ============================================================

function loadRules(): RuleDefinition[] {
  const rulesPath = join(__dirname, "rules.json");
  const raw = readFileSync(rulesPath, "utf-8");
  return (JSON.parse(raw) as RuleDefinition[]).map(normalizeMedium);
}

/**
 * Normalize legacy medium values to the new RuleMedium enum.
 * Handles backward compat for rules.json that may use old values.
 */
function normalizeMedium(rule: RuleDefinition): RuleDefinition {
  const legacyMap: Record<string, RuleMedium> = {
    "linter": "linter_warn",
    "settings.json": "settings",
    "claude.md": "claude_md",
  };
  return {
    ...rule,
    recommendedMedium: legacyMap[rule.recommendedMedium] ?? rule.recommendedMedium,
    alternativeMedium: rule.alternativeMedium.map(
      (m) => legacyMap[m] ?? m,
    ),
  };
}

// ============================================================
// Helper: category-specific cognitive needs
// ============================================================

const COGNITIVE_CATEGORIES = new Set([
  "code-style",
  "architecture",
  "code-quality",
]);

const COGNITIVE_SKILL_MAP: Record<string, string[]> = {
  "code-style": ["diagnostic", "educational"],
  "architecture": ["diagnostic", "decision-support"],
  "code-quality": ["diagnostic", "educational"],
  "security": ["diagnostic"],
  "process": ["educational"],
};

// ============================================================
// Phase/Team cost multipliers
// ============================================================

const PHASE_COST_MULTIPLIER: Record<ProjectPhase, number> = {
  prototype: 0.5,
  early: 0.8,
  growth: 1.0,
  mature: 1.2,
};

const TEAM_FREQUENCY_MULTIPLIER: Record<TeamSize, number> = {
  solo: 0.6,
  small: 0.8,
  medium: 1.0,
  large: 1.3,
};

// ============================================================
// Conflict Matrix (design §6.2)
// ============================================================

const CONFLICT_MATRIX: Array<{
  ruleA: string;
  ruleB: string;
  type: "direct_conflict" | "redundant" | "needs_refinement";
  description: string;
  resolution: string;
}> = [
  {
    ruleA: "R003",
    ruleB: "R015",
    type: "direct_conflict",
    description: "prefer-early-return 主张提前退出减少嵌套，error-handling 要求全面错误检查可能增加嵌套",
    resolution: "对简单守卫条件使用提前返回，复杂异步流程保持结构化错误处理",
  },
  {
    ruleA: "R009",
    ruleB: "R015",
    type: "direct_conflict",
    description: "no-duplicate-code 可能和 error-handling 冲突，因为错误处理模式看似相似但服务于不同上下文",
    resolution: "将通用的错误处理逻辑提取为共享工具函数，保留上下文特定的处理",
  },
  {
    ruleA: "R005",
    ruleB: "R015",
    type: "redundant",
    description: "type-annotations 和 error-handling 都会增加代码冗长度，可能导致代码臃肿",
    resolution: "对公开 API 和错误类型使用类型注解，对边界条件优先运行时错误处理",
  },
  {
    ruleA: "R003",
    ruleB: "R009",
    type: "redundant",
    description: "prefer-early-return 可能和 no-duplicate-code 冲突，提前返回可能导致相同逻辑分散在各处",
    resolution: "优先使用提前返回减少嵌套；当发现相同返回模式出现 3+ 次时再提取公共逻辑",
  },
  {
    ruleA: "R007",
    ruleB: "R013",
    type: "redundant",
    description: "test-before-merge 和 code-review-required 都要求合并前检查，可能造成流程冗余",
    resolution: "test-before-merge 由 CI 自动执行，code-review 是人工步骤，两者互补不冲突。可在 CI 中配置 review 要求",
  },
  {
    ruleA: "R019",
    ruleB: "R022",
    type: "needs_refinement" as const,
    description: "branch-naming-convention 和 secret-detection 都可能触发 pre-commit hook，需确保两者不冲突",
    resolution: "pre-commit hook 先运行 gitleaks（快速失败），再运行 branch name check",
  },
];

// ============================================================
// Decision Engine
// ============================================================

export class DecisionEngine {
  private rules: RuleDefinition[];

  constructor() {
    this.rules = loadRules();
  }

  /**
   * Filter rules by tech stack.
   */
  filterByTechStack(techStack: string[]): RuleDefinition[] {
    return this.rules.filter((r) =>
      r.techStack.some((t) => techStack.includes(t))
    );
  }

  /**
   * Run the four-question judgment flow for all applicable rules.
   */
  evaluate(input: EngineInput): EngineOutput {
    const applicable = this.filterByTechStack(input.techStack);

    const decisions: RuleDecision[] = applicable.map((rule) =>
      this._decide(rule, input)
    );

    const byMedium = {} as Record<RuleMedium, number>;
    let highConfidence = 0;
    let cognitiveRequired = 0;

    for (const d of decisions) {
      byMedium[d.recommendedMedium] = (byMedium[d.recommendedMedium] || 0) + 1;
      if (d.confidence >= 0.7) highConfidence++;
      if (d.cognitiveLayerRequired) cognitiveRequired++;
    }

    return {
      decisions,
      conflicts: this.detectConflicts(decisions),
      summary: {
        total: decisions.length,
        byMedium,
        highConfidence,
        cognitiveRequired,
      },
    };
  }

  /**
   * Detect conflicts between decisions using the conflict matrix.
   * Only reports conflicts where both rules are active in the decision set.
   */
  detectConflicts(decisions: RuleDecision[]): RuleConflict[] {
    const activeIds = new Set(decisions.map((d) => d.ruleId));
    const conflicts: RuleConflict[] = [];

    for (const entry of CONFLICT_MATRIX) {
      if (activeIds.has(entry.ruleA) && activeIds.has(entry.ruleB)) {
        conflicts.push({
          ruleA: entry.ruleA,
          ruleB: entry.ruleB,
          type: entry.type,
          description: entry.description,
          resolution: entry.resolution,
        });
      }
    }

    return conflicts;
  }

  /**
   * Four-question judgment flow for a single rule.
   *
   * Q1: 可形式化吗?  (checkFormalizable)
   * Q2: 代价多高?    (adjustCost)
   * Q3: 反馈要多快?  (estimateFeedbackSpeed)
   * Q4: 频率多高?    (estimateFrequency)
   */
  private _decide(rule: RuleDefinition, input: EngineInput): RuleDecision {
    const formalizable = this._checkFormalizable(rule);
    const cost = this._adjustCost(rule, input);
    const feedbackSpeed = rule.feedbackSpeed;
    const frequency = this._estimateFrequency(rule, input);

    // Check special cases first (design §6.3), then fall through to four-question flow
    const medium = this._specialCases(rule) ?? this._finalDecision(
      rule,
      formalizable,
      cost,
      feedbackSpeed,
      frequency,
    );

    const reasons: string[] = [];

    if (formalizable) {
      reasons.push("规则可形式化，适合自动化检查");
    } else {
      reasons.push("规则不可完全形式化，需要认知层支持");
    }

    if (cost <= 2) {
      reasons.push(`实施成本低 (${cost}/5)`);
    } else if (cost <= 3) {
      reasons.push(`实施成本适中 (${cost}/5)`);
    } else {
      reasons.push(`实施成本较高 (${cost}/5)`);
    }

    if (frequency >= 4) {
      reasons.push(`触发频率高 (${frequency}/5)，自动化收益大`);
    } else if (frequency <= 2) {
      reasons.push(`触发频率低 (${frequency}/5)`);
    }

    // Cognitive layer support check
    const needsCognitive =
      !formalizable && COGNITIVE_CATEGORIES.has(rule.category);

    const cognitiveTriggers = needsCognitive
      ? COGNITIVE_SKILL_MAP[rule.category] ?? []
      : [];

    if (needsCognitive) {
      reasons.push("建议配合认知层 Skills 使用");
    }

    return {
      ruleId: rule.id,
      ruleName: rule.name,
      recommendedMedium: medium,
      alternativeMedia: rule.alternativeMedium,
      confidence: this._calculateConfidence(
        formalizable,
        cost,
        frequency,
        input,
      ),
      reasons,
      cognitiveLayerRequired: needsCognitive,
      cognitiveSkillTriggers: cognitiveTriggers,
      adjustedCost: cost,
      adjustedCostLabel: cost >= 5 ? "critical" : cost >= 4 ? "high" : cost >= 3 ? "medium" : "low",
      feedbackSpeed: rule.feedbackSpeed,
      errorMessage: rule.errorMessage,
    };
  }

  // ---- Four Questions ----

  /** Q1: 可形式化吗？ */
  private _checkFormalizable(rule: RuleDefinition): boolean {
    return rule.formalizable;
  }

  /** Q2: 代价多高？（考虑项目阶段调整） */
  private _adjustCost(
    rule: RuleDefinition,
    input: EngineInput,
  ): number {
    const multiplier = PHASE_COST_MULTIPLIER[input.projectPhase];
    return Math.min(5, Math.round(rule.cost * multiplier));
  }

  /** Q3: 反馈要多快？(直接使用 rule 定义的 feedbackSpeed) */
  private _estimateFeedbackSpeed(rule: RuleDefinition): number {
    return rule.feedbackSpeed;
  }

  /** Q4: 频率多高？（考虑团队规模调整） */
  private _estimateFrequency(
    rule: RuleDefinition,
    input: EngineInput,
  ): number {
    const multiplier = TEAM_FREQUENCY_MULTIPLIER[input.teamSize];
    return Math.min(5, Math.round(rule.frequency * multiplier));
  }

  // ---- Special Cases (design §6.3) ----

  /**
   * Special rules that require fixed medium assignments.
   * These bypass the four-question flow for safety/process reasons.
   * Returns the fixed medium or null to fall through to normal decision flow.
   */
  private _specialCases(rule: RuleDefinition): RuleMedium | null {
    // Security-critical rules → linter_error (hard block)
    if (rule.category === "security" && rule.formalizable) {
      return "linter_error";
    }

    // Safety rules that must go to settings.json
    if (rule.id === "no-env-edit" || rule.name === "no-rm-rf" || rule.name === "no-sudo") {
      return "settings";
    }

    // Commit format → hook (enforced at commit time)
    if (rule.name === "commit-message-convention") {
      return "hook";
    }

    return null; // fall through to four-question flow
  }

  // ---- Final Decision ----

  /**
   * Map (formalizable, cost, feedbackSpeed, frequency) → RuleMedium.
   *
   * Core logic:
   * - formalizable + low cost + fast feedback → linter_warn
   * - formalizable + high frequency + commit-time → hook
   * - formalizable + slow feedback needed → ci
   * - not formalizable + high frequency → claude_md (cognitive)
   * - high cost + medium frequency → settings (soft nudge)
   * - fallthrough: use rule's recommendedMedium
   */
  private _finalDecision(
    rule: RuleDefinition,
    formalizable: boolean,
    cost: number,
    feedbackSpeed: number,
    frequency: number,
  ): RuleMedium {
    if (!formalizable) {
      if (frequency >= 4) return "claude_md";
      if (cost >= 4) return "claude_md";
      return "claude_md";
    }

    // Formalizable rules
    // Process rules at commit time → hook
    if (rule.category === "process" && frequency >= 3) {
      return "hook";
    }

    // Low cost, fast feedback → linter_warn (IDE integration)
    if (cost <= 2 && feedbackSpeed <= 2) {
      return "linter_warn";
    }

    // High frequency, commit-time check → hook
    if (frequency >= 4 && feedbackSpeed <= 2) {
      return "hook";
    }

    // Slow feedback acceptable, higher cost → CI
    if (feedbackSpeed >= 4 && cost >= 2) {
      return "ci";
    }

    // High cost/low frequency → soft nudge via settings
    if (cost >= 3 && frequency <= 2) {
      return "settings";
    }

    return rule.recommendedMedium;
  }

  /** Calculate confidence score (0-1) based on decision alignment. */
  private _calculateConfidence(
    formalizable: boolean,
    cost: number,
    frequency: number,
    input: EngineInput,
  ): number {
    let score = 0.7; // baseline

    // Formalizable rules have higher confidence
    if (formalizable) score += 0.15;

    // Low cost + high frequency = high confidence
    if (cost <= 2 && frequency >= 4) score += 0.1;

    // Early phase — lower confidence due to volatility
    if (input.projectPhase === "prototype") score -= 0.15;
    if (input.projectPhase === "early") score -= 0.05;

    return Math.max(0, Math.min(1, score));
  }
}
