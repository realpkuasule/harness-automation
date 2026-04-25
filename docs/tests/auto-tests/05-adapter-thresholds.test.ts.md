# 05-adapter-thresholds.test.ts — 规则适配器阈值测试

**Priority**: P2
**File under test**: `src/adapters/rule_adapter.ts` — `RuleAdapter` class

## Threshold Constants Under Test

```typescript
const BYPASS_DOWNGRADE_THRESHOLD = 0.3;   // bypassRate >= 30% → downgrade
const FIX_UPGRADE_THRESHOLD = 0.7;         // fixRate >= 70%   → upgrade
const LOW_TRIGGER_KEEP_THRESHOLD = 3;       // triggeredCount < 3 → keep
```

## Test Cases

### 降级条件 — bypassRate (4 tests)

| # | Scenario | Current Medium | bypassRate | triggerCount | Expected | 
|---|----------|---------------|-----------|-------------|----------|
| 1 | bypass 刚刚超过阈值 | linter | 0.31 | 10 | downgrade → settings.json |
| 2 | bypass 远超过阈值 | hook | 0.60 | 10 | downgrade → linter |
| 3 | bypass 刚好低于阈值 | linter | 0.29 | 10 | keep |
| 4 | bypass 在 claude.md 时 | claude.md | 0.50 | 10 | keep（已在最宽松的 medium，无法降级） |

### 降级条件 — low confidence (3 tests)

| # | Scenario | Current Medium | confidence | Expected |
|---|----------|---------------|-----------|----------|
| 5 | confidence < 0.5 in linter | linter | 0.4 | downgrade → settings.json |
| 6 | confidence < 0.5 in hook | hook | 0.3 | downgrade → linter |
| 7 | confidence < 0.5 in claude.md | claude.md | 0.2 | keep（无法再降级） |

### 升级条件 — fixRate (4 tests)

| # | Scenario | Current Medium | fixRate | triggerCount | Expected |
|---|----------|---------------|---------|-------------|----------|
| 8 | fixRate 刚好超过阈值 | settings.json | 0.71 | 5 | upgrade → linter |
| 9 | fixRate 远超过阈值 | linter | 0.90 | 10 | upgrade → hook |
| 10 | fixRate 低于阈值 | claude.md | 0.50 | 10 | keep |
| 11 | triggerCount < 3 | settings.json | 0.80 | 2 | keep（不足 3 次触发） |

### 升级条件 — high confidence (2 tests)

| # | Scenario | Current Medium | confidence | triggerCount | Expected |
|---|----------|---------------|-----------|-------------|----------|
| 12 | high confidence in claude.md | claude.md | 0.85 | 5 | upgrade → linter |
| 13 | high confidence in settings.json | settings.json | 0.90 | 5 | upgrade → linter |

### 升级目标验证 (1 test)

| # | Case | Expected |
|---|------|----------|
| 14 | ci → 更高无法升级 | keep（已经在最严格的 medium） |

### analyze 完整结果 (1 test)

使用构造的完整 `AnalyticsData` + `RuleUsageRecord[]` 调用 `analyze()`：

| # | Case | Expect |
|---|------|--------|
| 15 | 3 条规则的混合场景 | summary.total=3, 含 upgrade/downgrade/keep 各类型 |

## Implementation Note

构造 RuleAdapter 需要的 `AnalyticsData` 和 `RuleUsageRecord[]`：

```typescript
const mockAnalytics: AnalyticsData = {
  projectDir: "/tmp/test",
  collectedAt: new Date().toISOString(),
  summary: { totalRules: 1, byMedium: { linter: 1 }, averageConfidence: 0.8,
             cognitiveRequired: 0, highConfidence: 1 },
  rules: [{ ruleId: "R001", ruleName: "no-console-log", medium: "linter",
            confidence: 0.8, cognitiveRequired: false, category: "code-quality" }],
  history: [],
};

const mockUsage: RuleUsageRecord[] = [
  { ruleId: "R001", triggeredCount: 10, fixedCount: 8, bypassedCount: 2,
    lastTriggered: new Date().toISOString() },
];
```

Adapter 目前不使用 `projectDir` 做 IO 操作，所以不需要临时目录。
