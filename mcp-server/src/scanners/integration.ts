import { CodeScanner, type ScanSuggestion } from "./code_scanner.js";
import { ClaudeExtractor } from "./claude_extractor.js";
import { DecisionEngine } from "../engine.js";
import type { RuleDecision, Medium, EngineInput } from "../types.js";

// ============================================================
// Scan + Decision Integration
// ============================================================

export interface IntegratedResult {
  scanSummary: {
    filesScanned: number;
    totalLines: number;
    durationMs: number;
    suggestions: ScanSuggestion[];
  };
  extractedRules: number;
  decisions: RuleDecision[];
}

/**
 * Run a full scan-evaluate pipeline:
 * 1. Scan codebase for violations (with optional cache)
 * 2. Extract existing CLAUDE.md rules
 * 3. Adjust decision weights based on scan findings
 * 4. Return integrated results
 */
export async function scanAndEvaluate(
  input: EngineInput,
  options?: { useCache?: boolean },
): Promise<IntegratedResult> {
  // Step 1: Code scan (with optional cache)
  const codeScanner = new CodeScanner();

  let scanResult;
  if (options?.useCache) {
    scanResult = await codeScanner.scanDirCached(input.projectDir);
  } else {
    scanResult = await codeScanner.scanDir(input.projectDir);
  }

  // Step 2: CLAUDE.md extraction
  const extractor = new ClaudeExtractor();
  const extractionResult = extractor.extractFromProject(input.projectDir);

  // Step 3: Decision engine
  const engine = new DecisionEngine();
  const engineOutput = engine.evaluate(input);

  // Step 4: Boost confidence for rules found in scan
  const adjusted = adjustDecisionsByScan(
    engineOutput.decisions,
    scanResult.suggestions,
  );

  // Step 5: Add extracted rules as custom decisions
  const extractedDefs = extractor.toRuleDefinitions(
    extractionResult.extractedRules,
  );
  const extraDecisions: RuleDecision[] = extractedDefs.map((d) => ({
    ruleId: d.id!,
    ruleName: d.name!,
    recommendedMedium: d.recommendedMedium as Medium,
    alternativeMedia: ["claude.md"],
    confidence: 0.6,
    reasons: ["Extracted from existing CLAUDE.md"],
    cognitiveLayerRequired: !d.formalizable,
    cognitiveSkillTriggers: [],
  }));

  return {
    scanSummary: {
      filesScanned: scanResult.scannedFiles,
      totalLines: scanResult.totalLines,
      durationMs: scanResult.durationMs,
      suggestions: scanResult.suggestions,
    },
    extractedRules: extractionResult.extractedRules.length,
    decisions: [...adjusted, ...extraDecisions],
  };
}

/**
 * Adjust decision confidence based on scan findings.
 * Rules with many occurrences get higher confidence.
 */
export function adjustDecisionsByScan(
  decisions: RuleDecision[],
  suggestions: ScanSuggestion[],
): RuleDecision[] {
  const suggestionMap = new Map(
    suggestions.map((s) => [s.ruleId, s]),
  );

  return decisions.map((d) => {
    const scanHit = suggestionMap.get(d.ruleId);
    if (!scanHit) return d;

    // Boost confidence based on scan evidence
    const confidenceBoost = Math.min(0.15, scanHit.occurrences * 0.02);
    const newConfidence = Math.min(1, d.confidence + confidenceBoost);

    return {
      ...d,
      confidence: Math.round(newConfidence * 100) / 100,
      reasons: [
        ...d.reasons,
        `代码扫描发现 ${scanHit.occurrences} 处匹配`,
      ],
    };
  });
}

export { CodeScanner } from "./code_scanner.js";
export { ClaudeExtractor } from "./claude_extractor.js";
