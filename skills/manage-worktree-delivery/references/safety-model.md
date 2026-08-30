# Worktree Delivery Safety Model

## 状态位置

- 可移植项目策略：`.harness/worktree-delivery.json`，不得包含主机绝对路径。
- 允许根、保护根、租约、事务锁和生命周期回执：解析后的 Git common dir 下 `harness/worktree-delivery/`。
- 配置计划哈希同时覆盖项目策略和 `host-binding.json`；缺失或旧式内嵌绑定时 enforced 分配 fail-closed。
- 临时 Review 回执：操作系统 state 目录。
- 凭据不进入任何上述文件。
- 可选 `delegated-ai` 策略位于 host binding；AI decision 位于 Git common dir 的 `ai-decisions/`，绑定 plan、意图、策略、观测、模型和 TTL。模型凭据仍由已登录的 reviewer CLI 管理。
- 既有 worktree 接管 manifest 和计划不得成为第二套状态库；批准后只新增 Git common dir lease 与回执。

## 策略类型

确定性策略：

- `workspace.issue-single-persistent-lease`
- `workspace.mapping-consistency`
- `workspace.root-denylist`
- `workspace.capacity-budget`
- `workspace.lease-ttl`
- `workspace.clean-before-close`
- `workspace.unique-commits-protected`
- `workspace.done-no-persistent-worktree`
- `workspace.review-temporary-detached`
- `workspace.review-ttl`
- `workspace.zero-new-worktree-management`
- `workspace.cleanup-exact-hash`
- `workspace.cleanup-receipt`
- `workspace.remote-delete-disabled`（兼容保留的旧 ID；detail 报告当前 cleanup 模式）

交付前的 `worktree integration-check` 是只读证据：它以工具自建临时
`GIT_OBJECT_DIRECTORY` 和项目 common object directory 的 alternates 运行原生
`git merge-tree --write-tree --name-only -z`。项目 objects、refs、index、worktree
和 Git common dir 零写入；临时目录清理失败 fail closed。behind 只 warning，dirty、
unresolved conflict、unpushed、预测 conflict 和映射漂移均不得由 AI 覆盖。

只能保留为 guidance：

- dirty 内容的业务、资产或法律价值；
- 是否继续保留长期调试环境；
- Accepted Commit 的业务验收含义；
- 内容许可证和 AI 生成资产的最终法律判断；
- 无法得到确定性合并证据时是否人工保留或恢复 branch。

## 短生命周期分支

- 新配置默认 `remoteBranchDeletion: true`、陈旧功能分支审计为 1 天；存量显式值不变。
- close 不执行 merge/rebase，只接受已经发生的 merge。普通 merge 以 Accepted SHA 是当前本地/远端 management head 的祖先为证据；GitHub squash merge 绑定 exact repository、head branch/SHA、base branch 和 merged PR。实际 resolved push endpoint 必须唯一、哈希绑定且属于同一 repository，禁止 `pushurl` 或 URL rewrite 改写删除目标。
- 本地删除使用 `git update-ref -d <ref> <old-sha>`；远端观察和删除使用同一个 resolved endpoint 与 exact `--force-with-lease=<ref>:<old-sha>`。任一 ref/endpoint 漂移、远端歧义或证据不可用都在删除前 fail closed；删除结果不确定时返回 `WORKTREE_CLOSE_RECOVERY_REQUIRED`，不得伪补偿。
- `retention-audit` 永远只读并排除 management branch；1 天用于捕捉任何残留功能分支，不是合并后保留期。
- 已删除 ref 的 close 不自动 rollback，避免把未恢复远端的状态伪装成完整回滚。

## Provider

无 Provider 时仍可执行本机 `status`、`audit`、`review` 和保留期审计。

GitHub Adapter 使用配置中的 repository、Project owner/number、status field 和 Done values；不得硬编码字段名。Issue 状态走 REST；只有 ProjectV2 映射走一次批量 GraphQL，并在同一计划/漂移检查中复用观测。未配置 Project 时不得调用 GraphQL。配额耗尽必须显示 `GITHUB_GRAPHQL_RATE_LIMITED`，本地规则继续可观测，但需要 Project 证据的 mutation 仍 fail closed。GitLab/Jira 未安装 Adapter 时必须显示 `blocked`。

批量接管必须在同一 `apply.lock` 内重采 path、branch、HEAD、index、dirty evidence/patch、租约缺失、host binding、容量和 Provider 状态。全部通过后才可写 lease；接管不得调用任何 `git worktree add/remove`、checkout 或 branch/ref 变更命令。

## CI 边界

CI 通常只能看到自身 checkout，无法观察开发机 worktree 和 Git common-dir 租约。`check --mode ci` 只验证仓库配置并把 host-local enforcement 报告为 `blocked`；真正的 workspace gate 在本机会话开始和提交前运行。

## AI 委托边界

- reviewer 以无工具、无会话持久化的独立进程运行，不能写 worktree 或调用 apply；
- AI 只能在 host-local allowlist 内批准，不能覆盖 deterministic failure；
- `deny`、`abstain`、不可用、无效输出、过期和漂移全部 fail closed；
- `close`/`recover` 自动批准前必须确定性证明零 dirty、ignored、unique 和 unpushed 证据；
- `configure`、委托扩权和 rollback 不得由 AI 自我授权；
- 同一 OS 用户下的独立进程主要防误操作，不抵御恶意同权限进程；更强隔离需要受保护的本地 broker。
