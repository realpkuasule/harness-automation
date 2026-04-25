# 07-scanner-fixtures.test.ts — 代码扫描真实性测试

**Priority**: P3
**Files under test**: `src/scanners/code_scanner.ts`, `src/scanners/integration.ts`

## Fixture Directory

```
mcp-server/src/__fixtures__/
├── typescript/
│   ├── good.ts              # 完全符合规则的代码
│   ├── console-logs.ts      # 多处 console.log
│   ├── debugger-statement.ts # debugger 语句
│   ├── magic-numbers.ts     # 魔术数字
│   └── large-file.ts        # 超过行数限制
├── python/
│   ├── good.py
│   └── console-logs.py
├── go/
│   ├── good.go
│   └── magic-numbers.go
├── java/
│   ├── good.java
│   └── debugger-statement.java
└── mixed/                   # 多语言混合项目（测试 scanAndEvaluate 集成）
    ├── package.json
    ├── src/index.ts
    └── src/utils.py
```

每个 fixture 文件不超过 80 行，保持轻量。

## Test Cases

### 真实文件扫描模式 (6 tests)

| # | Fixture | Scanner Method | 期望检出违规数 |
|---|---------|---------------|---------------|
| 1 | typescript/console-logs.ts | scanFile() | >= 1 console.log |
| 2 | typescript/debugger-statement.ts | scanFile() | >= 1 debugger |
| 3 | typescript/magic-numbers.ts | scanFile() | >= 1 magic number |
| 4 | typescript/good.ts | scanFile() | 0 违规 |
| 5 | typescript/large-file.ts | scanFile() | >= 1 (file too large) |
| 6 | python/console-logs.py | scanFile() | >= 1 print (Python 的 console.log) |

### scanDir 集成 (3 tests)

| # | Fixture | Expect |
|---|---------|--------|
| 7 | typescript/ 目录 | 扫描全部 5 个文件 |
| 8 | mixed/ 目录 | 扫描 TS + Python |
| 9 | 不存在的目录 | suggestions=[], scannedFiles=0 |

### Scan Cache (3 tests)

| # | Case | Expect |
|---|------|--------|
| 10 | 首次扫描（无缓存） | 扫描全部文件 |
| 11 | 再次扫描（有缓存） | 仅扫描变更文件（通过 mtime 判断） |
| 12 | 清空缓存后重新扫描 | 扫描全部文件 |

### scanAndEvaluate 集成 (3 tests)

使用 `mixed/` fixture 目录：

| # | Case | Expect |
|---|------|--------|
| 13 | 扫描 + 决策集成 | decisions > 0, scanSummary.filesScanned > 0 |
| 14 | useCache=true | 正常返回 |
| 15 | 含 console.log 的项目 | no-console-log 规则 confidence 被提升 |

### ClaudeExtractor (2 tests)

| # | Case | Expect |
|---|------|--------|
| 16 | 提取存在 CLAUDE.md 的项目 | extractedRules > 0 |
| 17 | 提取无 CLAUDE.md 的项目 | extractedRules = [] |
