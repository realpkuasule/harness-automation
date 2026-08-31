# 会话交接设计（harness-automation `session` 扩展）

> 状态：设计草案 v0.3，待批准（按 harness-automation 的 plan → approve → apply 流程，批准后在新项目工作区实现）
> v0.3 变更：确认 harness-automation 仓库为负责人自有（realpkuasule/harness-automation，本地 clone `/Users/zhichao/codex/harness-automation`），改造直接在该仓库进行（Route A）；skill 安装点为仓库 `skill/` 经 install.sh 同步的副本。见 §3.2。
> v0.2 变更：架构调整为"改造 harness-automation 为主（执行与权威），插件降为可选薄适配层（观测与触发）"；见 §3.1。
> 关联：本设计的动机证据、决策边界与术语，均来自对真实会话 session-3299f5d5（aihot-remixer 项目）的复盘，以及关于上下文膨胀与 KV 缓存的三轮讨论结论。新工作区会话应以本文档为唯一入口，不必重新推导背景。

---

## 1. 目标与非目标

### 目标

1. 在切换发生时确定性完成交接：交接物落盘（`docs/HANDOFF-<issue>.md`）、回执与新会话 seed prompt（不经旧会话 AI 的自然语言转述）。
2. 让任意新会话准确地了解进展：以 git 产物 + harness 回执 + issue 结构化字段为唯一事实源，而不是会话间互相"传话"。

### 非目标

- 不自动终止会话、不替人做验收决定。
- 不做 git / worktree 管理——复用 `manage-worktree-delivery` 与 `harness-automation` CLI。
- 不把 AI 写的自然语言摘要当作跨会话状态事实。
- 不实现宿主会话观测、阈值、自动触发或批准插件；当前没有运行时消费者或多会话校准证据。

---

## 2. 背景与证据（为什么做）

### 2.1 原理结论（三轮讨论的收敛点）

1. 上下文膨胀带来三类互相独立的代价：**钱**（input token 计费）、**时间**（prefill / TTFT）、**质量**（注意力稀释、lost in the middle、指令遗忘）。
2. **缓存命中只能消除前两类，且只对"逐 token 精确匹配的前缀"有效**。动态注入（mid-context 内容变化）、模型切换都会切断前缀命中。缓存不改变模型的注意力行为，不解决质量下降。
3. 因此对抗膨胀必须打组合拳：**前缀友好设计 + 源头压缩 + 该切就切**。切会话的恢复成本靠交接物落盘趋近于零。

### 2.2 实证（session-3299f5d5 复盘数据）

| 指标 | 实测值 |
|---|---|
| 时长 | 25 小时（08-16 12:10 → 08-17 13:04） |
| 规模 | 40 轮、686 个 LLM 步骤、804 次工具调用、30,805 条事件 |
| 上下文增长 | turn 2 ~27K → turn 4 ~288K → 结尾 ~610K token（按内容字符估算） |
| 动态注入 | 94 次 inbox splice、3 次 goal/change、技能目录变更若干 |
| 模型切换 | deepseek-v4-pro ↔ deepseek-v4-flash 共 4 次 |
| 成本 | 用户反馈输入 token 达 200M+ |
| 质量信号 | "你总是忘了告诉我生成物在哪里"、"内容不能仅仅只有标题"被重复强调、"验证了一下，有很多问题"（返工循环）、session/title 变更 4 次 |

---

## 3. 总体架构

```
事实层（GitHub Issue + Project 看板 + git 产物 + harness 回执）
   唯一跨会话状态源；自然语言摘要不算数
        ↑ 写入者：harness CLI（有回执支撑才允许流转）
执行层（harness-automation 扩展 —— 本次改造的主体，唯一执行与权威系统）
   session 命令组、交接文档模板与校验、seed 确定性渲染、
   issue 状态机、模板与字段映射（.harness/session-workflow.yaml，走计划哈希）
        ↑ 调用方：agent 或人
```

- **harness-automation 是主体**：所有已实现的确定性逻辑（CLI、模板、状态机、回执）都进 harness-automation，全部 Agent 可用（portable 基线）。
- **与 `manage-worktree-delivery` 的分工**：它管 issue ↔ worktree 租约；session 命令组管 issue ↔ session 生命周期；两者通过同一 `provider:repository#issue` 对齐，不重复实现任何 git 逻辑。

### 3.1 实现归属

- harness-automation 仓库为负责人自有：`git@github.com:realpkuasule/harness-automation.git`；本地 clone：`/Users/zhichao/codex/harness-automation`（main 分支）。
- **CLI 与模板直接在仓库内实现**（Route A）：`session` 命令组、交接/seed 模板随包分发，`tests/` 加测试，CHANGELOG + 版本 bump（加性，建议 2.2.0）。
- **skill 协议扩展也在仓库内改**：仓库 `skill/`（SKILL.md、references、scripts、install.sh）是 skill 的版本化真相源；本机三个安装点（`~/.agents/skills`、`~/.claude/skills`、`~/.codex/skills`）经 install.sh 同步。SKILL.md 新增"会话交接协议"节 + `references/session-workflow.md`。
- 回滚 = git revert + 重跑 install.sh + 重装旧版本全局包。
- 配置兼容：旧 `thresholds` 键不再解释；schema 忽略它，避免继续制造已生效的假象。

---

## 4. Issue 状态机与字段

### 4.1 字段（GitHub issue 承载运行时状态）

| 字段 | 类型 | 写入者 | 说明 |
|---|---|---|---|
| `status` | Project 看板列 / issue field | CLI（回执支撑）+ 人 | `backlog` / `in-progress` / `ready-for-review` / `done` |
| `handoff-doc` | issue 字段 | CLI | 仓库内相对路径，如 `docs/HANDOFF-42.md` |
| `accepted-commit` | issue 字段 | worktree close 流程 | 验收通过的 commit sha |
| `receipts` | issue 评论（JSON 列表） | CLI | 每次交接/状态流转的回执 id 列表 |
| `sessions` | issue 评论 | 插件 | 接触过该工作项的 session id（仅审计） |

### 4.2 流转与证据要求

```
backlog ──(工作项被认领：worktree 租约存在 + seed 已生成)──▶ in-progress
in-progress ──(继续开发 handoff：文档 + 校验 + 回执)──▶ in-progress
in-progress ──(显式交付评审：文档 + 校验 + 回执)──▶ ready-for-review
ready-for-review ──(accepted-commit 存在)──▶ done
任意状态 ──(仅人可操作)──▶ backlog（reopen）
```

- 任何自动流转都必须携带证据（commit sha / 回执 id / 检查结果），**证据缺失即拒绝流转**。
- 仓库内策略（seed 模板、交接文档模板、字段映射）进入仓库文件 `.harness/session-workflow.yaml`，变更走 harness 的计划哈希批准流程；issue 只承载运行时状态，二者不混淆。

---

## 5. 延后能力

宿主观测、阈值、自动触发和插件不属于当前产品。只有实际宿主 API、运行时消费者以及多会话校准证据同时具备时，才以新设计重新提出；不得从本文件或 `.harness/session-workflow.yaml` 推断这些能力已经生效。

---

## 6. CLI 设计（P1：harness-automation `session` 命令组）

直接实现在 `realpkuasule/harness-automation` 仓库（本地 clone：`/Users/zhichao/codex/harness-automation`），随包发布；skill 的 `scripts/run.mjs` 只是转发器，无需改动。

```bash
# 交接：落盘 + 校验 + 回执 + issue 状态流转 + seed 生成
node <skill>/scripts/run.mjs session handoff \
  --project <项目绝对路径> \
  --work-item <provider:repository#issue> \
  --session <当前session-id> \
  [--to-status in-progress|ready-for-review] \
  [--dry-run]

# 查看当前工作项与会话状态（只读）
node <skill>/scripts/run.mjs session status \
  --project <项目绝对路径> \
  [--work-item <provider:repository#issue>]

# 仅渲染 seed prompt（不落盘、不流转，供人工粘贴）
node <skill>/scripts/run.mjs session seed \
  --project <项目绝对路径> \
  --work-item <provider:repository#issue>
```

`session handoff` 的确定性职责（全部无 AI 参与）：

1. 校验 work-item 与 provider 可达、issue 存在且状态合法。
2. 收集自上次回执以来的提交与检查结果，生成交接文档草稿（模板见 6.1，由当前会话 Agent 填充内容段后由 CLI 校验）。
3. **校验交接文档**：必需节齐全、引用路径存在、回执 id 与 harness 回执库一致；失败即拒绝，不产生状态流转。
4. 计算交接文档哈希，写 harness 回执 `{id, workItem, handoffDocHash, commit, session, at}`。
5. 更新 issue：`handoff-doc`、追加 receipts 评论、按证据执行状态流转（无证据拒绝）。
6. 渲染并输出 seed prompt（模板见第 7 节），同时将其写入交接文档头部。

### 6.1 交接文档模板（`docs/HANDOFF-<issue>.md`）

```markdown
# HANDOFF <issue> — <一句话目标>

> Seed prompt 见文末；本文件由 harness CLI 校验，非自由文本。

## 目标与验收标准
## 已完成（附 commit / 回执）
## 当前状态（跑通什么、依赖什么、密钥位置）
## 已知问题与未决项
## 下一步建议（编号列表，供新会话认领）
## 引用文件（路径列表，新会话必须读）
## SEED（由 CLI 确定性生成，勿手改）
```

---

## 7. Seed prompt 模板（确定性渲染）

模板存于仓库策略（`.harness/session-workflow.yaml`），由 issue 字段渲染，**逐字节固定**（无时间戳、无随机数）以保前缀缓存：

```markdown
【固定前缀块】（跨会话逐字复用：项目名、仓库地址、规则文件路径、报告协议、模型路由约束）
【目标】<issue 一句话目标>
【现状】已完成见 docs/HANDOFF-<issue>.md；待办与已知问题同上
【验收】<issue 验收标准字段>
【约束】<仓库策略中的固定约束段>
【第一步】先读 docs/HANDOFF-<issue>.md，恢复已有授权、head、PR 与 check evidence；
在有效授权内连续推进，仅在授权失效、确定性 blocker 或证据冲突时停止。
完成报告必须包含：改了什么、生成物完整路径、验收结果。
```

---

## 8. 不变量（禁止事项）

1. 不单方面终止会话、不代做验收（`done` 必须由 accepted-commit 支撑）。
2. 不把 AI 自然语言摘要当作状态事实；跨会话进展只认 git 产物 + 回执 + issue 字段。
3. 无证据不流转 issue 状态；CLI 校验失败必须拒绝，不留半成品状态。
4. 继续开发 handoff 保持 `in-progress`；只有显式交付评审才能进入 `ready-for-review`。
5. 不重复实现 git / worktree / 租约逻辑——一律走 `manage-worktree-delivery` 计划流程。
6. 不把未经实现和校准的宿主指标、阈值或插件写成生效能力。
7. 仓库策略（模板、字段映射）变更必须走计划哈希批准。

---

## 9. 分阶段交付计划

### P1 — 交接 CLI（无插件，人工触发）
- `session handoff / status / seed` 三命令 + 交接文档校验 + 回执 + issue 流转。
- **验收**：在 aihot-remixer 仓库用真实 issue 跑一次交接；新会话**仅凭 seed + HANDOFF 文档**能独立开工（盲测：新会话不阅读旧会话记录）。

### 后续（尚未设计）

若未来具备可验证的宿主观测 API 与多会话校准数据，另起设计和 Issue；本版本不预留阈值字段、插件接口或默认值。

---

## 10. 待确认问题（留给新工作区）

1. **provider 凭据复用**：`manage-worktree-delivery` 的 provider 映射如何获取凭据，能否同一接口复用。
2. **GitHub Project 配置**：看板与 issue 字段是自动创建还是人工预置；`status` 用 Project field 还是 label。
3. **未来宿主观测**：只有证明有消费者、可稳定观测、且完成多会话校准后，才提出新的插件设计。

---

## 11. 参考

- Skills：`harness-automation`（SKILL.md + references/workflow.md）、`manage-worktree-delivery`（SKILL.md）。
- 实证数据：`~/.dsh/sessions/--Users-zhichao-DSH-aihot-remixer--/session-3299f5d5-30af-4c61-abb3-6f14a1746fcb/session.jsonl.zstd`（复盘脚本见会话记录，统计口径：40 轮 / 686 步 / 94 splice / 上下文 ~27K→~610K token）。
