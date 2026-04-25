import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuleDefinition, CognitiveAutoTrigger } from "../types.js";
import { executeDiagnostic } from "./skills/diagnostic.js";
import type { DiagnosticResult } from "./skills/diagnostic.js";
import { executeEducational } from "./skills/educational.js";
import type { EducationalResult } from "./skills/educational.js";
import { executeDecisionSupport } from "./skills/decision_support.js";
import type { DecisionSupportResult } from "./skills/decision_support.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type SkillType = "diagnostic" | "educational" | "decision-support";

export interface CognitiveRequest {
  skillType: SkillType;
  ruleId: string;
  projectDir?: string;
  codePattern?: string;
  contextDescription?: string;
  topic?: string;
  experienceLevel?: "beginner" | "intermediate" | "advanced";
  currentMedium?: string;
  candidateMedia?: string[];
  projectPhase?: string;
  teamSize?: string;
  techStack?: string[];
}

export type CognitiveResponse = DiagnosticResult | EducationalResult | DecisionSupportResult;

function loadRules(): RuleDefinition[] {
  const rulesPath = join(__dirname, "..", "rules.json");
  const raw = readFileSync(rulesPath, "utf-8");
  return JSON.parse(raw) as RuleDefinition[];
}

export function processCognitiveRequest(input: CognitiveRequest): CognitiveResponse {
  const rules = loadRules();
  const rule = rules.find((r) => r.id === input.ruleId || r.name === input.ruleId);

  if (!rule) {
    throw new Error(`Rule '${input.ruleId}' not found`);
  }

  switch (input.skillType) {
    case "diagnostic":
      return executeDiagnostic({
        rule,
        codePattern: input.codePattern,
        contextDescription: input.contextDescription,
      });

    case "educational":
      return executeEducational({
        rule,
        topic: input.topic,
        experienceLevel: input.experienceLevel,
      });

    case "decision-support":
      return executeDecisionSupport({
        rule,
        currentMedium: input.currentMedium as any,
        candidateMedia: input.candidateMedia as any,
        context: {
          projectPhase: input.projectPhase,
          teamSize: input.teamSize,
          techStack: input.techStack,
        },
      });

    default:
      throw new Error(`Unknown skill type: ${input.skillType}`);
  }
}

export interface TriggerEntry {
  ruleId: string;
  timestamp: string;
}

/**
 * Detect repeated error patterns: if the same ruleId appears >= 2 times
 * in the last 3 entries, return an educational CognitiveRequest.
 * Returns null when no auto-trigger is needed.
 */
export function shouldAutoTrigger(
  history: TriggerEntry[],
): CognitiveAutoTrigger | null {
  const recent = history.slice(-3);
  const counts = new Map<string, number>();
  for (const entry of recent) {
    counts.set(entry.ruleId, (counts.get(entry.ruleId) ?? 0) + 1);
  }
  for (const [ruleId, count] of counts) {
    if (count >= 2) {
      return {
        skillType: "educational",
        ruleId,
        topic: `重复错误模式检测：规则 ${ruleId} 在最近 ${recent.length} 次中出现 ${count} 次`,
        experienceLevel: "intermediate",
      };
    }
  }
  return null;
}
