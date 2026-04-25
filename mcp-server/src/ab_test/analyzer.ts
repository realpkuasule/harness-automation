import { analyzeTest } from "./manager.js";
import type { ABTestResult } from "../types.js";

export interface AnalyzeABInput {
  projectDir: string;
  testId?: string;
}

export function analyzeABResults(input: AnalyzeABInput): {
  results: ABTestResult[];
  summary: { total: number; significant: number; keep: number; revert: number; adjust: number };
} {
  const results = analyzeTest(input.projectDir, input.testId);
  return {
    results,
    summary: {
      total: results.length,
      significant: results.filter((r) => r.statisticalSignificance).length,
      keep: results.filter((r) => r.recommendation === "keep").length,
      revert: results.filter((r) => r.recommendation === "revert").length,
      adjust: results.filter((r) => r.recommendation === "adjust").length,
    },
  };
}
