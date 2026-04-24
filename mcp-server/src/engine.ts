import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  RuleDefinition,
  RuleDecision,
  EngineInput,
  EngineOutput,
  Medium,
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
  return JSON.parse(raw) as RuleDefinition[];
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

    const byMedium = {} as Record<Medium, number>;
    let highConfidence = 0;
    let cognitiveRequired = 0;

    for (const d of decisions) {
      byMedium[d.recommendedMedium] = (byMedium[d.recommendedMedium] || 0) + 1;
      if (d.confidence >= 0.7) highConfidence++;
      if (d.cognitiveLayerRequired) cognitiveRequired++;
    }

    return {
      decisions,
      summary: {
        total: decisions.length,
        byMedium,
        highConfidence,
        cognitiveRequired,
      },
    };
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

    const medium = this._finalDecision(
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

  // ---- Final Decision ----

  /**
   * Map (formalizable, cost, feedbackSpeed, frequency) → Medium.
   *
   * Core logic:
   * - formalizable + low cost + fast feedback → linter
   * - formalizable + high frequency + commit-time → hook
   * - formalizable + slow feedback needed → ci
   * - not formalizable + high frequency → claude.md (cognitive)
   * - high cost + medium frequency → settings.json (soft nudge)
   * - fallthrough: use rule's recommendedMedium
   */
  private _finalDecision(
    rule: RuleDefinition,
    formalizable: boolean,
    cost: number,
    feedbackSpeed: number,
    frequency: number,
  ): Medium {
    // Special cases for security critical rules
    if (rule.category === "security" && formalizable) {
      return "linter";
    }

    if (!formalizable) {
      if (frequency >= 4) return "claude.md";
      if (cost >= 4) return "claude.md";
      return "claude.md";
    }

    // Formalizable rules
    // Process rules at commit time → hook
    if (rule.category === "process" && frequency >= 3) {
      return "hook";
    }

    // Low cost, fast feedback → linter (IDE integration)
    if (cost <= 2 && feedbackSpeed <= 2) {
      return "linter";
    }

    // High frequency, commit-time check → hook
    if (frequency >= 4 && feedbackSpeed <= 2) {
      return "hook";
    }

    // Slow feedback acceptable, higher cost → CI
    if (feedbackSpeed >= 4 && cost >= 2) {
      return "ci";
    }

    // High cost/low frequency → soft nudge via settings.json
    if (cost >= 3 && frequency <= 2) {
      return "settings.json";
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
