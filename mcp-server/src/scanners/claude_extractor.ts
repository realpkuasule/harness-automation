import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { RuleDefinition, Medium } from "../types.js";

// ============================================================
// Types
// ============================================================

export interface ExtractedRule {
  originalId?: string;
  name: string;
  description: string;
  medium?: string;
  sourceFile: string;
}

export interface ExtractionResult {
  extractedRules: ExtractedRule[];
  sourceFiles: string[];
}

// ============================================================
// Patterns
// ============================================================

/**
 * Heuristic patterns to detect rule-like declarations in CLAUDE.md:
 *
 * 1. Markdown headings with rule names (### rule-name)
 * 2. Bullet lists with rule descriptions (- **rule**: desc)
 * 3. Lines containing rule/code-style/constraint keywords
 * 4. Structured YAML-like frontmatter rules
 */

const RULE_HEADING_RE = /^#{2,4}\s+[\w-]+/gm;
const RULE_BULLET_RE = /^[-*]\s+\*{0,2}([\w-]+)\*{0,2}\s*[(:]\s*(.+)/gm;
const RULE_KEYWORD_RE =
  /\b(rule|cannot|should|must|avoid|prefer|always|never)\b/i;

// ============================================================
// Extractor
// ============================================================

export class ClaudeExtractor {
  /**
   * Scan a project directory for CLAUDE.md files and extract rules.
   */
  extractFromProject(projectDir: string): ExtractionResult {
    const candidates = [
      join(projectDir, "CLAUDE.md"),
      join(projectDir, ".claude", "CLAUDE.md"),
      join(projectDir, "docs", "CLAUDE.md"),
      join(projectDir, ".github", "CLAUDE.md"),
    ];

    const extractedRules: ExtractedRule[] = [];
    const sourceFiles: string[] = [];

    for (const file of candidates) {
      if (existsSync(file)) {
        sourceFiles.push(file);
        const rules = this._extractFromFile(file);
        extractedRules.push(...rules);
      }
    }

    return { extractedRules, sourceFiles };
  }

  /**
   * Extract rules from a single CLAUDE.md file.
   */
  private _extractFromFile(filePath: string): ExtractedRule[] {
    try {
      const content = readFileSync(filePath, "utf-8");
      return this.parseContent(content, filePath);
    } catch {
      return [];
    }
  }

  /**
   * Parse CLAUDE.md content and extract rule declarations.
   */
  parseContent(content: string, sourceFile: string): ExtractedRule[] {
    const rules: ExtractedRule[] = [];

    // Method 1: Headings (### rule-name)
    const headingMatches = content.matchAll(RULE_HEADING_RE);
    for (const m of headingMatches) {
      const name = m[0].replace(/^#+\s+/, "").trim();
      const afterHeading = content.slice(m.index! + m[0].length).trim();
      const lines = afterHeading.split("\n").filter((l) => l.trim());
      // Collect next non-empty paragraph as description
      const descLines: string[] = [];
      for (const line of lines) {
        if (line.startsWith("#")) break;
        if (line.startsWith("-") || line.startsWith("*")) {
          descLines.push(line.replace(/^[-*]\s*/, ""));
        } else if (RULE_KEYWORD_RE.test(line)) {
          descLines.push(line);
        }
        if (descLines.length >= 3) break;
      }

      const medium = this._inferMedium(afterHeading);

      rules.push({
        name: name.toLowerCase().replace(/\s+/g, "-"),
        description: descLines.join("; ").slice(0, 200),
        medium,
        sourceFile,
      });
    }

    // Method 2: Bullet items with bold rule names (- **rule**: desc)
    const bulletMatches = content.matchAll(RULE_BULLET_RE);
    for (const m of bulletMatches) {
      const name = m[1].trim().toLowerCase().replace(/\s+/g, "-");
      // Avoid duplicates from heading extraction
      if (rules.some((r) => r.name === name)) continue;
      rules.push({
        name,
        description: m[2].trim().slice(0, 200),
        sourceFile,
      });
    }

    return rules;
  }

  /**
   * Try to infer the medium from surrounding text.
   */
  private _inferMedium(text: string): string | undefined {
    if (/\blinter\b|\beslint\b/i.test(text)) return "linter";
    if (/\bhook\b|\bhusky\b|\bpre-commit\b/i.test(text)) return "hook";
    if (/\bci\b|\bgithub\s+actions\b/i.test(text)) return "ci";
    if (/\bsettings\.json\b|\bvscode\b/i.test(text)) return "settings.json";
    return undefined;
  }

  /**
   * Convert extracted rules to RuleDefinition format for merging.
   */
  toRuleDefinitions(extracted: ExtractedRule[]): Partial<RuleDefinition>[] {
    return extracted.map((r) => ({
      id: `EXT-${r.name}`,
      name: r.name,
      description: r.description,
      category: "custom",
      formalizable: r.medium !== undefined,
      cost: 2,
      feedbackSpeed: 2,
      frequency: 3,
      recommendedMedium: (r.medium as Medium) || "claude.md",
      alternativeMedium: ["claude.md"],
      techStack: ["generic"],
    }));
  }
}
