# 02-state-machine.test.ts — 状态机流转测试

**Priority**: P1
**File under test**: `src/state.ts` — `StateManager` class

## Test Cases

### 合法路径 (6 tests)

| # | 路径 | 调用序列 | 最终 status |
|---|------|---------|------------|
| 1 | null → evaluated | setEngineInput() | "evaluated" |
| 2 | null → evaluated | setEngineOutput() | "evaluated" |
| 3 | evaluated → confirmed | setConfirmedDecisions() | "confirmed" |
| 4 | confirmed → generated | setConfigOutput() | "generated" |
| 5 | generated → validated | updateStatus("validated") | "validated" |
| 6 | 整条链路: null → evaluated → confirmed → generated → validated | 依次调用 | "validated" |

### 状态查询 (3 tests)

| # | Case | Expect |
|---|------|--------|
| 7 | load() 返回默认状态（文件不存在） | status=null, version="1.0.0" |
| 8 | getStatus() | 当前 status |
| 9 | canResume() 在 null 状态 | false |

### 跨实例持久化 (2 tests)

| # | Case | Expect |
|---|------|--------|
| 10 | 新建 StateManager 能读取之前写入的 state | 数据一致 |
| 11 | state 中的 engineOutput.decisions 完整保留 | decisions.length > 0 |

### 文件损坏/容错 (2 tests)

| # | Case | Expect |
|---|------|--------|
| 12 | state.json 内容不是合法 JSON | load() 返回默认值 |
| 13 | state.json 缺失关键字段 | load() 能返回默认值，不抛异常 |

### 幂等性 (2 tests)

| # | Case | Expect |
|---|------|--------|
| 14 | 重复 setEngineInput | 状态不变，updatedAt 更新时间戳 |
| 15 | 重复 setConfirmedDecisions | 仅 confirmedAt 更新 |

## Implementation Note

全部测试使用临时目录（`tmpdir`），与现有集成测试模式一致。不需要 mock fs。

关键断言点：
- 每次 `save()` 后，`updatedAt` 被更新
- 文件写入路径：`${tmpDir}/.harness/state.json`
- `version` 字段始终为 `"1.0.0"`
