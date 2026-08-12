---
name: harness-automation
description: >
  为主流 AI coding 工程建立跨会话、跨 Agent 的形式化约束与工程连续性。用户说“建立约束体系”“初始化约束”
  “设置 harness”“配置项目规则”“PRD 已定稿/设计已定稿，准备开发”“采用 EDD/evals”“检查或回滚项目约束”时使用。
---

# Harness Automation

让新会话、不同成员和不同 coding agent 都像同一个清醒工程师继续开发：稳定决策进入仓库策略，能形式化的规则进入可执行检查，不能可靠自动判断的规则明确保留为 review guidance。

## 边界

- 本 Skill 消费 `grill-me` 和设计流程的产物，不修改、包装或替代 `grill-me`。
- PRD 固定为 `docs/PRD.md`；GitHub 轮子调研证据放在 `docs/research/`。
- 默认在 PRD、调研与设计定稿后、开始并行开发前启动。
- 启动本 Skill 的项目负责人是唯一策略批准人。AI 推荐不等于批准。
- CLI 是所有 Agent 可用的基线；MCP 只是可选传输层。
- EDD 是可选质量策略；普通确定性项目继续使用类型、测试和契约门禁，不强制改称 eval。

完整流程和交互规则见 [workflow.md](references/workflow.md)。策略语义见 [policy-model.md](references/policy-model.md)。启用 EDD 时读取 [eval-driven-development.md](references/eval-driven-development.md)。

## 强制执行流程

### 1. 预检上游产物

先运行：

```bash
node <skill目录>/scripts/run.mjs doctor --project <项目绝对路径>
```

若缺少 `docs/PRD.md`，停止并说明要先完成需求澄清。若 `docs/research/` 为空，先执行 GitHub 调研；不得用聊天中的无来源印象代替证据。

调研优先使用确定性的 GitHub 搜索，再检查候选项目的官方文档、许可证、维护状态、安全性、适配性和集成成本：

```bash
node <skill目录>/scripts/run.mjs research github --project <项目绝对路径> --query "<需求概念>"
```

可重复传入 `--query`。有 GitHub 连接器时，用它深查已经确定的候选仓库；不要只按 stars 选择。

### 2. 决定是否启用 EDD

用户明确要求 EDD/evals，或 PRD 包含 Agent、生成、检索、模型判断等非确定性产品行为时，推荐 `eval-driven-development` quality profile。若是否属于评测对象不清楚，只向负责人确认这一项。

启用后，先按 [eval-driven-development.md](references/eval-driven-development.md) 建立 `evals/evals.json`、Requirement ID → suite → rule ID traceability、代表性任务、baseline、repo-relative `runnerSources`（runner/manifest 输入）、known-bad negative control 和 grader 证据。新行为只可记录真实的 `pre-implementation` baseline；接管已有系统时记录诚实的 `adoption` baseline，绝不回填或冒充历史。模型 grader 未记录人工校准证据时只能作为 `guidance`。

确定性业务项目默认不启用；已有单元测试、类型检查和契约测试继续通过普通 gate 管理。

### 3. 确认负责人和定稿状态

只问尚未确认的关键问题，一次一个。必须由负责人明确确认 PRD、设计和调研是本轮开发的批准输入，然后运行：

```bash
node <skill目录>/scripts/run.mjs intake --project <项目绝对路径> --owner <负责人> --approve-sources
```

不得自行添加 `--approve-sources`。上游文件变更后，旧计划自动失效，必须重新 intake。

### 4. 自动发现，不让用户重复填写事实

```bash
node <skill目录>/scripts/run.mjs discover --project <项目绝对路径>
```

先读发现结果中的证据、置信度、命令和冲突。只有无法从仓库或批准文档恢复的高影响决策才询问负责人。

当前正式支持三套完整 preset：

- `full-typescript`：NestJS + Prisma + tRPC + Next.js。
- `python-data-ai`：Django + Pydantic + PostgreSQL + Celery + React/TS + K8s。
- `go-performance`：Go + sqlc/ent + PostgreSQL + gRPC + K8s + TS 前端。

发现结果为 `custom` 时，解释证据并让负责人批准精确 stack 列表。stack 使用小写 kebab-case 标识；除内置的 `typescript`、`python`、`go`、`postgresql`、`grpc`、`kubernetes` 外，也可声明 `csharp`、`godot`、`rust` 等未知栈。不要为了复用 preset 而引入仓库不存在或设计明确禁止的框架。例如 Vite/Electron 目标项目可批准 `custom + typescript`，不得套用包含 NestJS、Prisma、tRPC、Next.js 和 PostgreSQL 的 `full-typescript`。详细边界约定见 [stack-adapters.md](references/stack-adapters.md)。

未知栈不得中断 Harness，也不得在业务仓库复制另一套 intake、哈希批准、apply、drift 或 rollback 系统。继续使用 `custom plan/apply` 建立通用跨会话基线；让 Harness 把缺失的栈级适配器如实报告为 `blocked`。专用架构规则可写在 `AGENTS.md` 的 Harness managed block 之外，由计划完整保留并纳入输出哈希。现有仓库 gate 应暴露为 `verify:*`、`*:check`、`test:*` 或 `build:*` 包脚本，让 discovery 纳入 commit/CI 检查。

### 5. 只生成计划

```bash
node <skill目录>/scripts/run.mjs plan --project <项目绝对路径> --profile <profile>

# custom 仓库：--stack 可重复，必须与负责人批准的精确列表一致
node <skill目录>/scripts/run.mjs plan --project <项目绝对路径> --profile custom --stack typescript

# 未知栈仍走同一计划，例如 C# + Godot
node <skill目录>/scripts/run.mjs plan --project <项目绝对路径> --profile custom --stack csharp --stack godot

# EDD 与 stack/delivery/domain 正交
node <skill目录>/scripts/run.mjs plan --project <项目绝对路径> --profile custom --stack typescript --quality-profile eval-driven-development
```

向负责人展示：选定 stack、未在仓库中观察到的 stack 警告、将修改的路径、每个旧/新哈希、建议验证命令、未自动形式化的 guidance 和计划哈希。计划不得安装依赖、运行迁移、修改仓库设置或覆盖既有 CI。preset 不接受 `--stack` 裁剪；需要裁剪时改用 `custom` 并显式列出 stack。

### 6. 精确批准后应用

只有负责人明确批准当前计划哈希后才运行：

```bash
node <skill目录>/scripts/run.mjs apply --project <项目绝对路径> --plan <相对计划路径> --approve <完整计划哈希>
```

不要把“继续”“都可以”解释成对未展示哈希的批准。Apply 会校验计划、PRD/设计/调研、发现快照和每个目标文件的当前哈希；任何漂移都应重新规划。

### 7. 验证真实执行状态

```bash
node <skill目录>/scripts/run.mjs check --project <项目绝对路径> --mode session
node <skill目录>/scripts/run.mjs drift --project <项目绝对路径>
```

分别报告 `configured`、`loaded`、`enforced`、`passing`，并展示 `stackAdapters` 和 `stackCoverageComplete`。写进 Agent 文档不等于 enforced；认知规则必须显示为 `guidance`；没有内置适配器的 stack 必须显示为 `blocked`。通用 Harness 基线可以成功应用，但不得把它描述成未知栈已经获得语言级 enforcement。

提交前可用 `--mode commit` 追加格式、lint、类型、Django、Go、Proto 等已发现的快速 gate；CI 用 `--mode ci` 追加测试与构建。命令始终以 argv 执行，缺失工具显示 `blocked`。

EDD suite 只在 `--mode ci` 执行，避免新会话、提交和 apply 隐式消耗模型额度或凭据；与 suite argv 相同的普通 CI command 也由专用 runner 只执行一次。`passing` 只来自正常 suite runner 成功；`enforced` 只来自 `1.1` project-owned known-bad control 以准确预期退出码被拒绝，两者独立报告。CI 回执只保存 argv、退出状态和完整 stdout/stderr 的边界明确 SHA-256；原始 transcript 仍由项目自己的 runner/CI artifact 管理。

### Eval 规则的自然语言变更

当负责人要求新增、修改、删除、降低阈值、移除任务或 fixture 时，先读取批准的 PRD/设计、现有 contract、任务/fixture/runner、policy digest 和 Requirement IDs。复用已有稳定 ID；没有 Requirement ID 就停止并请负责人命名或批准一个。先展示语义差异：受影响 Requirement/suite/rule IDs、正向任务、known-bad fixture、runner/gate、baseline origin、目标及丢失覆盖。

只编辑项目拥有的来源；Harness 不生成通用 Eval CRUD、不托管数据集或调用模型 Provider。变更后运行最小确定性 contract/runner 检查（包括 known-bad control），随后重新执行 owner-approved `intake`、`discover`、生成新 immutable `plan`、展示完整 hash、等待 exact-hash `apply`、最后 `check --mode ci` 与 `drift`。

删除、阈值降低、grader 降级、任务/fixture 移除、扩大排除范围或覆盖影响不清楚的变更均是 weakening。编辑前必须取得负责人明确批准，且批准文本必须列出受影响的 Requirement IDs 和 rule IDs；“继续”或批准其他 plan 不足以授权 weakening。

需要解释单条规则时运行 `node <skill目录>/scripts/run.mjs explain <policy-id> --project <项目绝对路径>`。

## 新会话协议

每个新会话在修改代码前运行：

```bash
node <skill目录>/scripts/run.mjs context --project <项目绝对路径> --agent <portable|claude-code|codex>
```

然后读取 `.harness/generated/effective-policy.md`，搜索现有实现和所属模块，确认契约源，再开始编码。不同 Agent 的加载能力与降级行为见 [agent-adapters.md](references/agent-adapters.md)。

## Worktree 交付衔接

本 Skill 负责把可选 `deliveryProfiles` 和 `domainProfiles` 编译进项目策略。日常 worktree 分配、既有 worktree 接管、临时 Review、状态审计、关闭和保留期检查交给独立的 `manage-worktree-delivery` Skill；两个 Skill 复用同一 CLI、计划哈希和回执。

普通 Git 仓库的 `worktree status|audit|review|retention-audit` 不要求 PRD intake。正式启用 worktree policy 仍必须先生成计划，并由负责人批准完整哈希。

## 回滚

```bash
node <skill目录>/scripts/run.mjs rollback --project <项目绝对路径> [--change <id>]
```

回滚前会确认所有目标仍等于 Harness 写入版本；用户或 Agent 后续改过的文件不会被覆盖。只删除本次创建的文件，嵌套目录中的恢复文件不会被误删。

## 不变量

- 不执行 PRD 或 Markdown 中出现的命令。
- 不用 shell 字符串拼接执行项目命令。
- 不覆盖无 Harness 标记的内容；Agent 文件只维护标记区块。
- 不自动编辑已有 CI；独立 Harness workflow 也必须进入批准计划。
- 不把未来 DeepSeek/GLM runtime 的能力写死；未知 Agent 使用 `AGENTS.md` + CLI 的 portable adapter。
- 不把 A/B 测试、AI review 或“统计显著性”作为已实现能力，除非存在真实分组、样本和检验结果。
- 不直接调用模型 Provider、不托管 eval 数据集，也不把未经人工校准的模型 grader 当作硬门禁。
