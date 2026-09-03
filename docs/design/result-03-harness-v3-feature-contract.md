# 成果03：Harness Automation v3 正式功能清单

> 状态：`Approved`；作为成果04的正式功能边界输入。
>
> Owner：`zhichao`
>
> 日期：2026-09-03
>
> 跟踪工作项：[GitHub Issue #78](https://github.com/realpkuasule/harness-automation/issues/78)
>
> 上游目标：[成果01](./result-01-branch-worktree-collaboration-target.md)，SHA-256 `83f8bacbfc1472a6e581d23fe1c4c492421f9a9b1da497e85458701b465d27f4`
>
> 现状证据：[成果02](./result-02-harness-v3-scenario-feature-inventory.md)，SHA-256 `1f362297ec7b6be694a90efb63523e0ff137c48f1e6eb95467562327948d0ce2`

## 1. 文档边界

本文件只固定 Harness Automation v3 **应提供什么**：正式能力边界、优先级、
跨能力不变量和必须延后到受保护决策点的事项。

- 成果01是 Provider-neutral 治理术语、生命周期和安全不变量的唯一上游权威；
- 成果02永久保留为 v2.8.11 实现证据、场景解释和差距地图，不因本文件批准而改称正式需求；
- 本文件是获批的 v3 正式功能清单；
- 成果04把本文件逐项展开为可验证的正式需求，不得改变这里的能力边界或降低成果01门禁；
- 实现计划、模块所有权和施工排期不属于成果03或成果04。

若下游发现冲突，必须回到本文件显式修订并重新批准，不能在实现文档中静默覆盖。

## 2. 已批准的一次性语义清单

本次批准整体确认以下语义，不需要重新逐条审批成果02的讨论过程：

1. **产品形态**：保留一个 npm 包、CLI 和进程；内部按窄能力域拆分，不拆微服务。
2. **事实源**：Tracking 只支持 GitHub 默认模式和用户明确选择的 Local-only；不自动切换，不建设 GitLab/Jira 路线图或通用 Provider 插件框架。
3. **交付原子**：一项新代码工作由 Work Item、Delivery Branch、当前模式的写租约和 Delivery Worktree 共同组成；只读 Debug 可例外。
4. **并发边界**：Worktree 提供目录隔离，Branch 提供提交线隔离；租约和 fencing/CAS 只协调经过 Harness 的唯一主写。没有 server-side push/token enforcement 时只能声明 `coordinated`，不能声称阻止绕过 Harness 的直接写入；Worktree 本身也不是锁。
5. **生命周期**：Delivery Branch 与 Delivery Worktree 默认短生命周期；management checkout、默认分支、release/maintenance Branch 是显式长期例外。
6. **GitHub 路径**：新代码工作使用 Issue、Draft PR、exact-Head Ready、平台门禁和精确集成证明；auto-merge 推荐但不是必经状态。
7. **Local-only 路径**：使用 `<git-common-dir>/harness/local-tracking/TASK.json`、同目录 `CHANGELOG.jsonl`、内置版本化 `scripts/task.py`/`scripts/changelog.py`、common-dir work-item lease 和目标-ref 集成锁；不宣称跨 clone 或跨机器协调。
8. **关闭路径**：Integrated 后先建立 terminal claim，再做零损失快照、Closing journal、精确 cleanup token、SHA guard 和 reconciliation；不做全局后台 Branch 清理器。
9. **旧项目接管**：一次 Bootstrap 汇总只读盘点、adopt/migrate 和治理计划；Coverage 与 Enforcement 正交，未满足完整 preflight 时保持 `EnforcementPending`。
10. **Anti-self-lock**：任何门禁启用前必须证明凭证、Work Item、协调、push、PR、review/check 和 recovery path 可满足；损坏门禁不能阻断独立 Recovery plane。
11. **审批边界**：机器 hash 只证明完整性；普通计划可由受限独立 Reviewer Adapter 审查，受保护动作和高风险语义仍由人类批准。
12. **凭证边界**：日常 GitHub、临时 admin 和 reviewer secret 分权并存系统密钥库；仓库、日志、receipt 和 Agent 上下文不得保存明文凭证。
13. **上下文预算**：治理默认静默运行，主会话只接收异常、一次可读审批清单和最终结果；完整证据落盘。
14. **迁移原则**：复用 v2 能力但不改写历史；v3 adopt 后不得继续走绕过远端 Closing 的 compatibility close。
15. **优先级**：P0 先使端到端不变量真实成立；P1 只补宿主体验、CI 基础设施重试和高吞吐 merge queue。
16. **两个延后门**：GitHub 原生 CAS 可行性、Reviewer Adapter 的具体 Provider/model/credential/data scope 在各自实施前单独受保护审批，不在本次整体批准中暗含授权。

## 3. 清单状态

| 标记 | 含义 |
|---|---|
| `P0` | v3 正式成立必须保留或补齐；已有能力也必须通过 v3 验收，不能只因 v2 存在就视为完成 |
| `P1` | P0 闭环稳定后、出现真实使用入口时实现 |
| `Compat` | 只为安全接管历史状态保留；不得成为新项目默认路径 |
| `Out` | v3 明确不实现；若未来出现需求，必须另立需求并重新批准边界 |

当前“已实现/部分实现/待实现”的证据只在成果02维护；本文件不复制会随代码变化的状态。

## 4. 正式功能清单

### 4.1 Core：策略、审查与跨 Agent 连续性

| ID | 优先级 | 正式能力结果 |
|---|---|---|
| C-01 | P0 | 以跨 Agent 可用的 CLI 为基线，Skills 负责路由，MCP 只作可选传输层 |
| C-02 | P0 | 只消费 owner 明确批准的 PRD、设计、调研和版本化来源 |
| C-03a | P0 | 自动发现仓库事实、技术栈、Agent 能力和冲突，不让用户重复填写可恢复事实 |
| C-03b | P0 | 只有存在可达 adapter、失败 fixture、测试和真实 gate 时才能声称 stack/rule `supported` 或 `enforced` |
| C-04 | P0 | 机器计划不可变、完整哈希绑定、原子 Apply；普通计划由独立 Reviewer Adapter 给出受限 verdict，人类审批可读语义而非复制 JSON hash |
| C-05 | P0 | 提供 Check、Drift、Explain、Receipt、last-known-good、safe mode 和不覆盖用户后续修改的 Rollback |
| C-06 | P0 | 新会话、不同 Agent 和不同机器加载同一批准策略语义；宿主能力不足时显式降级 |
| C-07 | P0 | 已应用项目按已批准 profile/stacks/baseline 精确升级，不用新版默认值覆盖 |
| C-08 | Compat | 保留 TypeScript 历史命名债务的精确 adoption，不允许扩大 baseline |
| C-09 | Compat | 保留旧 EDD 快照的诚实 adoption migration，不伪造 pre-implementation 历史 |
| C-10 | P0 | EDD 作为可选 quality profile；非确定性能力必须有 Requirement/suite/rule traceability、真实 baseline、negative control 和 grader 证据 |
| C-11 | P0 | stack、delivery、domain、quality profile 正交，任一 profile 不得静默削弱公共规则 |
| C-12 | Compat | 旧正则 pre-scan 仅作迁移诊断，退出 v3 默认流程并允许后续删除 |
| C-13 | P0 | 新旧项目统一使用一次 Bootstrap：先只读汇总，一次语义批准后原子 Apply/readback；失败不反复索要新批准 |
| C-14 | P0 | 能力域职责必须有界，旧超大 façade 不再增长；迁移期间保持公开行为兼容，具体拆分方式留给后续架构设计 |

### 4.2 Governance、Tracking 与 Provider

| ID | 优先级 | 正式能力结果 |
|---|---|---|
| G-01 | P0 | 对 GitHub repo/organization 治理做完整、分页、失败关闭的只读 Audit |
| G-02 | P0/P1 | P0 只提供 Solo、Team、High-risk GitHub Profile；High-throughput merge queue 属于 P1。Legacy compatibility 归 G-03，Local-only 归 G-06，不承诺第三种 Provider |
| G-03 | P0 + Compat | 旧项目由统一 Bootstrap 执行 AuditOnly → Mixed/Managed 与 EnforcementPending → Enforced 的可审阅接管；Legacy compatibility 只处理尚未 adopt 的旧对象 |
| G-04 | P0 | GitHub 模式使用原生 Issue/GitHub Project 创建、验证和更新 Work Item；平台故障时不切换事实源 |
| G-05 | P0 | GitHub Adapter 统一处理身份、Issue、PR、checks、merge、settings、CAS 与 readback；失败不退回本地事实源 |
| G-06 | P0 | Local-only 由版本化 `scripts/task.py`/`scripts/changelog.py` 操作 `<git-common-dir>/harness/local-tracking/TASK.json` 与同目录 `CHANGELOG.jsonl`；tracking、common-dir work-item lease、目标-ref 集成锁和状态记录在 Git common dir 各有唯一权威副本 |
| G-07 | P0 + 延后门 | GitHub 模式必须先证明可用的远端 CAS/等价原子协调；证明失败时停在 `Admitted + Blocked + CoordinationBackendRequired`，不得偷建第二后端。没有 server-side push/token enforcement 时保证级别只能是 `coordinated` |

### 4.3 Workspace、Branch 与 Worktree

| ID | 优先级 | 正式能力结果 |
|---|---|---|
| W-01 | P0 | 只读观察 checkout、worktree、branch、lease、dirty/unpushed/unique commit、容量和拓扑 |
| W-02 | P0 | 每台机器保留一个 management checkout 与受保护安全根，交付 Worktree 不能占用管理根 |
| W-03 | P0 | 新项目采用 container 布局；仓库共同 Git 数据与各交付目录边界明确 |
| W-04 | P0 | 旧平铺 checkout 只通过精确计划、前置排空、回执和不可伪造迁移事实转换 |
| W-05 | P0 | 一个 Work Item 原子建立 Delivery Branch、模式适用的 lease 和 Delivery Worktree |
| W-06 | P0 | 可接管宿主或用户已创建的 Worktree，但必须先验证身份、Branch、Head、路径和唯一租约 |
| W-07 | P0 | GitHub Rebind/Renew 由当前 generation owner 先做远端 CAS、再更新本机缓存；Local-only 只以 CAS 或等价原子条件更新 common-dir work-item lease。Head 或控制面变化使绑定旧输入的当前态证据不再授权后续转换，历史 receipt/审计证据仍保留 |
| W-08 | P0 | 跨机器 transfer 需要零损失交接快照；证据不足只能 HandoffPending 或走人类批准的 takeover |
| W-09 | P0 | Integration Check 只读证明目标/ref/Head/策略条件，不因观察而改变状态 |
| W-10 | P0 | Review 使用 detached、只读、短生命周期 Worktree，不获得主写租约 |
| W-11 | P0 | Retention Audit 只报告超期或异常对象；不把报告扩大成全局自动删除 |
| W-12 | P0 + 延后门 | 独立 AI Review 必须通过可配置、最小权限 Reviewer Adapter；具体 Provider/model/数据范围需单独批准 |
| W-13 | P0 | 容量预算、受保护路径和拓扑不变量在分配与关闭前确定性验证 |
| W-14 | P0 | 本机 `worktree recover` 只回收 clean、detached、unleased 的残留 Worktree并保留 Branch；Closing journal 恢复归 L-05/L-06，跨机器恢复归 transfer/takeover |

### 4.4 Session 与宿主适配

| ID | 优先级 | 正式能力结果 |
|---|---|---|
| S-01 | P0 | 新会话在写代码前加载有效策略、项目上下文和当前 Delivery 事实 |
| S-02 | P0 | 新会话第一轮必须判断新工作、继续已有工作、只读 Debug 或非代码任务；老会话不重复做全量意图审问 |
| S-03 | P0 | 新代码工作只汇总一次可读确认；确认后原子 Prepare，宿主打不开时返回 `PreparedNotOpened` |
| S-04 | P0 | Session handoff/status/seed 以 Git 产物、receipt 和 Work Item 状态为事实，不以聊天摘要为事实源 |
| S-05 | P1 | 有真实宿主 API 时创建并打开 Host-native Worktree 任务；无能力时给精确人工步骤 |
| S-06 | Out | 不为同目录多个 Local 会话伪造并行写隔离；它们共享同一 checkout 和 Branch |
| S-07 | Out | Session Fork 不自动创建新的交付原子；新工作仍走 Admission/Prepare |

### 4.5 Delivery、PR、CI 与集成

| ID | 优先级 | 正式能力结果 |
|---|---|---|
| D-01 | P0 | 每次受管写入绑定 Work Item、Branch、Head、generation、control epoch、policy/scope 和当前 owner |
| D-02 | P0 | Push 前后都验证授权与远端 Head；失去租约、fencing 或 scope 时失败关闭 |
| D-03 | P0 | 一个交付原子永久只有一个主 PR identity，跨 open/closed/merged 状态不得另建替代主 PR |
| D-04 | P0 | GitHub 首次有效代码 Push 后建立 Draft PR；Local-only 不伪造 PR 状态 |
| D-05 | P0 | 正式命令名固定为 `harness-automation delivery ready`；生成绑定 exact Head 与控制面的 `ready-evidence/1.0` |
| D-06 | P0 | Head、永久 PR identity、base/head mapping、policy/scope、control epoch、验收或 review 输入变化立即使旧 Ready 证据失效 |
| D-07 | P0 | 本地 gate、Ready gate 与 integration gate 分阶段记录；GitHub required checks 可在 Ready 后 pending，但必须阻止实际集成 |
| D-08 | P0 | GitHub auto-merge 是推荐可选路径；武装、撤防和 readback 有序且不可绕过写冻结 |
| D-09 | Compat | v2 checks-green 直接 merge 仅服务未 adopt 对象；v3 对象不得借兼容路径绕过 Ready/Closing |
| D-10 | P1 | 只有存在真实 CI 执行入口和可分类基础设施错误时才自动有限重试 |
| D-11 | Out | 不在后台自动 rebase/merge 主线，不用隐式改写消除开发分歧 |
| D-12 | P0 | 只接受 Provider 精确 merge 事件或 Local-only 目标-ref CAS 证明 Integrated；绕过门禁的真实合并记录 `PolicyViolation`，不能否认事实 |

### 4.6 Closing、清理与 Reconciliation

| ID | 优先级 | 正式能力结果 |
|---|---|---|
| L-01 | P0 | 普通 merge 与 squash merge 分别证明 exact integratedSourceHead/integratedCommit，不用普通 ancestry 猜测 |
| L-02 | P0 | 清理前证明当前权威主写 Worktree 的 tracked 内容 clean，且无 unpushed/unique 内容；untracked/ignored 必须不存在或已有可丢弃证据 |
| L-03 | P0 | 本地/远端 ref 只按 cleanup token 与 expected old SHA CAS 删除 |
| L-04 | P0 | 平台已自动删除远端 Branch 时幂等记录外部事实，不把“不存在”当作本机安全证明 |
| L-05 | P0 | 从 Integrated 先以 CAS 建立无写权限、无 TTL 的 terminal claim；再取得并验证 closing safety snapshot；证明安全后才以 CAS 进入 Closing、建立 journal 并一次签发精确 cleanup token；完成后保留 tombstone/receipt |
| L-06 | P0 | 离线旧副本以 reconciliation obligation 独立收敛；每台恢复机器重新做零损失与 SHA guard |
| L-07 | P0 | Abandon 必须有人类批准的精确资产清单；默认保留 Branch/Worktree 和 tombstone，不授予删除权 |
| L-08 | Out | 不扫描并删除“所有已合并 Branch/Worktree”；只关闭 Harness 可证明拥有的交付原子 |

### 4.7 凭证与权限

| ID | 优先级 | 正式能力结果 |
|---|---|---|
| A-01 | P0 | Git transport、GitHub API、admin 和 reviewer 凭证用途分离，不通过隐式全局登录互相借权 |
| A-02 | P0 | 日常 GitHub 凭证默认使用开发者 × 机器 × 仓库的 fine-grained PAT；classic PAT 仅在证明官方能力缺口后例外 |
| A-03 | P0 | 凭证只存系统密钥库；运行时只注入单个子进程内存/环境，不进入 argv、仓库、日志或模型上下文 |
| A-04 | P0 | 日常 token 与临时 admin token 分权；ruleset/workflow/settings 写入只能使用受保护的临时管理授权 |
| A-05 | P0 | 验证身份、仓库和实际 API 能力，记录非秘密 credentialRef/权限摘要/到期日；401/403 失败关闭，不自动扩大 scope |

## 5. 跨能力硬不变量

以下规则同时约束全部 P0/P1 能力：

1. Git Branch 是提交引用，Worktree 是 checkout 目录，Issue/PR 是平台协作对象；任何实现不得混为同一资源。
2. 一个 Worktree 同时只有一个 HEAD：一个 Branch 或一个 detached commit；一个本地 Branch 同时只在一个 Worktree checkout；一个 Work Item 同时最多一个权威主写者。
3. Worktree/Branch 隔离不保证代码语义无冲突；冲突必须在更新主线、CI、review 或集成时显式发现并处理。
4. `Observed → Admitted → Prepared → Active → Draft? → Ready → MergeArmed? → Integrated → Closing → Closed` 是唯一主生命周期的正常路径；`Admitted`、`Prepared`、`Active`、`Draft` 或 `Ready` 可按 L-07 进入 `Abandoned`，`MergeArmed` 必须先安全撤防，后续 exact merge 覆盖为 `Integrated + PolicyViolation`。两者是同一生命周期的替代边，不是第二状态机。
5. Governance Coverage 与 Enforcement 是正交观察维度；控制面结果和 Delivery 附着标记不得冒充生命周期状态。
6. 已存在 generation 的远端状态转换绑定 generation、Head、`controlEpochDigest` 和 CAS；首次获取，以及从未产生 generation 的 Abandon/外部 Integrated，以“generation 不存在”为 CAS 前提。Lease token 防旧写者，control epoch 防旧控制面计划。
7. `Ready` 只代表绑定输入下开发证据成立，不代表 CI 必然已通过或一定可以合并。
8. Integrated 是外部事实；真实合并即使违规也必须进入 Integrated，并附加 `PolicyViolation`。
9. cleanup token 只在进入 Closing 的 CAS 中签发一次，只授权绑定的精确对象；Closing 恢复复用原 journal/token。
10. tombstone 保存身份与最终事实，不产生删除权限；永久丢失义务只能以人类批准的 waived 证据结束。
11. GitHub 设置、ruleset、branch protection、workflow 创建/修改/删除/启用和任何保护弱化，未经用户明确批准不得写入。
12. GitHub `allow_auto_merge` 与 `delete_branch_on_merge` 是可配置目标；启用全局自动删除前必须分类所有现存 Branch，并为长期/未接管 Branch 建立删除保护且 readback。存在任何未知或未分类 Branch 时保持关闭。
13. Solo Profile 的 PR 和 CI 可以是硬门禁，但 required human approvals 必须为 0；任何门禁不得要求项目没有的合格参与者。
14. Recovery plane 不依赖当前损坏的 policy、CI 或 reviewer；自动修复最多重审一次，随后进入 `NeedsHuman`。
15. quiet control plane 只压缩呈现，不减少事实、回执、失败原因或人类授权。
16. Tracking mode 不自动切换：旧对象必须在完成旧 Provider readback 后进入无 `RecoveryRequired` 的 `Closed`/`Abandoned`；永久不可达只能凭用户批准的 `TrackingMigrationWaiver`，未决 atom 留在旧只读归档且不得改写到新 mode。

## 6. 两个版本化持久合同

### 6.1 Ready evidence

- 生命周期状态名固定为 `Ready`，CLI 入口固定为 `harness-automation delivery ready`；
- schemaVersion 固定为 `ready-evidence/1.0`；
- 至少绑定 `repository`、`workItem`、`branch`、`trackingMode`、当前 `owner`、适用时的 `generation`、`readyHeadSHA`、`controlEpochDigest`、`policyDigest`、`scopeDigest`、验收/gate/review 证据引用、`createdAt` 和 `evidenceHash`；GitHub 模式还必须绑定 `sourceRepositoryId`、永久 `prIdentity`、`baseRepositoryId`/`baseRef` 与 `headRepositoryId`/`headRef` mapping，Local-only 不伪造 Provider identity；
- 任一绑定值变化，旧证据只能保留为历史，不得继续授权 MergeArmed 或集成。

### 6.2 Local-only Closing record

- 权威路径固定为 `<git-common-dir>/harness/worktree-delivery/closing/<sha256(workItem)>.json`，不在各 Worktree 复制；
- schemaVersion 固定为 `local-closing/1.0`，`kind` 固定为 `local-closing-record`；
- 至少保存 `repository`、`workItem`、`branch`、`integratedSourceHead`、`integratedCommit`、`lifecycleState`、`closeOwnerGeneration`、`controlEpochDigest`、结构化 `closingSafetySnapshot`、`cleanupToken`、逐步 `steps`、`reconciliationObligations`、`createdAt`、`updatedAt` 和 `recordHash`；
- `closingSafetySnapshot` 必须 hash 绑定进入 Closing 前的 Worktree 身份、Head，以及 dirty/untracked/ignored/unique/unpushed 证据；它属于同一 common-dir 权威记录，不创建第二事实源；
- `cleanupToken` 是成果01 cleanup token 的持久化表示，不是第二种授权类型或通用 bearer secret；它只包含本轮精确绑定对象和授权摘要，任何 ref 删除仍验证 expected old SHA；
- 每次更新必须对 expected `recordHash` 做可证明线性化的条件更新；冲突失败关闭。原子 rename 只能保证单次写入完整，不能单独充当 CAS；成果04规定可验证的线性化条件、失败语义和并发负面验收，具体锁或事务机制留给后续架构/实现设计；
- `Closing → Closed` 只在全部 required readback 成立后发生；Closed 冻结身份和最终 journal/receipt，后续 reconciliation 只追加关联 receipt，不改写历史最终事实；
- 文件不得包含 GitHub、admin、reviewer 或其他明文凭证。

## 7. Protected 与 Deferred Gates

### DG-01 GitHub 原生协调可行性

P0 实现前必须用真实私有/公开测试仓库证明：选定 GitHub 原生对象能提供所需 CAS、server time、generation/fencing 和 readback。若不能证明，GitHub 新 Delivery 只能停在 `Admitted + Blocked + CoordinationBackendRequired`。建设额外协调后端属于新的架构与运维边界，必须另行批准；本文件不预授权。

### DG-02 Reviewer Adapter 具体配置

Reviewer Adapter 的接口、最小权限和失败关闭语义属于 P0；首次选择或改变 Provider、model、credentialRef、私有内容范围或信任级别时必须由用户明确批准。Reviewer 只能返回绑定机器计划 hash 的 verdict，不能修改 policy、执行 Apply、获得 admin token 或降低风险。

### PG-01 受保护 GitHub 写入

每个项目的 ruleset、branch protection、workflow 和其他 protected action 必须出现在一次可读清单中，由用户明确批准后才能 Apply/readback。普通功能批准、Reviewer verdict 或计划 hash 均不构成该授权。

## 8. P0 依赖顺序

P0 只固定依赖，不在本文件规定模块或文件施工方案：

1. Core 事务、Credential Broker、Reviewer/Anti-self-lock 和可执行 adapter 准入；
2. Tracking 边界、GitHub Adapter、Local-only 单一事实源和旧项目 Bootstrap；
3. DG-01 可行性证明、remote lease/terminal claim、transfer/takeover；
4. Admission/Prepare、Branch/Worktree、Draft PR、Ready、checks/auto-merge 与 Local-only integration lock；
5. 完整 Delivery preflight 成立后才允许启用批准的 GitHub Enforcement；
6. Integrated、Closing、cleanup、tombstone、reconciliation 和 Abandon；
7. 最后把上述纵向能力编排进单入口 Bootstrap 和低上下文控制面。

任何后序能力不得用 mock、人工约定或“以后会补”冒充前序安全前提。

## 9. 明确不做

除各表 `Out` 项外，v3 还明确不做：

- 自动把一个聊天/Session Fork 解释成新的 Issue/Branch/Worktree；
- 为每次只读诊断创建持久 Worktree；
- 把 release/maintenance/默认分支纳入普通短生命周期自动清理；
- 为 npm 发布创建专用 release Worktree；
- 用通用 AI 猜测 Git merge、dirty 内容、权限、租约或删除安全性；
- 让独立 Reviewer 自己 Apply、自授权限或审查自己生成的语义政策；
- 在主开发会话中默认注入完整治理文档、计划 JSON、review 推理或 receipt；
- 未经用户批准自动创建、修改或削弱 GitHub 保护与 workflow。

## 10. 批准记录

当前记录：`Approved`。

- 批准人：`zhichao`
- 批准日期：2026-09-03
- 获批候选 SHA-256：`8fb3c07c36c7c0bd5a6df369717fe953d22c3097e9fa15626b5d35c31d4952be`
- 批准登记后仅调整标题、状态、时态和本批准记录；第 4 节 68 项功能矩阵及第 5～9 节获批语义未改变。

批准动作只确认本文件当前整合语义作为成果03正式功能清单，并不授权：

- 实现代码；
- GitHub protected actions；
- DG-01 的新增协调后端；
- DG-02 的具体 Reviewer Provider/model/credential/data scope；
- Harness policy intake/apply。

任何后续实质语义修改都必须重新批准；成果04只能展开和验证本文件，不能改写能力边界。
