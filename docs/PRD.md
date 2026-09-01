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
