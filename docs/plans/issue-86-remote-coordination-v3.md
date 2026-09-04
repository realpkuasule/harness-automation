# Issue #86：远端协调最小施工与验收计划

状态：实施计划，不是 DG-01 完成证明或生产启用批准。日期：2026-09-04。

交付线：`github:realpkuasule/harness-automation#86`；分支
`codex/issue-86-remote-coordination-v3`；起点
`6059146430fdfe9ab3013841d48e43ac62f5d3eb`。

## 1. 权威与本轮边界

- 语义来自[成果01 §9](../design/result-01-branch-worktree-collaboration-target.md)、
  [成果03 G-07/W-07/W-08、§5/§7](../design/result-03-harness-v3-feature-contract.md)、
  [成果04](../design/result-04-harness-v3-requirements.md)及 GitHub #82/#86；本计划不修改这些来源。
- 原语证据：`/Users/zhichao/.codex/reports/harness-automation/dg01-20260904.md`；
  原始字节位于同名稳定目录的 `rest/`、`git/`。Git exact-old-SHA 两轮竞争及
  staleExpected 拒绝通过；REST 为 **INCONCLUSIVE**，不能改写为通过或 CAS 已证伪。
  HTTP Date 可观测，但不是 Git ref 更新的原子时间戳。
- 当前可继续未启用的真实实现、合成测试及在既有同类授权边界内的隔离验证；
  不必先批准生产部署才编写代码。原语通过不等于完整 DG-01 资格通过。
- 不创建或采用永久生产协调 ref，不改凭据权限、GitHub settings/ruleset/workflow，
  不新增后端、daemon、Provider 框架或依赖。不启用 Reviewer Provider。
- 仅一个源码 writer；规划作者只拥有本文档，不撤销其他人的编辑。
  脏 primary 和其他交付线不动；Wave4 `77799b83…` 保持冻结。按 #82 数字顺序集成。

## 2. 最小职责与复用

| 责任 | 落点与限制 |
|---|---|
| 协调合同、前置条件、状态转换 | 新建窄 `mcp-server/src/coordination/` 域；先落实 schema/用例和配套测试，不向旧大 service 堆职责 |
| GitHub Git CAS 与 readback | 同域具体 Git transport 文件；复用 `repository/git.ts`、`repository/remote.ts`，不再造通用 GitHub Provider |
| 身份与 secret 注入 | 扩展现有 `credentials/service.ts` 的 git-transport 边界；API 与 Git 使用用途分离但相同 actor/repository 绑定的 credentialRef |
| 回执与本地恢复 | 复用 `receipt/service.ts`、`recovery/service.ts`、`v2/fs.ts` 的哈希、耐久写入、锁与 safe-mode 能力；不建第二套审批/回执库 |
| CLI | 新域 handler，`src/cli.ts` 只薄路由和帮助入口；实际调用相同用例，不能交付一个从未被 CLI 调用的库 |

基线 `6059146` 的 `credentials/service.ts` 在生产 `git-transport` 上明确返回
`CREDENTIAL_TRANSPORT_HELPER_REQUIRED`。该缺口必须真实补齐或明确保留 blocked；
不能将内存 test adapter 当 LIVE，也不能绕回 `tracking/service.ts` 的隐式全局 `gh`。
缺少 credentialRef、身份不匹配或实际能力不足时，在 mutation 前失败；不自动 login、
取另一个 token、扩大 scope 或回退 SSH agent。secret 只来自既有 resolver，不能进 argv、
仓库、Git object、receipt、stdout/stderr。新 helper 与 resolver 仍属于现有 broker。

### 2.1 实施决策：真实 CLI 的凭据、人工批准和 merge 观察

依据成果01 §14、成果03/04 A-01..05，不能以“尚无注入对象”为永久 CLI stub。
基线只有 `CredentialResolver` 接口，没有现成的系统密钥库注册表；本轮在既有
credentials/approval/receipt 域补齐下列窄实现，不引入 Provider 平台或第二审批库：

- **受信本机绑定**：从实际 Git common-dir 固定读取新建的
  `harness/credentials/host-binding.json` 非秘密投影；以既有 receipt chain/LKG
  校验其获批配置事件、完整绑定 hash、canonical common-dir、真实 host identity、
  仓库 ID、endpoint、用途、credentialRef、keychain 精确 locator 和到期日。
  若已有 worktree host binding，同时记录其 hash；尚未配置不阻止凭据注册，也不
  因注册获得 worktree 权限。绑定变更须重新批准，不能修改旧 strict schema 或让
  项目 JSON、环境变量、任意配置路径自行提供 resolver/批准。
  本机状态使用安全路径、拒绝 symlink、owner-only 权限；无 receipt 的手写文件不生效。
- **machine 身份**：采用仓库外固定本机用户状态目录中的随机安装 UUID，hostname
  仅作显示标签；repo ID、canonical common-dir/workspace 另行校验，不以同 hostname
  和路径推断同机器。首次凭据注册 plan 在无既有身份时生成候选 UUID，纳入同一个
  显式批准及 apply 原子落盘；已有 ID 则复用，不另起一轮初始化审批。普通读取绝不
  自动生成身份；每次从固定本机位置读取并与新 v3 凭据绑定/回执核对，不采信项目
  JSON 或 CLI 参数自报。ID 丢失/更换须显式恢复绑定，新机器不能复制旧 ID；它不是
  物理机器证明，不宣称抵抗同权限者复制整套状态。旧 worktree binding strict schema
  不变。本轮仅编写实现，不执行本机安装 ID/凭据登记或生产启用。
- **可执行注册与装配**：实现只含非秘密输入的绑定 plan/apply 入口，复用既有
  semantic plan、显式人工批准及 receipt 持久化；注册/变更是人类门，不依赖待注册
  凭据或未启用 Reviewer 来批准自身。CLI 自动装配固定 loader → OS resolver →
  同一 Broker → Git/API adapters；配置齐备时真实可运行，缺哪一项就报哪一项。
  此处只授权编写入口，不执行本项目生产注册、创建 token、扩大权限或启用协调 ref。
- **OS resolver**：首个实用实现采用本机 macOS Keychain 的固定原生命令
  `security find-generic-password`，只接受获批 locator，不接受自定义命令；secret
  输出由 Broker 私有管道捕获，不交给通用命令日志。其他未实现平台明确缺少 adapter，
  不回退明文文件/global gh/SSH agent。Git 走显式绑定的 transport helper；API 使用
  对应用途的显式 `GH_TOKEN` 子进程环境。secret 及其 Base64/Basic 等可逆表示均不能
  放 argv、URL、持久配置或证据；缺失/锁定/拒绝访问是明确凭据门，工具真正不存在才
  属于 ENVIRONMENT_BLOCKED，不靠错误字符串包含 keychain 就统一归类。
- **一个实际能力探测器**：Git/API 复用 Broker 的固定 GitHub 身份/仓库探测，分别
  使用自己的 credentialRef；校验真实响应的 actor、不可变 repo ID、exact endpoint
  和本操作能力。`x-oauth-scopes`、repo.permissions、配置自报 scopes 都不是
  fine-grained PAT 写能力证明；区分人工登记的权限摘要与实际验证的能力。读能力用
  对应真实 endpoint；写能力用同 credential/purpose/repo 的获批隔离写入证据及实际
  mutation/readback，不能额外写生产 ref 来 probe。401/403 阻断，普通生产路径的
  必要能力未知也阻断；首次隔离试写按 §2.2 授权，不能要求先有待证明的写能力。
  不反复 login、不自动提权，也不因 fine-grained PAT 缺 OAuth scope header 永久拒绝。
- **takeover 批准**：命令只接收批准引用，既有 approval 域把 HumanApproval 验为
  同一 semantic packet 的真实人工批准事件，并通过同一 receipt chain/LKG 装载；
  绑定动作、Work Item/repo ID、旧/新 owner+machine、generation/Head/epoch、资产风险、
  完整 plan/input/observed hash、批准主体与有效期。成功事务绑定消费，幂等恢复不再
  批准第二个事务。若需增加人工事件类型，在既有域扩展，不新建 approval 文件库，
  不把远端 takeover 伪装成本地 file/workspace recovery。CLI JSON 自报 approved、
  哈希正确或 reviewer verdict 均不等于人工批准；现有显式人工入口的真实性属于
  受管过程保证，不宣称 hash chain 能抵抗同 UID 恶意重写或提供宿主签名证明。
- **真实 merge observer**：同一 Broker 用 github-api 用途执行固定 `gh api` 只读
  PR/仓库观察，交叉绑定 PR 身份、head repo ID、integratedSourceHead、base repo/ref、
  merged/merged_at 和 merge commit；由实际响应生成带观察 hash 的内部证据，再交给
  terminal-claim。closed 不等于 merged，当前 branch tip 不代替合并时 source Head，
  CLI 不能传入一个布尔值或 JSON 充当 Provider 证明。不可完整证明即保留缺口。

源码验收必须包含正常 CLI 经受信 fixture 组合根成功调用真实 OS resolver/固定
Provider adapter 的证据，以及未注册、错用途、伪造批准、secret canary 的拒绝证据；
单测注入不代替 OS/GitHub LIVE。实际 token 登记/解锁或新增权限是后续明确人工门，
与“代码尚缺 resolver/handler”分别报告；生产采用仍另需 DG-01 资格和启用批准。

### 2.2 固定用途的人工授权回执与写尝试预算

在既有 approval 域增加一个小型 `approval/human.ts`，复用 semantic packet、
receipt/LKG、安全路径和共享 mutation lock，不伪装成 file/workspace recovery。
人工事件使用同一 receipt 服务的独立类型命名空间（如 `approval-human`），不混入
现有最多两次的 Reviewer attempt 目录，也不建立第二套存储/审批引擎。
固定支持以下三种用途，不接受任意 policy/action 或 CLI JSON 自报批准：

| 用途 | 批准绑定与实际准入 |
|---|---|
| `qualification-run` | runId、完整 candidate/script hashes、actor/安装 ID、repo ID、endpoint、credentialRef/purpose 与配置 hash、精确临时 refs/允许操作、执行 TTL、commit/网络写尝试预算及清理边界。验证身份和现有凭据后，允许该 scope 内尚未证明写能力的首次试写；成功 mutation/readback 才形成能力证据，不产生生产启用回执 |
| `production-enable` | 精确配置前后 hash、生产 ref/genesis、actor/repo/endpoint/凭据绑定与完整适用资格证据引用；批准只允许清单中的配置 Apply/明确列出的 bootstrap，不自动扩大权限或写 settings/workflow。Apply 后生成持久的已采用配置回执；运行期仍重验配置、资格及当前租约 |
| `takeover` | 精确 Work Item、旧/新 owner+machine、generation/Head/epoch/recordHash、资产风险和操作/input/observed hashes、事务 ID、有效期与写尝试上限；只允许该次接管，不能借用为一般写许可 |

共用 envelope 绑定 plan/packet/input/context/policy/observed/action digests、用途、
批准主体、批准来源、approvedAt/expiresAt 和 scopeHash。记录入口只消费真实的显式
人工批准，或如实引用其允许的委托范围；不能伪造新的人类签名、把 Reviewer verdict
或临时调用者对象当 authority。CLI 只传 approvalRef/runId，由固定 loader 从回执链
验证事件、绑定和未撤销状态；批准、尝试和结果均只含非秘密字段。

最小接口为 `recordHumanApproval`、`loadHumanAuthorization`、
`reserveCandidateQuota/recordCandidateResult`、`reserveWriteAttempt/recordWriteOutcome`；
由受信组合根的候选构造及 Broker 固定操作入口使用，不让 Store 自行构造授权。
隔离授权与生产已采用配置是两条明确路径，不能设置
`skipQualification` 绕过。资格执行和 takeover 的远端写用可信时间判定 TTL；生产
enable 批准的 TTL 约束首次配置 Apply，不因这张一次性票据后来到期就自动锁死已经
合法采用的配置，运行期资格/凭据/策略失效仍须阻断。

**commit 配额先于对象生成**：每次 `commit-tree`（含 bootstrap/source fixture/
竞争输家）前，在批准绑定的 common-dir 共享锁下耐久预留 candidate slot，绑定
approvalRef、事务和 parent/tree/record/提交元数据的 intent hash；额度不足不执行
生成命令。生成后记录 exact SHA，失败或崩溃不自动返还额度；只读恢复不重新生成。
已经生成并验证的同一对象可直接复用，不再次占 commit 配额，但重新执行生成命令
须预留新 slot，不能等到 beforePush 才按 unique SHA 追认。slot/result 追加到同一
approval-human receipt 链，临时 bare 目录不是配额账本，重建目录不重置额度。

每次网络写请求发出前，在共享锁下耐久预留独立 attemptId，绑定 approvalRef、
事务、操作和 exact ref/expected/candidate SHA；所有实际新尝试（含拒绝、超时）
逐次计数。上传新候选的尝试关联其 candidate slot；exact-SHA 删除不生成 commit，
只扣写尝试/清理预算，不能把 commit slot 当网络尝试额度。
每份授权最多一个未解决的 pending/unknown attempt；未解决时不得再预留候选或
写尝试，超时/TTL 到期不自动清除它。并发不得超支；预留后崩溃且是否发送未知，保守保留
已用额度，同一 attemptId 不能再次 dispatch。unknown outcome 的只读 readback/
回执恢复不重放写、不重复消费这次额度，
也不退款；后来若仍获准发起新写请求，必须预留新 attempt 并计入预算，不能凭同一
transactionId 免费重试。未确认结果不能标记 Applied 或生成成功资格证据。

双客户端竞争可各持一份绑定自身安装 ID、canonical common-dir、credentialBindingHash
和有限预算的授权，共同指向同一获批测试 run/ref 与相同 expected SHA，分别构造并
发送不同候选；每份各一个 pending 不妨碍真实并发 CAS。运行 manifest 固定全部授权
及额度分配，bootstrap/fixture/双方候选和清理一并计入本轮总上限，不把每端各 12
枚解释成原本总计 12 枚。指定唯一清理责任端；它须核验属于同一 run 的已知赢家。
这证明独立客户端竞争，不声称跨机器共享本地计数器；同机不同 clone 也不冒充跨机器。

同一 scope 可预留独立的精确清理额度和有限 cleanupExpiresAt，避免正常试写耗尽
清理预算；它只能清理已证明本次拥有的 synthetic refs，并仍执行 exact-SHA 校验。
存在 §4 未收敛的在途/不确定写入时仍保留资产，清理额度不是绕过恢复门的许可。
TTL/额度耗尽后只允许恢复观察，不追加写或扩大对象；该段仅定义实现，不执行任何
实际批准登记、凭据注册、生产采用或网络操作。

## 3. 权威记录与 exact Git CAS

选用一个**仓库级**内部 ref，具体名字由后续获批配置固定，禁止由请求任意指定。
该 ref 不属于 Delivery Branch，不允许在普通 branch cleanup 中删除。
每个 Work Item 对应树中 `records/<sha256(canonicalWorkItem)>.json` 一条记录；
更新只替换该条记录，保留其他条目及历史。只保存协调元数据，不复制项目代码。
仓库级 ref CAS 会串行化无关工作项；这是本轮可接受的吞吐上限，写明 `ponytail:`
说明，只有真实争用证据才考虑分片，不预建分片框架。
共享 ref 的无关工作项竞争是可重试冲突，不是资产损坏；重试必须重新观察并重新
验证原业务前置条件，不能盲改 expected SHA。内部 ref 的具体命名和分类仅为未来
配置候选，不提供默认生产 ref，也不因模块安装自动启用。

最小记录使用严格版本 `github-coordination/1.0`，未知字段/版本失败关闭：

| 字段 | 约束 |
|---|---|
| `repository`、`repositoryId`、`workItem` | canonical 名称和不可变 Provider ID；跨仓库、大小写/别名归一化后仍须映射一致 |
| `branch`、`sourceRepositoryId` | 交付分支和实际 head 仓库；支持 fork 身份分离，不把内部协调 ref 当交付分支 |
| `owner`、`machine`、`sessionRef` | owner 来自已验证身份，machine 使用 §2.1 受信安装 UUID 而非 hostname；sessionRef 可选、不透明，不授予权限 |
| `generation`、`controlEpochDigest` | generation 为正安全整数；fencing token 绑定该代及身份，不另造不一致计数器；epoch 为当前协议/mode/policy/config 的同一个 digest |
| `createdAt`、`expiresAt`、`lastObservedHead` | Provider 时间语义、exact source SHA；terminal 形态 `expiresAt=null`，不以超远未来冒充无 TTL |
| `lifecycleState` | 仅成果01 §9.1 的可达子集；不能写入 HandoffPending、Blocked、RecoveryRequired 等附着结果 |
| `closeOwnerGeneration` | 仅 terminal claim 建立后出现，固定被终结的写 generation |
| `recordHash`、`transactionId` | canonical 内容哈希和幂等事务身份；哈希不自包含，不含 secret |

仅按实际操作增加结构化、hash 绑定的冻结/交接信息和 Integrated 证据引用；
不要把完整 Delivery/Ready/Closing 合同重新定义一份。不存在记录表示尚未获取，
不能伪造 generation=0。首次外部 Integrated/Abandoned 无历史 generation 的特殊路径
保留其“generation 不存在”条件，不伪造新写租约；相应 Delivery 入口由后续 wave 接入。

每次 mutation 必须执行：

1. 验证获批配置、不可变仓库 ID、唯一实际 endpoint/其 hash、actor、对应用途 credentialRef；
   按 §3.1/§3.2 验证 exact control-ref SHA、完整树及历史，再验证目标记录的
   schema、recordHash、Work Item/source 映射。
2. 首次获取验证该记录不存在；已有记录验证 expected recordHash、generation、owner、
   source Head 和 control epoch，另加该操作的时间/状态/授权前置条件。
3. 构造唯一父节点等于 observed control-ref SHA 的新 commit，原子保留其他工作项；
   候选内容含 transactionId。禁止 blind overwrite、历史回退或应用中删除重建内部 ref。
4. 仅执行 `git push --force-with-lease=<exact-ref>:<exact-old-SHA>` 的精确 refspec；
   首次 ref 初始化使用 expected absent，但只能由获批 bootstrap/隔离资格运行触发。
   REST `force:false` 不能替代此原语。
5. readback exact ref、目标 record、transactionId 和全部身份，才更新本机缓存和成功回执。
   CAS conflict 不自动刷新 expected 并重放旧命令。身份/未知 SHA/返回不确定时停止。

控制 ref CAS 与 Delivery branch push 是两个对象，不是原子事务；最高保证为
`coordinated`。普通 Git push 没有 fencing token；不得声称阻止拥有凭据者绕过 Harness。
受管 append-only 规则不覆盖有权限者在外部回退、删除重建或恢复同一 SHA 的 ABA；
未知/不兼容记录必须失败关闭，但不能声称能检测全部 ABA 或抵抗恶意同权限写者。

### 3.1 无 checkout 的对象存储

控制树仅在隔离 bare object store/index 中处理，不 checkout 到文件系统，不继承
项目 hooks、filters、任意 Git 配置或外部 object alternates。Broker 先认证观察
精确 ref → SHA，再 fetch 该完整 SHA 并验证 commit 类型；期间 ref 漂移不改变本次
expected SHA，读取失败不能偷偷跟随新 tip。所有网络读写仍经过同一 Broker。

完整 `ls-tree` 必须包含 tree 项并采用 NUL 分隔；只允许规定的 `records` 目录和
`records/<hash>.json` 的 `100644` blob，拒绝 symlink/gitlink/可执行文件、未知或
异常路径（包括未知空目录）。逐条 `cat-file` 校验严格记录和文件名映射，明确限制
条目数、单 blob/总字节与命令输出，超限或截断不能继续。只有成功验证的树中缺少
目标路径才是 record absent；命令失败不是 absent，ref absent 另需认证查询证明。
初始空树只允许获批 bootstrap。构造时使用 raw `hash-object` 与隔离的
`read-tree/update-index/write-tree/commit-tree`，再次比较新旧条目，证明只替换
目标 Work Item；不经工作区、过滤器或 shell 执行远端内容。

### 3.2 Genesis 与增量历史验证

获批 bootstrap 使用**无父节点、仅允许元数据的 root commit**；exact genesis
SHA/tree、repo ID、endpoint/ref 和协议版本绑定既有配置批准回执。不能以项目源码
commit 为父节点，也不能把未知链的当前 tip 自动采纳为可信起点；既有链 adoption
须另有明确批准与历史验证。本节是实现约束，不批准任何实际生产 genesis/ref、
配置变更或权限扩展；隔离资格 genesis 只受该次测试 scope 授权。

正常读取从最近可信的已验证 tip 检查到本次 exact remote head：每个新增 commit
只有一个父节点且连续连接，树结构合规，新增/改变的 blob 逐条严格验证；未变的
已验证对象可复用结果。只验证当前树再做 `merge-base --is-ancestor` 不够，必须能
拒绝中间曾混入未知版本、后来又恢复的链。当前完整树仍按 §3.1 验证。

验证检查点复用既有 coordination receipt/LKG，绑定 genesis、repo/endpoint/ref、
tip/tree 和验证语义版本，不另建账本。它不授予 owner/generation/TTL 或写能力；
每次仍读取远端事实，发现回退、断链或无法证明连续性时停止正常写入。历史校验规则
变化须明确重验/迁移，无关源码改动不必使全部历史缓存失效；这与 exact-candidate
资格证据和当前操作的 epoch/授权校验分开。Git 对象缓存同样可重建、非权威。

新机器或检查点丢失时从可信 genesis 完整验证一次，允许按单次时间/对象/字节预算
分段并在同一回执机制保存进度；不设累计历史 commit 数硬上限，不把单批超预算当成
永久不可恢复。未验证完不得 PASS 或授权写入，继续只读验证不依赖有效写租约、
Reviewer 或生产写资格；无变化观察不追加重复证据。此机制不升级前述同权限恶意
改历史/ABA 的保证，也不把本机 hash chain 宣称为同 UID 恶意篡改防护。

## 4. 时间、缓存和恢复

- 时间来自认证后的 GitHub HTTP Date，同时记录本地单调时钟的请求起止及秒级精度。
  Date 与 Git CAS 非原子；不得采用 commit author/committer 时间或客户端墙钟作为权威。
- 有效写资格按“服务端当前时间的保守上界 < expiresAt”判定。上界必须包含 Date
  精度、完整请求往返、样本后的单调时间和明确安全裕量；异常/过旧/倒退样本阻断。
  TTL 从服务端样本计算，不能从本机 now 延长；剩余窗口不足以覆盖本次动作就提前停止。
- Git 操作前后重新验证时间与 exact 状态。超时、休眠/时钟不可证明、跨到期窗口或
  不确定写入均停止授权，不把延迟到达的 renew 当成自动恢复写资格。
  不声称 GitHub 在 Git CAS 瞬间原子执行 TTL 检查；若 LIVE 无法证明保守边界，
  该子项继续 unqualified，不能靠调大 TTL 或弱化断言过关。
- renew 使用 **reservation → 及时性证明 → confirmation**：第一次 exact CAS 只写
  pending renewal，保留旧 `expiresAt`，绑定 transactionId、owner/generation/Head/epoch
  和 `proposedExpiresAt`；拟延长期限不授予写权。随后以 fresh exact-ref/record readback
  证明该 reservation 在旧到期前已可见（保守服务端时间上界严格小于旧 `expiresAt`），
  再对同一 pending 做 exact CAS，将证明绑定入远端权威记录后才确认延长。
  确认可以晚于旧到期，但只是完成已证明及时成立的 reservation；必须拒绝覆盖其后的
  takeover、terminal 或漂移记录，且不能越过新到期时间。无法证明及时性时不确认、
  不恢复同代写权；发送时间、本机时间或本地 post-check 都不能替代这份证明。
  其他进程及重启恢复同样必须忽略未确认的 `proposedExpiresAt`，不能由缓存补出批准。
- 本机只保存 `<git-common-dir>/harness/` 下的缓存/回执。损坏、删除或旧缓存都不能
  赢过远端记录；无网络不能首次获取/renew/transfer/push。已确认持有者仅可沿最后
  可信的单调时钟截止点保留本地写资格；重启后没有该时间证据则阻断，绝不离线延长。
- CAS 前由现有用例层记录同一事务的 transactionId、批准绑定、expected SHA/
  recordHash 和 candidate commit/tree/recordHash。Store 只返回对象/传输证据，
  不另建 journal；started、确认、恢复继续由同一 receipt/LKG 服务持久化。
- 远端 CAS 成功、本地写回前崩溃：先验证 §3.2 的当前历史。exact candidate/record
  匹配时补齐原事务回执；ref 已推进时须证明 candidate 在合法链内且父/tree/record
  精确匹配，不能只凭 transactionId 相同认定成功。后续新代或 terminal 已取代它时
  只恢复历史成功事实，不再增加 generation、不发第二个 token、不恢复旧权限。
- push 超时、信号终止、断连或不可分类结果是 unknown outcome；等待所有子进程结束，
  保留必要候选对象及原回执引用的恢复资产，停止授权且不删除/回退 ref 补偿。
  readback 已推进不等于本次失败，读到旧 SHA 也不能证明超时写绝不会迟到；证据不足
  保持 RecoveryRequired，不刷新 expected 重放业务转换。**回执恢复不等于重新获得
  写资格**；后者重验当前远端状态和时间，过期/所有权不明走显式恢复与新代 fencing。

## 5. 条件转换与交接

| 用例 | 必须满足的条件与结果 |
|---|---|
| acquire | Work Item 存在、目标记录不存在、身份/epoch/source Head 正确；一次 CAS 建立唯一 generation，不由本命令提前声明 Prepared |
| renew | 当前 owner/generation/epoch/Head 与有效时间证据匹配；按 §4 reservation/及时性证明/confirmation 完成远端确认后才更新缓存；generation 不变 |
| rebind | 当前代主写者、目标 session/workspace/source Head 经事实验证；先 CAS 再缓存；generation 不变；变动使旧绑定证据失效 |
| transfer | 源端冻结、发布零损失事实后，目标端 accept-transfer 以一次 exact CAS 同时替换 owner/machine 并 generation+1，保留原 expiresAt；不能先释放再竞抢 |
| takeover/recover | 无法证明普通 transfer 时，只接受绑定当前/新 owner、expected generation/Head/epoch、资产风险和范围的显式人类批准；一次 CAS 新代 fencing，保留旧资产和风险回执 |
| terminal claim | 可信 Provider exact merge 事实绑定 integratedSourceHead/integratedCommit/身份；匹配当前 generation/epoch 时 CAS 到 Integrated 无写权限形态，固定 closeOwnerGeneration、无 TTL |

跨机器交接通过同一远端 record 的窄操作数据完成，不要求源 CLI 访问目标机器目录：

1. 源 owner CAS freeze，绑定 transferId、target owner/machine、source Head、
   generation/epoch；冻结期间普通写、renew、rebind 拒绝。排空受管在途写入后实际
   采集 canonical 源 Worktree、exact HEAD、tracked clean、untracked/ignored 清单
   及处理依据、unique/unpushed 为零和远端 exact Head，再以同代 CAS 附加规范化
   source facts 及其 hash；不能只存一个无法核验的 hash，也不接受 CLI JSON 自报。
2. 目标 host 用自身受信 Broker/安装身份读取并验证 freeze/source facts，在本机
   真实 fetch exact source SHA、核验目标工作区并重验远端 source Head。只有与
   freeze 指定目标匹配的 accept-transfer 可完成交接；它不是提前获得普通 owner 权。
3. 目标端以绑定当前 source-proof recordHash 的最后一次 exact CAS 换代，附 target
   retrieval evidence，拒绝覆盖 takeover、terminal 或任何漂移。新代继承原
   expiresAt，不在 transfer 中发放新 TTL；只有 CAS/readback 后仍可证明未到期才
   获得写资格，后续延长走 §4 的 renew。迟到 CAS 留下过期新代也不恢复写权。

这些 pending 阶段不是 lifecycleState；`HandoffPending` 仍为附着结果。各阶段复用
同一 transferId 和既有 receipt 链，分别绑定 phase/candidate SHA，不另建交接账本。
旧机器离线、证据缺失、到期或路径/Head 漂移时保持阻断，按已有显式 recovery/takeover
门处理；失败不自动解冻，unknown outcome 按 §4 恢复。保留源 Worktree 与原资产；
旧机器回来只能救援审计，不能自动 push/cherry-pick。排空/冻结只保证受管写入协调，
不宣称阻止用户绕过 Harness 修改文件；不增加 SSH、后台或第二后端。

terminal claim 即使原租约过期也可建立，但必须证明没有新 generation/epoch 取代它；
建立失败保持 `Integrated + RecoveryRequired`。它禁止 renew/transfer/new push/重新开发，
只承载后续安全快照及 Closing 责任；本 wave 不签发 cleanup token、不删除交付资产。
该路径不能仅凭 CLI 参数或 ancestry 认定 merge；无可信 merge 证据时阻断。

### 5.1 Drain 的锁边界与后续会话接入

复用 `recovery.acquireMutationLock/releaseMutationLock` 的
`<common-dir>/harness/worktree-delivery/apply.lock`；worktree Apply 已使用同一路径。
`requireMutationAllowed` 的恢复检查不能替代远端 freeze/租约检查。锁仅覆盖参与者，
成功取得锁不等于所有 Agent、编辑器或后台进程都已停止写文件。

#86 提供窄的锁内校验接口（例如 `assertManagedWriteAllowedLocked`），由实际持锁的
受管写入口调用：重验当前远端 owner/安装 ID、Head、generation/epoch、时间和冻结
状态，覆盖从授权到实际写入及子进程结束的整个操作。独立入口可用薄 wrapper 取得
同一把锁；已有 `applyWorkspacePlan` 等锁拥有者只调用锁内版本，禁止外层再加一次
锁。锁忙或遗留锁不算 drained，不自动删除；不为此建立第二锁、在途计数后台或账本。

源端在此锁下重验授权、CAS freeze，再重读 frozen record、核验写入覆盖/停稳证据、
采集 source facts 并发布 source proof，最后释放锁；已分阶段 freeze 的恢复同样先
取得该锁并验证同一 transferId。等待中的已接入写者获锁后必须重验冻结，不能复用
入队前或会话开始时的许可。所有步骤有界；不持本机锁等待目标机器 accept。

已读基线 `6059146` 与冻结 #87 `77799b83` 的边界：worktree Apply 参与共享锁；
#87 Local-only session handoff 参与此锁，GitHub handoff 路径尚未覆盖；session
admission 是 `managed-commands-only` 的准入记录，不是运行中写者登记或 drain
证明。#87 接入时应在真实 mutation 边界调用上述接口，不能因为本地 admission
fingerprint 未变就复用旧 `managedWriteAllowed`；只在 pre-write hook 检查后释放锁、
而实际操作尚未完成，也不能证明 drain。本轮不修改冻结 #87 分支。

source proof 必须绑定 freeze/transferId、common-dir/Work Item、实际覆盖的入口及
观察器版本、快照和可验证的宿主停稳证据；不接受 CLI 自报 `drained=true`。
#86 可独立证明已接入 CLI/受控资格 fixture 的排空，不能据此声称覆盖未接入的 Agent
工具、直接文件修改或 background build。生产源写者覆盖无法证明时，不发布完整
零损失 source proof，保持 `HandoffPending + Blocked` 或走已批准的显式 takeover；
不虚构宿主已暂停。隔离 fixture 的证明不得转为生产覆盖资格，凭据/生产采用门不变。

### 5.2 最小交接字段与调用合同

以下为 §5/§5.1 的接口约束，不新增生命周期、审批系统或后端；类型名可沿用现有
实现。`ctx` 仅由受信组合根装配，含已验证身份、配置、Broker、Store、时钟和观察器；
CLI 只传操作意图、精确预期值、工作区选择和 approvalRef，不接收授权/事实对象。

1. record 只增加窄 `handoff`：`transferId`、`source { owner, machine,
   generation, epoch, head }`、`target { owner, machine }`、可选 `sourceProof`
   与 `targetAcceptance`。source 元组从冻结前的真实记录固定，接收后仍保留以绑定
   原代；无 targetAcceptance 表示冻结，有 sourceProof 仅表示该操作已有源证明，
   均不改变 lifecycleState。targetAcceptance 存在时必须满足目标身份及 generation
   换代合同，不能仅靠添加字段解冻；接受后普通写仍须通过实时租约等全部检查。
2. `sourceProof` 绑定已提交的 `freezeRecordHash`、结构化 source facts、覆盖/
   停稳证据及 canonical hash；不得让 freeze 自引用其尚未产生的 recordHash。
   `targetAcceptance` 绑定 sourceProofHash、实际 retrieval/workspace facts 及其
   hash；facts 包含 source repo ID/ref/exact SHA、观察身份及时间，不保存 secret。
   远端 proof 是受管执行的审计证据，hash 或外部 JSON 本身不是凭据或 drain authority。
3. `assertManagedWriteAllowedLocked(ctx, lock, expected)` 只供已持有原 apply.lock
   的真实写入口调用；未持锁入口通过薄 wrapper 使用同一 acquire/release API。
   lock 是进程内持有句柄，不是可序列化的“已排空”凭证。锁覆盖检查、实际变更及全部
   子进程/写结果收敛；取得锁只证明此前参与该锁的操作结束。未收敛网络写/子进程、
   锁忙或遗留锁均不能据此出具 drain。既有锁拥有者不得嵌套取得同锁。
4. `freezeTransfer(ctx, { workItem, expected, transferId, target })` 在源本机锁内
   重验当前 owner/安装 ID/Head/generation/epoch/TTL，再 exact CAS 固定 handoff；
   expected 同时绑定 control SHA 和 recordHash。冻结禁止普通写、renew、rebind；
   只有绑定此 transferId 的证明/接受或明确授权恢复可以继续，不能借通用写入口绕过。
5. `publishSourceProof(ctx, { workItem, transferId, expectedFrozen })` 取得同锁、
   重读精确 frozen record，再调用固定观察器采集事实，不允许传 facts/drained。
   覆盖证据须来自实际已接入的写入口及可核验的宿主停稳能力，而非配置声明或用户
   JSON。覆盖/在途结果不可证明时保持冻结并返回 `HandoffPending + Blocked`，不写
   sourceProof；#86 的受控 fixture 只能证明 fixture。#87 后续须在真正 mutation
   边界接入此锁及校验；本节不使冻结 #87 或尚未接入的宿主自动获得覆盖。
6. `acceptTransfer(ctx, { workItem, transferId, expectedProof, targetWorkspace })`
   由目标 host 使用自身安装身份/Broker，在目标本机锁内验证指定目标及 source proof，
   真实 fetch 绑定的 source repo/ref/exact SHA，验证本机目标工作区并重读远端 source
   Head。任何源路径仅作审计信息，不访问源机器目录；targetWorkspace 须映射到本机
   已验证绑定。最后 exact CAS 一并写 acceptance、替换 owner/machine、generation+1，
   保留旧 expiresAt；readback/时间检查失败不给 token，不在 transfer 内续租。
7. `takeover(ctx, { workItem, expected, approvalRef })` 从既有 approval-human
   链装载精确批准，重验当前 record/身份/Head/epoch、目标及资产风险绑定后才 CAS
   换代；不能把缺少 source proof 当自动 takeover 条件。源机离线时如实将无法观察
   的资产列为风险，由该批准覆盖，不为取得 takeover 强行要求源机可读。保留旧资产
   和原 handoff 历史，并以同一事务回执记录批准及风险证据；不冒充零损失 transfer。
8. 所有阶段使用同一 transferId 和现有事务/回执，proof 发布及 acceptance 前后均
   重验冻结、Head、generation/epoch 和时间；无关 ref 竞争也须重新观察业务条件。
   unknown outcome 只读恢复原候选及合法历史，不自动解冻、重发或清理；不持源本机
   锁等待目标端。这些接口只定义实现边界，不批准真实跨机交接、凭据登记或生产启用。

### 5.3 同锁组合与非重入持有句柄

为避免 handoff 持 apply.lock 时，Store 的 beforeCommit/beforePush 经 human quota
再次 acquire 而自锁，采用显式锁内调用，不增加锁或全局自动重入：

1. apply.lock 只有一个底层 acquire/assert/release 实现，可放在 recovery 的窄模块
   并由 service 再导出。保留原 common-dir 路径、repository=false 路径和跨进程
   原子 mkdir 排他语义；持锁者再次普通 acquire 仍报 WORKSPACE_LOCKED，不能按
   PID、路径、环境变量或异步上下文自动跳过。review.lock 不属于此组合，不改其用途。
2. `acquireMutationLock(context): MutationLockHandle` 返回运行时 opaque 对象。
   模块私有 WeakMap 保存对象身份、canonical 锁域、PID、随机 owner nonce、目录
   身份和 active 状态；TypeScript brand 本身不算校验。nonce 可放在同一锁目录的
   小型 owner 标记中，仅用于识别这次锁，不是另一份事务账本；历史空锁不得自动认领。
   不提供从路径/JSON/nonce 导入或重建句柄的接口，跨进程复制和伪造对象一律无效。
3. `assertMutationLockHeld(handle, context)` 在每个锁内入口以及异步网络写 dispatch
   前校验私有注册、进程、active 状态、canonical 域、非 symlink 的目录身份与 owner
   标记。错误域、已释放/被替换的锁、丢失标记或旧句柄均失败关闭，不能转为重新 acquire
   后继续旧操作。此为受管进程防误用，不宣称抵抗同权限恶意改目录或内存。
4. human 保留原无句柄入口供独立调用，并将业务体共享给显式
   `reserveCandidateQuotaLocked(handle, ...args)`、`recordCandidateResultLocked`、
   `reserveWriteAttemptLocked`、`recordWriteOutcomeLocked`；必要的授权回执/LKG
   tail repair 同样在此锁域内。独立入口 acquire 后调用同一业务体并 release；Locked
   入口只 assert，不 acquire/release。Store 回调闭包捕获本次句柄，不接受 CLI 提供的
   锁或 `alreadyLocked` 布尔值；锁持有不替代候选/attempt 的耐久预留及授权检查。
5. recovery/v2/credentials 既有同步 acquire→try/finally→release 调用形态不变，
   返回值由字符串改为不透明句柄，必要时只机械调整内部类型。worktree 的 apply.lock
   私有 wrapper 委托同一实现；其 review.lock 继续使用专用 named-lock release。
   不为兼容路径字符串而建立“查到此路径当前有人持锁就借用”的桥接；这不改变 v2 的
   CLI、计划、回执或旧 worktree binding schema。旧版本留下的锁仍按已有恢复门处理。
   migration 的获批 `renameSync(root, newRoot)` 另用窄
   `relocateMutationLock(handle, exactMove): MutationLockHandle` 替代字符串拼路径：
   从旧活句柄保留的身份出发，验证批准计划的精确 from→to 相对映射、移动前后为同一
   common-dir/锁目录身份及 owner nonce、旧路径已消失、无 symlink 或其他借用操作
   在途；不能在 rename 后要求旧路径仍存在。成功返回新句柄并使旧句柄/旧域借用失效，
   全程不释放/重建磁盘锁。common-dir 未随 root 移动则不重定位；copy/delete、身份
   变化或中断不能当 rename，保留现场并沿原 migration 回执恢复。新路径不是持有证明。
6. 异步交接使用 `withMutationLock(context, async (held) => ...)` 或等价的显式
   await try/finally，必须 await 回调及其全部受管子进程/并发 promise 收敛后才释放；
   不能沿用同步 finally 包裹返回 Promise 的写法。内部只借用句柄、不负责释放，也不
   把它缓存到另一项顶层操作。取消/异常沿既有执行器结束本轮子进程；仍有活动写者时
   保留锁并报恢复门，不能靠 finally 宣称已排空。网络结果未知但执行已结束时按 §4
   保留 pending/unknown 和冻结事实；后续操作不能因本机锁已释放而绕过该门。
7. 只有获取者在最外层 release；先停止接受新借用，再验证仍为本次目录/owner，仅
   删除自己的标记并非递归移除锁目录。释放失败、所有权漂移或异常残留保留现场并报告，
   不删除继任者的锁；成功释放后旧句柄永久失效。重复释放同一已关闭句柄至多 no-op，
   不能按其旧路径删除新锁；未知对象直接拒绝。进程崩溃留下锁，不按 PID 死亡或 TTL
   自动抢锁，沿用现有恢复机制；清理错误也不能吞掉原操作失败。
8. 必需负面对照：外层锁内 quota/receipt 成功且仅一次 acquire；普通嵌套 acquire
   拒绝；并行另一进程拒绝；伪造/跨域/跨进程/释放后句柄拒绝；旧句柄不删继任锁；
   await 暂停期间锁不提前释放；异常/取消正确保留未收敛状态；既有 v2/worktree
   同步路径及 review.lock 回归不变；migration 同 inode 重定位后仍排他且可准确释放，
   错误映射/替换目录/旧句柄/迁移中断均不误认或删锁。本节仅收敛实现接口，不执行任何
   锁恢复或生产操作。

### 5.4 原生身份、epoch 与 source 仓库边界

1. 原生 runtime 从已验证的 host binding、实际 Broker 身份/仓库观察及当前批准输入
   装配操作 authority，不从 LifecycleService 参数推导权限。LifecycleService 在
   构造候选前调用共享的操作绑定校验；Store 的候选/dispatch 前置路径复用该校验并
   绑定本次操作，不能因为原始 store 可调用就绕过。缺少原生操作 authority 不放行；
   primitive 注入和纯转换单测不冒充生产身份验证，也不成为 CLI 的 bypass 模式。
2. acquire 的 repository/repositoryId、owner、machine、controlEpochDigest 必须
   匹配真实运行时。renew/rebind 同时校验当前远端记录与 expected 的身份、代际和
   epoch；知道另一写者的 expected 值不构成其授权。source/branch/Head 和 rebind
   目标工作区来自实际本机 Git 及已验证绑定的观察，不能由 CLI JSON 自证；远端 source
   身份/Head 另经 Broker 核验。transfer/takeover 按既定操作区分源与目标权限，不能
   机械要求旧 owner 和新 owner 都等于当前 actor。候选/网络额度预留仍走同一既有链。
3. controlEpochDigest 由唯一、版本化的 canonical descriptor 计算：固定的 epoch
   schema、协调 protocol/mode、实际 policy 文件摘要或显式 `none`、coordination
   配置 digest。policy 有效性/摘要与批准快照一致才可使用；配置 digest 只是其中一个
   输入，禁止将 HumanScopeBinding.configHash 直接当 epoch。descriptor 不包含
   actor、host/安装 ID、common-dir、credentialRef/bindingHash 或一次性运行票 ID，
   保证同一已采用控制语义可跨机器得到同一 epoch；上述身份仍分别严格验证。
4. 隔离 qualification approval 绑定真实观察到的 descriptor/epoch；policy 缺失时
   明确绑定 `none`，不为首次有限试写要求初始化 v2，也不伪造全零策略 hash。policy
   出现、消失或内容变化均须重新观察并匹配批准，不能静默继续。生产 descriptor 从
   已验证 adoption 的配置/策略快照读取并与当前事实重算核对；运行期不临时生成采用
   权限。epoch 改变不以普通 renew/rebind 自动覆盖旧记录，仍遵循已批准的转换/恢复门。
5. 当前 credential host binding 和 Git transport 仅绑定单一仓库。handoff 的
   sourceRepositoryId 与 base/control 仓库不同而无受信 source 路由时，在 freeze
   前返回 `COORDINATION_SOURCE_REPOSITORY_BINDING_REQUIRED`；若已经冻结则保留
   冻结并报告缺口。不能猜测同一 PAT 有权、暗用全局 gh/SSH、借 base endpoint 代替
   source 或临时重写绑定。本轮不因此扩展多仓库凭据注册/权限；base PR API 已有的
   fork head.repo.id 只读 merge 验证保持可用，不等同于 source fetch/交接授权。

本节只收敛已定身份与授权合同，不新增权限系统或执行任何登记/生产启用。必要负面对照
包括原生 acquire 冒用 owner/machine/repo/epoch、拿别人的 expected renew/rebind、
伪造本机 Head、直接 store 绕过、policy/配置漂移、未绑定 fork source 的 freeze 零写入，
并保留合法跨机器同 epoch 与 fork PR 只读 merge 的正向覆盖。

### 5.5 Takeover 的精确批准与新代租约

1. 扩展既有 `kind=takeover` scope，不增加审批域：保留 expected 六元组、
   expectedControlSha、targetOwner/HostId、newEpochDigest、transactionId 和预算；
   增加 `newLease { ttlMs, notAfter }`、`targetWorkspace`、`targetBranch`、
   `targetHead`、`sourceRepositoryId` 及结构化 `assetRisk`。assetRiskHash 必须为
   该规范化结构的摘要，全部字段进入同一 semantic packet/scopeHash；不能只批准一个
   无法查看内容的风险 hash。CLI 执行只消费 approvalRef，不接收可替换上述字段的 JSON。
2. ttlMs 是批准的有限时长，notAfter 是该新租约的绝对最晚期限，均经 schema/协议
   边界校验。构造候选时以一次可信服务端时间样本固定 createdAt，并按批准公式
   `newExpiresAt = min(sample.lowerMs + ttlMs, notAfter)` 计算期限；安全上界已不小于
   新期限则拒绝。写前仍检查批准有效期，CAS/readback 后重新检查新租约有效性；不从
   确认时间重新起算 TTL。批准票有效期与新租约期限是不同约束，票据过期不自动撤销
   已合法建立的新代，但也不允许新写尝试。unknown 恢复复用原候选及固定期限，不借
   resume 延长；获准的新尝试仍逐次计数，不能越过 notAfter。Git CAS 不被描述为
   服务端原子检查批准 TTL，迟到结果也不能突破这份固定租约的时间上限。
3. `assetRisk` 由固定本机观察器生成：包含实际目标安装/common-dir/workspace、
   branch/HEAD、tracked 变更、untracked/ignored 与处理依据、unique/unpushed 事实，
   以及 Broker 观察的 source repo/ref/endpoint/exact remote Head。源端另列明确的
   `observed`、`not-observed` 或 `unavailable` 及证据/原因；历史 source proof 必须
   标作历史，不当作当前观察。未访问或访问失败不能推断源机 offline、clean、无在途
   写入或无待救援资产。结构显式列出未知源资产、外部写者不可 fencing、保留旧资产
   和非零损失交接等适用风险，由同一人工批准覆盖；源不可读既不自动放行，也不强制
   源机上线。清单/观察失败或截断如实失败，不归零；不上传文件内容或秘密作为风险证据。
4. 计划绑定实际 canonical targetWorkspace（其 common-dir 必须匹配 binding）、
   targetBranch/targetHead 和 sourceRepositoryId。本轮只接管原 Work Item 的原
   source 仓库/branch，不顺带重命名、换仓库或覆盖文件；targetHead 可与旧记录 Head
   不同，但差异及其与实际远端 Head 的关系必须在批准风险中明确可见。执行在目标
   apply.lock 内重采事实，比较批准的语义事实指纹；新观察时间等审计字段另记回执，
   不因时间戳自然变化自锁，也不忽略内容/身份/Head 变化。目标必须实际处于获批
   branch/Head；不得为吻合计划自动 checkout/reset/clean。缺失 source 凭据路由仍
   按 §5.4 阻断，不以人类接受未知源资产来绕过目标/Provider 身份验证。
5. takeover 是显式新代 fencing，不要求旧租约仍有效、旧 owner 等于当前 actor、
   或完整零损失 source proof；但必须精确匹配当前 control SHA、recordHash、旧
   owner/machine/generation/Head/epoch 和批准风险，且不能重开 terminal 记录。
   候选保留原 Work Item/source 映射，owner/machine 改为获批目标、generation+1，
   采用新 Head/epoch/租约；移除属于旧代的 handoff、renewal/renewalConfirmation。
   不为保留 handoff 而放宽其 generation/epoch 一致性校验：完整旧记录留在 exact
   parent 的已验证 Git 历史，原事务回执绑定 previousControlSha/recordHash、批准
   和风险。源 Worktree/分支/文件不删除，不增加不断增长的资产数组或第二账本。
6. 旧 epoch 只与 scope.expected.controlEpochDigest 及实际旧记录匹配；目标
   `newEpochDigest` 必须等于当前已验证 `binding.controlEpoch` 的独立 digest，
   新记录也必须相等。不能把旧 epoch 必须等于新 epoch 写成接管前提，也不能允许
   调用者任意选新 epoch；生产目标 descriptor 仍来自已批准 adoption，不从 takeover
   顺便采用新生产策略。共享原生操作校验按 takeover 区分旧身份与获批目标身份。
7. 隔离资格 fixture 可以使用同一审批域的受限 takeover 票，显式关联已有获批
   qualification run/清单、精确临时 control ref/genesis 和独立预算分额；其 binding
   使用 isolated-qualification epoch，范围/时间/额度不得扩大父运行清单。不能仅以
   `kind!=qualification-run` 就强制 production epoch，亦不能以一个 test flag 放行。
   此路径运行同一 Broker/Store/接管用例，不要求 production adoption；生产接管则
   同时要求既有有效 adoption 与专用 takeover 批准。资格结果不是生产采用回执，
   takeover 子票的候选/尝试须纳入既定运行总上限，不能成为额外隐形预算。
8. 复用 approval-human 的 candidate 预留、attempt 和回执恢复，且只允许一个未
   解决尝试；candidate 在 commit 生成前、attempt 在实际 dispatch 前耐久记录。
   CAS 冲突不自动改 expectedControlSha 后重试，远端成功/本机中断按同一 transactionId
   只读恢复，已成功接管不得再消费该票再次换代。验收至少覆盖：TTL/Head/risk/epoch
   篡改拒绝；源 not-observed 经精确批准可行但不声称 offline；旧 handoff 保留历史且
   新代可解析；terminal 拒绝；未知结果不重发/不续期；隔离票不获得生产权限。

**takeover 的 lifecycleState 不作无依据的统一重置。** 依据成果01 §7 的进入/保持
条件，旧 Admitted 保留 Admitted；Prepared/Active/Draft 仅在新目标分别重新证明
交付原子映射、当前写者环境/租约复核、唯一真实 Draft PR 及其 mapping 时保留原态。
缺少相应能力或事实则不执行 takeover、保持 Blocked，不猜测降回 Admitted，也不
因新租约已生成就自动宣称宿主切换或 PR 状态成立。依据成果03 §6.1、成果04 §5.1，
owner/generation 本身属于 Ready 绑定，因此每次 takeover 都使旧 Ready 证据失效，
即使 targetHead 不变；旧 Ready 在目标环境/新租约复核成立后，以同次接管 CAS 退回
**Active**（采用成果01 §10.2 明确允许的 Active/Draft 中较小的 Active 路径），不
额外转换/新建 Draft PR，不重用旧验收、review 或布防资格；再次 Ready 走 D-05。
旧 MergeArmed 必须先走成果04 D-06/D-08 的 exact PR/旧 Ready Head 撤防、readback
及 CAS，期间保持 `MergeArmed + Disarming + Blocked` 和写冻结；未接入该能力则
阻断，不先换代再撤防。撤防收敛后才基于新的精确记录生成/消费 takeover 批准，旧
expected 票不可自动刷新。Provider 已证明合并则进入 Integrated，不再接管；
Integrated/Closing/Closed/Abandoned 一律不重开写租约。成功换代仍按上文删除新
记录中的旧 handoff/renewal，完整历史保留，不放宽旧字段的 generation 一致性。

本节只定义实现和测试合同，不登记真实批准、修改凭据、接管现有工作或启用生产。

#### 5.5.1 隔离 takeover 的静态分额

1. qualification-run scope 可选 `takeoverAllocations`，每项固定唯一 allocationId、
   workItem、controlRef/sourceRef、exact genesisSha 及 maxCommits/maxWriteAttempts。
   refs 必须属于父票，workItem/source 映射须匹配同一获批仓库；子操作仅为 takeover
   的 control-ref CAS，sourceRef 是观察绑定，不额外授予 source 写入。genesis 使用
   已批准的精确锚点，初次运行可按 §6.1 预计算，不为取得该字段提前生成 commit。
2. 父票 maxCommits/maxWriteAttempts 定义为该票连同全部分额的总上限；普通操作
   可用额永久等于总额减去所有 allocation 上限之和，批准时即检查非负与安全整数。
   bootstrap/source fixtures 消耗普通额度，必须预留充足；未登记、未使用、失败或
   撤销的分额均不返还，也不转给别的 child。无 allocations 时原语义不变。子票明确
   maxCommits 与 maxWriteAttempts 两个独立上限，不再用写尝试数替代 commit 数；
   每项可小于分额但不可大于，差额仍不回流。cleanup 预算只留在父票原有单独字段。
3. 子 takeover scope 固定引用 parentApprovalRef/runId/allocationId，且具有自己
   独立的显式人类批准及 §5.5 全部精确字段；父票预留不等于批准任意接管。父子必须
   匹配同一真实 binding/canonical common-dir、隔离 epoch、ref/genesis/workItem
   与 source branch；子票 expiresAt 不晚于父票普通写有效期，新租约 notAfter 不晚于
   父运行 cleanupExpiresAt。禁止转委托或再分额，不借子票切换机器、凭据或实现。
4. 子票首次登记在同一 apply.lock 下：验证父票/分额与子票批准，扫描既有
   approval-human receipt/LKG 中对该 parentApprovalRef/allocationId 的占用，再
   追加这一张 child 的原生批准事件。该事件本身就是分额占用证据，不另给父链追加
   第二份必须原子提交的占用事件。相同 child approvalRef/完整 scope 的恢复可幂等；
   另一张票即使上一张已撤销、过期或未用也拒绝。占用扫描必须包括已耐久写入但 LKG
   tail 尚未补齐的批准事件，不能只查成功索引；扫描/链验证不完整不能认定未占用，
   应恢复原链。复用现有存储安全检查，不新建索引账本或以累计历史条数上限永久拒绝。
5. 父/子历史的纯加载与“现在可否执行新动作”分开。子票登记、候选预留及每次实际
   dispatch 都重验父子未撤销、当前有效期、binding 和分额关系；父撤销或普通写过期
   即阻止新的子动作。不能只在 child 登记时检查父票，或因父票后来撤销/过期而把
   已有历史判成非法。已经发生的 candidate/outcome 事实仍可写回原回执，unknown
   可只读恢复；这些不补发许可、不退款、不重放网络写。缺失或损坏的父历史仍是恢复
   缺口，不能通过忽略父关系授权。受限历史修复不绕过正常锁及证据校验。
6. 同一分额只能消费到唯一 child 的候选/attempt 链，沿用一项未解决尝试限制。
   cleanup 由父运行原定责任端在原 cleanup 时间/额度内执行，须核验 child 在内的
   已知赢家及同 ref 的未收敛写入，不能只查父票自己的最后一次成功；有未知在途结果
   则保留资产。父撤销阻止新的网络清理，不能将 cleanup 当作撤销后的隐含豁免；父普通
   写窗口到期后，仅其原已批准、尚有效的独立 cleanup 窗口允许精确清理。
7. 本层仅证明同一 common-dir 内的有限静态分配，不声称跨机器共享计数器。完整
   资格 manifest 后续固定各端父票/全部分额和清理责任，总量逐项相加；不同主机不能
   各复制同一总预算后声称仍共享该上限。本次实现不需要跨机预算服务或新后台。
8. 验收覆盖：父普通额扣除全部预留；失败/撤销不返还；超额与错 binding/ref/genesis
   拒绝；两个进程登记同一 allocation 仅一个成功；批准事件已落盘而 LKG 未完成时
   不产生第二 child；父到期/撤销后新候选/dispatch 拒绝而历史及 unknown 恢复可读；
   child 结果可被唯一清理者核验且未知结果禁止删除。这里仅补实施约束，不登记任何票。

## 6. 可调用入口及资格门

提供 `harness-automation coordination status`，以及对应 acquire、renew、rebind、
transfer、takeover、terminal-claim 的命令路由；复用同一生产用例，不另写 CLI 状态机。
参数不允许任意命令、任意 endpoint、替代 credential 或任意设定 lifecycleState。

- 无协调配置：status 只读报告 `configured=false`、`coordinated=false`；mutation
  返回 `CoordinationBackendRequired`，零远端写入、零 token。GitHub 新交付仍为
  `Admitted + Blocked`，不回退 Local-only，也不自行创建内部 ref。
- 有配置但缺 Broker/完整资格/生产启用授权：准确报告各缺口，不能把原语 PASS
  或一个 `enabled=true` 当生产资格。旧证据 hash/实现版本/仓库/身份/配置漂移即失效。
- 隔离资格测试调用**同一实际 handler/adapter**，使用 scope 绑定的短期授权和
  合成资产；按 §2.2 允许首次资格试写而不预要求 write PASS，不会生成生产启用回执。
  测试 seam 不能经普通 CLI flag 或环境变量绕过门。
- 合成测试可在隔离 fixture 中装配具体 transport；生产组合根只能装配 Broker 验证
  的真实 transport。LIVE 所需权限/凭据若尚缺，记录明确缺口，不能把 mock 结果顶替。
- G-07/W-07/W-08 全部适用证据通过后仍须单独批准永久 ref 的生产采用/配置；
  该审批不阻止本节命令及未启用实现开发。退出码遵循仓库 0/1/3 规则，授权/策略门
  不是 ENVIRONMENT_BLOCKED；status 能成功报告 blocked 不等于 mutation 成功。

### 6.1 组合层最小落地顺序

1. **先固定实际 Harness 实现指纹**。开发资格可要求真实、干净的 Harness 源码
   checkout 并记录 head/tree；发布包使用构建时生成的运行文件 manifest，在运行时
   重算实际文件内容 hash，连同包身份、依赖身份形成 artifactDigest。缺失/额外运行
   文件或依赖漂移不得自动接受。使用 source/package 判别形态，Git provenance 在
   package 中可选；不能拿目标项目 HEAD、版本号或未复核的 manifest 自报值代替。
   资格绑定实际执行 artifactDigest；装包无需 clone Harness，字节变化也不自动继承。
2. **配置数据与授权分离**。CoordinationConfig 补齐 genesis SHA/tree 等实例数据，
   `enabled` 仅表示声明，qualification hash 仅作证据索引；组合根分别从既有回执
   装配“有限资格运行”或“持续采用配置”，不能共用一个绕过 flag 或永久 stub。
   所有配置/资格/批准摘要保持单向引用，不把自身 receipt hash 放入自身被哈希输入。
3. **genesis 只预计算，批准后才物化**。计划冻结 object format、空/允许元数据树、
   无 parent 的完整 commit 字节、固定作者/时间/消息；纯哈希或不带 `-w` 的
   `hash-object -t commit --stdin` 算出 exact SHA，不执行 `commit-tree` 或创建
   commit 对象。批准 Apply 后先按 §2.2 预留 slot，再物化并核对 exact SHA；
   不从执行时环境重新取作者/时间。这消除“先造 commit 才能精确批准”的循环。
4. **一次有限资格清单分配全部客户端额度**。同一 run manifest 固定参与端的
   安装 ID/common-dir/credentialBindingHash、runtime/script hashes、临时 control/
   source refs、TTL、额度及唯一清理责任端；各端在同一 approval-human 机制记录
   自己的有限子范围，总和含 bootstrap/source fixture，不依赖跨机共享计数器。
   source bootstrap 复用同一候选 slot、Broker 和写 attempt，只接受获批合成对象，
   不从项目源码历史派生，也不是一个任意 branch 写入入口。
5. **有限票直接装配真实资格运行**。验证人类票、凭据身份及当前 scope 后，装配
   同一 Broker/Store/Clock/handler；不要求生产已启用或先有待证明的 write PASS。
   候选与网络尝试分别扣额度，每票仅一个未解决 attempt；未知结果只读恢复，
   新写重试仍计数。测试 adapter/用户 JSON 不参与生产 authority 的构造。
6. **收敛资格与跨端清理证据**。汇总同一 run 的实际结果和双方候选/attempt 回执，
   指定清理端须能验证另一端的已知赢家，不能只认自身最后一次 applied SHA。
   资格保留精确测试实例 configHash；生产采用只可明确批准 control ref/genesis 等
   合成实例到生产实例的有限映射，实际实现、协议安全参数、repo/endpoint/身份/凭据
   的匹配仍须逐项验证。不是任意 config 漂移豁免，更不能将 primitive PASS 当完整资格。
7. **再执行获批生产 adoption**。计划绑定生产配置前后 hash、预计算 genesis、
   完整适用资格及上述实例映射；以 production-enable 票据执行清单内 bootstrap，
   预留配额、exact-absent CAS/readback 后才记录配置采用成功。远端成功而本机落盘
   失败按原事务恢复，不删除生产 ref 补偿；不以先写 `enabled=true` 冒充采用完成。
8. **持续运行消费已采用配置**。普通 CLI 每次核对 applied adoption receipt、配置
   与当前实现/资格/凭据，再重验实时租约、冻结和操作条件，调用实际 handler；
   不继续消费过期的资格运行票或把一次 enable Apply 票当永久写 token。takeover
   仍消费其专用人工批准。此顺序仅约束实现，不执行任何真实登记、授权或生产启用。

#### 6.1.1 Genesis/bootstrap 的最小接口

1. 正式 control genesis 固定为**空树、无父节点的 metadata-only root commit**，
   不包含业务 record；元数据只在固定 commit headers/message 中。提供纯
   `prepareGenesisObject(fixedMetadata): SyntheticObjectPlan`，冻结 objectFormat、
   空树原始字节/tree SHA、完整 commit 字节及其 SHA-256/exact Git SHA、固定作者/
   committer/时间/消息和 objectPlanHash。采用固定编码及 metadata 白名单，拒绝额外
   headers、签名或任意 payload；消息可绑定预先确定的 runId/objectId，但不能引用
   含自身 SHA 的最终 manifest/approval hash 形成循环。计划期只计算，不写 commit
   对象；Git 命令不带 `-w`。执行时不重新取墙钟、作者或换行格式。
2. qualification-run 的清单/scope 以及 production-enable 的批准内容必须保存或
   哈希绑定上述完整可重建 descriptor，关联 exact repo/endpoint/controlRef 与
   transactionId；只给 genesisSha/tree 而无可核验字节/metadata 不足以 bootstrap。
   合成源对象同样列入清单。普通父票额度承担 genesis/source fixture，各生成一次
   commit 对象占一个 candidate slot，首条业务记录另占一个，不能借 bootstrap 名义
   免计，也不动已预留给 takeover child 的额度；生产 bootstrap 消费其唯一获批
   genesis candidate 和有限网络尝试。配额不足必须发生在 commit 对象物化之前。
3. 在现有 GitCoordinationStore 增加窄 `bootstrap(approvedGenesis)` 用例，参数只
   由既有批准 loader 解析，仍用同一 bare 对象帮助函数、Broker/transport、candidate/
   attempt 回执和 exact-absent push。流程为验证批准与真实身份/不存在事实 → 耐久
   预留 candidate → 物化固定树/commit → 重算并核验字节/SHA → 预留 attempt → push
   → readback/历史验证；不制造空 Work Item、generation=0 或虚假 recordHash。
   原生普通 compareAndSwap/acquire 不再以 `initialize=true` 绕过此流程；ref 缺失
   即报告 bootstrap required，不代建 root。首次业务提交只有一个父节点，即 genesis；
   后续均按现有 exact tip CAS 追加，不能把业务 record 作为另一个无父 genesis。
4. Store.entries 只在受信 anchor 的 exact genesis SHA/tree、无父节点及完整对象
   验证全部成立时接受零条目；任意其他 commit 的空树、未知路径/模式仍拒绝。读取
   genesis 返回 `{controlSha: genesisSha, record: null}`，不是 ref absent。
   history anchor 补齐 genesisTree/objectPlanHash（以及既有 repo/endpoint/ref 绑定），
   从已批准 descriptor 取得，而非从“bootstrap 已标 applied”的回执反推，否则首次
   readback 会自锁。冷验证核验 exact genesis，之后沿现有单父增量验证；检查点不得
   把空树例外扩散到非 genesis。无批准 anchor 仍失败，不凭项目 JSON 或当前 tip 认领。
5. 同一 commit intent/candidate/receipt 用严格 subject 判别
   `coordination-record | control-genesis | source-fixture`：record 分支保持其
   Work Item/recordHash；另两类绑定 objectPlanHash/fixtureId，不伪造 record 或把
   任意 hash 填进 recordHash。沿用既有 reserveCandidate/result、reserveAttempt/
   outcome 与同锁 Locked 入口，所有 subject 的授权规则穷尽匹配，未知 kind 拒绝。
   bootstrap readback 可证明 exact genesis 当前存在或处于当前完整合法历史中，
   但不签发写租约，也不把竞争输家的拒绝改写为本次创建成功。远端已存在且无本次
   在途记录时不盲推/自动 adoption；unknown 只恢复原候选/事务，不重造对象或退回 ref。
   **Git 的 up-to-date 不是本次 CAS 成功。** 完整、无超时/信号/执行错误的 porcelain
   结果中，唯一获批 exact ref 为 `=`/`[up to date]` 时，即使 exit 0，本次 attempt
   也记 `rejected`，原因区分为 `CAS_NOT_PERFORMED`，不冒充服务端 stale rejection。
   已预留的尝试不退款；超时、输出截断或无法完整分类才保持 unknown。exit 0 加上
   readback 同 SHA 不能取代实际 ref-update 结果；成功分类还须匹配本次已记录的精确
   ref/expected/candidate 意图和正向更新结果，再完成原有对象/历史 readback。
   将明确 no-op/拒绝事实尽早记入同一 attempt 回执，恢复首先读取该事实：已经
   rejected 的尝试绝不因当前 SHA 相同或处于合法祖先中而升级为 Applied。底层对象
   恢复只证明“状态已观察到”，不自行决定哪次 attempt 更新了 ref。对确实 unknown
   且同一 SHA 可由多个 publisher 发布的情形，SHA/ancestry 本身不能归因；无绑定
   本次尝试的可靠更新证据时保留 unknown 与观察结果，不计 CAS winner、不用它
   自动取得本次创建/清理归属。已有正向更新结果可与只读 readback 合并补齐原事务，
   无需重发。负面对照必须让同 SHA 竞争的一方得到 `=`，证明它不被计作第二个赢家，
   其 rejected 结果跨进程恢复后仍不变；不另建 push 账本或降低未知结果恢复门。
6. source fixture 使用一个窄 `runApprovedSourceFixture(fixtureId)` 入口，复用同一
   私有对象物化/精确 push 帮助函数及预算 guard，不另建 Store/账本，也不放宽 control
   的 entries/history。固定 descriptor 只允许空树合成 commit；父节点只能为空或
   清单内已批准的 source-fixture SHA，完整可达图不能含项目源码或 control 历史。
   它只能写清单中独立的临时 sourceRef、expected/candidate SHA 和有限操作；调用者
   不能传任意 ref/父节点/字节/命令，生产-enable 和普通 lifecycle 路径不具有此能力。
   从隔离 bare 中推送，禁止复制项目 object database/alternates。源 ref 的读回验证
   exact 合成对象图，不拿 control record validator 冒充验证，也不授予交付分支写权。
7. 沿用一次性 candidate/attempt 及已知所有权清理：bootstrap/source object 的
   unknown 保留证据，readback 验证的是实际字节/父树/身份，不是仅比较 descriptor
   自报值；清理按原批准 exact SHA，来源不明或仍有未收敛写入则保留。必需验收：
   预计算与物化字节/SHA 一致；批准前无 commit 对象；额度耗尽不生成对象；合法空
   genesis 可读且首 acquire 为其单父子提交；非 genesis 空树/源码祖先/任意 source
   ref 或 payload 拒绝；两端 bootstrap 竞争/中断只读恢复不重复计数、不改变 verdict；
   正常 acquire 不隐式 bootstrap，源 fixture 不被当成 control genesis 或业务 record。

#### 6.1.2 多客户端 qualification manifest 与证据闭环

1. 使用一个不可变 `qualification-run-manifest/1` 输入，字段限于 runId、精确
   repo ID/endpoint、实际 Harness artifact/runner hashes、复用的 synthetic catalog、
   control/source refs 与 genesis、固定 required case IDs、clients、总预算/时间和
   唯一 cleanupClientId。每端 clientId 绑定其真实安装 ID、actor、canonical common-dir
   及完整 HumanScopeBinding、有限 refs/操作/窗口、父票总额度、takeover allocations
   和允许 publication IDs；catalog 中对象存在不等于每端都有发布权。相同控制 ref
   的各端必须认可同一 genesis；普通 bootstrap/source publication 指定唯一发布端，
   同 SHA 多发布者只可作为清单显式声明的有限负面对照。不得在运行中追加客户端或资源。
   该例外使用严格的 `sameShaPublicationNegativeControl` 对象，固定绑定
   `caseId: dg01-cas`、同一 catalog fixtureId、exact ref/expected（SHA 或 absent）
   以及恰好两个已列客户端及各自不同的 publication transactionId；candidate SHA
   从同一完整 descriptor 推导，不另接受任意对象。两个客户端的真实安装 ID/common-dir
   组合须不同，其既有 `synthetic.publications` 必须逐项匹配上述元组；transactionId
   标识各自尝试，不写入共享 commit 字节。每端在此对照中最多一次 publication
   dispatch，各自实际物化对象仍各占 candidate 额度；这些上限全部计入各端父票和
   全局静态预算。只对该精确元组豁免唯一发布端，不能使用泛化的 `allowShared`，
   也不新增 ref、客户端、操作、额度或清理者。缺少此对象的重复发布权、重复
   transactionId、对象漂移或额外尝试均拒绝。固定 runner 须让两端先完成原有
   expected-ref 检查，再在受控调度下实际观察一次正向 update 和另一端的 Git `=`；
   第二端仅在前置读取时失败不能替代 §6.1.1 的 no-op 负面对照。不允许以任意命令/
   回调实现该调度；当前 manifest/本机 collector 只验证范围与已有事实，未执行的
   runner 对照仍是证据缺口。
2. 哈希依赖保持单向：实际 artifact/runner 与纯 synthetic descriptors → manifest
   → 各端 scope/approval → receipts → 汇总结果。manifest 保存各端不含 manifest 回指
   和 approvalRef 的 scope definition/projection；计算其 digest 后，各端现有
   qualification scope 增加 `{ manifestHash, clientId }`，除该关联外必须精确等于
   对应 definition，不能只校验宽泛子集。最终 approvalRef 只出现在下游回执/报告，
   不回填 manifest。runner 不内嵌最终 manifest/批准 hash；运行输入/报告位于既有
   运行期状态区，不成为自身执行 artifact 的输入，不借此排除任何实际可执行代码。
   manifest 是既有审批计划的不可变输入/快照，不另建可变 budget/state 文件。
3. 总 commits/普通 attempts 等于各端**父票总上限**之和，再与 manifest 全局上限
   比较；已包含的 takeover allocations 不重复相加。每端普通额度仍先扣除自己的
   全部分额，bootstrap/fixture/输家/失败按实际候选生成和 dispatch 分别计数；重复
   使用同 SHA 不免额。只有 cleanupClientId 可有非零 cleanup 额度，其他端为零；
   子票不能新增清理权。各端批准本身仍须既有明确人类授权，manifest 不代替批准，
   也不是跨机器共享计数器；遗漏客户端、混入另一 run 或超出静态总额均拒绝。
4. 在现有 approval-human 父票链追加一个最小 `qualification-writes-closed` 事件，
   绑定 runId/manifestHash/clientId，表示该父票及其子分额的**普通写窗口永久关闭**。
   同锁下登记；此后禁止新 child 登记、新普通 candidate/attempt 及其 dispatch，但
   允许已有候选/结果事实回写、只读恢复和原票尚有效的受限 cleanup。它不是 revoke，
   不产生新生命周期/租约，也不抹去已预留或 unknown 尝试；revoke 的原规则不变。
   重复 close 返回既有事件，不重开、不退款。关闭后仍需实际 runner 等待本端受管
   子进程收敛并读取父子完整链；仅写关闭事件不等于 drained，无结果/未知尝试继续保留。
   **关闭与 dispatch 必须由同锁串行化。** beforePush 没有 borrowed 句柄时取得
   原 common-dir apply.lock，并持有至 prepare、实际 dispatch、readback、最终
   outcome 全部收敛；已有 held 时仅借用。attempt/outcome 使用本次写句柄的 Locked
   入口，不能只在 reserveAttempt 内短暂持锁，也不能仅靠再检查一次 closed 状态。
   已预留 candidate 的结果可在关闭后记事实，但后续 beforePush/dispatch 必须拒绝。
   release 由 Store/publication 外层 try/finally 的显式终结器保证，只有 owned 锁
   才释放；`recordWrite({candidate,pushed})` 的正向 update 持久化是**中间回调**，
   不能在此提前释放。beforePush 尚未返回终结器就抛错时自行清理 owned 锁；未产生
   attemptId 的前置失败、readback/outcome 抛错也必须走终结器，borrowed 锁仍由原
   获取者负责。普通 close 遇到持锁写者只能按既有有界锁行为等待/报告忙，不越过它
   宣称窗口已关闭；未收敛子进程/写结果仍按 §5.3 保留恢复边界，不新建重入锁框架。
5. 每端 export 是现有 receipt/LKG 的**只读投影**：包含 manifest/client/批准关联、
   原生关闭事件、父票及全部已登记 child 的完整验证输入与最终链 heads、candidate/
   attempt/outcome 和持久化 push 结果、实际运行环境与 case 证据。collector 必须验证
   所有 manifest 客户端、分额占用和链完整性，包括未完成 LKG tail；没有输出的端
   不是零尝试。读取来源必须来自本机固定 loader 或实际受控原生子进程；跨机器须有
   真实实现的受信宿主执行/读取通道绑定目标安装身份与所执行 artifact。导入 JSON、
   hash chain 或 `verified=true` 只能自报内容，不能自证来源；来源不明不得自动通过。
   不新造签名平台/后台，也不把相同主机的两个 common-dir 说成两台机器。
6. 聚合与清理分别验证事实。每个竞争 case 按真实 candidate/expected SHA、受信
   原生 push 结果及当前 Git 完整对象/历史确认赢家；同 SHA 的 `=` 仍是 no-op，
   rejected 永不升级，缺少本次 update 证据的 synthetic `state-observed` 仍 unknown。
   唯一清理端必须确认所有端已关闭普通写窗口、全部相关执行已收敛、无未决 candidate/
   attempt，再用自己的 Broker 读取 actual ref。当前 SHA 必须属于任一已验证客户端
   的已知本轮候选及获批图；不能只认清理端自己的最后一次 Applied。未知 SHA、来源
   不明、未决写入、图外资产或读回漂移均保留。删除仍在清理端原批准时间/预算及本机
   锁下按 exact SHA 条件执行并核验 absent；关闭普通写窗口不授予删除权或延长窗口。
7. 最小接口为 `prepareQualificationManifest(input)`（纯校验/哈希）、
   `scopeForClient(manifest, clientId)`（生成待明确批准的现有 scope）、
   `closeQualificationWrites(commonDir, approvalRef)`（上述同链事件）、
   `collectClientEvidence(verifiedLocalContext, approvalRef)`（真实本机读取）、
   `evaluateQualificationRun(manifest, verifiedClientEvidence)`（派生报告）以及
   `planQualificationCleanup(manifest, verifiedClientEvidence, brokerObservation)`。
   最后一个仅产生现有 cleanup attempt 所需的精确候选与证据，不建立另一批准库；
   verified context/evidence 仅由固定来源 loader/runner 在进程内产生，CLI 不接收
   可伪造的布尔证明。复用现有原生用例与 synthetic catalog，case ID 选择固定 runner
   行为，不允许 manifest 提供任意 shell、脚本路径或 Provider。
8. **下一小批次只落实 manifest、每端范围校验、关闭事件、本机真实收集/聚合接口
   和负面对照**：哈希无环、额度不重计、重复分额/错端拒绝、关闭后普通写禁止但结果/
   cleanup 可用、reserve→dispatch 间另一进程不能插入 close、中间 update 回调后锁
   仍持有、所有异常路径正确释放 owned 而不释放 borrowed、跨端已知赢家可验证、
   遗漏/伪造/未决/同 SHA no-op 不通过。实际 runner
   的完整用例调度、跨机器受信通道以及 production adoption 必须分别提供实现与运行
   证据；接口存在不等于完成。本地独立进程只能报 LOCAL/同机多客户端；#86/#82 的
   最终跨机器验收目标保持不变。宿主通道尚未实现属于实施缺口，不包装成用户凭据
   blocker，也不据此缩减完整 v3 目标。本节不执行真实网络写入、登记凭据或发布。

#### 6.1.3 本机 synthetic runner/collector 的最小实施批次

1. 先实现固定 `local-synthetic-publication/1` 运行方式，仅顺序调用既有原生 runtime
   的两类操作：`bootstrap` 发布已批准空 genesis；`publish-source` 发布已批准空树
   source fixture。每一步仍走 Broker、对象验证、candidate/attempt 回执和 readback，
   不用测试 transport 替代。初始化只有 §6.1.1 的隔离 bare 对象存储，不创建交付
   checkout、不复制项目对象、不注册凭据或采用生产配置。这是合成发布及执行证据
   闭环，不是完整 `dg01-cas` 用例组；不会因为 bootstrap 成功就标该组 PASS。
2. manifest 的哈希输入增加固定 execution 描述：上述 kind 与有序 steps，每步只含
   `stepId/clientId/operation/fixtureId/transactionId`。真实 ref/expected/对象字节
   从对应已批准 client scope/catalog 唯一解析；逐项核验操作 kind、唯一发布端、
   transactionId 和额度。bootstrap 在其后续依赖之前，source 父对象依赖按清单
   顺序满足；不按运行时猜测重排、补步骤、重试或扩额。已有不含 execution 的
   manifest 可以历史读取，但不能隐式生成运行计划。本批不调度同 SHA 多发布者
   对照；包含该待执行步骤的运行请求须在任何写入前报告 runner 不支持，不能串行
   执行后冒充 §6.1.2 的 barrier 对照。required case IDs 是验收要求，不是执行结果。
3. 一个前台 supervisor 仅为列入本轮的本机客户端启动**固定原生 client 入口**，
   在开始步骤前核对真实 binding/artifact/manifest/scope。各 client 使用 supervisor
   实际创建的独立进程组；登记实际 ChildProcess 句柄、PID/PGID/可核验启动身份、
   本轮 IPC 关联和执行 artifact，不能从 CLI JSON 导入。同步 `runWithCredential`
   启动的 git/gh 及其后代必须留在该受控组内，禁止 shell、daemon、脱组或
   fire-and-forget；命令、参数和凭据仍由现有固定 runtime/Broker 生成。清单只能
   选步骤，不可指定任意可执行文件或把任意回调标为受信 runner。
4. 正常收尾顺序为：**停止新增调度 → 等待全部已启动步骤/子操作 → 验证进程组
   收敛 → close → collector**。client leader 在全部同步调用结束后进入固定
   no-more-spawn 阶段并保活；supervisor 读取实际 OS 进程组成员，确认只有仍由本轮
   持有的 leader 后，才令其正常退出，等待进程 close 并确认无残留组成员。仅 child
   exit、IPC 自报、spawnSync 返回或 Promise.allSettled 都不能代替该检查。此处
   覆盖的是本轮固定入口的进程树，不是整个宿主/editor 的写者覆盖。随后逐端取得
   既有 apply.lock 写/读父票 writes-closed，再同锁读取完整父子 receipt/LKG；
   supervisor 不得持父锁等待需要该锁的 client，避免再次制造锁嵌套。
5. 每个步骤与停止检查有界；异常退出、超时、截断、残留后代、失联或无法确认组
   身份时停止新调度，保留事实和远端资源，不签发 settled。终止只可针对仍可验证
   为本轮实际创建并持有的进程组；leader 已意外退出、PID/PGID 可能复用或身份不明
   时不得按旧数字任意 kill。即使曾发送 TERM/KILL 或稍后看不见 leader，也不能
   据此把异常运行升级为正常收敛。未决远端写、锁失去所有权仍遵守既有恢复边界；
   有界停止能力不足须如实报告，不能通过等待到票据过期来取得清理权。
6. 正常 supervisor 才能产生私有 WeakMap settled handle，绑定 manifest、全部
   client 执行实例和实际收敛证据；native collector 另发绑定真实身份/artifact、
   关闭事件和完整链 heads 的 facts handle。二者共同供 §6.1.2 唯一清理端使用，
   loader 只读成功不能制造前者。清理前在原批准锁/窗口/预算内重新核对链和实际
   ref；来源缺失、unknown、句柄失效或进程重启时仅保留并允许只读恢复，不以导入
   JSON 重建授权。所有 candidate/attempt/outcome/close 继续写原 approval-human
   链；运行日志是证据附件而非另一审批库、配额账本或常驻服务。
7. 本批报告精确步骤与结果、本机进程拓扑和实际 transport 证据；本机收集结果不
   冒充跨机器资格，未执行的组/子断言仍列为缺口。完整固定 case runner、同 SHA
   受控并发、跨机器受信通道和生产采用仍需实现及独立证据。本节只确定实现接口，
   不批准或执行任何真实网络写入、凭据登记、生产启用或额外清理。

#### 6.1.4 本机跨 client 发布事实、远端合成历史与精确清理

1. 最小接口为 `observeQualificationRemote(settled, clientEvidence)`、沿用的
   `planQualificationCleanup(manifest, settled, clientEvidence, remoteEvidence)`
   和 `applyQualificationCleanup(cleanupHandle)`；前两者只派生事实/精确意图，不
   新授权限。settled/evidence/cleanupHandle 必须来自既有私有进程内 registry，
   真实 cleanup client、repo/endpoint、credential 与 artifact 从 manifest 及
   native binding 取得，不能注入任意 transport/JSON/布尔证据。可序列化的报告
   或 plan hash 只供审阅，不可作为删除凭证。缺少实际进程组停稳仍保留现有门禁。
2. 用唯一 cleanup client 的真实 Broker 对每个获批 ref 执行：读取 exact SHA →
   fetch 该 SHA 到隔离 bare → 核验完整可达图 → 再读 exact ref，漂移则 retain。
   复用 objects 的 `validateSyntheticObject` 与 publication 的 source ancestry
   验证：actual commit 原始字节、空 tree、父节点逐一对应本轮已批准 descriptor，
   拒绝 catalog 外祖先、项目代码、未知对象或将读取失败当 absent。本批运行方式
   只有 bootstrap/source；control ref 必须是其 exact 无父 genesis，source ref
   必须属于获批 source 图。即便额外 control record 格式合法，也不因此取得本批
   删除权。后续完整 case 的 control 历史复用 Store/history 的完整树和增量验证，
   不另建历史后端、不以一次 ancestry 检查替代；该后续支持仍需实现。
3. 跨端归属从全部受信父子链计算，不只认 cleanup 端自己的 Applied。将每个实际
   candidate 的 subject、父/tree/对象字节 hash、created SHA，与该 client 的
   manifest publication/transactionId、exact attempt ref/expected/head 和持久化
   正向 push 结果逐项关联；当前 ref 的 SHA 须有本轮真实更新证据且通过上条对象
   验证。catalog 中“允许生成”或 ancestry 中“曾出现”不是当前归属；另一端的
   合法赢家可清理，同 SHA `=`、已知 rejected 或仅 state-observed 不计赢家。
   同一竞争出现两个不相容的更新归属、遗漏端/子票或任一 unknown 均 retain，
   不为清理反向改写 verdict。跨客户端事实通过不等于跨机器或完整 DG 资格通过。
4. 清理端必须位于原 manifest cleanupClientId/refs/cleanupExpiresAt/预算范围内；
   所有普通写已关闭、原生运行已收敛、完整父子链无未决结果。持 cleanup common-dir
   的既有 apply.lock，重验真实 binding/artifact、上述事实及远端 exact SHA，
   再用既有 human 预算入口登记 `operation: cleanup, head: null, candidateId: null,
   expected: <verified SHA>`，保存下述纯审计关联。manifest 分支不再要求“本端
   最后一次 Applied”；跨端所有权由原生 cleanup 组合层验证，实际 dispatch
   必须持有其私有 handle，而历史回放不依赖 handle（见 §6.1.4.1）。其余
   撤销、有效窗口、身份、单一未决 attempt 和预算检查不削弱。不生成 commit 或
   candidate，不新设审批类型。每次实际 dispatch 包括失败均占 cleanup attempt；
   unknown 只读恢复不重放，另一次获准网络尝试仍另计，不借相同 transactionId 免额。
5. **回执推进不应造成自锁，也不能被泛化忽略。** settled 绑定原运行实例和关闭
   时的已验证前缀，不把首次 facts 的全局 LKG head 永久当作唯一可接受值。每次
   cleanup 前重新 native collect 全部相关链；逐链验证原前缀与当前完整合法后缀，
   普通写关闭事实不变，不接受新增普通 candidate/attempt/child。本次 reservation
   追加后，dispatch 校验只认可该 exact attempt 及其新链头，不与追加前快照机械
   比较，也不放行任意 tail。完成一项后原生重收集，下一项重新派生 cleanup handle；
   已完成的获批 cleanup 后缀可验证继承，任何未决、撤销或非预期事实变化仍阻断。
   不用“忽略 cleanup 事件”或更新用户 JSON 来绕过漂移检查，不另建可变清理账本。
6. 在同一 GitHub transport/Broker 增加窄 `deleteRef(ref, expectedSha)` 操作，
   只有受信 cleanup dispatch guard 可调用；普通 push 仍要求非空 SHA，不能把
   空字符串解释为通用删除。固定命令仅推送 `:<exact ref>`，并带
   `--force-with-lease=<exact ref>:<expected SHA>`；禁 wildcard/mirror/批量 refs。
   借用同锁覆盖准备、dispatch、正向结果耐久记录、readback 和最终 outcome，
   最后由原持有者释放。Broker 身份/权限探测后立即重验票据、时间和 exact intent；
   不把探测前的许可缓存当作 dispatch 许可。
7. 在现有 push-result 分类器增加严格删除分支，不复用非空 source SHA 的更新
   正则：只有无执行异常的完整 exact-ref `-`/`[deleted]` 正向结果，加上真实
   readback absent，才能最终 Applied。先耐久保存实际删除结果，再读回；超时、
   截断、未知分类或删除后读回失败保留 unknown。失败/拒绝绝不因后来 absent
   升级；开始时已 absent 只记“观察到不存在”，不 dispatch、不消耗新尝试，也不
   声称本次删除。未知尝试缺少可靠正向删除证据时，恢复后 absent 仍只是观察事实；
   若已耐久保存正向结果，可按同事务只读补齐，不重删、不退回或重建远端 ref。
8. 此批以 existing LOCAL/native tests 覆盖另一 client 创建、唯一 cleaner 删除，
   图外/源码祖先/错误 ref/伪造 handle/未停稳/unknown/超预算拒绝，ref 在观察后
   改变时 exact delete 失败，同 SHA no-op 不获归属，以及两 ref 依次清理不会因
   第一条合法 cleanup 回执自锁。报告分别列发布事实、对象验证、停稳和清理结果；
   即便这些通过，未执行的 DG 子断言及跨机器资格仍 incomplete。本节不进行真实
   GitHub 写入、凭据登记或生产启用，不扩大既有有限隔离测试/清理授权。

##### 6.1.4.1 额度登记、历史回放与实际 dispatch 的代码边界

- 沿用 human attempt，manifest cleanup 增加严格的纯审计字段
  `cleanupEvidenceHash` 与匹配父 scope 的 manifest/client 关联；该 hash 绑定本次
  原生证据投影、ref/expected 和来源链前缀，不含尚未生成的本次 reservation/outcome，
  避免自引用。字段不适用于普通 create/cas，未知字段仍拒绝。audit hash 只是证据
  索引，不是审批、停稳证明或删除能力；现有 receipt/event/LKG 保存它即可。
- `human.ts::checkAttempt/history` 只校验可回放的 scope、manifest 唯一 cleaner、
  ref/expected/head/candidate 形状、审计关联、额度及事件顺序。cleanup reservation
  **之前的链前缀**必须已有 writes-closed，不能用后来 closed 的链尾补合法；当时的
  revoke/未决/预算规则不变。历史加载不访问当前 clock、远端、runner 或 WeakMap，
  不因批准现已过期而抹去既有事实，也不把审计 hash 当作已证实的跨端赢家。
- 普通 reserve 缺该审计关联仍拒绝 manifest cleanup；关联齐备也只是在同锁下
  登记有限额度，返回 attemptId **不授予网络 dispatch 权**。格式正确的任意 hash
  不能令 transport 删除，更不能把 reserved 当作 executed/Applied。避免泛用的
  `skipOwnershipCheck`、`verified=true` 或由调用者提供验证回调。
- 原生 cleanup 组合层独占私有 handle 校验：先重验 settled、native facts/远端图
  与真实归属，再登记 attempt；Broker 的 beforeDispatch 在同一 held 锁内校验
  该 handle 与 exact approval/manifest、attemptId/audit hash、ref/expected、真实
  binding/artifact、当前窗口及合法链后缀，并一次性消费本次 dispatch 资格。刚
  登记的**本次 exact pending attempt**由此接续，不能因它自身 pending 而自锁；
  任何其他未决或未知尝试仍阻断。进程重启后的 audit/attempt 只能读恢复，不能
  重建私有 handle 或重发原次删除；新获准尝试仍单独计额。
- 依赖单向保持 `cleanup → qualification/evidence/human/transport`；human 只
  使用已有 human_scope、manifest 纯数据校验与 receipt，不反向 import cleanup
  或 runner。实际 guard 使用既有 native transport 组合边界，不给 ledger 增加
  通用 callback 或另造 authorization store。

#### 6.1.5 固定本机 qualification 流程的最小 CLI 接入

1. 实际入口是 `mcp-server/src/cli.ts`；沿用 `ParsedArguments`，参考现有
   `credentials/cli.ts` 的逐命令白名单与重复参数拒绝，在窄 coordination CLI
   模块实现以下命令（均支持 `--project <management checkout>`）：

   | 命令 | 最小参数与作用 |
   |---|---|
   | `coordination qualification plan` | `--input <non-secret-run-request.json>`；核验并保存 manifest、目标映射及逐端待批准 scope/packet，不登记批准 |
   | `coordination qualification approve` | `--plan <saved-plan> --approve <exact-plan-hash> --approved-by <person> --approval-source <human-message-reference>`；显式登记本计划各端有限 qualification 父票，不运行 |
   | `coordination qualification run` | `--plan <saved-plan>`；加载真实批准链，在同一进程完成固定 runner → remote observe → 逐 ref cleanup |
   | `coordination qualification recover-cleanup` | `--approval <receipt-ref> --attempt <attempt-id> --project <cleaner checkout>`；调用既有只读远端恢复用例，不重发删除 |

   不增加 `--verified`、`--provider`、任意命令、导入 settled handle 或“自动批准”
   开关。run 是包含原票有限 cleanup 的固定流程，计划清单明确显示这一点；不提供
   普通“先 run 退出、以后导入 JSON cleanup”的失效句柄路径。
2. input 是有限 manifest 请求及 `{clientId, projectRoot}` 目标映射，不是审批事件。
   复用 synthetic/manifest schema；用每端真实 repository context、已登记非秘密
   credentialRef 与 `observeCoordinationBinding/currentHarnessArtifact` 取得实际
   binding，输入中的绑定只能匹配，不能自证 actor/host/epoch/artifact。绑定缺失
   明确报凭据登记门，不自动登记或扩权。拒绝未知/重复/多余参数、重复客户端、
   漂移对象或本批未支持的 execution kind；plan 不读取 secret、不写远端。
3. 复用 `prepare/saveQualificationManifest`、`scopeForClient`、
   `createSemanticApprovalPacket` 与 `recordHumanApproval`。计划 core 包含
   manifest、canonical targets 和 scopes；先计算 core planHash，再派生各 scope
   的审批 packet，不能把包含 planHash 的 packet 回填进自己的哈希输入。packet
   一次生成并耐久保存。各端 manifest 写既有 common-dir/harness/plans，管理端
   保存完整计划；都是待批准输入，不能因文件名/packet 存在而当作已批准。输出
   一份人可读摘要：exact repo/refs、步骤、每端与总额度、窗口、唯一 cleaner、
   合成内容范围和“不启用生产”，同时保留机器可读 planPath/hash。
4. approve 是已有 CLI 信任边界上的**显式操作者确认入口**；source message 引用
   只作为审计来源，不能声称 CLI 已密码学验证真人身份，agent 也不得从计划文件
   中的 `explicit-human` 字样推断已获用户批准。重新校验计划、实际绑定与 exact
   hash 后逐端登记原 human receipt，批准来源由这次显式调用形成，不接受导入
   `approved: true`/成品 approval JSON。多 common-dir 登记不是原子事务：中断时
   报告已登记/未登记列表；重试只复用同计划、同批准人/来源的原事件及 approvedAt，
   不重新生成时间/packet 导致幂等自锁，也不静默撤销或重批其他端。run 从各端原
   receipt 加载批准，不能只相信 approve 输出；所有票齐备才启动第一个 client。
5. plan、输入快照、批准来源和运行报告均保存在既有 common-dir 运行期区域，
   不写源码 checkout 或 dist。Harness source 模式先要求真实执行代码 clean，
   之后保存这些计划仍不改变 source HEAD/tree/artifact；目标项目 HEAD 不能冒充
   Harness HEAD。输入若自己放在 Harness 源码树中造成 dirty，应移动该输入的
   存放位置或正常处理变更，不通过扩大 artifact/git-status 忽略规则放行。包模式
   继续用实际 runtime manifest；plan/approve/run 均复核，没有 caller hash 覆盖。
6. run 复用 `runLocalQualification` 返回的私有 settled/evidence，再调用既有
   remote/cleanup 入口。每个 ref 清理后重新 native observe/collect、生成下一个
   私有计划，不能复用第一项的旧 chain-head 快照；无凭据/批准/能力或前置不合格
   时零远端 mutation。中途失败保留真实步骤、清理结果及 recovery 定位，不自行
   重跑或伪造停稳；所有凭据解析、真实 API 时间/身份检查仍经原 Broker。
7. `runCoordinationCommand`、`runWorkflow`、`main` 必须贯通 await，所有异步
   rejection 进入既有 JSON 错误出口；不能 `printJson(Promise)`、未等待就 exit，
   或丢失异常后返回成功。plan/approve 的 0 仅表示该操作完成，不表示资格通过。
   当前 run 即使发布/清理成功，也输出 `executionStatus: completed`、
   `qualificationStatus: incomplete`、`qualified: false` 和真实 not-run 子断言，
   返回 2（未完成/门禁）；1 保留给实现/测试/验证失败，3 仅真实宿主能力缺失。
   凭据、策略、批准与窗口门分别输出稳定 code，不能伪装 ENVIRONMENT_BLOCKED。
   未来资格入口只有全部必需检查实际通过才可 0；本批不提供会误绿的 qualify 命令。
8. 在现有 coordination/credentials CLI tests 和 native fixtures 上补真实 spawn
   入口验证：plan 不批准/不读 secret/不写远端，错 hash 或伪造事件不运行，多端
   注册中断可幂等继续，计划落盘不使 clean artifact 失效，source 漂移仍拒绝；
   fixed run 实际进入原生发布/停稳/观察/清理、第二 ref 不因回执推进自锁、异步
   失败被捕获、incomplete 不返回绿色。复用已有隔离 OS/gh/git fixture，不加生产
   `--test-provider` 或 JSON 证据捷径。`acquire/renew/rebind/transfer/takeover/
   terminal-claim` 当前只有 requireEnabled 门，不能因该门返回就报告执行成功；
   生产组合仍明确未完成并待后续实现。本批只实现和 LOCAL 测试，不登记本项目
   真实凭据/资格票、不执行 GitHub 试写或生产启用，也不缩减完整 v3 目标。

#### 6.1.6 固定资格 runner 的下一可执行切片

1. 现有 `publication.test.ts` 的同 SHA 对照用 LOCAL transport 和同进程调度回调，
   另有新进程拒绝恢复测试；`github.test.ts` 已覆盖受控原生串行发布/清理。这些是
   可复用的回归来源，不等于固定资格 runner 已执行相应 DG 子断言，更不是 LIVE
   授权。下一单元只补**原生双进程同 SHA no-op 与新进程 verdict 不升级**，不同时
   扩展全部 lifecycle 或生产采用。
2. 在既有 execution 判别联合增加固定 `local-same-sha-publication/1`，复用
   `sameShaPublicationNegativeControl`；最小实例仅一个无父空 genesis/control
   ref、两个已绑定 client/不同 transactionId，expected 为 absent。由该对象
   publications 的固定顺序决定先后 dispatch，不接受自定义流程或 barrier 回调。
   两端各占 1 candidate、1 write attempt，总上限至少 2/2；唯一 cleaner 至少
   1 次且包含该 ref，不因 SHA 相同免计，也不因两发布者把删除数算成 2。固定 CLI
   流程在 plan/load/run 前都校验 cleaner.refs 覆盖本流程全部目标 refs，cleanup
   上限至少等于将发布的不同 ref 数；不自动加码，纯 manifest 不因此丧失表达较小
   范围的能力。原 serial execution 的语义和不支持并发的拒绝保持不变。
3. 将现有 synthetic publication 内部窄拆成 prepare/dispatch：prepare 执行原
   expected-ref 实读、父图验证、candidate quota、对象物化与 created 回执；只
   返回 worker 私有、绑定本次 scope/transaction/object directory 的一次性句柄。
   普通 bootstrap/source 仍连续调用这两段。prepare 不预留网络 attempt，也不
   持 apply.lock 等 supervisor；后续 dispatch 重新验证对象、绑定、批准、时间和
   closed 状态，并按原 beforePush/Broker 路径持锁登记 attempt、实际 push/readback。
   不把先前 expected 观察当作现在仍相等的保证：exact-old-SHA 仍交给 Git；此处
   不追加一个会吞掉真正 `=` 的前置 ref-equality 拒绝，也不放宽身份/预算/时间门。
   句柄不可导入、跨 worker 使用或重放；失败保留原 candidate/attempt 恢复边界。
4. 扩展现有固定 worker/IPC 的 prepare 与 dispatch 消息，均绑定 supervisor nonce、
   manifest/client/step 和实际进程实例。两端必须都真实 prepare 完成，collector
   对照原 candidate 回执确认 same SHA/同 expected 后，才先 dispatch 第一个；
   验证其正向更新并读回，再 dispatch 第二个，必须实际取得完整 exact-ref Git
   `=`，在原 human 链记 rejected。这个**受控交错**不是“两个 acquire 同时竞争”
   的证据。预期 no-op 只有真实分类及回执匹配时作为该子断言的正常结果返回；
   任意其他异常、提前拒绝或 unknown 都不能被 worker 吞成通过。消息失序、重复
   dispatch、nonce/句柄漂移及任一端失败时停止新增写，不自动重试另一条路线。
5. 两写者先正常组停稳并关闭普通写窗口，再用同一固定 worker 入口的窄只读角色
   启动一个**新的** loser 进程，核对真实绑定和 exact 已拒绝 attempt，调用原生
   synthetic recovery，并复读 rejected verdict、candidate/attempt 计数未变化。
   该角色允许读取非 pristine 的已关闭票，但没有 prepare/dispatch 指令，不能
   为恢复放宽普通 writer 的 pristine 门。它复用原 clientId/批准，只增加进程实例
   和 role，不新增客户端预算；监督其实际停稳后，原 collector/remote/唯一 cleaner
   接续。不以测试内 fake Store、人工写入 verdict 或 JSON `readOnly=true` 代替。
6. 在原报告中为 §7 的固定用例组增加固定子断言结果，不另造批准或可执行脚本
   registry。本切片仅覆盖 `dg01-cas` 下 same-SHA 实际更新、no-op 拒绝、唯一
   可归因赢家，以及 `dg01-recovery` 下 rejected 在新进程不升级；证据引用原
   candidate/attempt/receipt、实际 worker 实例、Git 正向/`=` 输出、远端对象图
   与真实 readback。每组其余子断言仍 not-run/incomplete，不能因覆盖一项就把
   整组标 PASS；所需子断言清单逐条保留 §7，不由 manifest 自定义或删除。结果
   仍 `qualified: false`，按既有 CLI incomplete 结局返回。
7. 后续按下表的最小边界补齐同一固定 runner；已有测试可复用固定断言/fixtures，
   不调用任意 Vitest 命令再把汇总转换为授权资格。DET/LOCAL 事实与实际 Broker
   LIVE 事实分别记录 exact artifact、run/case/subassertion、真实拓扑和来源：

   | 后续切片及现有测试来源 | 必须保留的用例组/真实证据边界 |
   |---|---|
   | Native acquire 双候选竞争、rebind/renew；service/authority/authorization | 补 `dg01-cas` 全部预期元组、唯一主写/其他 Work Item 保留；`dg01-time-renew` 正向服务端时间与换绑。实际 GitHub CAS/Date/readback 不能用本机时钟或模拟 Provider 顶替 |
   | 固定故障与恢复；clock/history/store/publication | `dg01-objects-history`、`dg01-late-renew`、`dg01-recovery` 及剩余时间边界：真实 LOCAL Git 图/进程重启和版本化确定性时钟故障；不修改宿主系统时钟、不把注入结果说成 LIVE |
   | 身份、票据/预算与 CLI；credentials、authority、human、manifest、CLI | `dg01-identity-scope`、`dg01-human-budget`、`dg01-cli-gates` 全部子断言；真实 native 入口/链及无 mutation 证据，secret canary 只用合成值，不以 mock API 身份声称生产权限 |
   | 交接/接管及写者排空；handoff/takeover/client_process | `dg01-handoff`、`dg01-drain`：复用真实目标取回与有限接管票、受管写者锁/进程覆盖；同机两个目录不能替代实际跨机器受信执行/读取通道 |
   | terminal；service/github | `dg01-terminal`：原生 Provider 的实际 exact PR/merge 只读证据及旧代拒绝；如需要新建 PR fixture，另列其有限授权，不能借只含 synthetic refs 的票执行 PR 写入 |

8. 最终仍须完成成果04 DG-01 的真实公开/私有测试仓库证据和跨机器合同，按每份
   有限清单静态计额，不把旧 probe 配额当无限许可。本切片先补 manifest enum、
   publication 两段复用、固定双 writer/只读 restart 调度及上述子断言，再做 LOCAL
   原生回归；没有任意 command/Provider/JSON verified 捷径，也不修改生产资格
   判定来迁就子集。本节只确定实施顺序，不新增批准、不运行真实凭据或远端写入。

#### 6.1.7 Native acquire 竞争、stale tuple 与其他 Work Item 保留

1. 下一单元固定为 `local-acquire-contention/1`，不并入旧 publication profile。
   清单绑定两个 client、两个不同 Work Item key（遵循现有 record schema）、一个
   control ref、两个空树 source fixture refs，以及逐步骤 client/transactionId、
   branch/source SHA 和有限 lease TTL。两份 A 工作区分属两个已登记 common-dir；
   B 工作区位于其中一端。Work Item 仅是本隔离控制 ref 中的测试记录，不创建或
   修改 Issue/Project、不冒充正式交付租约。不得上传项目对象、改用户 checkout
   的 HEAD/index/文件、切换已有分支，或为新 clone/common-dir 复制凭据与批准。
2. 为此 profile 增加获批 `localResources`：逐项 exact resourceId/clientId、真实
   authorityRoot/commonDir、canonical 新路径、新 branch、source fixtureId/SHA、
   allowed operations（导入该合成图、创建一次、只读核验、精确收尾）、有效期及
   本端最大同时存量；绑定已观察 worktree config/host-binding 摘要。进入 manifest
   core 和原逐端 human scope 后再计算 hash，不能循环引用批准 hash。最小实例
   **3 个 linked worktree/3 个本地 branch**（A 两份、B 一份），没有重新分配/自动
   重试余量。plan/load/run 在任何发布前校验配置、保护路径、容量及远端/本地收尾
   范围；普通 run 无此字段就零本地分配。缺安全绑定、策略不允许或容量不足时明确
   拒绝，不静默 configure、扩根或加容量；这不把已有纯 publication 资格试写改成
   必须先初始化 v2。真实新增路径/分支/对象写入只能来自未来 exact run plan 批准，
   当前可继续实现与 disposable LOCAL 测试，无需先执行真实配置或索取生产许可。
3. 在既有 worktree-delivery 域复用/窄提取 `validateTarget`、`validateBranch`、
   `workspaceStatus` 的实读与容量规则、已有工作区资产核验和 exact add/remove
   原语；所有资源 reserve/create/close 使用同一 `recovery.acquireMutationLock`
   的 opaque held 句柄与原 receipt/LKG 能力。不得直接伪装调用要求真实 Provider
   项目状态与 Delivery lease 的 `planWorkspaceAllocation`，也不复制一套宽松路径
   检查。资格夹具的预留/创建/保留/收尾事实写**原 qualification human receipt**，
   原 worktree status/audit 只读投影这些资源、计入同一容量与占用检查；正常 allocate
   也必须看见它们。先在锁内耐久预留全部本端名额，再创建；未决创建继续占额，不能
   靠换名/无 lease 隐身。投影不是第二资源账本，不伪造 active/done 交付状态，不改
   既有 host-binding strict schema。两个 common-dir 不假装共享锁：先逐端完成
   前置检查/有限预留，任一端失败就停止后续创建并精确收尾本轮已知资源。
4. 只通过现有 Broker 将 exact source 图取到 config-free bare 暂存区，核验批准
   object bytes、全部祖先与空树后，以固定对象导入原语（如受限 pack/index-pack）
   将**仅该有限合成图**导入原 common-dir；不得用项目对象作父，也不经项目 URL
   rewrite 的任意 fetch 路由。已有对象字节的复制不是再生成 candidate，但本地
   object-store 写入必须在 localResources 中披露。沿用受管 add 原语创建新 branch
   与 no-checkout linked worktree，固定命令禁 hooks/fsmonitor/自动维护副作用，
   不持久改 Git config；source 空树令真实工作区应为空且 clean。实读 Git worktree
   注册、真实路径/common-dir、symbolic HEAD 与 exact commit 后，native loader
   才签发绑定本次 receipt/resource/进程实例的私有 workspace capability。路径或
   branch 已存在、漂移、symlink、部分创建或身份不明就保留/拒绝，不 force 接管。
5. qualification runtime 内部区分 authorityContext 与 fixture workspaceContext：
   原 authorityRoot 决定 Broker、credentialRef/actor/安装 UUID、endpoint、实际
   config/policy epoch 与 artifact；新工作区只供现有 `assertCoordinationWorkspace`
   及受管写者 context 实读 branch/HEAD，且必须分享原 exact common-dir。保留
   LifecycleService 与 Store 的双层真实身份/候选校验，不以空 fixture 的 policy
   `none` 替换原 epoch，不复制配置/凭据。组合入口只接上一步 native 私有能力并
   再验证原批准范围；没有 production `--workspace`、caller-set root、跳过验证或
   JSON `verified` 入口。资源只属于该固定资格流程，不由此授予普通代码写入权。
6. 固定次序：发布 genesis/source-A/source-B → 分配并核验三个夹具 → 用 B 的
   实际 native lifecycle acquire 预置 B → 两个 A worker 都从含 B 的同一已读 tip
   prepare 首次 acquire → 两者均完成后各 dispatch 一次。窄拆现有 lifecycle/
   Store prepare/dispatch，普通 acquire 仍连续调用；prepare 执行原 authority、
   服务端时钟、完整树/expected 校验和 candidate quota，保存不同 transactionId
   的私有候选；dispatch 重验身份、工作区、窗口、候选与原审批/Broker 门，以原
   exact-old-SHA Git push 竞争，不换父、不自动重试。barrier 等待不持 apply.lock；
   dispatcher 不重建候选或把预期冲突在发送前吞掉。必须取得一条真实 update 和
   一条完整 Git stale rejection、同父不同 SHA、实际赢家读回与唯一成功 acquire；
   unknown、提前门禁或迟到失去租期不能算该断言通过。原同 SHA `=` 对照仍独立。
7. 在赢家真实工作区与 native runtime 上，固定 worker 逐项改变完整 expected 的
   generation/owner/machine/Head/epoch/recordHash，走原 rebind 入口；另以旧 tip
   对照 Store 的 expected-control-SHA 前置检查。每次必须命中目标拒绝、候选/网络
   attempt 计数不变、control ref/tree 不变，而非让错误 workspace/expired lease
   掩盖待测条件。只读收集 B 在预置、两候选树、赢家树及所有拒绝后的 exact blob/
   recordHash 相同，A 恰好新增一条；不能只比较记录数量。固定执行步骤本身绑定
   scope 中的 Work Item/branch/source/TTL，不能借这些入口提交任意 next record。
   本最小实例上限是 **6 candidates、6 write attempts、3 remote cleanup attempts**：
   genesis 1 + source 2 + B acquire 1 + A contenders 2，失败也计入；初始化端可分
   5/5，另一端 1/1。stale 对照零新候选/写尝试；3 个本地资源另计，不能挪用网络
   额度或自动加预算。计划必须同时足够清理全部 3 refs 和全部本轮创建资源。
8. 复用 §6.1.4 的 native remote evidence/唯一 cleaner，窄扩此 profile 的控制图
   校验：从批准 genesis 验证完整记录历史，所有新增 candidate 必须可关联本次
   原 human receipt、固定步骤与 source 图，实际当前赢家唯一可归因；只认格式
   正确而来源不明的记录仍 retain。先停止调度、真实监督全部进程停稳/关闭普通写
   窗口、完成 exact-SHA 远端清理，再以同锁复验本地资源身份、clean/untracked/
   ignored/unique/unpushed 和 exact branch/head 后收尾。批准的合成对象采用
   exact 图归属证明，不因它不在 main 祖先中而自锁，也不因此放行额外资产；本地
   branch 仅在本轮工作区移除后 exact-old-SHA 删除，无 force/remove-all/prune。
   失败资源保留原回执与容量占用，允许原只读恢复，不凭 closed 声明已清理；已经
   导入但无 ref 的合成对象可留待正常 Git 维护，本流程不运行广域 gc/prune。报告
   只增加本次实际执行的固定子断言；LOCAL 双进程不等于跨机器或 GitHub LIVE，
   其余 §7 子断言继续 not-run，完整 qualification/生产采用目标与门禁不变。

## 7. 施工顺序与最小证据

1. 先给协议/时间/错误合同与 CLI 负面用例加测试，再实现窄域；随后补 Broker 的真实
   transport 和 readback。复用已有 Vitest，不新建测试框架或测试执行器。
2. 以本地 bare-remote fixtures 验证真实 Git 竞争、exact old SHA、完整树保留和异常恢复；
   这些明确标 LOCAL，不冒充 GitHub LIVE。每个身份/权限分支有 secret canary 负面检查。
3. 在同一 Issue 上记录下表的证据缺口；候选 ready 后再做独立精确 HEAD 评审，原 writer
   一批修复 P0/P1，并保存诚实的 known-bad RED → candidate GREEN 回归证据。
4. 最后在获批隔离 scope 内对 exact candidate 做 LIVE 行为资格验证；零跳过、零吞错。
   尚有条件缺失则保留 Draft，不关闭 #86、不解开 Wave4/生产 Prepare 门。

下列 11 个固定 case ID 与既有验收矩阵逐行对应，是固定 runner 的用例组枚举，
不是新增验收项；每组必须保留该行全部子断言。有限单次 manifest 可选择子集，但
列入 ID 不等于执行或通过，子集结果不能宣称完整 DG-01。§6.1.1 的同 SHA no-op
及跨进程 verdict 不升级分别归入 `dg01-cas` 和 `dg01-recovery`，不另建用例类别。
ID 不编码 backend/机器数；证据另记真实环境、进程和安装身份。本机 collector 只能
报告 LOCAL/同机事实；完整资格仍须实际 runner、受信跨机器通道及合同要求的 GitHub
LIVE 证据，不把可在 LOCAL 完成的故障注入一律搬到远端，也不以 LOCAL 替代 LIVE。

| 固定 case ID | 证据组 | 正向及必需负面对照 |
|---|---|---|
| `dg01-identity-scope` | 身份/范围 | 正确 actor/repository/credentialRef 成功；同 hostname/路径但不同安装 UUID 不混同，普通读取不生成 ID；wrong ID、fork/source 映射错、endpoint rewrite、多 pushurl、secret 泄露和隐式凭据继承被拒 |
| `dg01-cas` | CAS/唯一主写 | 两个进程首次 acquire 只有一个赢家；stale expected SHA/generation/owner/Head/epoch/recordHash 逐项拒绝；其他 Work Item 的记录不丢失 |
| `dg01-objects-history` | 对象/历史 | 无 checkout；未知路径/模式、symlink、截断与读取失败不当 absent；拒绝源码祖先、断链和中间未知版本；冷缓存可分段恢复，超过单批预算的合法长链可完成，检查点不授予写权限 |
| `dg01-time-renew` | 时间/renew | 有效窗口 renew 不增代；到期边界、秒级 Date、往返延迟、陈旧/缺失/倒退样本、本机时间跳变、休眠和超时不能延长授权 |
| `dg01-late-renew` | 迟到 renew/跨进程 | 旧到期后 reservation 才落远端、发起进程退出、新进程读取时无同代写权；及时证明后的确认可恢复，但与 takeover/terminal 竞争必须拒绝旧确认，未确认拟延长期限永不授权 |
| `dg01-recovery` | 缓存/恢复 | 删缓存不删远端事实；CAS 后崩溃按 exact candidate/合法历史恢复原事务，ref 推进或新代取代不重复转换；同 transactionId 内容漂移、unknown outcome、401/403/5xx、复读旧 SHA 不报告成功 |
| `dg01-handoff` | transfer/takeover | 目标端实际取回 exact Head 后单 CAS 换代并保留原 expiresAt；冻结期间写/renew/rebind、伪造 source facts/target 身份、迟到 accept 授权均拒绝；dirty/untracked/ignored/unique/unpushed/离线/资产批准漂移逐项阻断，旧代不重新授权 |
| `dg01-drain` | drain/接入 | 同锁在途写者未结束不发布 source proof；获锁后的排队写者拒绝 frozen 状态；缓存 admission 不越过新 freeze；未接入入口/缺宿主停稳证据不报告完整 drained，不嵌套获取既有 Apply 锁 |
| `dg01-terminal` | terminal | 有效 exact merge 可在租约过期后终结；新代/epoch/身份漂移拒绝；claim 无 TTL 无写权，不产生 cleanup token、不删 Branch/Worktree |
| `dg01-cli-gates` | CLI/安全面 | 正常入口真实进入用例；无配置/资格/启用授权零 mutation；未知字段/伪造审批/伪造 merge 证据拒绝；safe-mode 只读恢复观察仍可用 |
| `dg01-human-budget` | 人工授权/预算 | 正确隔离授权可首次试写但不能生产启用；错用途/ref/actor/repo/endpoint/hash、过期/超预算拒绝；并发尝试不超支；unknown 只读恢复不重放/重复计数，新写重试仍逐次计数；enable Apply 票据到期不单独撤销已采用配置 |

运行受影响测试、TypeScript 检查、lint，以及源码入口 `check --mode commit` 和 `drift`；
每项保存 exact HEAD、argv、退出状态及证据 hash。执行构建或完整 wrapper 前检查其命令链。
新增 eval 来源若触发 intake 漂移，单列未批准来源状态，不能擅自 `--approve-sources`。

## 8. 交接约束

本计划选择原生 Git CAS 的施工方向，不改变成果01/03/04，不是额外后端或生产许可。
后续 writer 可补齐同范围实现细节，但遇到无法证明的时间安全性、所需新凭据权限或
更强 server enforcement，回报具体证据，不能降格需求、偷偷启用或转为第二后端。
当前 management 中的 worktree 配置未跟踪，#86 checkout 不会自动继承该文件；
生命周期命令从已配置 management 入口运行，不能手拷配置伪造新一轮批准。
