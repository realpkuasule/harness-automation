# 09-performance-baselines.test.ts — 性能基线测试

**Priority**: P3

## 测试内容

### 规则加载性能 (2 tests)

| # | Case | 基准线 |
|---|------|-------|
| 1 | DecisionEngine 构造（含 rules.json 加载） | < 50ms |
| 2 | 连续 100 次 evaluate | 平均 < 10ms/次 |

### 扫描性能 (3 tests)

使用 `__fixtures__/mixed/` 目录：

| # | Case | 基准线 |
|---|------|-------|
| 3 | scanDir 首次扫描 5+ 文件 | < 500ms |
| 4 | scanDirCached 缓存命中 | < 50ms |
| 5 | scanAndEvaluate 全流程 | < 1000ms |

### Generator 性能 (2 tests)

| # | Case | 基准线 |
|---|------|-------|
| 6 | generateClaudeMd（50条 decisions） | < 10ms |
| 7 | generateCiWorkflow（50条 decisions） | < 10ms |

## Implementation

使用 `vi.spyOn(performance, 'now')` 或 `Date.now()` 差值计时：

```typescript
const start = performance.now();
// ... 被测代码 ...
const duration = performance.now() - start;
expect(duration).toBeLessThan(50); // ms
```

**注意**: 性能基线在 CI 上不建议作为硬性断言（环境差异大），而是
记录并输出到 `test-results/performance.json`，用于趋势对比。
