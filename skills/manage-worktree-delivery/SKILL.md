---
name: manage-worktree-delivery
description: >
  审计和治理 AI coding 项目的 Git worktree 交付生命周期。用户要求分配或接管 Issue worktree、创建临时 Review
  环境、检查重复或残留 worktree、关闭已完成 worktree、检查租约/容量/漂移、审计远端分支保留期，或处理
  跨 Agent/跨会话 worktree 失控时使用。普通 Git 仓库无需 PRD 即可运行只读 status、audit 和临时 review。
---

# Manage Worktree Delivery

使用共享的 `harness-automation` CLI。Skill 只编排；Git 观测、路径保护、计划哈希、锁、漂移检查和回执由 CLI 执行。

安全模型和 enforcement 状态说明见 [safety-model.md](references/safety-model.md)。

## 开始会话

先运行只读命令：

```bash
node <skill目录>/scripts/run.mjs worktree status --project <项目绝对路径>
node <skill目录>/scripts/run.mjs worktree audit --project <项目绝对路径>
```

这两个命令必须创建零个 worktree，也不要求 `docs/PRD.md`、远端 Provider 或正式 Harness intake。

分别报告 `configured`、`loaded`、`enforced`、`passing`。Provider 不可用、租约重复或映射漂移时，不得把 `blocked` 解释为通过。

## 正式启用

未配置时，只生成配置计划：

```bash
node <skill目录>/scripts/run.mjs worktree configure \
  --project <项目绝对路径> \
  --mode enforced \
  --management-branch <管理checkout分支> \
  --allow-root <worktree允许父目录的绝对路径>
```

新项目优先使用项目容器：`<container>/main` 是唯一受保护的管理
checkout，`<container>/worktrees/<id>` 是持久 Issue checkout。容器必须已
存在且本身不是 Git 仓库；`worktrees/` 可以不存在，且只会在批准 configure
apply 时创建：

```bash
node <skill目录>/scripts/run.mjs worktree configure \
  --project <container绝对路径>/main \
  --mode enforced \
  --management-branch main \
  --topology container-v1 \
  --workspace-container <container绝对路径>
```

不要把 `--allow-root` 与容器拓扑混用。既有平铺 checkout 永不自动移动；先生成
`worktree migrate --workspace-container <绝对路径>` 预检计划。仅当负责人明确
批准完整 plan hash 后，才能使用 `worktree migrate apply --plan <相对路径>
--approve <完整sha256>` 执行。普通 `apply` 会明确拒绝迁移。首版只支持唯一
primary legacy checkout 且零 lease/worktree；中断后只能用同一计划/hash 从新
`main/` 路径续行，不会自动回滚或删除内容。

向项目负责人展示 `planPath`、完整 `planHash`、配置模式、management 分支选择器、主机绑定中的允许根/保护根、容量和 Provider 映射。仓库配置不得写入主机绝对路径；同一个哈希计划同时覆盖仓库策略和 Git common dir 下的主机绑定。缺失或歧义的 management checkout 在 enforced audit 中必须 fail closed。

新机器缺少主机绑定、或旧配置仍内嵌绝对路径时，enforced 分配必须停止并重新生成 configure 迁移计划。未显式提供的 portable 选项沿用现有仓库策略。

只有负责人明确批准展示过的完整哈希后才执行：

```bash
node <skill目录>/scripts/run.mjs apply \
  --project <项目绝对路径> \
  --plan <相对计划路径> \
  --approve <完整sha256>
```

“继续”“可以”不等于对尚未展示的计划哈希批准。

若 host binding 已通过一次人工 configure 计划启用 `delegated-ai`，不再要求用户逐次阅读机器计划或复制 hash。向用户展示简短意图卡（目的、创建/删除内容、保留内容、风险）；完整 plan 仅供审计。随后调用：

```bash
node <skill目录>/scripts/run.mjs worktree apply-ai \
  --project <项目绝对路径> \
  --plan <相对计划路径> \
  --intent <一句自然语言业务意图>
```

只有独立只读 reviewer 返回 `approve` 才会 apply。`deny`、`abstain`、超时、格式错误、越权、过期或漂移均视为未执行，不得自行回填 plan hash 绕过 reviewer。确定性路径保护、dirty/lease/容量/Provider/HEAD 检查始终优先；`close`/`recover` 还必须满足零 ignored、unique 和 unpushed 证据。`configure`、扩大委托范围和 rollback 仍需负责人一次性授权。

## 分配持久 worktree

每个工作项只能有一个持久租约。container-v1 从 work-item 的稳定 ID 自动得到
`<persistentWorktreeRoot>/<id>`；branch 仍须显式提供，并以 `/`、`.`、`_` 或 `-`
为边界包含大小写一致的 ID。legacy-flat 仍须提供绝对 `--path`：

```bash
node <skill目录>/scripts/run.mjs worktree allocate \
  --project <项目绝对路径> \
  --work-item <provider:repository#issue> \
  --branch <branch> \
  [--path <绝对路径>] \
  --owner <负责人> \
  [--thread <会话标识>] \
  [--start-point <commit>]
```

`allocate` 本身不得创建 worktree。审阅计划并按上节使用统一 `apply` 精确批准。

容量超限、重复工作项、branch 已被检出、路径不在 allowlist、路径命中保护根、Provider 不可用或观测漂移时停止。
container-v1 若显式 path 不等于派生路径会拒绝；既有/adopted/legacy-flat worktree 不移动、不改名。

## 交付前集成证据

先运行只读检查：

```bash
node <skill目录>/scripts/run.mjs worktree integration-check \
  --project <management或leased checkout> \
  --work-item <provider:repository#issue> \
  [--target <local-ref>]
```

省略 target 使用 management branch。behind 只是 warning；dirty、未解决冲突、未推送提交、预测冲突或映射漂移均为 blocked。它不 fetch、merge、rebase、checkout 或运行项目测试；真实 mergeability 只认隔离 `git merge-tree`。冲突时仅列出路径和证据，然后请求 owner 决定。

## 接管既有 worktree

配置前已经存在的持久 worktree 必须通过 manifest 批量接管，不能手写 lease：

```bash
node <skill目录>/scripts/run.mjs worktree adopt \
  --project <项目绝对路径> \
  --manifest <manifest绝对或项目相对路径>
```

manifest 使用 `worktree-adopt/1.0`，每项明确给出 `workItem`、`owner`、可选 `thread`、绝对 `path` 和当前 `branch`。`adopt` 只生成计划；负责人审阅计划中的 HEAD、dirty evidence/patch digest、Provider 状态、容量和租约哈希后，仍使用统一 `apply` 精确批准。

接管只写本次新增的本机 lease 与耐久回执。它允许 dirty worktree，因为接管是保护动作，但不改变 worktree 注册、branch、HEAD、index 或工作区文件。detached、locked、prunable、管理 checkout、保护/越界路径、重复映射和容量超限必须拒绝。批量中任一项漂移时零 lease 写入；写入中失败只补偿本次未被改变的新 lease。

## 临时 Review

Review 不创建本地 branch，使用 detached HEAD 和 OS 临时目录：

```bash
node <skill目录>/scripts/run.mjs worktree review \
  --project <项目绝对路径> \
  --commit <sha> \
  -- <review命令> [参数...]
```

命令以 argv 执行。checkout 保持 clean 时立即移除；Review 产生未提交内容时返回 `blocked` 并保留精确路径和回执。不得自行强制删除。

同一仓库一次只运行一个临时 Review。崩溃残留由 `retention-audit` 发现。

## 关闭持久 worktree

先确认负责人或 Provider 接受的 commit 等于 worktree 当前 HEAD。生成关闭计划：

```bash
node <skill目录>/scripts/run.mjs worktree close \
  --project <项目绝对路径> \
  --work-item <provider:repository#issue> \
  --accepted-commit <sha>
```

关闭计划必须拒绝 dirty worktree、Accepted Commit 不匹配、无远端引用、租约重复和任何计划后漂移。批准后仍使用统一 `apply`。

关闭只移除精确 worktree 和本机租约；保留本地 branch 和远端 branch。

## 保留期与恢复

只读检查：

```bash
node <skill目录>/scripts/run.mjs worktree retention-audit --project <项目绝对路径>
```

报告超时 Review、陈旧锁和超过保留期的远端 branch。默认永不删除远端 branch。
陈旧 lease、Review、锁或解析错误使 CLI 返回 2；只有旧 remote branch 仍返回 0。不得借此生成/apply plan、续期或删除内容。

需要撤销已应用 change 时使用：

```bash
node <skill目录>/scripts/run.mjs rollback \
  --project <项目绝对路径> \
  --change <receipt-id>
```

rollback 必须验证当前状态仍等于回执记录。已分配并可能承载新工作的 worktree 不通过 rollback 删除，应走新的 `close` 计划。
接管 rollback 只删除该接管新建且此后未被 close/heartbeat/transfer 等生命周期使用的 lease；它永不删除或重建既有 worktree。

## 禁止事项

- 不直接运行 `git worktree add/remove` 代替本 Skill 的计划流程。
- 不运行 `rm -rf`、`git reset --hard`、`git worktree remove --force`、`git branch -D` 或 `git clean -f/-x`。
- 不用 glob、相对路径或 shell 拼接表达删除目标。
- 不自动清理 dirty、独有提交或未推送提交。
- 不自动删除远端 branch。
- 不把资产价值、法律权利或长期调试保留判断伪装成确定性检查。
