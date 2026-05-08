# Harness Automation System

[![CI](https://github.com/realpkuasule/harness-automation/actions/workflows/ci.yml/badge.svg)](https://github.com/realpkuasule/harness-automation/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@realpkuasule/harness-automation)](https://www.npmjs.com/package/@realpkuasule/harness-automation)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

基于 MCP (Model Context Protocol) 的自动化约束配置工具。通过评估项目规则、生成配置文件、验证配置完整性，帮助项目建立有效的工程约束体系。

---

## 快速开始

### 安装

**方式一：npx 一键安装（推荐）**

```bash
npx @realpkuasule/harness-automation
```

npx 会自动完成：
1. 全局安装包（`npm install -g`）
2. 注册 MCP Server 到 Claude Code（`~/.claude.json`）
3. 安装 Skill 文件（`~/.claude/skills/harness-automation/`）

> 如果全局安装失败（权限问题），请手动运行 `npm install -g @realpkuasule/harness-automation` 后重新执行 npx。

**方式二：从源码安装**

```bash
cd /path/to/harness-automation
./skill/install.sh --dir /path/to/your-project
```

### 使用

安装后重新启动 Claude Code，在项目目录中输入触发短语：

> "给我的项目建立约束体系"

系统会自动执行 11 步工作流：适用性评估 → 规则评估 → 配置生成 → 验证 → 完成。

### 手动配置 MCP Server（可选）

如果安装脚本不可用，也可以通过 Claude Code CLI 注册：

```bash
claude mcp add --scope user harness-automation \
  node /path/to/harness/mcp-server/dist/index.js
```

重新启动 Claude Code 后生效。

## 22 个 MCP 工具

| 工具 | 功能 |
|------|------|
| `assess_suitability` | 评估项目是否适合应用约束体系 |
| `evaluate_rules` | 评估并推荐规则（四问题判定流） |
| `scan_codebase` | 扫描代码库发现违规模式 |
| `generate_config` | 生成配置文件（CLAUDE.md, ESLint, Husky, CI 等） |
| `confirm_decisions` | 确认规则推荐结果 |
| `validate_setup` | 验证配置完整性和语法正确性 |
| `query_state` | 查询当前进度（支持断点续做） |
| `rollback` | 回滚到备份状态 |
| `cognitive_skill` | 认知层技能（诊断 / 教育 / 决策支持） |
| `optimize_error_message` | 错误信息优化和建议 |
| `start_ab_test` | 启动 A/B 测试对比介质效果 |
| `collect_ab_metrics` | 收集 A/B 测试数据 |
| `analyze_ab_results` | 分析 A/B 测试结果 |
| `get_rule_stats` | 规则效果统计 |
| `analyze_rule_adjustments` | 自适应调整建议 |
| `export_rules` / `import_rules` | 规则跨项目复用 |
| `list_rule_presets` / `list_rule_exports` | 预设模板和导出列表 |
| `suggest_error_improvement` | 错误信息模板效果评估 |
| `reset_state` | 重置状态机 |

完整接口定义见 [OpenAPI 规范](./docs/api/openapi.yaml)。

## 架构

```
Skill 层 (CLAUDE.md skill)     ← 用户交互、流程编排
    ↓ MCP 协议调用
MCP 层 (22 个工具)             ← 计算、文件操作
    ├── 决策引擎               规则评估与介质推荐
    ├── 配置生成器             6 种配置文件生成
    ├── 代码扫描器             AST 代码模式检测
    ├── 配置验证器             9 项完整性检查
    ├── 规则分析 + 自适应      效果统计与介质调优
    ├── 认知层                 诊断/教育/决策支持
    └── A/B 测试框架           介质效果对比实验
```

## 内置规则（16 条）

覆盖五大类别：

| 类别 | 规则示例 |
|------|---------|
| **代码质量** | no-console-log, no-debugger, no-explicit-any |
| **架构规范** | prefer-early-return, no-duplicate-code, error-handling |
| **工程流程** | conventional-commits, branch-naming, ci-basics |
| **安全规范** | no-hardcoded-secrets, dependency-audit, input-validation |
| **代码风格** | consistent-imports, naming-conventions, max-complexity |

每条规则通过四问题判定流（是否可形式化 / 代价 / 反馈速度 / 频率）自动推荐最佳实施介质：`linter_error`、`linter_warn`、`claude_md`、`hook`、`ci`、`settings` 等。

## 开发

```bash
cd mcp-server
npm install
npm run build          # 编译 TypeScript
npm run dev            # 监听模式
npm run test           # 运行测试（320+ 用例）
npm run test:coverage  # 覆盖率报告
npm run lint           # ESLint 检查
```

## 文档

- [安装与使用指南](./docs/usage-as-claude-code-skill.md)
- [OpenAPI 接口规范](./docs/api/openapi.yaml)
- [npm 发布准备](./docs/preparing-npm.md)

## 技术栈

- TypeScript (ES2022, strict mode)
- Node.js >= 18
- @modelcontextprotocol/sdk
- Zod（输入校验）
- Vitest（测试）
- ESLint + typescript-eslint

## 许可证

MIT
