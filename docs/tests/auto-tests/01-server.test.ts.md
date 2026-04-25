# 01-server.test.ts — MCP Server 层测试

**Priority**: P0 (核心入口，当前无覆盖)
**File under test**: `src/index.ts`
**Key technique**: MCP SDK 的 `InMemoryTransport`

## Approach

MCP SDK 提供了 `InMemoryTransport`，可以配对创建 client/server 进行测试：

```typescript
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "test", version: "1.0" });
await client.connect(clientTransport);
// server is already connected via index.ts setup
```

但更简洁的方式：直接 import server 实例后，用 `server.connect(serverTransport)` 再通过 `client.callTool()` 发送请求。

## Test Cases

### evaluate_rules (6 tests)

| # | Case | Input | Expect |
|---|------|-------|--------|
| 1.1 | 基本正常调用 + TS | phase=growth, team=medium, stack=typescript | 返回 output.decisions.length > 0, summary.total > 0 |
| 1.2 | 空 techStack | techStack=[] | decisions=[] |
| 1.3 | prototype 阶段 | phase=prototype | 平均 confidence < growth |
| 1.4 | large team | teamSize=large | 含 hook/ci 决策 |
| 1.5 | dryRun=true | dryRun=true | 返回结果但不写状态文件 |
| 1.6 | 缺失必填参数 | 传 {} | isError=true, Zod 校验错误 |

### generate_config (5 tests)

| # | Case | Setup | Expect |
|---|------|-------|--------|
| 2.1 | 已 evaluate + confirmed 状态 | 先 evaluate + confirm | files.length > 0 |
| 2.2 | 未 evaluate 直接 generate | 空状态 | isError=true |
| 2.3 | dryRun=true | evaluate 后 dryRun | 有返回但不写状态 |
| 2.4 | 自定义 decisions 覆盖 | 传 decisions 参数 | 使用传入的 decisions 而非 state |
| 2.5 | decisions 含所有 5 种 medium | 5 种 medium 各至少一个 | 所有生成器都被触发 |

### init_harness (5 tests)

| # | Case | Input | Expect |
|---|------|-------|--------|
| 3.1 | 完整流程 TS | TS 项目全参数 | files 含 CLAUDE.md, settings.json, eslint, husky, ci |
| 3.2 | dryRun | dryRun=true | 返回但不写任何文件 |
| 3.3 | Python 项目 | stack=python | 配置适配 Python 生态 |
| 3.4 | prototype 轻量 | phase=prototype | 仅 CLAUDE.md, 无 husky/ci |
| 3.5 | 已存在文件的备份 | 目标目录已有 CLAUDE.md | backupDir 不为 null |

### query_state / reset_state (3 tests)

| # | Case | Expect |
|---|------|--------|
| 4.1 | evaluate 后 query | status="evaluated" |
| 4.2 | reset 后 query | status=null |
| 4.3 | 从未 init 的目录 query | status=null |

### confirm_decisions (4 tests)

| # | Case | Expect |
|---|------|--------|
| 5.1 | evaluated → confirmed | status="confirmed", summary 正确 |
| 5.2 | 在 null 状态 confirm | isError=true |
| 5.3 | 部分 decisions（仅 ruleId+medium） | 自动 enrich 为完整 RuleDecision |
| 5.4 | confirm 后重试 confirm 同一批 | 正常通过（幂等） |

### rollback (4 tests)

| # | Case | Expect |
|---|------|--------|
| 6.1 | 无备份时 list | 空数组 |
| 6.2 | 无备份时 restore | isError=true |
| 6.3 | 有备份时 list | 返回备份列表 |
| 6.4 | 有备份时 restore | 文件恢复到备份版本 |

### validate_setup (3 tests)

| # | Case | Expect |
|---|------|--------|
| 7.1 | 完整生成后 validate | passed=true |
| 7.2 | 缺文件 validate | passed=false, findings 含 errors |
| 7.3 | skipSyntaxCheck | 跳过语法校验但仍检查存在性 |

### get_rule_stats / analyze_rule_adjustments (4 tests)

| # | Case | Expect |
|---|------|--------|
| 8.1 | 未 evaluate 时 collect | isError=true |
| 8.2 | evaluate 后 collect | summary 字段正确 |
| 8.3 | 未 collect 时 getCurrent | 正常返回 |
| 8.4 | 无数据时 analyze | isError=true |

### export_rules / import_rules (5 tests)

| # | Case | Expect |
|---|------|--------|
| 9.1 | 直接 export | 含所有 decisions |
| 9.2 | saveToFile | 文件被写入 |
| 9.3 | import exportJson | 正常导入 |
| 9.4 | import presetId | 返回预设 decisions |
| 9.5 | import 不存在的 preset | isError=true |

### list_rule_presets / list_rule_exports (3 tests)

| # | Case | Expect |
|---|------|--------|
| 10.1 | list 全部 presets | 5 个预设 |
| 10.2 | 按 techStack 过滤 | 返回匹配的预设 |
| 10.3 | 无 exports 时 list | 空数组 |

## Implementation Note

需要创建一个辅助函数 `createServerClient()` 来启动 InMemoryTransport 并返回
client/server 对。参考 MCP SDK 的测试示例：

```typescript
async function createTestHarness() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  // index.ts 中 export 一个 `async function createServer()` 即可复用
  return { client, serverTransport };
}
```

但当前 `src/index.ts` 的 server 实例是模块级变量，建议将 server 创建逻辑提取
为可导出的 `createServer()` 函数，使测试可以创建独立实例。
