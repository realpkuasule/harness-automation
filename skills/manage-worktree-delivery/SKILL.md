---
name: manage-worktree-delivery
description: >
  审计和治理 AI coding 项目的 Git worktree 交付生命周期。用户要求分配 Issue worktree、创建临时 Review
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
  --allow-root <worktree允许父目录的绝对路径>
```

向项目负责人展示 `planPath`、完整 `planHash`、配置模式、主机绑定中的允许根/保护根、容量和 Provider 映射。仓库配置不得写入主机绝对路径；同一个哈希计划同时覆盖仓库策略和 Git common dir 下的主机绑定。

新机器缺少主机绑定、或旧配置仍内嵌绝对路径时，enforced 分配必须停止并重新生成 configure 迁移计划。未显式提供的 portable 选项沿用现有仓库策略。

只有负责人明确批准展示过的完整哈希后才执行：

```bash
node <skill目录>/scripts/run.mjs apply \
  --project <项目绝对路径> \
  --plan <相对计划路径> \
  --approve <完整sha256>
```

“继续”“可以”不等于对尚未展示的计划哈希批准。

## 分配持久 worktree

每个工作项只能有一个持久租约。先确认工作项、branch、绝对路径和负责人，再生成计划：

```bash
node <skill目录>/scripts/run.mjs worktree allocate \
  --project <项目绝对路径> \
  --work-item <provider:repository#issue> \
  --branch <branch> \
  --path <绝对路径> \
  --owner <负责人> \
  [--thread <会话标识>] \
  [--start-point <commit>]
```

`allocate` 本身不得创建 worktree。审阅计划并按上节使用统一 `apply` 精确批准。

容量超限、重复工作项、branch 已被检出、路径不在 allowlist、路径命中保护根、Provider 不可用或观测漂移时停止。

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

需要撤销已应用 change 时使用：

```bash
node <skill目录>/scripts/run.mjs rollback \
  --project <项目绝对路径> \
  --change <receipt-id>
```

rollback 必须验证当前状态仍等于回执记录。已分配并可能承载新工作的 worktree 不通过 rollback 删除，应走新的 `close` 计划。

## 禁止事项

- 不直接运行 `git worktree add/remove` 代替本 Skill 的计划流程。
- 不运行 `rm -rf`、`git reset --hard`、`git worktree remove --force`、`git branch -D` 或 `git clean -f/-x`。
- 不用 glob、相对路径或 shell 拼接表达删除目标。
- 不自动清理 dirty、独有提交或未推送提交。
- 不自动删除远端 branch。
- 不把资产价值、法律权利或长期调试保留判断伪装成确定性检查。
