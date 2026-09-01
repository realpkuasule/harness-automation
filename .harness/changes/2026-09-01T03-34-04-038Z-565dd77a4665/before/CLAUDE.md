# Harness Automation System

## 项目概述

Harness Automation System 是一个基于 MCP (Model Context Protocol) 的自动化约束配置工具。它通过评估项目规则、生成配置文件、验证配置完整性，帮助项目建立有效的约束体系。

**v1.2.0** 新增：GitLab CI/CD 支持、团队协作模式（MR 模板、AI Code Review、Onboarding）、Gitleaks 密钥扫描、双远程（GitHub + GitLab）支持。支持 23 条内置规则和 6 个预设模板。

## 技术栈

- **TypeScript** (ES2022, strict mode)
- **Node.js** >= 18
- **MCP SDK** (@modelcontextprotocol/sdk ^1.8.0)
- **Zod** (输入校验)
- **Vitest** (测试框架)
- **ESLint + typescript-eslint** (代码规范)

## 协作

- 开发事实源: GitHub Issues + 配置好的 GitHub Project。
- `TASK.json` 仅保留为历史归档，不再新增或更新。
- 变更记录: "CHANGELOG.jsonl"

## 项目管理脚本

```bash
# GitHub Issue / Project 操作 (scripts/github_tracker.py)
python3 scripts/github_tracker.py doctor
python3 scripts/github_tracker.py summary
python3 scripts/github_tracker.py list --state open
python3 scripts/github_tracker.py show 123
python3 scripts/github_tracker.py create --title "标题" --body "描述"
python3 scripts/github_tracker.py status 123 "In Progress"
python3 scripts/github_tracker.py close 123 --comment "Done"

# 变更记录操作 (scripts/changelog.py)
python3 scripts/changelog.py add feat 11 "实现某功能" --issue realpkuasule/harness-automation#123
python3 scripts/changelog.py add fix 11 "修复某问题" --issue realpkuasule/harness-automation#123
python3 scripts/changelog.py list [n]           # 查看最近 n 条
python3 scripts/changelog.py search <keyword>   # 搜索变更
```

GitHub Project 配置文件: `.github/project-workflow.json`

## 目录结构

```
mcp-server/
├── src/
│   ├── index.ts              # MCP Server 入口（工具注册、处理）
│   ├── engine.ts             # 决策引擎（四问题判定流）
│   ├── state.ts              # 状态管理（.harness/state.json）
│   ├── types.ts              # 类型定义 + Zod Schema
│   ├── deps.ts               # 依赖管理检查
│   ├── generators/           # 配置生成器（v1.2.0: 9 → 15 个）
│   │   ├── claude_md.ts      # CLAUDE.md 生成（含 Team Collaboration 章节）
│   │   ├── eslint.ts         # ESLint 配置生成
│   │   ├── settings_json.ts  # settings.json 生成
│   │   ├── gitignore.ts      # .gitignore 追加
│   │   ├── husky.ts          # Husky hook 生成（含 gitleaks + branch check）
│   │   ├── ci.ts             # GitHub Actions CI 生成（支持 gitProvider）
│   │   ├── gitlab_ci.ts      # GitLab CI/CD 生成（NEW: 5 stages + security templates）
│   │   ├── ai_review.ts      # AI Code Review CI job（NEW）
│   │   ├── gitleaks.ts       # Gitleaks .toml + pre-commit hook（NEW）
│   │   ├── gitlab_mr_template.ts  # MR 模板（NEW）
│   │   ├── gitlab_settings.ts     # GitLab 项目设置 script + doc（NEW）
│   │   ├── team_onboarding.ts     # scripts/onboard.sh（NEW）
│   │   ├── package_json.ts   # package.json 依赖合并
│   │   └── scripts_deployment.ts  # legacy task.py / changelog.py 部署
│   ├── scanners/             # 代码扫描器
│   ├── validators/           # 配置验证器
│   ├── analytics/            # 规则效果统计
│   ├── adapters/             # 自适应调整
│   └── io/                   # 规则导入/导出（v1.2.0: 6 presets）
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

## 仓库开发约束

1. 每个非琐碎改动都应绑定 GitHub Issue。
2. Issue 的流程状态由 GitHub Project 管理。
3. `TASK.json` 是只读历史，不再作为当前开发真相源。
4. `CHANGELOG.jsonl` 记录重大变更时优先写入 `issueRef`。

## v1.2.0 团队协作新增

### 新参数（init_harness）

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `gitProvider` | `"github"` \| `"gitlab"` \| `"both"` | `"github"` | Git 平台选择。`"both"` 用于 GitHub + GitLab 双远程 |
| `collaborationMode` | `"solo"` \| `"team"` | `"solo"` | 团队模式启用 MR 模板、onboarding 等。`teamSize ∈ {medium,large}` 时自动为 `"team"` |

### 新规则（R019-R023）

- **R019** branch-naming-convention → hook
- **R020** mr-template-required → claude_md
- **R021** ai-code-review → ci
- **R022** secret-detection → linter_error
- **R023** team-onboarding → settings

### 新 Preset

- `team-gitlab-ts` — TypeScript 团队 + GitLab 完整 Harness 配置（23 条规则）

<!-- harness-automation:v2:start -->
## Harness engineering continuity

Effective policy digest: `18a0a4263ac0d647cac2a08f9dcd784f373b7f61d97143028aec78c4a388e413`

Before editing code in a new session:

1. Run `harness-automation context --project .` and read `.harness/generated/effective-policy.md`.
2. Search for the existing implementation and identify the owning module before adding a new one.
3. Treat shared APIs, RPC, database schemas, queues, and generated code as contracts.
4. Run `harness-automation check --project .` before declaring work complete.
5. Never edit `.harness/generated/**` or this managed block directly.

<!-- harness-automation:v2:end -->
