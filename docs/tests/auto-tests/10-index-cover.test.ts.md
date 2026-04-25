# 10-index-cover.test.ts — 移除 index.ts 覆盖排除 + Server test helper

**Priority**: P0（配合 01-server.test.ts）

## Action Items

1. 修改 `vitest.config.ts` 中的 `coverage.exclude`，移除 `"src/index.ts"`
2. 在 `src/index.ts` 中重构 server 创建逻辑，使测试可创建独立 server 实例

## 重构方案

当前 `src/index.ts` 的 server 实例是模块级变量。建议将 server 创建提取为可导出函数：

```typescript
// 在 index.ts 末尾添加：
export async function createServer() {
  const server = new Server(
    { name: "harness-automation", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  // ... 注册 tools ...
  return server;
}

// main() 保持不变
```

然后 01-server.test.ts 可以：

```typescript
import { createServer } from "../index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

async function createTestHarness() {
  const server = await createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0" });
  await client.connect(clientTransport);
  await server.connect(serverTransport);
  return { client, server };
}
```

## vitest.config.ts 修改

```typescript
coverage: {
  exclude: [
    "src/**/*.test.ts",
    "src/generators/**",  // keep generators excluded or add tests for them
  ],
  thresholds: {
    branches: 80,
    functions: 85,
    lines: 85,
    statements: 85,
  },
},
```
