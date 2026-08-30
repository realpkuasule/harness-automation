# Harness Automation

[![CI](https://github.com/realpkuasule/harness-automation/actions/workflows/ci.yml/badge.svg)](https://github.com/realpkuasule/harness-automation/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@realpkuasule/harness-automation)](https://www.npmjs.com/package/@realpkuasule/harness-automation)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[English](README.md)

Harness Automation 是面向 AI coding 工程的 repository-native policy compiler。它把已经确认的工程决策编译成跨会话、跨 Agent 的稳定上下文和可执行检查，使每个新的编码会话像同一个清醒工程师继续工作。

它不追求“生成更多规则文件”，而是保证三件事：

- PRD、设计和技术调研是可追溯、带哈希的策略输入；
- 能形式化的规则由真实检查器执行，不能形式化的规则明确标为 review guidance；
- 所有变更先生成不可变计划，经项目负责人批准精确哈希后才原子应用并可精确回滚。

典型使用场景是项目完成初始化、开始由多人或多个 AI 会话并行开发的第一周。Harness 重点控制三类最常见的失控：

- 不同会话没有先搜索现有实现，重复建设同一能力；
- 接口约定在局部实现中被悄悄改变，调用方和实现方逐渐分叉；
- `camelCase`、`snake_case` 等命名边界因 Agent 理解不同反复返工。

## 适用时机

推荐流程：

```text
需求澄清 / grill-me
  -> docs/PRD.md
  -> GitHub 轮子调研（docs/research/）
  -> PRD 与设计定稿
  -> Harness intake / discover / plan / apply / check
  -> 开始多人、多 Agent 并行开发
```

Harness 不修改或替代 `grill-me`，只消费它和设计流程留下的仓库产物。

## 支持的技术栈

| Profile | 组合 | 命名边界 |
|---|---|---|
| `full-typescript` | NestJS + Prisma + tRPC + Next.js | TS/JSON camelCase；PostgreSQL snake_case；Prisma 显式映射 |
| `python-data-ai` | Django + Pydantic + PostgreSQL + Celery + React/TS + K8s | Python snake_case；JSON/TS camelCase；Pydantic 显式 alias |
| `go-performance` | Go + sqlc/ent + PostgreSQL + gRPC + K8s + TS | Go mixedCaps；Proto/DB snake_case；Proto JSON/TS camelCase |
| `custom` | 由负责人批准精确 stack 标识 | 只编译可用适配器，不继承最接近 preset 的框架 |

TypeScript、Python 和 Go 的代码命名由 AST 检查器验证。数据库、RPC、API 和生成代码边界分别保留自己的惯用形式，通过 schema/compiler 显式转换。

`custom` 接受小写 kebab-case stack 标识。`typescript`、`python`、`go`、`postgresql`、`grpc`、`kubernetes` 有内置适配器；`csharp`、`godot`、`rust` 等未知栈仍可进入完整 plan/apply/check/rollback 闭环，但栈级 enforcement 会如实报告为 `blocked`。例如 `custom + typescript` 不会隐式加入 NestJS、Prisma、tRPC、Next.js 或 PostgreSQL。

## 安装

要求 Node.js 18 或更高版本。安装分为两步：先安装全局 CLI，再把同一份 Skill 和可选 MCP 接入本机 coding agent。

```bash
npm install -g @realpkuasule/harness-automation@latest
harness-automation install
```

验证安装：

```bash
npm list -g @realpkuasule/harness-automation --depth=0
harness-automation help
```

`harness-automation doctor --project .` 还会只读比较当前 CLI 打包的两个 Skill 与 `~/.claude`、`~/.codex`、`~/.agents` 安装副本；显示 `missing`、`stale` 或 `blocked` 时运行 `harness-automation install` 修复，doctor 本身不写入主机目录。

`harness-automation install` 会部署：

- `~/.claude/skills/harness-automation/`；
- `~/.codex/skills/harness-automation/`；
- `~/.agents/skills/harness-automation/`；
- 同位置的 `manage-worktree-delivery/`；
- Claude Code 可选 MCP Server。

安装后新建 coding-agent 会话，让 Agent 重新发现 Skill。CLI 是所有 Agent 的权威基线；即使某个 Agent 尚无专用 MCP，也可以通过仓库文件和 CLI 使用完整流程。

从源码：

```bash
cd mcp-server
npm ci
npm run build
cd ..
./skill/install.sh
```

## 快速开始

准备以下输入：

- `docs/PRD.md`；
- `docs/research/` 中的 GitHub/官方文档调研证据；
- 可选的 `docs/design/` 设计文档。

然后执行：

```bash
# 只读预检
harness-automation doctor --project .

# 缺少调研证据时，执行确定性的 GitHub 候选发现
harness-automation research github --project . --query "<需求概念>"

# 项目负责人确认上游产物已经定稿
harness-automation intake --project . --owner <负责人> --approve-sources

# 自动发现仓库事实和 Agent 能力
harness-automation discover --project .

# 只生成计划，不修改目标文件
harness-automation plan --project . --profile full-typescript

# 无完整 preset 匹配时，由负责人批准精确 stack；--stack 可重复
harness-automation plan --project . --profile custom \
  --stack typescript \
  --stack postgresql

# 没有内置 adapter 的栈不会中断 Harness
harness-automation plan --project . --profile custom \
  --stack csharp \
  --stack godot

# delivery/domain/quality profile 与技术栈正交，可独立追加
harness-automation plan --project . --profile custom \
  --stack csharp \
  --stack godot \
  --delivery-profile worktree-delivery \
  --domain-profile game-development \
  --quality-profile eval-driven-development

# 负责人审阅计划后，使用输出中的完整哈希批准
harness-automation apply --project . \
  --plan .harness/plans/<plan>.json \
  --approve <sha256>

# 验证真实执行状态和漂移
harness-automation check --project . --mode session
harness-automation drift --project .
```

`plan` 的 JSON 输出包含最终 stack、目标文件、变更前后哈希、验证命令、warning 和完整 `planHash`。项目负责人必须审阅这些内容后，才能把该哈希交给 `apply`。

## 会话交接（v2.2.0）

长会话该切就切，恢复成本靠交接物落盘趋近于零。`session` 命令组确定性执行交接、校验、回执与 issue 状态流转，全程无 AI 参与。协议见[会话交接设计](docs/designs/session-handoff.md)与 [session workflow 参考](skill/references/session-workflow.md)。

Issue 状态机：

```text
backlog ──(工作项被认领：worktree 租约存在 + seed 已生成)──▶ in-progress
in-progress ──(handoff 文档落盘 + 校验通过 + 回执)──▶ ready-for-review
ready-for-review ──(accepted-commit 存在)──▶ done
任意状态 ──(仅人可操作)──▶ backlog（reopen）
```

任何自动流转都必须携带证据（commit sha / 回执 id / 检查结果），证据缺失即拒绝流转。

```bash
# 交接：两阶段。文档缺失时只渲染模板骨架（不写 issue、不流转）；
# 填充内容段后再次运行同一命令：校验 → 回执 → issue 更新 → seed。
harness-automation session handoff \
  --project <项目绝对路径> \
  --work-item github:owner/repository#24 \
  --session <当前session-id> \
  [--to-status ready-for-review] \
  [--dry-run]

# 只读状态：issue、看板字段、交接文档校验结果、最近回执
harness-automation session status \
  --project <项目绝对路径> \
  [--work-item github:owner/repository#24]

# 仅渲染 seed prompt（不落盘、不流转，供人工粘贴）
harness-automation session seed \
  --project <项目绝对路径> \
  --work-item github:owner/repository#24
```

- 输出为稳定 JSON；`--dry-run` 全程零写入（含 gh 只读校验），输出不含时间戳、逐字节可复现。
- 交接文档 `docs/HANDOFF-<issue>.md` 由 CLI 校验：必需节齐全、SEED 段外无未填 `{{...}}` 占位符、引用文件路径存在、「已完成」中引用的回执 id 与 harness 回执库一致；失败即拒绝，不留半成品状态。
- 回执写入 `<git-common-dir>/harness/session-handoff/receipts/handoff-<issue>-<docHash12>.json`；id 由文档哈希决定，同文档重跑幂等。
- issue 写入复用既有 `gh` 凭据通道与 `.harness/worktree-delivery.json` 的 provider 映射，不新造凭据机制。
- 阈值、模板引用、字段名与看板状态显示名映射存于 `.harness/session-workflow.yaml`：项目有则用之，无则用包内默认（只读）；该策略变更一律走计划哈希批准流程，CLI 与插件均不得自行改写。

## Eval-driven development

对 Agent、生成、检索或模型判断等非确定性产品行为，可以启用 EDD quality profile。普通确定性项目继续使用现有类型、单元、集成和契约门禁，不必强制启用。

启用前先创建 `evals/evals.json`，记录稳定的 Requirement ID → suite → rule ID 映射、代表性任务、目标、grader、跨栈 argv runner、明确的 repo-relative `runnerSources`（runner/manifest 输入），以及 project-owned known-bad negative control。新行为使用真实 `pre-implementation` baseline；接管已有 eval 系统使用诚实的 `adoption` baseline，绝不回填历史。`1.0` 保持可读：缺失 origin 才报告为 `legacy-unknown`，即使带有新字段也不能声明 enforced；`1.1` 才要求并验证 traceability、baseline origin、runnerSources 和 negative control。格式见 [Eval Contract v1](docs/api/eval-contract-v1.schema.json) 与 [EDD 工作流](skill/references/eval-driven-development.md)。然后重新 intake/discover 并规划：

```bash
harness-automation intake --project . --owner <负责人> --approve-sources
harness-automation discover --project .
harness-automation plan --project . --profile custom \
  --stack typescript \
  --quality-profile eval-driven-development
```

Eval runner 只在 CI mode 执行：

```bash
harness-automation check --project . --mode ci
```

Harness 分别报告 `passing`（正向 suite 成功）与 `enforced`（known-bad control 按预期被拒绝），只有两者都成立才通过 CI；回执仅保存 argv、退出状态和输出 SHA-256。普通确定性测试即使脚本名为 `evals` 仍是普通 gate，Harness 只做 advisory，不会自动启用 EDD。它不直接调用模型 Provider、不保存凭据/原始 transcript，也不允许未经人工校准的模型 grader 成为硬门禁。

## Worktree 交付治理

普通 Git 仓库无需 PRD 或 Provider 即可只读检查：

```bash
harness-automation worktree status --project .
harness-automation worktree audit --project .
harness-automation worktree retention-audit --project .
```

正式启用、分配、接管既有 worktree 和关闭默认只生成计划：

```bash
harness-automation worktree configure \
  --project . \
  --mode enforced \
  --management-branch main \
  --allow-root /absolute/worktree-parent

harness-automation worktree allocate \
  --project . \
  --work-item github:owner/repository#24 \
  --branch issue-24 \
  --path /absolute/worktree-parent/issue-24 \
  --owner <负责人>

harness-automation worktree adopt \
  --project . \
  --manifest /absolute/path/worktree-adopt.json

harness-automation worktree close \
  --project . \
  --work-item github:owner/repository#24 \
  --accepted-commit <sha>
```

这些命令输出的计划都通过统一 `apply --plan ... --approve <sha256>` 执行。新项目默认 2 个持久 worktree、72 小时租约和短生命周期分支：`close` 必须先得到确定性合并证据，再用 SHA compare-and-swap 删除精确的本地与 upstream 功能分支。1 天只读审计会捕捉因任何原因残留的陈旧功能分支并排除 management branch，它不是正常保留期；存量显式配置保持不变。`adopt` 只为 manifest 中已经注册的 worktree 批量创建租约；它接受并哈希锁定 dirty 内容，但不 add/remove worktree、不切换 branch、不改 HEAD/index/工作区文件。任一项漂移或失败都会在写入前停止，或只补偿本次新建租约。`status`、`audit`、保留期审计和 planning 创建零个 worktree。仓库中的 `.harness/worktree-delivery.json` 只保存可移植策略，包括唯一 management checkout 的分支选择器；允许根和保护根写入 Git common dir 的本机绑定。配置计划哈希同时覆盖两者，新机器必须批准自己的本机绑定。

临时 Review 使用 detached HEAD、OS 临时目录且不创建本地 branch：

```bash
harness-automation worktree review --project . --commit <sha> -- npm test
```

clean Review checkout 会立即回收；产生未提交内容时返回 `blocked`，保留精确路径、文件大小、SHA-256、binary patch 摘要和耐久回执。Harness 不会自动 merge；外部完成 merge 后，普通 merge 使用 ancestry 证明，GitHub squash merge 使用精确的 merged PR head/base/SHA 证明，再清理分支。

## 新会话接力

每个新编码会话在修改代码前先运行：

```bash
harness-automation context --project . --agent codex
```

`--agent` 可选 `auto`、`portable`、`claude-code` 或 `codex`。随后：

1. 读取 `.harness/generated/effective-policy.md`；
2. 搜索已有实现，避免重复建设；
3. 确认所属模块、共享契约和命名边界；
4. 完成前运行 `harness-automation check --project . --mode session`；
5. 提交前运行 `--mode commit`，CI 使用 `--mode ci`。

## 安全模型

- `plan` 是默认写入边界，只新增 `.harness/plans/*.json`。
- `apply` 要求完整计划 SHA-256，并重新校验 PRD、设计、调研、发现快照和每个目标文件。
- 写入使用临时文件 + rename；中途失败会恢复已经写过的文件。
- Agent instruction 文件只维护标记区块，区块外内容保持不变。
- 不自动执行 PRD 中的命令，不自动安装依赖、运行迁移、修改仓库设置或覆盖既有 CI。
- 回滚拒绝覆盖应用后又被人或 Agent 修改的文件；只删除本次创建的文件。

## 仓库状态

```text
.harness/
  intake.json                  批准输入及 SHA-256
  discovery.json               仓库事实、证据和能力
  policy.yaml                  唯一策略源（JSON 形式的 YAML 1.2 子集）
  manifest.json                编译器、策略和输出哈希
  plans/                       不可变变更计划
  changes/                     应用与逐文件回滚记录
  sessions/                    本地新会话收据（忽略提交）
  generated/
    effective-policy.md        跨 Agent 有效策略
    check_python_naming.py      Python profile 的 AST gate
    check_go_naming.go          Go profile 的 AST gate
```

`AGENTS.md` 是 portable adapter。发现 Claude Code 时，Harness 也在 `CLAUDE.md` 写入同一策略摘要。未来或未知的 DeepSeek/GLM coding agent 默认使用 `AGENTS.md + CLI`，不会根据品牌名称虚构 hook 或 MCP 能力。

## 验证语义

`harness-automation check` 分开报告：

- `configured`：目标配置存在；
- `loaded`：Agent 能发现当前策略摘要；
- `enforced`：真实检查器能拒绝已知无效 fixture；
- `passing`：当前代码库通过检查。

`stackAdapters` 另外报告每个 stack 的内置适配器覆盖，`stackCoverageComplete` 汇总是否全部覆盖。写入 instruction 文件不等于 enforced。设计判断类规则始终显示为 `guidance`；缺少运行时或适配器时显示为 `blocked`。未知栈的通用 Harness 基线可以成功应用，但不等于该语言已经获得确定性 enforcement。

## CLI 与 MCP

v2 CLI 命令：`doctor`、`research github`、`intake`、`discover`、`plan`、`apply`、`context`、`check`、`drift`、`explain`、`rollback`，以及 `worktree configure|allocate|adopt|review|status|audit|close|retention-audit` 和 `session handoff|status|seed`。`plan` 支持正交的 `deliveryProfile`、`domainProfile` 和 `qualityProfile`。`check --mode commit|ci` 会执行计划中可见的可信项目 gate；EDD runner 只在 CI mode 执行，缺失运行时明确返回 `blocked`。CI 无法观察宿主机 worktree 时会如实报告 workspace enforcement 不可用。

MCP 暴露同一 service layer，包括核心 `harness_*` 工具和对应的 `harness_worktree_*` 工具。CLI 仍是 Claude Code、Codex、DeepSeek/GLM 等 Agent 的 portable 基线。

旧 v1 handler 仍为迁移已有调用保留，但默认不会暴露给 Agent。只有显式设置 `HARNESS_ENABLE_LEGACY_V1=1` 才会在 MCP tool list 中出现；新的 Skill 不使用 `init_harness`、`generate_config`、占位 AI review 或伪 A/B 路径。

## 开发

```bash
cd mcp-server
npm ci
npm run build
npm test
npm run lint
```

设计与正式策略 schema：

- [会话交接设计](docs/designs/session-handoff.md)
- [Harness Skill v2 设计](docs/design/harness-skill-v2.md)
- [Worktree Delivery 设计](docs/design/worktree-delivery.md)
- [Policy v2 JSON Schema](docs/api/harness-policy-v2.schema.json)
- [Eval Contract v1 JSON Schema](docs/api/eval-contract-v1.schema.json)
- [Worktree Delivery v1 JSON Schema](docs/api/worktree-delivery-v1.schema.json)
- [Worktree Host Binding v1 JSON Schema](docs/api/worktree-host-binding-v1.schema.json)
- [Worktree Adopt v1 JSON Schema](docs/api/worktree-adopt-v1.schema.json)
- [Skill](skill/SKILL.md)
- [Worktree Skill](skills/manage-worktree-delivery/SKILL.md)

## 仓库开发机制

这个仓库自身的开发事实源已经从本地 `TASK.json` 切换为 GitHub Issues + GitHub Project。

- 活跃任务追踪：GitHub Issues / GitHub Project
- 历史归档：`TASK.json`
- 变更记录：`CHANGELOG.jsonl`

仓库级工作流命令：

```bash
python3 scripts/github_tracker.py doctor
python3 scripts/github_tracker.py summary
python3 scripts/github_tracker.py list --state open
python3 scripts/github_tracker.py show 123
python3 scripts/github_tracker.py create --title "Title" --body "Details" --priority high
python3 scripts/github_tracker.py status 123 "In Progress"
python3 scripts/github_tracker.py priority 123 critical
python3 scripts/github_tracker.py close 123 --comment "Done"
python3 scripts/changelog.py add feat 11 "Describe change" --issue realpkuasule/harness-automation#123
```

配置文件在 `.github/project-workflow.json`，详细说明见 [GitHub Issue / Project Workflow](docs/development/github-project-workflow.md)。

## 许可证

MIT
