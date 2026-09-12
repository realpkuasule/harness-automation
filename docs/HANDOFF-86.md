# HANDOFF 86 — v3 Wave 3: remote coordination, fencing, and transfer

> Seed prompt 见文末；本文件由 harness CLI 校验，非自由文本。
> 各内容段由当前会话 Agent 填充；占位符在 handoff 校验时必须全部消失（SEED 段除外）。

## 目标与验收标准

v3 Wave 3：远端协调、围栏与交接（GitHub Issue #86）。

本 Issue 未配置结构化验收字段。现行验收依据是 `docs/plans/issue-86-remote-coordination-v3.md`：
§6.1 各切片的最小落地顺序、§7 的固定用例组（11 个固定 case ID 及其全部子断言），以及
`mcp-server/src/coordination/qualification_cases.ts` 中的固定断言清单。

子断言只能由原生事实映射，子集不得宣称完整 DG-01；生产启用与 GitHub LIVE 资格另有门禁，
不因任何本机证据而解锁。

## 已完成（附 commit / 回执）

本轮本地 main 从 96402f8 推进到 09e8d5e，共 18 个提交，已推送 origin/main。

工具链基线：
- bc295f1 管理检出恢复干净（入库 4 个遗漏产物、忽略 2 类本地文件、删除仓库根误装残留），
  解除 scripts/verify-protection-faults.mjs 的 PROTECTION_FAULT_SOURCE_NOT_CLEAN 阻塞。
- 2aa1a30 generated-files 漂移归零：按项目自身 profile 重编译，AGENTS.md / CLAUDE.md 的
  负责方文本逐字保留、受管区块复位；编译器版本 2.8.11 到 2.8.19。
- be35b9e 以官方 close 入口关闭已并入 main 的 #86 worktree 与过期租约。
  回执: worktree-close-2026-09-12T06-36-17-623Z-f91e8cb920cd
- c9086f8 与 0a62e53 显式限制 Vitest worker 上限并记录实测特征（修复前默认并发 3/3 失败）。
- 首次补验 npm run build：EXIT 0，含 runtime-manifest 生成。

三处自托管缺陷（92c1f83）：
- plan 未显式指定时静默丢弃已应用的正交 profile，会连带删除整个 evaluations 契约。
- remoteBranchRetentionDays 删除远端分支后，close 永久死锁于 BRANCH_UPSTREAM_REQUIRED。
- close 对任何含 node_modules / dist / __pycache__ 的工作区零豁免，实际不可用；
  新增 --dispose-ignored，由审批者在 exact-hash 计划中声明可弃路径。

Issue #86 bounded-cleanup-authority 全链路：
- 4cdafa3 关闭三个真实缺陷：reserved 相位可释放「目录真实存在」的资源（容量账目错误）；
  mkdir-owned 与 add-started 相位永远无法关闭；分支已缺席却被误报为 BRANCH_DELETE_FAILED。
  六条失败路径同时开始落 retained 事实，此前生产中从未写入过。
- bed86a3 状态词汇补 failed，并加入粘性失败记录原语。
- 760b94b 父进程资源相位接入固定运行器，跑通规范强制的「发布成功后第二个目录创建失败，
  仍可 aborted + 真实停稳 + 已知清理」。
- ea0a772 映射器让 dg01-acquire-contention / bounded-cleanup-authority 由原生事实得出。
- 2aa0772 与 09e8d5e 建立 acquire 争用的清单契约与独立执行配置 local-acquire-contention/1。

证据链耐久性：
- 7695a8d 故障位置从行号钉死改为语义锚点（同类改动此前三次导致位移）。
- ee4ff90 故障运行器补真实 TMPDIR，恢复 local-disposable-drift，用例数 18 到 19。

## 当前状态（跑通什么、依赖什么、密钥位置）

在 09e8d5e 上实跑通过：
- 全量测试 76 文件 / 966 测试通过，EXIT 0，0 unhandled error。
- 保护性故障验证器 19/19 correctly-caught；
  reportSha256 = 238bd03cba492624a4eb4c289ef632753faada7d97d73ebccd7c673443066cde。
- tsc --noEmit 干净；eslint 0 errors / 149 warnings（与基线一致）。
- check --mode commit 返回 ok true 且 workspace verified；drift 返回 clean true。
- npm run build EXIT 0。

依赖与边界：
- 本机 10 核；mcp-server/vitest.config.ts 显式 maxWorkers: 4。
- 故障验证器要求净工作树（git status --porcelain 为空），且在自有临时根下运行，不触碰宿主。
- 发布：npm latest 仍为 2.8.11，本地为 2.8.19，8 个版本未发布；按负责人决定暂缓。
- 凭据：gh 已认证为 realpkuasule（token 前缀 gho_），作用域 gist、read:org、repo、workflow。
  仓库内无明文密钥；凭据经既有 credential broker 与 host binding 解析，不写入 argv、仓库或回执。

## 已知问题与未决项

1. gh 令牌缺 read:project，session handoff 的校验与注册步骤无法执行；session seed 可用。
2. Vitest worker RPC 超时未根除：maxWorkers 4 下 8 次运行中 1 次，且该次伴随同机并发重负载；
   严格空闲 7/7 干净。判定为外部 CPU 竞争，不是套件或单一文件的缺陷。
3. local-acquire-contention/1 可声明但运行器拒绝执行
   （QUALIFICATION_ACQUIRE_EXECUTION_UNSUPPORTED）：争用调度尚未接线。这是有意的 fail-closed，
   运行器宁可拒绝也不静默跑一个不含争用的序列。
4. dg01-* 各用例组中目前只有少数子断言可由运行事实映射，其余仍为 not-run。
5. npm 发布断层（2.8.12 到 2.8.19 未发布）。
6. Wave4 / #87（origin/codex/issue-87-session-prepare，tip 77799b83）按计划 §1 冻结；
   解冻前须先裁决与 main 互斥的 mutation-lock 设计冲突，不是机械 rebase。
7. 本机未安装 harness Skill（~/.claude、~/.codex、~/.agents 下均 missing），属仓库外主机改动。

## 下一步建议（编号列表，供新会话认领）

1. 接线 local-acquire-contention/1 的争用执行，并同步移除第 3 条那道护栏：客户端 worker 增加
   acquire prepare/dispatch（runtime.lifecycle 已可用，same-sha 配置已有跨消息持有 prepared 的先例），
   运行器按「两端各自 prepare 完成后才各 dispatch 一次」调度，屏障等待不持 apply.lock。
2. 复用 recordQualificationSubassertion 映射 dg01-cas 的剩余子断言（dual-acquire-single-winner 等）。
3. 令牌补 read:project 后运行 session handoff，完成本文件的校验与注册。
4. 决定 npm 发布范围（补发最新版或逐版补齐），发布前须跑通 prepublishOnly 全量验证。
5. 按 docs/plans/issue-86-remote-coordination-v3.md §6.1.6 表继续后续切片；LIVE 资格需真实
   公开或私有测试仓库与跨机器受信通道，本地证据不得替代。

## 引用文件（路径列表，新会话必须读）

docs/plans/issue-86-remote-coordination-v3.md
docs/api/coordination-runtime.md
docs/verifications/issue-86-protection-faults.md
docs/design/result-03-harness-v3-feature-contract.md
mcp-server/src/coordination/qualification_cases.ts
mcp-server/src/coordination/manifest.ts
mcp-server/src/coordination/qualification.ts
mcp-server/src/coordination/qualification_remote.ts
mcp-server/src/coordination/github.test.ts
mcp-server/src/coordination/lifecycle-acquire.test.ts
mcp-server/vitest.config.ts
scripts/verify-protection-faults.mjs
CHANGELOG.jsonl

## SEED（由 CLI 确定性生成，勿手改）

【固定前缀块】
项目：harness-automation
仓库：https://github.com/realpkuasule/harness-automation
规则文件：策略与不变量以仓库 skill/SKILL.md 与已存在的 .harness 策略文件为准；缺少 context 或 host binding 不阻断已授权交付。
报告协议：每轮汇报必须包含改了什么（完整路径）、生成物路径、测试/验收结果、遗留问题。

【目标】v3 Wave 3: remote coordination, fencing, and transfer
【现状】已完成见 docs/HANDOFF-86.md；待办与已知问题同上
【验收】（issue 未配置结构化验收字段，见 https://github.com/realpkuasule/harness-automation/issues/86）
【约束】不把 AI 自然语言摘要当作状态事实；进展只认 git 产物 + harness 回执 + issue 字段； 无回执证据不流转 issue 状态；交接文档 SEED 段由 CLI 确定性生成，勿手改。

【第一步】先读 docs/HANDOFF-86.md，恢复已有的 work-item、授权回执、PR、head SHA 与 checks 证据。
输出 3 行当前状态、下一自动步骤和下一不可逆边界；只有授权缺失/失效、deterministic blocker 或证据冲突时才询问人，其他情况直接继续。
完成报告必须包含：改了什么、生成物完整路径、验收结果。


【交付授权】未找到有效授权回执；在执行外部交付动作前先取得一次覆盖完整工作流的授权。
