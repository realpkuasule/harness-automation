# 修复计划 fix-1.0

> 对 Harness 项目进行全面审查后编制的修复计划。
> 基于 `npm run build` 失败和代码审计结果，按 P0→P1→P2 分级。

---

## P0 — 阻断编译（必须立即修复）

### P0-1: `rule_analytics.test.ts` mock 类型缺失

- **确认状态**: `npm run build` 因 TS 编译错误退出码 2（见下文）。
- **文件**: `mcp-server/src/analytics/rule_analytics.test.ts`
- **行号**: 46
- **错误原文**:
  ```
  src/analytics/rule_analytics.test.ts(46,9): error TS2739
  Type '{ linter: number; "claude.md": number; }' is missing the following
  properties from type 'Record<Medium, number>': "settings.json", hook, ci
  ```
- **根因**: `makeState()` 中 `summary.byMedium` 只提供了 `{ linter: 1, "claude.md": 1 }`，但 `Medium` 类型有 5 个值：`"claude.md" | "settings.json" | "linter" | "hook" | "ci"`。`Record<Medium, number>` 要求所有 5 个 key 都存在（`tsconfig.json` 开启了 `strict: true`）。
- **改动内容**: 将第 46 行的 `byMedium: { linter: 1, "claude.md": 1 }` 补齐为：
  ```typescript
  byMedium: { linter: 1, "claude.md": 1, "settings.json": 0, hook: 0, ci: 0 },
  ```
- **验证方法**: `npm run build` 应通过；`npx vitest run src/analytics/rule_analytics.test.ts` 仍通过。
- **来源**: **新发现**（TASK.json 未跟踪此编译错误）

---

## P1 — 功能缺陷（影响正确性）

### P1-1: CI 生成器中 ruleId 匹配永远不命中

- **确认状态**: `generateCiWorkflow()` 用 `d.ruleId === "test-before-merge"` 和 `d.ruleId === "dependency-lock"` 做条件判断。但 `rules.json` 中这两条规则的 `id` 分别是 `"R007"` 和 `"R010"`，`name` 才是 `"test-before-merge"` 和 `"dependency-lock"`。决策引擎输出的 `RuleDecision.ruleId` 等于 `RuleDefinition.id`，所以条件永远为 `false`。
- **文件**: `mcp-server/src/generators/ci.ts`
- **行号**: 58, 65
- **改动内容**: 将两处 `d.ruleId === "test-before-merge"` 改为 `d.ruleName === "test-before-merge"`；`d.ruleId === "dependency-lock"` 改为 `d.ruleName === "dependency-lock"`。
- **验证方法**: 创建一个含有 `R007` 决策的输入调用 `generateCiWorkflow()`，期望输出包含 `"Run tests"` 步骤。单元测试应覆盖此场景。
- **来源**: **新发现**（TASK.json 未跟踪）

### P1-2: settings.json 生成路径错误

- **确认状态**: `generate_config` 和 `init_harness` 都将 settings.json 输出到 `.vscode/settings.json`（VS Code 配置）。但设计文档中 `settings.json` 介质特指 Claude Code 的 `.claude/settings.json`（harness 强制行为）。当前行为导致生成的配置文件对 Claude Code 无效。
- **相关行号**:
  - `mcp-server/src/index.ts:249`：`path: ".vscode/settings.json"`
  - `mcp-server/src/index.ts:419`：`path: ".vscode/settings.json"`
  - `mcp-server/src/index.ts:964`：备份文件列表中的 `".vscode/settings.json"`
  - `mcp-server/src/validators/setup_validator.ts:43`：`MANAGED_FILES` 中的 `".vscode/settings.json"`
  - `mcp-server/src/validators/setup_validator.test.ts:43`：测试文件中的 `.vscode/settings.json`
- **改动内容**: 将所有 `.vscode/settings.json` 改为 `.claude/settings.json`，涉及 5 个文件：
  1. `index.ts:249` — `generate_config` handler 的输出路径
  2. `index.ts:419` — `init_harness` handler 的输出路径
  3. `index.ts:964` — `backupGeneratedFiles` 候选文件列表
  4. `setup_validator.ts:43` — `MANAGED_FILES` 列表
  5. `setup_validator.test.ts:43` — 测试创建的文件路径
- **验证方法**: `npx vitest run` 全部通过；手动调用 `generate_config` 检查输出为 `.claude/settings.json`。
- **来源**: **新发现**（TASK.json 未跟踪）

### P1-3: 缺少集成/E2E 测试

- **确认状态**: 当前 77 个测试全为单元测试（`src/**/*.test.ts`），覆盖单个模块的内部逻辑。没有端到端测试验证 MCP 工具的完整调用流程（如 `evaluate_rules → confirm_decisions → generate_config → validate_setup`）。TASK.json P3-6 描述"创建集成测试套件"但只实现了单元测试。
- **根因**: 缺少一个 `src/__tests__/integration.test.ts` 或 `tests/e2e/` 目录。
- **改动内容**: 创建 `mcp-server/src/__tests__/integration.test.ts`，覆盖：
  - 完整流程：`evaluate_rules → confirm_decisions → generate_config → validate_setup`
  - 工具错误处理：无效输入、缺少依赖状态
  - 多技术栈场景：TypeScript / Python / Go
  - 预期断言：文件生成路径正确、内容非空、状态流转正确
- **验证方法**: `npx vitest run` 包含通过的新集成测试；测试应覆盖至少 3 个完整场景。
- **来源**: **反复出现**（TASK.json P3-6 承诺了集成测试但未交付）

### P1-4: 生成器代码重复

- **确认状态**: `index.ts` 中 `generate_config` handler（行 200-285）和 `init_harness` handler（行 359-499）的文件生成逻辑约 80% 重复。差异仅在于 `init_harness` 额外生成 Husky/CI/package.json 文件。任何生成逻辑变动需同步修改两处。
- **根因**: 代码复用不足，common file generation logic 未被提取为共享函数。
- **改动内容**: 提取一个共享函数 `generateProjectFiles(decisions, projectDir, techStack)` 在文件末尾，返回 `files` 数组。两个 handler 都调用此函数。`init_harness` 额外在返回前合并 Husky/CI/dep info。
- **验证方法**: 重构后所有 77 个测试通过；`generate_config` 和 `init_harness` 的输出应与重构前完全一致（内容不变）。
- **来源**: **新发现**（TASK.json 未跟踪）

### P1-5: 项目自身无 ESLint 配置

- **确认状态**: `package.json` 中定义了 `"lint": "eslint src/"` 脚本，但项目根目录没有 `.eslintrc.*` 或 `eslint.config.*` 文件，运行 `npm run lint` 会失败。
- **改动内容**: 创建 `mcp-server/eslint.config.json`，继承 `@typescript-eslint` 推荐规则，至少包含：`no-explicit-any` warn、`no-console-log` warn、`@typescript-eslint/no-unused-vars` error。
- **验证方法**: `npx eslint src/` 应正常执行（可以有 warnings 但不能 crash）。
- **来源**: **新发现**（TASK.json 未跟踪）

### P1-6: 缺少 `@vitest/coverage-v8` 依赖

- **确认状态**: `vitest.config.ts` 配置了 coverage（provider: "v8"），但 `package.json` 的 `devDependencies` 中未包含 `@vitest/coverage-v8`。运行 `npx vitest run --coverage` 报错 `Cannot find dependency '@vitest/coverage-v8'`。
- **改动内容**: 在 `mcp-server/package.json` 的 `devDependencies` 中添加 `"@vitest/coverage-v8": "^3.0.0"`，然后运行 `npm install`。
- **验证方法**: `npx vitest run --coverage` 输出覆盖率报告。
- **来源**: **新发现**（TASK.json 未跟踪）

---

## P2 — 代码质量与维护

### P2-1: 设计文档版本检查脚本过时

- **确认状态**: `check_design_completeness.py:156` 检查 `**版本**: v2.0`，但设计文档头部的实际版本是 `v3.0`。脚本永远失败。
- **文件**: `check_design_completeness.py`（项目根目录）
- **行号**: 156
- **改动内容**: 将 `v2.0` 改为 `v3.0`（与文档头部一致）。
- **验证方法**: `python3 check_design_completeness.py` 退出码为 0。
- **来源**: **新发现**（TASK.json 未跟踪）

### P2-2: 代码扫描器 `findUntypedAny` 可能误报

- **确认状态**: `code_scanner.ts:120` 中 regex `/:\s*any\b(?!\s*\[)/g` 没有排除注释和字符串上下文，可能匹配：
  - 代码注释中的 `: any`（如 `// type: any`）
  - 字符串字面量中的 `: any`（如 `"key: any"`）
  - 该类误报会降低扫描置信度。
- **文件**: `mcp-server/src/scanners/code_scanner.ts`
- **行号**: 118-127
- **改动内容**: 在 `findUntypedAny()` 中添加行级预处理：跳过以 `//` 开头的行；跳过字符串字面量内的匹配（简单启发式：行内引号内匹配不计数）。
- **验证方法**: 添加测试用例覆盖注释和字符串中的 `: any`，期望不匹配。
- **来源**: **新发现**（TASK.json 未跟踪）

### P2-3: 项目自身无 CLAUDE.md

- **确认状态**: 项目本身（`/Users/zhichao/claude/harness/`）没有 `CLAUDE.md`。作为一个用于生成 `CLAUDE.md` 的工具项目，自身缺少约束文档。
- **改动内容**: 创建 `/Users/zhichao/claude/harness/CLAUDE.md`，包含：
  - 项目概述与技术栈（TypeScript, Node.js, MCP SDK）
  - 目录结构说明
  - 常用命令（`npm run build/test/dev`）
  - 关键架构原则（Skill+MCP 双层架构、工具不直接与用户交互、Zod 校验输入）
- **验证方法**: 文件存在且内容完整。
- **来源**: **新发现**（TASK.json 未跟踪）

### P2-4: 项目自身无 CI/CD

- **确认状态**: 项目没有 `.github/workflows/` 配置。作为一个能为其他项目生成 CI 的工具，自身缺少 CI 保护。
- **改动内容**: 创建 `mcp-server/.github/workflows/ci.yml`，包含：
  - `npm ci` 安装依赖
  - `npx tsc --noEmit` 类型检查
  - `npx vitest run` 测试
  - `npm run build` 构建验证
- **验证方法**: GitHub Actions 在推送时自动运行并通过。
- **来源**: **新发现**（TASK.json 未跟踪）

---

## 汇总

| 分级 | 数量 | 内容 |
|------|------|------|
| P0   | 1    | 编译阻断（mock 类型缺失） |
| P1   | 6    | 功能缺陷：CI ruleId 不命中、settings.json 路径错误、缺少集成测试、代码重复、ESLint 缺失、coverage 依赖缺失 |
| P2   | 4    | 代码质量：设计检查脚本版本、扫描器误报、无 CLAUDE.md、无 CI/CD |
| **总计** | **11** | 其中 10 个为**新发现**，1 个为**反复出现**（集成测试） |

### 修复顺序建议

1. **P0-1** → `npm run build` 恢复
2. **P1-1** → CI 生成器功能修复
3. **P1-2** → settings.json 路径修正
4. **P1-6** → coverage 依赖补充
5. **P1-5** → ESLint 配置
6. **P1-4** → 生成器代码重构
7. **P1-3** → 集成测试
8. **P2-1~P2-4** → 代码质量项（优先级可灵活调整）
