# 04-engine-combinatorial.test.ts — 引擎决策枚举覆盖

**Priority**: P2
**File under test**: `src/engine.ts` — `DecisionEngine` class

## Combinatorial Matrix

现有测试覆盖了 4-5 种组合。完整矩阵理论上为:

```
4 phases × 4 teamSizes × 6 techStacks = 96 组合（单个 techStack）
```

但 `filterByTechStack` 的行为和 `_decide` 的行为可以分开测试。

## Test Cases

### filterByTechStack — 全枚举 (6 tests)

| # | TechStack | 期望匹配 | 预期数量 |
|---|-----------|---------|---------|
| 1 | typescript | TS + JS + generic rules | >= 12 (rules.json 中 TS 标签规则) |
| 2 | javascript | JS + generic rules | 少于 TS 但 > 0 |
| 3 | python | Python + generic | >= 6 |
| 4 | go | Go + generic | >= 5 |
| 5 | java | Java + generic | >= 5 |
| 6 | ["typescript", "python"] | 并集 | = TS单独 + Python单独 - 重叠 |

### _finalDecision — 决策矩阵 (8 tests)

验证 `_finalDecision` 对不同 `(formalizable, cost, feedbackSpeed, freq)` 组合的输出：

| # | formalizable | cost | feedbackSpeed | freq | category | 期望 medium |
|---|-------------|------|---------------|------|----------|------------|
| 7 | true | 1 | 1 | 4 | code-quality | linter |
| 8 | true | 1 | 1 | 5 | process | hook |
| 9 | true | 3 | 5 | 3 | process | ci |
| 10 | true | 3 | 1 | 2 | code-quality | settings.json |
| 11 | true | 1 | 2 | 3 | security | linter (security 强制) |
| 12 | false | 4 | 3 | 4 | code-quality | claude.md |
| 13 | false | 4 | 3 | 1 | architecture | claude.md |
| 14 | true | 2 | 2 | 2 | architecture | linter (fallthrough) |

**备注**: `_finalDecision` 是 private 方法。测试方式：

1. 构造特定的 `EngineInput`，通过 `evaluate()` 间接测试
2. 或者通过 `// @ts-expect-error` 访问 private 方法
3. 推荐方式 1 —— 通过 rules.json 中已知的规则间接验证

### evaluate — 选择组合 (6 tests)

对已有单元测试的补充：

| # | 场景 | Input | Expect |
|---|------|-------|--------|
| 15 | prototype + solo + TS | phase=prototype, size=solo, TS | 决策数 > 0, 0 hook/ci |
| 16 | mature + large + 全栈 | phase=mature, size=large, [TS,JS,PY,GO] | 大量 hook/ci |
| 17 | prototype + large | phase=prototype, size=large | 成本低但频率高 → 极少 strict medium |
| 18 | 所有 6 种 techStack | techStack 包含全部 | 决策覆盖所有规则 |
| 19 | 重复 techStack | ["typescript","typescript"] | 与单次结果一致 |
| 20 | generic + 未知 | ["generic"] | 仅 generic 标签规则 |

### 置信度计算 (4 tests)

| # | Case | Confidence |
|---|------|-----------|
| 21 | prototype + high cost + low freq | expected ≤ 0.6 |
| 22 | mature + low cost + high freq + formalizable | expected ≥ 0.85 |
| 23 | early + formalizable | expected ≥ 0.8 |
| 24 | prototype + non-formalizable | expected ≤ 0.55 |

### 确定性 (1 test)

| # | Case | Expect |
|---|------|--------|
| 25 | 相同输入重复 3 次 | 3 次结果 === |

## 预期覆盖率

全部 25 个测试通过后：
- `filterByTechStack`: 覆盖所有 6 种 techStack + 多 stack 组合
- `_finalDecision`: 覆盖 5 种 medium 分配路径 + security 特殊 case
- `_calculateConfidence`: 覆盖 prototype/early/mature + 高低 cost/freq
- `_decide` (四问题): 间接覆盖所有路径
