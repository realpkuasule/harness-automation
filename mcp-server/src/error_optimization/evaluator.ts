import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ErrorSuggestion } from "../types.js";

const EVAL_FILE = "error_message_evaluations.json";

interface EvaluationRecord {
  templateId: string;
  context: string;
  renderedMessage: string;
  timestamp: string;
  userRating?: number; // 1-5
  wasHelpful?: boolean;
  wasFollowed?: boolean;
}

export interface EvaluationStats {
  totalRecords: number;
  ratedRecords: number;
  averageRating: number;
  helpfulRate: number;
  followRate: number;
  templateStats: Record<string, {
    uses: number;
    averageRating: number;
  }>;
}

export class ErrorMessageEvaluator {
  private projectDir: string;

  constructor(projectDir: string) {
    this.projectDir = projectDir;
  }

  private getStoragePath(): string {
    return join(this.projectDir, ".harness", EVAL_FILE);
  }

  private loadRecords(): EvaluationRecord[] {
    const path = this.getStoragePath();
    try {
      if (!existsSync(path)) return [];
      return JSON.parse(readFileSync(path, "utf-8")) as EvaluationRecord[];
    } catch {
      return [];
    }
  }

  private saveRecords(records: EvaluationRecord[]): void {
    const path = this.getStoragePath();
    mkdirSync(join(this.projectDir, ".harness"), { recursive: true });
    writeFileSync(path, JSON.stringify(records, null, 2), "utf-8");
  }

  recordSuggestion(suggestion: ErrorSuggestion, context: string): void {
    const records = this.loadRecords();
    records.push({
      templateId: suggestion.templateId,
      context,
      renderedMessage: suggestion.renderedMessage,
      timestamp: new Date().toISOString(),
    });
    this.saveRecords(records);
  }

  rateSuggestion(templateId: string, rating: number, wasFollowed: boolean): boolean {
    const records = this.loadRecords();
    // Find the latest unrated record for this template
    const record = [...records].reverse().find(
      (r) => r.templateId === templateId && r.userRating === undefined,
    );
    if (!record) return false;

    record.userRating = rating;
    record.wasHelpful = rating >= 4;
    record.wasFollowed = wasFollowed;
    this.saveRecords(records);
    return true;
  }

  getStats(): EvaluationStats {
    const records = this.loadRecords();

    if (records.length === 0) {
      return {
        totalRecords: 0,
        ratedRecords: 0,
        averageRating: 0,
        helpfulRate: 0,
        followRate: 0,
        templateStats: {},
      };
    }

    const ratedRecords = records.filter((r) => r.userRating !== undefined);
    const helpfulRecords = records.filter((r) => r.wasHelpful === true);
    const followedRecords = records.filter((r) => r.wasFollowed === true);

    // Per-template stats
    const templateStats: Record<string, { uses: number; averageRating: number }> = {};
    for (const r of records) {
      if (!templateStats[r.templateId]) {
        templateStats[r.templateId] = { uses: 0, averageRating: 0 };
      }
      templateStats[r.templateId].uses++;
    }
    for (const r of ratedRecords) {
      const stat = templateStats[r.templateId];
      if (stat) {
        stat.averageRating = (stat.averageRating * (stat.uses - 1) + (r.userRating ?? 0)) / stat.uses;
      }
    }

    return {
      totalRecords: records.length,
      ratedRecords: ratedRecords.length,
      averageRating: ratedRecords.length > 0
        ? ratedRecords.reduce((s, r) => s + (r.userRating ?? 0), 0) / ratedRecords.length
        : 0,
      helpfulRate: ratedRecords.length > 0
        ? helpfulRecords.length / ratedRecords.length
        : 0,
      followRate: ratedRecords.length > 0
        ? followedRecords.length / ratedRecords.length
        : 0,
      templateStats,
    };
  }
}
