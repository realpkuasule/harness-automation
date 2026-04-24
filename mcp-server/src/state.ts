import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessState, HarnessStatus, EngineInput, EngineOutput, GenerateConfigOutput, RuleDecision } from "./types.js";

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
      return JSON.parse(raw) as HarnessState;
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
    state.status = status;
    this.save(state);
    return state;
  }

  /** Store engine input after evaluation. */
  setEngineInput(input: EngineInput): HarnessState {
    const state = this.load();
    state.engineInput = input;
    state.status = "evaluated";
    this.save(state);
    return state;
  }

  /** Store engine output. */
  setEngineOutput(output: EngineOutput): HarnessState {
    const state = this.load();
    state.engineOutput = output;
    state.status = "evaluated";
    this.save(state);
    return state;
  }

  /** Store confirmed decisions and advance status to 'confirmed'. */
  setConfirmedDecisions(decisions: RuleDecision[]): HarnessState {
    const state = this.load();
    state.decisions = decisions;
    state.status = "confirmed";
    state.confirmedAt = new Date().toISOString();
    this.save(state);
    return state;
  }

  /** Store config output after generation. */
  setConfigOutput(output: GenerateConfigOutput): HarnessState {
    const state = this.load();
    state.configOutput = output;
    state.status = "generated";
    this.save(state);
    return state;
  }

  /** Check if we can resume from a previous session. */
  canResume(): boolean {
    const state = this.load();
    return state.status !== null && state.engineInput !== undefined;
  }

  /** Get the last status for resume logic. */
  getStatus(): HarnessStatus {
    return this.load().status;
  }

  /** Create a fresh default state. */
  private _default(): HarnessState {
    return {
      status: null,
      projectDir: this.projectDir,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: VERSION,
    };
  }
}
