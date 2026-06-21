import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { HarnessState, HarnessStatus, EngineInput, EngineOutput, GenerateConfigOutput, RuleDecision, GenerationRecord, TechStack, ProjectPhase, TeamSize, GitProvider, CollaborationMode } from "./types.js";

const STATE_DIR = ".harness";
const STATE_FILE = "state.json";
const VERSION = "1.0.0";

// ============================================================
// State Management
// ============================================================

export class StateManager {
  private projectDir: string;

  constructor(projectDir: string) {
    this.projectDir = projectDir;
  }

  /** Get the state file path. */
  private get statePath(): string {
    return join(this.projectDir, STATE_DIR, STATE_FILE);
  }

  /** Ensure the .harness directory exists. */
  private ensureDir(): void {
    const dir = join(this.projectDir, STATE_DIR);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /** Load existing state or return default. */
  load(): HarnessState {
    try {
      if (!existsSync(this.statePath)) {
        return this._default();
      }
      const raw = readFileSync(this.statePath, "utf-8");
      const parsed = JSON.parse(raw) as HarnessState & { status?: HarnessStatus };
      // Migrate from old "status" field to "phase" (design §4.1)
      if (parsed.status !== undefined && parsed.phase === undefined) {
        parsed.phase = parsed.status;
        delete parsed.status;
      }
      return parsed as HarnessState;
    } catch {
      return this._default();
    }
  }

  /** Save state to file. */
  save(state: HarnessState): void {
    this.ensureDir();
    state.updatedAt = new Date().toISOString();
    state.version = VERSION;
    writeFileSync(this.statePath, JSON.stringify(state, null, 2), "utf-8");
  }

  /** Update the harness status. */
  updateStatus(status: HarnessStatus): HarnessState {
    const state = this.load();
    state.phase = status;
    this.save(state);
    return state;
  }

  /** Store engine input after evaluation. */
  setEngineInput(input: EngineInput): HarnessState {
    const state = this.load();
    state.engineInput = input;
    state.phase = "evaluated";
    state.evaluatedAt = new Date().toISOString();
    this.save(state);
    return state;
  }

  /** Store engine output. */
  setEngineOutput(output: EngineOutput): HarnessState {
    const state = this.load();
    state.engineOutput = output;
    state.phase = "evaluated";
    state.evaluatedAt = new Date().toISOString();
    this.save(state);
    return state;
  }

  /** Store confirmed decisions and advance status to 'confirmed'. */
  setConfirmedDecisions(decisions: RuleDecision[]): HarnessState {
    const state = this.load();
    state.decisions = decisions;
    state.phase = "confirmed";
    state.confirmedAt = new Date().toISOString();
    this.save(state);
    return state;
  }

  /** Store config output after generation. */
  setConfigOutput(output: GenerateConfigOutput): HarnessState {
    const state = this.load();
    state.configOutput = output;
    state.phase = "generated";
    this.save(state);
    return state;
  }

  /** Check if we can resume from a previous session. */
  canResume(): boolean {
    const state = this.load();
    return state.phase !== null && state.engineInput !== undefined;
  }

  /** Get the last status for resume logic. */
  getStatus(): HarnessStatus {
    return this.load().phase;
  }

  /** Create a fresh default state. */
  private _default(): HarnessState {
    return {
      phase: null,
      projectDir: this.projectDir,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: VERSION,
      sessionId: randomUUID(),
    };
  }

  /** Save a generation log entry. */
  logGeneration(entry: GenerationRecord): void {
    const state = this.load();
    if (!state.generationLog) state.generationLog = [];
    state.generationLog.push(entry);
    this.save(state);
  }

  /** Store validation result snapshot. */
  setValidation(result: { summary: { status: "pass" | "warn" | "fail"; errors: number; warnings: number; info: number } }): HarnessState {
    const state = this.load();
    state.validation = {
      status: result.summary.status,
      errors: result.summary.errors,
      warnings: result.summary.warnings,
      findings: result.summary.errors + result.summary.warnings + result.summary.info,
      checkedAt: new Date().toISOString(),
    };
    state.validatedAt = new Date().toISOString();
    state.phase = "validated";
    this.save(state);
    return state;
  }

  /** Store project info snapshot. */
  setProjectInfo(
    techStack: TechStack[],
    projectPhase: ProjectPhase,
    teamSize: TeamSize,
    gitProvider?: GitProvider,
    collaborationMode?: CollaborationMode,
  ): void {
    const state = this.load();
    state.project = { techStack, projectPhase, teamSize, gitProvider, collaborationMode };
    this.save(state);
  }
}
