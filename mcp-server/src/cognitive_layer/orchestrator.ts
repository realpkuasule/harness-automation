import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuleDefinition } from "../types.js";
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
