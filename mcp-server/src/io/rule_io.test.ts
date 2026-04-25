import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RuleIO } from "./rule_io.js";
import type { RuleDecision, RuleDefinition } from "../types.js";

function makeDecisions(): RuleDecision[] {
  return [
    {
      ruleId: "R001",
      ruleName: "no-console-log",
      recommendedMedium: "linter",
      alternativeMedia: ["hook", "claude.md"],
      confidence: 0.85,
      reasons: ["formalizable", "low cost"],
      cognitiveLayerRequired: false,
      cognitiveSkillTriggers: [],
    },
    {
      ruleId: "R003",
      ruleName: "prefer-early-return",
      recommendedMedium: "claude.md",
      alternativeMedia: ["linter", "settings.json"],
      confidence: 0.7,
      reasons: ["not formalizable"],
      cognitiveLayerRequired: true,
      cognitiveSkillTriggers: ["diagnostic", "educational"],
    },
  ];
}

function makeDefinitions(): RuleDefinition[] {
  return [
    {
      id: "R001",
      name: "no-console-log",
      description: "No console.log in production",
      category: "code-quality",
      formalizable: true,
      cost: 1,
      feedbackSpeed: 1,
      frequency: 4,
      recommendedMedium: "linter",
      alternativeMedium: ["hook", "claude.md"],
      techStack: ["typescript", "javascript"],
    },
    {
      id: "R003",
      name: "prefer-early-return",
      description: "Prefer early return",
      category: "code-style",
      formalizable: false,
      cost: 1,
      feedbackSpeed: 1,
      frequency: 5,
      recommendedMedium: "claude.md",
      alternativeMedium: ["linter", "settings.json"],
      techStack: ["typescript", "javascript", "python", "go", "java"],
      cognitiveLayerSupport: {
        required: true,
        skillTriggers: ["diagnostic", "educational"],
        contextRequirements: ["function complexity"],
      },
    },
  ];
}

describe("RuleIO", () => {
  let tmpDir: string;
  let io: RuleIO;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `harness-io-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    io = new RuleIO(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("exportRules", () => {
    it("serializes decisions to export format", () => {
      const decisions = makeDecisions();
      const data = io.exportRules(decisions, {
        projectPhase: "growth",
        teamSize: "medium",
        techStack: ["typescript"],
      });

      expect(data.version).toBe("1.0");
      expect(data.source.projectDir).toBe(tmpDir);
      expect(data.source.projectPhase).toBe("growth");
      expect(data.rules.length).toBe(2);

      const r1 = data.rules[0];
      expect(r1.ruleId).toBe("R001");
      expect(r1.recommendedMedium).toBe("linter");
    });
  });

  describe("saveExport / listExports / loadExport", () => {
    it("saves export to .harness/exports/", () => {
      const decisions = makeDecisions();
      const data = io.exportRules(decisions);
      const filePath = io.saveExport(data, "test-export.json");

      expect(filePath).toContain(".harness/exports/test-export.json");
      expect(existsSync(filePath)).toBe(true);
    });

    it("generates default filename when none given", () => {
      const decisions = makeDecisions();
      const data = io.exportRules(decisions);
      const filePath = io.saveExport(data);

      expect(filePath).toContain(".harness/exports/");
      expect(filePath).toContain("harness-export-");
    });

    it("lists available exports", () => {
      const decisions = makeDecisions();
      const data = io.exportRules(decisions);
      io.saveExport(data, "export-a.json");
      io.saveExport(data, "export-b.json");

      const exports = io.listExports();
      expect(exports.length).toBe(2);
      expect(exports).toContain("export-a.json");
      expect(exports).toContain("export-b.json");
    });

    it("returns empty list when no exports exist", () => {
      expect(io.listExports()).toEqual([]);
    });

    it("loads an export file and returns parsed data", () => {
      const decisions = makeDecisions();
      const data = io.exportRules(decisions);
      const filePath = io.saveExport(data, "roundtrip.json");

      const loaded = io.loadExport(filePath);
      expect(loaded.version).toBe("1.0");
      expect(loaded.rules.length).toBe(2);
    });
  });

  describe("importRules", () => {
    it("converts export data back to decisions", () => {
      const decisions = makeDecisions();
      const defs = makeDefinitions();
      const data = io.exportRules(decisions);
      const result = io.importRules(data, defs);

      expect(result.total).toBe(2);
      expect(result.decisions.length).toBe(2);
      expect(result.warnings.length).toBe(0);
    });

    it("enriches decisions with definition data when provided", () => {
      const decisions = makeDecisions();
      const data = io.exportRules(decisions);
      const defs = makeDefinitions();
      const result = io.importRules(data, defs);

      const r3 = result.decisions.find((d) => d.ruleId === "R003")!;
      expect(r3.cognitiveLayerRequired).toBe(true);
      expect(r3.cognitiveSkillTriggers).toContain("diagnostic");
    });

    it("warns when rule definitions are missing", () => {
      const decisions = makeDecisions();
      const data = io.exportRules(decisions);
      // Add a rule with unknown ID
      data.rules.push({
        ruleId: "R999",
        ruleName: "unknown-rule",
        recommendedMedium: "claude.md",
        confidence: 0.5,
        alternativeMedia: [],
        reasons: [],
      });

      const defs = makeDefinitions();
      const result = io.importRules(data, defs);

      expect(result.warnings.length).toBe(1);
      expect(result.warnings[0]).toContain("R999");
      expect(result.total).toBe(3);
    });
  });

  describe("getPreset / listPresets", () => {
    it("returns preset by ID", () => {
      const preset = io.getPreset("web-app-ts");
      expect(preset).toBeDefined();
      expect(preset!.id).toBe("web-app-ts");
      expect(preset!.decisions.length).toBeGreaterThan(0);
    });

    it("returns undefined for unknown preset", () => {
      expect(io.getPreset("nonexistent")).toBeUndefined();
    });

    it("lists all presets", () => {
      const presets = io.listPresets();
      expect(presets.length).toBe(5);
      const ids = presets.map((p) => p.id);
      expect(ids).toContain("web-app-ts");
      expect(ids).toContain("library-ts");
      expect(ids).toContain("python-script");
      expect(ids).toContain("prototype");
      expect(ids).toContain("go-service");
    });

    it("filters presets by techStack", () => {
      const presets = io.listPresets();
      const pythonPresets = presets.filter((p) => p.techStack.includes("python"));
      expect(pythonPresets.length).toBeGreaterThan(0);
      for (const p of pythonPresets) {
        expect(p.techStack).toContain("python");
      }
    });

    it("all preset decisions have valid ruleId format", () => {
      const presets = io.listPresets();
      for (const preset of presets) {
        for (const decision of preset.decisions) {
          expect(decision.ruleId).toMatch(/^R\d{3}$/);
        }
      }
    });
  });

  describe("exportRules — edge cases", () => {
    it("exports empty decisions array", () => {
      const data = io.exportRules([]);
      expect(data.rules).toEqual([]);
      expect(data.version).toBe("1.0");
    });

    it("exports all 5 medium types", () => {
      const decisions: RuleDecision[] = [
        { ruleId: "R001", ruleName: "no-console-log", recommendedMedium: "linter", alternativeMedia: [], confidence: 0.8, reasons: [], cognitiveLayerRequired: false, cognitiveSkillTriggers: [] },
        { ruleId: "R002", ruleName: "some-hook", recommendedMedium: "hook", alternativeMedia: [], confidence: 0.8, reasons: [], cognitiveLayerRequired: false, cognitiveSkillTriggers: [] },
        { ruleId: "R003", ruleName: "some-ci", recommendedMedium: "ci", alternativeMedia: [], confidence: 0.8, reasons: [], cognitiveLayerRequired: false, cognitiveSkillTriggers: [] },
        { ruleId: "R004", ruleName: "some-claude", recommendedMedium: "claude.md", alternativeMedia: [], confidence: 0.8, reasons: [], cognitiveLayerRequired: false, cognitiveSkillTriggers: [] },
        { ruleId: "R005", ruleName: "some-settings", recommendedMedium: "settings.json", alternativeMedia: [], confidence: 0.8, reasons: [], cognitiveLayerRequired: false, cognitiveSkillTriggers: [] },
      ];
      const data = io.exportRules(decisions);
      const exportedMedia = data.rules.map((r) => r.recommendedMedium);
      expect(exportedMedia).toContain("linter");
      expect(exportedMedia).toContain("hook");
      expect(exportedMedia).toContain("ci");
      expect(exportedMedia).toContain("claude.md");
      expect(exportedMedia).toContain("settings.json");
    });
  });

  describe("importRules — edge cases", () => {
    it("partially matches definitions, falls back to export values", () => {
      const decisions = makeDecisions();
      decisions.push({
        ruleId: "R999", ruleName: "unknown-rule", recommendedMedium: "claude.md",
        alternativeMedia: [], confidence: 0.5, reasons: [], cognitiveLayerRequired: false, cognitiveSkillTriggers: [],
      });
      const data = io.exportRules(decisions);
      const defs = makeDefinitions();
      const result = io.importRules(data, defs);
      const matched = result.decisions.find((d) => d.ruleId === "R001")!;
      expect(matched.cognitiveLayerRequired).toBe(false); // from definition
      const unmatched = result.decisions.find((d) => d.ruleId === "R999")!;
      expect(unmatched.cognitiveLayerRequired).toBe(false); // fallback
    });

    it("imports empty rules array", () => {
      const data = io.exportRules([]);
      const result = io.importRules(data);
      expect(result.decisions).toEqual([]);
      expect(result.warnings).toEqual([]);
      expect(result.total).toBe(0);
    });
  });

  describe("roundtrip", () => {
    it("export → import preserves decisions", () => {
      const original = makeDecisions();
      const data = io.exportRules(original);
      const defs = makeDefinitions();
      const result = io.importRules(data, defs);
      expect(result.total).toBe(original.length);
      for (const d of result.decisions) {
        const orig = original.find((o) => o.ruleId === d.ruleId);
        expect(orig).toBeDefined();
        expect(d.recommendedMedium).toBe(orig!.recommendedMedium);
        expect(d.cognitiveLayerRequired).toBe(orig!.cognitiveLayerRequired);
      }
    });

    it("export → save → load → import completes full cycle", () => {
      const original = makeDecisions();
      const data = io.exportRules(original);
      const filePath = io.saveExport(data, "full-cycle.json");
      const loaded = io.loadExport(filePath);
      const defs = makeDefinitions();
      const result = io.importRules(loaded, defs);
      expect(result.total).toBe(original.length);
      expect(existsSync(filePath)).toBe(true);
    });
  });
});
