# 会话交接协议（session handoff）

> 设计依据：`docs/designs/session-handoff.md`（v0.3）。本节对应 P1：harness CLI `session`
> 命令组（人工触发，无插件）。P2/P3（宿主观测插件、看板闭环）不在本 Skill 范围内。

## 定位与分工

- 唯一跨会话状态源：GitHub Issue + Project 看板 + git 产物 + harness 回执。AI 自然语言摘要不是状态事实。
- `manage-worktree-delivery` 管 issue ↔ worktree 租约；`session` 命令组管 issue ↔ session 生命周期。
  两者通过同一 `provider:repository#issue` 对齐，session 命令不重复实现任何 git / worktree / 租约逻辑。
- 触发者是 agent 或人（决定跑 CLI）；宿主自动触发属于 P2 插件，不是本 Skill 的职责。

## Issue 状态机（§4）

```
backlog ──(工作项被认领：worktree 租约存在 + seed 已生成)──▶ in-progress
in-progress ──(继续开发交接：文档 + 校验 + 回执)──▶ in-progress
in-progress ──(显式交付评审：文档 + 校验 + 回执)──▶ ready-for-review
ready-for-review ──(accepted-commit 存在)──▶ done
任意状态 ──(仅人可操作)──▶ backlog（reopen）
```

- 任何自动流转都必须携带证据（commit sha / 回执 id / 检查结果），证据缺失即拒绝流转。
- `status` / `handoff-doc` 写在 GitHub Project 看板字段；`receipts` 以 issue 评论（JSON 回执 id 列表）追加。
- P1 的默认 handoff 保持 `in-progress`；只有明确传入 `--to-status ready-for-review` 的交付评审才流转。其余流转不在此命令组内。

## 命令（§6）

```bash
# 交接：两阶段。文档缺失时只渲染模板骨架（不写 issue、不流转）；
# 填充内容段后再次运行：校验 → 回执 → issue 更新 → seed。
node <skill>/scripts/run.mjs session handoff \
  --project <项目绝对路径> \
  --work-item <provider:repository#issue> \
  --session <当前session-id> \
  [--to-status in-progress|ready-for-review] \
  [--dry-run]

# 只读状态：issue、看板字段、交接文档校验结果、最近回执
node <skill>/scripts/run.mjs session status \
  --project <项目绝对路径> \
  [--work-item <provider:repository#issue>]

# 仅渲染 seed prompt（不落盘、不流转，供人工粘贴）
node <skill>/scripts/run.mjs session seed \
  --project <项目绝对路径> \
  --work-item <provider:repository#issue>
```

- 所有输出为稳定 JSON；`--dry-run` 零写入（含 gh 只读校验），输出不含时间戳、逐字节可复现。
- work-item 语法：`github:<owner>/<repo>#<issue>`（P1 仅 GitHub）。

## 交接文档（docs/HANDOFF-<issue>.md）

- 模板随包分发（`dist/session/templates/handoff.md`），必需节固定 7 节，见模板。
- CLI 校验：必需节齐全、`{{...}}` 占位符全部消失（SEED 段除外）、引用文件路径存在、
  「已完成」中引用的回执 id 与 harness 回执库一致。失败即拒绝，不产生状态流转、不留半成品。
- 回执引用格式：`回执: <id>`（或 `receipt: <id>`）。回执库查找位置：
  `<git-common-dir>/harness/session-handoff/receipts/`、`<git-common-dir>/harness/worktree-delivery/receipts/`、
  `<project>/.harness/sessions/`、`<project>/.harness/eval-runs/`。
- SEED 段由 CLI 确定性生成并在每次 handoff 时重写，**勿手改**。

## 回执与 issue 更新

- handoff 回执：`<git-common-dir>/harness/session-handoff/receipts/handoff-<issue>-<docHash12>.json`，
  记录 `{id, workItem, session, handoffDocPath, handoffDocHash, commit, receiptIds, fromStatus, toStatus, at}`。
  id 由文档哈希决定 → 同文档重跑幂等（回执文件幂等覆盖；issue 评论可能重复追加，属已知行为）。
- issue 更新顺序：校验与本地回执先行，随后追加 receipts 评论、写 `handoff-doc` 字段、写 `status` 字段。
  任一远端写入失败会整体报错并提示幂等重跑，本地文档与回执不丢。

## 仓库策略（.harness/session-workflow.yaml）

- 模板文件引用、issue 附加字段名、statusValues 映射、seed 约束段都存于此文件；P1 没有宿主观测实现，故没有 session 阈值字段或默认值。
- 项目有 `.harness/session-workflow.yaml` 则用之；没有则使用包内默认值（CLI 只读，绝不写回项目）。
- 该文件与默认值的任何变更必须走 harness `plan`/`apply` 计划哈希批准流程；插件与 CLI 均不得自行改写。
- provider 主体（repository、project 编号、statusField）复用 `.harness/worktree-delivery.json`；
  session 命令组不另设凭据机制，统一走既有 `gh` 通道（`gh auth`）。

## Seed prompt（§7）

- 由 `session seed` / `session handoff` 确定性渲染：issue 标题=目标、验收标准字段=验收，
  固定前缀块（项目/仓库/规则文件/报告协议）+ 约束段来自策略文件。逐字节固定，无时间戳、无随机数。
- 交接完成后，seed 与 `docs/HANDOFF-<issue>.md` 一起落盘，新会话复制即用。若 work-item 有有效的交付授权回执，seed 必须恢复该包络、当前 head/PR/check evidence 与 retry budget；会话切换本身不构成新的确认门。

## 不变量（§8 摘要）

- 无证据不流转 issue 状态；CLI 校验失败必须拒绝，不留半成品状态。
- 不把 AI 自然语言摘要当作状态事实；进展只认 git 产物 + harness 回执 + issue 字段。
- 正常的 commit、同一授权范围内的 rebase、同 SHA 基础设施重试和会话切换不应重新请求授权；只有授权稳定事实失效、deterministic blocker 或证据冲突才停止。
- 不重复实现 git / worktree / 租约逻辑；不新造凭据机制。
- 策略（模板、字段映射）变更必须走计划哈希批准。
