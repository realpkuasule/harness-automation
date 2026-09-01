# PRD: 禁止为 npm 发布新建 worktree

## 状态

- Owner: zhichao
- GitHub Issues: `realpkuasule/harness-automation#67`, blocker `#68`
- 批准日期: 2026-08-31
- 阻塞修复批准日期: 2026-09-01
- 状态: 自举修订待 owner 批准；批准后必须重新执行 Harness intake 并生成新计划

## 问题

Harness Automation 的 npm 发布由 `v*` tag 触发 GitHub Actions 完成，Actions 会自行 checkout。为版本更新、发布验证、打 tag、publish 或失败重试另建专用 release worktree 没有隔离价值，反而会留下重复 checkout、脏状态和分支漂移。

## 目标

将以下规则固化为跨会话、跨 Agent 的发布约束：

1. **PRD-REL-001**：npm 版本更新、验证、打 tag、publish 和发布重试必须复用现有 primary/management checkout。
2. **PRD-REL-002**：不得仅为 npm release 创建、分配、接管或使用专用 worktree。
3. **PRD-REL-003**：primary/management checkout 不适合安全发布时必须停止并报告原因，不得以新建 worktree 作为兜底。
4. **PRD-REL-004**：普通 GitHub Issue 开发、集成检查和临时 Review worktree 保持现有行为。

## Harness 自举阻塞

首次 apply 暴露出 Harness 2.8.0 的 TypeScript naming gate 没有可靠的既有仓库采纳路径。复核共同执行路径后确认：apply 写入计划目标，随即由 `checkProject` 调用共享 `checkTypeScript` 执行全仓检查；失败则由原事务回滚。该 post-apply 验证和回滚必须保留，根因在 naming verifier 的错误分类，以及 baseline 缺少受控的采纳与收缩语义。

原先报告的 60 条并非历史债务，而是五类分类误报：25 条 UPPER_SNAKE_CASE import、8 条 Node 约定标识符 `__dirname`/`__filename`、2 条占位参数 `_`、22 条 PascalCase Zod schema 常量、3 条 `static readonly` 常量。修正这些语义并按原政策只允许模块级 `const` 使用 UPPER_SNAKE_CASE 后，严格扫描另发现 4 条真实历史债务：`mcp-server/src/__tests__/integration.test.ts` 的 `TS_INPUT`、`PY_INPUT`、`GO_INPUT`，以及 `mcp-server/src/validators/setup_validator.ts` 的 `NON_RULE_KEYS`。原 60 条不得迁入 baseline；这 4 条只能通过受控 adoption 流程暂时采纳。

为解除自举阻塞并保持 gate 只进不退：

1. **PRD-HARNESS-001**：共享 TypeScript verifier 必须正确识别五类合法命名，同时继续拒绝局部或可变的 UPPER_SNAKE_CASE、普通 PascalCase 值、非占位下划线名称及其他真实违规。
2. **PRD-HARNESS-002**：真实历史债务 baseline 必须绑定固定 rule ID `typescript-naming` 与稳定 SHA-256 违规指纹；指纹至少绑定规范化仓库相对路径、标识符角色和名称，不得依赖行号、格式或诊断文案，并按多重集精确匹配。
3. **PRD-HARNESS-003**：新建 baseline 必须来自 owner 显式批准的 naming adoption intake；policy 必须记录批准该 baseline 的 intake hash，baseline 内容必须进入 immutable plan、operation hashes 和完整 `planHash`。
4. **PRD-HARNESS-004**：未显式请求 adoption 的 plan 只能保留“旧 baseline 与当前 observed violations 的多重集交集”；已修复项自动从计划中的 baseline 移除，baseline 只能单向收缩，不能静默扩张。
5. **PRD-HARNESS-005**：baseline 新建、扩张或替换属于 weakening，必须同时经过 fresh explicit adoption intake、显式 adoption plan 和 owner 对新完整计划哈希的精确批准；同一旧 intake 不得再次授权扩张。
6. **PRD-HARNESS-006**：apply 写入前必须重新扫描现场并复核 rule ID、指纹多重集、intake hash 与 baseline transition；写入后继续运行现有全量 `checkProject`，任何失败继续走现有 rollback。
7. **PRD-HARNESS-007**：TypeScript parse error 不得生成可采纳指纹，也不得被任何 baseline 过滤。
8. **PRD-HARNESS-008**：CLI 与 MCP 必须复用同一个 intake/plan/apply/check 服务入口，不建立第二套 baseline 文件、waiver、ignore 或迁移系统。
9. **PRD-HARNESS-009**：原本干净的 TypeScript 仓库继续零容忍；没有显式 adoption 时，任一真实 naming violation 都必须失败。
10. **PRD-HARNESS-010**：`passing` 与 `enforced` 必须继续独立证明；known-bad negative control 必须以合同规定的退出码被拒绝。

任何治理输入或源码变化都会使旧计划失效。不得复用失败计划 `b4d05857b22cbf70a01ff228e90e7a3f7a25f90fb8d8ec6d40cd268c3ed927c1`，也不得把此前已应用计划的哈希用于本次修订；完成实现和测试后必须重新 intake、discover、plan，展示新的完整哈希并等待 owner 精确批准。

## 实施范围

- 更新全局 Codex npm 发布护栏，使任务编排在创建 release worktree 前停止。
- 更新随 npm 包分发的 `manage-worktree-delivery` Skill，增加 npm release 例外和触发描述。
- 更新 npm 发布参考文档。
- 复用现有安装测试，验证安装后的 Skill 包含该约束。
- 记录 `CHANGELOG.jsonl`。
- 先修正 TypeScript naming verifier 的五类误报，再完成 blocker `#68` 的 owner-approved fingerprint baseline/ratchet，最后重新治理本仓库。

## 非目标

- 不修改 `mcp-server/src/worktree/`、worktree schema 或配置格式。
- 不修改 `.github/workflows/publish.yml`。
- 不禁止普通开发或 Review worktree。
- 不从 branch 名、路径或 commit 内容推断发布意图。
- 不自动删除现有 release worktree、分支或未提交内容。
- 不通过真实 `npm publish` 验证本修复。
- 不删除 `.harness`、关闭 naming gate、扩大 ignore、跳过 post-apply 验证或增加通用 waiver。
- 不实现通用迁移执行器；只复用现有 intake、plan、hash approval、apply receipt 和 rollback 路径处理 `typescript-naming` adoption。
- 不为误报的 60 个合法标识符建立 baseline，也不为解除自举阻塞批量重命名这些标识符。

## Harness 最低验收测试

1. 五类合法命名均不产生 violation；真实 snake_case、非法 UPPER_SNAKE_CASE、普通 PascalCase 值等仍被拒绝。
2. 带真实历史违规的仓库可以通过 owner 显式批准的 adoption intake、immutable plan 和 exact full hash 启用规则。
3. baseline 中精确匹配的原有违规暂时允许；稳定指纹不因插入合法空行、注释或格式变化而改变。
4. 新增、重命名、移动到其他路径或改变标识符角色的同类违规会被拒绝；重复违规按数量精确计算，不能由单个 fingerprint 无限放行。
5. 修复历史违规不会失败；下一次未显式 adoption 的 plan 会令 baseline 自动收缩，收缩 apply 后不得重新引入已移除违规。
6. 未经 fresh explicit adoption intake 的 baseline 新建、扩张或替换在 plan/apply 路径中被拒绝；错误或旧计划哈希也被拒绝。
7. 原本干净的仓库行为不变；parse error 永远不可采纳。
8. known-bad fixture 仍以合同规定的退出码被拒绝，不能仅以 positive runner `passing` 宣称 `enforced`。
9. Harness 在本仓库完成一次真实的 fresh explicit adoption intake、discover、new immutable plan、exact-hash apply、session/CI check 和 drift clean 闭环；生成 policy 不再包含原 60 条误报，只精确采纳已批准的 4 条真实历史债务。
10. 随后重新推进 npm 发布修复，并证明发布路径没有调用 worktree create/allocate/adopt，且前后 `git worktree list --porcelain` 路径集合不增加。

## 验收标准

1. Agent 规则明确禁止为 npm release 或重试新建专用 worktree，并要求使用 primary/management checkout。
2. 安装到 Claude Code、Codex 和 portable Agent 的 `manage-worktree-delivery` Skill 均携带该规则。
3. 普通 Issue、集成和 Review worktree 的文档语义不变。
4. `skill/install.test.sh` 能在约束未被分发时失败。
5. build、安装测试、完整 test、lint、`prepublishOnly` 和 `npm pack --dry-run --json` 通过。
6. 修复实施和后续发布过程前后的 `git worktree list --porcelain` 路径集合不增加。

## 形式化边界

该规则属于 procedural/cognitive governance：Harness 可以证明规则已配置并分发，但 Git commit 和 npm registry 无法可靠证明提交源自哪个 checkout。因此不得把它宣称为 worktree CLI 的确定性 enforcement。

---

# PRD: 一等公民的项目治理升级

## 状态

- Owner: zhichao
- GitHub Issue: `realpkuasule/harness-automation#69`
- 需求批准日期: 2026-09-01
- 状态: 本节、配套设计和当前状态调研是下一轮 Harness intake 的批准输入；实施完成后必须由 owner 精确批准本仓库 update plan 的完整哈希
- 前置条件: 保留并验证上文 TypeScript naming 自举修复，不得覆盖、回退或绕过其 baseline ratchet

## 问题

已经应用旧版 Harness 的项目没有正式升级入口。现有普通 `plan` 依赖调用方再次传入 profile 和各类 profiles，漏传会把已有显式选择编译为空；manifest 又只记录 `harness-automation@2`，无法判断项目最后由哪个精确包版本编译。项目因此只能冒险重新初始化、手工改 generated state，或无法证明升级历史和审批链连续。

## 正式接口

只提供一个正式 CLI 入口：

```bash
harness-automation update plan --project <absolute-path>
```

不同时提供 `upgrade plan`、`plan --upgrade` 或 `plan --update`，不新增独立 apply、approval、receipt 或 rollback 命令。该命令由用户已经安装或构建好的当前 CLI 离线执行，不查询 registry，也不负责安装 npm 包。若 `.harness/policy.yaml` 不存在，必须返回 `HARNESS_INITIALIZATION_REQUIRED`。

## 功能需求

1. **PRD-UPG-001 — 原地继承**：升级规划必须读取现有 policy、manifest、intake 和 discovery，自动继承 owner、profile、stacks、deliveryProfiles、domainProfiles、qualityProfiles、phase、approved adoption baseline 及其他当前编译器理解的显式项目选择；调用方不得重新输入这些事实。
2. **PRD-UPG-002 — 当前编译器重编译**：候选策略由当前 CLI 的同一个 policy compiler 基于当前仓库状态编译；命令不联网、不安装依赖、不运行项目命令。
3. **PRD-UPG-003 — 计划阶段零副作用**：有变化时只可新增一个 `.harness/plans/` 下的 immutable policy update plan；当前版本且语义无变化时返回 `current`/no-op，不写 policy plan。普通 policy update 不得创建、删除、移动或切换 branch/worktree；companion workspace 状态或迁移要求不得迫使系统生成空 policy plan。
4. **PRD-UPG-004 — 完整差异**：升级结果必须报告旧/新 compiler package version 与 policy schema version、按稳定 rule ID 对齐的 added/removed/changed、formalization、severity、verification argv、target adapter coverage、include/exclude、baseline、source/intake/discovery drift、worktree configuration 状态、warnings、migrationRequired，以及每个目标文件的 before/after SHA-256。所有可应用内容和差异元数据必须进入完整 plan hash。
5. **PRD-UPG-005 — 单一应用路径**：升级计划必须由现有 `apply --plan ... --approve <full-sha256>` 应用，继续复用全部 precondition、事务写入、post-apply check、change receipt 和 rollback；不得隐式 apply，也不得建立第二套审批或回滚系统。
6. **PRD-UPG-006 — 精确编译器身份**：新编译的 policy 和 manifest 都必须记录精确 npm package name 与 version。旧文件只有 major 标记或没有精确版本时状态为 `legacy-version-unknown`，不得猜测历史版本。
7. **PRD-UPG-007 — Doctor 状态**：`doctor` 必须离线比较项目最后编译版本与当前本地 CLI，至少返回 `current`、`stale`、`legacy-version-unknown`、`unconfigured`；`current` 仅代表二者与本地安装版本一致。
8. **PRD-UPG-008 — 来源漂移 fail-closed**：approved PRD、design、research、eval source 或 discovery 已漂移时，update plan 必须在写计划前失败，给出重新 intake/discover 的准确动作；不得自行批准来源。
9. **PRD-UPG-009 — Baseline 单向 ratchet**：现有精确 TypeScript naming fingerprints 可以保留，已修复项自动收缩；新增、替换或扩张只能复用 fresh explicit owner adoption intake。parse error、万能 waiver、ignore、关闭规则或扩大排除均不得代替 adoption。
10. **PRD-UPG-010 — Weakening 独立批准证据**：删除规则、降低 severity、deterministic→procedural/cognitive、procedural→cognitive、减少 verifier/target adapter、缩小 include、扩大 exclude、关闭 active rule、降低 eval threshold、移除 task/gating grader/traceability 或 known-bad control 都是 weakening。新 policy 必须持久化 canonical EDD semantic snapshot；legacy policy 无 snapshot 时只有旧 eval source hashes 与当前批准 source set 完全一致才可安全继承，否则 fail closed。weakening digest 必须绑定 before/after policy digest、semantic diff 和完整 rule ID 集合；只有 fresh owner intake 可批准。
11. **PRD-UPG-011 — Worktree 配置正交升级**：存在 `.harness/worktree-delivery.json` 时只读检查 schema、host binding 和当前 CLI 兼容性，并只报告 `not-configured`、`compatible`、`configuration-plan-required` 或 `migration-required`。所有显式值必须逐值保留；可无损重写时复用现有 `workspace-plan` 生成独立 immutable configuration plan 和独立完整哈希。需要 legacy-flat→container-v1 或其他目录移动时只报告 `migrationRequired` 与精确 `worktree migrate` 后续命令，policy update plan/apply 不得执行拓扑迁移；无效 schema 直接 fail closed 且零计划。
12. **PRD-UPG-012 — 引擎与配置状态分离**：输出必须区分“当前 CLI 执行算法已升级”“policy 已重编译”“worktree 配置已重写/仍待迁移”，不得把安装新 CLI 描述为项目配置已迁移。
13. **PRD-UPG-013 — 自举闭环**：功能和测试完成后，本仓库必须执行真实 update plan，展示完整哈希并等待 zhichao 精确批准；批准后执行现有 apply、`check` 和 `drift`，证明不会重现自举死锁。
14. **PRD-UPG-014 — 发布边界**：Issue #69 不自动发布 npm，不为 npm 发布创建 worktree。是否发布必须在全部功能、自举和 prepublish 验证通过后另行决定。

## 非目标

- 不删除或重新初始化 `.harness`，不删除 managed blocks，不清空 baseline。
- 不查询 npm registry，不比较远端 latest，不安装或升级 CLI 本身。
- 不在 update plan/apply 中执行 worktree topology migration。
- 不为升级创建另一套 policy compiler、plan schema、审批数据库、receipt 或 rollback executor。
- 不把未知旧 compiler version 猜成 `2.0.0`、最新 major 或当前本地版本。
- 不在第一版增加 MCP transport；CLI 是唯一正式接口，service 层保持可复用。

## 最低验收测试

1. 缺少 `.harness/policy.yaml`：精确返回 `HARNESS_INITIALIZATION_REQUIRED`，零计划。
2. 当前精确版本且候选语义/输出哈希相同：返回 no-op/current，除可能独立生成的 companion workspace plan 外不写 policy plan。
3. 只有 `harness-automation@2` 的 legacy manifest：使用当前 compiler 生成可复现 update plan，并报告旧版本 unknown。
4. 旧 policy 的 owner、profile、stacks、delivery/domain/quality profiles 和 phase 全部继承；调用方没有相应 flags 也不丢失。
5. 当前 compiler 新增规则：diff 报告 added rule，exact-hash apply 后规则进入 policy 和生成输出。
6. 任一 weakening 精确列出 rule IDs；无 fresh matching owner intake 时 apply 被拒绝。
7. 任一 approved source 或 discovery drift：计划文件不产生，并要求重新 intake/discover。
8. TypeScript adoption baseline 只保留或收缩；扩张继续要求 fresh explicit adoption intake。
9. 错误完整哈希、计划篡改、source/intake/discovery/target 漂移均在任何目标写入前失败；中途失败由现有事务回滚且不留半成品。
10. 现有 rollback 恢复更新前 policy、manifest、generated files 与 managed blocks。
11. worktree 显式配置值逐值不变；policy update plan/apply 前后 `git worktree list --porcelain` 集合不变。
12. 必须移动目录的 topology 只报告 migrationRequired 和现有 `worktree migrate` 动作，不移动目录。
13. `doctor` 覆盖 current、stale、legacy-version-unknown、unconfigured，且全程不联网。
14. eval threshold 降低或 known-bad control 移除被列为带 rule IDs 的 weakening，并由 fresh intake 独立批准。
15. harness-automation 本仓库完成真实 update plan → exact-hash apply → check → drift 闭环。
