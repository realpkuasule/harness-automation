# Worktree Delivery Safety Model

## 状态位置

- 可移植项目策略：`.harness/worktree-delivery.json`，不得包含主机绝对路径。
- 允许根、保护根、租约、事务锁和生命周期回执：解析后的 Git common dir 下 `harness/worktree-delivery/`。
- 配置计划哈希同时覆盖项目策略和 `host-binding.json`；缺失或旧式内嵌绑定时 enforced 分配 fail-closed。
- 临时 Review 回执：操作系统 state 目录。
- 凭据不进入任何上述文件。
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
- `workspace.remote-delete-disabled`

只能保留为 guidance：

- dirty 内容的业务、资产或法律价值；
- 是否继续保留长期调试环境；
- Accepted Commit 的业务验收含义；
- 内容许可证和 AI 生成资产的最终法律判断；
- 远端 branch 是否应在保留期后删除。

## Provider

无 Provider 时仍可执行本机 `status`、`audit`、`review` 和保留期审计。

GitHub Adapter 使用配置中的 repository、Project owner/number、status field 和 Done values；不得硬编码字段名。GitLab/Jira 未安装 Adapter 时必须显示 `blocked`。

批量接管必须在同一 `apply.lock` 内重采 path、branch、HEAD、index、dirty evidence/patch、租约缺失、host binding、容量和 Provider 状态。全部通过后才可写 lease；接管不得调用任何 `git worktree add/remove`、checkout 或 branch/ref 变更命令。

## CI 边界

CI 通常只能看到自身 checkout，无法观察开发机 worktree 和 Git common-dir 租约。`check --mode ci` 只验证仓库配置并把 host-local enforcement 报告为 `blocked`；真正的 workspace gate 在本机会话开始和提交前运行。
