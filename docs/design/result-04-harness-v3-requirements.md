# 成果04：Harness Automation v3 正式需求文档

> 状态：`Approved`；正式需求基线，由已批准的成果03逐项展开，不新增产品边界。
>
> Owner：`zhichao`
>
> 日期：2026-09-03
>
> 跟踪工作项：[GitHub Issue #78](https://github.com/realpkuasule/harness-automation/issues/78)
>
> Provider-neutral 上游：[成果01](./result-01-branch-worktree-collaboration-target.md)，SHA-256 `83f8bacbfc1472a6e581d23fe1c4c492421f9a9b1da497e85458701b465d27f4`
>
> 现状证据：[成果02](./result-02-harness-v3-scenario-feature-inventory.md)，SHA-256 `1f362297ec7b6be694a90efb63523e0ff137c48f1e6eb95467562327948d0ce2`
>
> 获批功能边界：[成果03](./result-03-harness-v3-feature-contract.md)，当前 SHA-256 `f2689c89fef25c5ed544c16657988767551bde8b1d460fb8817b0ae193840d60`；其获批候选 SHA-256 为 `8fb3c07c36c7c0bd5a6df369717fe953d22c3097e9fa15626b5d35c31d4952be`。获批候选是语义授权锚点；当前文件是批准登记后的引用载体，其批准记录说明第 4 节功能矩阵及第 5～9 节语义未变。本文件逐项展开成果03第 4 节的 68 项功能，并将其第 5～9 节转为验收约束。

## 1. 范围与权威

本文件规定 Harness Automation v3 必须满足的可验证结果。它不是实现计划，
不指定模块、文件、类、数据库、队列、服务拆分、排期或负责人。

权威顺序与用途如下：

| 来源 | 本文件中的角色 | 冲突处理 |
|---|---|---|
| 成果01 | Branch/Worktree/协作治理的 Provider-neutral 术语与安全下限 | 不得降低；v3 可选择更窄的 Provider 范围 |
| 成果03 | 已批准的 v3 功能边界、优先级、硬不变量和延后门 | 本文件只能展开；改变语义必须回到成果03重新批准 |
| 本文件 | v3 验收与发布声明的正式需求基线 | 实现、测试和文档都必须可追溯到本获批版本 |
| 成果02 | v2.8.11 现状、场景和差距证据 | 可更新实现状态，但不能反向改写正式需求 |
| `docs/PRD.md` 的窄范围需求 | 只按各章节记录的批准状态和 Issue 范围生效 | 不得把整份文件冒充 v3 已批准 PRD；冲突按第 9 节显式收敛 |
| v2 产品/实现设计 | `harness-skill-v2.md`、`worktree-delivery.md`、`project-governance-upgrade.md` 只提供 v2 compatibility/实现证据 | 不得反向改变 v3 边界；精确裁决见第 9 节 |
| 更早的系统设计/对比/backup | `harness-automation-design.md`、`harness-automation-design-v2.0-backup.md`、`harness-design-comparison.md` 只提供历史证据 | 不提供 v3 权威状态、架构或路线图；精确裁决见第 9 节 |

本文件的正式化不构成实现授权，也不构成 GitHub protected action、额外协调后端、
Reviewer Provider/model/credential/data scope 或 Harness policy apply 的授权。

## 2. 规范语言与验收证据

- **必须 / 不得**：发布 v3 或声称对应能力成立前必须满足。
- **应该**：默认行为；偏离时必须有项目级批准理由和回执。
- **可以**：可选能力；不存在时不得影响 P0 基线。
- `P0`、`P1`、`Compat`、`Out` 的含义与成果03完全相同；它们不是实现状态。
- 每个功能 ID 同时是本文件的需求主键，并且与成果03一一对应。
- “已实现/部分实现/待实现”只在成果02维护，本文件不复制易漂移状态。

证据类型：

| 代码 | 含义 |
|---|---|
| `DET` | 可重复的自动化测试、fixture、schema/哈希/状态断言或负面控制 |
| `LIVE` | 针对真实 GitHub、Git、宿主或系统密钥库的集成测试和 readback |
| `PROC` | 结构化计划、receipt、journal、tombstone 或审计记录证明过程成立 |
| `HUM` | 绑定可读对象、风险和范围的人类明确批准 |
| `COG` | 独立 Reviewer 的受限 verdict；不能单独授权 protected/destructive action |

每个 P0/P1 需求必须同时有成功证据和失败关闭/负向证据。非确定性判断只能使用
`COG` 或 `HUM`，不得伪装成 `DET`。

能力声明属于不同维度，不构成一条可互换的强弱阶梯：

| 声明 | 精确定义 |
|---|---|
| `configured` | 目标配置存在且可读取 |
| `loaded` | 对应 Agent/工具可发现预期 policy digest |
| `passing` | 当前仓库通过对应 verifier；不证明 known-bad 会失败 |
| `supported` | 对应 capability 的 adapter 可达，正向 fixture 通过、known-bad 失败，且所需真实 gate 可用 |
| `enforced` | 对应 rule/capability 的可执行 gate 在真实边界拒绝 known-bad；不等于 Governance 的 `Enforced` |
| `coordinated` | 全部受管客户端遵守租约/fencing，但 token 校验未与服务端 ref 更新原子绑定 |
| `server-enforced` | 服务端把授权 token 校验与 ref 更新原子绑定 |
| `EnforcementPending` / `Enforced` | Governance 的正交维度：当前 profile 的 Delivery preflight、可满足性和治理 readback 未全部成立 / 已全部成立 |

主生命周期之外的术语必须按以下正交类别使用：

| 类别 | 固定术语 | 含义 |
|---|---|---|
| Delivery 附着标记 | `Blocked`、`LeaseExpired`、`HandoffPending`、`Disarming`、`RecoveryRequired`、`PolicyViolation` | 附着于当前主状态，不是新主状态 |
| 控制面结果 | `ReviewPending`、`NeedsHuman`、`PreparedNotOpened`、`CoordinationBackendRequired`、`TrackingModeMigrationRequired` | 表示一次控制面操作的结果，不写入 `lifecycleState` |
| Governance 维度 | Coverage：`Unconfigured/AuditOnly/Mixed/Managed`；Enforcement：`EnforcementPending/Enforced` | 两维正交，且不改变 Delivery 主状态 |
| 终结记录形态 | terminal claim、tombstone | terminal claim 是 Integrated 后同一协调记录的无写权限形态；tombstone 是 Closed/Abandoned 后的持久终态记录，二者都不是主状态 |

## 3. 统一模型与全局不变量

| ID | 正式需求 | 最低验收 |
|---|---|---|
| INV-01 | Branch 必须仅表示提交引用，Worktree 必须仅表示 checkout 目录，Work Item/PR 必须仅表示协作对象，Session 必须仅表示宿主上下文。 | `DET`：schema 和输出保持身份分离；类型错配或以名称代替身份时拒绝。 |
| INV-02 | 新代码工作的交付原子必须绑定一个 Work Item、一个 Delivery Branch、当前 Tracking Mode 的唯一主写协调记录和一个 Delivery Worktree；只读 Debug 可以停在 `Observed`。 | `DET+PROC`：完整建立或零建立；任一对象缺失时不得进入 `Prepared`。 |
| INV-03 | Tracking Mode 只能是 GitHub 或用户明确选择的 Local-only，且不得因网络、凭证或 Provider 故障自动切换。 | `DET`：故障保持原 mode 并失败关闭；不存在 GitLab/Jira 或通用 Provider 默认路径。 |
| INV-04 | 唯一主生命周期必须为 `Observed → Admitted → Prepared → Active → Draft? → Ready → MergeArmed? → Integrated → Closing → Closed`，并只允许成果03规定的 Abandon 和外部合并替代边。 | `DET`：状态迁移表覆盖全部合法边并拒绝其他边；历史事实不被重写。 |
| INV-05 | Delivery 附着标记、控制面结果、Governance Coverage 与 Enforcement 必须正交，且不得写入 `lifecycleState`。 | `DET`：序列化与迁移测试拒绝维度混写；Coverage 不授予转换权限。 |
| INV-06 | 一个本地 Branch 同时最多在一个 Worktree checkout；一个 Work Item 同时最多一个权威主写者。Worktree 不是锁，语义冲突必须由更新、检查、review 或集成显式发现。 | `DET`：重复 checkout/lease 阻断；两个隔离目录的冲突 fixture 仍被集成检查发现。 |
| INV-07 | 未把 token 校验与 ref 更新服务端原子绑定时，保证级别必须报告为 `coordinated`，不得报告为 server-enforced。 | `DET+LIVE`：无服务端门禁 fixture 只能得到 coordinated；绕过 Harness 的写入被检测为漂移而非声称已阻止。 |
| INV-08 | generation/fencing 必须隔离写者代次，`controlEpochDigest` 必须隔离协议、Tracking Mode、policy 与配置纪元；两者不得互换。 | `DET`：旧 generation、旧 epoch、旧 Head 和 CAS 冲突均在写入前失败。 |
| INV-09 | `Ready` 只证明 exact Head 与绑定输入下的开发证据成立，不等于 required checks 已通过或一定可以集成。 | `DET`：Ready 后 check 可以 pending；Head/身份/策略变化使旧证据失效。 |
| INV-10 | Integrated 必须作为 Provider 或目标-ref CAS 证明的外部事实；绕过门禁的精确合并仍进入 Integrated，并附加 `PolicyViolation`。 | `DET+LIVE`：违规精确合并不被否认；普通 ancestry 或模糊证据不能建立 Integrated。 |
| INV-11 | Integrated 后必须先建立无写权限、无 TTL 的 terminal claim，再验证零损失快照，随后才可进入 Closing 并签发一次性 cleanup token。 | `DET+PROC`：顺序不可交换；claim/快照/CAS 任一失败均保留可恢复资产。 |
| INV-12 | Branch 和 Worktree 的短生命周期只适用于受管 Delivery；默认、release、maintenance Branch 与 management checkout 是显式长期例外。TTL 只能用于发现。 | `DET`：长期对象和未知对象不能成为自动删除目标；超期仅产生审计 finding。 |
| INV-13 | ruleset、branch protection、workflow 及其他 protected GitHub 写入必须绑定一次可读清单和 `HUM` 批准；普通 plan hash、Reviewer verdict 或功能批准不能替代。 | `DET+HUM+LIVE`：无匹配批准时零远端写入；获批后逐项 readback。 |
| INV-14 | 任何门禁激活前必须证明 credential、Work Item、协调、push、PR、review/check 与独立 recovery path 可满足；恢复平面不得依赖正在损坏的 gate。 | `DET+LIVE`：缺一项保持 `EnforcementPending`；自修复最多重审一次后返回 `NeedsHuman` 控制面结果。 |
| INV-15 | Git transport、日常 API、临时 admin 与 Reviewer 凭证必须分权；明文 secret 不得进入仓库、argv、日志、receipt 或 Agent 上下文。 | `DET+LIVE`：泄漏 canary 和越权调用被拒；缺权不自动扩大 scope。 |
| INV-16 | 治理默认静默运行；主会话只接收异常、一次可读批准清单和最终摘要，但完整事实与回执必须落盘。 | `DET+PROC`：安静模式不丢字段；错误仍包含可执行恢复动作。 |
| INV-17 | 由 Harness 执行的计划型控制面 mutation 和治理 Apply 必须先绑定现场、输入和目标哈希，原子 Apply，readback 并持久化 receipt；失败不得留下未声明半成品或覆盖用户后续修改。开发期代码写入只按 D-01/D-02 授权与 fencing，不要求每次编辑生成 immutable plan。 | `DET+PROC`：计划篡改、漂移和注入故障均在写前拒绝或按 journal 恢复；普通编辑不产生控制面计划。 |
| INV-18 | configured、loaded、passing、supported、enforced、coordinated、server-enforced 与 Governance `Enforced` 必须按第 2 节各自维度报告，不得互相替代。 | `DET`：known-bad、adapter 缺失和外部门禁缺失分别产生精确状态，不被归一化为成功或更强声明。 |
| INV-19 | Tracking Mode 迁移必须先关闭或放弃旧对象并完成旧 Provider readback；永久不可达仅能由 `TrackingMigrationWaiver` 结束，未决对象保留只读归档。 | `DET+HUM+PROC`：无 waiver 的不可达对象阻断切换；迁移不伪造历史。 |
| INV-20 | 产品保持一个 npm 包、CLI 和进程；能力域职责必须有界，但本需求不得预设内部模块或微服务拆分。 | `DET`：公开行为与一个 CLI 基线可验证；架构评审拒绝新增第二套事实源、执行器或审批系统。 |

## 4. 功能需求与验收

### 4.1 Core：策略、审查与连续性

| ID | 优先级 | 正式需求 | 最低验收 |
|---|---|---|---|
| C-01 | P0 | 所有跨 Agent 基线能力必须可由同一 CLI 调用；Skill 只能编排，MCP 只能复用同一服务语义。 | `DET` 正：无 MCP 仍完成基线；负：CLI/MCP 同输入产生不同计划或状态时失败。 |
| C-02 | P0 | Intake/Plan/Apply 必须只消费 owner 明确批准且版本化、哈希绑定的 PRD、设计、调研和发现来源。 | `DET+HUM` 正：批准来源可追溯；负：新增、删除或字节漂移使未执行计划失效。 |
| C-03a | P0 | 系统必须自动发现仓库事实、技术栈、Agent 能力和指令冲突，并区分 observed/inferred 与证据。 | `DET` 正：fixture 自动恢复事实；负：冲突或低置信信息被静默当作事实时失败。 |
| C-03b | P0 | 只有 adapter 可达、known-bad 会失败、有效 fixture 会通过且真实 gate 已连接时，才可声明 stack/rule supported 或 enforced。 | `DET+LIVE` 正：正负 fixture 与 gate readback 齐全；负：任一缺失返回 blocked 并列出 capability-level 证据缺口，绝不宣称落实。 |
| C-04 | P0 | 计划必须 canonical、不可变、完整哈希绑定并原子 Apply；普通、可逆且忠实派生自 owner-approved sources 的计划必须由受限独立 Reviewer 绑定同一哈希给出 verdict；新的 policy/source 语义、weakening、高风险语义和 protected action 仍须人类审批可读语义。 | `DET+COG+HUM` 正：批准与同一计划绑定；负：篡改、Reviewer 自审/Apply/越权或仅复制裸 hash 均不能授权。 |
| C-05 | P0 | 必须提供 Check、Drift、Explain、Receipt、last-known-good、safe mode 和不覆盖后续修改的 Rollback。 | `DET+PROC` 正：故障注入后可解释并恢复 owned bytes；负：目标已被用户修改时 rollback 停止而非覆盖。 |
| C-06 | P0 | 新会话、不同 Agent 和不同机器必须加载同一批准策略摘要；宿主缺能力时显式降级。 | `DET` 正：多 adapter 返回同一 policy digest；负：缺 hook/MCP 时不得声称 native enforcement。 |
| C-07 | P0 | 已应用项目升级必须精确继承已批准 profile、stacks、baseline 和显式配置，不得用新版默认值替换。 | `DET` 正：round-trip 深度相等或显式 diff；负：未知字段、来源漂移或 weakening 无授权时零计划/零写入。 |
| C-08 | Compat | TypeScript 历史命名债务只能按固定 rule ID `typescript-naming` 的稳定 SHA-256 指纹精确保留或收缩；指纹必须绑定 canonical 仓库相对路径、标识符角色和名称，不得依赖行号、格式或诊断文案，并按多重集精确匹配。Parse error 不得产生可采纳指纹；扩张或替换必须经 fresh explicit owner adoption intake，并复用同一 plan/apply 路径。 | `DET+HUM` 正：已批准多重集可通过、格式变化不改指纹且修复后自动收缩；负：新增、移动、角色/名称变化、数量扩张、parse error 或无 fresh intake 的替换均被拒。 |
| C-09 | Compat | 旧 EDD 快照只能诚实 adoption，并明确 `historicalContinuity=unavailable`。 | `DET+HUM` 正：adoption 绑定旧/新证据；负：不得伪造实施前快照或自动批准 weakening。 |
| C-10 | P0 | EDD 只能作为可选 quality profile；每项非确定性能力必须有 Requirement/suite/rule traceability、真实 baseline、negative control 和 grader 证据。 | `DET+COG` 正：traceability 完整且 known-bad 失败；负：只有 prompt/类型声明时不得称为 gate。 |
| C-11 | P0 | stack、delivery、domain、quality profile 必须正交合成，任一 profile 不得静默削弱公共规则。 | `DET` 正：组合矩阵保持公共不变量；负：顺序变化、缺省值或 profile 冲突导致削弱时失败。 |
| C-12 | Compat | 旧正则 pre-scan 只能用于迁移诊断，不得成为 v3 新项目默认 gate 或事实源。 | `DET` 正：legacy audit 可调用；负：v3 Bootstrap 不依赖其结论且移除它不破坏主流程。 |
| C-13 | P0 | 新旧项目必须共用一次 Bootstrap：只读汇总后消费一次语义批准，再原子 Apply/readback；相同计划重试不得重复索取批准。 | `DET+HUM+PROC` 正：一次清单覆盖同一 semantic plan；负：对象/风险/内容变化使旧批准失效。 |
| C-14 | P0 | 能力域职责必须保持有界，旧超大 façade 不得继续吸收新跨域逻辑；迁移必须保持公开行为兼容。 | `DET` 正：契约测试证明公开行为兼容且新职责未进入旧 façade；负：新增第二事实源、执行器或状态权威时不得验收。 |

### 4.2 Governance、Tracking 与 Provider

| ID | 优先级 | 正式需求 | 最低验收 |
|---|---|---|---|
| G-01 | P0 | GitHub repository/organization Audit 必须完整分页、只读、可追溯并在任一分页或权限失败时失败关闭。 | `DET+LIVE` 正：多页 fixture/真实仓库完整；负：截断、限流、403 或未知字段不能给出 clean。 |
| G-02 | P0/P1 | P0 只支持 Solo、Team、High-risk GitHub Profile；High-throughput merge queue 为 P1；Legacy 与 Local-only 分别归 G-03/G-06。 | `DET` 正：三种 P0 profile 可配置；负：不得生成第三 Provider、通用插件框架或把 merge queue 设为 P0 前提。 |
| G-03 | P0 + Compat | 旧项目 Bootstrap 必须分别推进 Coverage `AuditOnly→Mixed/Managed` 与 Enforcement `EnforcementPending→Enforced`；只管理显式接管对象。 | `DET+PROC` 正：混合资产逐项归属；负：未知/未接管对象不被改写、迁移或清理。 |
| G-04 | P0 | GitHub Mode 必须以原生 Issue 和配置的 GitHub Project 创建、验证和更新 Work Item；平台故障不得切换事实源。 | `DET+LIVE` 正：Issue/Project readback 一致；负：不可达时阻断新交付且不写本地替代任务。 |
| G-05 | P0 | 一个 GitHub Adapter 必须统一身份、Issue、PR、checks、merge、settings、CAS 和 readback 语义。 | `DET+LIVE` 正：所有调用使用同一身份/仓库绑定；负：部分 API 失败不退回隐式 `gh` 全局状态或 Local-only。 |
| G-06 | P0 | Local-only 必须由随包版本化的 `scripts/task.py` 与 `scripts/changelog.py` 操作 `<git-common-dir>/harness/local-tracking/TASK.json` 与同目录 `CHANGELOG.jsonl`；tracking、common-dir work-item lease、目标-ref 集成锁和状态记录必须在 Git common dir 各有唯一权威副本。 | `DET+PROC` 正：多个 Worktree 看到同一权威 tracking、lease、集成锁和状态并可原子更新；负：per-worktree 副本、临时现写脚本或跨机器保证声明均失败。 |
| G-07 | P0 + 延后门 | GitHub 新交付前必须完成 DG-01，证明远端 CAS/等价协调；否则停在 `Admitted + Blocked + CoordinationBackendRequired`，不得偷建第二后端。 | `LIVE+PROC` 正：真实仓库并发负面测试通过；负：CAS 不成立时不得进入 Prepared，保证级别不得高于 coordinated。 |

### 4.3 Workspace、Branch 与 Worktree

| ID | 优先级 | 正式需求 | 最低验收 |
|---|---|---|---|
| W-01 | P0 | 状态命令必须只读观察 checkout、Worktree、Branch、lease、dirty/untracked/ignored、unique/unpushed、容量和拓扑。 | `DET` 正：machine-readable Git fixture 完整；负：只读命令前后 ref、index、文件和 common-dir 清单不变。 |
| W-02 | P0 | 每台机器必须保留一个受保护 management checkout/safety root；Delivery Worktree 不得占用或删除它。 | `DET` 正：唯一管理根可识别；负：缺失、歧义、嵌套或目标命中受保护路径时阻断 mutation。 |
| W-03 | P0 | 新项目必须采用 container 布局，明确共同 Git 数据、`main/` management checkout 与 `worktrees/` 交付目录。 | `DET+PROC` 正：新建布局无歧义；负：不得把 container 当仓库或在仓库内部递归创建 Worktree。 |
| W-04 | P0 | legacy-flat 迁移必须由精确计划、排空前置、逐步回执和不可伪造事实驱动；首次接管不得捆绑目录移动。 | `DET+HUM+PROC` 正：安全中断可恢复；负：有 lease/交付目录/dirty/路径漂移时不移动。 |
| W-05 | P0 | Prepare 必须为一个 Work Item 原子建立 Delivery Branch、模式适用的唯一 lease 和 Delivery Worktree。 | `DET+PROC` 正：三对象与 Head 映射同时成立；负：中途失败只补偿本事务新建且未承载内容的对象。 |
| W-06 | P0 | Adopt 必须支持宿主或用户已创建的 Worktree，但先验证 repository、Work Item、Branch、Head、canonical path 和 lease 唯一性。 | `DET` 正：合法对象只写元数据；负：不得 checkout、移动、清理或改写被接管内容。 |
| W-07 | P0 | GitHub Rebind/Renew 必须由当前 generation owner 先远端 CAS 再更新本机缓存；Local-only 必须对 common-dir lease 做原子条件更新。 | `DET+LIVE` 正：成功更新绑定、到期时间或 Head，并保持同一预期 generation；只有 W-08 的 transfer/takeover 才增加 generation。负：旧 owner、Head、epoch 或 hash 失败后不得更新缓存。 |
| W-08 | P0 | 跨机器 Transfer 必须先冻结旧写者并形成零损失交接快照，再以单次 CAS 替换 owner/generation；证据不足只能 HandoffPending 或人类批准 takeover。 | `DET+HUM+PROC` 正：新机器可取回 exact Head；负：dirty/unique/unpushed/离线不明时不得普通转交。 |
| W-09 | P0 | Integration Check 必须只读证明 source/target Head、merge-base、ahead/behind、dirty、unpushed、冲突和策略条件。 | `DET` 正：可重复报告精确证据；负：不得更新项目 object database、refs、index、working tree 或 common dir；允许工具自有临时 object directory，但失败必须关闭并清理。预测冲突必须阻断。 |
| W-10 | P0 | Review Worktree 必须 detached、只读、短生命周期且不获得主写租约。 | `DET+PROC` 正：exact commit review 后安全移除；负：review 产生修改或清理不安全时保留目录和恢复回执。 |
| W-11 | P0 | Retention Audit 必须只报告超期和异常 lease/Worktree/receipt，不得自行删除。 | `DET` 正：TTL finding 可追溯；负：运行前后路径、ref 和文件集合不变。 |
| W-12 | P0 + 延后门 | 独立 AI Review 必须经 DG-02 的可配置、最小权限 Reviewer Adapter，只输出绑定 plan/evidence hash 的 verdict。 | `DET+COG+HUM` 正：独立进程/身份、无工具 Apply；负：超时、歧义、自审、hash 漂移或 secret 缺失均失败关闭。 |
| W-13 | P0 | 分配与关闭前必须确定性验证容量预算、canonical path、受保护根和 Worktree 拓扑。 | `DET` 正：边界值可预测；负：容量超限、symlink escape、重叠或路径漂移时零 mutation。 |
| W-14 | P0 | `worktree recover` 只能回收 clean、detached、unleased 的本机残留 Worktree并保留 Branch；Closing 和跨机器恢复必须走各自正式流程。 | `DET+PROC` 正：符合四条件的残留幂等回收；负：任一条件不成立即保留资产。 |

### 4.4 Session 与宿主适配

| ID | 优先级 | 正式需求 | 最低验收 |
|---|---|---|---|
| S-01 | P0 | 新会话必须在首次受管写入前加载有效 policy digest、项目上下文和当前 Delivery 事实。 | `DET` 正：新会话证据绑定当前摘要；负：缺失、过期或对象不匹配时阻止写入。 |
| S-02 | P0 | 新会话第一轮必须区分新工作、继续已有工作、只读 Debug 和非代码任务；老会话只在关键事实变化时复核。 | `DET` 正：四类场景走对应路径；负：未完成新工作准入前不得改代码，也不得每轮重复全量询问。 |
| S-03 | P0 | 新代码工作必须只汇总一次可读确认，确认后原子 Prepare；宿主无法打开目录时返回 `PreparedNotOpened`。 | `DET+HUM+PROC` 正：确认绑定 Work Item/Branch/path/scope；负：不得伪称已经切换当前会话 cwd。 |
| S-04 | P0 | handoff/status/seed 必须以 Git 产物、receipt、policy digest 和 Work Item 状态为事实，聊天摘要只能作提示。 | `DET` 正：新会话可由持久证据恢复；负：聊天与仓库冲突时以权威事实阻断。 |
| S-05 | P1 | 只有存在真实宿主 API 时才可创建并打开 Host-native Worktree 任务；否则给出精确人工打开步骤。 | `DET+LIVE` 正：API readback 证明目标目录；负：能力缺失时不得声称自动切换或以 shell 改变其他会话。 |
| S-06 | Out | 系统不得为共享同一 checkout 的多个 Local 会话宣称并行写隔离。 | `DET` 正：明确报告 shared checkout/Branch；负：不存在会话级伪锁或隐藏 Branch 切换。 |
| S-07 | Out | Session Fork 不得自动创建 Issue、Branch、lease 或 Worktree；新代码工作仍走 Admission/Prepare。 | `DET` 正：fork 只复制允许的会话历史；负：fork 前后交付原子集合不变。 |

### 4.5 Delivery、PR、CI 与集成

| ID | 优先级 | 正式需求 | 最低验收 |
|---|---|---|---|
| D-01 | P0 | 每次受管写入必须绑定 Work Item、Branch、Head、generation、control epoch、policy/scope 和 owner。 | `DET` 正：完整 authorization 可验证；负：任一字段缺失/漂移时写前失败。 |
| D-02 | P0 | Push 前后必须验证授权和远端 Head；失去 lease、fencing、scope 或 CAS 时失败关闭并保留本地工作。 | `DET+LIVE` 正：有效 push/readback；负：并发远端更新或旧 token 不得被当作成功。 |
| D-03 | P0 | 一个交付原子必须永久只有一个主 PR identity，跨 open/closed/merged 状态不得新建替代主 PR。 | `DET+LIVE` 正：重试返回同一 identity；负：发现多个候选时保持当前主状态并附加 `RecoveryRequired`，不得猜选。 |
| D-04 | P0 | GitHub 首次有效代码 Push 后默认必须建立该 identity 的 Draft PR；若首次 Push 时已经满足完整 Ready 条件，可以直接创建同一 identity 的 Ready PR。Local-only 不得伪造 PR。 | `DET+LIVE` 正：Draft 或 fast path Ready 都绑定 exact Head、head/base mapping，后者还绑定全部 Ready 证据；负：无 Push、错误 Head 或已有 identity 时不重复创建。 |
| D-05 | P0 | `harness-automation delivery ready` 必须生成 exact Head 和控制面绑定的 `ready-evidence/1.0`。 | `DET+PROC` 正：schema、hash 和全部 gate 引用有效；负：缺证据、旧 Head 或旧 epoch 不得进入 Ready。 |
| D-06 | P0 | Head、PR identity/mapping、policy/scope、control epoch、验收或 review 输入变化时，旧 Ready evidence 必须立即失去授权效力；若当前为 MergeArmed，仍保持 `MergeArmed + Disarming + Blocked` 和写冻结，直到 disable/readback/CAS 完成后才退回 Active/Draft。 | `DET+LIVE` 正：旧证据保留为历史且撤防顺序可恢复；负：失效证据不得武装、解冻或集成。 |
| D-07 | P0 | 本地 gate、Ready gate 和 integration gate 必须分阶段记录；required checks 可在 Ready 后 pending，但实际集成必须被平台门禁阻止。 | `DET+LIVE` 正：每个 gate identity/trigger/result 可 readback；负：不存在的 check 不得冒充 pending/success。 |
| D-08 | P0 | GitHub auto-merge 必须是 Ready 后的推荐可选支路；武装、撤防和 readback 必须有序并保持写冻结。 | `DET+LIVE` 正：满足门禁后可 MergeArmed；负：新 push 前未确认撤防、Head 漂移或平台结果不明时不得解冻。 |
| D-09 | Compat | v2 checks-green 直接 merge 只能服务尚未 adopt 的对象；v3 对象不得借兼容路径绕过 Ready 或 Closing。 | `DET` 正：legacy identity 精确识别；负：adopted/v3 对象调用该路径被拒。 |
| D-10 | P1 | 只有真实 CI 入口且错误被可靠分类为基础设施故障时，才可有限、可配置、可审计重试。 | `DET+LIVE` 正：瞬态 fixture 在上限内恢复；负：测试失败、未知错误或超限不重试。 |
| D-11 | Out | 系统不得后台自动 rebase/merge 主线，也不得隐式改写功能提交来消除分歧。 | `DET` 正：只读报告 behind/conflict；负：检查和守护流程前后 source/target refs 不变。 |
| D-12 | P0 | 只有 Provider 精确 merge 事件或 Local-only 目标-ref CAS 才能证明 Integrated；真实违规合并必须记录 `PolicyViolation`。 | `DET+LIVE+PROC` 正：普通/squash/Local-only 三类证据分别成立；负：ancestry、名称或 CI 绿不能单独证明。 |

### 4.6 Closing、清理与 Reconciliation

| ID | 优先级 | 正式需求 | 最低验收 |
|---|---|---|---|
| L-01 | P0 | 普通 merge 与 squash merge 必须分别保存并证明 exact `integratedSourceHead`/`integratedCommit`。 | `DET+LIVE` 正：两种策略均绑定永久 PR/目标 ref；负：squash 不要求错误 ancestry，模糊映射被拒。 |
| L-02 | P0 | 清理前必须证明权威主写 Worktree tracked clean、无 unique/unpushed，且 untracked/ignored 不存在或已有可丢弃证据。 | `DET+PROC` 正：零损失快照 hash 绑定身份与 Head；负：任一未知或变化时保留所有资产。 |
| L-03 | P0 | 本地和远端 ref 只能由 cleanup token 针对精确 ref 与 expected old SHA 做 CAS 删除。 | `DET+LIVE` 正：匹配 SHA 幂等完成；负：ref 移动、复用、token 不匹配或权限不明时不删除。 |
| L-04 | P0 | 平台已自动删除远端 Branch 时必须幂等记录外部事实，但仍独立验证本机资产。 | `DET+LIVE+PROC` 正：远端 absent 与 exact merge 证据关联；负：远端不存在不得自动授权本机删除。 |
| L-05 | P0 | Closing 必须严格执行 terminal claim → closing safety snapshot → Closing CAS/journal/cleanup token → 精确步骤 → Closed/tombstone。 | `DET+PROC` 正：逐步重入复用同一 token/journal；负：Closing 前失败保持 `Integrated + RecoveryRequired`，进入 Closing 后失败保持 `Closing + RecoveryRequired`；两者都禁止新 lease 和重复签发。 |
| L-06 | P0 | 每台离线旧副本必须以 reconciliation obligation 独立收敛，并重新验证零损失和本机 SHA guard。 | `DET+PROC` 正：安全副本最终回执关联 tombstone；负：远端 Closed、TTL 或旧 receipt 不能单独授权本机删除。 |
| L-07 | P0 | Abandon 必须绑定 `HUM` 批准的精确资产清单，终止受管交付；默认保留 Branch/Worktree 和 tombstone，不授予删除权。 | `DET+HUM+PROC` 正：未合并对象可终结且映射保留；负：MergeArmed 未撤防或 Provider 已合并时不得 Abandon。 |
| L-08 | Out | 系统不得扫描并删除所有“看起来已合并”的 Branch/Worktree，只能关闭可证明拥有的交付原子。 | `DET` 正：未知/长期/未接管对象只报告；负：名称、年龄、ancestry 或 TTL 单独触发删除即失败。 |

### 4.7 凭证与权限

| ID | 优先级 | 正式需求 | 最低验收 |
|---|---|---|---|
| A-01 | P0 | Git transport、GitHub 日常 API、临时 admin 和 Reviewer 凭证必须按用途分离，不得从隐式全局登录借权。 | `DET+LIVE` 正：每条路径报告非秘密 credentialRef/identity；负：错用途或身份不一致时拒绝。 |
| A-02 | P0 | 日常 GitHub 凭证默认必须是开发者 × 机器 × 仓库的 fine-grained PAT；classic PAT 仅在记录官方能力缺口后例外。 | `LIVE+HUM+PROC` 正：scope/仓库/identity 最小化 readback；负：跨仓库或宽 scope 不被静默接受。 |
| A-03 | P0 | secret 只能存系统密钥库，运行时只注入单个子进程内存/环境，不得进入 argv 或持久证据。 | `DET+LIVE` 正：子进程可用且生命周期受限；负：仓库/日志/计划/receipt 扫描无 secret canary。 |
| A-04 | P0 | 日常 token 与临时 admin token 必须分权；ruleset/workflow/settings 写入只能用受保护、限时、精确范围的管理授权。 | `DET+HUM+LIVE` 正：普通操作不持有 admin；负：无 PG-01 或凭证过期时零治理写入。 |
| A-05 | P0 | 每次使用前必须验证身份、仓库和实际 API 能力，并记录非秘密权限摘要与到期日；401/403 必须失败关闭。 | `DET+LIVE` 正：能力 probe 与实际操作一致；负：失败不得触发网页登录循环、自动提权或 Tracking Mode 切换。 |

## 5. 持久合同

### 5.1 `ready-evidence/1.0`

Ready evidence 必须至少包含：

- `repository`、`workItem`、`branch`、`trackingMode`、`owner`；
- 适用时的 `generation`，以及 `readyHeadSHA`、`controlEpochDigest`、`policyDigest`、`scopeDigest`；
- 验收、gate、review 证据引用、`createdAt` 与 `evidenceHash`；
- GitHub Mode 的 `sourceRepositoryId`、永久 `prIdentity`、`baseRepositoryId/baseRef`、
  `headRepositoryId/headRef`；Local-only 不得伪造这些 Provider 字段。

`evidenceHash` 必须覆盖除自身外的 canonical 内容。任一绑定输入变化后，旧记录只能作为
历史证据，任何 MergeArmed/集成命令必须拒绝它。正向验收必须证明相同输入可重复验证；
负向验收必须逐字段篡改并证明失败。

### 5.2 `local-closing/1.0`

Local-only Closing 的唯一权威路径必须为：

```text
<git-common-dir>/harness/worktree-delivery/closing/<sha256(workItem)>.json
```

记录的 `kind` 必须是 `local-closing-record`，并至少包含 `repository`、`workItem`、
`branch`、`integratedSourceHead`、`integratedCommit`、`lifecycleState`、
`closeOwnerGeneration`、`controlEpochDigest`、结构化 `closingSafetySnapshot`、
`cleanupToken`、逐步 `steps`、`reconciliationObligations`、`createdAt`、`updatedAt` 和
`recordHash`。

- snapshot 必须 hash 绑定 Worktree identity、Head 及 dirty/untracked/ignored/unique/unpushed 证据；
- cleanup token 只能表示本轮精确清理授权，不能充当通用 bearer secret；
- 每次更新必须验证 expected `recordHash` 并可证明线性化；原子 rename 只能证明单次写完整，不能单独冒充 CAS；
- Closed 后身份和最终 journal/receipt 冻结，后续 reconciliation 只能追加关联 receipt；
- 记录不得含任何明文凭证。

验收必须包含两个并发写者、进程中断、ref 漂移、重复恢复和字段篡改的负面测试，且不得
出现双 token、丢步骤、历史改写或不安全删除。

## 6. 延后门与受保护门

| Gate | 必须先证明/批准 | 未满足时的唯一结果 |
|---|---|---|
| DG-01 GitHub 原生协调可行性 | 在真实公开/私有测试仓库证明选定 GitHub 原生对象的 CAS、server time、generation/fencing 与 readback，并通过并发负面测试 | GitHub 新 Delivery 停在 `Admitted + Blocked + CoordinationBackendRequired`；额外协调后端必须另立架构批准 |
| DG-02 Reviewer Adapter 配置 | 用户明确批准 Provider、model、credentialRef、私有内容范围与信任级别；接口同时证明最小权限、独立身份和失败关闭 | 普通计划不得获得 Reviewer allow；不得回退为主 Agent 自审或偷偷把原始项目内容外发 |
| PG-01 Protected GitHub 写入 | 一次可读清单精确列出 repository、设置、before/after、风险、恢复路径和计划摘要，并取得用户明确批准 | ruleset、branch protection、workflow、settings 和任何保护弱化零写入 |

`allow_auto_merge` 与 `delete_branch_on_merge` 可以是项目 Bootstrap 的可配置目标，但 Apply
仍受 PG-01 约束。启用全局自动删除前必须完成全部现存 Branch 分类，并以平台规则保护
默认/release/maintenance/未知/未接管 Branch；无法证明保护时保持关闭。

## 7. 端到端验收场景

| 场景 | 必须证明的结果 |
|---|---|
| 新 Solo GitHub 项目 | Bootstrap 一次批准；Issue/Project、Delivery、Draft PR、Ready、checks、可选 auto-merge、Closing 闭环；required human approvals 为 0 |
| 新 Team/High-risk 项目 | 只有真实可履责 reviewer/CODEOWNER 才启用对应 gate；不可满足时保持 EnforcementPending，不自锁 |
| 从未使用 Harness 的旧项目 | 先 AuditOnly，未知对象保持不变，adopt/migrate/治理写入分别计划，Coverage 与 Enforcement 独立推进 |
| 新会话提出新功能 | 写代码前识别新工作，一次确认后 Prepare；宿主不能打开时诚实返回 PreparedNotOpened |
| Debug | 只读复现不创建交付原子；一旦需要受管写入，再升级为正常 Work Item/Branch/lease/Worktree |
| 一台机器并行两个功能 | 两个 Work Item 使用不同 Branch/Worktree/lease；共享对象 DB 不造成文件覆盖，语义冲突在集成边界被发现 |
| 同一工作串行换会话 | 新会话接管同一交付原子，不另建 Branch/Worktree/PR；以持久证据而非聊天摘要续做 |
| 多人、多机器、多 Agent | 每台机器有独立 management checkout；远端协调唯一主写，CLI 语义一致，未服务端强制时只声明 coordinated |
| 跨机器 Transfer/Takeover | 普通 Transfer 保证零损失；高风险 takeover 必须有人类风险批准并保留被放弃资产证据 |
| 主线变化/冲突 | behind 只报告，冲突阻断 Ready/集成；不后台 rebase/merge 或修改提交 |
| PR、CI、Review、Auto-merge | Ready 与 integration gate 分离；Head 变化失效证据；MergeArmed 写冻结与撤防顺序可恢复 |
| 合并后关闭及离线副本 | exact merge → terminal claim → snapshot → Closing → Closed；离线机器独立 reconciliation |
| npm 发布 | version、验证、tag、publish 和重试复用现有 primary/management checkout；不创建 release Worktree |
| Local-only | TASK/CHANGELOG、common-dir work-item lease、目标-ref 集成锁和 Closing 记录均在 Git common dir 各有唯一权威副本；不宣称跨 clone/机器协调 |

P0 发布声明必须在至少一个真实 GitHub 仓库和一个 Local-only fixture 上覆盖上述适用场景，
并注入网络失败、401/403、CAS 冲突、stale Head、dirty/unique/unpushed、进程中断、
Reviewer 不可用、gate 不可满足和 protected action 无批准等失败。任何失败被吞并成 success、
`No findings` 或更强能力声明，都属于发布阻塞。

## 8. P0 验收顺序与完成定义

验收顺序必须保持成果03的依赖，不规定施工模块：

1. Core transaction、Credential、Reviewer/Anti-self-lock 与 adapter 证据准入；
2. Tracking 边界、GitHub/Local-only Adapter 和旧项目 Bootstrap；
3. DG-01、远端协调、terminal claim、Transfer/Takeover；
4. Admission/Prepare、Branch/Worktree、Draft PR、Ready、checks/auto-merge 与 Local-only 目标-ref 集成锁；
5. 完整 Delivery preflight 后才可激活获批 GitHub Enforcement；
6. Integrated、Closing、cleanup、tombstone、reconciliation 与 Abandon；
7. 最后验证一次 Bootstrap 和 quiet control plane 的纵向编排。

P0 完成必须同时满足：

- 成果02、成果03当前文件第 4 节、本文件的 68 个功能 ID 集合相同，且每个 ID 在本文件第 4 节只有一个主需求；成果03批准记录说明该矩阵自获批候选摘要起未变；
- 每个 P0 有正向、负向和与声明强度相称的证据；所有 known-bad 均被拒绝；
- `Compat` 只能处理精确 legacy identity，`Out` 没有可执行隐式路径；
- CLI 是可独立运行的基线，MCP/宿主能力缺失不破坏可用基线；
- `check --mode session`、CI 适用检查、drift 和端到端 fixture 全部通过；
- protected/deferred gate 未满足时保持明确 blocked，不以 mock、文档或人工约定冒充；
- 文档、schema、公开命令和 receipt 与本需求一致，旧文档冲突已按第 9 节限定作用域。

## 9. 既有文档冲突收敛记录

本节通过“保留历史 + 限定作用域 + 明确迁移边界”解决冲突，不改写过去已经发生的事实。
本轮裁决绑定以下精确输入；任一输入变化后必须重新执行冲突检查，不能沿用本表结论：

| 输入 | SHA-256 |
|---|---|
| `docs/PRD.md` | `579ce16f28e13a9719ae0928138ec0125c04175d5a2826d07a14e26913bc623b` |
| `docs/design/harness-skill-v2.md` | `37448fa527133a99b3dad892f6ba1000493befe64d91c3f06c1a177f98761ab2` |
| `docs/design/project-governance-upgrade.md` | `b8ac3cf666054cd18be53a9c4ca50193988da130eb3ffaa25ead56b0c07ed9d7` |
| `docs/design/worktree-delivery.md` | `aaa32ed7b25f4870c8e8a0ca61a0f6fdd68698a85d8f2134c47d4c3e4f89a641` |
| `docs/design/harness-automation-design.md` | `be715a5787993196dd447b70d2db90d448957c54097082608ccb677c1289e507` |
| `docs/design/harness-automation-design-v2.0-backup.md` | `9b27dc8b89be4d84d738e7c1e44ce5efcb4ddabe0f2c7c105f4b16a7fb942bfc` |
| `docs/design/harness-design-comparison.md` | `1ad7263e9ad68012e8511f0a7b773d97a9c0144690de6b75c644e2e6b97ca0bb` |

| 既有文档/语义 | 裁决 |
|---|---|
| [docs/PRD.md](../PRD.md) 的 npm release 与项目治理升级 PRD | 只按各自章节记录的批准状态和 Issue 范围使用，整份文件不得冒充 v3 已批准 PRD；其中首个 PRD 的自举修订仍是待批准状态。npm release 的 management checkout 例外进入第 7 节；v2 update 的 exact hash 继续作完整性/compat gate，但不恢复 v3 普通计划“让人复制裸 hash”的交互。 |
| [harness-skill-v2.md](./harness-skill-v2.md) | 作为 v2 产品与兼容证据。CLI 基线、单一服务和证据强度继续复用；旧 owner/exact-hash 审批表述在 v3 由 C-04、DG-02、PG-01 分风险取代。 |
| [project-governance-upgrade.md](./project-governance-upgrade.md) | 仅定义 Issue #69 的 v2 update 实现边界。其 policy update 不移动 Worktree 是正确的命令边界，不限制 v3 Bootstrap 调用独立、获批的 topology migration；其中既有模块 owner 和最小文件集不是 v3 总体架构，不得覆盖 C-14 no-growth，具体拆分留给后续架构设计。 |
| [worktree-delivery.md](./worktree-delivery.md) 的旧 Close | 保留为 v2.8.x 实现证据；尚未 adopt 的对象可走精确 compatibility。v3/adopted 对象不得使用“先删 Worktree/lease、再删 ref”路径，必须满足 INV-11 与 L-01～L-06。 |
| `worktree-delivery.md` 的 GitLab/Jira blocked 配置 | 旧字段可以只读保留用于审计/迁移，不得为 v3 新建或宣称支持。v3 新工作只能选择 GitHub 或显式 Local-only。 |
| [harness-automation-design.md](./harness-automation-design.md) 与 [v2.0 backup](./harness-automation-design-v2.0-backup.md) 的 MCP-first、默认 workflow 生成及旧 A/B 状态 | 作为历史设计保留，不是 v3 需求来源。v3 以 CLI 为基线；workflow 受 PG-01；旧测试状态不得写入 Delivery/Coverage/Enforcement。 |
| 旧设计的 `.harness/state.json` 与 `evaluated/confirmed/generated/validated` | 仅表示 legacy v1 工作流进度，不得迁移或映射成 v3 Delivery 状态；policy 状态和 configured/loaded/passing/enforced 观察结果也继续留在各自正交域。 |
| 旧设计的默认 pre-scan、A/B telemetry、自动认知 Skill 与适用性流程 | 不在获批的 68 项边界内，不进入 v3 需求；pre-scan 仅按 C-12 用于兼容诊断，真实 EDD 仅按 C-10。新增这些能力必须先修订成果03。 |
| v2 多轮 decide/plan/apply 交互 | 内部可以保留阶段，但 v3 用户界面必须按 C-13 汇总为一张语义清单和至多一次等待；对象与计划未变的恢复不得重复索取批准。 |
| [harness-design-comparison.md](./harness-design-comparison.md) | 仅作历史分析，不提供 v3 权威状态、架构或路线图。 |

若实现只能通过违反本表裁决来满足旧测试，必须将该测试标为 legacy scope 或先完成显式
migration；不得削弱本需求、伪造兼容或直接删除历史证据。

## 10. 明确不在本需求内

- 微服务、后台 daemon、通用 Provider 插件框架或未批准的协调后端；
- GitLab/Jira 路线图；
- 自动把 Session Fork 变成新的交付原子；
- 为每次只读 Debug 或 npm release 创建 Worktree；
- 全局扫描并删除“已合并”Branch/Worktree；
- 后台自动 rebase/merge、强制 ref/Worktree 删除或自动处理未知本机资产；
- 让 Reviewer Apply、自授权限、获得 admin token 或审批自身生成的政策；
- 未经用户明确批准创建、修改、删除、启用或削弱 GitHub ruleset、branch protection、workflow/settings；
- 在本文件指定内部模块、文件所有权、数据库、队列、服务拆分、排期或发布版本号。

任何新增能力、Provider、持久事实源、授权类型或强于 coordinated 的保证，都必须先回到
成果03修订并重新批准，再更新本文件与验收证据。

## 11. 批准记录

当前记录：`Approved`。

批准人：`zhichao`；批准日期：2026-09-03；获批候选 SHA-256：
`ca4a3b4b72b9b9801f970b69c0db4d7905a2397a14cf6bf007493c4f122db150`。

该批准只确认本文档对成果01和成果03的展开语义，不授权实现代码、Harness policy
intake/apply、GitHub protected action、额外协调后端或 Reviewer
Provider/model/credential/data scope。批准登记只改变标题、状态、时态和本记录；第 2～10
节的需求语义未变。批准后的只读复核又完成两处非语义术语收敛：消除对成果03的指代
歧义，并将 L-07 的资产表述与成果03统一；成果01规定的 commit 和未提交内容默认保留
下限不变。上述候选摘要已在批准登记前按原始字节核对，并在登记后反向还原复核。任何
实质语义修改都必须重新批准；批准登记造成的物理文件摘要变化不得覆盖上述获批候选摘要。
