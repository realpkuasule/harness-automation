# 成果02：Harness Automation v3 场景化功能清单与 v2.8.11 差距

> 状态：供用户审阅和修改的建议稿，不是 v3 正式需求。
>
> 修订：第十轮为成果03候选统一零损失检查、Local-only tracking、W-07 与 L-05 职责和术语。
>
> 内部一致性：规范名称以第 3.2 节、第 6 节及 G-02、G-07、D-06、L-05 的定义为准。
>
> 上游目标：[成果01：Branch、Worktree 与跨机器多人协作目标方案](./result-01-branch-worktree-collaboration-target.md)
>
> 当前实现基线：`v2.8.11`，Git commit `fe6ea2582d3f864d1ba517ae07213219c968d0fe`。
>
> 跟踪工作项：`realpkuasule/harness-automation#78`。

## 1. 文档定位

本文把两类信息放在同一张地图上：

1. 成果01确认的 Branch、Worktree、写租约、PR、跨机器协作和精确清理目标；
2. Harness Automation `v2.8.11` 已经存在的全部正式产品能力。

它回答三个问题：

- 用户在真实项目场景中，v3 应该提供什么体验；
- 这些体验中，哪些已经由 v2.8.11 完成，哪些只有可复用原语，哪些尚未实现；
- v2 现有语义与成果01发生冲突时，应怎样迁移，而不是用新说法覆盖旧行为。

本文不把 README 中的设想、类型里尚不可达的字段、旧 v1 兼容代码或仓库自身的维护脚本算作正式产品能力。判定顺序是：公开入口和运行时行为优先，测试与源码作为证据，当前文档作为补充。

为避免同一规则在多个场景中重复演化，规范解释顺序固定为：审批边界（3.3）与 Anti-self-lock（6.1）优先于功能契约（第 4 节），功能契约优先于场景示例（第 5 节）和迁移说明（第 8 节）。场景和迁移只能解释，不能扩大权限、降低门禁或另造状态。

成果01的生命周期语义长期保持 Provider-neutral；本文只把 v3 的实际交付范围收缩为 GitHub 与显式 Local-only，不是否定未来其他远端 Provider。v3 不为尚无真实需求的 Provider 预建实现或插件框架。

`common-dir work-item lease`、`TASK.json`/`CHANGELOG.jsonl`、`last-known-good`、`safe mode`、`Anti-self-lock`、`v2 compatibility`、`compatibility close` 和 `adopt/adoption` 是本文的 Harness 实现、存储或迁移术语；它们未出现在成果01词汇表中是有意的层级边界，不构成第二套生命周期，也不得改变成果01的目标语义。其中 `v2 compatibility` 专指成果01 `Legacy compatibility` Profile 下的旧实现操作，不是 Profile 或 Coverage 状态的别名；适用对象可以处于 `AuditOnly`，也可以在 `Mixed` 中属于尚未接管的子集。

### 1.1 状态定义

| 状态 | 判定标准 |
|---|---|
| **已实现** | v2.8.11 已有用户可达入口、确定性行为和测试，且主要语义与成果01一致。 |
| **部分实现** | 已有值得复用的实现，但缺少端到端编排、跨机器保证或成果01要求的关键不变量。 |
| **待实现** | 当前没有完整、可达的产品入口，不能通过组合几个手工命令就宣称已经提供。 |
| **明确不做** | v3 有意排除；它不是以后默认补齐的“欠账”。 |
| **兼容保留** | 旧项目仍可使用，但不再代表 v3 推荐路径。 |

“场景已实现”必须意味着整个场景成立。例如，本机能够创建 Worktree，不等于“跨机器唯一主写”已经实现；能够创建普通 PR，也不等于“Draft → Ready → 平台 auto-merge”已经实现。

### 1.2 基线纠正

任务最初口述的版本是 `v2.8.1`，但仓库当前 HEAD、Git tag 和 `mcp-server/package.json` 一致表明实际基线为 `v2.8.11`。本文以可复现的实际基线为准，不反向猜测旧版本能力。

## 2. 一句话结论

Harness v2.8.11 已经具备三块坚实基础：**工程策略编译器、单机 Worktree 生命周期治理、带回执的 Session/Delivery 原语**；但成果01要求的“从新工作准入到跨机器唯一主写，再到平台合并和精确关闭”的端到端闭环尚未形成。

v3 最合理的方向不是另写一套系统，而是：

- 保留精确哈希作为机器完整性边界，但取消“人类复制哈希即审批”的交互；
- 由确定性风险策略和独立第二 AI 静默审查普通计划，只把真正需要人的语义决定汇总成一张清单；
- 让现有 Worktree、Session、Delivery、GitHub Audit 共用一个交付状态模型；
- 只新增缺失的远端协调、准入编排、GitHub 治理写入、Host Adapter 和 Closing 恢复能力；
- 把治理放在低上下文控制面中静默执行，一次 Bootstrap 完成初始设置；
- 不建设后台守护进程、全局分支清理器、自动 rebase 机器人、GitLab/Jira 空壳或通用 Provider 插件框架。

## 3. 产品边界与原子化建议

### 3.1 保留一个产品，内部按能力域原子化

建议继续保留一个 `harness-automation` 仓库、npm 包和 CLI。原因不是把功能都堆进一个模块，而是以下基础设施天然需要共享：

- 同一份项目策略和 profile；
- 同一套 plan hash、Apply、receipt、drift 和 rollback 事务边界；
- 同一个 Work Item、Branch、PR、Lease 和 Worktree 身份映射；
- 同一套升级与旧项目接管协议。

内部应保持以下能力域边界，而不是拆成互不一致的独立产品：

| 能力域 | 责任 | 不应负责 |
|---|---|---|
| **Core** | 策略语义、交付状态机、不变量、漂移判定和迁移规则 | 拼接 GitHub API、执行 Apply 或操纵 Codex UI |
| **Plan Transaction** | planHash、前置条件、原子 Apply 与本轮精确补偿 | 决定 policy 语义或风险等级 |
| **Approval** | 风险分类、语义审批包、独立 reviewer、审批回执 | 修改计划、执行 Apply 或代替用户批准高风险动作 |
| **Receipts** | 不可变执行证据、hash chain 与查询 | 决定状态转换或保存 secret |
| **Recovery** | last-known-good、safe mode 和有界恢复 | 借恢复路径降低保护或改业务代码 |
| **Bootstrap** | 单会话发现、计划聚合、审查、执行与最终清单 | 把每个子计划变成一轮对话 |
| **Workspace** | 本机 checkout、Worktree、Branch、安全根和本机缓存 | 宣称拥有跨机器权威租约 |
| **Coordination** | 远端 lease、generation、fencing 与条件更新并发语义 | 决定合法 Delivery 状态转换、拼接 GitHub API 或决定 repo settings |
| **Delivery** | 授权、push、PR 身份与合法生命周期转换、Ready、集成证据、Closing | 实现 CAS 存储或绕过仓库 ruleset 决定团队审批 |
| **Tracking/GitHub** | Issue、GitHub Project 和工作项状态 | 操纵本地 Worktree 或保存明文凭证 |
| **Tracking/Local** | Git common dir 中唯一权威的 `TASK.json`、`CHANGELOG.jsonl` 和内置脚本 | 在各 Worktree 里各写一份状态，或在 GitHub 故障时悄悄成为第二事实源 |
| **Governance/GitHub** | repo settings、ruleset、branch protection 和 workflow | 拥有 PR/lease 生命周期或决定 Core 状态语义 |
| **GitHub Adapter** | repository identity、GitHub API/CAS、平台 readback | 决定 tracking、delivery、coordination 或 governance 政策 |
| **Host Adapter** | 发现、创建或打开 Codex/Claude 等宿主工作环境 | 自己重写 Git/Worktree 治理 |
| **Credential Broker** | 从系统密钥库取 GitHub 日常/admin 与 reviewer 凭证，并短暂注入单个子进程 | 保存或输出明文 secret |

v3 只正式支持两种 tracking mode：默认 `github`，以及用户明确声明的 `local-only`。Core 只保留这两个真实后端需要的最小 Work Item 契约；不为 GitLab/Jira 搭插件平台，也不把它们放入 v3 路线图。

### 3.2 v3 的交付原子

GitHub-backed 可交付工作的标准映射是：

```text
一个 Work Item
  ↕
一个短生命周期 Delivery Branch
  ↕
最多一个主 PR
  ↕
最多一个远端权威写租约
  ↕
最多一个 Primary-writing Delivery Worktree
```

Issue 是 GitHub 模式的 Work Item 实现，但不是 Git 的组成部分；Branch 保存提交线，Worktree 提供独立本地目录，写租约协调谁可以继续写。三者不能互相替代。

Local-only 是明确降级的单 Git common dir 模式：共享 Local Tracking Work Item + Delivery Branch + common-dir work-item lease + Delivery Worktree；集成时另取目标-ref 集成锁（target-ref integration lock）。该锁存放于 Git common dir，并按目标 ref 唯一。权威的 `TASK.json` 与 `CHANGELOG.jsonl` 位于该仓库唯一共享的 Git common dir，因此同一 clone 的所有 Worktree 读写同一事实源；它不创建 PR、不进入 `Draft/MergeArmed`，也不提供跨 clone、跨机器租约或唯一主写保证。检查复用项目原生命令，集成证明还必须绑定 expected base/source SHA 和 ref CAS 产生的 `integratedCommit`，不仿造一套本地 PR 平台。

本文中的 **GitHub Project** 指 GitHub 看板；**Host Project** 指宿主保存的仓库入口，例如 Codex Project。逻辑项目身份可以对应同一 repository 的管理 checkout 和多个交付 Worktree，当前执行目录仍必须精确到某一个 checkout，不能用“同一项目”推导它们共享 working tree。

### 3.3 机器完整性与人类审批必须分开

`planHash` 的价值是防篡改、绑定精确输入和拒绝漂移，不是让人类阅读。v3 保留 JSON plan 和完整哈希，但默认不把 JSON 或哈希作为用户审批界面。

每个 mutating plan 先生成稳定、可读的语义审批包，至少列出：对象、动作、before/after、风险、可逆性、验证、恢复路径和计划 digest。风险分类要求人类 gate 时，用户批准这份语义清单；允许自动审批时，由独立 reviewer 的结构化 verdict 批准。Harness 都在回执中自动绑定底层 `planHash`，不要求人类复制粘贴。

| 类别 | 默认处理 | 第二 AI 的角色 |
|---|---|---|
| 只读发现、audit、check、drift | 静默执行 | 不需要 |
| heartbeat、精确 CAS 幂等动作，以及满足全部零损失证明的正常 `Integrated → Closing → Closed` | 按已批准 profile 静默执行；plan/receipt 仍落盘 | 不调用 |
| 已批准语义的可逆编译产物、config 修复和受管区块更新 | 独立第二 AI 通过后自动批准和 Apply | 必须给出结构化 verdict |
| 新 policy 语义、legacy 对象映射/adopt/目录迁移、ruleset、branch protection、workflow、权限扩大、削弱保护、高风险 takeover、reviewer 信任配置、不可达旧事实源的 tracking migration waiver，以及会丢弃/覆盖既有内容或证据不足的删除、Abandon、事后 recovery/rollback | 用户明确批准一张合并清单 | 只能提供意见，不能代替用户 |

独立 reviewer 的契约是：

- 与主 Agent 隔离，默认使用不同模型家族，最好不同 Provider；
- 直接读取批准需求、canonical plan、raw diff 和验证证据，不读取主 Agent 的说服性结论或思维过程；
- 只输出 `approve | reject | needs-human`、findings 和置信度，并绑定 planHash、输入 digest、模型、Provider、reviewer-policy 版本；
- 只能提高风险，不能降低确定性 risk class；不能改计划、Apply、获取 admin credential 或批准自己的配置；
- reviewer Provider、模型、reviewer policy、凭证引用以及发送代码/计划的数据范围本身属于 protected trust configuration，只能由用户明确批准；
- Head、计划、来源或 policy digest 变化后，旧 review receipt 立即失效；
- 最多允许主 Agent自动修订并重审一次；再次拒绝进入 `NeedsHuman`，禁止原地循环；
- reviewer 不可用时不得回退为主 Agent 自审。已有项目继续使用 last-known-good；首次 Bootstrap 或确需推进的普通可逆计划，可退回为用户对可读语义清单的一次明确批准。用户未批准时进入 `ReviewPending`，不重复询问。该故障不得封锁只读诊断、普通开发、旧策略加载、rollback 或 safe mode。

MiniMax-M3 可以作为首选 reviewer 配置候选，但 Provider、模型 ID、凭证、隐私范围、超时和 fallback 另行设计；v3 契约不写死某个模型。

### 3.4 原子模块架构，不拆成微服务

当前最大的生产文件已经明显过肥：

| 文件 | 当前行数 | 混合职责 |
|---|---:|---|
| `mcp-server/src/worktree/service.ts` | 4,754 | 配置、观察、审计、plan、lease、迁移、Review、集成、关闭和远端清理 |
| `mcp-server/src/index.ts` | 2,261 | MCP 注册、v2 路由、legacy v1 路由、参数转换和旧 handler |
| `mcp-server/src/v2/service.ts` | 2,177 | intake、plan、update、apply、rollback、check、drift 和迁移 |
| `mcp-server/src/cli.ts` | 832 | 所有 CLI 命令解析和路由 |

v3 保持一个仓库、一个 npm 包、一个 CLI、一个进程，内部沿真实 use case 拆分：

```text
entrypoints/cli + entrypoints/mcp   只解析和序列化
bootstrap                           单会话编排
plan-transaction                    哈希、不可变计划与 Apply 事务
approval                            风险分类、语义包与 reviewer
receipts                            回执与证据链
recovery                            last-known-good、补偿与 safe mode
discovery                           stack / Agent / project gate 发现
tracking/github                     Issue / GitHub Project
tracking/local                      TASK / CHANGELOG
workspace                           config / observation / local lease cache / worktree lifecycle / review / cleanup
coordination                        remote lease / generation / fencing / conditional-state CAS
delivery                            push / PR / Ready / merge / Closing
governance/github                   audit / settings / ruleset / workflow
adapters/github                     GitHub API / CAS / readback
credentials                         keychain 与子进程注入
session                             admission / handoff
host                                Codex / Claude 薄适配
legacy/v1                           默认不加载的兼容边界
```

依赖方向固定为 `entrypoint → use-case → domain/ports`，由 composition root 装配具体 GitHub/Local adapter；domain 不反向依赖 adapter。窄 port 只在真实 I/O 或已有两种实现的边界建立，不演变成通用 Provider 插件平台。CLI/MCP 不承载业务逻辑，GitHub Adapter 不决定 Core 状态，不允许循环依赖。

模块体量立即采用 no-growth baseline：先为既有 façade 补齐 characterization tests，再随着 v3 纵向用例依次抽取入口路由、approval/recovery、lease/cleanup 和 Bootstrap；新职责从第一天起不得继续堆入旧 façade，但不要求先把三个大文件整体搬空。行数只是告警，真正硬标准是一个模块只能拥有一个生命周期责任、独立测试和窄入口。

## 4. 完整功能清单

## 4.1 Core：工程策略与跨 Agent 连续性

### C-01 安装 CLI、Skills 和可选 MCP｜已实现

**用户场景：** 开发者在一台新机器上安装 Harness，希望 Codex、Claude Code 和只支持通用说明文件的 Agent 使用同一套规则。

**当前能力：** `harness-automation install` 安装 Harness Skill、Worktree Skill 和可选 Claude MCP；CLI 是所有 Agent 的便携基线。`doctor` 只读检查 `~/.claude`、`~/.codex`、`~/.agents` 下的 Skill 是否 missing、stale 或 blocked。

**v3 目标：** 原样保留，不建设第二套安装器。安装只部署工具，不擅自接管具体仓库。

### C-02 批准 PRD、设计和调研输入｜已实现

**用户场景：** 项目负责人先完成需求和设计，再让 Harness 把确认过的决策变成工程约束。

**当前能力：** `research github`、`intake` 和 `discover` 会记录来源、负责人批准和 SHA-256；GitHub research 是候选发现，不把网络内容直接当指令。

**v3 目标：** 保留来源哈希和 owner 批准边界。PRD、设计、治理策略和任何新的有效 policy 语义必须来自用户批准的输入；独立第二 AI 只能审查这些输入是否被忠实编译和安全 Apply，不能自行发明或批准新的策略语义。

### C-03a 技术栈与 Agent 事实发现｜已实现

**当前能力：** 支持 `full-typescript`、`python-data-ai`、`go-performance`、`custom`；能发现 TypeScript、Python、Go、PostgreSQL、gRPC、Kubernetes 以及 portable、Claude Code、Codex 等 Agent surface。

**v3 目标：** 继续准确发现仓库事实，并把发现结果交给真实 adapter 或项目原生 gate。发现本身不等于执行约束。

### C-03b 已声明技术栈的可执行约束覆盖｜部分实现

**当前能力：** 已有规则覆盖唯一实现 owner 搜索、共享 contract-first、generated files immutable；TypeScript/Python/Go AST 命名；TypeScript/Prisma、Python/Pydantic/Django/Celery、Go/gRPC/数据库/generated schema 边界；Kubernetes schema、secret 和 immutable image 检查。只有 AST 等可执行检查属于 deterministic，合同设计等仍是 procedural/cognitive guidance。

**v3 目标：** 不是把“诚实降级”当成产品目标，而是把每一项**声称支持或强制**的能力落实成可执行功能。一个 stack/rule 只有同时具备可达 adapter、失败 fixture、自动化测试和项目实际 gate 绑定，才能标为 `supported/enforced`。优先复用仓库原生 lint、test、build、schema 和 CI gate；没有原生 gate 时才使用 Harness 自带的最小检查器。

`custom` 或未知技术栈仍可使用通用 Core，但不能获得未经实现的 stack enforcement 声明。这里的“诚实”只是防止虚假承诺的全局不变量；v3 的交付目标是扩大并验证真实覆盖，而不是长期停留在降级状态。

### C-04 不可变机器计划、独立审查与原子 Apply｜部分实现

**用户场景：** Harness 将要修改本地策略、Worktree 配置或远端治理设置，需要防止计划在检查后被替换，同时避免让用户审批不可读的 JSON。

**当前能力：** `plan` 默认只写不可变计划；`apply` 要求完整 `planHash`，执行前重验来源、目标和文件哈希，使用临时文件加 rename，并在中途失败时补偿本次写入。这已经实现机器完整性和本地原子写入，但“展示 JSON → 让用户复制哈希”的交互不能证明用户理解了变更，因此不再视为有效人工审批。

**v3 目标：** 保留 JSON plan、完整哈希、重验、原子 Apply 和 receipt 作为机器事务边界；移除人类复制粘贴哈希的默认流程。用户只审批可读的语义清单，系统自动绑定底层 `planHash`。由已批准输入确定性派生的普通可逆配置可由独立第二 AI 审查后自动 Apply；新的 policy 语义、protected actions、权限扩大、削弱保护、会丢弃既有内容和其他高风险动作始终要求用户明确批准。满足完整零损失证明的受管合并收尾属于已批准短生命周期 profile 的正常日常动作，不因会删除精确交付资产而重复询问。完整审查契约见 3.3。

### C-05 Check、Drift、Explain、Receipt 和安全 Rollback｜已实现

**当前能力：** `check --mode session|commit|ci` 分层运行可信检查；`drift` 比对策略和 Workspace；`explain` 解释单条 policy；`rollback` 只恢复 Harness 自己修改且之后未漂移的文件。回执持久记录计划、执行和证据。

**v3 目标：** 扩展到新治理对象。远端动作只能精确补偿 Harness 本次创建且尚未被后续使用的状态，不能把已合并代码或已被他人修改的 ruleset 伪装成完全可回滚。

### C-06 跨会话、跨 Agent 加载同一有效策略｜已实现

**当前能力：** `.harness/generated/effective-policy.md` 是可读摘要，`AGENTS.md` 是通用入口，发现 Claude Code 时可维护 `CLAUDE.md` 的受管区块；区块外内容不被覆盖。`context` 生成带 policy digest 的 session receipt。

**v3 目标：** CLI 继续是完整便携基线，MCP 和 Host Adapter 只是薄适配。

### C-07 已应用项目的精确版本升级｜已实现

**当前能力：** `update plan` 继承 owner、stack 和 orthogonal profiles，输出 exact compiler version、规则/评估语义差异、目标哈希及 Worktree compatibility。削弱规则时要求 owner 批准 weakening digest 和确切 rule IDs。

**v3 目标：** v3 schema 与治理迁移继续沿用；不得把本机 v2 lease 自动升级成远端唯一写租约。

### C-08 TypeScript 历史命名债务接管｜已实现

**当前能力：** 负责人可批准稳定 fingerprint baseline；后续只能消化已有债务，不能把新违规藏入 baseline。

**v3 目标：** 保留这个窄迁移，不泛化成“任意规则都能一键忽略”。

### C-09 旧 EDD 快照接管｜已实现

**当前能力：** `update legacy-eval-snapshot plan` 为缺少 evaluation snapshot 的旧 policy 创建明确 adoption 迁移，记录无法恢复的历史连续性，而不是伪造 pre-implementation 基线。

**v3 目标：** 保留。

### C-10 Eval-driven Development｜已实现

**当前能力：** Eval Contract 1.1 支持 Requirement → suite → rule traceability、runnerSources、baseline origin、known-bad negative control；eval runner 只在 CI mode 执行。Passing 和 enforced 分开报告，不合格的模型 grader 只能作为 guidance。

**v3 目标：** 保留为可选 quality profile。它约束产品行为质量，不代替 Branch/Worktree/Lease 治理。

### C-11 领域与交付 Profile｜已实现

**当前能力：** stack profile 之外可独立选择 `worktree-delivery`、`game-development`、`eval-driven-development`。Worktree profile 编译本机 audit/integration gate；Game profile 覆盖 deterministic replay、真实引擎 smoke、目标设备性能预算和内容来源；EDD 规则覆盖 eval contract、regression/negative-control gate、evidence provenance 和 model-judge calibration。

**v3 目标：** 新增仓库治理 profile 时沿用正交组合，不复制成多个产品版本。

### C-12 Legacy 启发式 Pre-scan｜兼容保留，不进入 v3 默认流程

**当前情况：** 早期 `code_scanner.ts`、`claude_extractor.ts`、`integration.ts` 和 `scan_cache.ts` 仍约 874 行生产代码，直接测试约 694 行（含 scanner fixture 测试约 878 行）。它们用正则扫描 `console.*`、`debugger`、直接 `fetch`、magic number、`any`、缺少 `try/catch` 的 async 等模式，并提取旧 `CLAUDE.md` 规则。

`scan_codebase` 只存在于 `HARNESS_ENABLE_LEGACY_V1=1` 的旧 MCP surface；当前 v2 CLI、`discover`、`plan`、`check` 和 Skill 都不调用它。因此它不是 v2.8.11 的正式当前能力，也不应被算作以后每个项目启动时必须运行的 pre-scan。

**v3 处理：** 从标准 Bootstrap 和默认安装 surface 中排除这套正则扫描器；仅在明确接管 legacy v1 项目时作为可选迁移诊断，且输出不得成为阻塞 gate。日常项目使用 v2 discovery、AST verifier、项目原生 lint/test/build/schema 与 CI。若没有真实迁移用户，后续直接删除 legacy scanner 比继续维护两套扫描体系更稳健。

### C-13 单会话 Bootstrap 与低上下文控制面｜待实现

**用户场景：** 新项目或旧项目第一次启用 Harness，不应经过数轮问答，也不应让治理说明占据大部分开发会话上下文。

**v3 目标：** 提供一个幂等入口：

```text
harness-automation bootstrap --project .
```

它在同一次运行中完成发现、tracking mode 判定、项目 gate 绑定、policy 初始化/升级、适用于当前模式的 Branch/Worktree/GitHub audit、reviewer 检查、安全变更 Apply、readback 和最终回执。首次配置发现 GitHub remote 时默认选择 `github`；没有 GitHub remote 也不能自动推断 `local-only`，必须把这项选择放入唯一的合并清单等待用户明确确认。再次运行时，已配置的 `trackingMode` 始终优先于 remote discovery；两者冲突只报告 `TrackingModeMigrationRequired` 并阻止新 Admission，不得静默切换或同时写两套事实源。其他 protected actions 也汇总在同一张可读清单，只询问一次；用户批准后在同一会话继续完成，不拆成多个子计划对话。批准只授权执行，不证明门禁已经可满足；完整 Delivery preflight 或 readback 缺失时最终状态仍必须是 `EnforcementPending`。

默认只向主会话输出状态、异常、待批准事项和最终清单；完整 plan、diff、review 和 receipt 落盘，需要排障时才用 `--verbose` 或读取 artifact。静默控制面不等于扩大授权：ruleset/workflow 等 protected actions 仍停在一次明确人类 gate。

### C-14 超大模块原子化迁移｜待实现

**v3 目标：** 立即冻结 `worktree/service.ts`、`v2/service.ts` 和 MCP/CLI 大入口的新职责增长，并补 characterization tests。随后沿 v3 实际触及的纵向用例逐步抽取入口路由、approval/recovery、lease/cleanup 和 Bootstrap；第一阶段保留 façade、公开 API 与行为，不同时重写业务语义。不是先做一次搬空所有大文件的大爆炸重构，也不引入微服务、动态插件系统或第二套状态库。

## 4.2 GitHub 治理与 Provider

### G-01 只读 GitHub Governance Audit｜已实现

**用户场景：** 团队想先知道默认分支、ruleset、required checks、CODEOWNERS、Actions、Environment 和 GitHub Project 配置映射的真实状态，而不修改 GitHub。

**当前能力：** `github audit` 输出确定性 blockers、warnings、unavailable evidence 和稳定 `observedHash`；不 fetch、不写 repo setting、不改 token scope。

**v3 目标：** 扩展观察 `allow_auto_merge`、`delete_branch_on_merge`、允许的 merge methods、auto-merge 可用性、短/长期 Branch 分类及长期 Branch 的删除保护。CODEOWNERS 只能证明配置存在，不能把 owner token 当成已完成真人审核。

### G-02 新项目 GitHub 治理 Profile｜待实现

**用户场景：** 新项目一旦连接 GitHub repo，就按项目性质配置共享入口。

**v3 目标：** 提供 Solo、Team、High-risk、High-throughput profile；执行固定流程：

```text
observe → semantic plan → deterministic/independent review
        → [protected actions: one explicit human approval]
        → preflight → apply → readback → receipt
```

本流程实现并引用成果01 §13.1 的八阶段治理写入规范，不在本文另造第二套事务。
这是本文唯一的治理写入阶段命名。Foundation/Enforcement 只描述治理激活范围；
其中的每个治理写入计划仍完整经过上述八阶段，不再使用另一套事务阶段别名。
同一 semantic plan 可以聚合同一合并清单内的多项写入；需要人类 gate 时，只要
对象、风险和计划内容未变，就只消费一次明确批准，不按 API 调用重复询问。

所有 profile 默认设置：

- `allow_auto_merge = true`；
- `delete_branch_on_merge = true`，但只让短生命周期交付 Branch 可被自动删除；
- 默认分支禁止直接 push 和 force-push；
- 变更必须经 PR；
- required checks 使用仓库实际存在的 exact check name 与 source App/Workflow identity，不能猜；
- 普通功能默认 Squash merge，Merge commit 可配置，Rebase merge 默认关闭；
- Actions 使用最小权限，emergency bypass 只能显式授权并留痕；
- review 要求、merge queue 和环境规则由 profile 配置。

Profile 必须显式声明长期默认/release/maintenance ref 或 pattern。GitHub 的自动删除是仓库级设置；官方文档明确说明 [branch protection 和 repository rules 可以阻止自动删除](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-the-automatic-deletion-of-branches)。因此，存在长期 Branch 时必须先对这些 ref 建立禁止删除的规则并 readback，之后才可启用 `delete_branch_on_merge`；规则尚未获用户批准或不可用时保持 `EnforcementPending`，不能用 Branch 名约定冒险。

`allow_auto_merge` 和 `delete_branch_on_merge` 属于用户已经批准的默认 GitHub 项目设置，可在权限、长期 Branch 删除保护、preflight 和 readback 均成立时静默对齐。现有未知 ruleset 只生成差异，不整体覆盖；削弱现有保护始终要求用户明确批准。

**Protected-action 硬边界：** Harness 未经用户对可读 before/after 清单的明确批准，不得创建、更新、删除或启用 GitHub ruleset、等价 branch protection 或 workflow。独立第二 AI 只能审查并指出风险，不能替代该人类 gate；历史上批准过某个 profile 也不能被解释为批准未来任意 workflow 内容。

空仓库采用两阶段 bootstrap，不能先用尚不存在的 check 名把自己锁死：

1. **Foundation**：建立默认分支，复用已有 CI；如果必须创建或修改 workflow，先把完整语义差异放入本次合并清单并取得用户明确批准；随后至少产生一次真实 check run；
2. **Enforcement**：先通过既有代表性交付，或用户批准且可精确回收的 canary，证明当前 profile 的 credential、Work Item、Coordination CAS、Branch push、PR 创建/readback 和独立恢复路径端到端可达；再在代表性 PR 事件上观察稳定的 check identity，验证 trigger 与 branch/path filter 覆盖范围，计划并启用 PR/ruleset/required checks，最终 readback 进入 Enforced。

如果 Harness 不负责生成该项目的 CI，Foundation 停在 `EnforcementPending` 并报告明确外部前提；不得把“计划目标是 required CI”误报成“仓库已受保护”。`allow_auto_merge` 可先配置；`delete_branch_on_merge` 只有在所有现存 Branch 都已分类、且每个长期/未接管 Branch 的远端删除保护成立后才可配置。没有真实 checks 时不能武装具体 PR 的 auto-merge。

激活任何 approval/check 要求前必须证明存在可满足路径：Solo 的 required approvals 固定为 0；Team 配置为 `≥1` 时必须观察到足够的合格非作者 reviewer，否则保持 `EnforcementPending`，不得静默降为 0。High-risk 优先使用合格非作者 reviewer；确实无人可用时，只能采用预先明确的人类 owner 风险接受路径，并把服务端 required approvals 设为 0，不能写入不可满足的规则。Required approvals 大于 0 时必须启用使批准绑定当前 diff/Head 的平台规则。Required check 必须绑定 exact name + source App/Workflow，在代表性 PR 事件上真实成功，并证明 trigger、branch filter 和 path filter 不会让受保护变更完全不产生该 check。

Satisfiability 不是一次性 Bootstrap 事实。激活 gate 前必须证明至少存在一个不依赖该 gate 的授权恢复主体/路径，并证明当前 profile 的 credential、Work Item、Coordination、Branch push 与 PR 路径端到端可达；以后在 `bootstrap`、`github audit`、governance drift 和武装 merge 前重新验证 reviewer、权限、check identity、trigger/filter 与恢复路径。已激活 gate 后发生漂移时，覆盖状态不变，enforcement 降为 `EnforcementPending`；在下一次 Provider 事件、受管 audit/drift 或 merge readback 发现后，为受影响 Delivery 附加 `Blocked`，停止新的 merge 武装，并按 D-06 安全撤防已处于 `MergeArmed` 的 PR。Harness 不自动降低保护，用户通过已验证 recovery path 明确修复；没有 webhook/daemon 时不宣称墙钟时间上的即时发现。

### G-03 旧项目统一 Governance Bootstrap｜部分实现

**当前原语：** 已有 `github audit`、`worktree status/audit`、`adopt`、`migrate` 和 policy update，但没有一个统一入口把 Branch、Worktree、repo settings 和凭证接管串起来。

**v3 目标：** 旧项目和新项目共用一个便携、幂等入口：

```text
harness-automation bootstrap --project .
```

Skill 可以把 `/harness-automation governance` 作为兼容自然语言入口，但底层不能依赖某个 Agent 才支持的 slash command。Bootstrap 先在同一会话完成只读盘点；所有既有对象映射、legacy adopt、目录迁移、tracking mode 迁移、长期/交付 Branch 分类和进入 Enforced 的目标都汇入同一张人类语义清单。用户批准后，本次运行才继续执行这些动作、安全 Apply 和 readback；该批准只授权尝试，仍必须通过 G-02 的完整 Delivery preflight 和治理 readback 才能实际进入 Enforced。启用仓库级 `delete_branch_on_merge` 前，所有现存 Branch 必须被分类为“可删除的受管交付 Branch”或“不可删除的长期/未接管 Branch”，后者必须先有远端禁止删除规则并 readback；存在未知或未分类 Branch 时保持全局设置关闭，标记 `EnforcementPending`，受管交付 Branch 仍可按 exact merge 事实由 Harness 精确清理。以后新增长期 Branch 也必须先获得同等保护并 readback，才能作为 PR head 使用。未批准任何 v3 接管时保持 `AuditOnly`，v3 只允许 observe、report、plan 和 receipt；只批准精确子集时进入 `Mixed`，仅该子集可变更，歧义或独有对象继续不受管。用户显式调用的 v2 compatibility 操作仍按 6 节边界处理，但不得被 Bootstrap 冒充为 AuditOnly 下的“安全初始化”。失败时也不反复生成新计划要求用户批准。

阶段术语按作用域分开：成果01旧项目接管的四阶段是 Bootstrap 人类运行阶段，
G-02 的八阶段是唯一治理写入事务，P0 编号是产品实现依赖顺序。Bootstrap 阶段四
调用 G-02 流程；三者不按编号互相映射，也不构成三套状态机。

### G-04 Work Item 创建与 GitHub Project 登记｜部分实现

**当前原语：** Session 和 Worktree 模块能读取 GitHub Issue/GitHub Project、验证映射并更新项目字段；仓库自己的 `scripts/github_tracker.py` 能创建 Issue，但它不是 npm 产品能力。

**v3 目标：** `github` 是连接 GitHub repo 时的默认 tracking mode。Tracking/GitHub 通过窄 GitHub Adapter 的 `gh`/`gh api` 能力创建、验证和更新 Issue、GitHub Project；Delivery 负责 PR 生命周期，Git ref 继续使用 `git`。Issue 是任务事实源，配置的 GitHub Project 是默认工作流视图，PR/commit 通过原生关系追踪。组织仓库默认使用同组织 GitHub Project；个人 GitHub Project 只作显式兼容例外。无需 GitHub Project 的 profile 可以只使用 Issue。

GitHub-backed 新工作如果无法创建或验证 Issue、无法取得远端租约，应 fail closed，不先写代码。GitHub 暂时不可用时也不能悄悄切换为 `TASK.json`，否则会形成两个事实源；恢复后继续同一个 GitHub Work Item。

### G-05 GitHub Provider 的统一边界｜部分实现

**当前情况：** Issue/GitHub Project、PR/merge、repo audit 分布在 Worktree、Session、Delivery 和 GitHub 模块；可以工作，但没有共享远端交付记录或租约。

**v3 目标：** 统一 GitHub 身份、repository ID、base/head repository、Issue、PR 和远端协调状态。Core 只依赖当前 GitHub 与 Local-only 两种真实模式所需的最小动作，不直接散落 GitHub API 拼接，也不为假想 Provider 建通用插件框架。

### G-06 Local-only Tracking｜部分实现

**用户场景：** 用户明确声明项目不上 GitHub、只在本地运行，仍需要可复现的任务和变更追踪。

**当前原语：** npm 包已携带 `scripts/task.py` 和 `scripts/changelog.py`，可操作 `TASK.json` 与 `CHANGELOG.jsonl`，但它们目前只通过 legacy 脚本部署路径交付。两者都会整文件重写且缺少原子 rename 与并发锁；`task.py` 对部分异常结构退回空列表，`changelog.py` 会静默跳过损坏 JSONL 行，因此都缺少严格 schema/corrupt-input fail-closed。仓库自己的 `scripts/github_tracker.py` 是本仓库维护工具，不是通用产品 adapter。

**v3 目标：** 只有用户明确选择 `local-only` 时，才把 `<git-common-dir>/harness/local-tracking/TASK.json` 作为任务事实源、同目录的 `CHANGELOG.jsonl` 作为变更事实源，并安装两份内置、版本化的操作脚本。脚本必须通过 `git rev-parse --git-common-dir` 定位同一权威存储，在 common dir 使用同一把锁；Agent 必须调用脚本，不得临时现写替代品。Worktree 根若为兼容性保留同名文件，只能是只读导出，不能接受写入。正式启用前补齐原子写入、锁、输入验证、损坏数据 fail closed 与跨 Worktree 单一事实源测试。Local-only 使用 common-dir work-item lease 与缩短的 Delivery 状态路径，不宣称提供 GitHub PR/GitHub Project、远端 Closing，或跨 clone、跨机器权威租约。

各 Work Item 的 common-dir work-item lease 只隔离各自 Delivery Branch，不能串行化多个工作项对同一默认/目标 Branch 的集成。Local-only 还必须提供目标-ref 集成锁；该锁存放于 Git common dir，绑定 expected base/source SHA，要求管理 checkout 安全，并用 ref CAS 固化 exact integratedCommit。锁冲突、目标漂移或 checkout 不安全时保持 `Ready + Blocked`，不得更新目标 ref。

当前 schema 中的 GitLab/Jira 值只保留清晰的 unsupported/deprecation 诊断，不进入 v3 路线图；等出现真实端到端用户需求时重新立项，而不是现在预建 Provider 抽象。

### G-07 远端权威写租约｜待实现

**用户场景：** 张三、李四、王五在不同机器上使用不同 Agent，系统必须防止两个遵循 Harness 的客户端同时把自己当作同一 Issue 的主写者；没有服务器端 enforcement 时不承诺阻止恶意绕过。

**当前差距：** v2 `WorkspaceLease` 保存在每个 clone 的 Git common dir，只含本机 heartbeat 等信息；另一台机器看不到它。

**v3 目标：** Coordination 通过窄 GitHub Adapter 执行原子 compare-and-set，并管理至少这些字段；字段顺序只是统一展示，不构成 schema 不变量：

- repository；
- workItem；
- branch；
- sourceRepositoryId（承载交付 Branch 的不可变 Provider repository ID；非 fork 时等于受管 repository 的 Provider ID）；
- owner；
- machine；
- sessionRef（可选；宿主会话或 workspace 的不透明引用，不作为身份或权限证据）；
- generation / fencing token；
- controlEpochDigest；
- createdAt；
- expiresAt；
- lastObservedHead；
- lifecycleState（成果01 §9.1 定义的 Delivery 主状态持久化投影）；
- closeOwnerGeneration（仅 terminal claim 建立后；固定被接管的写 generation）。

`createdAt` 和 `expiresAt` 使用 Provider 服务端时间。`lifecycleState` 的合法值、不可达模式与排除项以成果01 §9.1 为唯一权威，本文不新增 enum。Terminal claim 是 `lifecycleState=Integrated` 时协调记录形成的无写权限、无 TTL 形态，不是另一个 schema 字段或 enum 值，也不是 `closeOwnerGeneration` 的别名；后者只记录该终结责任冻结的写 generation。

没有服务器端 push/token enforcement 时，必须把保障级别标成 **coordinated**，不能宣称已经硬性阻止恶意或绕过 Harness 的直接 push。

客户端必须使用安全裕量，只能在服务端到期时间之前提前停写，不能用本机时钟延长租约。Provider 失联时不得续期、转交、Ready、合并或启动清理。generation/fencing token 隔离主写者代次，`controlEpochDigest` 隔离协议、policy 和 config 纪元，二者不可互换；transfer/takeover 必须增加 generation，除首次获取以 generation 不存在为 CAS 前提外，每次受管状态 CAS、写入和 push 都必须同时验证预期 generation 与 `controlEpochDigest`。纪元改变后，活动 atom 必须通过显式兼容迁移，否则保持 Blocked，旧客户端不得按旧 schema 继续操作。

精确观察到 Integrated 时，Coordination 必须以 CAS 把匹配的 generation/integratedSourceHead/controlEpochDigest 从可写 lease 转成 terminal claim：它立即撤销写入、续租和转交，且不会随原 lease TTL 消失，只保留安全快照、Recovery 和 Closing 的唯一责任。原 lease 已到期不应阻断转换，只要远端仍是同一 generation/head/control epoch 且没有新 owner；claim 缺失或冲突时保持 `Integrated + RecoveryRequired`，不得为了清理重新签发写租约。Local-only 在 Git common dir 中的 Closing journal 采用同一语义。

租约存储是 Provider 协调元数据，不应实现为额外的用户功能 Branch，否则会重新制造 Branch 列表噪音和误删风险。

这是 v3 的关键可行性门：普通 Issue assignee、label 或 GitHub Project 字段若没有可靠条件更新，就只能作展示镜像。实现前必须证明 GitHub 原生能力能提供 CAS/等价原子语义；不能用“先读再写”冒充唯一租约。系统无法证明 GitHub 项目永远只有一个 clone，因此 CAS 不可行时，新的 v3 Delivery 最多停在 `Admitted + Blocked + CoordinationBackendRequired`：已经创建或验证的 Issue 可以保留，独立获批的 Governance Foundation 也可按自身事务边界继续，但不得创建 Delivery Branch/Worktree、push、PR、Ready 或 merge，也不得宣称 v3 Delivery 已受管。只读 tracking/governance 和明确的 v2 compatibility 操作仍可用；系统不得静默切到 Local-only 或引入第二个协调服务/状态库。是否扩大产品边界建设该后端，届时作为独立架构决策交由用户批准。

## 4.3 本机 Workspace、Branch 与 Worktree

### W-01 只读状态与审计｜已实现

**当前能力：** `worktree status/audit` 观察注册 Worktree、Branch、dirty、unique commits、unpushed commits、lease 映射、TTL、容量、保护根和 Provider 状态；只读命令不要求先有 PRD。

**v3 目标：** 作为新旧项目 Governance Bootstrap 的底层能力保留。

### W-02 管理 Checkout 与本机安全根｜已实现

**当前能力：** portable policy 存 `.harness/worktree-delivery.json`，机器专属 allowed/protected roots 和 topology 存 Git common dir；每台机器必须批准自己的 host binding。

**v3 目标：** 管理 checkout 长期存在，默认停在管理分支，用于同步、集成、发布和治理，不承担普通功能开发。

### W-03 新项目 Container 布局｜已实现

**当前能力：** `container-v1` 支持 `<container>/main` 管理 checkout 和 `<persistentWorktreeRoot>/<work-item-id>`；allocation 确定性派生路径。

**v3 目标：** 保留实现，但用户文案统一称“交付 Worktree”，避免把 `persistent` 误解成长期不清理。这里的持久仅表示跨会话保留到交付结束。

### W-04 旧平铺 Checkout 迁移｜部分实现

**当前能力：** `worktree migrate` 有不可变计划、独立 apply 和 receipts，但执行器有意只支持唯一 primary checkout、没有现存 lease/worktree 的窄安全前提。

**v3 目标：** 保留窄实现；任何既有目录迁移都进入 Bootstrap 的一次人类语义清单，批准后才执行。复杂旧项目只生成阻塞原因和人工计划，不扩张成自动文件搬家工具。

### W-05 为一个 Work Item 创建 Branch、Worktree 和 Lease｜部分实现

**当前能力：** `worktree allocate` 在 v2 `enforced` 工作区模式下校验工作项、路径、Branch、容量、Host Binding 和 Provider 映射，再通过 plan/apply 创建 Branch、Worktree 和本机 lease。

**差距：** 它只能保证当前 clone 内的一对一，不能证明另一台机器没有相同 work item；默认 `startPoint` 又是本地 `HEAD`，命令不会 fetch 或证明目标基线等于最新远端 SHA。

**v3 目标：** 复用现有本机创建逻辑。GitHub 模式下 Prepare 先 fetch/readback 目标 ref，从精确远端 SHA 创建 Branch，并在 Apply 前取得远端 generation；本机 lease 降级为远端状态的缓存和恢复证据。Local-only 从用户已选定的本地 base ref 创建 Branch，只建立 Git common dir 内有效的 common-dir work-item lease；它不能协调同一机器上的另一个 clone。管理 checkout 只有 clean 且可 fast-forward 时才更新。

### W-06 接管宿主或用户已创建的 Worktree｜部分实现

**当前能力：** `worktree adopt` 能批量接管已注册 Worktree，哈希锁定 dirty 内容，在失败时只补偿本轮写入的 leases；它不会 add/remove Worktree、切 Branch 或改 working tree。

**v3 目标：** Codex 等宿主在同一次 Prepare 中按 exact plan 新建的 Worktree 可走同一自动 adopt 路径，并增加 mode-appropriate lease/delivery identity 冲突检查；任何 Prepare 之前已存在的 legacy Worktree 映射/adopt 都必须进入 Bootstrap 的一次人类清单。不要为每个宿主复制一套 Git 接管逻辑。

### W-07 Rebind、Renew 与本机 HEAD 快照｜部分实现

**当前能力：** `worktree rebind` 更正 Branch 映射，`renew` 更新本机 heartbeat 和当前 HEAD，均经过 plan hash、drift 检查和 receipt。

**v3 目标：** GitHub 模式的 Rebind/Renew 都由当前 generation owner 先做远端 CAS，再更新本机缓存；Local-only 只以 CAS 或等价原子条件更新 common-dir work-item lease。Head 或控制面变化使绑定旧输入的当前态证据不再授权后续转换，但历史 receipt/审计证据继续保留。`acceptedCommit` 应迁移为 `lastObservedHead`，因为正常开发中的 HEAD 不是“已验收提交”。

### W-08 跨机器 Transfer 与 Takeover｜待实现

**v3 目标：**

- 正常转交：当前 owner 先冻结写入并取得耐久交接快照，证明 tracked 内容 clean、没有未解释的 untracked/ignored、unique 或 unpushed 内容，且 exact 远端 Head 可由接收方取回；随后才以单次 CAS 将 generation 转给新 owner/machine；
- 交接快照不完整时保持 `HandoffPending + Blocked`，不移动 generation；旧 owner 先提交/推送或显式处理资产，不能把普通 transfer 静默降级成 takeover；
- 租约到期接管：若旧机器离线或可能仍有未推送内容，先把证据与风险放入一次人类语义审批；批准后新 owner 才能原子增加 generation；
- 旧 token 随 generation 变化失去写资格，只允许救援审计和保存本机内容；
- 断网、过期或接管绝不删除旧机器内容；
- 无法确认远端状态时只允许保存和只读诊断，不允许继续受管 push。

### W-09 只读 Integration Check｜已实现

**当前能力：** `worktree integration-check` 使用隔离的 native `merge-tree` 预测与本地目标 ref 的冲突；不 fetch、不 checkout、不 merge、不 rebase、不运行测试。dirty、unpushed、mapping drift、冲突会阻塞，单纯 behind 只警告。

**v3 目标：** 原样保留。它是预测证据，不是自动修改历史的授权。

### W-10 Detached Review Worktree｜已实现

**当前能力：** `worktree review --commit <sha> -- <command>` 在系统临时目录以 detached HEAD 运行固定 SHA；clean 立即回收，dirty 则 fail closed，记录路径、大小、SHA-256、patch digest 和 durable receipt。

**v3 目标：** 原样保留，用于测试、review 和复现；不得把 Review Worktree 升格为第二主写者。

### W-11 Retention Audit｜已实现

**当前能力：** `retention-audit` 只读检查临时 Review、locks、receipts 和残留远端分支，可按 host-global 或 exact project/common-dir scope 过滤。

**v3 目标：** 时间只触发审计，不构成删除授权。

### W-12 独立 AI Review 执行面｜部分实现

**当前能力：** `worktree apply-ai` 可让隔离、只读的 Claude CLI reviewer 审查受允许的 Worktree operation，确定性 preflight 仍不可绕过。这证明了“主 Agent 之外的模型审查”可行，但只覆盖 Worktree、只支持 Claude，并未实现 3.3 的统一 plan reviewer 契约。

**v3 目标：** 将它收敛为统一 Reviewer Adapter：Provider、模型 ID、凭证、超时和数据范围可配置，MiniMax-M3 可作为首个候选配置但不写死；首次配置及任何信任/数据范围变化都要用户明确批准。所有准备自动批准的实质性 mutating plan 都先经过该独立 reviewer；纯只读动作、租约 heartbeat 和已经由确定性 CAS 完全限定的幂等日常动作可由 profile 明确豁免，避免为无判断空间的操作浪费模型调用。reviewer 永远不能修改计划、取得 admin credential 或替代 protected-action 的人类批准。

### W-13 容量与受保护路径｜已实现

**当前能力：** `maxPersistentWorktrees`、allowed root、protected root、management branch、路径归一化和映射审计已实现。

**v3 目标：** 保留。容量上限触发整理或拆分，不授权删除。

### W-14 本机 `recover`｜已实现

**当前能力：** v2 `worktree recover` 只删除精确的 clean、detached、unleased 残留 Worktree，保留 Branch。

**v3 目标：** 保留旧语义并明确命名为本机残留回收；Closing journal 的幂等续跑由 L-05/L-06 负责，跨机器写资格恢复使用 `lease takeover` 或等价新命令，不能静默改变 `recover` 的含义。

## 4.4 Session 与 Host Adapter

### S-01 新会话加载策略上下文｜已实现

**当前能力：** `context --agent auto|portable|claude-code|codex` 返回有效策略和 session receipt，引导 Agent 先读 policy、搜索既有实现并在结束前 check。

**差距：** 它不判断当前目录是不是管理 checkout，也不检查当前工作对应哪个 Issue、Branch、Worktree 或 lease。

### S-02 新会话首次工作意图准入｜待实现

**用户场景：** 开发者打开“项目 → 新会话”，直接说“增加导出功能”，却忘了选择新 Worktree/Branch。

**v3 目标：** 新会话的第一次可能写代码的意图必须分类：

- 只读问答/诊断：允许留在当前 checkout；
- 继续已映射工作：恢复现有交付原子；
- 新功能或会改代码的修复：在任何代码变更前进入 Prepare；
- 意图不清：先保持只读，问一个会改变工作路径的必要问题。

老会话不在每轮重复做自然语言分类，只在 `cwd/Branch/HEAD/lease/work-item` 变化、准备 push 或准备交付等事件触发确定性复核。

准入结果默认只向会话注入一条紧凑状态（例如 `read-only`、`continue #123`、`prepare required`），不注入整份 Branch/Worktree/GitHub 治理说明；详细证据保存在 receipt 中，只有异常或用户主动询问时展开。

没有 Host pre-write hook 或文件权限隔离时，Harness 只能阻止受管命令并通过 Skill 约束 Agent，不能声称从操作系统层面拦住任意文件写入；有真实宿主拦截点后再升级为 hard gate。

### S-03 一次确认后的 Delivery Prepare｜待实现

**v3 目标：** 用户确认一次后，Harness 尽可能完成：

```text
创建/验证当前 tracking mode 的 Work Item
→ 获取该模式要求的写租约
→ 创建或验证 Branch
→ 创建或接管 Delivery Worktree
→ 写入本机映射和 seed
→ 由 Host Adapter 打开目标会话，或返回 PreparedNotOpened
```

GitHub 模式对应 Issue + 远端租约；Local-only 对应 Git common dir 中的 `TASK.json` 条目 + common-dir work-item lease，且只协调共享该 common dir 的 Worktree，不承诺跨 clone 或跨机器隔离。任何一步失败都不能在管理 checkout 里继续写功能代码。已经存在的合法对象应复用，不重复创建。

整个 Prepare 对主会话表现为一次事件：成功时只返回 Issue、Branch、目标 Worktree/任务和状态；失败时只返回阻塞点与恢复动作。内部 audit、plan、review、credential 注入和 receipt 不逐项占用对话上下文。

### S-04 Session Handoff、Status 与 Seed｜已实现

**当前能力：** `session handoff` 两阶段生成并验证 `docs/HANDOFF-<issue>.md`，校验必填段落、占位符、引用路径和 receipt ID；稳定 doc hash 生成幂等 receipt，并能更新 GitHub Project 状态。`status` 只读，`seed` 只渲染接续提示。

**v3 目标：** 保留并接入交付原子；状态写入通过当前 Tracking 能力完成，GitHub 更新 Issue/GitHub Project，Local-only 更新 `TASK.json`，不让 Session 自建第三套事实源。Handoff 的 `ready-for-review` 只表示会话交接状态，不能等同 PR 的 Delivery Ready。

### S-05 Host-native Worktree 任务｜部分实现

**当前原语：** 通用 adopt 能验证和接管已存在 Worktree；当前没有 Codex/Claude 专用的“创建并打开目标任务”产品适配。

**v3 目标：**

- 宿主能创建 Worktree 时：Host Adapter 请求创建，Core 验证/adopt；
- Host Project 继续按 repository identity 归组，具体任务绑定精确 Worktree path；
- 宿主只能创建目录而不能切当前会话时：返回新路径和 seed；
- 宿主没有 API 时：明确返回 `PreparedNotOpened`，用户在目标目录新开任务；
- 不谎称 Harness 已经把当前会话 cwd 自动切过去。

### S-06 同目录多个 Local 会话｜明确不做并行写隔离

两个 Local 会话若指向同一个 checkout，它们共享同一 `.git` 状态、Branch、index 和 working tree。A 会话切 Branch 后，B 会话看到变化是 Git 的正常行为，不是会话隔离失效。

v3 只允许两种用途：

- 同一项工作的串行接续；
- 多个只读观察者。

两项功能并行写必须使用不同 Worktree。多个会话同时主写同一工作项不受支持；需要真实并行时拆分 Work Item。

### S-07 Session Fork｜明确不做自动交付 Fork

Fork 会话只复制上下文，不自动产生新 Issue、Branch、Worktree 或写租约。只有用户明确申请新工作，才创建新的交付原子。

## 4.5 Delivery、PR、CI 与合并

### D-01 精确 Delivery Authorization｜部分实现

**当前能力：** `delivery authorize` 将 Work Item、不可变用户授权来源、允许路径、名为 `policyHash` 的 Worktree delivery config/legacy binding digest、remote endpoint hash、base/feature SHA、能力和 supersession 写入 Git common dir。它当前没有绑定 `.harness/policy.yaml` 的 effective-policy digest。后续动作形成 receipt hash chain。

**差距：** 授权没有绑定远端 lease generation，无法证明当前机器仍是跨机器主写者。

**v3 目标：** 每个写动作都验证当前模式的 lease、Branch、Head 和 scope；GitHub 额外验证远端 generation/fencing token 与 endpoint。授权分别绑定 effective-policy digest 与 workspace/governance config digest，并与远端协调记录中的 `controlEpochDigest` 一致；旧 authorization 不自动获得新权限，epoch 变化后的活动 atom 必须显式兼容迁移或保持 Blocked。

### D-02 受约束 Push｜部分实现

**当前能力：** `delivery push` 要求 clean Worktree，校验 scope/endpoint/remote ref drift，push 后重读远端 Head 并写回执。

**v3 目标：** 在现有检查前增加远端 lease 验证。没有 server-side enforcement 时，将直接绕过 Harness 的 push 明确列为规则不能完全阻断的边界。

### D-03 一个工作项最多一个主 PR｜部分实现

**当前能力：** `delivery pr` 会查找同 base/head 的唯一 open PR，多个结果时拒绝歧义；没有则创建 PR，并确认 PR Head 等于当前 Head。

**差距：** PR identity 没有进入共享远端交付状态，fork repository identity 处理也不完整。

**v3 目标：** 在远端交付记录中永久绑定不可变 PR identity：PR number、base/head repository ID 与 base/head ref；查询 open/closed/merged 全状态并跨机器复用同一 PR。开发中的可变 Head 只写 `lastObservedHead`，Ready 固化 `readyHeadSHA`，精确合并后才固化 `integratedSourceHead` 与 `integratedCommit`，不能把任一可变 Head 当作永久 PR identity。PR closed-unmerged 时优先重开同一 PR；无法安全重开则进入 Recovery/Abandon，或由用户建立新的 Work Item，不得为原工作项自动创建第二个主 PR。

### D-04 首次有效 Push 后建立 Draft PR｜部分实现

**当前情况：** v2 创建的是普通 PR，请求没有 `draft=true`；命令名虽为 upsert，但对已存在 PR 不更新标题和正文。

**v3 目标：** 第一次有意义的受管 push 后创建或更新 Draft PR。若一个小工作在首次 push 时已经满足全部 Ready 条件，可以在同一事务中直接创建 Ready PR 或立即完成 Draft → Ready；两条路径都必须绑定同一 exact Head 和完整证据，不能因跳过持久 Draft 状态而跳过门禁。

### D-05 Agent 声明开发完成与 Ready Head｜待实现

**v3 目标：** 提供统一 `delivery ready`（名称可在成果03调整），要求：

- 验收项逐条有证据；
- 验收标准明确，不存在未完成项或已知缺陷；
- profile 声明的 Ready gates 已通过；项目本地 lint/test/build 等确定性检查默认属于此类；
- Branch、Worktree 和当前模式的 lease 映射有效；
- 预期内容均已提交；GitHub 模式还必须全部推送；
- 没有未解释的 dirty、untracked、ignored 内容或集成冲突，改动范围符合授权；
- GitHub 模式的 PR identity 唯一且 Head 等于 `readyHeadSHA`；Local-only 的 Branch Head 等于本地 `readyHeadSHA`；
- 当前模式要求的 lease 仍有效；
- 风险 profile 要求在 Ready 前成立的人类 gate 已满足并绑定当前 Head：GitHub 可以 readback 已经完成的平台批准，Local-only 写 Harness receipt。

门禁由风险与 profile 中的 gate phase 决定，不由 tracking mode 决定。普通风险任务在 GitHub 和 Local-only 都可由主 Agent 自主声明开发完成；高风险、验收含糊、存在已知缺口或成果01列明需人工判断的任务，必须在 Ready 前获得人类证据。GitHub required checks 默认是 integration gate，可以在 Ready 后继续 pending，但必须由平台阻止实际合并；只有 profile 显式把某个远端 check 分类为 Ready gate 时才要求它在 Ready 前成功。普通 Team profile 若把 reviewer 明确定义为集成门禁，也可以在 Ready 后、MergeArmed/merge 前由平台满足；这不等于绕过 GitHub ruleset 或 CI。

GitHub 模式进入 Ready 时，必须先绑定 exact `readyHeadSHA`，再创建或将同一 PR 标记为 ready-for-review 并 readback；任一步失败都不得进入 Ready，已有 PR 则保持 Draft。Local-only 没有 PR，只记录本地 Ready 证据。

### D-06 Head 变化使 Ready 失效｜待实现

任何新 commit、force update、base/head mapping、policy/scope 或 `controlEpochDigest` 变化，都必须使绑定旧 Head 的验收证据、Harness/AI review、Ready 和 `MergeArmed` 全部失效，并回到 Active/Draft 重新产生证据；epoch 不兼容时保持 Blocked，不能自行重写远端状态。平台 human approval 也必须重新 readback，只有能证明绑定当前 Head 时才可复用；不能把旧 Head 的批准平移到新代码。

受管客户端在 `MergeArmed` 后准备 push 时，必须先保持 `MergeArmed + Disarming + Blocked` 和写冻结 → 对 exact PR/Head 调用平台禁用 auto-merge → readback 已禁用且 PR Head 仍是旧 `readyHeadSHA` → 再以远端 CAS 退回 Active/Draft 并使旧 Ready 证据失效 → 最后才允许 push。禁用结果不确定时保持冻结并继续 readback；若平台已合并，则直接观察为 Integrated。不能先退出 `MergeArmed` 留出仍可自动合并的窗口，也不能等 push 后再补偿。不得依赖 GitHub 因新 commit 自动撤防：[GitHub 官方文档](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/automatically-merging-a-pull-request)只明确保证无 write 权限者推送时会禁用 auto-merge，因此所有受管 push 无论 actor 权限都必须显式禁用并 readback。绕过 Harness 的直接 push 按 `PolicyViolation`/drift 处理。v2 目前能检测部分 Head、workspace config、scope 和 endpoint drift，但没有 effective-policy binding 或 `readyHeadSHA` 生命周期。

### D-07 Required Checks 证据｜部分实现

**当前能力：** `delivery merge` 在直接合并前调用 GitHub required checks，并要求全部 `SUCCESS`。

**v3 目标：** Required check 的 identity、trigger/filter 覆盖和可满足性始终是治理前提，但一次 check run 的结果按 profile phase 处理：Ready gate 未成功则阻止 Ready；默认的 GitHub integration gate 可以在 Ready 后仍为 pending，并由平台阻止实际合并，Harness 直接 merge 则必须等其成功。`MergeArmed` 可以在结果 pending 时建立，前提是平台已 readback 确认该 required check 会约束当前 PR；check 不存在、identity 漂移或根本不会触发属于配置缺失，会阻止武装。Required check 必须复用 G-02 已验证的 exact name、source App/Workflow、trigger 和 branch/path filter 身份，不能在 Delivery 阶段退回为只按名称匹配，也不由本地一次查询独占最终合并决定。

### D-08 GitHub Auto-merge｜待实现

**v3 目标：** Ready 后按 profile 武装 GitHub auto-merge；只有已退出 Draft、PR Head 仍等于 `readyHeadSHA`、当前 governance gate 可满足且平台 readback 成功时才能进入 `MergeArmed`。`MergeArmed` 冻结受管 push，修改代码必须先按 D-06 有序退回。GitHub ruleset、review、required checks 和可选 merge queue 决定何时实际集成；未启用 auto-merge 的项目仍可由人类在平台合并。

### D-09 v2 Checks-green 直接 Squash Merge｜兼容保留

**当前能力：** 当 authorization 的 `mergeMode=checks-green` 时，`delivery merge` 验证 PR、Head、mergeable 和 required checks，然后直接调用 GitHub merge API，固定 `merge_method=squash`，最后重读 PR 验证。

**边界：** 该 REST merge 请求仍受 GitHub 服务端 branch protection/ruleset 约束，不能描述成天然绕过平台门禁；但当前 Harness 不验证远端 lease、Ready/`readyHeadSHA`、调用凭证的 bypass 权限或 merge queue 语义。

**v3 目标：** 推荐路径是 Ready 后武装 auto-merge。满足服务端门禁的显式直接 merge 可作为 profile 允许的非默认路径，但必须绑定 exact Head、有效租约、Ready 证据和无 bypass 的受限凭证，并在调用后 readback。

### D-10 CI 基础设施失败重试｜部分实现

**当前能力：** 已有确定性/基础设施/未知失败分类和基于 Head、run、workflow、job、check、step、attempt 的重试预算判断。

**差距：** 没有公开命令真正执行重试，不能把分类函数宣传成完整自动重试功能。

**v3 目标：** 只有在同一 Head、明确基础设施错误和有限预算下才可接入最小执行；测试、lint、权限或未知失败不自动重试。

### D-11 后台自动 Rebase/Merge Main｜明确不做

v2 authorization 类型中的 `controlledRebase` 只是能力字段，没有可达执行；v3 不补齐后台 rebase 机器人。只保留 read-only integration check，冲突由主写者显式解决并重新验证 Ready。

### D-12 观察 Integrated｜部分实现

**当前能力：** v2 直接 merge 后会重读 PR，Worktree close 能证明普通 ancestry merge 或 GitHub exact squash merge。

**v3 目标：** Delivery 通过窄 GitHub Adapter readback，并分别记录 `integratedSourceHead`、base、PR、`integratedCommit`、merge method 和 observed provider time；Adapter 不拥有状态转换。Integrated 表示预期源 Head 被预期 PR 的精确合并事件接受，不表示该 Head commit 必须出现在目标 Branch ancestry 中；Squash 必须依赖 exact PR merge 证据。本地机器不能仅凭 Branch 名或“看起来已合并”进入清理。

Local-only 不使用 Provider merge event；它必须在目标-ref 集成锁下绑定 expected base/source SHA，以 ref CAS 产生 exact `integratedCommit`。工作项 lease 本身不能替代目标-ref 集成锁；锁冲突、目标漂移或管理 checkout 不安全时保持 `Ready + Blocked`。

若 Provider 精确证明预期 PR/integratedSourceHead 已合并，Integrated 是外部事实，可以从任何尚未集成的 Delivery 状态进入；若此前未满足 Ready，或绕过当时 profile 要求的集成门禁，则同时附加 `PolicyViolation`（reason=`OutOfBandIntegration`）、冻结继续写入，并仍按完整关闭前安全检查收尾。`MergeArmed` 本身可选：从 Ready 经满足服务端门禁的人工/平台合并不因未武装 auto-merge 而违规。若只有直接 push、普通 ancestry 或 PR 没有显示 merged，则证据不足，进入 `RecoveryRequired` 而不是 Integrated/Closing。

## 4.6 合并后精确关闭与残留治理

### L-01 普通 Merge 与 GitHub Squash Merge 证明｜部分实现

**当前能力：** 普通 merge 使用 ancestry；GitHub squash 使用 exact merged PR 的 repository、base、head 和 SHA 证据。只知道 Branch 名相同不够。

**差距：** v2 的普通 ancestry 证明可以单独放行 close，不满足 v3 对 exact integration event 的要求，因此不能标为已实现或原样复用。

**v3 目标：** 接入统一 Integrated 事件，分别固化 `integratedSourceHead` 与 `integratedCommit`。GitHub 普通 merge 的 ancestry 只作辅助校验，必须与 exact PR/Provider merge event、目标 Branch 和预期源 Head 身份组合；ancestry 单独不能触发 Integrated 或清理，Squash 也不得使用 ancestry 代替 exact merged PR。Local-only 则必须由目标-ref 集成锁、expected base/source SHA 与 ref CAS 共同证明 exact integratedCommit。

### L-02 关闭前本机内容安全检查｜部分实现

**当前能力：** `worktree close` 要求唯一 lease、精确 accepted commit、clean Worktree、无 ignored 内容；没有 remote ref 的未推送 commit 会阻塞。所有检查进入不可变计划。

**差距：** 零损失检查器与不可变计划可以复用，但 v2 只有“一律拒绝 ignored 内容”的保守路径，尚未实现对 untracked/ignored 可丢弃证据的结构化绑定与验证。

**v3 目标：** 保留零损失门禁，而不是把 v2 偶然更严格的“所有 ignored 内容一律阻止”冻结成产品要求。以成果01 §11.1 为权威：tracked 内容必须 clean，且不得有 unpushed/unique 内容；untracked/ignored 必须不存在或已有可丢弃证据。字段语义拆为开发期可变的 `lastObservedHead`、Ready 的 `readyHeadSHA`、集成后的 `integratedSourceHead` 与 `integratedCommit`。

### L-03 精确删除本地和远端 Ref｜已实现

**当前能力：** 本地 Branch 用 `update-ref -d <ref> <expected-sha>`；远端 Branch 用 `--force-with-lease=<ref>:<expected-sha>`；管理分支、仍被其他 lease/worktree 使用的 Branch 和发生漂移的 ref 不会删除。

**v3 目标：** 原样复用为本机收尾执行器。

### L-04 平台已自动删除远端 Branch 的幂等收尾｜部分实现

**当前能力：** v2 能处理部分远端 ref 已不存在的情况，并保留 exact merge evidence。

**v3 目标：** 只有 base/head repository identity、PR 和 integratedSourceHead 都匹配时，才能把“远端已不存在”当作成功；fork 的 head branch 只能在 head repository 清理。

### L-05 Remote Closing、Tombstone 与逐步 Journal｜待实现

**当前冲突：** v2 close 的执行顺序是移除 Worktree → 删除本机 lease → 删除本地 Branch/config → 删除远端 Branch。远端删除失败时，本机 lease 已经消失，跨机器无法知道该工作仍在收尾。

远端 tombstone 只适用于 GitHub 模式。Local-only 不制造远端 tombstone，但采用同样的“先零损失证明、后签发清理授权”顺序，并使用 Git common dir 中的 Closing journal、exact merge proof 和现有精确 close 执行器完成本机 Closing。

**v3 目标：**

```text
Integrated
→ 以 CAS 将匹配 generation/integratedSourceHead/controlEpochDigest 转为无写权限、无 TTL 的 terminal claim
→ 对当前权威主写 Worktree 取得关闭安全快照
→ 证明 tracked 内容 clean、无 unique/unpushed 内容，untracked/ignored 不存在或已有可丢弃证据，且身份无漂移
→ GitHub: Provider CAS 将 terminal claim 转为 Closing，建立远端 Closing journal，并签发 exact cleanup token
  Local: common-dir Closing journal 将 terminal claim 转为 Closing，并签发本机 exact cleanup token
→ 本轮可达的清理执行者验证 cleanup token，按 Closing journal 中的精确对象执行并追加结果
→ 远端 ref 与当前机器本地 ref 按 SHA CAS 清理
→ 本轮 required readback 全部满足
→ GitHub: Provider CAS 为 Closed，保留 tombstone/receipt
  Local: Closing journal 标为 Closed，保留最终 receipt
```

cleanup token 复用成果01 §11.2 的绑定范围：workItem、integratedSourceHead、integratedCommit 和当前模式适用的精确 Worktree/本地 ref/远端 ref；它授权这些精确对象的清理，ref 删除还必须通过 old-SHA guard。Closing journal 只保存精确计划、逐步结果和恢复进度，不能代替授权。

GitHub 模式的权威 Closing journal 与 terminal claim/tombstone 同属远端 Coordination/Delivery record，并以同一 CAS 更新；每台机器的本机清理或 reconciliation 进度保存在各自 Git common dir 的本机 journal/receipt，不能覆盖远端权威记录。Local-only 的权威 Closing journal 位于 Git common dir；具体子目录与 schema 由成果03的版本化 Local Closing storage contract 定义，不与 local-tracking 路径耦合，也不得由会话临时选择或在各 Worktree 各写一份。若 G-07 的远端 CAS 后端不可证明，GitHub Closing 继续 fail closed，不因此引入第二个协调后端。

同一权威 Coordination/Delivery record 在 `lifecycleState=Closing` 时持有 Closing journal；完成后以 CAS 转为 `Closed`，冻结身份、最终 journal/receipt 和待 reconciliation 义务，并持久保留为 tombstone。Local-only 由标为 Closed 的 common-dir Closing journal 承担本机 tombstone 作用，不创建远端对象。`Abandoned` 也保留 tombstone：GitHub 保存在同一远端记录，Local-only 将 Git common dir 中的 Abandoned 状态记录作为本机 tombstone；两者默认都没有 Closing journal 或 cleanup token。

terminal claim 建立不依赖写租约在此刻仍有效，只要求远端 generation/head/control epoch 精确匹配且没有更新 owner；它不授予任何写入能力。claim 缺失或冲突、当前权威主写者离线、快照不完整或安全证明失败时，保持 `Integrated + RecoveryRequired`，不得签发 cleanup token，也不得重开写租约；平台已自动删除远端 ref 只能记录为外部事实，不能替代本机内容证明。若该机器被负责人明确判定永久不可恢复，只有在用户批准可能丢失未推送/未跟踪内容的高风险 recovery 后，才能把精确本机义务记为 waived 并继续关闭可证明安全的远端对象；receipt 不得宣称零损失。进入 Closing 后不得重新分配同一工作；中途失败进入 `Closing + RecoveryRequired`，从 Closing journal 幂等继续，不能重头猜测。已在 takeover 中失去主写资格的旧离线副本不阻塞远端最终 Closed，只作为 tombstone 下的 reconciliation obligation。

### L-06 跨机器 Reconciliation｜待实现

每台离线机器恢复后，远端 Closed/Closing 记录和本机 exact receipt 只允许它开始 reconciliation，不直接授权删除。该机器必须重新观察 exact identity、dirty、untracked、ignored、unique 和 unpushed 内容，并以本机 SHA guard 执行精确清理；任一证据不安全就保留 Worktree/ref，记录本机 `RecoveryRequired`。它不能扫描并删除其他不受管对象，也不能因远端已 Closed 而覆盖后来出现的本机独有内容。

### L-07 放弃未合并工作｜待实现

Abandon 是 P0 必需的独立终结路径，不能伪造 Integrated，也不能复用 merged close：

- 先展示并绑定 exact Work Item、Branch、PR、Head、dirty、ignored、unique、unpushed 和 remote-only 资产，取得明确人工批准；
- MergeArmed 必须先按 D-06 完成安全撤防；任一时点若 Provider 已精确证明合并，立即转 Integrated，禁止 Abandon；
- 以远端 CAS（Local-only 用 common-dir 状态记录）把当前 generation/身份转为 `Abandoned`；若仍在 Admitted、从未创建 generation，则以“generation 不存在”为前置条件转换。两者都终止全部受管续租、转交、push、Ready 和 merge；部分失败记录 `Abandoned + RecoveryRequired` 并幂等继续；
- 关闭或标记 PR/Work Item 为不再交付，但保留永久 identity/tombstone；Branch、Worktree、commit 和未提交内容默认原地保留；
- 平台更新后必须再次 readback 永久 PR identity；以后任一 Provider 事件若精确证明合并，外部事实都覆盖 Abandoned，进入 `Integrated + PolicyViolation` 并建立 terminal claim。已有 generation 时按 exact generation/head/controlEpochDigest CAS；从未有 generation 时以“generation 不存在 + 永久 PR identity + integratedSourceHead + controlEpochDigest”为 CAS 前置条件，绝不重开写租约；
- 归档或删除资产仍是后续独立高风险动作，需要新的人工批准，不能夹带在 Abandon 中。以后重做同一需求必须建立新 Work Item/交付原子。

### L-08 全局“已合并 Branch”后台清理器｜明确不做

Harness 可以报告残留和生成单项精确计划，但不会遍历所有看似 merged 的 Branch 后自动删除。时间、Branch 名、PR closed 或 ancestry 任一单独条件都不足以授权破坏性清理。

## 4.7 凭证与权限

### A-01 Git Transport 与 GitHub API 凭证分离｜部分实现

**当前情况：** git push 和 `gh` API 已走不同命令通道，但产品没有正式 credential model，通常继承 ambient 环境或现有 `gh auth`。

**v3 目标：** 把两者明确分开；Deploy Key/SSH key 可用于 Git transport，但不能用于创建 Issue 或修改 GitHub settings。

### A-02 每开发者 × 每机器 × 每仓库 Fine-grained PAT｜待实现

**v3 默认：** 日常 token 只选择目标仓库；基线为 Metadata read、Issues write，并按启用功能增加 Pull requests write，只有需要直接更新组织 GitHub Project 时才增加对应 Projects write。默认有效期上限 365 天，并在 `bootstrap`、`context`、`doctor` 等受管命令运行时对 30/7/1 天窗口做机会性提醒；没有显式宿主 scheduler 时，不承诺精确日期主动通知。组织更短上限优先。只有官方能力缺口被实际证明时才允许 classic PAT，且建议不超过 90 天，不自动降级。

### A-03 系统密钥库与单进程凭证注入｜待实现

**v3 目标：** GitHub 日常/admin token 与独立 reviewer secret 的明文只进入 macOS Keychain、Windows Credential Manager 或 Linux Secret Service。仓库仅保存 `credentialRef`、作用域身份、secret kind、预计到期日和权限/数据范围摘要。运行时只向需要它的单个子进程注入：GitHub 使用临时 `GH_TOKEN`，reviewer 使用其 Adapter 声明的环境变量；不得写入 argv、日志、receipt、Agent prompt 或仓库文件。Receipt 只保存 credential reference/fingerprint 和非敏感范围摘要。

### A-04 日常 Token 与临时 Admin Token 分权｜待实现

日常 token 不应包含 repository administration。ruleset、branch protection、repo settings、Actions/environment 等治理 Apply 使用独立、一次性的短期 admin credential；readback 后从 Keychain/Credential Manager/Secret Service 删除 secret 和所有活动引用，只在 receipt 保存非敏感 credential fingerprint、权限摘要和操作证据。Harness 不购买、续发或偷偷扩大 token 权限。

### A-05 凭证验证、轮换与失败关闭｜待实现

Setup 优先通过权限/readback API 验证身份、repo visibility 和可用权限。若某项写权限无法只读证明，写探针必须是显式、可清除、有独立回执的批准步骤，不能暗中制造 Issue/评论等外部状态。401/403 时报告缺少的权限并失败关闭，不能频繁要求 `gh auth login --web`，也不能自动换成 classic PAT。用户创建/撤销 token，Harness 负责提醒和原子更新 credential reference。

## 5. 按开发场景理解 v3

### 5.1 单人、新 GitHub 项目

张三创建仓库后只需运行一次 `harness-automation bootstrap --project .`。v3 在同一会话完成发现、policy、GitHub tracking、凭证引用、Workspace 与治理配置。Solo profile 允许 auto-merge、合并后删除 head branch、默认分支最终只能通过 PR、required CI 必须通过，但 required approvals 为 0。因此 GitHub“不允许自己批准自己的 PR”不会锁死单人开发者；PR 和 CI 仍保留可审计的集成边界。

安全、已预先批准的设置由 Harness 静默完成；需要创建/修改 ruleset、branch protection 或 workflow 时，只展示一张合并的 before/after 清单。张三明确批准后，Harness 在本次运行继续 Apply，而不是让他复制 JSON hash 或另开数轮对话。`allow_auto_merge` 不需要重复询问；`delete_branch_on_merge` 也不重复询问设置值，但若项目声明长期 Branch，其禁止删除规则仍属于上述 protected-action 清单。

张三配置本机日常 fine-grained PAT；需要 protected governance Apply 时使用临时 admin credential。空仓库先建立默认分支并复用已有 CI；若确实需要 Harness 创建 workflow，也包含在上述显式审批清单中。Foundation 完成后，还要通过既有代表性交付或用户批准、可精确回收的 canary，证明 credential、Issue、Coordination CAS、Branch push、PR 创建/readback 和独立恢复路径端到端可达；只有产生真实 check 名并通过这条交付 preflight 后才启用 required checks。任一前提尚未就绪时停在 `EnforcementPending`，不提前激活会自锁的保护。Harness 最终 readback 成功后才进入 `Enforced`。v2.8.11 目前只完成 policy lifecycle 和 GitHub read-only audit，远端设置写入仍待实现。

### 5.2 接管一个从未使用 Harness 的旧项目

同样只运行一次 `harness-automation bootstrap --project .`。Harness 先在内部只读盘点 Branch/Worktree、dirty/unpushed/unique commits、repo settings、CI、Issue/GitHub Project、目录 topology 和冲突工作项；所有既有对象映射、legacy adopt、目录迁移、进入 Enforced 的目标、ruleset/workflow 或削弱保护的决定只汇总为一张清单。用户批准后，本次运行才继续接管、应用安全配置并 readback；若完整 Delivery preflight 或治理 readback 尚不成立，则保留 `EnforcementPending`，不能把批准本身当作 Enforced 证据。

旧项目可以长期处于 `AuditOnly` 或 `Mixed`；v3 不自动映射或接管历史对象、不自动移动 legacy-flat 目录、不自动改 Branch 名、不把已有普通 PR 改 Draft，也不把每个历史 Branch 都补成 Issue。用户未批准任何 v3 接管时，AuditOnly 只完成 observe、report、plan 和 receipt，不写 workspace、tracking、Delivery 或 GitHub 配置；只批准精确子集时进入 Mixed，仅该子集可以初始化或变更。未批准的 protected actions 和未接管对象都在最终清单中标为 pending/unmanaged。

### 5.3 新会话里提出一个新功能

在 GitHub 项目中，张三在管理 checkout 的新 Codex 会话里说“增加导出功能”。Admission 判定这是会改代码的新工作，在第一次写文件前暂停。用户确认后，只有已验证的远端 CAS/协调能力能够建立权威租约时，Prepare 才创建/验证 Issue、取得远端租约、创建 `feature/<issue>-export` 和交付 Worktree，并请求 Codex 打开 Worktree 任务；宿主做不到时返回 `PreparedNotOpened` 及目标路径。协调能力缺失时最多保留已创建的 Issue，状态为 `Admitted + Blocked + CoordinationBackendRequired`，不得创建 Branch/Worktree 或在管理 checkout 写代码。Local-only 的对应路径见 5.13。

这时 Issue、Branch 和 Worktree 通常同时存在，但它们各自解决不同问题，不是三份重复记录。

### 5.4 Debug：只读复现与代码修复

“为什么线上请求失败？”如果只需读日志、查代码或运行不修改 tracked files 的复现，可留在当前安全环境，不强制创建完整交付原子。只要准备修改 tracked code、提交临时日志或产生需要保留的补丁，就升级为普通修复：当前模式的 Work Item + Branch + Delivery Worktree + lease。

“临时诊断 Worktree”不是每次 Debug 的默认步骤。只有需要隔离依赖、固定 SHA、避免污染现有目录时才使用 detached Review Worktree；它不承担主写。

### 5.5 一台机器并行开发两个功能

导出功能和搜索功能各自拥有 Work Item、Branch、Delivery Worktree 和租约。同一 clone 共享 Git object database，但两个 Worktree 各有 working tree 和 index，所以未提交文件不会直接覆盖。

未来合并时仍可能产生语义或文本冲突。Worktree 解决的是“开发期间目录互踩”，Branch 解决的是“提交历史和集成边界”；它们都不承诺两个设计天然兼容。`integration-check` 提前报告冲突，主写者在自己的 Branch 显式解决。

### 5.6 同一工作串行换会话

会话 A 到长度边界后写 handoff，结束主写；会话 B 在同一 Delivery Worktree 接续。这是“两个会话都在干同一项工作”的主要意义：恢复上下文和责任，而不是并发写。若 A、B 同时写同一个目录，Harness 应阻止把它们都登记为 primary writer。

### 5.7 三名开发者、三台机器、三种 Agent

张三/Codex、李四/Claude Code、王五/DeepSeek Harness 各自 clone 同一个远端 repo。每个 clone 都有自己的管理 checkout 和本机 Worktrees；远端仓库只有 Git objects、refs、Issues 和 PR，不存在远端 Worktree。

三人可以分别开发多个功能，因为不同 Work Item 获得不同远端租约。每台机器的默认分支 checkout 应通过 fetch/fast-forward 保持合理同步，但无需在每一秒拥有完全相同的 working tree。真正共享的集成真相是远端默认分支、PR 和 Provider 状态。

### 5.8 同一工作跨机器转交

张三把 Issue 转给李四。正常路径不是李四直接拉同一 Branch 开写，而是张三先冻结并取得耐久交接快照，证明 tracked 内容 clean、没有未解释的 untracked/ignored、unique 或 unpushed 内容，且 exact 远端 Head 可由李四取回；Provider 随后才以单次 CAS 增加 generation 并记录新 owner。证据不完整时保持 `HandoffPending + Blocked`，不移动 generation。李四取得新 lease 后创建/接管自己的 Worktree；张三旧 token 失去写资格，只能保存本地内容、救援审计或只读查看。

张三机器离线且 lease 过期时，李四的 takeover 必须展示旧机器可能存在未推送内容的风险并取得一次明确人类批准；系统随后保留原 owner、过期证据和新 generation，且不会删除张三机器上的文件。

### 5.9 主线在开发期间变化

Harness 只在 Admission、Ready、用户显式 status/check 或 merge readback 等受管边界执行 fetch，然后用固定 ref 做只读集成预测；不建立后台定时 fetch。behind 本身不阻塞；真正冲突、dirty、unpushed 或 mapping drift 阻塞。v3 不在后台自行 rebase，因为重写历史会改变 Head、让旧 Ready 和审阅证据失效。

### 5.10 PR、CI、Review 与 Auto-merge

首次受管 push 后创建 Draft PR。Agent 完成本地验收后，将当前 SHA 标成 `readyHeadSHA`。普通风险任务在 GitHub 与 Local-only 都无需额外人类“批准完成”；高风险、验收含糊或有已知缺口的任务必须先取得绑定当前 Head 的人类证据。本地确定性 Ready checks 必须先成功；GitHub required checks 默认可以在 Ready 后继续 pending，由平台阻止实际合并，profile 也可以显式把某项 check 提前为 Ready gate。普通 Team reviewer 若被 profile 定义为集成门禁，同样可以在 Ready 后由平台满足。

Solo profile 不要求他人 approval；Team profile 配置为 `≥1` 时必须有足够的非作者 reviewer，否则不启用该门禁；High-risk profile 优先要求匹配 CODEOWNERS/风险域的人类 reviewer，没有可用 reviewer 时服务端 required approvals 保持 0，并由 owner 在 Harness 人类 gate 中显式接受风险，不能伪造 GitHub 自审。条件满足后 GitHub auto-merge 完成集成。

### 5.11 合并后自动收尾

Provider 观察到 exact PR/integratedSourceHead 已集成后，先以 CAS 把匹配 generation/head/controlEpochDigest 转为无写权限、无 TTL 的 terminal claim，再从当前权威主写 Worktree 取得包含 tracked-clean、untracked/ignored 可丢弃证据、unique/unpushed、identity 与 SHA 的关闭安全快照；证明零损失后才把 terminal claim CAS 为 Closing，建立 Closing journal 并签发按 L-05 绑定的 cleanup token。原写租约已到期不阻断 claim，只要没有新 generation 或 control epoch；claim 缺失或冲突时保持 `Integrated + RecoveryRequired`，不得重开写租约。平台可能已经删掉远端 Branch，Harness 只把它记录为外部事实，不能用它跳过本机证明。当前主写者离线或证据不完整时同样保持 RecoveryRequired；已失去主写资格的旧离线副本仅作为后续 reconciliation obligation。

Integrated/Closing 由已有平台事件入口或下一次受管 `status/check/reconciliation` 命令机会性触发；没有事件入口时不承诺实时收尾，也不为此建设本地常驻 daemon。

失败不会转回 Active 或重新分配，而是保留 Closing journal 供幂等恢复。这个流程自动化的是“受管对象的已知生命周期”，不是扫描所有历史 Branch 的全局垃圾回收。

### 5.12 npm 发布和其他管理操作

普通功能开发遵循短生命周期 Branch/Worktree。发布、仓库维护或必须使用主 checkout 的操作是显式 profile/项目规则例外，例如本仓库 npm release 要在既有 management checkout 完成验证、版本、tag 和 publish，不能为了发布另造 Worktree。

v3 只需要能表达并检查这类例外，不需要建设一个通用自动发布编排器。

### 5.13 明确不上 GitHub 的本地项目

只有用户明确声明“这个项目不上 GitHub、只在本地运行”，Bootstrap 才选择 `local-only`。Harness 安装并使用内置 `task.py` 与 `changelog.py`，把任务和变更写入 `<git-common-dir>/harness/local-tracking/` 下唯一权威的 `TASK.json`、`CHANGELOG.jsonl`；所有 Worktree 通过脚本访问同一事实源，Agent 不得临时现写看板脚本。每项开发使用 local Work Item、Delivery Branch、common-dir work-item lease 和 Delivery Worktree；Ready 后另取目标-ref 集成锁，以 expected base/source SHA 和 ref CAS 产生 exact integratedCommit，才进入 Integrated 并执行本机 Closing。不仿造 PR/auto-merge，也不承诺跨 clone 或跨机器协调。

如果仓库已经连接 GitHub，网络或权限故障只让相关步骤进入 `Blocked`，不能自动切到 Local-only。两种 tracking mode 不同时启用，避免出现两个任务事实源。

## 6. v3 统一状态模型

沿用成果01已经确认的主生命周期，不用实现细节另造一套状态。`Draft` 与 `MergeArmed` 是 PR-capable Provider 的条件状态；Local-only 走缩短路径：

```text
共同前缀： Observed → Admitted → Prepared → Active
GitHub：   Active → [通常 Draft] → Ready → [可选 MergeArmed] → Integrated → Closing → Closed
Local：    Active ─────────→ Ready ────────────────────→ Integrated → Closing → Closed
未集成：  Admitted / Prepared / Active / Draft / Ready ──人工批准──→ Abandoned
外部事实：Abandoned ── exact merged PR ──→ Integrated + PolicyViolation
```

下表第三列统一表示进入该状态及维持该状态成立所需的条件。

| 状态 | 含义 | 进入/保持条件 |
|---|---|---|
| `Observed` | 仅讨论、检查或只读诊断 | 尚无代码写入意图 |
| `Admitted` | Work Item 已存在且可验证 | 尚未获得完整交付环境也可以停在此处 |
| `Prepared` | Work Item、Branch、当前模式的 lease 和 Delivery Worktree 映射成立 | GitHub 使用远端 lease；Local-only 使用 common-dir work-item lease |
| `Active` | 当前会话通过环境和租约复核 | GitHub 当前 generation 或 Local-only common-dir work-item lease 可受管写入 |
| `Draft` | GitHub 已推送有效代码并建立唯一 Draft PR | Local-only 不进入此状态 |
| `Ready` | 开发完成证据绑定 `readyHeadSHA`、`controlEpochDigest` 与 policy/scope | Head 或任一绑定输入变化立即失效；默认远端 integration checks 可以仍在 pending |
| `MergeArmed` | GitHub 可选；平台 auto-merge 已武装 | Local-only 不进入此状态；撤防完成前仍保持该主状态和写冻结 |
| `Integrated` | 预期 integratedSourceHead 已被精确集成事件接受 | 固化 integratedSourceHead 与 integratedCommit；GitHub 由 exact merged PR 证明，Local-only 由目标-ref 集成锁 + expected base/source SHA + ref CAS 产生的 integratedCommit 证明；Squash 不要求 source commit 出现在目标 ancestry 中 |
| `Closing` | 当前模式按 L-05 绑定的 cleanup token 和 Closing journal 已建立 | 不可续期、接管或重新分配 |
| `Closed` | 权威交付身份与本轮可达资产已收尾 | GitHub 以远端 tombstone 冻结身份、最终 journal/receipt 和旧副本 reconciliation obligations；Local-only 以最终 Closing journal/receipt 冻结同一组 tombstone 事实；永久丢失义务只能以人工批准的 waived 证据结束 |
| `Abandoned` | 未集成交付原子已被人工批准放弃 | 终止受管写入和集成；保留 identity/tombstone，Branch/Worktree 默认不删除；后续 exact merge 可覆盖为 Integrated + PolicyViolation |

状态命名空间必须分开：

- Delivery 附着标记：`Blocked`、`LeaseExpired`、`HandoffPending`、`Disarming`、`RecoveryRequired`、`PolicyViolation`；例如撤销 auto-merge 期间是 `MergeArmed + Disarming + Blocked`，Closing 中断仍是 `Closing + RecoveryRequired`，绕过受管门禁但被 Provider 精确证明已合并则是 `Integrated + PolicyViolation`。
- 控制面操作结果：`ReviewPending`、`NeedsHuman`、`PreparedNotOpened`、`CoordinationBackendRequired`、`TrackingModeMigrationRequired`。`ReviewPending` 表示 reviewer 不可用且尚未得到一次用户语义批准；`NeedsHuman` 表示自动审查/修复已达到上限；`PreparedNotOpened` 表示交付环境已建立但宿主未打开；`CoordinationBackendRequired` 表示 GitHub 原生 CAS 不满足所有新受管写入的租约前提；`TrackingModeMigrationRequired` 表示已配置事实源与新发现 remote 冲突。它们都不改变已经成立的 Delivery 主状态。
- Governance/Bootstrap 拆成两个正交维度，不能替代 Delivery 主状态或其附着标记：Coverage 为 `Unconfigured`、`AuditOnly`、`Mixed`、`Managed`；Enforcement 为 `EnforcementPending`、`Enforced`。`Mixed + Enforced`（只有部分对象受管且其门禁完整）和 `Managed + EnforcementPending`（全部对象已接管但门禁缺失）都合法。

以下组合守卫单向展开成果01 §7 的目标不变量，不得改变其语义。Coverage 与 Delivery 的组合守卫固定为：

| Coverage 状态 | 允许的 Delivery 行为 |
|---|---|
| `Unconfigured` / `AuditOnly` | v3 控制面只读，不执行新的 v3 受管 Prepare；用户显式调用的 v2 compatibility 操作可以按旧安全边界执行，但完全处于 v3 状态、租约和 Closing 保证之外。项目或对象一旦 adopt 到 v3，就禁止再走 compatibility close |
| `Mixed` | 只有 v3 新建或用户显式 adopt/migrate 的对象受管；其余 legacy/未接管对象保持原责任边界。它只表达覆盖范围，不表达门禁健康度 |
| `Managed` | 当前声明范围内的对象全部进入 v3 管理；能走到哪个 Delivery 转换仍由 Enforcement 决定 |

Enforcement 与 Delivery 的组合守卫固定为：

| Enforcement 状态 | 允许的 Delivery 行为 |
|---|---|
| `EnforcementPending` | 允许 Foundation 和不依赖缺失门禁的开发阶段；在第一个缺失能力处阻止转换：Ready gate 缺失/未通过则阻止 Ready，integration gate 的配置、identity 或可触发性缺失则允许 Ready 但阻止 MergeArmed/Harness merge。已正确受平台约束但本次运行仍 pending 不属于能力缺失 |
| `Enforced` | 当前 profile 的完整 Delivery preflight、satisfiability 与治理 readback 都通过，允许 coverage 范围内的完整受管生命周期 |

Local-only 的上述状态只检查本地 policy、Tracking、Workspace、common-dir work-item lease 和目标-ref 集成锁能力的就绪度，不等待不存在的 GitHub governance。`Enforced` 是持续观察结论而非永久授予；成员、CI、权限或恢复路径漂移后，coverage 不变，enforcement 在下一次 Provider 事件、受管 audit/drift 或 merge readback 发现时降为 `EnforcementPending`，为受影响 Delivery 附加 `Blocked`，不能继续用旧 readback 宣称门禁可满足。新的 merge 武装立即停止；已处于 `MergeArmed` 的 PR 必须按 D-06 保持冻结、先禁用并 readback auto-merge、再 CAS 退回，若已合并则观察为 Integrated。没有 webhook/daemon 时不宣称墙钟时间上的即时发现。

Work Item 已存在但无有效 lease 表示 `Admitted + Blocked`；若原因是租约到期，再附加 `LeaseExpired`，无需新增 `Unclaimed`。

GitHub 小任务在首次 push 时已经满足完整 Ready 条件，可以从 Active 直接创建 Ready PR；这是 Draft 的受证据约束 fast path，不是绕过 Ready。`MergeArmed` 也不是必经状态；GitHub 手工平台 merge 和受目标-ref 集成锁保护的 Local-only 显式集成都可以从 Ready 直接进入 Integrated。Abandoned 是未集成工作的独立人工终结结果，不伪装成 `Integrated → Closed`；若已 MergeArmed 必须先安全撤防。Abandon 只终止受管动作，不能否认后来发生的 external merge：Provider 任一时点证明 exact merged PR 都覆盖为 `Integrated + PolicyViolation`。Session 的 GitHub Project 字段 `in-progress/ready-for-review/done` 只是看板状态映射，也不得冒充完整 Delivery 状态。

Local-only 从 Ready 集成时必须另取目标-ref 集成锁，绑定 expected base/source SHA，并以 ref CAS 产生 exact integratedCommit；工作项 lease 不能代替这把跨工作项锁。锁冲突、目标漂移或管理 checkout 不安全时保持 `Ready + Blocked`。

Provider 精确证明预期 PR/integratedSourceHead 已合并时，可以从任一未集成状态进入 `Integrated`；若绕过 Ready 或当时 profile 要求的集成门禁，则必须同时附加 `PolicyViolation` 并冻结写入。未经过可选 MergeArmed 的合规人工/平台合并不违规。普通 ancestry 或直接 push 证据不足以触发该事实边，只能进入 `RecoveryRequired`。

Integrated 首次被精确观察时必须以 CAS 将匹配 generation/head/controlEpochDigest 转为无写权限、无 TTL 的 terminal claim；后续安全快照和 Closing 依赖该 claim，不依赖仍有效的写租约。远端交付记录不等待已经失去主写资格的旧离线副本重新上线才进入 Closed：当前权威主写 Worktree 已通过关闭安全快照、权威远端 ref 和本轮必要清理完成后即可关闭；旧副本残留作为 tombstone 下的 reconciliation obligations 最终收敛。claim 冲突、当前权威主写者离线或证据不完整时仍保持 `Integrated + RecoveryRequired`，不能借本条跳过零损失证明或重开写租约。

### 6.1 Anti-self-lock 硬不变量

Harness 的控制面修复能力不能依赖它正在修复的数据面健康。v3 把以下条件作为可执行不变量，而不是运维建议：

1. **先证明可满足，再激活 gate，并持续复核。** required approval 激活前验证存在合格的非作者 reviewer；required check 必须绑定 exact name 与 source App/Workflow，在代表性 PR 事件上成功，并验证 trigger 与 branch/path filter 覆盖受保护变更。Required approvals 大于 0 时，平台必须让批准对当前 diff/Head 敏感。进入 Enforced 前还必须证明当前 profile 的 credential、Work Item、Coordination CAS、Branch push、PR 创建/readback 和独立恢复路径端到端可达。每次 governance audit/drift 和 merge 武装前重新验证成员、权限、check、filter 与恢复路径；失效后保持 coverage、降为 `EnforcementPending`，阻止新的 merge 武装并按 D-06 撤防已武装 PR，不自动削弱。Solo profile 的 required approvals 固定为 0。
2. **Foundation 与 Enforcement 分离。** 默认分支、CI、权限和非阻塞基础设置先准备并验证；完整 Delivery preflight 成功后，ruleset/required checks 才激活并 readback。任何前提缺失都停在 `EnforcementPending`，不能先写一个未来才可能满足的规则。
3. **Recovery plane 不受当前项目 policy 反向封锁。** gate 激活前证明至少一个不依赖该 gate 的授权恢复主体/路径可用。`doctor`、只读 audit、plan 查看、exact last-known-good 恢复计划和本地 safe mode 入口使用随产品发布的最小内建规则，在 Harness 可执行文件和本地存储可用的前提下始终可达；不得要求当前损坏 policy、当前失败 CI 或不可用 reviewer 先通过。Safe mode 只允许诊断、查看计划和生成/验证精确恢复计划，禁止编辑业务代码、创建新 policy、push、merge、修改远端治理或降低保护。
4. **治理写入复用 G-02 的唯一八阶段流程。** `observe → semantic plan → deterministic/independent review → [protected actions: one explicit human approval] → preflight → apply → readback → receipt`；保存 last-known-good、反向计划和 receipt。同一次尚未完成的 Apply 可自动补偿 Harness 本轮可证明创建、未漂移且未被后续使用的状态。任何事后恢复执行、保护弱化或外部写入都必须由用户明确批准，不能借 safe mode 绕过正常授权。
5. **失败只冻结依赖它的转换。** GitHub、credential 或 reviewer 故障不能封锁只读诊断、rollback、safe mode、加载最后有效策略或与该外部能力无关的本地工作。
6. **自动修复有界。** 主 Agent 最多修改计划并重新提交独立 reviewer 一次；同一 blocker 再出现即进入 `NeedsHuman`。禁止自我修复、重新 plan、重新审批无限循环。
7. **审批者与执行者权限分离。** 第二 AI 不能 Apply、拿 admin token、改变 reviewer policy 或降低风险；主 Agent 不能在 reviewer 不可用时改成“自审通过”。
8. **Break-glass 不隐身。** 紧急绕过只能由用户明确授权，限定对象、动作和有效期，写入 receipt；不能成为后台自动 fallback。

最低验收矩阵必须覆盖：Solo repo、没有现成 check、没有合格 reviewer、激活后 reviewer 离开、check/workflow identity 漂移、恢复主体失效、长期 Branch 面对全局自动删除、token 过期、reviewer 503、损坏 policy、Apply 中断、readback 不一致和 Harness 自身修复。每个用例都要证明系统进入可诊断、可恢复的确定状态，而不是重复要求同一个无法满足的 gate。

## 7. GitHub Profile 建议

| 设置 | Solo | Team | High-risk | High-throughput |
|---|---:|---:|---:|---:|
| PR 必须 | 是 | 是 | 是 | 是 |
| Required CI | 是 | 是 | 是 | 是 |
| Required approvals | 0 | ≥1，可配置；人数不足则不激活 | 有合格非作者时 ≥1；否则 0 + owner 风险 gate | 可配置但必须可满足 |
| Allow auto-merge | 是 | 是 | 是 | 是 |
| Delete head branch on merge（目标值） | 是* | 是* | 是* | 是* |
| Force-push 默认禁止 | 是 | 是 | 是 | 是 |
| Merge queue | 可选 | 可选 | 可选 | 推荐但不强制 |
| Environment approval | 按部署风险 | 按部署风险 | 高风险环境启用 | 按部署风险 |

这些是可配置 profile 默认值，不应散落成代码常量。新仓库采用所选 profile；既有仓库先读后计划。`allow_auto_merge` 可按已确认默认自动对齐；`delete_branch_on_merge` 还要求所有现存 Branch 已被分类为可删除交付 Branch 或已受远端删除保护的长期/未接管 Branch，未知或未分类 Branch 会使全局设置保持关闭。ruleset、branch protection 和 workflow 的创建/更新/删除/启用仍要求一次明确的人类语义审批，任何降低现有保护的调整都走 weakening approval。

\* “是”只表示 profile 的目标值；分类、长期/未接管 Branch 删除保护和 readback 前置条件全部成立后才能启用，不是无条件 Bootstrap 写入。

表中的 Required CI 是 Enforced 终态要求；空仓库必须先完成 Foundation，并在代表性 PR 上验证 exact check name、source App/Workflow、trigger 和 branch/path filters，不能把目标默认值直接当作第一步远端写入。GitHub required approvals 的具体数字不得高于当前可验证的合格非作者人数，且大于 0 时必须让 approval 绑定当前 diff/Head。Team 的目标值无法满足时保持 `EnforcementPending`；High-risk 明确采用 owner 风险接受路径时，服务端值为 0，并在 Ready 前执行 Harness 人类 gate，不能写成一个永远无法满足的 GitHub approval 要求。所有门禁的 satisfiability 在 merge 武装前重新验证；已激活配置发生漂移时 coverage 不变、enforcement 降为 `EnforcementPending`，不自动降低规则。

## 8. v2.8.11 与成果01的明确冲突及迁移

### 8.1 本机 Lease 不能原地宣称为远端写租约

v2 lease 没有远端 CAS、generation、expiresAt、Provider server time 或 fencing token。升级时只能作为本机线索。任何 GitHub-mode 对象要进入 v3 受管写入，都先保持 `AuditOnly`，由用户确认当前 owner 后创建第一代远端 lease；不能因当前只观察到一个 clone 就跳过。

### 8.2 `acceptedCommit` 实际是变化中的 HEAD 快照

v2 `renew` 会更新它，因此名称不能继续表示“业务已接受提交”。迁移为 `lastObservedHead`，另存 `readyHeadSHA`、`integratedSourceHead` 和 `integratedCommit`。

### 8.3 v2 `recover` 与跨机器恢复不是一回事

旧命令继续执行 clean detached unleased Worktree 回收，并给出明确帮助文本；新跨机器能力使用 `lease transfer/takeover`，避免破坏脚本兼容性。

### 8.4 普通 PR 不能冒充 Draft 流程

不自动把历史非 Draft PR 转成 Draft。新 v3 GitHub 交付默认 Draft（满足完整 Ready fast path 的小任务除外）；存量 PR 记录为 compatibility mode，直到下一项工作。Local-only 不使用 Draft 状态。

### 8.5 直接 Squash Merge 与 Auto-merge 必须分开记录

旧 authorization 的 `checks-green` 权限不自动转换为 auto-merge。GitHub REST merge 仍受服务端保护，并不天然绕过 ruleset；真正缺失的是远端 lease、Ready/readyHeadSHA、bypass credential 限制和 merge queue 语义。v3 profile 明确决定是允许受限的显式直接 merge、平台手工 merge，还是武装 auto-merge，并分别记录实际路径。

### 8.6 `context` 不是 Admission

保留现有 policy context receipt，新增独立 admission/prepare 结果。避免让每一轮对话都重新跑昂贵的意图分类。

### 8.7 Session Ready 不等于 Delivery Ready

旧 `ready-for-review` 只保留看板语义。只有绑定当前 Head、验收项和 gates 的新证据才能进入 Delivery Ready。

### 8.8 v2 Close 没有远端 Closing

升级后，只有 v3 创建或显式 adopt/migrate 的远端交付记录才能走自动跨机器 Closing。旧 work item 只有在仍由 `Legacy compatibility` Profile 处理、且尚未被 v3 adopt 时，才可按旧安全边界使用现有 exact-hash close；其 Coverage 可以是 `AuditOnly`，也可以在 `Mixed` 中属于尚未接管的子集。项目或该对象进入 v3 受管状态后必须走 v3 Closing，不能继续绕过远端 tombstone，也不能凭本机 receipt 补写一个虚假的远端历史。

### 8.9 GitHub Audit 不是 Settings Apply

保留 read-only audit；新增 governance plan/apply/readback。Bootstrap 只能自动修复已批准 profile 内、非 protected、可逆且边界明确的差异；不能覆盖不认识的 ruleset 条目。ruleset、branch protection 和 workflow 只能在本次可读差异获得用户明确批准后 Apply。

### 8.10 类型声明不是已实现功能

当前 `controlledRebase`、`closeout` 没有可达执行；CI retry 只有分类/预算判断；`DeliveryStatus` 声明的部分 phase 运行时不会产生。Worktree close 又使用另一套 receipt，因此即使本机已经清理，Delivery status 仍可能停在 `closing`。v3 要么实现并测试统一可达路径，要么删除/降级这些过度承诺字段。

### 8.11 CLI 与 MCP 当前并非完全同构

CLI 是完整基线；Session、Delivery、GitHub Audit 和部分 Worktree 操作没有同等 MCP 入口。v3 文档和 `doctor` 应如实输出 surface matrix，不把“共用部分 service”写成“所有命令 parity”。

### 8.12 Legacy v1 不进入 v3 路线图

旧 `init_harness`、`generate_config`、旧 CI generator、占位 AI review、A/B 与 cognitive handlers 只在 `HARNESS_ENABLE_LEGACY_V1=1` 下暴露，并会绕过 v2 exact-hash 模型。它们继续默认隐藏，用于明确迁移兼容，不复活为 v3 功能。

### 8.13 人肉复制 Plan Hash 不再算有效审批

v2 的 `planHash`、输入重验和原子 Apply 继续保留，但 CLI/Skill 不再把“请复制完整 hash”作为默认人工闸门。迁移后，忠实派生自已批准输入的普通计划由语义审批包、风险分类和独立 reviewer 产生 approval receipt；protected actions 由用户批准可读语义清单。系统内部把两者绑定到 exact plan，用户不需要阅读原始 JSON。

### 8.14 旧正则 Pre-scan 退出标准流程

`scan_codebase` 及其 scanner/cache/extractor 继续跟随 legacy v1 默认隐藏，不接入 `bootstrap`、`discover` 或 `check`。若存在明确 legacy 接管需求，只作为非阻塞诊断；否则在 v3 模块迁移后删除，避免维护两套重叠且结论不同的扫描系统。

### 8.15 Tracking 只保留 GitHub 与显式 Local-only

连接 GitHub 的项目以原生 Issue/GitHub Project/PR 为事实源；现有 `TASK.json` 不自动接管，也不在网络故障时成为 fallback。明确 Local-only 的项目通过内置 `task.py` 和 `changelog.py` 管理本地事实源。当前 GitLab/Jira 枚举迁移为明确 unsupported/deprecated 诊断，不补空 adapter。

### 8.16 先拆职责，再增加 v3 跨域功能

旧 façade 和 service 暂时保持兼容入口，但从迁移开始即执行 no-growth；实现逐步迁入 3.4 的窄模块。迁移阶段以行为不变为验收，不同时重写状态机，也不等待“全部拆完”才禁止新职责进入旧文件。

### 8.17 Tracking mode 不能由 Remote Discovery 隐式切换

已配置 `trackingMode` 是事实源选择，优先于以后发现的 remote。Local-only 项目新增 GitHub remote，或 GitHub 项目请求转为 Local-only 时，Bootstrap 只报告 `TrackingModeMigrationRequired` 并阻止新 Admission，不向两套事实源双写。

正常切换要求既无活动 lease，也无未终结 Delivery atom。现有工作必须在 last-known-good mode 中 drain；只有不带 `RecoveryRequired` 且已完成旧 Provider 必需 readback 的 `Closed`/`Abandoned` 才算 drained，`Abandoned + RecoveryRequired` 不算。旧 Provider 可恢复时必须继续在旧身份下完成收尾；唯一例外是旧 Provider 被明确判定永久不可达，此时只能由用户批准高风险 `TrackingMigrationWaiver` 后切换。该 receipt 必须绑定旧 Provider/mode、最后观察到的 Work Item/PR/lease/generation/head/controlEpochDigest/state，并明确“未证明远端已 Closed/Abandoned”；系统不得制造终态，也不得把未决 atom 重写到新 mode，只能把它保留在旧只读归档中作为 reconciliation obligation。旧 Provider 日后恢复时仍按原身份核对。全部可证明活动项终结或取得上述 waiver 后，用户再批准历史 Work Item 映射和单一切换点；同一事务先冻结旧事实源为只读归档，再启用新事实源。GitHub 故障本身永远不构成反向迁移授权。

## 9. 当前公开能力总表

这张表用于防止成果02漏掉 v2.8.11 已有入口，也防止把仅存在于源码类型中的设想计入产品。

| 当前入口 | v2.8.11 实际作用 | v3 处理 |
|---|---|---|
| `install` | 安装两项 Skills 和可选 MCP | 保留 |
| `doctor` | 只读项目、compiler、Skill 安装状态 | 扩展 governance/credential/host 能力摘要 |
| `research github` | 确定性 GitHub 候选调研证据 | 保留 |
| `intake` | owner 批准来源、命名接管、weakening | 保留 |
| `discover` | 仓库、栈、Agent、eval 能力快照 | 保留 |
| `plan` | 初次 policy 不可变计划 | 保留为统一计划模型 |
| `update plan` | exact-version、语义差异、worktree compatibility | 扩展 v3 schema |
| `update legacy-eval-snapshot plan` | 旧 EDD 快照接管 | 保留 |
| `apply` | exact-hash 原子应用与 receipt | 保留机器 hash；改用语义/独立审查 approval receipt |
| `context` | policy context 和 session receipt | 保留，另加 admission |
| `check` | session/commit/ci 分层可信检查 | 扩展交付/治理检查 |
| `drift` | policy 与 workspace 漂移 | 扩展远端 readback |
| `explain` | 单 policy 解释 | 保留 |
| `rollback` | 精确、本地、安全回滚 | 保留，不夸大远端可逆性 |
| `worktree status/audit` | 本机 Workspace 观察与规则审计 | 保留 |
| `worktree retention-audit` | 临时对象、锁、receipt、远端残留只读审计 | 保留 |
| `worktree integration-check` | 隔离 merge-tree 预测 | 保留 |
| `worktree configure` | portable config + host binding 计划 | 保留 |
| `worktree migrate/apply` | 窄安全前提的 container 迁移 | 兼容保留 |
| `worktree allocate` | 创建 Branch、Worktree、本机 lease 的计划 | 接入远端 lease |
| `worktree adopt` | 批量接管既有 Worktree | 接入远端映射 |
| `worktree rebind` | 修正本机 Branch/lease 映射 | GitHub 由当前 generation owner 先做远端 CAS；Local-only 原子更新 common-dir work-item lease |
| `worktree renew` | 更新本机 heartbeat/HEAD | GitHub 由当前 generation owner 先做远端 CAS；Local-only 原子更新 common-dir work-item lease |
| `worktree recover` | 删除 clean detached unleased 残留 | 兼容保留，避免名称混淆 |
| `worktree apply-ai` | Claude reviewer 授权允许的 Worktree 计划 | 迁入可配置的统一独立 Reviewer Adapter |
| `worktree review` | 固定 SHA detached 临时执行 | 保留 |
| `worktree close` | exact merge proof + 本机/远端 ref CAS 清理 | 放入 Closing journal |
| `delivery authorize/status` | 本机授权 envelope、receipt chain、派生 phase | 接入统一远端状态 |
| `delivery push` | scope/endpoint/drift 受约束 push | 增加 fencing token |
| `delivery pr` | 查找唯一 open PR或创建普通 PR | 改为 Draft/upsert/shared identity |
| `delivery merge` | required checks 后直接 squash merge | 迁移为 profile 控制/auto-merge |
| `session handoff/status/seed` | GitHub Issue/GitHub Project 驱动的确定性交接 | 接入 delivery atom |
| `github audit` | GitHub repo 治理只读报告 | 增加 settings plan/apply/readback |

### 9.1 MCP Surface

当前 MCP 正式暴露 Core 的 doctor/intake/discover/plan/apply/context/check/explain/drift/rollback/research 和 Worktree 的主要子集。CLI-only 或 MCP 不完整的能力包括 update、Session、Delivery、GitHub Audit，以及 rebind/renew/recover/migrate 等部分 Worktree 操作。

v3 不必为了形式对称复制每一个入口；但 `doctor` 和文档必须精确报告可用 surface，Host Adapter 需要的动作必须有稳定 service/CLI 路径。

## 10. 明确不做

以下项目不属于 v3 默认路线图：

1. 扫描所有本地/远端已合并 Branch 并后台自动删除；
2. 后台自动 fetch/rebase/merge 或静默解决冲突；
3. 让两个 Primary Agent 同时写同一 Work Item；
4. 把 Worktree 当增量目录或远端对象；它仍是完整 working tree；
5. 仅凭 Branch 名、Issue closed、PR closed、TTL 或 ancestry 单一条件执行破坏性清理；
6. 为每次只读 Debug 创建 Work Item、Branch 和 Worktree；
7. 每轮对话都重新做自然语言意图识别；
8. 将 Session fork 自动解释为新功能开发；
9. 没有真实宿主 API 时声称已自动切换会话目录；
10. 没有服务器端 enforcement 时声称 lease 能阻止所有绕过 Harness 的 push；
11. 自动把 fine-grained PAT 升级成 classic PAT，或把 admin 权限放入日常 token；
12. 为 GitLab/Jira 或其他假想后端编写空 Provider/插件框架；
13. 复活默认隐藏且绕过当前事务边界的 legacy v1 能力，或让旧正则 pre-scan 成为所有项目的必经 gate；
14. 为发布场景建设通用发布 Worktree 或自动发布平台；
15. 继续把复制不可读 JSON 的 plan hash 当作人工审批；
16. 未经用户明确批准创建、修改、删除或启用 GitHub ruleset、branch protection 或 workflow；
17. 默认把完整治理文档、plan JSON、review 推理或 receipt 注入开发会话上下文。

## 11. 推荐的 v3 最小交付范围与依赖顺序

### P0：先让核心不变量真实成立

1. 立即冻结超大 service/entrypoint 增长并补 characterization tests；每个后续 v3 纵向用例先抽取它需要的窄模块，保留 façade，不做一次性搬空重构；
2. 抽取并加固 plan transaction、receipt、last-known-good/safe mode，以及覆盖 GitHub 日常/admin 和 reviewer secret 的通用 Credential Broker；
3. 建立风险分类、语义审批包、可配置独立 Reviewer Adapter、approval receipt 和 Anti-self-lock 验收矩阵；
4. 为所有声称 `supported/enforced` 的 stack/rule 建立可执行 adapter/fixture/test 准入；隔离 legacy pre-scan，加固 `task.py`/`changelog.py`，建立 GitHub/Local-only Tracking 边界，以及只接受已完成旧 Provider readback 的干净终态或用户批准的不可达 Provider `TrackingMigrationWaiver` 的 mode migration；未决旧 atom 只能作为只读 reconciliation obligation 保留，不能迁入新 mode；并用跨 Worktree 用例证明 Git common dir 中只有一个 Local Tracking 事实源；
5. 完成窄 GitHub Adapter、governance audit 扩展、旧仓所有 Branch 分类及长期/未接管 Branch 删除保护差异计划、持续 satisfiability/recovery-path 检查、protected-action 人类 gate、空仓 Foundation 和 settings plan；此阶段不得激活会阻断开发的 Enforcement，未知 Branch 必须保持全局自动删除关闭；
6. 验证权威协调存储可行性，并实现带 `controlEpochDigest` 的 remote lease、generation、server time、具备零损失交接快照的 transfer/人工 takeover，以及 Integrated 后无写权限、无 TTL 的 terminal claim；
7. 实现新会话 Admission、一次确认的 Prepare 与 `PreparedNotOpened`；
8. 实现 GitHub Draft PR、跨 open/closed 状态的永久 shared PR identity、lastObservedHead/readyHeadSHA/integratedSourceHead/integratedCommit 分层、Ready 与 integration check phase、MergeArmed 有序退回、auto-merge/受限直接 merge、exact Provider integration 证明和最小 Abandon 终结路径；为 Local-only 实现目标-ref 集成锁与 base/source/integratedCommit CAS 证明；
9. 只有第 2、5—8 项形成的 credential、Work Item、Coordination、Branch push、PR 和 recovery path 端到端 preflight 成功后，才 Apply 并 readback 已批准的长期 Branch 删除保护、ruleset/required checks 与其他 GitHub Enforcement；验收必须证明无法完成受管 Delivery 时仓库仍停在 `EnforcementPending`，不会先锁死默认分支；
10. 实现 terminal claim、关闭安全快照、Remote Closing、cleanup token、Closing journal、带本机零损失复核的 reconciliation，以及 v2 local lease/direct merge/close 的显式迁移；
11. 最后完成单入口 `bootstrap` 的端到端编排和低上下文输出。CLI 壳可以提前存在，但依赖未齐时只能精确报告 pending capability，不能宣称 Bootstrap 场景已完成。

### P1：在真实需求出现后补齐适配体验

1. Codex/Claude Host Adapter 的真实创建/打开能力；
2. 有执行入口的 CI infrastructure retry；
3. High-throughput merge queue 的 profile 化。

P0 已经很大，因此模块拆分只做行为保持式迁移；v3 不同时重写现有 policy compiler、Eval、命名检查器或本机 Worktree 执行器。GitLab/Jira 不在 P1 排队，出现真实端到端需求后另行立项。

## 12. 成果03 审阅时应固定的决定

本文已经采用以下建议，用户可在成果03阶段直接修改：

1. 一个仓库、npm 包、CLI 和进程，内部按窄能力域原子化；不拆微服务；
2. 立即禁止旧超大 façade 增长；按 v3 纵向用例行为保持式抽取窄模块，不做先搬空全部大文件的大爆炸重构；
3. 新旧项目都使用一次 `harness-automation bootstrap --project .` 完成初始设置；旧项目的既有对象映射、adopt、目录迁移、已 drain 项目的 tracking mode 迁移和进入 Enforced 汇入一次人类清单，slash command 只作 Skill 路由；
4. Tracking 只有 GitHub 默认和用户明确声明的 Local-only 两种模式；已配置 mode 优先于 remote discovery，冲突时阻止新 Admission；活动 Delivery 只有在旧 mode 中成为无 `RecoveryRequired`、已完成必需 readback 的 `Closed`/`Abandoned` 才算 drained。永久不可达旧 Provider 只能凭用户批准的高风险 `TrackingMigrationWaiver` 放行切换，未决 atom 留在旧只读归档等待 reconciliation，不得伪造终态或迁入新 mode；不建设 GitLab/Jira 路线图或通用插件框架；
5. GitHub 模式默认使用原生 Issue/GitHub Project/PR，`gh`/`gh api` 操作平台对象，`git` 操作 refs；故障不切换为本地事实源；
6. Local-only 使用内置且加固的 `task.py`/`changelog.py` 操作 Git common dir 中唯一权威的 `TASK.json`/`CHANGELOG.jsonl`，并采用 common-dir work-item lease、目标-ref 集成锁与缩短的无 PR 生命周期；它不承诺跨 clone 或跨机器协调，Agent 不临时现写；
7. plan hash 只作机器完整性，不再要求人类复制；需要人类 gate 时审批可读语义清单，普通计划由 reviewer verdict 绑定 hash；
8. 只有忠实派生自已批准语义的实质性计划可由独立第二 AI 自动审查批准；MiniMax-M3 是候选配置，不写死；reviewer 不能发明 policy、Apply、拿 admin token 或降低风险，其 Provider/模型/信任和数据范围变更必须用户明确批准；
9. ruleset、branch protection、workflow 和其他 protected actions 未经用户明确批准不得写入；一次 Bootstrap 只汇总询问一次；
10. Anti-self-lock 是硬不变量：gate 激活前不仅证明 reviewer/check/recovery path 可满足，还要证明 credential、Work Item、Coordination、Branch push 和 PR 路径端到端可达；漂移不改变 coverage，只把 enforcement 降为 `EnforcementPending` 并安全撤防已武装 PR，不自动弱化；Recovery plane 不依赖当前损坏 policy/CI/reviewer，自动修复最多重审一次；
11. 声称 `supported/enforced` 的技术栈能力必须有可达 adapter、失败 fixture、测试和实际 gate；诚实只是底线，真实落实才是目标；
12. 旧正则 pre-scan 不进入 v3 标准流程，只可作 legacy 迁移诊断并允许后续删除；
13. 治理默认静默运行，主会话只收到异常、一次审批清单和最终结果；完整 artifact 落盘；
14. 新工作采用当前模式的 Work Item + Delivery Branch + mode-appropriate lease + Delivery Worktree；GitHub 使用 Issue/远端 lease，Local-only 使用 common-dir `TASK.json` 条目/common-dir work-item lease，并在集成时另取目标-ref 集成锁；只读 Debug 例外；
15. GitHub 远端 lease 默认只能宣称 coordinated，除非另有 server-side enforcement；所有远端状态 CAS 都绑定统一 `controlEpochDigest`。GitHub 原生 CAS 不可行时新的 v3 Delivery 最多停在 Admitted，Branch/Worktree/push/PR/Ready/merge fail closed；已创建 Issue 和独立获批的 Governance Foundation 可以保留，不能静默增建协调后端；
16. GitHub 新 PR 默认 Draft；所有模式的 Ready 绑定 exact Head，Head、绑定输入或 control epoch 变化使旧验收/review/Ready 失效；MergeArmed 后修改必须保持写冻结，先禁用 auto-merge 并 readback，再以远端 CAS 退出 MergeArmed、失效旧 Ready，最后才允许 push；
17. GitHub auto-merge 是推荐路径但不是必经状态；Local-only 不仿造 auto-merge；
18. GitHub Solo profile 需要 PR 与 CI，但 required human approvals 为 0；门禁由风险和 profile phase 决定，本地确定性检查默认阻止 Ready，GitHub required checks 默认可在 Ready 后 pending 但必须阻止实际集成；高风险/含糊验收的人类证据必须在 Ready 前成立，任何平台 gate 都不能超过实际合格参与者；
19. Integrated 后先以 CAS 将匹配 generation/head/control epoch 转为无写权限、无 TTL 的 terminal claim，再完成当前权威主写 Worktree 的零损失快照，之后才进入 Closing；正常精确收尾按已批准 profile 静默执行，永久丢失机器只能经人工风险接受记录 waived obligation；GitHub 使用远端 tombstone、Local-only 使用本机 Closing journal。远端 Closed 只触发离线副本 reconciliation，每台恢复机器仍重新执行本机零损失检查和 SHA guard；全局 Branch 清理器明确不做；
20. delivery Branch/Worktree 短生命周期，management checkout、默认分支、release/maintenance 例外长期存在；GitHub 全局自动删 head Branch 前必须分类所有现存 Branch，并先保护所有长期/未接管 Branch 不被删除；存在未知 Branch 时保持全局设置关闭；
21. 日常 fine-grained PAT 按开发者×机器×仓库配置，GitHub 日常/admin 与 reviewer secret 都由系统密钥库存储并分权；
22. v2 现有能力通过显式迁移复用，不修改历史来伪造成果01一直成立；v3 受管对象不得继续走绕过远端 Closing 的 compatibility close；
23. 每个交付原子的主 PR identity 跨 open/closed/merged 状态永久唯一，但可变 lastObservedHead、Ready 的 readyHeadSHA、合并后的 integratedSourceHead/integratedCommit 分开记录；精确观察到绕过 Ready 或必需集成门禁的真实合并时接受 Integrated 外部事实并记录 PolicyViolation，未经过可选 MergeArmed 本身不构成违规；
24. Governance 的 Coverage 与 Enforcement 是正交观察维度：AuditOnly 的 v3 控制面只允许 observe/report/plan/receipt，Mixed 只写明确受管对象，Managed 覆盖全部声明对象；EnforcementPending 在首个缺失 gate 处阻止转换，只有完整 Delivery preflight 与治理 readback 都通过才进入 Enforced。显式 v2 compatibility 操作不获得 v3 保证，adopt 后不得再用 compatibility close；
25. Abandon 是 P0 人工终结路径：精确资产清单获批后以 CAS 终止受管写入和集成、保留身份，Branch/Worktree 默认不删除；任何资产归档或删除另行审批。Abandoned 后若 Provider 精确证明合并，必须覆盖为 Integrated + PolicyViolation 并建立 terminal claim，不能否认外部事实；
26. 普通跨机器 transfer 只有在旧 owner 的零损失交接快照和 exact 远端 Head 均可验证时才静默执行；否则保持 HandoffPending，或走用户批准、明确记录潜在内容损失的 takeover。

## 13. 实现证据索引

以下文件是本文状态判定的主要依据：

- `mcp-server/src/cli.ts`：正式 CLI surface；
- `mcp-server/src/index.ts`：正式 MCP surface 与 legacy v1 opt-in 边界；
- `mcp-server/src/v2/service.ts`：intake/discover/plan/update/apply/check/drift/rollback/context/doctor/research；
- `mcp-server/src/v2/policy.ts`：profile、policy rules、managed instruction blocks 和生成检查器；
- `mcp-server/src/v2/evals.ts`：Eval Contract 与 EDD 发现/验证；
- `mcp-server/src/v2/verifier.ts`：TypeScript、Python、Go 命名检查；
- `mcp-server/src/worktree/service.ts`：Workspace audit、计划、allocate/adopt/rebind/renew/recover/review/close/retention/integration；
- `mcp-server/src/worktree/provider.ts`：GitHub provider 观察与未安装 adapter 边界；
- `mcp-server/src/session/service.ts`：GitHub Session handoff/status/seed；
- `mcp-server/src/delivery/service.ts`：delivery authorization、push、PR、direct merge 和 CI failure classification；
- `mcp-server/src/github/governance.ts`：GitHub governance read-only audit；
- `mcp-server/src/scanners/code_scanner.ts`、`claude_extractor.ts`、`integration.ts`、`scan_cache.ts`：只由 legacy v1 暴露的正则 pre-scan 实现；
- `scripts/task.py`、`scripts/changelog.py` 与 `mcp-server/package.json`：当前随包复制但仍走 legacy 部署的本地任务/变更脚本；
- `scripts/github_tracker.py`：本仓库使用的 GitHub Issue/GitHub Project 辅助工具，不是当前 npm 产品 adapter；
- 对应 `*.test.ts` 与 `mcp-server/src/__tests__/*.test.ts`：公开行为和失败边界测试。

仓库 README 的 CLI/MCP 清单落后于部分源码入口，因此本文以实际公开 CLI、MCP handler 和测试为准；这项文档漂移应在 v3 实现阶段一并修正。模块行数来自当前基线的物理行统计，用作 no-growth 告警，不作为独立架构质量指标。
