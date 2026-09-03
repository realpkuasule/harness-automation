# 成果01：Branch、Worktree 与跨机器多人协作目标方案

> 状态：已确认的目标治理模型
>
> 日期：2026-09-02
>
> 关联工作项：[GitHub Issue #78](https://github.com/realpkuasule/harness-automation/issues/78)
>
> 内部一致性：第九轮统一 Closing journal、清理授权、Lease schema、并发令牌职责与跨文档权威边界。

## 1. 文档定位

本文把 Branch、Worktree、会话、Issue、PR 和跨机器协作整理为一套归一化模型，
回答以下问题：

- 一项代码工作如何获得独立提交线和独立工作目录；
- 多人、多机器、多 coding agent 如何避免同时写同一交付项；
- 代码何时进入 PR、何时可以合并、何时可以安全清理；
- 宿主不能自动创建或切换会话时如何诚实降级；
- 旧项目如何在不破坏现状的前提下逐步接管。

本文是与 Harness、GitHub、Codex、Claude Code 和具体 CLI 无关的目标规范。
它不声明当前产品已经实现其中任何能力；现状与缺口将在“成果02”中单独核对。
具体命令、配置 schema、内部 ref 名称、租约时长和 UI 也不在本文定型。

规范用语：

- **必须**：违反后会破坏安全性或核心不变量；
- **应该**：默认推荐，可以由明确的项目 profile 覆盖；
- **可以**：可选能力，不构成通用前提。

## 2. 一句话结论

普通并行开发的推荐交付原子是：

~~~text
一个可独立交付的工作项
↔ 一个交付 Branch
↔ 至多一个主 PR
↔ 至多一个有效写租约
↔ 至多一个有效主写交付 Worktree
~~~

Branch 负责隔离提交线，Worktree 负责隔离本地文件目录，写租约负责隔离当前写入
责任。三者解决的问题不同，缺一项都不能完整覆盖多人、多机器并行开发。

## 3. 必须分开的三层

### 3.1 Git 原生事实

- Branch 是指向某个提交的可移动引用，用来表达一条提交线。
- Worktree 是某台机器上的工作目录；它检出某个 Branch 或具体 commit。
- 主 checkout 本身也是一个 Worktree。本文称它为“管理 checkout”，避免把
  Branch 名 main 和工作目录混称为“main worktree”。
- 一个本地 Git 仓库可以关联多个 Worktree；它们共享 Git object database，
  但各自拥有工作文件、HEAD 和 index。
- Worktree 显示的是一套完整项目文件，不是只保存增量文件。共享 object database
  可以节省提交对象空间，但依赖目录、构建产物和未跟踪文件仍可能在每个 Worktree
  中各占一份空间。
- 协作所说的远端托管仓库保存 commits 和 refs，不保存开发者机器上的 Worktree。
- Git 通常阻止同一本地仓库把同一 Branch 同时检出到两个 Worktree，但无法阻止
  不同 clone、不同机器同时检出并修改同一 Branch。
- Git 本身没有 Issue、PR、review、auto-merge 或“唯一主写者”的概念。

### 3.2 治理规则

治理层补充 Git 不提供的约束：

- 工作项、Branch、PR、写租约和交付 Worktree 的映射；
- 当前唯一主写者以及跨机器转交；
- 新工作准入、交付检查、合并门禁和精确清理；
- 过期、断网、冲突、接管和故障恢复；
- 旧项目的审计、计划、接管和强制模式；
- 确定性自动化与人工判断的边界。

### 3.3 宿主适配

宿主是 Codex、Claude Code、IDE、终端或其他 coding agent 运行环境。宿主适配器
只负责：

- 识别当前会话所在目录、Branch 和 Worktree；
- 宿主提供能力时，创建或打开对应会话；
- 宿主不能自动切换时，返回已准备路径和明确的打开指引；
- 将宿主会话绑定到已经存在的治理对象。

宿主会话不是治理状态的权威来源。关闭、复制或 fork 会话均不得自动创建新的
工作项。会话 fork 只是上下文分叉；仓库 fork 是另一个远端仓库；二者都不等于
Worktree。只有 fork 动作同时显式申请了新工作目录时，才会伴随新的 Worktree。

## 4. 归一化术语

| 术语 | 规范含义 |
|---|---|
| 仓库（Repository） | commits、refs 和 Git 对象的逻辑集合；可以有远端和多个本地 clone |
| 工作项（Work Item） | 可独立开发、审查和合并的最小交付单元，通常对应一个 Issue |
| GitHub Project | GitHub 原生看板；是工作流视图，不是 Git 对象或宿主工作目录 |
| Host Project | 宿主保存的仓库入口，例如 Codex Project；可以关联同一 repository 的多个 Worktree，不是 GitHub Project |
| 管理 checkout | 某台机器长期保留的受保护 checkout，通常检出默认 Branch |
| 交付 Branch | 工作项专属的短生命周期提交线 |
| 交付 Worktree | 当前主写者为该工作项修改代码的本地工作目录 |
| 主 PR | PR-capable Provider 中工作项唯一的正式集成入口；无 PR 的正式模式中数量为零 |
| 写租约 | 限时、可转交、带代次的主写权限记录 |
| 控制纪元（controlEpochDigest） | 绑定协调协议/schema、tracking mode、effective policy 与 delivery/governance config 的摘要；不同纪元不得操作同一受管交付记录 |
| 目标-ref 集成锁（target-ref integration lock） | 无 PR 的共享本机模式中按目标 ref 唯一的短时锁；它串行化不同工作项对同一目标 Branch 的集成，不替代各工作项写租约 |
| Terminal claim | Integrated 后由精确 generation/head/controlEpochDigest 固化的无写权限、无 TTL 终结责任，用于安全快照、Recovery 和 Closing |
| cleanup token | 进入 Closing 的 CAS 中一次性签发并绑定 workItem、integratedSourceHead、integratedCommit 和当前模式适用的精确对象，只授权该次精确清理；ref 删除仍需 old-SHA guard |
| Closing journal | Closing 的耐久记录，保存精确清理计划、逐步结果和恢复进度；它不授予清理权限，也不能替代 cleanup token |
| Tombstone | 同一权威记录在 Closed 或 Abandoned 后持久保留的终态形态，冻结身份、最终 journal/receipt 和待 reconciliation 义务；它不授予删除权限 |
| 主写者 | 当前持有有效写租约的开发者、机器和会话组合 |
| Review Worktree | 对确定 commit 做检查的短生命周期 detached Worktree |
| 宿主会话 | Agent 或 IDE 的交互上下文，不等同于 Branch 或 Worktree |
| 开发 Head（lastObservedHead） | 开发期间最近一次观测到的可变交付 Branch Head |
| Ready Head（readyHeadSHA） | Ready 证据绑定的精确 Head；任何绑定输入变化都会使它失效 |
| 集成源 Head（integratedSourceHead） | 精确集成事件最终接受的交付 Branch Head；进入 Integrated 后固化 |
| 集成提交（integratedCommit） | 变更进入目标 Branch 后的 commit；Squash 时与 integratedSourceHead 不同 |

### 4.1 “独立提交历史”的实际意义

独立 Branch 不只是“保留信息”，而是把尚未集成的变更放在主线可达范围之外。

例如：

~~~text
main:              M0
                    ├── feature/101-export: E1 ─ E2
                    └── feature/102-login:  L1
~~~

- 导出功能未合并时，main 和登录功能都不会自动包含 E1、E2。
- 导出功能被放弃时，可以关闭它的交付原子，而无需从 main 删除代码。
- 导出功能通过 PR 后才进入公共主线。
- Branch 不会消除语义依赖。若 C 依赖已经合并的 B，之后回滚 B，C 可能需要同步
  修复；这是代码依赖问题，不是 Branch 能自动隔离的问题。

因此 Branch 的核心作用是“在集成决策之前隔离变化”，而不是保证合并后的变化
永远互不影响。

## 5. 核心不变量

对一个处于开发阶段的工作项：

1. 必须只有一个交付 Branch。
2. 整个交付原子生命周期内必须至多只有一个主 PR；无 PR 的正式模式中为零。旧 PR closed-unmerged 后不得为同一工作项自动另建第二个主 PR。
3. 必须至多只有一个有效写租约。
4. 必须至多只有一个拥有主写资格的交付 Worktree。
5. 多个会话可以串行继续同一工作项；其他并发会话只能阅读，或在固定 SHA 的隔离
   Review Worktree/独立 clone 中测试和 review。不得让无租约会话在主写交付
   Worktree 中运行可能产生文件变化的命令。
6. 需要多个主写者真正并行时，必须拆成可独立合并的子工作项；每个子工作项建立
   自己的交付原子。
7. 管理 checkout 不承载普通功能开发，也不得通过切换 Branch 临时变成功能目录。
8. 工作项身份、远端 Branch、PR 和写租约属于跨机器协调状态；绝对 Worktree 路径
   只属于本机，不写入共享策略。
9. “一个主写 Worktree”表示治理角色唯一，不表示故障恢复期间世界上绝不可能
   留下第二个物理目录。旧目录可以休眠或待救援，但不能继续交付。
10. 治理约束正常协作中的误操作。拥有 Git 权限的人故意绕过工具，不属于本方案
    单独能够提供的安全隔离。

## 6. 每台机器的推荐工作区

治理系统自行创建目录时，推荐：

~~~text
example/
├── main/                 # 长期管理 checkout
└── worktrees/
    ├── 101-export/       # Issue #101 的交付 Worktree
    └── 102-login/        # Issue #102 的交付 Worktree
~~~

规则如下：

- 外层 example 容器不是 Git 仓库；
- main 目录长期存在，普通交付 Worktree 随工作项建立和关闭；
- 绝对路径只存于本机绑定；
- Codex 等宿主原生创建 Worktree 时，治理层验证并接管，不重复创建第二个目录；
- 既有平铺项目不得自动搬迁，目录迁移必须独立计划并明确批准。

张三、李四、王五在三台机器上各自拥有一个管理 checkout。这三个目录不是同一个
Worktree，也无需共享文件系统。它们通过同一个远端默认 Branch 对齐：

- 在工作准入和集成等受控边界 fetch；
- 管理 checkout 干净且能够 fast-forward 时才更新；
- 不后台 reset、切换 Branch 或制造其他会话不可见的目录变化。

## 7. 生命周期

主流程保持简单：

~~~text
Observed → Admitted → Prepared → Active → Draft → Ready
                                                  ├──→ MergeArmed ──→ Integrated
                                                  └────────────────→ Integrated
                                                                         ↓
                                                                      Closing
                                                                         ↓
                                                                       Closed

Admitted / Prepared / Active / Draft / Ready
        └─── 经人工批准的放弃 ───→ Abandoned

Abandoned ── Provider 后续精确证明合并 ──→ Integrated + PolicyViolation
~~~

Draft 与 MergeArmed 只适用于 PR-capable Provider；正式的无 PR 共享本机模式从 Active 经 Ready 进入集成时，还必须取得目标-ref 集成锁，绑定 expected base/source SHA，并以 ref CAS 固化 exact integratedCommit 后才能进入 Integrated；不得仿造 PR 或 auto-merge。

下表第三列统一表示进入该状态及维持该状态成立所需的条件。

| 状态 | 含义 | 进入/保持条件 |
|---|---|---|
| Observed | 仅讨论、检查或只读诊断 | 尚无代码写入意图 |
| Admitted | 已确定工作项 | Issue 或等价工作项存在且可验证 |
| Prepared | 交付环境已准备 | Branch、租约和交付 Worktree 映射成立 |
| Active | 正在开发 | 当前会话通过环境和租约复核 |
| Draft | PR-capable Provider 已推送有效代码 | 唯一 Draft PR 已建立 |
| Ready | Agent 声明开发完成 | 交付证据、检查和映射满足要求，并绑定 readyHeadSHA、controlEpochDigest 与 policy/scope；任一绑定输入变化立即失效 |
| MergeArmed | 已启用 auto-merge 的可选支路 | PR 非 Draft，平台支持且允许 |
| Integrated | 交付变更已被精确集成事件接受 | 固化 integratedSourceHead 与目标 Branch 上的 integratedCommit；Squash 不要求两者存在 ancestry；首次受管观察时把写 generation 转为 terminal claim |
| Closing | 已冻结交付身份并正在精确收尾 | cleanup token 和 Closing journal 已经建立 |
| Closed | 权威交付身份已经关闭 | 当前主写和本轮可达资产已精确收尾；旧离线副本已登记 reconciliation obligation，永久丢失义务仅可经人工风险接受标为 waived，并形成最终回执 |
| Abandoned | 未集成工作已被显式放弃 | 人工批准已绑定精确身份和资产清单；受管写入与集成已终止，Branch/Worktree 默认保留；后续 exact merge 外部事实仍可覆盖为 Integrated + PolicyViolation |

以下是标记而非额外主状态：

- Blocked：当前转换条件不满足；
- LeaseExpired：旧主写资格已经失效；
- HandoffPending：正在显式转交写入责任；
- Disarming：保持写冻结，正在解除平台 auto-merge；
- RecoveryRequired：存在不确定、部分成功或待救援状态；
- PolicyViolation：Provider 已证明外部事实成立，但转换绕过了受管门禁。

以下是控制面操作结果，不是 Delivery 主状态或附着标记：`ReviewPending`、
`NeedsHuman`、`PreparedNotOpened`、`CoordinationBackendRequired`、
`TrackingModeMigrationRequired`。Governance/Bootstrap 另以两个正交维度观察：Coverage
使用 `Unconfigured/AuditOnly/Mixed/Managed`，Enforcement 使用
`EnforcementPending/Enforced`。Coverage 只界定受管对象，不授权状态转换：
`Unconfigured/AuditOnly` 只读，`Mixed` 只管理明确子集，`Managed` 覆盖声明范围。
Enforcement 只门禁转换：`EnforcementPending` 在第一个缺失能力处阻断，只有当前
profile 的 Delivery preflight、satisfiability 与治理 readback 都成立才是 `Enforced`；
Local-only 只评估对应本机能力。两维都不改变已经成立的 Delivery 主状态。

任何阶段都不得因为对象“看起来很旧”而直接跳到 Closed。

Provider 已经精确证明预期 PR/integratedSourceHead 实际合并时，`Integrated` 是不可否认的外部事实；若合并绕过 Ready 或当时 profile 要求的集成门禁，必须记录 `PolicyViolation`、立即冻结继续写入，并按完整关闭前提收尾。`MergeArmed` 是可选状态：从 Ready 经满足服务端门禁的人工/平台合并进入 Integrated，不因未武装 auto-merge 而违规。只有直接 push、普通 ancestry 或其他含糊证据时，仍停在 `RecoveryRequired`，不得自动清理。

## 8. 新工作与 Debug 准入

### 8.1 新会话

- 新会话第一次出现代码写入意图时，必须执行准入判断。
- 新会话已经位于映射有效的交付 Worktree 时，应该确定性恢复已有工作项，不重复
  创建 Issue、Branch 或 Worktree。
- 新会话位于管理 checkout，且识别为新功能或需要代码修改的新修复时，不得先写
  代码；用户确认一次后，再准备交付原子。
- 老会话已经准入同一工作项后，不需要每轮重新识别意图。
- 只有只读转写入、工作项变化、Branch、路径、租约、策略或 Issue 状态变化时，
  才重新验证。

若宿主无法改变当前会话目录，治理层只能返回 PreparedNotOpened：交付环境已经
准备，但用户仍需在宿主中打开指定目录或创建原生 Worktree 会话。系统不得声称
已经切换当前会话。

### 8.2 Debug

- 阅读代码、运行测试和不改文件的复现不需要新 Branch 或 Worktree。
- 一旦需要修改受版本控制内容，包括临时日志，必须进入已有工作项的交付
  Worktree，或建立新的交付原子。
- 不为每次诊断创建“临时诊断 Worktree”。
- 对确定 commit 做独立检查时，可以使用 detached、短生命周期 Review Worktree。

### 8.3 新工作的失败关闭

若新工作依赖远端工作项和远端权威租约，而平台、网络或凭证不可用：

- 可以继续讨论、阅读和只读诊断；
- 不得建立新的交付 Branch、交付 Worktree 或写租约；
- 不得创建临时本地 Issue，稍后再静默回填。

非 GitHub 项目可以正式配置其他工作项提供者，但不得在故障时临时改变事实来源。

## 9. 写租约

### 9.1 定义

写租约不是 Git 原生对象，而是跨机器的限时主写许可。它最少记录：

~~~text
repository
workItem
branch
sourceRepositoryId（承载交付 Branch 的不可变 Provider repository ID；非 fork 时等于受管 repository 的 Provider ID）
owner
machine
sessionRef（可选；宿主会话或 workspace 的不透明引用，不作为身份或权限证据）
generation / fencing token
controlEpochDigest
createdAt
expiresAt
lastObservedHead
lifecycleState（第 7 节 Delivery 主状态在同一权威记录中的持久化投影）
closeOwnerGeneration（仅 terminal claim 建立后；固定被接管的写 generation）
~~~

`lifecycleState` 不是 lease 子状态机。合法值是现有主状态的记录可达子集：
`Admitted | Prepared | Active | Draft | Ready | MergeArmed | Integrated | Closing | Closed | Abandoned`。
`Observed` 通常由协调记录不存在表示；`Draft/MergeArmed` 在无 PR 模式不可达。
Delivery 附着标记、控制面结果以及 Coverage/Enforcement 都不得写入该字段。

Terminal claim 是协调记录在 Integrated 后形成的无写权限生命周期形态，不是另一个
schema 字段或 `lifecycleState` 枚举值，也不是 `closeOwnerGeneration` 的别名；此时
`lifecycleState=Integrated`，后者只记录该终结责任冻结的写 generation。

Branch 回答“提交到哪条线”，Worktree 回答“在哪个目录修改”，写租约回答“现在谁
可以作为主写者交付”。

### 9.2 权威性和原子性

1. 远端协调状态必须是权威；本机记录只是缓存。
2. 获取、续期、转交和恢复必须使用 compare-and-swap 或等价原子条件更新。
3. 协调记录必须保存单一 `controlEpochDigest`；获取、续期、写入、Ready、merge、terminal claim 和 Closing 的每次 CAS 都要验证它。纪元变化时，活动交付只能经过显式兼容迁移继续，否则保持 Blocked；旧客户端不得按旧 schema 猜测新状态。
4. 每次转交或恢复必须产生新的 fencing token。
5. generation/fencing token 隔离主写者代次，`controlEpochDigest` 隔离协议、policy 和 config 纪元，二者不可互换。除首次获取以 generation 不存在为 CAS 前提外，每次受管状态 CAS、写入和 push 都必须验证预期 generation、control epoch 与远端 Head；旧 token 不得执行受管写入、push、转 Ready 或合并。清理不复用写 token，而使用 Integrated 后固化的 terminal claim。
6. 普通在线转交必须先冻结旧持有者，并取得耐久交接快照，证明 tracked 内容 clean、没有未解释的 untracked/ignored、unique 或 unpushed 内容，且精确远端 Head 可由新持有者取回。证据不完整时保持 `HandoffPending + Blocked`，不得移动 generation；旧持有者先提交/推送或显式处理资产，只有负责人批准可能丢失内容的高风险 takeover 才能越过零损失路径。
7. 完成上述证明后才以一次 CAS 原子替换 owner 并增加 generation；不能先释放后竞抢。
8. Issue assignee、label 或项目看板字段可以作为展示镜像；除非它们提供可靠的原子
   条件更新，否则不能充当权威锁。

精确观察到 Integrated 后，协调记录必须以 CAS 把匹配的 generation、integratedSourceHead 与 `controlEpochDigest` 转成无写权限、无 TTL 的 terminal claim，并固化 `closeOwnerGeneration`。该 claim 只保留安全快照、Recovery 和 Closing 的唯一责任，不允许续租、转交、push 或重新开发；即使原写租约已经到期，只要 generation/head/control epoch 未被新一代状态取代，也可以建立该 claim。claim 缺失、冲突或身份漂移时保持 `Integrated + RecoveryRequired`，不得为了清理重开写租约。

租约的具体存储由 Provider 适配器决定。它不应伪装成普通用户功能 Branch，也
不应要求所有平台共享同一种内部实现。

普通 Git push 不携带 fencing token。“检查租约后再 push”与真正的 push 之间仍有
竞态窗口。因此必须区分两种保证：

- **coordinated**：所有受管客户端遵守租约、转交前停写，并在每次 push 前复核；
- **server-enforced**：服务端 hook、GitHub App、权限控制或同一后端原子事务把
  token 校验与 ref 更新绑定，才能宣称硬性阻止旧写者 push。

没有服务端能力时，系统只能声明 coordinated，不能把本地复核宣传成原子强制。
这仍能防止正常 Agent 协作中的绝大多数误并发，但不能消除恶意绕过或极端竞态。

### 9.3 到期、断网和接管

- 到期只撤销写资格，不删除 Branch、Worktree、commit 或未提交内容。
- 到期以权威 Provider 的服务器时间为准；客户端使用安全裕量，只能提前停止，
  不能凭本机时钟把租约延长。
- 远端失联时，现任主写者最多工作到最后确认的租约到期时间；期间不得执行依赖
  新远端确认的交付、合并或清理。
- 未持有已确认租约时，获取、续期、转交和交付一律 fail-closed。
- 原机器恢复时，如果远端还没有新一代租约，可以在安全复核后恢复。
- 在线换机器或换开发者必须走带零损失交接快照的 transfer；旧持有者或远端 Head 无法满足普通转交前提时保持 HandoffPending，不得静默降级。
- 旧机器离线、租约到期且无法取得零损失交接证据时，只能显式执行经人工批准的 takeover/recover，并形成风险回执。
- 旧机器以后重新出现时，只能进入救援审计；遗留提交是否 cherry-pick 由新主写者
  明确决定，不能直接推回主交付 Branch。

租约防止正常协作中的误并发，不承诺阻止拥有仓库凭证的人故意绕过治理。若要
提供硬隔离，必须另有服务器端权限或 hook。

## 10. Branch 与 PR

### 10.1 Branch 生命周期

- 交付 Branch 应从经过远端新鲜度检查的目标基线创建。
- Branch 名应该包含稳定工作项 ID，便于辨认，但名称本身不是删除授权。
- 第一次有效 push 后，建立该工作项唯一的 Draft PR。
- 后续会话继续更新同一个 PR，不重复创建。
- 小任务直到完成才首次 push 时，可以直接创建 Ready PR。
- 普通交付 Branch 在真实合并并安全关闭后立即结束生命周期。
- 默认 Branch、release 和 maintenance 等明确声明的长期 Branch 不适用短生命
  周期清理。
- 仓库级“合并后自动删除 head Branch”只能自动作用于交付 Branch。默认、release、maintenance 等长期 Branch 必须由显式 branch class 和禁止删除的 ruleset/branch protection 保护；不能只靠名称约定避免误删。

### 10.2 开发完成

普通风险任务允许 coding agent 自主声明开发完成，但必须同时满足：

- 验收标准明确，且逐项记录完成证据；
- Branch、Worktree 和写租约映射有效；
- 预期内容已提交并推送；
- 没有未解释的 dirty、untracked 或 ignored 内容；
- 项目声明的本地检查通过；
- PR 没有已知缺陷、冲突或未完成项。

验收标准含糊、存在已知缺口、检查失败或属于高风险变更时，必须保持 Draft 或
Blocked，并请求人工判断。“Agent 声明完成”是状态转换请求，不等于所有业务语义
都已经被形式化证明。

Ready 必须绑定精确 readyHeadSHA、controlEpochDigest 和其他 policy/scope 输入。Ready 或 MergeArmed 之后，任何新 commit、force update、base/head mapping、policy/scope 或 controlEpochDigest 变化，都必须使旧验收证据、检查和 review 全部失效：系统必须撤销 auto-merge，回到 Active/Draft，针对新 Head 与控制纪元重新检查并再次声明 Ready；纪元不兼容时保持 Blocked。

受管客户端在 `MergeArmed` 后若要推送新 commit，必须先保持 `MergeArmed + Disarming + Blocked` 和写冻结，对 exact PR/Head 禁用平台 auto-merge 并 readback；确认已禁用且 Head 仍等于旧 `readyHeadSHA` 后，才以 CAS 退回 Active/Draft、失效旧 Ready 证据并允许 push。禁用结果不确定时继续冻结；若平台已合并则直接观察为 Integrated。不得依赖 GitHub 因新 commit 自动撤防：[GitHub 官方文档](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/automatically-merging-a-pull-request)只明确保证无 write 权限者推送时会禁用 auto-merge，因此所有受管 push 无论 actor 权限都必须显式禁用并 readback。绕过 Harness 的直接 push 仍按治理漂移处理。

### 10.3 合并策略

- 普通短生命周期功能 Branch 默认使用 Squash merge。
- main 以工作项和 PR 为提交单位，开发中的细碎提交仍保留在 PR 记录中。
- 项目可以显式启用 Merge commit。
- Rebase merge 默认关闭，确有需求时再由 profile 开启。
- Squash 场景必须分别保存 integratedSourceHead 和 integratedCommit，不能混称 Accepted Commit，也不能要求二者存在 ancestry。
- 正式无 PR 的共享本机模式必须使用目标-ref 集成锁；该锁存放于 Git common dir，锁定 expected base/source SHA，要求管理 checkout 安全，并以 ref compare-and-swap 产生 exact integratedCommit。锁冲突、目标漂移或 checkout 不安全时保持 `Ready + Blocked`，不得把工作项写租约误当成目标-ref 集成锁。

### 10.4 CI、Review 与 Auto-merge

- 默认 Branch 禁止直接 push；普通功能变更必须经主 PR。
- 仓库应允许 auto-merge，但每个 PR 只有进入 Ready 后才能武装 auto-merge。
- auto-merge 是可选平台能力，不是生命周期必经状态；人工合并或其他 Provider
  可以在满足服务端门禁后从 Ready 直接进入 Integrated。
- Draft PR 即使 CI 通过也不得合并。
- CI 通过不等于一律需要人工验收，也不证明所有业务语义正确。
- 项目声明的本地确定性检查默认是 Ready gate，失败或未运行会阻止 Ready；GitHub required checks 默认是集成 gate，可以在 Ready 后继续运行，但必须由平台阻止实际合并。只有 profile 显式把某个远端 check 分类为 Ready gate 时，它才必须在 Ready 前成功。check identity/trigger 不存在属于门禁配置缺失，不等同于一次正常运行仍在 pending。
- 单人普通项目 required approvals 为 0，避免维护者被自己的规则锁死。
- 团队项目是否需要 review 由项目 profile 和服务端规则决定。
- 高风险区域存在合格维护者时，必须由另一位维护者 review。
- 高风险项目没有第二位维护者时，不配置无法完成的自我审批；负责人必须做显式
  风险确认并留下回执，CI 仍不可跳过。
- CODEOWNERS 只填写真实且能够履责的所有者。
- 只要 required approvals 大于 0，平台规则就必须让批准绑定当前 diff/Head，例如启用 stale approval dismissal 或 latest-reviewable-push approval；不能让旧 Head 的批准放行新代码。
- gate 的可满足性不是一次性事实。成员、权限、workflow/check identity、trigger/filter 或恢复权限变化后必须重新审计；下一次 Provider 事件或受管 audit/drift/merge readback 发现当前 profile 不再可满足时，停止新的武装，并按上述 Disarming 协议安全解除受影响的既有 MergeArmed，不能后台降低保护。没有 webhook/daemon 时不得宣称能在墙钟意义上立即发现漂移。
- 高并发团队可以选择 Merge Queue；它不是普通项目的强制前提。

### 10.5 主线变化和冲突

治理系统可以 fetch 最新远端状态、只读预测冲突，并报告 behind、冲突路径和映射
漂移。它不得在后台自动 merge、rebase、checkout 或猜测冲突解决。

冲突必须由当前租约持有人在交付 Worktree 中显式解决，并重新运行相关检查。
Worktree 只能避免开发阶段因共享目录而相互覆盖，不能消除未来集成时的文本冲突
或语义冲突。

## 11. 合并后关闭与精确清理

### 11.1 关闭前提

只有同时证明以下事实，才可以清理：

- PR-capable Provider 中，主 PR 已实际合并到预期目标 Branch；正式无 PR 共享本机模式中，目标-ref 集成锁、expected base/source SHA、ref CAS 和 exact integratedCommit 证据成立；
- baseRepositoryId、headRepositoryId、完整 head/base ref、integratedSourceHead 与工作项
  精确一致；
- 当前 Worktree 没有未提交内容；
- 没有独有或未推送 commit；
- untracked 和 ignored 内容已经证明可丢弃，否则阻塞；
- Branch、路径、terminal claim 和远端目标自快照后没有漂移。

### 11.2 清理顺序

精确观察到 Integrated 后，只针对精确对象执行：

1. 以 CAS 将匹配的 generation/integratedSourceHead/controlEpochDigest 转为无写权限、无 TTL 的 terminal claim，立即禁止续租、转交和新 push；该转换不要求写租约在此刻仍未到期，但必须证明没有更新的 generation 或 control epoch；
2. 从当前权威主写 Worktree 取得耐久的关闭安全快照，记录身份、Head、dirty、untracked、ignored、unique 和 unpushed 证据；它是事实快照，不另建 Worktree，也不替代零损失检查；
3. 证明 11.1 的全部安全前提后，才以 CAS 把 terminal claim 转为 Closing，建立 Closing journal，并签发绑定 workItem、integratedSourceHead、integratedCommit 和当前模式适用的精确 Worktree/本地 ref/远端 ref 的 cleanup token；
4. 由同一个 cleanup token 授权上述精确对象的清理；ref 删除还必须分别通过后续 old-SHA guard；
5. 用远端 old-SHA guard 删除精确远端功能 ref，或证明平台已经幂等删除；
6. 用旧 SHA compare-and-swap 删除本地功能 ref；
7. 每一步更新同一个 Closing journal；全部完成后以 CAS 将同一权威记录从 Closing 转为 Closed，冻结身份、最终 journal/receipt 和待 reconciliation 义务，并持久保留为 tombstone。

Closing 不是“先释放租约”。写租约在 Integrated 的 terminal claim 转换时已经失去写能力；Closing 只是把该唯一终结责任推进为精确清理授权。任何一步结果不确定时保留 terminal claim 或 Closing 与本地可恢复对象，标记 RecoveryRequired，不允许另一台机器重新获取租约后被旧清理流程误删。

不得使用强制 Branch 删除，也不得把 TTL 当成删除授权。

托管平台可能已经按 Automatically delete head branches 删除远端 Branch。只有
精确 PR/head 映射成立，并确认目标远端 Branch 已不存在时，才可视为幂等成功；
仅仅“找不到 Branch”不足以证明安全。

同仓库交付是自动清理的默认边界。若 PR 的 head 位于 fork，必须把不可变的
headRepositoryId 与完整 ref 纳入身份；没有该 fork 的删除权限或专门适配器时，
只能观察合并，不自动删除 fork ref。外部贡献者 fork 不默认进入受管写租约。

远端 Branch 可以统一关闭，但每台离线机器上的本地 Worktree 和 Branch 只能由
该机器以后自行 reconciliation。“本地和远端都短生命周期”表示远端及时关闭、
各机器最终收敛，不表示中心服务能够删除离线机器上的目录。

远端 Closed/tombstone 只表示旧副本可以开始本机 reconciliation，不是本地删除授权。离线机器恢复后仍必须重新观察 exact identity、dirty、untracked、ignored、unique 和 unpushed 内容；任一证据不安全就保留目录并进入本机 RecoveryRequired，只有零损失前提和本机 SHA guard 都成立时才可精确清理。

当前权威主写机器永久丢失时，系统不能无限自动重试，也不能伪造零损失证明。只有负责人明确声明该机器不可恢复、接受可能存在的未推送/未跟踪内容损失后，才可把该本机义务记为 waived，继续关闭可证明安全的远端对象；回执必须保留被放弃的机器、Worktree、最后观测 Head 和风险。这是人工 recovery，不是正常自动收尾。

### 11.3 放弃未合并工作

PR 关闭但未合并时不得按合并路径清理。Abandon 是独立终结结果，必须满足：

1. 向负责人展示并绑定精确 Work Item、Branch、PR、Head、dirty、ignored、unique、unpushed 和 remote-only 资产清单，取得明确人工批准；
2. 若仍处于 MergeArmed，先按 Disarming 协议确认关闭 auto-merge；若 Provider 已经精确证明合并，立即转 Integrated，禁止 Abandon；
3. 以 CAS 把当前 generation/身份转为 Abandoned；若尚停在 Admitted、从未创建 generation，则以“generation 不存在”为前置条件转换。两者都终止全部受管续租、转交、push、Ready 和 merge；部分失败附加 RecoveryRequired 并从耐久回执继续；
4. 关闭或标记 PR/Work Item 为不再交付，但永久保留原映射和审计身份；
5. 完成平台更新后再次 readback 永久 PR identity；任一时点只要 Provider 精确证明合并，外部事实都覆盖 Abandoned，转为 `Integrated + PolicyViolation` 并建立 terminal claim。已有 generation 时按 exact generation/head/controlEpochDigest CAS；从未有 generation 时以“generation 不存在 + 永久 PR identity + integratedSourceHead + controlEpochDigest”为前置条件建立 claim，绝不重开写租约；
6. 默认保留 Branch、Worktree、commit 和未提交内容。归档或删除任何资产是后续独立高风险动作，不能夹带在 Abandon 中。

同一需求以后重做时建立新的 Work Item 和交付原子，不复活 Abandoned 身份，也不为原工作项自动创建第二个主 PR。

### 11.4 为什么不做全局后台清理器

“扫描所有看起来已合并的 Branch，然后自动删除”风险高，原因包括：

- Squash merge 后不能只靠普通 ancestry 判断源 Branch 是否已被接受；
- release、maintenance、演示或审计 Branch 可能本来就需要长期保留；
- Branch Head 可能在观察后移动或被复用；
- 其他机器可能仍有未推送 commit、dirty Worktree 或离线工作；
- 名称、年龄和“已合并”外观不能证明资产可以丢弃；
- 删除一旦命中错误对象，恢复成本远高于保留一个 ref。

收益却有限：

- Branch ref 本身占用很小；
- 受管交付在正常 Integrated → Closing → Closed 路径已经立即清理；
- 真正占空间的 Worktree 残留可以由只读审计定位；
- 未受管或证据不足的残留，提示人工处理比猜测删除更稳健。

因此应自动化“受管工作项的确定性收尾”，而不是构建“任何已合并 Branch 的全局
清道夫”。

## 12. 生命周期原则

短生命周期适用于：

- 功能、修复等交付 Branch；
- 交付 Worktree；
- detached Review Worktree。

长期存在的是：

- 默认 Branch；
- release、maintenance 等明确声明的长期 Branch；
- 各机器的管理 checkout。

Release 是项目策略例外，不应机械地“每次发布都创建 Worktree”。当项目明确要求
在既有管理 checkout 完成 version、验证、tag、publish 和重试时，必须复用该
checkout；如果它不安全，应 fail-closed，而不是新建 release Worktree 兜底。

TTL 只用于发现残留、提醒和审计，不用于自动删除。正常路径是观察到真实合并后
立即精确收尾，而不是等待若干天后批量清理。

## 13. 仓库侧治理

### 13.1 共享入口

任何使用托管远端的新项目都应该由可配置 profile 建立以下基线：

- 默认 Branch 禁止直接 push；
- 功能变更必须经 PR；
- required CI；
- 禁止默认 Branch force push 和删除；
- required check 名称必须先经过实际观测，不能猜测后写入规则；
- review 数量根据 Solo、Team 和 High-risk profile 变化；
- profile 必须显式区分短生命周期交付 Branch 与长期 Branch；长期 Branch 的删除保护必须在仓库级自动删 head Branch 生效前成立；
- CODEOWNERS 只列真实责任人；
- emergency bypass 必须显式授权并留痕；
- gate 激活前必须证明至少一个不依赖该 gate 的授权恢复主体/路径可用；后续 audit、drift 和合并边界继续复核其可满足性；
- 恢复平面不得反向依赖正在修复的 policy、失败 CI 或不可用 reviewer；最小安全入口只允许诊断以及生成、验证精确恢复计划，任何业务代码修改、push、merge、远端治理写入或保护弱化仍须经过正常授权；
- 会阻断默认 Branch 直推的 Enforcement 激活前，必须先证明当前 profile 的 credential、Work Item、Coordination、Branch push、PR 创建/readback 和独立恢复路径端到端可达；Foundation 可以先准备，任何缺失都保持 EnforcementPending；
- 治理写入统一遵循八阶段流程：observe → semantic plan → deterministic/independent review → [protected actions: one explicit human approval] → preflight → apply → readback → receipt；
- 同一 semantic plan 可以聚合同一合并清单内的多项写入；需要人类 gate 时，只要对象、风险和计划内容未变，就只消费一次明确批准，不按 API 调用重复询问；
- 不覆盖来源不明的既有规则。

### 13.2 GitHub 新仓库默认

任何新项目一旦使用 GitHub repository，默认目标至少包括：

- allow_auto_merge = true；
- delete_branch_on_merge = true；
- 普通功能 PR 默认 Squash merge；
- Actions 使用最小权限；
- 默认 Branch ruleset 保护 PR、required checks、force push 和删除边界。

`delete_branch_on_merge = true` 仍是目标默认值，但 GitHub 的该设置是仓库级的。启用前必须把所有现存 Branch 分类为可删除的交付 Branch，或已受经批准且 readback 成功的禁止删除规则保护的长期/不受管 Branch；存在未知、未分类或保护尚未成立的 Branch 时保持治理未完成状态，不冒险启用自动删除。以后新增长期 Branch 也必须先获得同等保护，才能作为 PR head 使用。[GitHub 官方文档](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-the-automatic-deletion-of-branches)也明确说明 branch protection/rules 可以阻止自动删除。

这些是 profile 默认值，不是写死的唯一配置。高并发团队可以增加 Merge Queue，
高风险项目可以增加 review，旧项目则必须先审计和生成差异计划。

Issue/GitHub Project 的默认所有权应该与 repository 一致：组织仓库优先使用同组织
GitHub Project；个人 GitHub Project 只作为显式兼容例外，不自动迁移旧项目。

## 14. 凭证和权限

Git transport 与平台 API 凭证必须分开：

- clone、fetch、push 使用开发者 SSH key 或系统 Git Credential Manager；
- Issue、PR、GitHub Project 和租约 API 使用最小权限的日常 token；
- ruleset 等仓库管理权限只在 bootstrap 或 drift repair 时临时提供；
- deploy key 只用于 CI 或部署机器，不用于创建 Issue；
- Worktree 共享所属本地仓库的 remote 和 Git transport 凭证。

GitHub 默认采用：

- 每位开发者、每台机器、每个仓库配置一个 fine-grained PAT；
- token 存在 OS keychain，仓库只保存 credential reference；
- 运行时只向需要的子进程短暂注入 GH_TOKEN；
- 不要求每个会话反复运行交互式登录或 auth status；
- 日常 token 默认最长 365 天，组织或平台更短限制优先；
- 在到期前 30、7、1 天本地提醒；
- classic PAT 只在已证明 fine-grained PAT 存在能力缺口时显式启用，最长 90 天，
  不得静默降级；
- 仓库治理 admin token 只用于设置应用和回读，用完从本机移除；
- 丢失机器、疑似泄漏或人员离开时立即撤销对应 token。

日常 Agent 不持有修改 ruleset 的权限，因此不能为了让自己的 PR 通过而降低护栏。

## 15. 典型场景

### 15.1 单人并行开发两个功能

~~~text
Issue #101 → Branch feature/101-export → Worktree 101-export
Issue #102 → Branch feature/102-login  → Worktree 102-login
~~~

同一开发者可以同时持有不同工作项的租约，但每个工作项仍只有一个主写者。两个
功能修改同一文件时，开发阶段不会互相覆盖；未来合并仍可能冲突。

### 15.2 三名开发者、三台机器、三个 Agent

- 张三在机器 A 使用 Codex；
- 李四在机器 B 使用 Claude Code；
- 王五在机器 C 使用其他 coding agent；
- 三人分别 clone 同一个远端仓库并拥有自己的管理 checkout；
- 每个工作项使用独立 Branch、本机交付 Worktree、主 PR 和远端写租约；
- 其他人可以阅读、测试和 review，但不能同时成为同一工作项主写者；
- 需要多人并行写一个大型功能时，父 Issue 只做协调，实际开发拆成可独立合并的
  子 Issue 和各自交付原子。

### 15.3 同一工作串行换会话

新会话打开同一交付 Worktree，且租约、Branch 和工作项映射仍有效时，直接恢复。
这正是“两个会话串行继续同一项工作”的意义：换上下文，不复制交付身份。

### 15.4 同一项目多个 Local 会话

多个 Local 会话如果指向同一个管理 checkout，它们看到的是同一目录和同一个
HEAD。A 会话在右上角切换 Branch，本质上改变了该共享目录，因此 B 会话也会看到
变化。这不是会话同步 Branch，而是两个会话共享了同一 Worktree。

正确做法是：

- 管理 checkout 保持默认 Branch；
- 每项并行写入工作使用独立交付 Worktree；
- 会话绑定 Worktree，而不是把 Branch 当成会话私有状态。

### 15.5 宿主无法自动切换

治理层准备好 Issue、Branch、租约和 Worktree 后返回 PreparedNotOpened。用户
在宿主中打开指定目录或创建原生 Worktree 会话，适配器随后验证并绑定。系统
不得伪称已经改变当前会话 cwd。

## 16. 旧项目接管

旧项目采用四阶段 Bootstrap。它描述接管时的人类运行阶段，不是治理写入事务：
阶段四中的每个治理写入计划仍使用 13.1 节的唯一八阶段流程；成果02的 P0 编号只表示
产品实现依赖顺序，也不是第三套运行状态。

### 阶段一：只读盘点

Bootstrap 处于阶段一时只能输出：

- Branch、Worktree 和 checkout 清单；
- 默认、release、feature、未知和疑似残留分类；
- dirty、detached、重复检出、未推送 commit 和远端漂移证据；
- 建议接管计划和风险。

不得移动、重命名、创建或删除任何对象。

“只能输出”约束的是阶段一，而不是整个 Bootstrap 调用。盘点完成后，阶段二的全部决定汇总成一张清单；负责人明确批准前保持只读，批准并转换到后续阶段后，同一次 Bootstrap 可以在前置条件成立时继续阶段三、四。

### 阶段二：审阅计划

负责人决定：

- 哪些对象长期保留；
- 哪些现有 Branch/Worktree 映射到工作项；
- 哪些继续不受管；
- 是否迁移目录布局；
- 何时进入 `Enforced`。

未知对象默认保留，不按名称或时间猜测可删除性。

仓库级自动删除 head Branch 只有在全部现有 Branch 已被分类为“可删除的交付 Branch”或“已受禁止删除规则保护的长期/不受管 Branch”后才可启用；存在 unknown/unclassified Branch 时保持关闭。以后新增长期 Branch，也必须先建立并 readback 删除保护，再允许它作为 PR head。

### 阶段三：接管

接管只建立治理元数据和租约，不改变既有 Worktree 的 Branch、HEAD、index 或
文件内容。Dirty Worktree 可以为了保护现状而被接管，但不得直接关闭。

### 阶段四：强制治理

只有接管结果经过审阅、当前 profile 的完整 Delivery preflight 可达且治理 Apply/readback 成功，项目才进入 `Enforced`。任一前提缺失都保持 `EnforcementPending`；项目也可以长期保留 `AuditOnly` 或 `Mixed`，不强制一次性治理全部历史资产。

目录迁移、Branch 重命名和清理是三个独立动作，不得捆绑进首次接管。

## 17. 失败边界

| 情形 | 必须行为 |
|---|---|
| 平台或网络不可用 | 新工作 fail-closed；已有租约最多工作到缓存到期 |
| API token 失效 | 阻止 Issue、PR、GitHub Project 和租约 API 写入；不冒充 Git transport 同时失效 |
| Git push 凭证失效 | 保留本地工作，阻止进入 Ready |
| 租约 CAS 冲突 | 停止受管写入，重新读取远端权威状态 |
| control epoch 不匹配 | 保持 Blocked；只允许显式兼容迁移，旧客户端不得继续 CAS |
| 完整 Delivery preflight 尚不可达 | 保持 EnforcementPending，不先激活会阻断默认 Branch 的门禁 |
| 租约过期 | 撤销主写资格，保留全部本地资产 |
| 普通 Transfer 的交接快照不完整 | 保持 HandoffPending + Blocked，不移动 generation；先处理本机资产或走人工批准的高风险 takeover |
| 本机与 Provider 时钟不一致 | 以 Provider 时间和客户端安全裕量为准，不延长租约 |
| Ready 后 PR Head 改变 | 撤销 Ready/auto-merge，回到 Active/Draft 重新验证 |
| MergeArmed 后受管客户端准备 push | 保持写冻结，先禁用 auto-merge 并 readback，再 CAS 退回 Active/Draft，最后才允许 push |
| 主线预测冲突 | 阻止 Ready 或 merge，不自动解决 |
| Local-only 目标-ref 集成锁冲突、目标漂移或管理 checkout 不安全 | 保持 Ready + Blocked，不更新目标 Branch |
| Worktree dirty | 阻止清理 |
| 存在独有或未推送 commit | 阻止清理或跨机器静默接管 |
| PR 证据不可用或含糊 | 不删除 Branch 或 Worktree |
| Integrated 后 terminal claim 缺失或 generation/head/control epoch 冲突 | 保持 Integrated + RecoveryRequired；不重开写租约、不签发 cleanup token |
| 远端删除结果不确定 | 保存恢复回执，进入 RecoveryRequired |
| Closing 中途失败 | 保持 `lifecycleState=Closing` 的权威记录和 Closing journal，禁止新租约并按 journal 恢复 |
| Abandon 的 PR/Work Item 更新中途失败 | 保持 Abandoned + RecoveryRequired 和全部本地资产，按耐久回执幂等继续 |
| 当前权威主写机器永久丢失 | 保持 Integrated + RecoveryRequired；仅在负责人明确接受潜在本机内容损失后记录 waived obligation 并继续远端收尾 |
| PR Head 来自外部 fork | 缺少精确身份或权限时不自动删除 head ref |
| 宿主不能打开新会话 | 返回 PreparedNotOpened，不伪称已切换 |
| 旧机器在接管后恢复 | 只允许救援审计，旧 token 不得继续交付 |
| 旧离线副本在远端 Closed 后恢复且含本机独有内容 | 保留 Worktree/ref 并进入本机 RecoveryRequired；远端 tombstone 不授权删除 |
| 用户绕过治理直接使用 Git | 检测并报告漂移；无服务端机制时不宣称已经阻止 |
| Provider 精确证明绕过治理的 PR 已合并 | 接受 Integrated 外部事实并附加 PolicyViolation；冻结写入，满足完整安全前提后再收尾 |
| 已激活的 reviewer/check/recovery 路径后来不可满足 | 下一次受管观察时停止新的武装，安全解除受影响的 MergeArmed 并报告治理漂移；不得自动削弱规则 |

## 18. 自动化边界

### 18.1 可以确定性自动化

- 盘点 refs、Worktrees 和映射；
- 验证 Branch、路径、HEAD、dirty 和未推送状态；
- 原子获取、续期和转交租约；服务端支持时原子绑定 push fencing；
- 按稳定工作项 ID 派生本机路径；
- 创建或接管交付环境；
- 第一次有效 push 后创建 Draft PR；
- 执行项目声明的检查；
- 预测集成冲突；
- 将证据齐全的普通 PR 转 Ready，并在 Provider 支持时武装 auto-merge；
- 观察真实合并；
- 对精确受管对象做 CAS 清理；
- 生成审计和恢复回执。

### 18.2 必须保留人工或显式决策

- 验收标准含糊时判断是否完成；
- 解决 merge/rebase 冲突；
- 判断独有、未提交或 ignored 内容能否丢弃；
- 放弃未合并工作；
- 跨机器接管可能留有代码的过期租约；
- 扩大权限、降低 ruleset 或使用 emergency bypass；
- 迁移旧项目目录和清理未知历史资产。

### 18.3 没有宿主或服务器支持时无法保证

- 改变当前会话 cwd；
- 自动创建并聚焦另一个宿主会话；
- 发现离线机器上的未推送内容；
- 阻止拥有 Git 凭证的人故意绕过治理；
- 证明所有自然语言验收语义都已满足；
- 立即删除所有机器上的本地 Branch 和 Worktree。

## 19. 项目 Profile

所有受管 GitHub Profile 共享：

- 默认 Branch 禁止直接 push；
- 功能变更必须经 PR；
- required CI；
- 允许 auto-merge；
- 合并后删除短生命周期交付 head Branch；长期 Branch 必须受删除保护；
- 默认 Squash merge；
- 交付 Branch 和 Worktree 短生命周期；
- 本地只做精确、可恢复的收尾。

差异如下：

| Profile | Review 默认值 | 适用场景 |
|---|---:|---|
| Solo | 0 approvals | 单人普通项目，避免自己锁死 |
| Team | 可配置，通常至少 1 | 多维护者项目 |
| High-risk | 合格的另一维护者 review；无人时显式 owner 风险确认 | 权限、安全、支付、迁移等区域 |
| High-throughput | Team 基线，可增加 Merge Queue | 主线变化频繁、并行 PR 多 |
| Legacy compatibility | 不改变现状 | 尚未完成接管的旧项目；Coverage 通常为 `AuditOnly` |
| Non-GitHub | 使用正式配置的等价 Provider | 不依赖 GitHub 的项目 |

Profile 是版本化、可审阅的配置，不应把所有项目写死成同一规则集合。

## 20. 表面矛盾的归一化处理

| 表面矛盾 | 归一化处理 |
|---|---|
| 一个工作项一个 Worktree，但跨机器交接后旧目录仍存在 | 唯一的是有效主写角色；旧目录进入休眠或救援状态 |
| 租约阻止旧机器 push，但 Git 不认识租约 | 这是受管流程约束；硬阻止需要服务端 enforcement |
| 写租约会到期，但安全快照和清理可能耗时 | Integrated 后把精确 generation/head/control epoch 原子转为无写权限、无 TTL 的 terminal claim；证明零损失后才进入 Closing |
| 管理 checkout 应同步，但后台更新会影响会话 | 只在准入和集成边界 fetch/fast-forward |
| GitHub 自动删远端 Branch 与治理层 CAS 删除竞态 | 精确 PR/head 证据成立且远端已不存在时视为幂等成功 |
| Squash 后 PR Head 不等于 main 上的 commit | 分别保存 integratedSourceHead 和 integratedCommit；不要求二者存在 ancestry |
| 本地和远端都要短生命周期，但离线机器无法清理 | 远端及时关闭，本地按每台机器最终收敛 |
| 远端已 Closed，但离线副本可能后来出现本机独有内容 | Closed 只触发本机 reconciliation；每台机器仍重新执行零损失检查和 SHA guard |
| 每个工作项已有写租约，为何 Local-only 还需要目标-ref 集成锁 | 工作项租约隔离各自交付 Branch；目标-ref 集成锁串行化多个工作项对同一目标 Branch 的更新 |
| Agent 可宣布完成，但自然语言验收无法完全证明 | 仅对验收明确、证据齐全的普通风险任务自治 |
| Ready 后又 push 新代码 | readyHeadSHA 变化立即撤销 Ready 和 auto-merge |
| GitHub 全局自动删 head Branch，但 release/maintenance 要长期保留 | 显式分类长期 Branch，并用禁止删除的 ruleset/branch protection 把它们排除在自动删除之外 |
| gate 激活时可满足，但成员或 CI 后来漂移 | 持续复核可满足性；漂移时停止自动合并并走显式恢复，不自动降低保护 |
| 新会话必须意图识别，但老会话不应反复中断 | 首次准入加事件触发复核，不做逐轮分类 |
| 一个功能一个 Issue/Branch/Worktree，但大型功能需多人并行 | 父项协调，开发拆成可独立合并的子工作项 |
| Debug 是否必须建立完整环境 | 纯只读诊断不需要；产生代码改动时进入交付原子 |
| 内部租约若表现为普通 Branch 会增加 UI 噪音 | 存储是 Provider 实现细节，不进入用户功能 Branch 语义 |

## 21. 最终原则

本方案追求的是受管协作中的确定性、可恢复和最小误操作面，不替代 Git 托管平台
的权限系统，也不声称能够控制离线机器或故意绕过治理的开发者。

所有自动删除都必须由精确对象、精确 SHA 和确定性接受证据授权。时间、命名习惯、
“看起来已经合并”或“CI 曾经通过”均不构成删除依据。

对日常工作而言，可以记住四句话：

1. **Branch 隔离提交线。**
2. **Worktree 隔离本地目录。**
3. **写租约隔离当前写入责任。**
4. **PR、CI 和服务端规则决定何时集成，精确合并证据决定何时清理。**

## 22. 与仓库现有文档的关系

本文不替代现有实现文档，也不把目标要求伪装成已实现能力。后续成果02将逐项对照：

- [现行 Worktree Delivery 设计](worktree-delivery.md)
- [现行会话交接设计](../designs/session-handoff.md)
- [GitHub 治理审计参考](../reference/github-governance.md)
- [GitHub Project 工作流](../development/github-project-workflow.md)

成果02可以定义 Harness 特有的实现、存储和 v2 迁移术语；这些术语未进入本文词汇表是有意的层级边界，不表示缺少另一套目标生命周期。实现术语只能映射并收窄本文约束，不能新增状态、扩大权限或降低门禁。

若成果02发现实现与本文目标冲突，应明确标为“已实现但需调整”，而不是修改本文
来迁就当前代码。
