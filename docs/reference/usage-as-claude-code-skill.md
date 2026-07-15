# Harness Automation Skill 使用指南

Harness Automation Skill 同时面向 Claude Code、Codex 和只能访问仓库文件/命令行的 coding agent。它把批准的工程决策编译为稳定上下文和真实验证器，不再是 Claude 专用规则文件生成器。

## 安装

```bash
cd mcp-server
npm ci
npm run build
cd ..
./skill/install.sh
```

安装结果：

- `~/.claude/skills/harness-automation/`；
- `~/.codex/skills/harness-automation/`；
- Claude Code 可选 MCP 注册；
- 全部 Agent 共用 `harness-automation` CLI。

安装过程不会修改 `grill-me` 或目标项目。项目策略只有在负责人批准具体计划后才应用。

## 触发

可以使用：

- “给我的项目建立约束体系”；
- “PRD 和设计已经定稿，准备开发”；
- “初始化 Harness”；
- “检查项目约束”；
- “回滚 Harness 变更”。

当需求与设计刚刚定稿时，Agent 应询问是否在开发前启动 Harness，但不修改上游需求澄清 Skill。

## 前置产物

```text
docs/PRD.md                  必需
docs/research/*.md|*.json    必需
docs/design/*                推荐
```

缺少研究报告时，可运行：

```bash
harness-automation research github --project . --query "<需求概念>"
```

该命令只生成候选发现证据。最终入选项目仍需检查官方文档、许可证、版本兼容、安全性和集成成本。

## 标准流程

```bash
harness-automation doctor --project .
harness-automation intake --project . --owner <负责人> --approve-sources
harness-automation discover --project .
harness-automation plan --project . --profile <profile>
```

Agent 必须把计划中的路径、旧/新哈希、验证命令、guidance 和完整计划哈希展示给负责人。负责人明确批准该哈希后才能运行：

```bash
harness-automation apply --project . \
  --plan .harness/plans/<plan>.json \
  --approve <完整 SHA-256>

harness-automation check --project . --mode session
harness-automation drift --project .
```

支持的 `<profile>`：

- `full-typescript`；
- `python-data-ai`；
- `go-performance`。

如果自动发现无法匹配，Agent 必须根据仓库证据向负责人澄清，不能静默选择。

## 新会话

每个新会话在改代码前运行：

```bash
harness-automation context --project . --agent <portable|claude-code|codex>
```

然后：

1. 读取 `.harness/generated/effective-policy.md`；
2. 搜索现有实现，避免重复实现；
3. 识别所属模块及共享契约源；
4. 按对应栈的命名边界实现；
5. 完成前运行 `harness-automation check --project . --mode session`；提交前运行 `--mode commit`，CI 使用 `--mode ci`。

## 状态解释

- `configured` 只表示文件存在；
- `loaded` 表示 Agent 能看到当前策略 digest；
- `enforced` 表示检查器通过无效 fixture 自测；
- `passing` 表示当前仓库通过检查；
- `guidance` 是需要 review 的认知规则；
- `blocked` 表示运行时或适配器不可用。

## 回滚

```bash
harness-automation rollback --project .
# 或
harness-automation rollback --project . --change <change-id>
```

如果应用后的文件又被修改，回滚会拒绝覆盖并要求人工处理。它不会删除已恢复的嵌套文件，也不会触碰不属于该 change 的文件。
