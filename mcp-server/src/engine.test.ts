import { describe, it, expect } from "vitest";
import { DecisionEngine } from "./engine.js";

describe("DecisionEngine", () => {
  const engine = new DecisionEngine();

  describe("filterByTechStack", () => {
    it("returns TypeScript rules for typescript stack", () => {
      const rules = engine.filterByTechStack(["typescript"]);
      expect(rules.length).toBeGreaterThan(0);
      expect(rules.every((r) => r.techStack.includes("typescript"))).toBe(true);
    });

    it("returns generic rules for any stack", () => {
      const rules = engine.filterByTechStack(["go"]);
      // All go rules should include go in techStack or generic
      expect(rules.every((r) => r.techStack.some((t) => ["go", "generic"].includes(t)))).toBe(true);
    });

    it("returns fewer rules for python-only vs multi-stack", () => {
      const ts = engine.filterByTechStack(["typescript"]);
      const py = engine.filterByTechStack(["python"]);
      expect(ts.length).toBeGreaterThan(py.length);
    });

    it("handles unknown tech stack gracefully", () => {
      const rules = engine.filterByTechStack(["unknown"]);
      // Only generic rules might match — or none
      expect(Array.isArray(rules)).toBe(true);
    });
  });

  describe("evaluate", () => {
    it("returns decisions for a full-stack TypeScript project", () => {
      const output = engine.evaluate({
        projectDir: "/test",
        projectPhase: "growth",
        teamSize: "medium",
        techStack: ["typescript", "javascript"],
      });

      expect(output.decisions.length).toBeGreaterThan(0);
      expect(output.summary.total).toBe(output.decisions.length);
      expect(output.summary.byMedium).toBeDefined();
      expect(Object.keys(output.summary.byMedium).length).toBeGreaterThan(0);
    });

    it("adjusts for prototype phase — lower confidence and fewer strict tools", () => {
      const growth = engine.evaluate({
        projectDir: "/test",
        projectPhase: "growth",
        teamSize: "medium",
        techStack: ["typescript"],
      });

      const proto = engine.evaluate({
        projectDir: "/test",
        projectPhase: "prototype",
        teamSize: "medium",
        techStack: ["typescript"],
      });

      // Prototype should have lower average confidence
      const growthAvg = growth.decisions.reduce((s, d) => s + d.confidence, 0) / growth.decisions.length;
      const protoAvg = proto.decisions.reduce((s, d) => s + d.confidence, 0) / proto.decisions.length;
      expect(protoAvg).toBeLessThan(growthAvg);
    });

    it("adjusts for large team — higher frequency estimates", () => {
      const solo = engine.evaluate({
        projectDir: "/test",
        projectPhase: "growth",
        teamSize: "solo",
        techStack: ["typescript"],
      });

      const large = engine.evaluate({
        projectDir: "/test",
        projectPhase: "growth",
        teamSize: "large",
        techStack: ["typescript"],
      });

      // Large team should push more rules to stricter media
      // (higher frequency → more rules land in hook/ci)
      const soloStrict = (solo.summary.byMedium["hook"] || 0) + (solo.summary.byMedium["ci"] || 0);
      const largeStrict = (large.summary.byMedium["hook"] || 0) + (large.summary.byMedium["ci"] || 0);
      expect(largeStrict).toBeGreaterThanOrEqual(soloStrict);
    });

    it("marks security rules as linter regardless of other factors", () => {
      const output = engine.evaluate({
        projectDir: "/test",
        projectPhase: "prototype",
        teamSize: "solo",
        techStack: ["typescript", "javascript", "python", "go", "java"],
      });

      const securityRules = output.decisions.filter((d) => d.ruleId === "R012");
      for (const rule of securityRules) {
        expect(rule.recommendedMedium).toBe("linter");
      }
    });

    it("detects cognitive layer requirements for non-formalizable rules", () => {
      const output = engine.evaluate({
        projectDir: "/test",
        projectPhase: "growth",
        teamSize: "medium",
        techStack: ["typescript", "javascript", "python", "go", "java"],
      });

      const cognitiveRules = output.decisions.filter((d) => d.cognitiveLayerRequired);
      expect(cognitiveRules.length).toBeGreaterThan(0);

      for (const rule of cognitiveRules) {
        expect(rule.cognitiveSkillTriggers.length).toBeGreaterThan(0);
      }
    });

    it("produces consistent results for identical inputs", () => {
      const input = {
        projectDir: "/test",
        projectPhase: "growth" as const,
        teamSize: "medium" as const,
        techStack: ["typescript" as const],
      };

      const a = engine.evaluate(input);
      const b = engine.evaluate(input);

      expect(a.decisions).toEqual(b.decisions);
    });
  });
});
