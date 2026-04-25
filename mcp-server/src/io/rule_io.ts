import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Medium, RuleDecision, RuleDefinition } from "../types.js";
// ============================================================
// Types
// ============================================================

export interface RuleExportData {
  version: string;
  exportedAt: string;
  source: {
    projectDir: string;
    projectPhase?: string;
    teamSize?: string;
    techStack?: string[];
  };
  rules: Array<{
    ruleId: string;
    ruleName: string;
    recommendedMedium: Medium;
    confidence: number;
    alternativeMedia: Medium[];
    reasons: string[];
  }>;
}

export interface RuleImportResult {
  decisions: RuleDecision[];
  total: number;
  warnings: string[];
}

export interface RulePreset {
  id: string;
  name: string;
  description: string;
  techStack: string[];
  decisions: Array<{
    ruleId: string;
    recommendedMedium: Medium;
  }>;
}

// ============================================================
// Constants
// ============================================================

const EXPORT_VERSION = "1.0";

const PRESETS: RulePreset[] = [
  {
    id: "web-app-ts",
    name: "TypeScript Web 应用",
    description: "TypeScript 全栈/前端 Web 应用的完整 Harness 配置，包含全部约束介质",
    techStack: ["typescript", "javascript"],
    decisions: [
      { ruleId: "R001", recommendedMedium: "linter_warn" },
      { ruleId: "R002", recommendedMedium: "linter_warn" },
      { ruleId: "R003", recommendedMedium: "claude_md" },
      { ruleId: "R004", recommendedMedium: "hook" },
      { ruleId: "R005", recommendedMedium: "linter_warn" },
      { ruleId: "R006", recommendedMedium: "linter_warn" },
      { ruleId: "R007", recommendedMedium: "ci" },
      { ruleId: "R008", recommendedMedium: "hook" },
      { ruleId: "R009", recommendedMedium: "claude_md" },
      { ruleId: "R010", recommendedMedium: "ci" },
      { ruleId: "R011", recommendedMedium: "linter_warn" },
      { ruleId: "R012", recommendedMedium: "linter_warn" },
      { ruleId: "R013", recommendedMedium: "claude_md" },
      { ruleId: "R014", recommendedMedium: "linter_warn" },
      { ruleId: "R015", recommendedMedium: "claude_md" },
      { ruleId: "R016", recommendedMedium: "linter_warn" },
    ],
  },
  {
    id: "library-ts",
    name: "TypeScript 库",
    description: "TypeScript 库项目的轻量 Harness 配置，偏重 linter 和 CI",
    techStack: ["typescript", "javascript"],
    decisions: [
      { ruleId: "R001", recommendedMedium: "linter_warn" },
      { ruleId: "R003", recommendedMedium: "claude_md" },
      { ruleId: "R004", recommendedMedium: "hook" },
      { ruleId: "R005", recommendedMedium: "linter_warn" },
      { ruleId: "R006", recommendedMedium: "linter_warn" },
      { ruleId: "R007", recommendedMedium: "ci" },
      { ruleId: "R008", recommendedMedium: "hook" },
      { ruleId: "R009", recommendedMedium: "claude_md" },
      { ruleId: "R012", recommendedMedium: "linter_warn" },
      { ruleId: "R014", recommendedMedium: "linter_warn" },
      { ruleId: "R015", recommendedMedium: "claude_md" },
      { ruleId: "R016", recommendedMedium: "linter_warn" },
    ],
  },
  {
    id: "python-script",
    name: "Python 项目",
    description: "Python 项目的最小 Harness 配置，偏重 process 和 code-quality",
    techStack: ["python"],
    decisions: [
      { ruleId: "R003", recommendedMedium: "claude_md" },
      { ruleId: "R004", recommendedMedium: "hook" },
      { ruleId: "R007", recommendedMedium: "ci" },
      { ruleId: "R008", recommendedMedium: "hook" },
      { ruleId: "R009", recommendedMedium: "claude_md" },
      { ruleId: "R010", recommendedMedium: "ci" },
      { ruleId: "R012", recommendedMedium: "linter_warn" },
      { ruleId: "R013", recommendedMedium: "claude_md" },
      { ruleId: "R015", recommendedMedium: "claude_md" },
    ],
  },
  {
    id: "prototype",
    name: "原型/早期项目",
    description: "原型阶段的极简 Harness 配置，仅 CLAUDE.md 软约束，不产生额外维护成本",
    techStack: ["typescript", "javascript", "python", "go", "java", "generic"],
    decisions: [
      { ruleId: "R003", recommendedMedium: "claude_md" },
      { ruleId: "R009", recommendedMedium: "claude_md" },
      { ruleId: "R013", recommendedMedium: "claude_md" },
      { ruleId: "R015", recommendedMedium: "claude_md" },
    ],
  },
  {
    id: "go-service",
    name: "Go 服务",
    description: "Go 微服务项目的 Harness 配置，偏重 CI 和 code-quality",
    techStack: ["go"],
    decisions: [
      { ruleId: "R003", recommendedMedium: "claude_md" },
      { ruleId: "R004", recommendedMedium: "hook" },
      { ruleId: "R007", recommendedMedium: "ci" },
      { ruleId: "R008", recommendedMedium: "hook" },
      { ruleId: "R009", recommendedMedium: "claude_md" },
      { ruleId: "R010", recommendedMedium: "ci" },
      { ruleId: "R011", recommendedMedium: "linter_warn" },
      { ruleId: "R012", recommendedMedium: "linter_warn" },
      { ruleId: "R013", recommendedMedium: "claude_md" },
      { ruleId: "R015", recommendedMedium: "claude_md" },
      { ruleId: "R016", recommendedMedium: "linter_warn" },
    ],
  },
];

const EXPORT_DIR = ".harness/exports";

// ============================================================
// RuleIO
// ============================================================

export class RuleIO {
  private projectDir: string;

  constructor(projectDir: string) {
    this.projectDir = projectDir;
  }

  /**
   * Export current rule configuration as portable JSON.
   */
  exportRules(
    decisions: RuleDecision[],
    metadata?: { projectPhase?: string; teamSize?: string; techStack?: string[] },
  ): RuleExportData {
    return {
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      source: {
        projectDir: this.projectDir,
        ...metadata,
      },
      rules: decisions.map((d) => ({
        ruleId: d.ruleId,
        ruleName: d.ruleName,
        recommendedMedium: d.recommendedMedium,
        confidence: d.confidence,
        alternativeMedia: d.alternativeMedia,
        reasons: d.reasons,
      })),
    };
  }

  /**
   * Save export data to a file.
   */
  saveExport(data: RuleExportData, filename?: string): string {
    const exportDir = join(this.projectDir, EXPORT_DIR);
    if (!existsSync(exportDir)) mkdirSync(exportDir, { recursive: true });

    const name = filename ?? `harness-export-${Date.now()}.json`;
    const filePath = join(exportDir, name);
    writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
    return filePath;
  }

  /**
   * Load export data from a file.
   */
  loadExport(filePath: string): RuleExportData {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as RuleExportData;
  }

  /**
   * Import rules from export data and convert back to RuleDecision[].
   */
  importRules(
    data: RuleExportData,
    enrichFromDefinitions?: RuleDefinition[],
  ): RuleImportResult {
    const warnings: string[] = [];
    const decisions: RuleDecision[] = [];

    for (const r of data.rules) {
      let definition: RuleDefinition | undefined;
      if (enrichFromDefinitions) {
        definition = enrichFromDefinitions.find((d) => d.id === r.ruleId);
      }

      if (!definition) {
        warnings.push(`Rule definition not found for "${r.ruleId}" — using exported values`);
      }

      decisions.push({
        ruleId: r.ruleId,
        ruleName: r.ruleName,
        recommendedMedium: r.recommendedMedium,
        alternativeMedia: definition?.alternativeMedium ?? r.alternativeMedia,
        confidence: r.confidence,
        reasons: r.reasons,
        cognitiveLayerRequired: definition?.cognitiveLayerSupport?.required ?? false,
        cognitiveSkillTriggers: definition?.cognitiveLayerSupport?.skillTriggers ?? [],
      });
    }

    return { decisions, total: decisions.length, warnings };
  }

  /**
   * Get a preset configuration by ID.
   */
  getPreset(presetId: string): RulePreset | undefined {
    return PRESETS.find((p) => p.id === presetId);
  }

  /**
   * List all available presets.
   */
  listPresets(): RulePreset[] {
    return PRESETS;
  }

  /**
   * List saved export files.
   */
  listExports(): string[] {
    const exportDir = join(this.projectDir, EXPORT_DIR);
    if (!existsSync(exportDir)) return [];
    try {
      return readdirSync(exportDir)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }
}
