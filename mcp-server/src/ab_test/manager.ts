import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ABTestConfig, ABTestDataPoint, ABTestResult } from "../types.js";

const AB_TEST_FILE = "ab_tests.json";

interface StoredABTest {
  testId: string;
  ruleId: string;
  config: ABTestConfig;
  dataPoints: ABTestDataPoint[];
  createdAt: string;
}

/** Result of starting an A/B test. */
export interface StartABTestResult {
  testId: string;
  status: "started" | "already_running" | "invalid_config";
  startTime: string;
  endTime?: string;
  message: string;
}

export function loadTests(projectDir: string): StoredABTest[] {
  const path = join(projectDir, ".harness", AB_TEST_FILE);
  try {
    if (!existsSync(path)) return [];
    return JSON.parse(readFileSync(path, "utf-8")) as StoredABTest[];
  } catch {
    return [];
  }
}

export function saveTests(projectDir: string, tests: StoredABTest[]): void {
  const dir = join(projectDir, ".harness");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, AB_TEST_FILE), JSON.stringify(tests, null, 2), "utf-8");
}

export function startABTest(
  projectDir: string,
  config: ABTestConfig,
): StartABTestResult {
  const tests = loadTests(projectDir);

  // Validate config
  if (!config.ruleId || !config.baselineMedium || !config.testMedium) {
    return {
      testId: "",
      status: "invalid_config",
      startTime: new Date().toISOString(),
      message: "Invalid A/B test configuration: ruleId, baselineMedium, and testMedium are required",
    };
  }

  // Check for existing active test on same rule
  const existing = tests.find(
    (t) => t.ruleId === config.ruleId && !hasTestExpired(t),
  );
  if (existing) {
    return {
      testId: existing.testId,
      status: "already_running",
      startTime: existing.createdAt,
      endTime: hasTestExpired(existing) ? existing.createdAt : undefined,
      message: `Active test already exists for rule '${config.ruleId}' (ID: ${existing.testId}). Collect metrics and analyze first.`,
    };
  }

  const testId = `ab-${config.ruleId}-${Date.now()}`;
  const createdAt = new Date().toISOString();
  const durationMs = config.durationDays * 24 * 60 * 60 * 1000;
  const endTime = new Date(Date.now() + durationMs).toISOString();

  tests.push({
    testId,
    ruleId: config.ruleId,
    config,
    dataPoints: [],
    createdAt,
  });
  saveTests(projectDir, tests);

  return {
    testId,
    status: "started",
    startTime: createdAt,
    endTime,
    message: `A/B test started for rule '${config.ruleId}': ${config.baselineMedium} vs ${config.testMedium}`,
  };
}

export function collectDataPoint(
  projectDir: string,
  testId: string,
  dataPoint: ABTestDataPoint,
): { collected: boolean; message: string } {
  const tests = loadTests(projectDir);
  const test = tests.find((t) => t.testId === testId);
  if (!test) {
    return { collected: false, message: `Test '${testId}' not found` };
  }

  test.dataPoints.push(dataPoint);
  saveTests(projectDir, tests);
  return { collected: true, message: `Data point recorded for test '${testId}'` };
}

export function analyzeTest(
  projectDir: string,
  testId?: string,
): ABTestResult[] {
  const tests = loadTests(projectDir);
  const toAnalyze = testId
    ? tests.filter((t) => t.testId === testId)
    : tests;

  return toAnalyze.map((t) => analyzeSingleTest(t));
}

function analyzeSingleTest(test: StoredABTest): ABTestResult {
  const dataPoints = test.dataPoints;
  const n = dataPoints.length;

  if (n < 2) {
    return {
      testId: test.testId,
      ruleId: test.ruleId,
      config: test.config,
      dataPoints,
      statisticalSignificance: false,
      recommendation: "keep",
      confidenceScore: 0,
    };
  }

  const avgFixRate = dataPoints.reduce((s, d) => s + d.fixRate, 0) / n;
  const avgBypassRate = dataPoints.reduce((s, d) => s + d.bypassCount, 0) / n;
  const significance = n >= 5 && avgFixRate > 0.5;
  const confidence = Math.min(1, n / 10 + avgFixRate * 0.5);

  let recommendation: "keep" | "revert" | "adjust";
  if (avgFixRate > 0.7 && avgBypassRate < 0.2) {
    recommendation = "keep";
  } else if (avgFixRate < 0.3 || avgBypassRate > 0.5) {
    recommendation = "revert";
  } else {
    recommendation = "adjust";
  }

  return {
    testId: test.testId,
    ruleId: test.ruleId,
    config: test.config,
    dataPoints,
    statisticalSignificance: significance,
    recommendation,
    confidenceScore: confidence,
  };
}

function hasTestExpired(test: StoredABTest): boolean {
  if (test.dataPoints.length === 0) return false;
  const created = new Date(test.createdAt).getTime();
  const elapsed = Date.now() - created;
  const durationMs = test.config.durationDays * 24 * 60 * 60 * 1000;
  return elapsed > durationMs;
}
