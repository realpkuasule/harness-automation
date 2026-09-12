# Worktree Governance 2.5.0 实施计划

**状态：** 已确认决策，待实现

**基线：** `v2.4.1` / `19ec9bb0db0c4799f83b4d30d1c0b12ac1cae61a`

**日期：** 2026-08-21

## 目标

在不新增第二套 worktree 管理系统的前提下，收紧新项目默认治理，降低
coding-agent 创建不可辨认、长期占用或难以集成的 persistent worktree 的概率。
实现继续复用现有 container-v1、lease、exact-hash plan、drift recheck、
delegated AI、durable receipt、close、renew、recover 和 migrate 路径。

本轮只新增一个只读的 `worktree integration-check`。它报告当前 leased
worktree 相对指定本地 target ref（省略时为 management branch）的真实
mergeability 证据，不运行 merge/rebase，不修改冲突，不 fetch，不创建 plan、
receipt、lock 或临时 worktree。合成 Git object 只能写入工具自建并最终清理的
OS 临时 object directory，项目和 Git common dir 保持零写入。

## 已确认决策

1. 新项目默认 `maxPersistentWorktrees` 从 `4` 改为 `2`。
2. 新项目默认 `leaseTtlHours` 从 `168` 改为 `72`。
3. 存量 `.harness/worktree-delivery.json` 中的显式数值原样保留；升级不得重写。
4. stale lease 只产生失败证据和续期/关闭提示，不获得删除权限。
5. Provider 已完成、Issue 已关闭或 lease 明确为 `done` 时，继续立即违反
   `workspace.done-no-persistent-worktree`；不增加 24 小时宽限。
6. work-item ID 是新 allocation 的身份签：
   - container-v1 自动得到 `<persistent-worktree-root>/<id>`；
   - branch 继续由调用方显式提供，但必须包含边界清晰、大小写一致的 ID；
   - existing、adopted 和 legacy-flat worktree 不自动重命名、移动或重建。
7. 新增只读 `worktree integration-check`，支持可选 `--target <local-ref>`，
   省略时使用 `managementBranch`；behind 只产生 warning，不阻止 `passing`，
   但 dirty、当前未解决冲突、unpushed commit、预测 merge conflict 或
   lease/worktree 映射漂移必须 blocked。
8. Harness 不执行 merge、rebase、checkout、冲突修改或所谓“自动解决冲突”。
9. 不新增 daemon、cron、launchd、邮件通知或后台清理器。
10. `delegated-ai` 的默认 operation allowlist 仍为 `allocate`、`renew`。
    `close`、`recover` 仍需显式委托，并继续要求零 dirty、ignored、unique 和
    unpushed 证据；configure、migrate、rollback 不可委托。
11. 修正 migration plan summary 仍声称 plan 不可 apply 的文档漂移。

## 明确废弃的方案

以下方案不得进入实现、文档范例或 Skill 指令：

- 跨项目共享的 `~/ai_workspaces/` 或按日期汇总的 worktree 根；
- 以日期或任务类型作为身份主键；
- `rm -rf`、`git worktree remove --force`、`git reset --hard`、
  `git clean -f/-x`、`git worktree prune` 或 `git branch -D`；
- 仅因目录年龄、最后提交时间或 TTL stale 自动删除；
- 自动 push 后销毁 worktree；
- 自动 merge、自动 rebase、自动修改冲突标记；
- 为本轮新增第二套 lease、approval、scheduler、notification 或 cleanup 状态机。

远端 branch 删除继续永久关闭。提交存在不等于内容已安全交付；close 仍要求
clean、Accepted Commit 等于 HEAD 且至少一个 remote ref 包含该 commit。

## 当前能力与复用点

- `mcp-server/src/worktree/service.ts`
  - `defaultConfig()` 是新默认值的唯一来源；
  - `workspaceStatus()` 已输出 topology、capacity、worktree、lease 和 dirty evidence；
  - `auditWorkspace()` 已实现 single lease、mapping、capacity、TTL、Done、dirty、
    unique/unpushed、protected-root 和 receipt 检查；
  - `planWorkspaceAllocation()` 已集中处理 Provider、路径、branch、容量和起点预检；
  - `planWorkspaceRenew()`、`planWorkspaceClose()`、`planWorkspaceRecover()` 已覆盖
    stale remediation 所需的全部 mutation；
  - `reviewAndApplyWorkspacePlan()` 已提供 hash-bound delegated AI，不另造审批器。
- `mcp-server/src/worktree/types.ts` 是 worktree 公共 JSON 契约的唯一类型来源。
- `mcp-server/src/cli.ts` 已有 stable JSON 输出、plan summary 和 worktree 路由。
- `mcp-server/src/index.ts` 是 MCP transport seam；CLI 仍是 portable baseline。
- `mcp-server/src/v2/policy.ts` 已有唯一的 `worktree-delivery-gate`，冲突约束扩充
  该规则，不新增重复 policy。

## 公共 CLI 契约

### Configure defaults

未配置仓库或负责人明确生成新 configure plan 时，省略相关 flag 等价于：

```bash
harness-automation worktree configure \
  --max-persistent 2 \
  --lease-ttl-hours 72
```

这些仍只是 plan 输入。configure plan 必须保持零 lifecycle 副作用，并继续由
exact plan hash 批准后 apply。读取到既有显式值时，省略 flag 必须沿用该值，
不得回落到新默认。

### Container-v1 allocation

container-v1 的推荐调用去掉 `--path`：

```bash
harness-automation worktree allocate \
  --project <container>/main \
  --work-item github:owner/repository#113 \
  --branch codex/113-owner-observation \
  --owner PM
```

planner 从 host binding 的 `persistentWorktreeRoot` 和 work-item ID `113` 得到：

```text
<container>/worktrees/113
```

规则如下：

- GitHub work item 使用最后一个 `#` 后的 Issue ID；
- 其他 portable work item 使用最后一个 `#` 或 `:` 后的 ID；
- ID 必须匹配 `[A-Za-z0-9][A-Za-z0-9._-]*`，且不得为 `.` 或 `..`；
- 派生后仍执行现有 canonical path、symlink、direct-child、allowed-root、
  protected-root 和 existing/non-empty 检查；
- branch 中 ID 必须是完整 segment，左右边界只能是字符串边界或 `/._-`；
- branch ID 匹配大小写敏感，避免一个 work item 出现多个视觉近似身份。

container-v1 若仍传 `--path`，只在其 canonical path 精确等于派生路径时接受；
不相等时报错，不静默改写。legacy-flat 没有可派生的 persistent root，继续要求
显式绝对 `--path`。adopt 继续按 manifest 接受 existing path/branch，只做现有
安全检查，不因旧命名拒绝或重命名。

### Read-only integration check

新增：

```bash
harness-automation worktree integration-check \
  --project <management-or-leased-checkout> \
  --work-item <provider:work-item> \
  --target main
```

它只接受恰好一个已有 lease。`--target` 必须解析为本仓库的 local ref；省略时
使用配置的 `managementBranch`。不增加 `--strategy`、`--rebase` 或尾随任意
命令，避免命令变成另一个 merge/CI 执行器。

检查步骤：

1. 解析 repository root、Git common-dir、host binding、配置和全部 worktree。
2. 精确找到 work item 的单一 lease 及其单一 registered worktree。
3. 复核 path、branch、top-level、bare/detached/locked/prunable 状态。
4. 将 leased worktree HEAD 记为 `sourceHead`，将显式 target 或 management
   branch 解析为 `targetHead`，并读取 merge-base。
5. 用只读 `rev-list` 计算 source 相对 target 的 `ahead`、`behind`，并计算
   source 的 `unpushedCommits`。
6. 从现有 porcelain/dirty evidence 提取未解决状态：`DD`、`AU`、`UD`、`UA`、
   `DU`、`AA`、`UU`。
7. 在 OS 临时根下创建工具独占的 object directory，以项目 canonical common
   object directory 作为 `GIT_ALTERNATE_OBJECT_DIRECTORIES`，并将临时目录设为
   `GIT_OBJECT_DIRECTORY`。
8. 以 argv 执行
   `git merge-tree --write-tree --name-only -z <targetHead> <sourceHead>`。退出码
   `0` 表示 mergeable，`1` 表示存在预测冲突；解析 NUL-delimited
   `conflictingPaths`。其他退出码或 spawn error 保留 Git stderr/stdout 诊断并
   fail closed。
9. 在 `finally` 精确删除本次创建的临时根；清理失败必须作为失败诊断返回，
   不能把遗留目录伪装成成功。
10. 输出 canonical JSON，不在项目或 Git common dir 落盘。

这个隔离使 `merge-tree` 生成的 tree/blob 只进入临时 object directory；项目
object database、refs、index 和 worktree 均不改变。changed-path overlap 可在
未来作为附加 warning，但本轮不实现，也绝不能替代原生 merge-tree 结果。

建议输出契约：

```ts
interface WorkspaceIntegrationCheck {
  schemaVersion: "worktree-integration-check/1.0";
  projectDir: string;
  commonDir: string;
  workItem: string;
  workItemId: string;
  source: {
    path: string;
    branch: string;
    head: string;
    unpushedCommits: number;
  };
  target: {
    ref: string;
    head: string;
    source: "explicit-local-ref" | "management-branch";
  };
  mergeBase: string;
  ahead: number;
  behind: number;
  clean: boolean;
  currentConflicts: Array<{ path: string; status: string }>;
  mergeable: boolean;
  conflictingPaths: string[];
  blockers: Array<{
    code: "WORKTREE_INTEGRATION_DIRTY" | "WORKTREE_INTEGRATION_CONFLICTED" |
      "WORKTREE_INTEGRATION_UNPUSHED" | "WORKTREE_INTEGRATION_MERGE_CONFLICT";
    detail: string;
  }>;
  warnings: Array<{
    code: "WORKTREE_INTEGRATION_BEHIND";
    detail: string;
  }>;
  status: "ready" | "warning" | "blocked";
  passing: boolean;
  observedHash: string;
}
```

语义：

- `behind > 0`：`status: "warning"`，`passing: true`；
- dirty 但无 unresolved conflict：blocked，因为 HEAD 不能代表全部待交付内容；
- unresolved conflict、`unpushedCommits > 0`、`mergeable: false` 或
  `conflictingPaths` 非空：blocked；
- lease/path/branch/top-level/target 漂移或 merge-tree 证据不可得：命令
  fail closed；
- target 明确是 local ref；命令不评价远端新鲜度，也绝不 fetch。

CLI 对 `ready` 和 `warning` 返回 `0`，对正常完成检查但得到 `blocked` 返回 `2`；
Git 执行、target 解析或临时目录清理失败走现有错误通道并保留诊断。

MCP 增加等价的 `harness_worktree_integration_check`，只接收 `projectDir` 和
`workItem` 及可选 `target`，直接调用同一 service 函数，不复制逻辑。

## Retention audit 语义

`retention-audit` 保持完全只读。CLI 在以下任一情况存在时返回退出码 `2`：

- `staleReviews.length > 0`；
- `staleLeases.length > 0`；
- `staleLocks.length > 0`；
- `errors.length > 0`。

仅有超过保留期的 `remoteBranches` 仍返回 `0`，因为 remote deletion 被禁用，
这些只是人工保留决策证据。stale lease 的后续动作只能是：

- 工作仍活跃：生成 `renew` plan；
- 工作完成且满足 close 前置条件：生成 `close` plan；
- dirty、unique、unpushed 或 Provider 证据不足：停止并报告。

retention audit 不自动生成或 apply plan，不修改 lease `status`，不删除目录。

## Agent 与 AI 审批边界

扩充现有 `worktree-delivery-gate` 和 `manage-worktree-delivery` Skill：

- 实现或交付前运行 host-local audit；交付前运行 `integration-check`；
- behind 只解释为 warning；真实 mergeability 只认隔离执行的 `merge-tree`；
- 发现 unresolved 或预测 conflict 时，Agent 可以只读列出路径、status、
  source/target HEAD 和双方差异，随后停止并请求 owner 决定；
- Agent 不得把“帮我看看冲突”解释为 merge/rebase/checkout/reset 授权；
- delegated AI reviewer 只判断 plain-language intent 是否匹配 exact plan，不能
  覆盖 deterministic check，也不能修改任何 Git 状态；
- 默认委托集合仍为 `allocate`、`renew`，升级不得扩大现有 host binding 权限。

## 错误码与 warning code

复用现有错误码：

- `WORKTREE_LEASE_NOT_FOUND`
- `DUPLICATE_WORK_ITEM_LEASE`
- `WORKTREE_NOT_FOUND`
- `WORKTREE_MANAGEMENT_BRANCH_REQUIRED`
- `WORKTREE_MANAGEMENT_CHECKOUT_INVALID`
- `WORKTREE_PATH_EXISTS`
- `PROTECTED_WORKTREE_PATH`
- `WORKTREE_CAPACITY_EXCEEDED`

新增最小错误码：

| Code | 条件 |
|---|---|
| `WORK_ITEM_ID_INVALID` | work item 无法得到安全的单一 ID |
| `WORKTREE_BRANCH_ID_REQUIRED` | 新 allocation branch 未包含边界清晰 ID |
| `WORKTREE_PATH_ID_MISMATCH` | container-v1 显式 path 不等于派生 path |
| `WORKTREE_INTEGRATION_PRECONDITION_FAILED` | source/target/top-level/registration 状态不满足只读检查 |
| `WORKTREE_INTEGRATION_DIRTY` | source 含未提交且非冲突内容；结构化 blocker |
| `WORKTREE_INTEGRATION_CONFLICTED` | source index 含 unresolved entries；结构化 blocker |
| `WORKTREE_INTEGRATION_UNPUSHED` | source 含未推送 commit |
| `WORKTREE_INTEGRATION_TARGET_UNAVAILABLE` | target local ref 或 merge-base 不可解析 |
| `WORKTREE_INTEGRATION_MERGE_CONFLICT` | 隔离 merge-tree 预测到冲突；结构化 blocker |
| `WORKTREE_INTEGRATION_GIT_FAILED` | merge-tree spawn 或非 0/1 退出失败，附 Git 诊断 |
| `WORKTREE_INTEGRATION_TEMP_CLEANUP_FAILED` | 工具自建临时 object directory 未能精确清理 |

behind 是结构化 warning，不使用异常，也不使 `passing` 变为 false。

## 零副作用合同

下列命令必须保持项目目录和 Git common dir 零写入，不创建项目内目录、branch、
worktree、lease、plan、receipt、lock、Git object 或 Git commit：

- `worktree status`
- `worktree audit`
- `worktree retention-audit`
- `worktree integration-check`

`integration-check` 使用 `--no-optional-locks` 或等价的 `GIT_OPTIONAL_LOCKS=0`。
唯一允许的临时写入是本次命令以 `mkdtemp` 创建的 OS 临时根及其
`GIT_OBJECT_DIRECTORY`；项目 common object directory 只能作为 alternates
读取。不得执行 shell 拼接、fetch、merge、rebase、checkout、update-index、
worktree add/remove 或项目测试命令。临时根必须在 `finally` 精确清理；清理
失败使命令失败并保留可诊断路径。

allocation planning 仍只允许写现有 immutable `.harness/plans/` artifact；不得
创建派生 path、branch、lease 或 receipt。只有 exact-hash apply 或有效的
delegated-AI authorization 才能进入现有 allocation transaction。

## 具体文件计划

### Runtime 与 transport

- `mcp-server/src/worktree/types.ts`
  - 增加 `WorkspaceIntegrationCheck`；
  - 不修改 `WorkspacePlan`、`WorkspaceReceipt`、`WorkspaceLease` schemaVersion。
- `mcp-server/src/worktree/service.ts`
  - 修改新配置默认值；
  - 增加一个 work-item ID 解析 helper 和 branch segment 检查；
  - 在现有 allocation planner 中派生 container-v1 path；
  - 增加 `integrationCheckWorkspace()`，复用现有 spawn/Git 诊断并隔离
    merge-tree object writes 到工具自建 OS 临时目录；
  - 不新增 lifecycle operation 或 apply 分支。
- `mcp-server/src/cli.ts`
  - 路由 `worktree integration-check [--target <local-ref>]`；
  - container-v1 allocation 允许省略 `--path`，legacy-flat 仍要求；
  - retention-audit 对 stale lease/error 返回 2；
  - 修正 migrate summary 为“plan-only；仅显式 migrate apply 可执行”。
- `mcp-server/src/index.ts`
  - 暴露与 CLI 同 service 的 MCP read-only tool。

### Policy、Skill 与文档

- `mcp-server/src/v2/policy.ts`
  - 扩充现有 `worktree-delivery-gate`，不新增重复 rule ID。
- `docs/design/worktree-delivery.md`
- `docs/reference/worktree-delivery.md`
- `README.md`
- `skills/manage-worktree-delivery/SKILL.md`
- `skills/manage-worktree-delivery/references/safety-model.md`
  - 同步默认值、identity、integration-check、冲突只读边界和废弃方案。
- `docs/api/worktree-delivery-v1.schema.json`
  - 仅在当前 schema 已声明 defaults/descriptions 时同步说明；字段形状不变。
- `CHANGELOG.jsonl`
  - 实施完成后用仓库脚本追加一条关联实际 GitHub Issue 的记录；本计划阶段不创建
    Issue、不写 changelog。

### Tests

- `mcp-server/src/worktree/service.test.ts`
- `mcp-server/src/v2/cli.test.ts`
- `mcp-server/src/v2/service.test.ts`
- `mcp-server/src/index.test.ts`

不引入新依赖、daemon package、scheduler 配置或 GitHub repository settings。

## 测试矩阵

| 场景 | 预期 |
|---|---|
| 未配置仓库 | status 显示 persistent `2`、lease TTL `72h` |
| 存量显式 `4/168` | configure 省略 flags 时仍生成 `4/168`，文件不被升级重写 |
| 默认容量 | 前两个 allocation plan 可生成，第三个 `WORKTREE_CAPACITY_EXCEEDED` |
| 显式提高容量 | 保持现有可配置行为，不受默认 2 限制 |
| GitHub ID | `#113` 派生 `<root>/113`，plan 阶段目录不存在 |
| portable ID | 最后一个 `#`/`:` 后安全 ID 可派生；空、穿越、分隔符 ID 拒绝 |
| branch ID | `codex/113-slug` 通过，`codex/2113-slug` 对 ID `113` 拒绝 |
| 显式 container path | 精确等于派生值通过；其他路径 `WORKTREE_PATH_ID_MISMATCH` |
| legacy-flat allocation | 仍要求显式绝对 path，不自动移动 |
| existing/adopted old name | audit/adopt 不重命名、不拒绝、不写 worktree 内容 |
| integration 默认 target | 省略 `--target` 时精确使用 configured management branch |
| integration 显式 target | `--target main` 解析为 local ref 并绑定 target HEAD |
| integration clean/mergeable | `mergeable: true`、`ready`、passing，项目零写入 |
| integration behind | warning、passing；HEAD/index/refs/项目 object count 不变 |
| integration 预测冲突 | `mergeable: false`、精确 `conflictingPaths`、blocked、exit `2` |
| integration dirty | blocked，报告 dirty evidence，项目零写入 |
| integration unresolved | blocked，返回精确 current conflict paths/status，项目零写入 |
| integration unpushed | `unpushedCommits > 0`、blocked、exit `2` |
| integration merge-tree 失败 | fail closed，保留 Git exit/spawn/stdout/stderr 诊断 |
| integration temp cleanup 失败 | fail closed，返回精确临时路径和 cleanup 诊断 |
| missing/duplicate lease | fail closed |
| detached/locked/prunable/mapping drift | fail closed |
| management branch missing/ambiguous | 省略 target 时 fail closed；显式有效 target 不依赖 checkout 猜测 |
| remote 状态 | 不评价、不 fetch，不影响 local target 的结论 |
| retention stale lease | JSON 含 stale lease，CLI exit `2`，零 lease/worktree/ref 写入 |
| retention malformed receipt | errors 非空，CLI exit `2` |
| retention old remote branch only | 仍 exit `0`，不删除 remote ref |
| Provider Done | audit 立即失败 done-no-persistent-worktree；不自动 close |
| renew stale lease | exact-hash/AI apply 只改 heartbeat，HEAD/index/dirty/branch 不变 |
| delegated AI defaults | 仍只有 allocate/renew；升级不扩权 |
| destructive AI | dirty/ignored/unique/unpushed close/recover 继续 deny |
| migration plan summary | 明确 plan-only 且仅 migrate apply 可执行，不再说不可 apply |
| CLI/MCP parity | 两个 transport 返回同一 integration-check 结构与 observedHash |

零副作用测试在命令前后比较：

- `git worktree list --porcelain`；
- `git for-each-ref`；
- target HEAD、index hash、dirty evidence/patch；
- lease、receipt、plan、lock 文件集合及 SHA-256；
- Git object count；
- container/worktree target 的存在性。

测试还必须把工具临时根定向到 fixture 专属 OS temp parent，断言成功、blocked、
merge-tree 失败各路径结束后均无残留目录；cleanup failure 通过受控故障注入验证
错误诊断。项目 common object count 在所有路径前后相同，证明合成 object 从未
写入项目 object database。

## 实施顺序

1. 创建或确认实际 GitHub Issue，并按仓库流程设为 In Progress；本计划落盘阶段
   明确不执行该外部写入。
2. 先补 RED tests：默认值、ID/path/branch、integration-check、retention exit、
   migrate summary。
3. 在 `types.ts` 和 `service.ts` 完成最小 service 实现；不碰 apply transaction。
4. 接入 CLI 与 MCP；验证 read-only 路径不调用 plan/save/lock/mutation helper。
5. 更新唯一 delivery policy、Skill 和文档，删除与确认决策冲突的旧范例。
6. 运行 targeted tests，再运行完整 test、lint、build 和 prepublish validation。
7. 记录 changelog、提交独立 Conventional Commit，并准备 2.5.0 release commit/tag。

## 兼容性与弃用

- 版本继续读取 `worktree-delivery/1.0` config、plan、lease 和 receipt。
- 新默认只影响没有显式配置的新项目；不提供自动 config migration。
- existing lease、branch、path 和 legacy-flat checkout 不移动、不重命名。
- container-v1 新 allocation 的非 ID path 在 2.5.0 起 fail closed；release note 必须
  明确这是新 allocation contract，不能伪装成无影响修复。
- legacy-flat 的 `--path` 不弃用。
- integration-check 是新增只读输出；现有 status/audit JSON 字段不删除。
- retention-audit 对 stale lease/error 新增非零退出码可能影响脚本，必须进入
  release note。
- `--max-persistent > 2` 仍受支持；默认 2 不是全局硬上限。
- 72h stale 不是删除或 close 授权。
- 日期命名、共享目录、force cleanup、auto push/destroy、auto merge/rebase 被明确
  标为不支持，不提供兼容 shim。

## 验证与发布边界

实施完成后至少运行：

```bash
cd mcp-server
npm test
npm run lint
npm run build
npm run prepublishOnly
```

发布版本为 `2.5.0`。发布必须遵守：

1. 所有 prepublish validation 完成并成功后，才向用户索取 npm OTP；
2. OTP 到达后立即 publish，不在 OTP 有效期内重新跑验证；
3. registry 验证成功后再确认 release commit、annotated `v2.5.0` tag 和 push；
4. 最后运行 `skill-sync`，在 m2、m4、mbp 上全局安装/更新并分别验证
   harness-automation、Codex、Claude Code、DSH；
5. 任一 host 失败时只生成失败报告，不自动重试、回滚 npm publish 或跳过该 host；
6. 不对任何现有项目自动 configure、migrate、allocate、close、recover 或重命名。

## 完成定义

- 已确认的默认值、identity、只读 integration-check 和 retention exit 语义全部由
  自动化测试证明；
- exact-hash、fail-closed、single lease、container-v1、protected-root、
  delegated-AI 和 durable-receipt 不变量未降低；
- 没有新增 daemon、依赖、清理器、merge/rebase executor 或第二套状态库；
- 文档不再推荐共享目录、日期主键、force cleanup 或自动 push/destroy；
- migration summary 与当前显式 executor 一致；
- 完整 test、lint、build、prepublishOnly 通过后才进入 2.5.0 发布。
