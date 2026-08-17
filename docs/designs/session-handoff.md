# 会话自动切分与交接设计（harness-automation `session` 扩展 + dsh-session-handoff 薄插件）

> 状态：设计草案 v0.3，待批准（按 harness-automation 的 plan → approve → apply 流程，批准后在新项目工作区实现）
> v0.3 变更：确认 harness-automation 仓库为负责人自有（realpkuasule/harness-automation，本地 clone `/Users/zhichao/codex/harness-automation`），改造直接在该仓库进行（Route A）；skill 安装点为仓库 `skill/` 经 install.sh 同步的副本。见 §3.2。
> v0.2 变更：架构调整为"改造 harness-automation 为主（执行与权威），插件降为可选薄适配层（观测与触发）"；见 §3.1。
> 关联：本设计的动机证据、决策边界与术语，均来自对真实会话 session-3299f5d5（aihot-remixer 项目）的复盘，以及关于上下文膨胀与 KV 缓存的三轮讨论结论。新工作区会话应以本文档为唯一入口，不必重新推导背景。

---

## 1. 目标与非目标

### 目标

1. 在会话运行过程中**自动观测**"该新开会话"的信号，并给出建议（质量 > 性价比：优先保证工作质量，性价比作为次约束）。
2. 在切换发生时**自动完成交接**：交接物落盘（`docs/HANDOFF-<issue>.md`）、issue 状态流转（有回执支撑）、新会话 seed prompt **确定性生成**（不经旧会话 AI 的自然语言转述）。
3. 让任意新会话**准确地了解进展**：以 git 产物 + harness 回执 + issue 结构化字段为唯一事实源，而不是会话间互相"传话"。

### 非目标

- 不自动终止会话、不替人做验收决定。
- 不做 git / worktree 管理——复用 `manage-worktree-delivery` 与 `harness-automation` CLI。
- 不把 AI 写的自然语言摘要当作跨会话状态事实。
- 不托管模型调用、不建立未经人工校准的硬门禁。

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

### 2.3 切会话信号及其可自动化程度

| 信号 | 判定方式 | 自动化程度 |
|---|---|---|
| 轮数 / 步骤数 / 模型耗时超阈值 | 宿主会话统计（已存在） | **自动告警**（确定性） |
| 输入 token 超阈值 | 新增投影单元折叠 chunk usage（待确认字段语义） | **自动告警**（v2） |
| 阶段切换（session/title 变更、goal/change、用户要求写交接文档） | 事件日志 | **半自动建议** |
| retry / 返工循环 | llm/retry 事件计数 | 自动提示 |
| 用户重复交代（质量信号） | 启发式（短消息 + 否定词模式） | **只统计，不触发**（不可靠） |
| 是否真的切换、是否验收通过 | 人 | **必须人工批准** |

---

## 3. 总体架构（改造 harness-automation 为主，插件为薄适配层）

```
事实层（GitHub Issue + Project 看板 + git 产物 + harness 回执）
   唯一跨会话状态源；自然语言摘要不算数
        ↑ 写入者：harness CLI（有回执支撑才允许流转）
执行层（harness-automation 扩展 —— 本次改造的主体，唯一执行与权威系统）
   session 命令组、交接文档模板与校验、seed 确定性渲染、
   issue 状态机、阈值策略文件（.harness/session-workflow.yaml，走计划哈希）
        ↑ 唯一调用方：agent（人工触发）或触发层插件
触发层（dsh-session-handoff 宿主插件 —— 可选薄适配层，缺省时系统依然完整可用）
   只做：宿主观测（投影 seam）→ 阈值比对 → open turn 注入建议
        → approval 门 → 调用 harness CLI
   不含任何交接 / 状态机 / 模板逻辑，避免双自动化系统
```

- **harness-automation 是主体**：所有确定性逻辑（CLI、模板、状态机、策略）都进 harness-automation，全部 Agent 可用（portable 基线）。插件**不实现任何交接逻辑**，只是"传感器 + 扳机"。
- **与 `manage-worktree-delivery` 的分工**：它管 issue ↔ worktree 租约；session 命令组管 issue ↔ session 生命周期；两者通过同一 `provider:repository#issue` 对齐，不重复实现任何 git 逻辑。

### 3.1 为什么不是"全部并入 harness-automation"（结构边界）

harness-automation 有三条属性使它无法承担"自动触发"层，只能作为执行与权威系统被调用：

1. **它是 agent 内的、可移植的**：一切动作经 agent 工具调用发生，对宿主运行时零访问。会话指标（turns/steps/llmMs/token）只有宿主投影层在算；技能最多写"每 8~12 轮自查"——这是认知规则（guidance），执行者却是注意力正被稀释的 agent 本身。harness-automation 自己的原则："写进 Agent 文档不等于 enforced"。宿主阈值检查才是 enforced，这正是它补不上的部分。
2. **它明确不写死 runtime 能力**（不变量："不把未来 DeepSeek/GLM runtime 的能力写死；未知 Agent 使用 AGENTS.md + CLI 的 portable adapter"）：投影 seam、inbox 注入、approval seam、会话生命周期都是 DSH 宿主专属，塞进核心会破坏对 claude-code/codex 等 agent 的可移植性。
3. **触发时机**：CLI 的触发者是"agent 或人决定跑它"；插件的触发者是宿主确定性事件（阈值命中、open turn）。该切而 agent 没意识到时，只有宿主能兜底。

因此插件的定位等于 harness-automation 所说的"CLI 是基线、MCP 只是可选传输层"——它是 DSH 上的那层可选传输/触发层；没有它，P1（人工触发）依然完整可用。

### 3.2 实现归属（v0.3 已定：直接改造自有仓库）

- harness-automation 仓库为负责人自有：`git@github.com:realpkuasule/harness-automation.git`；本地 clone：`/Users/zhichao/codex/harness-automation`（main 分支）。
- **CLI 与模板直接在仓库内实现**（Route A）：`session` 命令组、交接/seed 模板随包分发，`tests/` 加测试，CHANGELOG + 版本 bump（加性，建议 2.2.0）。
- **skill 协议扩展也在仓库内改**：仓库 `skill/`（SKILL.md、references、scripts、install.sh）是 skill 的版本化真相源；本机三个安装点（`~/.agents/skills`、`~/.claude/skills`、`~/.codex/skills`）经 install.sh 同步。SKILL.md 新增"会话交接协议"节 + `references/session-workflow.md`。
- 回滚 = git revert + 重跑 install.sh + 重装旧版本全局包。
- 加性兼容要求不变：已发布包，其他项目与 `manage-worktree-delivery` 共存，禁止改既有命令语义与 policy 文件格式。
- 改造前 hygiene：clone 当前存在未跟踪的 `.harness/plans/` 目录，先决定纳入 gitignore 或提交。

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
in-progress ──(handoff 文档落盘 + 校验通过 + 回执)──▶ ready-for-review
ready-for-review ──(accepted-commit 存在)──▶ done
任意状态 ──(仅人可操作)──▶ backlog（reopen）
```

- 任何自动流转都必须携带证据（commit sha / 回执 id / 检查结果），**证据缺失即拒绝流转**。
- 仓库内策略（阈值、seed 模板、交接文档模板）进入仓库文件 `.harness/session-workflow.yaml`，变更走 harness 的计划哈希批准流程；issue 只承载运行时状态，二者不混淆。

---

## 5. 插件设计（dsh-session-handoff，薄适配层）

> 边界重申：本节描述的全部内容是**观测、判定、触发**。交接物生成、校验、回执、issue 流转、seed 渲染全部由 harness CLI 执行，插件绝不重复实现。

### 5.1 观测

- 消费宿主会话投影 seam（`dsh-session-projection` 的 registry snapshot + change feed，`dsh-session-stats` 是既有参考实现）。
- **v1 直接可用的指标**（`dsh-session-stats` 已 fold，log-scoped、不受压缩影响）：`steps`、`turns`、`llmMs`、`ttftMs`、`decodeMs`、`decodeTokens`、`toolMs`。
- **v2 新增投影单元** `sessionInputTokens`：折叠 chunk 事件中 provider 上报的 prompt tokens（本机样本中 `assistant/chunk` 已含 usage 键，字段语义待在新版本确认）。
- 事件级信号：`session/title` 变更次数、`goal/change`、`llm/retry` 计数、`agent/inbox/spliced` 计数（动态注入频度本身就是一个"缓存被破坏"的代理指标）。

### 5.2 判定（默认阈值，仓库策略可覆盖）

| 信号 | 默认阈值 | 动作 |
|---|---|---|
| 用户轮数 | ≥ 12 | 注入切换建议 |
| LLM 步骤数 | ≥ 150 | 注入切换建议 |
| 累计模型耗时 | ≥ 30 分钟 | 注入切换建议 |
| session/title 变更 | ≥ 2 次 | 注入阶段漂移提示 |
| llm/retry | ≥ 3 次 | 注入返工提示 |
| inbox splice 频度 | ≥ 阈值（可配置） | 注入"前缀缓存被破坏"提示 |
| （v2）累计输入 token | ≥ 5M，或单轮估算 ≥ 300K | 强切换建议 |
| 质量信号（用户重复交代启发式） | — | 仅计入统计，不触发 |

### 5.3 交接（触发路径）

1. 信号命中 → 插件在**下一个 open turn 内**（用户在发消息时）注入一条 append-only 的建议消息：含命中的信号、一句切换建议、以及"生成交接物"的一键入口。
2. 人确认后，经 `ctx.approval.request()`（复用 `dsh-user-approval` 的 seam，词汇表 `allowed-once/rejected/cancelled/unavailable`）请求一次性批准。
3. 批准 → 插件调用 harness CLI（第 6 节）执行交接；CLI 全程确定性，无 AI 参与。
4. CLI 输出新会话 seed prompt：插件注入到当前会话末尾展示，同时写入 `docs/HANDOFF-<issue>.md` 头部（seed 与文档一起落盘，新工作区复制即用）。

**约束（已查证）**：approval seam 只允许在 open agent turn 内请求（宿主文档明示 "durable out-of-turn approval workflow is deferred"），因此插件**不得**用后台定时器触发切换，只能在用户交互时提出——这符合"切会话必须在人眼皮底下发生"的原则。

### 5.4 注入纪律（KV 缓存意识）

- 注入内容**只允许 append-only**，禁止改写已保留的历史（宿主 `dsh-user-approval` 的做法：状态未变时零追加，变化才追加一条，且附加在保留历史之后）。
- 注入文本必须是**确定性模板渲染**（不含时间戳、随机数），保证同状态下跨请求逐字节一致，保住前缀缓存。
- 每次注入后要在请求记录中核对前缀命中情况（把注入对缓存的影响做成可观测指标，而非口头承诺）。

### 5.5 与既有宿主包的关系

| 包 | 关系 |
|---|---|
| `dsh-session-stats` | 参考实现；其 fold 逻辑可复用/引用；注意它当前只挂在 web-app bundle |
| `dsh-user-approval` | 复用其 approval seam；其 KV-cache-aware 注入方式是模板 |
| `dsh-session-checkpoint-policy` | 压缩只改模型可见面；本插件统计一律取 log 层（与 session-stats 同策略），不受压缩影响 |
| `dsh-session-projection` | 挂载点：注册自己的 projection unit / 订阅 change feed |

---

## 6. CLI 设计（P1：harness-automation `session` 命令组）

直接实现在 `realpkuasule/harness-automation` 仓库（本地 clone：`/Users/zhichao/codex/harness-automation`），随包发布；skill 的 `scripts/run.mjs` 只是转发器，无需改动。

```bash
# 交接：落盘 + 校验 + 回执 + issue 状态流转 + seed 生成
node <skill>/scripts/run.mjs session handoff \
  --project <项目绝对路径> \
  --work-item <provider:repository#issue> \
  --session <当前session-id> \
  [--to-status ready-for-review] \
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
【第一步】先读 docs/HANDOFF-<issue>.md 并运行 harness `context`，
输出 3 行执行计划 + 需要人确认的问题，确认后再动手。
完成报告必须包含：改了什么、生成物完整路径、验收结果。
```

---

## 8. 不变量（禁止事项）

1. 不在 open turn 之外请求 approval；不用后台定时器触发切换。
2. 不单方面终止会话、不代做验收（`done` 必须由 accepted-commit 支撑，由人确认）。
3. 注入只允许 append-only，禁止改写保留历史；注入文本确定性渲染。
4. 不把 AI 自然语言摘要当作状态事实；跨会话进展只认 git 产物 + 回执 + issue 字段。
5. 无证据不流转 issue 状态；CLI 校验失败必须拒绝，不留半成品状态。
6. 不重复实现 git / worktree / 租约逻辑——一律走 `manage-worktree-delivery` 计划流程。
7. 不把未经人工校准的模型判断（含质量信号启发式）当作硬门禁；只允许统计与提示。
8. 仓库策略（阈值、模板）变更必须走计划哈希批准，插件不得自行改写。

---

## 9. 分阶段交付计划

### P1 — 交接 CLI（无插件，人工触发）
- `session handoff / status / seed` 三命令 + 交接文档校验 + 回执 + issue 流转。
- **验收**：在 aihot-remixer 仓库用真实 issue 跑一次交接；新会话**仅凭 seed + HANDOFF 文档**能独立开工（盲测：新会话不阅读旧会话记录）。

### P2 — 观测与建议插件（建议，不自动切）
- 注册 projection unit，订阅 change feed；按第 5.2 节阈值注入 append-only 建议 + 一键交接（approval seam 包裹 CLI 执行）。
- **验收**：在真实长会话中触发建议 → 批准 → CLI 完成交接；对比注入前后的请求前缀，确认缓存命中率不因注入下降；信号阈值可经仓库策略配置并走计划哈希。

### P3 — 闭环（看板 + 阶段信号 + 可选自动新开）
- goal/change、session/title 等阶段信号接入；GitHub Project 看板列自动流转（仅回执支撑的部分）。
- 探索"自动新开"的机制形态：宿主是否暴露创建新会话的 host API（`dsh --profile headless` 已有 fresh persisted session 先例；web 形态待查）。若不可得，退化为"一键复制 seed，人手动开新会话"。
- **验收**：从一个 backlog issue 开始，两个会话轮换完成一个工作项，全程状态可审计，人工只在验收点介入。

---

## 10. 待确认问题（留给新工作区）

1. **插件包落点**：插件仅为可选薄适配层（不做也可用，P1 独立成立）。主实现目标 = harness-automation 的 `session` 命令组与协议扩展。插件若做，建议独立 npm 包（`dsh-session-handoff`，out-of-tree 挂到 profile）。
2. **输入 token 观测**：chunk 事件的 usage 字段语义需在新版本确认；不可得时降级为字符估算（chars/4）并明示。
3. **provider 凭据复用**：`manage-worktree-delivery` 的 provider 映射如何获取凭据，能否同一接口复用。
4. **GitHub Project 配置**：看板与 issue 字段是自动创建还是人工预置；`status` 用 Project field 还是 label。
5. **压缩交互**：change feed 在 checkpoint 压缩后的事件完整性需实测确认。
6. **人批准形态**：P2 的"一键交接"用 approval seam（插件发起）还是仅提示 + 人手动复制 seed；批准粒度是每次切换一次还是每次 CLI 执行一次。
7. **插件自身仓库**：新工作区若另建仓库，本文档迁移后作为 `docs/DESIGN.md` 冻结为 v0.1，后续变更走 plan/apply。
8. **与 goal 工具的关系**：goal round 的 continuation 是否应触发信号（目标延续 vs 会话切分的目标变更判定）。

---

## 11. 参考

- 本机宿主包（`~/.nvm/.../@deepseek-ai/`）：`dsh-session-stats`、`dsh-session-projection`、`dsh-user-approval`、`dsh-session-checkpoint-policy`、`dsh-goal`、`dsh-session` 的 README 与 fold 语义。
- Skills：`harness-automation`（SKILL.md + references/workflow.md）、`manage-worktree-delivery`（SKILL.md）。
- 实证数据：`~/.dsh/sessions/--Users-zhichao-DSH-aihot-remixer--/session-3299f5d5-30af-4c61-abb3-6f14a1746fcb/session.jsonl.zstd`（复盘脚本见会话记录，统计口径：40 轮 / 686 步 / 94 splice / 上下文 ~27K→~610K token）。
