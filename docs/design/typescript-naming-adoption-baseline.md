# TypeScript naming adoption baseline

## 状态与范围

- Issue：`realpkuasule/harness-automation#68`
- 状态：修订待 owner 批准；批准后重新执行 Harness intake
- 目标：先消除 TypeScript naming verifier 的分类误报，再仅为确认的真实历史债务提供 owner-approved fingerprint baseline/ratchet

本设计只处理 `typescript-naming` 的受控存量接管，不建立通用 baseline 或迁移框架，不修改 #67 的 npm worktree 功能范围，也不通过关闭 gate、扩大 ignore、跳过 post-apply 验证、增加通用 waiver 或批量重命名合法标识符解除自举阻塞。

## 复核结论

### 共同执行路径

```text
CLI/MCP intake
      |
 intakeProject + explicit naming adoption snapshot
      |
CLI/MCP plan
      |
  planProject + baseline transition
      |
ChangePlan + intake/source/operation hashes + exact planHash
      |
  applyPlan pre-apply fingerprint validation
      |
atomic writes -> checkProject -> shared checkTypeScript
      |                         |
   receipt                  failure -> rollback
```

- CLI 与 MCP 已共享 service 层，必须继续复用同一 `intakeProject`、`planProject`、`applyPlan` 和 `checkProject`。
- `applyPlan` 写入计划目标后调用 `checkProject`，失败时恢复原文件；该 post-apply 验证和 rollback 是正确的安全边界，不能移除。
- 自举死锁的共同根因是 `checkTypeScript` 对合法标识符误报，以及现有 baseline 只有易漂移的诊断字符串，没有 rule ID、稳定指纹、旧状态比较或 fresh intake 门禁。
- `migrationRequired` 仍只是 policy 元数据；本修复不增加通用迁移执行器，而是在既有 intake/plan/apply 事务中实现 `typescript-naming` 的最小 adoption transition。

### 60 条报告的语义分类

| 类别 | 数量 | 合法语义 | verifier 约束 |
| --- | ---: | --- | --- |
| UPPER_SNAKE_CASE import | 25 | 导入的模块常量保留其导出名称 | import binding 允许 UPPER_SNAKE_CASE；普通变量只有模块级 `const` 才允许 |
| `__dirname` / `__filename` | 8 | Node 约定标识符 | 只允许这两个精确名称，不开放任意双下划线名称 |
| 参数 `_` | 2 | 未使用的位置占位参数 | 只允许参数名精确为 `_`，不允许同名变量、成员或任意 underscore waiver |
| PascalCase Zod schema | 22 | 导出的运行时 schema/type companion | 只允许模块级导出、以 `Schema` 结尾且初始化调用链根为 `z.*` 的 schema 常量 |
| `static readonly` 常量 | 3 | 类级不可变常量 | 只有同时为 `static` 和 `readonly` 的 property 才允许 UPPER_SNAKE_CASE |
| 其他 | 0 | — | — |

修正这五类分类后，原 60 条全部归零。按原政策继续只允许模块级 `const` 使用 UPPER_SNAKE_CASE，严格扫描另发现 4 条真实历史 naming debt：`mcp-server/src/__tests__/integration.test.ts` 的 `TS_INPUT`、`PY_INPUT`、`GO_INPUT`，以及 `mcp-server/src/validators/setup_validator.ts` 的 `NON_RULE_KEYS`。原 60 条不得进入新 baseline；这 4 条只能通过下述 adoption 流程采纳。

## 稳定违规身份

### 数据合同

不建立通用 baseline registry，只增加 `typescript-naming` 专用合同：

```ts
interface TypeScriptNamingAdoption {
  ruleId: "typescript-naming";
  fingerprints: string[];
}

interface Intake {
  // existing fields unchanged
  typescriptNamingAdoption?: TypeScriptNamingAdoption;
}

interface TypeScriptNamingBaseline extends TypeScriptNamingAdoption {
  approvedIntakeHash: string;
}

interface PolicyDocument {
  // existing fields unchanged
  typescriptNamingBaseline?: TypeScriptNamingBaseline;
}
```

TypeScript stack 的新计划应写出 baseline 状态，即使 `fingerprints` 为空，以保留最近一次已消费的 intake hash，避免后来把空状态误当成首次采纳。

### 指纹算法

每个真实违规先形成规范身份：

```text
typescript-naming\0<POSIX 仓库相对路径>\0<identifier role>\0<identifier name>
```

再计算该字符串的 SHA-256，得到 64 位小写十六进制 fingerprint。约束如下：

- rule ID 同时存在于 baseline 对象和哈希输入中，不能把其他规则的 fingerprint 混入。
- 路径统一为仓库相对 POSIX 形式；路径、名称或标识符角色变化会产生新 fingerprint。
- 行号、空白、注释、格式和诊断文案不进入 fingerprint；插入合法行或修改提示文本不会使同一债务漂移。
- `fingerprints` 排序以保证计划确定性，但保留重复值；匹配必须按计数消费，禁止用 `Set` 合并重复违规。
- parse error 不形成 fingerprint，始终作为不可采纳的独立失败。
- 人类可读的路径、行号和诊断可写入 plan warnings/输出供 owner 审阅，但不作为运行时身份。

## 合法命名语义

共享 AST verifier 必须在同一遍扫描中实现：

1. 变量默认 camelCase；UPPER_SNAKE_CASE 仅允许模块级 `const`，PascalCase 仅保留现有 React function/component 语义和受限 Zod schema 语义。
2. import local binding 允许 camelCase、PascalCase 或 UPPER_SNAKE_CASE。
3. 参数默认 camelCase，额外只允许精确占位符 `_`。
4. 变量额外只允许精确的 Node 约定名 `__dirname` 和 `__filename`。
5. class property 默认 camelCase；UPPER_SNAKE_CASE 仅允许 `static && readonly`。
6. 类、interface、type、enum 继续要求 PascalCase；真实 snake_case 等违规继续失败。

policy 的自然语言 statement、valid/invalid examples 和 verifier 测试必须与这些语义一致，不能让文档仍声称 UPPER_SNAKE_CASE “仅限模块常量”而实现额外放行未记录的例外。

## Adoption 与 ratchet

### 显式 owner gates

真实债务的首次采纳或扩张需要两个显式请求：

```text
CLI intake: harness-automation intake ... --approve-sources --approve-typescript-naming-adoption
MCP intake:  harness_intake { ..., approveSources: true, approveTypeScriptNamingAdoption: true }

CLI plan:   harness-automation plan ... --adopt-typescript-naming
MCP plan:   harness_plan { ..., adoptTypeScriptNaming: true }
```

- intake 请求由共享 verifier 捕获当时的真实 fingerprint 多重集，并写入 `.harness/intake.json`；无显式请求时不产生 adoption 授权。
- plan 请求只能消费当前 intake 中相同 rule ID 的已批准 fingerprints，不能在 plan 阶段自行扩大 intake snapshot。
- baseline 内容随 policy operation 进入 operation hash 和最终 `planHash`；owner 必须审阅新增 fingerprint 的人类可读诊断和完整新 hash。
- apply 仍只接受现有 `--approve <full-plan-hash>`；旧 hash、截断 hash 或批准其他计划不得复用。

### 状态转换

所有集合运算均为保留重复计数的多重集运算。

| 当前状态 | 请求 | 目标 baseline | 结果 |
| --- | --- | --- | --- |
| 无既有 policy/baseline | 无 adoption | 空；真实违规仍由 check 拒绝 | 默认严格 |
| 无既有 baseline | explicit adoption intake + adoption plan | 当前 observed | 允许首次采纳 |
| 有既有 baseline | 普通 plan | `old ∩ observed` | 相同或单向收缩 |
| 有既有 baseline | adoption plan，无新增 fingerprint | `old ∩ observed` | 允许收缩，不构成 weakening |
| 有既有 baseline | adoption plan，有新增 fingerprint | 当前 observed | 仅 fresh explicit adoption intake 可授权 |
| 有既有 baseline | 删除旧项并加入新项 | 当前 observed | 视为 replacement；按扩张门禁处理 |

扩张或替换必须同时满足：

1. 当前 intake 明确包含 `typescriptNamingAdoption`，rule ID 精确为 `typescript-naming`。
2. 每个新增 fingerprint 均在该 intake snapshot 中，且现场仍观察到相同 fingerprint 和数量。
3. 当前 intake file hash 不等于旧 baseline 的 `approvedIntakeHash`；同一个旧 intake 不能在 baseline 收缩后再次授权恢复旧债务。
4. plan 显式请求 adoption，完整 transition 和 diagnostics 进入 immutable plan。
5. owner 精确批准该计划的新完整 `planHash`。

任一条件不满足时在 plan 或 apply 阶段拒绝。普通 plan 不得静默把新违规加入 baseline。

### 收缩与防重引入

- 修复已采纳违规后，日常 check 继续通过。
- 下一次普通 plan 自动生成 `old ∩ observed`，从目标 policy 移除已消失 fingerprint。
- apply 前若现场重新出现已从目标 baseline 移除的违规，现场复核拒绝计划；apply 后若发生不一致，post-apply check 失败并由原事务回滚。
- 收缩计划应用后，旧 fingerprint 不再受 baseline 保护；要重新加入只能作为 weakening 重新走 fresh explicit adoption intake 和新完整 hash 批准。

### Apply 前后验证

在现有 file-plan apply 路径中增加一次 TypeScript baseline transition validator，不建立新 apply 命令：

1. 先执行现有 `validatePlan`，验证 plan tamper、exact approval、project、intake、discovery 和 source hashes。
2. 从当前 policy 与计划中的目标 policy 读取 baseline，验证固定 rule ID、fingerprint 格式、排序/重复计数和 `approvedIntakeHash === plan.intakeHash`。
3. 重新扫描现场；parse error 立即失败。
4. 比较旧、目标、intake adoption 与现场多重集，执行上述扩张/收缩门禁；目标 baseline 不得包含现场不存在的未来 fingerprint。
5. 通过后继续现有 atomic writes。
6. 写入后继续调用共享 `checkProject -> checkTypeScript`；任何失败继续执行现有 reverse-order rollback。

旧的诊断字符串数组不含 rule ID 或 intake hash，不能继续作为授权。它只可在新计划中收缩为严格空 fingerprint baseline；若新目标非空，必须按首次 adoption 走 fresh explicit intake 和新 hash。

## 最少改动文件

| 文件 | 必要改动 |
| --- | --- |
| `mcp-server/src/v2/types.ts` | 增加专用 intake adoption 与 typed policy baseline 合同 |
| `mcp-server/src/v2/verifier.ts` | 修正五类误报，输出稳定 fingerprint，并按多重集精确过滤 |
| `mcp-server/src/v2/policy.ts` | 让 naming statement/examples 与合法语义一致 |
| `mcp-server/src/v2/service.ts` | intake snapshot、plan transition、apply 前现场复核，以及 check 复用 |
| `mcp-server/src/cli.ts` | 将 intake/plan 两个显式 flag 映射到共享 service |
| `mcp-server/src/index.ts` | 将 MCP intake/plan 两个 boolean 映射到同一 service |
| `mcp-server/src/v2/verifier.test.ts` | 五类合法语义、真实反例、稳定 fingerprint 与重复计数 |
| `mcp-server/src/v2/service.test.ts` | adoption、扩张门禁、收缩、防重引入、parse error、rollback 和 clean repo |
| CLI/MCP schema tests | 验证显式 intake/plan 参数，不复制 baseline 逻辑 |
| `README.md`、`skill/SKILL.md` | 说明 fresh intake、exact hash、默认严格和单向收缩 |
| `CHANGELOG.jsonl` | 关联 #68 记录根因修复 |

不修改依赖清单、lockfile、CI、`mcp-server/src/worktree/**`、npm release eval contract、通用 fs/hash helper 或 rollback 事务模型；不手工编辑 `.harness/generated/**`、`.harness/policy.yaml` 或 manifest。

## 回归测试与验收

### Verifier tests

1. UPPER import、精确 Node 标识符、参数 `_`、受限 Zod schema 和 `static readonly` 常量均不报告 violation。
2. function/local UPPER、`let` UPPER、普通 PascalCase 值、非 readonly static UPPER、其他双下划线名和 snake_case 继续失败。
3. 同一真实违规前插合法空行、注释或格式化后 fingerprint 不变；名称、路径或角色变化后 fingerprint 改变。
4. 相同 fingerprint 重复两次时 baseline 中一个实例只能放行一个，另一个仍失败。
5. invalid naming self-test 仍证明 verifier `enforced`；parse error 不可被 baseline 过滤。

### Service lifecycle tests

1. 干净仓库无 adoption 即可 plan/apply/check，行为保持零容忍。
2. 有真实历史违规但无 explicit adoption intake 时，adoption plan 被拒绝或 apply 保持失败并不留下半成品。
3. explicit adoption intake + adoption plan 生成 rule-bound fingerprints；错误 full hash 被拒绝，正确 hash apply 后旧违规暂时允许。
4. 新增、改变、移动或增加重复违规导致 check 失败。
5. 同一旧 intake 不能扩张或替换 baseline；fresh explicit adoption intake + 新 immutable plan + 新 exact hash 才能授权。
6. 修复旧违规后普通 plan 自动收缩，apply 成功；随后重新引入已移除 fingerprint 会失败。
7. apply 前现场 fingerprint 与计划不一致时在写入前失败；post-apply 异常仍按现有路径完整 rollback。
8. legacy string baseline 不能授权非空新 baseline；原 60 条误报在本仓库的新 policy 中归零，新 baseline 只包含显式 intake 批准的 4 条真实历史债务。

### 项目级证据

```bash
cd mcp-server
npx vitest run src/v2/verifier.test.ts src/v2/service.test.ts
npm test
npm run lint
npm run build
npm run prepublishOnly
```

随后必须使用通过验证的本地构建完成一次真实自举闭环：

1. owner 批准更新后的 PRD、设计、调研和 EDD source set。
2. 使用 `--approve-typescript-naming-adoption` 重新 intake，再 discover；本仓库严格扫描应只有 4 条真实 naming debt，intake 不得包含原 60 条误报。
3. 使用真实 `custom + typescript + eval-driven-development` 生成新 immutable plan。
4. 展示完整新计划哈希并等待 owner 精确批准；不得复用 `b4d05857b22cbf70a01ff228e90e7a3f7a25f90fb8d8ec6d40cd268c3ed927c1` 或此前计划哈希。
5. apply 后运行 session/CI check 与 drift；known-bad negative control 必须以合同规定退出码被拒绝，`passing` 与 `enforced` 分别报告。

## #67 重跑顺序

1. 完成 #68 根因修复、全部测试和上述自举闭环。
2. 确认新的 generated policy 不包含原 60 条误报，只精确包含已批准的 4 条真实历史债务 fingerprint。
3. 重新生成“npm 发布不得创建 worktree”的 Harness 计划并取得新的完整 hash 批准。
4. 应用后运行 EDD positive/known-bad controls、完整项目验证和 drift。
5. 证明 npm 发布路径没有调用 worktree create/allocate/adopt，且实施前后的 `git worktree list --porcelain` 路径集合不增加。
