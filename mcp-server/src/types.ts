import { z } from "zod";

// ============================================================
// Enums & Constants
// ============================================================

/**
 * The constraint media types (design §3.1.3).
 * 9-value enum: 8 from design + backward-compat aliases.
 */
export type RuleMedium =
  | "linter_error"
  | "linter_warn"
  | "linter+hook"
  | "claude_md"
  | "ci"
  | "hook"
  | "settings"
  | "none"
  | "claude.md"   // backward-compat alias
  | "linter"       // deprecated — use linter_warn or linter_error
  | "settings.json"; // deprecated — use settings

/** @deprecated Use RuleMedium instead. */
export type Medium = RuleMedium;

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
// Error Code System (design §5.1)
// ============================================================

export type ErrorCode =
  | "STATE_NOT_FOUND"
  | "STATE_PHASE_MISMATCH"
  | "FILE_READ_ERROR"
  | "FILE_WRITE_ERROR"
  | "FILE_BACKUP_ERROR"
  | "CONFIRM_REQUIRED"
  | "NO_DECISIONS"
  | "INVALID_CONFIG"
  | "DEPENDENCY_MISSING"
  | "SCAN_FAILED"
  | "ROLLBACK_FAILED"
  | "UNKNOWN_ERROR"
  | "UNKNOWN_TOOL";

export interface HarnessError {
  code: ErrorCode;
  message: string;
  detail?: string;
  recoverable: boolean;
}

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
  recommendedMedium: RuleMedium;
  alternativeMedium: RuleMedium[];
  techStack: TechStack[];
  cognitiveLayerSupport?: RuleCognitiveSupport;
  /** Design §3.1.1: structured error message with why/whatInstead/reference */
  errorMessage?: {
    why: string;
    whatInstead: string;
    reference: string;
  };
}

// ============================================================
// Decision Engine Types
// ============================================================

export interface RuleDecision {
  ruleId: string;
  ruleName: string;
  recommendedMedium: RuleMedium;
  alternativeMedia: RuleMedium[];
  confidence: number; // 0-1
  reasons: string[];
  cognitiveLayerRequired: boolean;
  cognitiveSkillTriggers: string[];
  /** Design §3.1.1: adjusted cost after phase multiplier (1-5) */
  adjustedCost?: number;
  /** Design §3.1.1: cost classification label */
  adjustedCostLabel?: "critical" | "high" | "medium" | "low";
  /** Design §3.1.1: feedback speed from rule definition (1-5) */
  feedbackSpeed?: number;
  /** Design §3.1.1: structured error message (why/whatInstead/reference) */
  errorMessage?: {
    why: string;
    whatInstead: string;
    reference: string;
  };
}

/** Design §6.2: Conflict between two rules */
export interface RuleConflict {
  ruleA: string;
  ruleB: string;
  type: "direct_conflict" | "redundant" | "needs_refinement";
  description: string;
  resolution: string;
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
  conflicts: RuleConflict[];
  summary: {
    total: number;
    byMedium: Record<RuleMedium, number>;
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
    recommendedMedium: z.enum(["linter_error", "linter_warn", "linter+hook", "claude_md", "ci", "hook", "settings", "none", "claude.md", "linter", "settings.json"]),
  })),
  dryRun: z.boolean().optional().default(false),
});

export type GenerateConfigInput = z.infer<typeof GenerateConfigInputSchema>;

export const QueryStateInputSchema = z.object({
  projectDir: z.string().describe("Absolute path to the project directory"),
});

export type QueryStateInput = z.infer<typeof QueryStateInputSchema>;

export interface ConfigError {
  file: string;
  message: string;
  code: string;
}

export interface GenerateConfigOutput {
  files: Array<{
    path: string;
    content: string;
    action: "created" | "overwritten" | "skipped" | "merged" | "dry_run";
    backupPath?: string;
  }>;
  summary: {
    total: number;
    created: number;
    updated: number;
    skipped: number;
  };
  errors: ConfigError[];
  warnings: string[];
}

// ============================================================
// State Management (design §4.1)
// ============================================================

export interface GenerationRecord {
  phase: string;
  timestamp: string;
  action: string;
  detail?: string;
}

export interface HarnessState {
  phase: HarnessStatus;
  projectDir: string;
  createdAt: string;
  updatedAt: string;
  engineInput?: EngineInput;
  engineOutput?: EngineOutput;
  decisions?: RuleDecision[];
  confirmedAt?: string;
  configOutput?: GenerateConfigOutput;
  version: string;
  evaluatedAt?: string;
  // Design §4.1 missing fields:
  sessionId?: string;
  validatedAt?: string;
  generationLog?: GenerationRecord[];
  validation?: {
    status: "pass" | "warn" | "fail";
    errors: number;
    warnings: number;
    findings: number;
    checkedAt: string;
  };
  project?: {
    techStack: TechStack[];
    projectPhase: ProjectPhase;
    teamSize: TeamSize;
  };
}

// ============================================================
// Suitability Assessment
// ============================================================

export interface SuitabilityWarning {
  type: "prototype" | "script" | "overhead";
  severity: "low" | "medium" | "high";
  message: string;
  evidence?: string[];
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

export interface ABTestMetric {
  name: string;
  weight: number;
}

export interface ABTestConfig {
  ruleId: string;
  baselineMedium: RuleMedium;
  testMedium: RuleMedium;
  durationDays: number;
  metrics: ABTestMetric[];
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
  effectiveness?: {
    fixRate: number;
    clarityScore: number;
    learningImpact: number;
  };
}

export interface ErrorSuggestion {
  templateId: string;
  renderedMessage: string;
  confidence: number;
}

/** Cognitive auto-trigger for repeated error pattern detection (OpenAPI CognitiveAutoTrigger). */
export interface CognitiveAutoTrigger {
  skillType: "educational";
  ruleId: string;
  topic: string;
  experienceLevel: "beginner" | "intermediate" | "advanced";
}

// ============================================================
// Scan / Init / Rollback Input Schemas
// ============================================================

export const ScanCodebaseInputSchema = z.object({
  projectDir: z.string().describe("Absolute path to the project directory"),
  techStack: z.array(z.enum(["typescript", "javascript", "python", "go", "java", "generic"])).optional().describe("Tech stack for rule filtering"),
  projectPhase: z.enum(["prototype", "early", "growth", "mature"]).optional().describe("Project phase for context-aware decisions"),
  teamSize: z.enum(["solo", "small", "medium", "large"]).optional().describe("Team size for frequency estimation"),
  scanDepth: z.enum(["quick", "full"]).optional().default("full").describe("Scan depth: quick (config + recent sources) or full (all files)"),
  useCache: z.boolean().optional().default(false).describe("Enable incremental scan cache (only scans changed files)"),
});

export type ScanCodebaseInput = z.infer<typeof ScanCodebaseInputSchema>;

export const InitHarnessInputSchema = z.object({
  projectDir: z.string().describe("Absolute path to the project directory"),
  projectPhase: z.enum(["prototype", "early", "growth", "mature"]).describe("Current phase of the project"),
  teamSize: z.enum(["solo", "small", "medium", "large"]).describe("Size of the development team"),
  techStack: z.array(z.enum(["typescript", "javascript", "python", "go", "java", "generic"])).describe("Technology stack used"),
  dryRun: z.boolean().optional().default(false).describe("Preview mode without making changes"),
  preset: z.object({
    techStack: z.array(z.enum(["typescript", "javascript", "python", "go", "java", "generic"])).optional(),
    projectPhase: z.enum(["prototype", "early", "growth", "mature"]).optional(),
    teamSize: z.enum(["solo", "small", "medium", "large"]).optional(),
  }).optional().describe("Nested preset object (alternative to flat params)"),
});

export type InitHarnessInput = z.infer<typeof InitHarnessInputSchema>;

export const ConfirmDecisionsInputSchema = z.object({
  projectDir: z.string().describe("Absolute path to the project directory"),
  decisions: z.array(z.object({
    ruleId: z.string(),
    ruleName: z.string().optional(),
    recommendedMedium: z.enum(["linter_error", "linter_warn", "linter+hook", "claude_md", "ci", "hook", "settings", "none", "claude.md", "linter", "settings.json"]),
    alternativeMedia: z.array(z.enum(["linter_error", "linter_warn", "linter+hook", "claude_md", "ci", "hook", "settings", "none", "claude.md", "linter", "settings.json"])).optional(),
    confidence: z.number().min(0).max(1).optional(),
    reasons: z.array(z.string()).optional(),
    cognitiveLayerRequired: z.boolean().optional(),
    cognitiveSkillTriggers: z.array(z.string()).optional(),
  })).describe("Confirmed rule decisions"),
});

export type ConfirmDecisionsInput = z.infer<typeof ConfirmDecisionsInputSchema>;

export interface RollbackOutput {
  status: "success" | "partial" | "failed";
  restored: string[];
  failed: string[] | null;
  errors: string[] | null;
  backupId: string;
  cleaned?: string[] | null;
}

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
}).refine(
  (data) => data.exportJson || data.presetId || data.filePath,
  { message: "Provide one of: presetId, exportJson, or filePath" },
);

export type ImportRulesInput = z.infer<typeof ImportRulesInputSchema>;

export const ListRulePresetsInputSchema = z.object({
  techStack: z.array(z.string()).optional().describe("Filter presets by tech stack"),
});

export type ListRulePresetsInput = z.infer<typeof ListRulePresetsInputSchema>;

export const ListRuleExportsInputSchema = z.object({
  projectDir: z.string().describe("Absolute path to the project directory"),
});

export type ListRuleExportsInput = z.infer<typeof ListRuleExportsInputSchema>;
export const ResetStateInputSchema = z.object({
  projectDir: z.string().describe("Absolute path to the project directory"),
});
export type ResetStateInput = z.infer<typeof ResetStateInputSchema>;

export const SuggestErrorImprovementInputSchema = z.object({
  projectDir: z.string().describe("Absolute path to the project directory"),
});
export type SuggestErrorImprovementInput = z.infer<typeof SuggestErrorImprovementInputSchema>;

// Medium tools
export const AnalyzeABResultsInputSchema = z.object({
  projectDir: z.string().describe("Absolute path to the project directory"),
  testId: z.string().optional().describe("Optional, analyze all active tests if not specified"),
});
export type AnalyzeABResultsInput = z.infer<typeof AnalyzeABResultsInputSchema>;

export const AssessSuitabilityInputSchema = z.object({
  projectDir: z.string().describe("Absolute path to the project directory"),
  techStack: z.array(z.string()).optional().describe("Technology stack (optional)"),
  analysisDepth: z.enum(["quick", "full"]).optional().default("full").describe("Analysis depth: quick or full"),
});
export type AssessSuitabilityInput = z.infer<typeof AssessSuitabilityInputSchema>;

// Complex tools
export const StartABTestInputSchema = z.object({
  projectDir: z.string().describe("Absolute path to the project directory"),
  ruleId: z.string().describe("Rule ID to test"),
  baselineMedium: z.enum(["linter_error", "linter_warn", "linter+hook", "claude_md", "ci", "hook", "settings", "none", "claude.md", "linter", "settings.json"]).describe("Baseline medium"),
  testMedium: z.enum(["linter_error", "linter_warn", "linter+hook", "claude_md", "ci", "hook", "settings", "none", "claude.md", "linter", "settings.json"]).describe("Test medium"),
  durationDays: z.number().optional().default(14).describe("Test duration in days"),
  metrics: z.array(z.union([
    z.string(),
    z.object({ name: z.string(), weight: z.number() }),
  ])).optional().default(["triggerCount", "fixRate", "bypassCount"]).describe("Metrics to track: string[] (backward compat) or {name, weight}[]"),
});
export type StartABTestInput = z.infer<typeof StartABTestInputSchema>;

export const CollectABMetricsInputSchema = z.object({
  projectDir: z.string().describe("Absolute path to the project directory"),
  testId: z.string().describe("A/B test ID"),
  triggerCount: z.number().describe("Trigger count"),
  fixRate: z.number().describe("Fix rate (0-1)"),
  bypassCount: z.number().describe("Bypass count"),
  userFeedback: z.string().optional().describe("User feedback (optional)"),
});
export type CollectABMetricsInput = z.infer<typeof CollectABMetricsInputSchema>;

export const OptimizeErrorMessageInputSchema = z.object({
  projectDir: z.string().optional().describe("Absolute path to the project directory"),
  ruleId: z.string().optional().describe("Rule ID (optional)"),
  ruleName: z.string().optional().describe("Rule name (optional)"),
  scenario: z.string().optional().describe("Scenario description (optional)"),
  actualCode: z.string().optional().describe("Actual code snippet (optional)"),
  fileName: z.string().optional().describe("File name (optional)"),
  lineNumber: z.number().optional().describe("Line number (optional)"),
  rateAfter: z.boolean().optional().describe("Whether to record rating (optional)"),
});
export type OptimizeErrorMessageInput = z.infer<typeof OptimizeErrorMessageInputSchema>;

export const CognitiveSkillInputSchema = z.object({
  skillType: z.enum(["diagnostic", "educational", "decision-support"]).describe("Skill type"),
  ruleId: z.string().describe("Rule ID or name"),
  projectDir: z.string().optional().describe("Project directory (optional, for rule loading)"),
  codePattern: z.string().optional().describe("Code pattern (diagnostic)"),
  contextDescription: z.string().optional().describe("Context description (diagnostic)"),
  topic: z.string().optional().describe("Topic (educational)"),
  experienceLevel: z.enum(["beginner", "intermediate", "advanced"]).optional().describe("Experience level (educational)"),
  currentMedium: z.string().optional().describe("Current medium (decision-support)"),
  candidateMedia: z.array(z.string()).optional().describe("Candidate media list (decision-support)"),
  projectPhase: z.string().optional().describe("Project phase (decision-support)"),
  teamSize: z.string().optional().describe("Team size (decision-support)"),
  techStack: z.array(z.string()).optional().describe("Tech stack (decision-support)"),
});
export type CognitiveSkillInput = z.infer<typeof CognitiveSkillInputSchema>;
