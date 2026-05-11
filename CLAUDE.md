# Harness Automation System

## 项目概述

Harness Automation System 是一个基于 MCP (Model Context Protocol) 的自动化约束配置工具。它通过评估项目规则、生成配置文件、验证配置完整性，帮助项目建立有效的约束体系。

## 技术栈

- **TypeScript** (ES2022, strict mode)
- **Node.js** >= 18
- **MCP SDK** (@modelcontextprotocol/sdk ^1.8.0)
- **Zod** (输入校验)
- **Vitest** (测试框架)
- **ESLint + typescript-eslint** (代码规范)

## 协作

- 任务看板: "TASK.json"。
- 变更记录: "CHANGELOG.jsonl"

## 项目管理脚本

```bash
# 任务看板操作 (scripts/task.py)
python3 scripts/task.py summary                 # 按状态/优先级统计
python3 scripts/task.py list [--status pending|completed|in_progress]
python3 scripts/task.py list --phase 6
python3 scripts/task.py show P6-5               # 查看任务详情
python3 scripts/task.py update P6-5 completed   # 更新任务状态

# 变更记录操作 (scripts/changelog.py)
python3 scripts/changelog.py add feat 6 "P6-X: 实现某功能"
python3 scripts/changelog.py add fix 4 "P4-Y: 修复某问题"
python3 scripts/changelog.py list [n]           # 查看最近 n 条
python3 scripts/changelog.py search <keyword>   # 搜索变更
```

## 目录结构

```
mcp-server/
├── src/
│   ├── index.ts              # MCP Server 入口（工具注册、处理）
│   ├── engine.ts             # 决策引擎（四问题判定流）
│   ├── state.ts              # 状态管理（.harness/state.json）
│   ├── types.ts              # 类型定义 + Zod Schema
│   ├── deps.ts               # 依赖管理检查
│   ├── generators/           # 配置生成器
│   │   ├── claude_md.ts      # CLAUDE.md 生成
│   │   ├── eslint.ts         # ESLint 配置生成
│   │   ├── settings_json.ts  # settings.json 生成
│   │   ├── gitignore.ts      # .gitignore 追加
│   │   ├── husky.ts          # Husky hook 生成
│   │   ├── ci.ts             # CI 工作流生成
│   │   └── package_json.ts   # package.json 依赖合并
│   ├── scanners/             # 代码扫描器
│   ├── validators/           # 配置验证器
│   ├── analytics/            # 规则效果统计
│   ├── adapters/             # 自适应调整
│   └── io/                   # 规则导入/导出
├── eslint.config.js          # 项目 ESLint 配置
├── package.json
└── tsconfig.json
```

## 常用命令

```bash
npm run build    # TypeScript 编译
npm run dev      # 开发模式（tsx watch）
npm run lint     # ESLint 检查
npm run test     # 运行测试
npm run test:watch  # 监听模式
npx vitest run --coverage  # 覆盖率报告
```

## 架构原则

1. **Skill + MCP 双层架构**: Skill 负责用户交互和流程引导，MCP 层负责计算和文件操作
2. **工具不直接与用户交互**: MCP 工具不输出交互式问题，所有用户交互在 Skill 层处理
3. **Zod 校验输入**: 所有 MCP 工具输入通过 Zod Schema 校验
4. **状态驱动**: 通过 `.harness/state.json` 持久化状态，支持断点续做
5. **测试覆盖**: 单元测试 + 集成测试，所有模块必须有测试覆盖
