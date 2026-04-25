# 06-io-roundtrip.test.ts — 规则导入/导出闭环测试

**Priority**: P2
**File under test**: `src/io/rule_io.ts` — `RuleIO` class

## Test Cases

### exportRules — 格式验证 (4 tests)

| # | Case | Input | Expect |
|---|------|-------|--------|
| 1 | 基本导出 | 标准 decisions | 含 version, exportedAt, source, rules[] |
| 2 | 带 metadata | 含 projectPhase, teamSize | source 含所有 metadata 字段 |
| 3 | 空 decisions | [] | rules=[], version="1.0" |
| 4 | 所有 medium 类型 | 5 种 medium 各一个 | 全部保留 |

### saveExport / loadExport — 文件操作 (3 tests)

| # | Case | Expect |
|---|------|--------|
| 5 | saveExport | 文件写入 .harness/exports/ |
| 6 | 自定义 filename | 文件名匹配 |
| 7 | loadExport 读取同一文件 | 数据与导出一致 |

### importRules — 导入逻辑 (4 tests)

| # | Case | Input | Expect |
|---|------|-------|--------|
| 8 | 完整 definitions | 有 enrichFromDefinitions | 含 cognitiveLayerRequired |
| 9 | 无 definitions | 无 enrich | warnings 含 "not found" |
| 10 | 部分匹配 definitions | 部分 ruleId 不存在 | 匹配的有定义值，未匹配的用导出值 |
| 11 | 空 rules 导入 | data.rules=[] | decisions=[], warnings=[] |

### presets (5 tests)

| # | Case | Input | Expect |
|---|------|-------|--------|
| 12 | getPreset 有效 ID | "web-app-ts" | 返回匹配的 preset |
| 13 | getPreset 无效 ID | "non-existent" | undefined |
| 14 | listPresets | — | 返回 5 个预设 |
| 15 | listPresets 过滤 | techStack=["python"] | 仅含 python-script + prototype |
| 16 | 每个 preset 的 decisions 都有效 | 遍历所有 | ruleId 格式匹配 /R\d+/ |

### listExports (2 tests)

| # | Case | Expect |
|---|------|--------|
| 17 | 无 exports 目录 | [] |
| 18 | 有 exports 文件 | 返回排序后的 .json 文件名列表 |

## 闭环测试 (2 tests)

最重要的集成验证：

| # | Case | Steps | Expect |
|---|------|-------|--------|
| 19 | 闭环：export → import 后 decisions 一致 | 导出标准 decisions → 导入（带 definitions） | 原始 decisions ≈ 导入 decisions |
| 20 | 闭环：export → save → load → import | 完整文件读写链 | 最终 decisions 正确 |
