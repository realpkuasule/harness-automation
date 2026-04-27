# Harness Automation System

[![CI](https://github.com/your-org/harness-automation/actions/workflows/ci.yml/badge.svg)](https://github.com/your-org/harness-automation/actions/workflows/ci.yml)

基于 MCP (Model Context Protocol) 的自动化约束配置工具。通过评估项目规则、生成配置文件、验证配置完整性，帮助项目建立有效的工程约束体系。

## 快速开始

### 作为 Claude Code Skill 使用

在目标项目中运行：

```bash
# 安装 MCP Server 到目标项目
npx harness-automation install --dir /path/to/your-project
```

然后在 Claude Code 中输入触发短语：

> "给我的项目建立约束体系"
> "初始化约束"
> "检查项目约束"

系统会自动执行 11 步工作流：评估适用性 → 断点续做 → 收集项目信息 → 规则评估 → 代码扫描 → 推荐确认 → 配置生成 → 验证 → 回滚（可选）→ A/B 测试（可选）→ 完成。

详细用法见 [Skill 使用指南](./docs/usage-as-claude-code-skill.md)。

### 开发模式

```bash
cd mcp-server
npm install
npm run build   # 编译 TypeScript
npm run dev     # 监听模式
npm run test    # 运行测试
```

## 22 个 MCP 工具

| 工具 | 功能 |
|------|------|
| `assess_suitability` | 评估项目是否适合应用约束体系 |
| `evaluate_rules` | 评估并推荐规则（四问题判定流） |
| `scan_codebase` | 扫描代码库发现违规模式 |
| `generate_config` | 生成配置文件（CLAUDE.md, ESLint, Husky, CI 等） |
| `validate_setup` | 验证配置完整性和语法正确性 |
| `rollback` | 回滚到备份状态 |
| `cognitive_skill` | 认知层技能（诊断 / 教育 / 决策支持） |
| `start_ab_test` | 启动 A/B 测试对比介质效果 |
| ... 共 22 个工具 | 完整列表见 [OpenAPI 规范](./docs/api/openapi.yaml) |

## 架构

```
Skill 层 (CLAUDE.md skill)     ← 用户交互、流程编排
    ↓ MCP 协议调用
MCP 层 (22 个工具)             ← 计算、文件操作
    ├── 决策引擎 (engine.ts)
    ├── 配置生成器 (generators/)
    ├── 代码扫描器 (scanners/)
    ├── 配置验证器 (validators/)
    ├── 规则分析 (analytics/)
    ├── 自适应调整 (adapters/)
    └── 认知层 (cognitive_layer/)
```

两层之间通过 MCP 协议通信，Skill 层负责交互和流程，MCP 层负责纯计算。

## 测试

```bash
cd mcp-server
npm run test          # 运行所有测试
npm run test:coverage # 覆盖率报告
npm run test:ci       # CI 模式
```

## 技术栈

- TypeScript (ES2022, strict mode)
- Node.js >= 18
- @modelcontextprotocol/sdk
- Zod (输入校验)
- Vitest (测试)
- ESLint + typescript-eslint

## 许可证

MIT
