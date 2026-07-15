# Harness Automation

[![CI](https://github.com/realpkuasule/harness-automation/actions/workflows/ci.yml/badge.svg)](https://github.com/realpkuasule/harness-automation/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@realpkuasule/harness-automation)](https://www.npmjs.com/package/@realpkuasule/harness-automation)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

Harness Automation 是面向 AI coding 工程的 repository-native policy compiler。它把已经确认的工程决策编译成跨会话、跨 Agent 的稳定上下文和可执行检查，使新的编码会话像同一个清醒工程师继续工作。

它不追求“生成更多规则文件”，而是保证三件事：

- PRD、设计和技术调研是可追溯、带哈希的策略输入；
- 能形式化的规则由真实检查器执行，不能形式化的规则明确标为 review guidance；
- 所有变更先生成不可变计划，经项目负责人批准精确哈希后才原子应用并可精确回滚。

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

## v2 支持的技术栈

| Profile | 组合 | 命名边界 |
|---|---|---|
| `full-typescript` | NestJS + Prisma + tRPC + Next.js | TS/JSON camelCase；PostgreSQL snake_case；Prisma 显式映射 |
| `python-data-ai` | Django + Pydantic + PostgreSQL + Celery + React/TS + K8s | Python snake_case；JSON/TS camelCase；Pydantic 显式 alias |
| `go-performance` | Go + sqlc/ent + PostgreSQL + gRPC + K8s + TS | Go mixedCaps；Proto/DB snake_case；Proto JSON/TS camelCase |

TypeScript、Python 和 Go 的代码命名由 AST 检查器验证。数据库、RPC、API 和生成代码边界分别保留自己的惯用形式，通过 schema/compiler 显式转换。

## 安装

从 npm：

```bash
npm install -g @realpkuasule/harness-automation
harness-automation install
```

从源码：

```bash
cd mcp-server
npm ci
npm run build
cd ..
./skill/install.sh
```

安装器部署同一份 Skill 到 Claude Code、Codex 和通用 Agent Skill 目录，并为 Claude Code 注册可选 MCP Server。CLI 是所有 Agent 的权威基线。

## 使用

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

# 负责人审阅计划后，使用输出中的完整哈希批准
harness-automation apply --project . \
  --plan .harness/plans/<plan>.json \
  --approve <sha256>

# 验证真实执行状态和漂移
harness-automation check --project . --mode session
harness-automation drift --project .
```

每个新编码会话先运行：

```bash
harness-automation context --project . --agent codex
```

再读取 `.harness/generated/effective-policy.md`，搜索现有实现和所属模块，确认共享契约后开始编码。

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

写入 instruction 文件不等于 enforced。设计判断类规则始终显示为 `guidance`；缺少运行时或适配器时显示为 `blocked`。

## CLI 与 MCP

v2 CLI 命令：`doctor`、`research github`、`intake`、`discover`、`plan`、`apply`、`context`、`check`、`drift`、`explain`、`rollback`。`check --mode commit|ci` 会执行计划中可见的可信项目 gate，缺失运行时明确返回 `blocked`。

MCP 暴露同一 service layer：`harness_doctor`、`harness_intake`、`harness_discover`、`harness_plan`、`harness_apply`、`harness_context`、`harness_check`、`harness_drift`、`harness_rollback` 和 `harness_research_github`。

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

- [Harness Skill v2 设计](docs/design/harness-skill-v2.md)
- [Policy v2 JSON Schema](docs/api/harness-policy-v2.schema.json)
- [Skill](skill/SKILL.md)

## 许可证

MIT
