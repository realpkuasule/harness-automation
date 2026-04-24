import { z } from "zod";

// ============================================================
// Enums & Constants
// ============================================================

/** The five constraint media types */
export type Medium = "claude.md" | "settings.json" | "linter" | "hook" | "ci";

/** Project phase for context-aware decisions */
export type ProjectPhase = "prototype" | "early" | "growth" | "mature";

/** Team size bracket */
export type TeamSize = "solo" | "small" | "medium" | "large";

/** State machine for harness setup progress */
export type HarnessStatus =
  | null
  | "evaluated"
  | "confirmed"
  | "generated"
  | "validated";

/** Tech stack category for rule filtering */
export type TechStack = "typescript" | "javascript" | "python" | "go" | "java" | "generic";

// ============================================================
// Rule Definition
// ============================================================

export interface RuleCognitiveSupport {
  required: boolean;
  skillTriggers: string[];
  contextRequirements: string[];
}

export interface RuleDefinition {
  id: string;
  name: string;
  description: string;
  category: string;
  formalizable: boolean;
  cost: number; // 1-5
  feedbackSpeed: number; // 1-5 (1=fastest, 5=slowest)
  frequency: number; // 1-5
  recommendedMedium: Medium;
  alternativeMedium: Medium[];
  techStack: TechStack[];
  cognitiveLayerSupport?: RuleCognitiveSupport;
}

// ============================================================
// Decision Engine Types
// ============================================================

export interface RuleDecision {
  ruleId: string;
  ruleName: string;
  recommendedMedium: Medium;
  alternativeMedia: Medium[];
  confidence: number; // 0-1
  reasons: string[];
  cognitiveLayerRequired: boolean;
  cognitiveSkillTriggers: string[];
}

export interface EngineInput {
  projectDir: string;
  projectPhase: ProjectPhase;
  teamSize: TeamSize;
  techStack: TechStack[];
  dryRun?: boolean;
}

export interface EngineOutput {
  decisions: RuleDecision[];
  summary: {
    total: number;
    byMedium: Record<Medium, number>;
    highConfidence: number;
    cognitiveRequired: number;
  };
}

// ============================================================
// MCP Tool Input/Output Types
// ============================================================

export const EvaluateRulesInputSchema = z.object({
  projectDir: z.string().describe("Absolute path to the project directory"),
  projectPhase: z.enum(["prototype", "early", "growth", "mature"]).describe("Current phase of the project"),
  teamSize: z.enum(["solo", "small", "medium", "large"]).describe("Size of the development team"),
  techStack: z.array(z.enum(["typescript", "javascript", "python", "go", "java", "generic"])).describe("Technology stack used"),
  dryRun: z.boolean().optional().default(false).describe("Preview mode without making changes"),
});

export type EvaluateRulesInput = z.infer<typeof EvaluateRulesInputSchema>;

export const GenerateConfigInputSchema = z.object({
  projectDir: z.string().describe("Absolute path to the project directory"),
  decisions: z.array(z.object({
    ruleId: z.string(),
    recommendedMedium: z.enum(["claude.md", "settings.json", "linter", "hook", "ci"]),
  })),
  dryRun: z.boolean().optional().default(false),
});

export type GenerateConfigInput = z.infer<typeof GenerateConfigInputSchema>;

export const QueryStateInputSchema = z.object({
  projectDir: z.string().describe("Absolute path to the project directory"),
});

export type QueryStateInput = z.infer<typeof QueryStateInputSchema>;

export interface GenerateConfigOutput {
  files: Array<{
    path: string;
    content: string;
    action: "create" | "update" | "skip";
  }>;
  summary: {
    total: number;
    created: number;
    updated: number;
    skipped: number;
  };
}

// ============================================================
// State Management
// ============================================================

export interface HarnessState {
  status: HarnessStatus;
  projectDir: string;
  createdAt: string;
  updatedAt: string;
  engineInput?: EngineInput;
  engineOutput?: EngineOutput;
  decisions?: RuleDecision[];
  confirmedAt?: string;
  configOutput?: GenerateConfigOutput;
  version: string;
}

// ============================================================
// Suitability Assessment
// ============================================================

export interface SuitabilityWarning {
  type: "prototype" | "script" | "cost" | "overhead";
  severity: "low" | "medium" | "high";
  message: string;
}

export interface SuitabilityAssessment {
  suitable: boolean;
  score: number; // 0-100
  reason: string;
  warnings: SuitabilityWarning[];
  recommendations: string[];
}

// ============================================================
// A/B Test Types
// ============================================================

export interface ABTestConfig {
  ruleId: string;
  baselineMedium: Medium;
  testMedium: Medium;
  durationDays: number;
  metrics: string[];
}

export interface ABTestDataPoint {
  timestamp: string;
  triggerCount: number;
  fixRate: number;
  bypassCount: number;
  userFeedback?: string;
}

export interface ABTestResult {
  testId: string;
  ruleId: string;
  config: ABTestConfig;
  dataPoints: ABTestDataPoint[];
  statisticalSignificance: boolean;
  recommendation: "keep" | "revert" | "adjust";
  confidenceScore: number;
}

// ============================================================
// Error Message Types
// ============================================================

export interface ErrorMessageTemplate {
  id: string;
  name: string;
  structure: {
    why: string;
    whatInstead: string;
    reference: string;
    context: string;
    learningTip: string;
  };
  applicableScenarios: string[];
}

export interface ErrorSuggestion {
  templateId: string;
  renderedMessage: string;
  confidence: number;
}

// ============================================================
// Scan / Init / Rollback Input Schemas
// ============================================================

export const ScanCodebaseInputSchema = z.object({
  projectDir: z.string().describe("Absolute path to the project directory"),
  techStack: z.array(z.enum(["typescript", "javascript", "python", "go", "java", "generic"])).optional().describe("Tech stack for rule filtering"),
  projectPhase: z.enum(["prototype", "early", "growth", "mature"]).optional().describe("Project phase for context-aware decisions"),
  teamSize: z.enum(["solo", "small", "medium", "large"]).optional().describe("Team size for frequency estimation"),
  useCache: z.boolean().optional().default(false).describe("Enable incremental scan cache (only scans changed files)"),
});

export type ScanCodebaseInput = z.infer<typeof ScanCodebaseInputSchema>;

export const InitHarnessInputSchema = z.object({
  projectDir: z.string().describe("Absolute path to the project directory"),
  projectPhase: z.enum(["prototype", "early", "growth", "mature"]).describe("Current phase of the project"),
  teamSize: z.enum(["solo", "small", "medium", "large"]).describe("Size of the development team"),
  techStack: z.array(z.enum(["typescript", "javascript", "python", "go", "java", "generic"])).describe("Technology stack used"),
  dryRun: z.boolean().optional().default(false).describe("Preview mode without making changes"),
});

export type InitHarnessInput = z.infer<typeof InitHarnessInputSchema>;

export const ConfirmDecisionsInputSchema = z.object({
  projectDir: z.string().describe("Absolute path to the project directory"),
  decisions: z.array(z.object({
    ruleId: z.string(),
    ruleName: z.string(),
    recommendedMedium: z.enum(["claude.md", "settings.json", "linter", "hook", "ci"]),
    alternativeMedia: z.array(z.enum(["claude.md", "settings.json", "linter", "hook", "ci"])),
    confidence: z.number().min(0).max(1),
    reasons: z.array(z.string()),
    cognitiveLayerRequired: z.boolean(),
    cognitiveSkillTriggers: z.array(z.string()),
  })).describe("Confirmed rule decisions"),
});

export type ConfirmDecisionsInput = z.infer<typeof ConfirmDecisionsInputSchema>;

export const RollbackInputSchema = z.object({
  projectDir: z.string().describe("Absolute path to the project directory"),
  backupId: z.string().optional().describe("Specific backup to restore (default: latest)"),
  list: z.boolean().optional().default(false).describe("List available backups without restoring"),
});

export type RollbackInput = z.infer<typeof RollbackInputSchema>;

export const ValidateSetupInputSchema = z.object({
  projectDir: z.string().describe("Absolute path to the project directory"),
  checkFiles: z.array(z.string()).optional().describe("Specific files to check (default: all managed files)"),
  skipSyntaxCheck: z.boolean().optional().default(false).describe("Skip syntax validation"),
  skipPermissionCheck: z.boolean().optional().default(false).describe("Skip permission checks"),
});

export type ValidateSetupInput = z.infer<typeof ValidateSetupInputSchema>;

export const RuleStatsInputSchema = z.object({
  projectDir: z.string().describe("Absolute path to the project directory"),
  collect: z.boolean().optional().default(true).describe("Whether to collect fresh analytics data from current state"),
});

export type RuleStatsInput = z.infer<typeof RuleStatsInputSchema>;

export const AnalyzeAdjustmentsInputSchema = z.object({
  projectDir: z.string().describe("Absolute path to the project directory"),
});

export type AnalyzeAdjustmentsInput = z.infer<typeof AnalyzeAdjustmentsInputSchema>;

export const ExportRulesInputSchema = z.object({
  projectDir: z.string().describe("Absolute path to the project directory"),
  saveToFile: z.boolean().optional().default(false).describe("Save export to .harness/exports/"),
  filename: z.string().optional().describe("Custom export filename"),
});

export type ExportRulesInput = z.infer<typeof ExportRulesInputSchema>;

export const ImportRulesInputSchema = z.object({
  projectDir: z.string().describe("Absolute path to the project directory"),
  exportJson: z.string().optional().describe("JSON string of exported rules"),
  presetId: z.string().optional().describe("Preset ID to load (use list_rule_presets)"),
  filePath: z.string().optional().describe("Path to an export file"),
});

export type ImportRulesInput = z.infer<typeof ImportRulesInputSchema>;

export const ListRulePresetsInputSchema = z.object({
  techStack: z.array(z.string()).optional().describe("Filter presets by tech stack"),
});

export type ListRulePresetsInput = z.infer<typeof ListRulePresetsInputSchema>;

export const ListRuleExportsInputSchema = z.object({
  projectDir: z.string().describe("Absolute path to the project directory"),
});

export type ListRuleExportsInput = z.infer<typeof ListRuleExportsInputSchema>;
