---
name: harness-automation
description: >
  为主流 AI coding 工程建立跨会话、跨 Agent 的形式化约束与工程连续性。用户说“建立约束体系”“初始化约束”
  “设置 harness”“配置项目规则”“PRD 已定稿/设计已定稿，准备开发”“检查或回滚项目约束”时使用。
---

# Harness Automation

让新会话、不同成员和不同 coding agent 都像同一个清醒工程师继续开发：稳定决策进入仓库策略，能形式化的规则进入可执行检查，不能可靠自动判断的规则明确保留为 review guidance。

## 边界

- 本 Skill 消费 `grill-me` 和设计流程的产物，不修改、包装或替代 `grill-me`。
- PRD 固定为 `docs/PRD.md`；GitHub 轮子调研证据放在 `docs/research/`。
- 默认在 PRD、调研与设计定稿后、开始并行开发前启动。
- 启动本 Skill 的项目负责人是唯一策略批准人。AI 推荐不等于批准。
- CLI 是所有 Agent 可用的基线；MCP 只是可选传输层。

完整流程和交互规则见 [workflow.md](references/workflow.md)。策略语义见 [policy-model.md](references/policy-model.md)。

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

### 2. 确认负责人和定稿状态

只问尚未确认的关键问题，一次一个。必须由负责人明确确认 PRD、设计和调研是本轮开发的批准输入，然后运行：

```bash
node <skill目录>/scripts/run.mjs intake --project <项目绝对路径> --owner <负责人> --approve-sources
```

不得自行添加 `--approve-sources`。上游文件变更后，旧计划自动失效，必须重新 intake。

### 3. 自动发现，不让用户重复填写事实

```bash
node <skill目录>/scripts/run.mjs discover --project <项目绝对路径>
```

先读发现结果中的证据、置信度、命令和冲突。只有无法从仓库或批准文档恢复的高影响决策才询问负责人。

当前正式支持三套 profile：

- `full-typescript`：NestJS + Prisma + tRPC + Next.js。
- `python-data-ai`：Django + Pydantic + PostgreSQL + Celery + React/TS + K8s。
- `go-performance`：Go + sqlc/ent + PostgreSQL + gRPC + K8s + TS 前端。

发现结果为 `custom` 时，解释证据并让负责人选择最接近的 profile 或停止；不得静默猜测。详细边界约定见 [stack-adapters.md](references/stack-adapters.md)。

### 4. 只生成计划

```bash
node <skill目录>/scripts/run.mjs plan --project <项目绝对路径> --profile <profile>
```

向负责人展示：将修改的路径、每个旧/新哈希、建议验证命令、未自动形式化的 guidance 和计划哈希。计划不得安装依赖、运行迁移、修改仓库设置或覆盖既有 CI。

### 5. 精确批准后应用

只有负责人明确批准当前计划哈希后才运行：

```bash
node <skill目录>/scripts/run.mjs apply --project <项目绝对路径> --plan <相对计划路径> --approve <完整计划哈希>
```

不要把“继续”“都可以”解释成对未展示哈希的批准。Apply 会校验计划、PRD/设计/调研、发现快照和每个目标文件的当前哈希；任何漂移都应重新规划。

### 6. 验证真实执行状态

```bash
node <skill目录>/scripts/run.mjs check --project <项目绝对路径> --mode session
node <skill目录>/scripts/run.mjs drift --project <项目绝对路径>
```

分别报告 `configured`、`loaded`、`enforced`、`passing`。写进 Agent 文档不等于 enforced；认知规则必须显示为 `guidance`。失败时展示具体违规和被阻塞的运行时，不要虚报完成。

提交前可用 `--mode commit` 追加格式、lint、类型、Django、Go、Proto 等已发现的快速 gate；CI 用 `--mode ci` 追加测试与构建。命令始终以 argv 执行，缺失工具显示 `blocked`。

需要解释单条规则时运行 `node <skill目录>/scripts/run.mjs explain <policy-id> --project <项目绝对路径>`。

## 新会话协议

每个新会话在修改代码前运行：

```bash
node <skill目录>/scripts/run.mjs context --project <项目绝对路径> --agent <portable|claude-code|codex>
```

然后读取 `.harness/generated/effective-policy.md`，搜索现有实现和所属模块，确认契约源，再开始编码。不同 Agent 的加载能力与降级行为见 [agent-adapters.md](references/agent-adapters.md)。

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
