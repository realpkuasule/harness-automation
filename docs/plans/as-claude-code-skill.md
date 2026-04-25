# Plan: 将 Harness Automation 做成 Claude Code Skill

**Date**: 2026-04-25
**Based on**: `docs/harness-automation-design.md` (§9 Skill 设计, §2 交互流程, §14 认知层)
**Current state**: 22 MCP tools implemented, spec-aligned, 304 tests passing. 126/126 tasks completed.

---

## 1. Goal

将 Harness Automation 从一个 MCP Server 集合升级为**即插即用的 Claude Code 插件/Skill**，使其可以在任意项目的开发过程中被触发调用。

---

## 2. Current State Assessment

| 维度 | 状态 |
|------|------|
| MCP 工具层 (22个) | ✅ 全部实现，与 OpenAPI 完全对齐 |
| 决策引擎 + 规则库 | ✅ 16 条内置规则，四问题判定流 |
| 配置生成器 (6个) | ✅ CLAUDE.md / ESLint / settings.json / .gitignore / Husky / CI |
| 扫描器 + 验证器 | ✅ |
| 认知层 (3 skill types) | ✅ `processCognitiveRequest` 已实现 |
| `shouldAutoTrigger` | ⚠️ 函数存在但**未在任何工具中调用** |
| 错误信息评估 | ⚠️ `ErrorMessageEvaluator` 存在，但缺乏前端触发 |
| **`skill/SKILL.md`** | ❌ **不存在** — 这是最核心的缺失 |
| **安装机制** | ❌ 无法一键安装到其他项目 |
| **Skill 工作流端到端测试** | ❌ 无集成测试覆盖 |
| **用户文档** | ❌ 无如何使用作为 Skill 的文档 |

---

## 3. 工作分解

### Phase 1: Core Skill Layer (P0, 最高优先级)

#### 1.1 创建 `skill/SKILL.md` — Skill 定义文件

**文件**: `skill/SKILL.md` (新建)

这是 Claude Code skill 的核心文件。需要包含：

**Frontmatter**:
- `name: harness-automation`
- `description`: 包含设计 §9.2 的所有触发短语，用 Claude Code 的 trigger matching 机制

**Workflow** (设计 §2.1 + §9.1 的完整 11 步):
- Step 0: 调 `assess_suitability` 评估项目适用性
- Step 1: 调 `query_state` 检查断点续做
- Step 2: AskUserQuestion 收集项目信息 (技术栈/阶段/团队规模)
- Step 3: 调 `evaluate_rules`
- Step 4: AskUserQuestion 是否扫描代码库
- Step 5: 展示推荐，AskUserQuestion 确认/调整
- Step 6: 调 `confirm_decisions`
- Step 7: 调 `generate_config` (先 dry_run 预览)
- Step 8: 调 `validate_setup`
- Step 9: 如有问题，AskUserQuestion + `rollback`
- Step 10: 可选启动 A/B 测试
- Step 11: 完成

**关键设计决策**:
- 在 SKILL.md 中用 Markdown 编写，Claude Code 加载后按步骤执行
- 每个 MCP 调用后检查 errors/warnings，异常时引导用户

**参考**: 设计 §9.1 的 SKILL.md 模板 + §2.1 的 Step 0 (assess_suitability)

#### 1.2 Design §2.2 → MCP enums 映射

**文件**: `skill/SKILL.md` 内联

设计 §2.2 定义的用户面枚举值与实际 MCP 工具期望的值不同，SKILL.md 需要在 AskUserQuestion 后做映射：

| 用户选择 (设计 §2.2) | MCP 实际值 |
|---------------------|-----------|
| techStack: "nextjs-ts" / "react-vite" / "node-ts" / "other" | `["typescript"]` / `["typescript"]` / `["typescript"]` / `["generic"]` |
| projectPhase: "prototype" / "development" / "maintenance" | `"prototype"` / `"early"`\|`"growth"` / `"mature"` |
| teamSize: "1-2人" / "3-5人" / "5人以上" | `"solo"` / `"small"`\|`"medium"` / `"large"` |

**方式**: 在 SKILL.md 中的对应步骤用自然语言写明映射规则，由 Claude 执行时自动翻译。

#### 1.3 断点续做逻辑

**位置**: `skill/SKILL.md` Step 1 的子逻辑

当前 `query_state` 返回 `phase` 字段表示进度。SKILL.md 需按 §9.1 的逻辑决策树跳过已完成步骤：

```
phase == "evaluated"   → 跳过 evaluate_rules，从确认步骤继续
phase == "confirmed"   → 跳过 evaluate_rules + 确认，从 generate_config 继续
phase == "generated"   → 跳过 evaluate_rules + 确认 + generate_config，从 validate 继续
phase == "validated"   → 询问用户是否重新生成或只是检查
phase == null          → 全新开始
```

---

### Phase 2: 安装机制 (P1)

#### 2.1 创建 `skill/install.sh`

**文件**: `skill/install.sh` (新建)

一键安装脚本，功能：
1. 检查目标项目目录是否是 Git 仓库
2. 检查 Claude Code 配置 (`.claude/settings.json` 或 `CLAUDE.md`)
3. 在 `.claude/settings.json` 中添加 MCP server 配置，指向本项目的 MCP server
4. 将 harness 的 rules.json 复制到目标项目的 `.harness/` 目录
5. 输出完成信息

**安装方式示例**:
```bash
# 在目标项目中运行
npx harness-automation init    # 未来方向
# 或
curl -fsSL <url> | bash        # 快速安装
```

当前最简单的方案是 **CLAUDE.md-based 引用**：在目标项目的 `.claude/settings.json` 中添加 MCP server 配置。

#### 2.2 跨项目 MCP Server 配置

**文件**: 待定

目标项目需要在自己的 Claude Code 配置中引用本项目的 MCP server。有两种方式：

**方式 A (推荐)**: 全局安装
- 通过 npm 发布 `harness-automation` 包（当前版本 v1.0.3）
- 目标项目安装 `npm install -g harness-automation`
- `.claude/settings.json` 中配置：
```json
{
  "mcpServers": {
    "harness-automation": {
      "command": "node",
      "args": ["/path/to/harness/mcp-server/dist/index.js"]
    }
  }
}
```

**方式 B**: 本地路径
- 直接引用本项目的 dist/index.js
- 适合开发阶段测试

**计划**: 先实现方式 B (本地路径安装脚本)，后续发布 npm 后默认使用方式 A。

---

### Phase 3: 认知层集成 (P2)

#### 3.1 将 `shouldAutoTrigger` 接入错误报告流程

**文件**: `mcp-server/src/index.ts` (修改)

当前状态：`orchestrator.ts:89` 的 `shouldAutoTrigger` 函数未被任何工具调用。

**方案**: 在 `suggest_error_improvement` 或 `optimize_error_message` 工具中集成：

1. 当 `optimize_error_message` 被调用时，将调用记录写入一个 `.harness/trigger_history.json` 文件
2. `shouldAutoTrigger` 读取该文件，检测重复模式
3. 当检测到重复错误时，在响应中添加 `autoTrigger` 字段，提示 Skill 层调用 `cognitive_skill`

**具体改动**:

`mcp-server/src/index.ts`:
- 在 `optimize_error_message` handler 中，每次调用后记录 trigger entry 到 `.harness/trigger_history.json`
- 在返回结果中添加 `repeatedPattern` 字段（如果 `shouldAutoTrigger` 返回非 null）

`mcp-server/src/cognitive_layer/orchestrator.ts`:
- 可选：添加一个辅助函数 `recordAndCheckTrigger`，合并记录和检测

#### 3.2 错误信息模板数据积累

当前: `ErrorMessageEvaluator` 可以记录和建议，但前端没有调用 `suggest_error_improvement` 的工具

**方案**: SKILL.md 中增加一个可选步骤：
- 在完成初始设置后，询问用户是否要查看错误信息模板效果
- 如果用户同意，调 `suggest_error_improvement` 查看数据

---

### Phase 4: 测试 (P0)

#### 4.1 Skill 工作流集成测试

**文件**: `mcp-server/src/__tests__/skill-workflow.test.ts` (新建)

测试步骤：
1. 创建一个临时 Git 仓库作为目标项目
2. 模拟 AskUserQuestion 的输入收集
3. 依次调用 `assess_suitability` → `evaluate_rules` → `confirm_decisions` → `generate_config` (dry_run) → `validate_setup`
4. 验证 `.harness/state.json` 的内容变化
5. 验证断点续做：重复第 2 步，检查是否跳过已完成步骤

#### 4.2 断点续做测试

**文件**: `mcp-server/src/__tests__/state.test.ts` (追加)

追加测试用例：
1. phase = "confirmed" 时重新运行，验证跳过 evaluated phase
2. phase = "generated" 时重新运行，验证跳过 evaluated + confirmed
3. phase = "validated" 时询问用户

#### 4.3 安装脚本测试

**文件**: `skill/install.test.sh` (新建)

测试：
1. 创建临时项目目录
2. 运行 `skill/install.sh`
3. 验证 `.claude/settings.json` 中添加了 harness-automation 配置

---

### Phase 5: 文档 (P1)

#### 5.1 用户文档

**文件**: `docs/usage-as-claude-code-skill.md` (新建)

内容：
1. 快速开始（一分钟安装）
2. 工作流说明（用户在每个步骤的体验）
3. 触发短语大全
4. 断点续做说明
5. 回滚指南
6. A/B 测试说明
7. 认知层 Skills 说明
8. FAQ

---

## 4. 文件变更清单

| # | 文件 | 操作 | 优先级 | 估算规模 |
|---|------|------|--------|---------|
| 1 | `skill/SKILL.md` | **新建** — Skill 定义，完整的 11 步工作流 | P0 | ~300 行 |
| 2 | `skill/install.sh` | **新建** — 一键安装脚本 | P1 | ~100 行 |
| 3 | `mcp-server/src/index.ts` | **修改** — 接入 `shouldAutoTrigger`，添加 trigger history 记录 | P2 | ~30 行 |
| 4 | `mcp-server/src/cognitive_layer/orchestrator.ts` | **修改** — 添加 `recordAndCheckTrigger` 辅助函数 | P2 | ~20 行 |
| 5 | `mcp-server/src/types.ts` | **修改** — 为 `OptimizeErrorMessageOutput` 添加 `repeatedPattern?` 字段 | P2 | ~10 行 |
| 6 | `mcp-server/src/__tests__/skill-workflow.test.ts` | **新建** — 集成测试 | P0 | ~200 行 |
| 7 | `mcp-server/src/__tests__/state.test.ts` | **修改** — 追加断点续做测试 | P0 | ~50 行 |
| 8 | `skill/install.test.sh` | **新建** — 安装脚本测试 | P1 | ~50 行 |
| 9 | `docs/usage-as-claude-code-skill.md` | **新建** — 用户文档 | P1 | ~200 行 |
| 10 | `package.json` (mcp-server) | **修改** — 添加 `bin` 字段，支持 CLI 安装 | P1 | ~5 行 |

---

## 5. Phase 1 (SKILL.md) 详细设计

### 5.1 Frontmatter

```markdown
---
name: harness-automation
description: 为项目自动建立约束体系。触发词：建立约束体系, 初始化约束, 设置harness, 配置项目约束, setup harness, 给我的项目加规则, 检查项目约束, 回滚约束配置, harness自动化, 配置项目规则
---

# Harness Automation Skill
```

### 5.2 工作流步骤详解

**Step 0: 适用性评估**
```
调 MCP `assess_suitability`({ projectDir, analysisDepth: "quick" })
← 返回 { suitable, score, reason, warnings, recommendations }

if !suitable:
  显示原因和建议，询问是否继续
  if 否 → 结束
```

**Step 1: 断点检查**
```
调 MCP `query_state`({ projectDir })
← 返回 { stateExists, phase, summary, ... }

if phase == "validated":
  询问用户：已完成所有配置。要重新生成还是检查现有配置？
if phase == "generated":
  跳过 Step 2-7，从 Step 8 (validate_setup) 继续
if phase == "confirmed":
  跳过 Step 2-6，从 Step 7 (generate_config) 继续
if phase == "evaluated":
  跳过 Step 2-3，从 Step 4 (scan request) 继续
```

**Step 2: 信息收集 (AskUserQuestion × 1)**
```
收集三项信息：

1. 技术栈:
   - "Next.js + TypeScript"        → ["typescript"]
   - "React + Vite + TypeScript"   → ["typescript"]
   - "Node.js + TypeScript"        → ["typescript"]
   - "Python"                      → ["python"]
   - "Go"                          → ["go"]
   - "Java"                        → ["java"]
   - "其他 / 不确定"               → ["generic"]

2. 项目阶段:
   - "原型期 / 刚起步"             → "prototype"
   - "功能开发期 / 快速增长"       → "early" | "growth"
   - "稳定维护期 / 成熟"           → "mature"

3. 团队规模:
   - "1-2人"                       → "solo"
   - "3-5人"                       → "small"
   - "5-10人"                      → "medium"
   - "10人以上"                    → "large"
```

**Step 3: evaluate_rules**
```
调 MCP `evaluate_rules`({
  projectDir,
  projectPhase,
  teamSize,
  techStack
})
← 返回 { recommendations, conflicts, summary }
```

**Step 4: 扫描代码库 (AskUserQuestion × 1)**
```
询问：是否需要扫描现有代码库发现违规模式？

if 是:
  调 MCP `scan_codebase`({ projectDir, techStack, scanDepth: "full" })
  ← 合并扫描发现到推荐列表
```

**Step 5: 展示推荐 + 确认 (AskUserQuestion × 2)**
```
展示推荐规则列表（含扫描合并结果）
列出每条规则的：ruleName, recommendedMedium, reason

AskUserQuestion:
1. "接受全部推荐规则？" (是/否)
2. 如果否 → "要调整哪些规则？" (逐条列出让用户选择 medium)

调整选项: linter_error / linter_warn / claude_md / ci / hook / settings / none
```

**Step 6: confirm_decisions**
```
调 MCP `confirm_decisions`({ projectDir, decisions })
← 返回 { status, summary }
```

**Step 7: generate_config (先 dry_run 预览)**
```
先调 MCP `generate_config`({
  projectDir,
  decisions: [...],
  dryRun: true
})
← 显示预览（哪些文件将被创建/修改/跳过）

AskUserQuestion: "确认生成这些配置文件？"
if 是:
  调 MCP `generate_config`({
    projectDir,
    decisions: [...],
    dryRun: false
  })
  ← 返回生成结果
```

**Step 8: validate_setup**
```
调 MCP `validate_setup`({ projectDir })
← 返回 { status, errors, warnings, findings }
```

**Step 9: 错误恢复**
```
if validation.status == "fail":
  显示错误列表
  AskUserQuestion: "是否回滚到之前的状态？"
  if 是:
    调 MCP `rollback`({ projectDir })
    ← 回滚完成
```

**Step 10: A/B 测试 (可选)**
```
AskUserQuestion: "是否启动效果评估？可以跟踪规则触发和修复数据。"
if 是:
  引导用户使用 start_ab_test / collect_ab_metrics / analyze_ab_results
```

### 5.3 异常处理

每个 MCP 调用后，SKILL.md 需要写明：
```
检查返回中是否有 errors/warnings
if 发现错误:
  - 判断是否可恢复 (recoverable)
  - 向用户显示错误信息
  - 建议下一步操作
```

---

## 6. 验证清单

### Phase 1: SKILL.md
- [ ] `skill/SKILL.md` 创建，frontmatter 包含所有触发短语
- [ ] 11 步工作流完整，每个步骤描述清晰
- [ ] 断点续做逻辑覆盖 4 种 phase 状态
- [ ] 设计 §2.2 的用户面枚举到 MCP 枚举的映射正确
- [ ] dry_run 预览 + 确认后才实际写入
- [ ] 每个 MCP 调用后检查异常

### Phase 2: 安装机制
- [ ] `skill/install.sh` 在目标项目中添加 MCP server 配置
- [ ] 安装后 Claude Code 能发现 harness-automation 工具
- [ ] 安装脚本处理已有 `.claude/settings.json` 的情况（merge 而非覆盖）

### Phase 3: 认知层
- [ ] `shouldAutoTrigger` 响应中包含重复错误检测
- [ ] 错误信息模板使用记录写入 `.harness/trigger_history.json`
- [ ] 重复检测阈值 (≥2次/最近3条) 合理

### Phase 4: 测试
- [ ] 集成测试覆盖完整工作流
- [ ] 断点续做测试覆盖全部 4 种 phase
- [ ] dry_run 不写文件，二次调用才写
- [ ] `npm run test` 全部通过
- [ ] `npm run build` 编译成功

### Phase 5: 文档
- [ ] `docs/usage-as-claude-code-skill.md` 覆盖安装和使用

---

## 7. 依赖关系

```
Phase 1 (SKILL.md) ─── 无依赖，可立即开始
  │
  ├──→ Phase 2 (安装) ─── 依赖 Phase 1 完成（SKILL.md 需要被安装到目标项目）
  │
  ├──→ Phase 3 (认知层) ─── 无依赖，可与 Phase 1 并行
  │
  ├──→ Phase 4 (测试) ─── 依赖 Phase 1 完成（测试 Skill 工作流）
  │
  └──→ Phase 5 (文档) ─── 依赖 Phase 1-3 全部完成
```

**建议执行顺序**: Phase 1 → Phase 4 (测试 Phase 1) → Phase 2 → Phase 3 → Phase 4 (追加测试) → Phase 5

---

## 8. Morgan Code 集成预研 (Step 2)

当前计划的 Step 1 只关注 Claude Code Skill 化。下一步 (Step 2) 的 Morgan Code 集成需要：

1. **CDD 工作流集成**: 将 `evaluate_rules` 嵌入 Morgan Code 的"约束先行"流程
2. **TDD 约束检查**: 在 TDD 的红-绿-重构循环中自动检查约束违反
3. **模板化规则包**: 为 Morgan Code 预配置规则集

这些不在当前计划范围内，仅作为参考标注。
