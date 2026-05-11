# Harness Automation System Design

> 基于 Harness Engineering 方法论，将"建立有效约束体系"的四步流程自动化的完整设计。

**版本**: v3.0
**日期**: 2026-04-22

---

## 1. 系统概述

### 1.1 设计目标

将 Harness Engineering 文章中"五种介质 + 四问题判定流"的方法论，转化为一个可自动执行的系统，使用户通过最少的输入获得完整的项目约束体系配置。

### 1.2 核心原则

- **一次收集，自动决策**: 通过一次性问卷收集项目信息，后续全自动
- **默认有据**: 所有默认决策基于工程最佳实践，标注依据来源
- **可覆盖**: 用户可逐条调整默认决策
- **渐进增强**: 从最小可行开始，支持逐步扩展
- **安全优先**: 写文件前自动备份，支持回滚

### 1.3 架构概览

采用 **Skill + MCP Server** 双层架构，核心原则：**MCP Tool 不直接与用户交互**。

```
┌─────────────────────────────────────────────────┐
│ Skill 层（工作流引导 + 用户交互）                   │
│                                                   │
│   AskUserQuestion 收集项目信息                     │
│   → 调 MCP evaluate_rules()                       │
│   → AskUserQuestion 确认/调整推荐                   │
│   → 调 MCP generate_config()                      │
│   → 调 MCP validate_setup()                       │
│   → 如有问题，调 MCP rollback()                    │
└──────────────────────┬──────────────────────────┘
                       │ 调 MCP Tool
                       ▼
┌─────────────────────────────────────────────────┐
│ MCP Server 层（纯计算 + 文件操作，无用户交互）       │
│                                                   │
│   evaluate_rules    → 纯计算，返回推荐列表            │
│   scan_codebase     → 纯分析，返回扫描发现            │
│   generate_config   → 纯生成，写文件                  │
│   validate_setup    → 纯检查，返回验证结果             │
│   rollback          → 纯操作，恢复到之前状态           │
│   confirm_decisions → 纯存储，持久化用户确认结果       │
│   init_harness      → 快捷入口（仅 preset 模式）       │
│   query_state       → 纯读取，查询当前状态             │
└─────────────────────────────────────────────────┘
```

#### Skill 与 MCP 职责边界

| 职责 | Skill 层 | MCP 层 |
|------|----------|--------|
| 与用户对话（AskUserQuestion） | ✅ | ❌ |
| 规则决策计算 | ❌ | ✅ |
| 代码扫描 | ❌ | ✅ |
| 配置文件生成 | ❌ | ✅ |
| 文件读写 | ❌ | ✅ |
| 工作流编排 | ✅ | ❌ |
| 错误恢复引导 | ✅ | ✅ (执行) |
| 状态管理 | ❌ | ✅ (存储) |


## 2. 用户交互流程

### 2.1 完整流程

```
用户: "给我的项目建立约束体系"
  │
  ├─ Skill 被触发，加载工作流
  │
  ├─ Step 0: Skill → MCP assess_suitability() 评估项目适用性
  │   ├─ 适合应用 harness → 继续
  │   ├─ 不适合（原型/一次性脚本）→ 提供轻量建议，结束
  │   └─ 有限制条件 → 调整推荐强度，继续
  │
  ├─ Step 1: Skill → MCP query_state() 检查断点续做
  │   ├─ 已有进行中状态 → 跳过已完成的步骤
  │   └─ 无状态 → 继续
  │
  ├─ Step 2: Skill 收集项目信息（AskUserQuestion × 1）
  │   ├─ 技术栈 (Next.js+TS / React+Vite / Node+TS / 其他)
  │   ├─ 项目阶段 (原型期 / 功能开发期 / 稳定维护期)
  │   └─ 团队规模 (1-2人 / 3-5人 / 5人以上)
  │
  ├─ Step 3: Skill → MCP evaluate_rules(projectParams)
  │   ├─ 加载规则数据库，按技术栈过滤
  │   ├─ 应用四问题判定流
  │   ├─ 冲突检测
  │   ├─ 写入 .harness/state.json
  │   └─ 返回推荐配置清单
  │
  ├─ Step 4: Skill 询问是否需要扫描代码库（AskUserQuestion × 1）
  │   ├─ 是 → MCP scan_codebase()，合并扫描发现到推荐列表
  │   └─ 否 → 跳过
  │
  ├─ Step 5: Skill 展示推荐（含扫描合并结果）+ 用户确认（AskUserQuestion × 2）
  │   ├─ 用户确认全部接受
  │   └─ 或逐条调整（override medium / 禁用某条规则）
  │
  ├─ Step 6: Skill → MCP confirm_decisions(decisions)
  │   ├─ 写入 .harness/state.json，phase → confirmed
  │   └─ 返回确认摘要
  │
  ├─ Step 7: Skill → MCP generate_config(dryRun?)
  │   ├─ 备份现有文件 → .harness/backups/
  │   ├─ 生成 CLAUDE.md / ESLint / settings.json / Husky / CI / package.json
  │   ├─ 更新 .harness/state.json
  │   └─ 返回生成摘要
  │
  ├─ Step 8: Skill → MCP validate_setup()
  │   ├─ 验证文件完整性
  │   └─ 运行安装检查
  │
  ├─ Step 9: 如验证失败 → Skill 询问 → MCP rollback()
  │
  ├─ Step 10: Skill → MCP start_ab_test() 启动效果评估（可选）
  │   ├─ 收集规则触发数据
  │   ├─ 分析修复率和绕过率
  │   └─ 提供优化建议
  │
  └─ 完成
```

### 2.2 信息收集设计

采用"声明式配置收集"模式，一次问完所有问题：

```typescript
interface ProjectInput {
  projectName: string;
  techStack: 'nextjs-ts' | 'react-vite' | 'node-ts' | 'other';
  projectPhase: 'prototype' | 'development' | 'maintenance';
  teamSize: '1-2' | '3-5' | '5+';
  customRules?: string[];
  overrideDecisions?: RuleOverride[];
}

interface RuleOverride {
  ruleId: string;
  medium: 'linter_error' | 'linter_warn' | 'linter+hook' | 'claude_md' | 'ci' | 'hook' | 'settings' | 'none';
}
```

> **注意**: 当 `techStack` 为 `other` 时，规则数据库仅返回 `appliesTo: 'all'` 的通用规则（约 9 条）。这是因为内置规则主要针对 TS 技术栈优化。选择 `other` 的用户应通过 `scan_codebase` 发现项目特有规则，或手动添加自定义规则。


## 3. MCP Server 设计

### 3.1 工具接口定义

#### 3.1.1 `evaluate_rules`

纯计算工具。输入项目参数，输出规则推荐列表。结果写入状态文件，不直接与用户交互。

```typescript
interface EvaluateRulesInput {
  projectDir: string;          // 用于定位 .harness/state.json
  techStack: string;
  projectPhase: string;
  teamSize: string;
}

interface EvaluateRulesOutput {
  recommendations: RuleRecommendation[];
  conflicts: RuleConflict[];
  summary: {
    totalRules: number;
    byMedium: Record<string, number>;
  };
}

interface RuleRecommendation {
  ruleId: string;
  ruleName: string;
  description: string;
  category: string;
  formalizable: boolean | 'partial';
  adjustedCost: 'critical' | 'high' | 'medium' | 'low';  // 引擎调整后的代价（区别于 RuleDefinition.baseCost）
  feedbackSpeed: 'immediate' | 'commit' | 'pr';
  adjustedFrequency: 'high' | 'medium' | 'low';           // 引擎调整后的频率（区别于 RuleDefinition.baseFrequency）
  recommendedMedium: string;
  reason: string;
  evidence: string;
  errorMessage: {
    why: string;
    whatInstead: string;
    reference: string;
  };
  autoFixable: boolean;
  requiredPackages: string[];
}

interface RuleConflict {
  ruleA: string;
  ruleB: string;
  type: 'direct_conflict' | 'redundant' | 'needs_refinement';
  resolution: string;
}
```

**行为**:
1. 从规则数据库中加载所有规则
2. 按 `techStack` 过滤（只保留 appliesTo 包含当前技术栈的规则）
3. 对每条规则执行四问题判定流
4. 运行冲突检测
5. 将结果写入 `.harness/state.json`，状态 → `evaluated`
6. 返回推荐列表

#### 3.1.2 `scan_codebase`

```typescript
interface ScanCodebaseInput {
  projectDir: string;
  scanDepth?: 'quick' | 'full';
}

interface ScanCodebaseOutput {
  findings: ScanFinding[];
  existingRules: ExtractedRule[];
  suggestedRules: RuleSuggestion[];
}

interface ScanFinding {
  pattern: string;
  occurrences: number;
  fileExamples: string[];
  suggestedRuleId: string;
  severity: 'error' | 'warn' | 'info';
}

interface ExtractedRule {
  source: string;              // 文件路径
  content: string;             // 原始内容
  matchedRuleId?: string;      // 匹配到的内置规则
}

interface RuleSuggestion {
  ruleId: string;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}
```

**行为**:
- `quick` 模式：只扫描最近修改的文件和关键配置文件
- `full` 模式：全项目扫描
- 扫描结果合并到 `.harness/state.json`

**扫描结果合并规则**:
```
suggestedRules 与 recommendations 的合并逻辑：

1. 匹配：suggestedRules[i].ruleId === recommendations[j].ruleId
   → 已存在，保留 recommendations 的 medium，不做更改

2. 新增：suggestedRules[i].ruleId 不在 recommendations 中
   → 追加到推荐列表末尾，标记为 confidence 来源

3. 冲突：suggestedRules 建议的 medium 与 recommendations 不同
   → 记录为 info 级别的 conflict，用户确认时可见

Skill 层在展示推荐前调用此工具，合并后的完整列表再展示给用户。
```

#### 3.1.3 `generate_config`

```typescript
interface GenerateConfigInput {
  projectDir: string;
  decisions: RuleDecision[];           // 用户确认后的最终决策
  dryRun?: boolean;                    // true = 只预览，不写文件
}

interface RuleDecision {
  ruleId: string;
  medium: 'linter_error' | 'linter_warn' | 'linter+hook' | 'claude_md' | 'ci' | 'hook' | 'settings' | 'none';
  description?: string;                  // 用于生成 CLAUDE.md 内容
  eslintRule?: string;                   // ESLint 规则名（如 "@typescript-eslint/no-explicit-any"）
  eslintOptions?: any;                   // ESLint 规则配置
  eslintPlugins?: string[];               // 所需 ESLint 插件列表
  requiredPackages?: string[];           // 所需 npm 包
}

interface GenerateConfigOutput {
  files: ConfigFileResult[];
  summary: ConfigSummary;
  errors: ConfigError[];
  warnings: string[];
}

interface ConfigFileResult {
  path: string;
  action: 'created' | 'overwritten' | 'skipped' | 'merged' | 'dry_run';
  backupPath?: string;                 // 备份路径（如有）
  content?: string;                    // dry_run 模式时返回生成的内容预览
}

interface ConfigError {
  file: string;
  code: string;
  message: string;
}

interface ConfigSummary {
  totalRules: number;
  byMedium: Record<string, number>;
  generatedFiles: number;
  warnings: number;
  errors: number;
}
```

**行为**:
1. `dryRun=true` 时：只计算要写的文件内容，不执行任何写操作
2. 非 dry-run 模式：
   - 对每个目标文件，检查是否已存在
   - 如果存在，先备份到 `.harness/backups/`
   - 根据 `action` 策略执行写操作
   - 更新 `.harness/state.json`，状态 → `generated`
3. 遇到错误不中断，收集所有错误后一起返回

#### 3.1.4 `validate_setup`

```typescript
interface ValidateSetupInput {
  projectDir: string;
}

interface ValidateSetupOutput {
  status: 'pass' | 'warn' | 'fail';
  checks: ValidationCheck[];
  nextSteps: string[];
}

interface ValidationCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
  fixCommand?: string;
}
```

**检查项**:
- 所有声明要生成的文件是否存在
- ESLint 配置语法是否合法（`eslint --print-config`）
- JSON 文件语法是否合法
- Husky hooks 是否可执行
- 依赖包是否已安装

#### 3.1.5 `rollback`

```typescript
interface RollbackInput {
  projectDir: string;
  target?: 'last' | 'all';            // last = 只回滚最后一次，all = 全部
}

interface RollbackOutput {
  status: 'success' | 'partial' | 'failed';
  restored: string[];                  // 恢复的文件列表
  failed: string[];                    // 恢复失败的文件列表
  errors: string[];
}
```

**行为**:
1. 读取 `.harness/backups/` 中的备份文件
2. 逐个恢复原始文件
3. 删除 `generate_config` 生成的新文件
4. 更新 `.harness/state.json`，状态 → `evaluated`
5. 返回恢复结果

#### 3.1.6 `confirm_decisions`

用户确认/调整推荐后，将最终决策写入状态文件并推进状态机。Skill 层调用此工具来持久化用户的确认结果。

```typescript
interface ConfirmDecisionsInput {
  projectDir: string;
  decisions: RuleDecision[];
}

interface ConfirmDecisionsOutput {
  status: 'confirmed';
  summary: {
    totalRules: number;
    byMedium: Record<string, number>;
  };
}
```

**行为**:
1. 读取 `.harness/state.json`，验证 phase 为 `evaluated`、`confirmed`、`generated` 或 `validated`
2. 写入 `state.decisions = decisions`
3. 更新 `state.phase → 'confirmed'`
4. 更新 `state.confirmedAt = now`
5. 返回确认摘要

#### 3.1.7 `init_harness`（快捷入口）

当用户已经有明确的配置方案时，跳过交互直接执行完整流程。

```typescript
interface InitHarnessInput {
  projectDir: string;
  preset: {
    techStack: string;
    projectPhase: string;
    teamSize: string;
  };
}

interface InitHarnessOutput {
  recommendations: RuleRecommendation[];
  configs: GenerateConfigOutput;
  validation: ValidateSetupOutput;
}
```

**行为**:
1. 内部依次调用 `evaluate_rules` → 自动将 recommendations 转为 decisions（使用推荐介质，不调整） → `confirm_decisions` → `generate_config` → `validate_setup`
2. 不产生任何用户交互
3. 适用于：二次运行、CI 环境、有经验的用户

#### 3.1.8 `query_state`（状态查询）

查询当前项目已保存的 Harness 状态，用于断点续做或查看配置摘要。

```typescript
interface QueryStateInput {
  projectDir: string;
}

interface QueryStateOutput {
  stateExists: boolean;
  phase: HarnessState['phase'] | null;
  project?: {
    techStack: string;
    projectPhase: string;
    teamSize: string;
  };
  summary?: {
    totalRules: number;
    byMedium: Record<string, number>;
    generatedFiles: number;
    validatedAt?: string;
  };
}
```

**行为**:
1. 检查 `.harness/state.json` 是否存在
2. 如果存在，解析并返回当前阶段和摘要
3. 如果不存在，返回 `{ stateExists: false, phase: null }`
4. 纯读取操作，不修改任何文件

#### 3.1.9 `assess_suitability`（适用性评估）

评估项目是否适合应用 harness。在流程开始时调用，避免在不适合的场景（如原型阶段、一次性脚本）中过度约束。

```typescript
interface AssessSuitabilityInput {
  projectDir: string;
  analysisDepth?: 'quick' | 'full';
}

interface AssessSuitabilityOutput {
  suitable: boolean;
  reason: string;
  warnings: SuitabilityWarning[];
  recommendations: string[];
}

interface SuitabilityWarning {
  type: 'prototype' | 'one_off_script' | 'high_maintenance_cost' | 'low_roi';
  severity: 'high' | 'medium' | 'low';
  message: string;
  evidence: string[];
}
```

**评估标准**:
1. **原型阶段检测**：
   - git 历史少于 10 个提交
   - 文件数量少于 20 个
   - 依赖数量少于 5 个
   - 频繁的文件结构变化

2. **一次性脚本识别**：
   - 单个入口文件
   - 无测试文件
   - 无 package.json 或极简配置
   - 无版本控制或简单提交历史

3. **维护成本评估**：
   - 团队规模 vs 规则数量比例
   - 项目阶段（早期 vs 成熟期）
   - 预期生命周期

**行为**:
1. `quick` 模式：仅检查 git 历史和文件结构
2. `full` 模式：完整分析，包括依赖分析和代码复杂度
3. 如果不适合应用 harness，提供轻量级替代建议
4. 如果适合但有限制，在后续决策中调整推荐强度

#### 3.1.10 `start_ab_test`（启动 A/B 测试）

为特定规则启动 A/B 测试，验证规则效果。用户可选择测试新规则或调整现有规则的介质。

```typescript
interface StartABTestInput {
  projectDir: string;
  testConfig: ABTestConfig;
}

interface ABTestConfig {
  ruleId: string;
  baselineMedium: string;      // 当前或对照组的介质
  testMedium: string;         // 测试组的介质
  durationDays: number;       // 测试持续时间（1-30天）
  metrics: ABTestMetric[];    // 要收集的指标
  targetUsers?: string[];     // 目标用户（如特定团队成员）
}

interface ABTestMetric {
  name: 'trigger_count' | 'fix_rate' | 'bypass_count' | 'user_feedback' | 'time_to_fix';
  weight: number;             // 指标权重（0-1）
}

interface StartABTestOutput {
  testId: string;
  status: 'started' | 'already_running' | 'invalid_config';
  startTime: string;
  endTime: string;
  trackingUrl?: string;       // 监控面板 URL（如有）
}
```

**行为**:
1. 验证规则存在且配置有效
2. 检查是否已有相同规则的测试在进行中
3. 创建测试记录到 `.harness/ab_tests.json`
4. 为测试组生成临时配置（不影响主配置）
5. 返回测试 ID 和监控信息

#### 3.1.11 `collect_ab_metrics`（收集 A/B 测试数据）

收集 A/B 测试期间的指标数据。可手动调用或由 CI 定期触发。

```typescript
interface CollectABMetricsInput {
  projectDir: string;
  testId: string;
  timeRange?: {
    start: string;
    end: string;
  };
}

interface CollectABMetricsOutput {
  testId: string;
  status: 'collecting' | 'completed' | 'paused';
  metrics: ABTestDataPoint[];
  summary: {
    baseline: ABTestSummary;
    test: ABTestSummary;
    difference: {
      absolute: number;
      relative: number;
      confidence: number;
    };
  };
}

interface ABTestDataPoint {
  timestamp: string;
  group: 'baseline' | 'test';
  metric: string;
  value: number;
  context?: Record<string, any>;
}

interface ABTestSummary {
  triggerCount: number;
  fixRate: number;           // 触发后修复的比例
  bypassCount: number;       // 绕过规则的比例
  avgTimeToFix?: number;     // 平均修复时间（分钟）
  userFeedbackScore?: number; // 用户反馈评分（1-5）
}
```

**行为**:
1. 从 git 历史、CI 日志、用户反馈等来源收集数据
2. 按测试组（baseline/test）分类统计
3. 计算关键指标和差异
4. 更新测试记录状态

#### 3.1.12 `analyze_ab_results`（分析 A/B 测试结果）

分析收集到的 A/B 测试数据，提供统计显著性检验和优化建议。

```typescript
interface AnalyzeABResultsInput {
  projectDir: string;
  testId: string;
  significanceLevel?: number;  // 默认 0.05
}

interface AnalyzeABResultsOutput {
  testId: string;
  analysis: {
    statisticalSignificance: boolean;
    pValue: number;
    effectSize: number;
    confidenceInterval: [number, number];
  };
  recommendation: {
    action: 'keep' | 'revert' | 'adjust' | 'extend_test';
    confidence: 'high' | 'medium' | 'low';
    reason: string;
    suggestedAdjustments?: RuleAdjustment[];
  };
  insights: string[];
  limitations: string[];
}

interface RuleAdjustment {
  ruleId: string;
  field: 'medium' | 'severity' | 'errorMessage' | 'autoFix';
  from: any;
  to: any;
  reason: string;
}
```

**行为**:
1. 对关键指标进行统计检验（t-test、chi-square 等）
2. 评估实际效果大小
3. 考虑业务上下文和用户反馈
4. 生成优化建议和调整方案

#### 3.1.13 `recommend_rule_adjustment`（规则调整推荐）

基于 A/B 测试结果或使用数据分析，推荐规则调整方案。

```typescript
interface RecommendRuleAdjustmentInput {
  projectDir: string;
  ruleId: string;
  dataSource: 'ab_test' | 'usage_analytics' | 'user_feedback';
  timeRange?: {
    start: string;
    end: string;
  };
}

interface RecommendRuleAdjustmentOutput {
  ruleId: string;
  currentConfig: RuleDecision;
  recommendations: RuleAdjustmentRecommendation[];
  evidence: {
    dataPoints: number;
    timePeriod: string;
    confidence: 'high' | 'medium' | 'low';
  };
}

interface RuleAdjustmentRecommendation {
  priority: 'high' | 'medium' | 'low';
  adjustment: RuleAdjustment;
  expectedImpact: {
    fixRateChange: number;      // 预期修复率变化（百分比）
    bypassRateChange: number;   // 预期绕过率变化
    userSatisfactionChange: number; // 预期用户满意度变化（1-5分）
  };
  implementationCost: 'low' | 'medium' | 'high';
}
```

**行为**:
1. 分析规则的历史表现数据
2. 识别优化机会（介质调整、错误信息改进等）
3. 评估预期收益和实施成本
4. 提供优先级排序的调整建议


## 4. 状态管理

### 4.1 状态文件

所有工具共享同一个状态文件 `.harness/state.json`：

```typescript
interface HarnessState {
  version: 1;
  projectDir: string;
  
  // 状态机
  phase: null | 'evaluated' | 'confirmed' | 'generated' | 'validated';
  
  // 项目参数
  project: {
    techStack: string;
    projectPhase: string;
    teamSize: string;
  };
  
  // 决策结果
  recommendations: RuleRecommendation[];
  conflicts: RuleConflict[];
  
  // 用户确认/调整
  decisions: RuleDecision[];
  confirmedAt?: string;
  validatedAt?: string;
  
  // 生成记录（用于回滚）
  generationLog: GenerationRecord[];
  
  // 验证结果
  validation?: ValidateSetupOutput;
  
  // 元数据
  createdAt: string;
  updatedAt: string;
  sessionId: string;
}

interface GenerationRecord {
  timestamp: string;
  action: 'generate' | 'rollback';
  files: {
    path: string;
    action: 'create' | 'overwrite' | 'merge' | 'skip';
    backupPath?: string;
  }[];
}
```

### 4.2 状态机

```
null ──→ evaluated ──→ confirmed ──→ generated ──→ validated
  │         │              │              │
  │         │              │              ├──→ validated (成功)
  │         │              │              └──→ evaluated (回滚)
  │         │              │
  │         │              ├── evaluate_rules (重新评估)
  │         │              └── confirm_decisions (推进到 confirmed)
  │         │
  │         └── generate_config (直接使用默认推荐)
  │
  └── init_harness (快捷入口，跳过所有交互步骤)
```

**阶段顺序**: `null(0) → evaluated(1) → confirmed(2) → generated(3) → validated(4)`
在实现中通过数值索引比较阶段先后，文档中用集合表达式表示，如 `phase in {confirmed, generated, validated}` 表示"处于 confirmed 阶段或之后"。

### 4.3 断点续做

- 如果 phase 为 `evaluated`、`confirmed`、`generated` 或 `validated`，跳过 `evaluate_rules`
- 如果 phase 为 `generated` 或 `validated`，跳过 `generate_config`
- 如果 phase 为 `validated`，提示用户是否要重新生成
- 状态文件本身不纳入 git 版本控制（`.gitignore` 中忽略 `.harness/`）

## 5. 错误处理

### 5.1 错误码定义

```typescript
interface MCPError {
  code: ErrorCode;
  message: string;
  detail?: string;
  recoverable: boolean;        // 用户能否自行恢复
}

type ErrorCode =
  | 'STATE_NOT_FOUND'          // 缺少 .harness/state.json
  | 'STATE_PHASE_MISMATCH'     // 状态机阶段不匹配
  | 'FILE_READ_ERROR'          // 文件读取失败
  | 'FILE_WRITE_ERROR'         // 文件写入失败（权限、只读）
  | 'FILE_BACKUP_ERROR'        // 备份失败
  | 'INVALID_CONFIG'           // 生成的配置语法错误
  | 'DEPENDENCY_MISSING'       // 缺少必要依赖包
  | 'SCAN_FAILED'              // 代码扫描失败
  | 'ROLLBACK_FAILED'          // 回滚失败
  | 'UNKNOWN_ERROR';
```

### 5.2 备份机制

- 所有写操作前，目标文件的原始内容备份到 `.harness/backups/{timestamp}/`
- 备份文件命名：`{originalPath}.bak`（保持目录结构）
- `generate_config` 返回每个文件的 `backupPath`
- `rollback` 从备份目录恢复

### 5.3 Dry-run 模式

```typescript
// generate_config 支持 dryRun 参数
const preview = await generate_config({
  projectDir: '/project',
  decisions: decisions,
  dryRun: true,               // 预览模式
});

// 返回内容预览但不写文件
preview.files.forEach(f => {
  console.log(`[${f.action}] ${f.path}`);
  console.log(f.content);     // 生成的内容
});
```

### 5.4 典型错误场景处理

| 场景 | 检测时机 | 处理方式 |
|------|----------|----------|
| 项目已有 ESLint 配置且规则冲突 | generate_config | 自动合并，冲突规则以用户决策为准，记录 warning |
| 文件写入权限不足 | generate_config | 收集所有错误后返回，不中断，提示用户修改文件权限 |
| 缺少 ESLint 插件 | validate_setup | 返回 `fixCommand: "npm install -D <pkg>"` |
| Husky hook 不可执行 | validate_setup | 返回 `fixCommand: "chmod +x .husky/pre-commit"` |
| 用户中途取消 | Skill 层 | 状态保留在 `.harness/state.json`，下次可继续 |
| 生成的配置导致构建失败 | validate_setup | 建议 rollback，修复后重试 |


## 6. 决策引擎设计

### 6.1 四问题判定流实现

```python
class DecisionEngine:
    def __init__(self, ruleDb, projectParams):
        self.ruleDb = ruleDb
        self.params = projectParams

    def evaluateAll(self):
        # 先按技术栈过滤
        applicable = self._filterByTechStack()
        results = []
        for rule in applicable:
            medium, reason = self.decide(rule)
            results.append((rule, medium, reason))
        return results

    def _filterByTechStack(self):
        stack = self.params.techStack
        return [r for r in self.ruleDb
                if stack in r.appliesTo or 'all' in r.appliesTo]

    def decide(self, rule):
        # 优先检查特殊规则（强制介质）
        special = self._specialCases(rule.id)
        if special:
            return special, f"特殊规则 -> {special}"

        # 问题1: 可形式化吗？
        formalizable = self._checkFormalizable(rule)
        if formalizable is False:
            return "CLAUDE.md", "不可形式化，只能放CLAUDE.md"

        # 问题2: 代价多高？
        cost = self._adjustCost(rule.baseCost, self.params.teamSize)

        # 问题3: 反馈要多快？
        feedback = rule.feedbackSpeed

        # 问题4: 频率多高？
        frequency = self._estimateFrequency(rule, self.params)

        medium, reason = self._finalDecision(cost, feedback, frequency, rule)
        
        # 检查是否需要认知层支持
        if rule.cognitiveLayerSupport?.required:
            medium = f"{medium}+cognitive_support"
            reason = f"{reason} + 需要认知层辅助（{rule.cognitiveLayerSupport.complexity}复杂度）"
        
        return medium, reason

    def _checkFormalizable(self, rule):
        if rule.formalizable == 'partial':
            return len(rule.toolSupport) > 0
        return rule.formalizable

    def _adjustCost(self, baseCost, teamSize):
        # 将成本等级转为数值：critical=4, high=3, medium=2, low=1
        scoreMap = {"critical": 4, "high": 3, "medium": 2, "low": 1}
        levelMap = {4: "critical", 3: "high", 2: "medium", 1: "low"}
        multiplier = {"1-2": 0.8, "3-5": 1.0, "5+": 1.3}
        score = scoreMap[baseCost] * multiplier.get(teamSize, 1.0)
        # 四舍五入后钳制到有效范围 [1, 4]
        return levelMap.get(max(1, min(4, round(score))), "medium")

    def _estimateFrequency(self, rule, params):
        base = rule.baseFrequency
        phaseFactor = {"prototype": 0.5, "development": 1.0, "maintenance": 0.7}
        teamFactor = {"1-2": 0.5, "3-5": 1.0, "5+": 1.8}
        freq = base * phaseFactor.get(params.projectPhase, 1.0) * teamFactor.get(params.teamSize, 1.0)
        if freq >= 5:
            return "high"
        elif freq >= 1:
            return "medium"
        else:
            return "low"
```

### 6.2 冲突检测

```python
conflictMatrix = {
    ("no-explicit-any", "allow-any-in-prototype"): {
        "type": "direct_conflict",
        "resolution": "按项目阶段切换，原型期允许，其他阶段禁止"
    },
    ("max-lines:300", "max-lines:200"): {
        "type": "redundant",
        "resolution": "保留更严格的那条 (200行)"
    },
    ("no-direct-fetch", "allow-ssr-fetch"): {
        "type": "needs_refinement",
        "resolution": "增加例外路径: app/api/ 下允许直接fetch"
    },
}

def detectConflicts(decisions):
    conflicts = []
    for i, a in enumerate(decisions):
        for b in decisions[i+1:]:
            key = (a.ruleId, b.ruleId)
            if key in conflictMatrix:
                conflicts.append({
                    "ruleA": a.ruleId,
                    "ruleB": b.ruleId,
                    **conflictMatrix[key]
                })
    return conflicts
```

### 6.3 综合决策

完整覆盖五种介质 + settings.json：

```python
def _finalDecision(self, cost, feedback, frequency, rule):
    if cost in ("critical", "high"):
        if feedback == "immediate":
            return "linter+hook", f"{'极高' if cost == 'critical' else '高'}代价+需立刻反馈 -> 双重拦截"
        elif feedback == "commit":
            return "hook", f"{'极高' if cost == 'critical' else '高'}代价+提交时反馈 -> hook拦截"
        else:
            return "CI", f"{'极高' if cost == 'critical' else '高'}代价+可慢反馈 -> CI兜底"
    elif cost == "medium":
        if frequency == "high":
            return "linter error", "中代价+高频 -> linter error"
        else:
            return "linter warn", "中代价+低频 -> linter warn"
    else:
        if frequency == "low" and feedback != "immediate":
            return "CLAUDE.md", "低代价+低频 -> 不值得投资硬约束"
        elif feedback == "immediate" and frequency == "high":
            return "linter warn", "低代价+高频+需立刻反馈 -> linter warn提示"
        else:
            return "CLAUDE.md", "低代价+低频 -> 软约束"

def _specialCases(self, ruleId):
    special = {
        "no-env-edit": "settings.json",
        "no-rm-rf": "settings.json",
        "no-sudo": "settings.json",
        "commit-format": "hook",
    }
    return special.get(ruleId)
```


## 7. 规则数据库设计

### 7.1 数据结构

```typescript
interface RuleDefinition {
  id: string;
  name: string;
  description: string;
  category: 'security' | 'architecture' | 'quality' | 'style' | 'process';
  appliesTo: TechStack[];              // 新增：适用技术栈
  formalizable: boolean | 'partial';
  baseCost: 'critical' | 'high' | 'medium' | 'low';
  baseFrequency: number;
  feedbackSpeed: 'immediate' | 'commit' | 'pr';
  toolSupport: ToolSupport[];
  errorMessage: {
    why: string;
    whatInstead: string;
    reference: string;
  };
  evidence: string;
  cognitiveLayerSupport?: {
    required: boolean;  // 是否需要认知层支持
    skillTriggers: string[];  // 触发哪些认知层 Skills
    contextRequirements: string[];  // 需要的上下文信息
    complexity: 'low' | 'medium' | 'high';  // 认知复杂度
  };
}

type TechStack = 'all' | 'nextjs-ts' | 'react-vite' | 'node-ts';

interface ToolSupport {
  tool: 'eslint' | 'typescript' | 'husky' | 'commitlint' | 'github-actions' | 'settings-json' | 'custom';
  configTemplate: string;
  autoFixable: boolean;
  requiredPackages: string[];          // 新增：所需 npm 包
}
```

### 7.2 频率数值映射

`baseFrequency` 在类型定义中为 `number`，规则表中的定性值按以下映射转为定量：

| 定性值 | 数值 | 含义 |
|--------|------|------|
| 高 | 10 | 每天多次触发 |
| 中 | 5 | 每天触发数次 |
| 低 | 1 | 数天触发一次 |

`baseCost` 支持四级：`critical`（极高，映射为数值 4）、`high`（高，3）、`medium`（中，2）、`low`（低，1）。规则表中"极高"对应 `critical`，用于安全相关规则（no-env-edit、migration-review、no-eval、no-rm-rf、no-sudo）。

此映射用于 `_estimateFrequency` 中的 `base * phaseFactor * teamFactor` 计算。

### 7.3 内置规则数据库

> **说明**: 下表为规则数据库的摘要视图，方便查阅。完整规则数据库以 JSON 格式存储在 `mcp-server/src/rules.json`，包含 `toolSupport`、`errorMessage`、`eslintOptions` 等嵌套结构，与 `RuleDefinition` 类型一一对应。实现时以 JSON 文件为准，Markdown 表仅用于文档展示。

| ID | 规则名 | 适用栈 | 形式化 | 代价 | 反馈 | 频率 | 推荐介质 | 依据 | 所需包 | 错误说明 |
|---|---|---|---|---|---|---|---|---|---|---|
| no-explicit-any | 禁用any类型 | nextjs-ts, react-vite, node-ts | Y | 中 | 立刻 | 高 | linter error | TS最佳实践 | @typescript-eslint/eslint-plugin | 禁止使用any类型，应使用具体类型 |
| no-direct-fetch | API须经services层 | nextjs-ts, react-vite | Y | 中 | 立刻 | 高 | linter error | DDD分层 | eslint-plugin-import | 禁止直接fetch，应通过services层调用 |
| no-env-edit | 禁止修改.env | all | Y | 极高 | 提交时 | 低 | settings.json | OWASP | 无 | 禁止修改.env文件，环境变量应通过平台管理 |
| commit-format | commit信息格式 | all | Y | 低 | 提交时 | 高 | hook | Conventional Commits | @commitlint/config-conventional | commit信息不符合Conventional Commits格式 |
| no-comment-tamper | 不乱改注释 | all | N | 低 | N/A | 中 | CLAUDE.md | 最小变更原则 | 无 | 不乱改注释，只修改与需求直接相关的代码 |
| migration-review | 迁移review | all | 部分 | 极高 | PR时 | 低 | ci¹ | 数据安全 | 无 | 数据库迁移必须经review，不可直接合并 |
| prefer-sc | 优先server comp | nextjs-ts | 部分 | 低 | 立刻 | 高 | claude_md + linter_warn² | React RSC | 无 | 默认使用Server Component，需要客户端交互时再用Client Component |
| no-console-log | 禁止console.log | all | Y | 中 | 立刻 | 中 | linter warn | 生产日志 | 无 | 禁止使用console.log，应使用项目统一的日志工具 |
| component-size | 组件大小限制 | nextjs-ts, react-vite | Y | 低 | PR时 | 中 | linter warn | 可维护性 | eslint-plugin-react | 组件超过300行时应拆分为更小的组件 |
| no-eval | 禁止eval | all | Y | 极高 | 立刻 | 低 | linter error | 安全 | eslint-plugin-security | 禁止使用eval，存在XSS注入风险 |
| no-rm-rf | 禁止rm -rf | all | Y | 极高 | N/A | 低 | settings.json | 安全 | 无 | 禁止执行rm -rf命令，使用 safer替代方案 |
| no-sudo | 禁止sudo | all | Y | 极高 | N/A | 低 | settings.json | 安全 | 无 | 禁止使用sudo执行命令 |
| no-direct-prisma | 禁止直接import prisma | nextjs-ts, node-ts | Y | 中 | 立刻 | 中 | linter error | 分层架构 | eslint-plugin-import | 禁止直接import prisma，应通过repository层访问 |
| func-complexity | 函数复杂度限制 | all | Y | 中 | 立刻 | 中 | linter error | 可维护性 | eslint-plugin-complexity | 函数圈复杂度超过10时应重构 |
| import-order | 导入排序 | all | Y | 低 | 立刻 | 高 | linter warn | 代码整洁 | eslint-plugin-import | 导入语句顺序不符合项目规范 |
| naming-convention | 命名规范 | all | Y | 低 | 立刻 | 高 | linter warn | 代码整洁 | @typescript-eslint/eslint-plugin, eslint-plugin-unicorn | 代码标识符使用camelCase，文件名使用snake_case |

> **复合介质说明**:
> 1. **ci¹**: 规则通过 CI 工作流强制执行（`ci` 介质），同时建议在 PR review 流程中人工检查。引擎将其视为 `ci` 介质，`_finalDecision` 对 `cost=high + feedback=pr` 返回 `ci`。
> 2. **claude_md + linter_warn²**: 规则同时写入 CLAUDE.md（软约束）和 ESLint（warn 级别）。这是因为 `prefer-sc` 形式化程度为 `partial`（无法完全通过 ESLint 检查），但 ESLint 可以覆盖部分场景（如检测 `"use client"` 指令缺失），所以采用双介质策略。

## 8. 配置生成器设计

### 8.1 模板引擎

```python
class ConfigGenerator:
    def __init__(self, decisions, techStack, projectParams):
        self.decisions = decisions
        self.techStack = techStack
        self.params = projectParams

    def generateAll(self):
        return {
            "claudeMd": self._generateClaudeMd(),
            "eslintrc": self._generateEslintrc(),
            "settingsJson": self._generateSettingsJson(),
            "husky": self._generateHuskyHooks(),
            "ci": self._generateCiWorkflow(),
            "packageJsonUpdates": self._generatePackageJsonUpdates(),
            "gitignore": self._generateGitignore(),
        }

    def _generateClaudeMd(self):
        # 包含 linter_warn 规则的理由：CLAUDE.md 作为"为什么要有这条规则"的说明文档，
        # 即使 ESLint 会自动报 warn，开发者也应在 CLAUDE.md 中理解其背景。
        # 而 linter_error 规则是硬性拦截，开发者被迫遵守，不需要额外在 CLAUDE.md 中说明。
        rules = [d for d in self.decisions if d.medium in ['claude_md', 'linter_warn']]
        content = f"""# {self.params.projectName}

## 编码约束

"""
        for r in rules:
            content += f"- {r.description}\n"
        return content

    def _generateEslintrc(self):
        errorRules = [d for d in self.decisions if d.medium in ('linter_error', 'linter+hook') and d.eslintRule]
        warnRules = [d for d in self.decisions if d.medium == 'linter_warn' and d.eslintRule]
        config = {"rules": {}}
        for r in errorRules:
            config["rules"][r.eslintRule] = ["error", r.eslintOptions or {}]
        for r in warnRules:
            config["rules"][r.eslintRule] = ["warn", r.eslintOptions or {}]
        # 自动添加需要的 plugin 声明，处理包名简写
        #   @typescript-eslint/eslint-plugin → @typescript-eslint
        #   eslint-plugin-xxx → xxx
        plugins = set()
        for r in errorRules + warnRules:
            for plugin in (r.eslintPlugins or []):
                normalized = plugin.replace('/eslint-plugin', '')
                if normalized.startswith('eslint-plugin-'):
                    normalized = normalized[len('eslint-plugin-'):]
                plugins.add(normalized)
        if plugins:
            config["plugins"] = sorted(plugins)
        return json.dumps(config, indent=2)

    def _generateSettingsJson(self):
        """生成 .claude/settings.json，包含编辑器级保护规则"""
        settingsRules = [d for d in self.decisions if d.medium == 'settings']
        if not settingsRules:
            return None
        config = {
            "security": {
                "allowedCommands": [],
                "blockedCommands": [],
                "allowedPaths": [],
                "blockedPaths": [],
            }
        }
        for r in settingsRules:
            if r.ruleId == "no-env-edit":
                config["security"]["blockedPaths"].append(".env")
                config["security"]["blockedPaths"].append(".env.local")
            elif r.ruleId == "no-rm-rf":
                config["security"]["blockedCommands"].append("rm -rf")
            elif r.ruleId == "no-sudo":
                config["security"]["blockedCommands"].append("sudo")
        return json.dumps(config, indent=2)

    def _generateHuskyHooks(self):
        """生成 .husky/pre-commit 和 .husky/commit-msg"""
        hooks = {}
        hasLinter = any(d.medium in ['linter_error', 'linter_warn', 'linter+hook', 'hook']
                        for d in self.decisions)
        hasCommit = any(d.ruleId == 'commit-format' for d in self.decisions)

        if hasLinter:
            hooks[".husky/pre-commit"] = """#!/usr/bin/env sh
. "$(dirname -- "$0")/_/husky.sh"

npx lint-staged
"""
        if hasCommit:
            hooks[".husky/commit-msg"] = """#!/usr/bin/env sh
. "$(dirname -- "$0")/_/husky.sh"

npx --no -- commitlint --edit $1
"""
        return hooks

    def _generateCiWorkflow(self):
        """生成 .github/workflows/check.yml"""
        hasCi = any(d.medium == 'ci' for d in self.decisions)
        hasLinter = any(d.medium in ['linter_error', 'linter_warn', 'linter+hook']
                        for d in self.decisions)
        hasTypescript = self.techStack in ['nextjs-ts', 'react-vite', 'node-ts']

        if not hasCi and not hasLinter and not hasTypescript:
            return None

        jobs = []
        if hasLinter:
            jobs.append("""  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci
      - run: npx eslint .""")
        if hasTypescript:
            jobs.append("""  typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci
      - run: npx tsc --noEmit""")

        return f"""name: Code Quality Check
on: [push, pull_request]

jobs:
{chr(10).join(jobs)}
"""

    def _generatePackageJsonUpdates(self):
        """返回需要在 package.json 中合并的配置"""
        updates = {}
        devDeps = set()

        for d in self.decisions:
            for pkg in (d.requiredPackages or []):
                devDeps.add(pkg)

        if devDeps:
            updates["devDependencies"] = {pkg: "latest" for pkg in devDeps}

        # lint-staged 配置
        hasLinter = any(d.medium in ['linter_error', 'linter_warn', 'linter+hook']
                        for d in self.decisions)
        if hasLinter:
            updates["lint-staged"] = {"*.{ts,tsx}": ["eslint --fix"]}

        return updates

    def _generateGitignore(self):
        """确保 .harness/ 目录不被纳入版本控制"""
        content = "\n# Harness Automation State\n.harness/\n"
        return content
```

### 8.2 错误信息优化框架

#### 8.2.1 设计原则

错误信息是给 Agent 看的上下文工程，所有从 harness 流回模型的信号都是引导。设计原则：

1. **上下文丰富**：提供足够背景帮助 Agent 理解问题根源
2. **Actionable**：明确下一步操作，减少 Agent 的猜测
3. **可学习性**：帮助 Agent 避免重复错误，建立正确模式
4. **一致性**：统一风格和术语，降低认知负荷
5. **可测试性**：支持 A/B 测试验证效果

#### 8.2.2 模板库系统

扩展 `ErrorMessageGenerator` 支持模板库，提供结构化、可复用的错误信息模板：

```typescript
interface ErrorMessageTemplate {
  id: string;
  name: string;
  structure: {
    why: string;      // 模板占位符: {rule.why}, {context.projectType}
    whatInstead: string; // 模板占位符: {rule.alternative}, {context.example}
    reference: string;   // 模板占位符: {rule.reference}, {context.docsUrl}
    context: string;     // 额外上下文信息: {context.impact}, {context.alternatives}
    learningTip: string; // 学习建议: {tip.bestPractice}, {tip.commonMistake}
  };
  适用场景: string[];
  效果指标: {
    fixRate: number;     // 历史修复率
    clarityScore: number; // 清晰度评分（1-5）
    learningImpact: number; // 学习效果评分
  };
}

class ErrorMessageGenerator {
  private templates: ErrorMessageTemplate[] = [];
  
  generate(rule: RuleDefinition, context: ErrorContext): string {
    // 1. 选择最合适的模板
    const template = this.selectTemplate(rule, context);
    
    // 2. 填充模板变量
    return this.fillTemplate(template, {
      rule: rule.errorMessage,
      context: context,
      tip: this.generateLearningTip(rule)
    });
  }
  
  selectTemplate(rule: RuleDefinition, context: ErrorContext): ErrorMessageTemplate {
    // 基于规则类型、复杂度、目标受众选择模板
    const candidates = this.templates.filter(t => 
      t.适用场景.some(scene => scene.includes(rule.category))
    );
    
    // 优先选择效果指标高的模板
    return candidates.sort((a, b) => 
      b.效果指标.fixRate - a.效果指标.fixRate
    )[0];
  }
  
  generateLearningTip(rule: RuleDefinition): LearningTip {
    // 根据规则类型生成学习建议
    return {
      bestPractice: `最佳实践: ${rule.evidence}`,
      commonMistake: `常见错误: ${this.getCommonMistake(rule.id)}`,
      relatedRules: this.getRelatedRules(rule.id)
    };
  }
}

interface ErrorContext {
  projectType: string;
  techStack: string;
  userExperience: 'beginner' | 'intermediate' | 'expert';
  previousErrors: string[];  // 近期类似错误
  timeOfDay?: string;        // 可选的上下文因素
}

interface LearningTip {
  bestPractice: string;
  commonMistake: string;
  relatedRules: string[];
}
```

#### 8.2.3 错误信息 A/B 测试

集成到 A/B 测试框架中，验证不同错误信息设计的效果：

```typescript
interface ErrorMessageABTest {
  ruleId: string;
  variants: ErrorMessageVariant[];
  metrics: {
    primary: 'fix_rate' | 'time_to_fix' | 'user_satisfaction';
    secondary: string[];
  };
}

interface ErrorMessageVariant {
  id: string;
  templateId: string;
  customizations: Record<string, any>;
  hypothesis: string;  // 例如："更详细的上下文会提高修复率"
}

// 在 A/B 测试框架中集成
const errorMessageTest: ABTestConfig = {
  ruleId: 'no-explicit-any',
  baselineMedium: 'linter_error',
  testMedium: 'linter_error+cognitive_support',
  durationDays: 7,
  metrics: [
    { name: 'fix_rate', weight: 0.6 },
    { name: 'time_to_fix', weight: 0.3 },
    { name: 'user_feedback', weight: 0.1 }
  ]
};
```

#### 8.2.4 优化建议工具

提供 `suggest_error_improvement` 工具，分析错误信息使用情况并提供优化建议：

```typescript
interface SuggestErrorImprovementInput {
  projectDir: string;
  ruleId?: string;  // 可选，指定特定规则
  timeRange?: {
    start: string;
    end: string;
  };
}

interface SuggestErrorImprovementOutput {
  ruleId: string;
  currentTemplate: string;
  analysis: {
    usageStats: {
      triggerCount: number;
      fixCount: number;
      bypassCount: number;
      avgTimeToFix: number;
    };
    userFeedback: {
      clarityRating: number;
      helpfulnessRating: number;
      comments: string[];
    };
  };
  recommendations: ErrorImprovementRecommendation[];
}

interface ErrorImprovementRecommendation {
  priority: 'high' | 'medium' | 'low';
  change: {
    template: string;  // 建议的新模板 ID
    customizations: Record<string, any>;
  };
  expectedImpact: {
    fixRateImprovement: number;  // 预期修复率提升百分比
    clarityImprovement: number;  // 预期清晰度提升（1-5分）
  };
  evidence: string;  // 支持建议的证据
}
```

**优化流程**:
1. 收集错误信息使用数据（触发、修复、绕过、用户反馈）
2. 分析当前模板的效果指标
3. 对比模板库中的最佳实践
4. 生成数据驱动的优化建议
5. 支持一键应用优化建议并启动 A/B 测试验证

### 8.3 文件写入策略

```typescript
interface WriteStrategy {
  action: 'create' | 'overwrite' | 'append' | 'merge';
  mergeKey?: string;          // package.json 中要合并的 key
  backupExisting?: boolean;
}

// 各文件的写入策略
const fileStrategies: Record<string, WriteStrategy> = {
  "CLAUDE.md":              { action: "create", backupExisting: true },
  ".eslintrc.json":         { action: "merge", backupExisting: true },
  ".claude/settings.json":  { action: "merge", backupExisting: true },
  ".husky/pre-commit":      { action: "create", backupExisting: true },
  ".husky/commit-msg":      { action: "create", backupExisting: true },
  ".github/workflows/check.yml": { action: "create", backupExisting: false },
  "package.json":           { action: "merge", mergeKey: "devDependencies" },
  ".gitignore":             { action: "append", backupExisting: true },
};
```

### 8.4 依赖管理

```typescript
interface DependencyCheck {
  packageName: string;
  required: boolean;         // true = 必须，false = 推荐
  installCommand: string;
  isInstalled: boolean;
}

// generate_config 运行时检查所有需要的依赖
// validate_setup 时再次确认
// 如果缺少必要依赖，返回 fixCommand
```

## 9. Skill 设计

### 9.1 SKILL.md

```markdown
---
name: harness-automation
description: 为项目自动建立约束体系。当用户说"建立约束体系"、"初始化约束"、"设置harness"、"配置项目约束"、"setup harness"时触发。
---

# Harness Automation

## 工作流

1. 调 MCP `query_state` 检查是否有进行中的状态（断点续做）
   - 如果 phase 为 `evaluated`、`confirmed`、`generated` 或 `validated`，跳过 evaluate_rules，从步骤 5 继续
   - 如果 phase 为 `confirmed`、`generated` 或 `validated`，跳过确认步骤，从步骤 8 继续
   - 如果 phase 为 `validated`，询问用户是否重新生成
2. 确认用户意图，询问项目根目录
3. AskUserQuestion 收集项目信息（技术栈/阶段/团队规模）
4. 调用 MCP `evaluate_rules` 获取推荐列表
5. 询问是否需要扫描代码库以发现额外规则（AskUserQuestion）
   - 是 → 调 MCP `scan_codebase`，合并扫描发现到推荐列表
   - 否 → 跳过
6. 展示推荐给用户（含扫描合并结果），AskUserQuestion 确认或逐条调整
7. 调 MCP `confirm_decisions` 将最终决策写入状态
8. 调 MCP `generate_config`（建议先 dry_run 预览）
9. 调 MCP `validate_setup` 验证安装
10. 如有问题，AskUserQuestion 确认后调 MCP `rollback`
11. 完成

## 注意事项

- 如果项目已有 CLAUDE.md，先读取现有内容
- 如果项目已有 ESLint 配置，合并而非覆盖
- 所有 MCP 调用需检查返回的 errors/warnings
```

### 9.2 触发条件

| 用户说 | 触发 |
|--------|------|
| "建立约束体系" | Y |
| "初始化约束" | Y |
| "设置harness" | Y |
| "配置项目约束" | Y |
| "setup harness" | Y |
| "给我的项目加规则" | Y |
| "检查项目约束" | Y（调 validate_setup） |
| "回滚约束配置" | Y（调 rollback） |
| 其他无关任务 | N |

## 10. 实现路径（MVP）

### Phase 1: 核心决策引擎（1-2天）

```text
实现内容：
├── 规则数据库（16条内置规则，JSON格式）
├── 决策引擎（四问题判定流 + 技术栈过滤）
├── 冲突检测器
├── 状态管理（.harness/state.json）
├── 配置生成器（CLAUDE.md + ESLint + settings.json + .gitignore）
├── dry_run 预览模式
├── 备份与回滚机制

交付物：
├── mcp-server/
│   ├── package.json
│   ├── src/
│   │   ├── index.ts            # MCP Server 入口
│   │   ├── engine.ts           # 决策引擎
│   │   ├── rules.json          # 规则数据库（JSON 格式）
│   │   ├── state.ts            # 状态管理
│   │   ├── generators/
│   │   │   ├── claude_md.ts
│   │   │   ├── eslint.ts
│   │   │   ├── settings_json.ts
│   │   │   └── gitignore.ts
│   │   └── types.ts            # 类型定义
│   └── tsconfig.json
└── skill/
    └── SKILL.md

> **注意**: Husky hooks、CI 工作流、package.json 合并三个生成器在 Phase 2 实现。Phase 1 只生成 CLAUDE.md、ESLint 配置、settings.json 和 .gitignore 四个文件。
```

### Phase 2: 代码分析 + 扩展（+2-3天）

```text
实现内容：
├── AST 分析器（扫描代码发现潜在规则）
├── CLAUDE.md 解析器（提取已有规则）
├── Husky hook 生成器
├── CI 工作流生成器
├── package.json 合并器
├── 依赖管理检查
└── 规则效果统计（触发频率、修复率）

交付物：
├── mcp-server/src/
│   ├── scanners/
│   │   ├── code_scanner.ts     # AST 分析
│   │   └── claude_extractor.ts # CLAUDE.md 提取
│   ├── generators/
│   │   ├── husky.ts
│   │   ├── ci.ts
│   │   └── package_json.ts
│   └── deps.ts                 # 依赖管理
```

### Phase 3: 验证 + 优化（+2天）

```text
实现内容：
├── 配置验证器（检查文件完整性 + 语法校验）
├── 规则效果统计（触发频率、修复率）
├── 自适应调整建议（降级/升级建议）
└── 规则导入/导出（分享配置）
```

### Phase 4: 高级功能（+3-5天）

```text
实现内容：
├── 适用性评估（assess_suitability）
│   ├── 原型阶段检测
│   ├── 一次性脚本识别
│   └── 维护成本评估
├── A/B 测试框架
│   ├── 测试配置管理（start_ab_test）
│   ├── 数据收集器（collect_ab_metrics）
│   ├── 统计分析引擎（analyze_ab_results）
│   └── 规则调整推荐（recommend_rule_adjustment）
├── 错误信息优化框架
│   ├── 模板库系统
│   ├── 上下文感知生成
│   └── 效果评估工具
└── 认知层 Skills 集成
    ├── 诊断型 Skills（根因分析）
    ├── 教育型 Skills（规则解释）
    ├── 决策支持型 Skills（权衡分析）
    └── 自适应触发机制

交付物：
├── mcp-server/src/
│   ├── suitability/
│   │   └── assessor.ts
│   ├── ab_test/
│   │   ├── manager.ts
│   │   ├── collector.ts
│   │   ├── analyzer.ts
│   │   └── recommender.ts
│   ├── error_optimization/
│   │   ├── templates.ts
│   │   ├── generator.ts
│   │   └── evaluator.ts
│   └── cognitive_layer/
│       ├── skills/
│       │   ├── diagnostic.ts
│       │   ├── educational.ts
│       │   └── decision_support.ts
│       ├── orchestrator.ts
│       └── context.ts
└── skill/
    └── cognitive_skills.md

> **注意**: Phase 4 功能均为可选扩展，不影响核心流程。用户可选择启用高级功能。
```

## 11. 验证与测试

### 11.1 测试场景

> **注意**: `totalRules` 统计通过技术栈过滤且推荐介质不为 `none` 的规则数量。以下数值基于当前 16 条内置规则计算得出。

```typescript
// 场景1: 全新 Next.js 项目
const scenario1 = {
  techStack: 'nextjs-ts',
  projectPhase: 'development',
  teamSize: '3-5',
  expected: {
    totalRules: 16,
    linterErrors: 5,
    linterWarns: 5,
    settingsJson: 3,
    claudeMd: 1,
    hook: 1,
    ci: 1,
  }
};

// 场景2: 原型期个人项目（约束最少）
const scenario2 = {
  techStack: 'react-vite',
  projectPhase: 'prototype',
  teamSize: '1-2',
  expected: {
    totalRules: 4,
  }
};

// 场景3: 稳定期大团队（约束最全）
const scenario3 = {
  techStack: 'nextjs-ts',
  projectPhase: 'maintenance',
  teamSize: '5+',
  expected: {
    totalRules: 13,
  }
};
```

### 11.2 验证指标

| 指标 | 目标 | 测量方式 |
|------|------|----------|
| 决策准确率 | >90% | 与人工决策对比 |
| 配置完整性 | 100% | 文件存在性检查 |
| 配置语法正确性 | 100% | ESLint/JSON 校验 |
| 备份恢复成功率 | 100% | rollback 测试 |
| 用户满意度 | >80% | 用户反馈收集 |

## 12. 设计总结

### 12.1 自动化程度

| 环节 | 自动化程度 | 人工介入 |
|------|-----------|---------|
| 规则发现 | 70% | 代码扫描建议，用户确认 |
| 规则分类 | 90% | 预设数据库，用户可覆盖 |
| 冲突检测 | 100% | 自动检测并给出解决建议 |
| 介质决策 | 95% | 自动决策，用户可逐条调整 |
| 配置生成 | 100% | 自动生成完整配置 |
| 文件写入 | 100% | 自动创建/合并文件，支持 dry_run |
| 备份回滚 | 100% | 自动备份，一键回滚 |
| 验证测试 | 80% | 自动检查，用户确认结果 |
| 依赖管理 | 80% | 自动检测缺失依赖，提供安装命令 |
| 持续优化 | 60% | 自动统计，用户决定调整 |

### 12.2 关键设计决策

1. **Skill + MCP 双层架构**: Skill 负责流程引导+用户交互，MCP 负责纯计算/文件操作，职责清晰
2. **声明式配置收集**: 一次问完所有问题，后续全自动
3. **默认有据**: 所有默认决策基于工程最佳实践，可追溯
4. **可覆盖设计**: 用户可调整任何默认决策，不强制
5. **安全优先**: 写文件前自动备份，支持回滚
6. **状态驱动**: 通过 .harness/state.json 实现断点续做

### 12.3 局限与未来

**当前局限**:
- 规则数据库只覆盖通用规则，项目特有规则需用户手动添加
- AST 分析器能力依赖各语言 parser 的支持
- 无法自动评估"规则是否真正有效"（需要被动数据采集）

**未来方向**:
- 规则效果追踪：统计触发频率和修复率
- 跨项目规则库共享：社区维护的规则数据库
- 自适应约束调整：根据项目阶段自动调整约束强度
- 规则模板市场：预配置的行业/框架特定规则集


## 13. A/B 测试与效果评估

### 13.1 设计目标

1. **数据驱动决策**：基于实际使用数据验证规则效果，而非主观假设
2. **持续优化**：通过 A/B 测试不断改进规则设计和错误信息
3. **防止规则膨胀**：确保每条规则都有实际价值，避免过度约束
4. **个性化适配**：根据团队和项目特点调整约束强度

### 13.2 架构设计

```
┌─────────────────────────────────────────────────────┐
│                    A/B 测试框架                      │
├─────────────────────────────────────────────────────┤
│ 1. 测试配置管理                                      │
│    - 测试定义 (ruleId, baseline, test, duration)    │
│    - 指标定义 (primary, secondary, weights)         │
│    - 目标用户分组                                    │
├─────────────────────────────────────────────────────┤
│ 2. 数据收集层                                        │
│    - 触发事件捕获 (git hooks, CI, linter)           │
│    - 用户反馈收集 (满意度评分, 评论)                 │
│    - 性能指标追踪 (修复时间, 绕过率)                 │
├─────────────────────────────────────────────────────┤
│ 3. 分析引擎                                          │
│    - 统计显著性检验 (t-test, chi-square)            │
│    - 效果大小评估                                    │
│    - 业务上下文加权                                  │
├─────────────────────────────────────────────────────┤
│ 4. 推荐系统                                          │
│    - 优化建议生成                                    │
│    - 优先级排序                                      │
│    - 一键应用支持                                    │
└─────────────────────────────────────────────────────┘
```

### 13.3 核心组件

#### 13.3.1 测试配置管理

```typescript
interface ABTestManager {
  // 创建新测试
  createTest(config: ABTestConfig): Promise<ABTest>;
  
  // 查询进行中的测试
  getActiveTests(): Promise<ABTest[]>;
  
  // 暂停/恢复测试
  updateTestStatus(testId: string, status: 'active' | 'paused' | 'completed'): Promise<void>;
  
  // 导出测试数据
  exportTestData(testId: string, format: 'json' | 'csv'): Promise<string>;
}

interface ABTest {
  id: string;
  config: ABTestConfig;
  status: 'draft' | 'active' | 'paused' | 'completed' | 'archived';
  timeline: {
    created: string;
    started?: string;
    completed?: string;
    lastDataCollection?: string;
  };
  results?: ABTestResults;
}
```

#### 13.3.2 数据收集器

```typescript
class DataCollector {
  // 从不同来源收集数据
  collectFromGitHooks(): Promise<HookEvent[]>;
  collectFromCI(): Promise<CIEvent[]>;
  collectFromLinter(): Promise<LinterEvent[]>;
  collectUserFeedback(): Promise<UserFeedback[]>;
  
  // 数据标准化
  normalizeEvents(rawEvents: RawEvent[]): NormalizedEvent[];
  
  // 数据存储
  storeEvents(events: NormalizedEvent[]): Promise<void>;
}

interface NormalizedEvent {
  timestamp: string;
  ruleId: string;
  eventType: 'trigger' | 'fix' | 'bypass' | 'feedback';
  group: 'baseline' | 'test' | 'control';
  userId?: string;
  metadata: Record<string, any>;
}
```

#### 13.3.3 统计分析引擎

```typescript
class StatisticalAnalyzer {
  // 统计检验
  tTest(baseline: number[], test: number[]): TTestResult;
  chiSquareTest(observed: number[][], expected?: number[][]): ChiSquareResult;
  confidenceInterval(mean: number, stdDev: number, n: number, confidence: number): [number, number];
  
  // 效果评估
  calculateEffectSize(baseline: number[], test: number[]): number;
  calculatePracticalSignificance(statisticalResult: StatisticalResult, businessContext: BusinessContext): PracticalSignificance;
  
  // 报告生成
  generateAnalysisReport(testId: string): AnalysisReport;
}

interface AnalysisReport {
  testId: string;
  statisticalSummary: {
    significant: boolean;
    pValue: number;
    effectSize: number;
    confidenceInterval: [number, number];
  };
  businessImpact: {
    estimatedImprovement: number;
    confidence: 'high' | 'medium' | 'low';
    roiEstimate?: number;
  };
  recommendations: Recommendation[];
  limitations: string[];
}
```

### 13.4 集成到主流程

#### 13.4.1 阶段集成

1. **规则应用后**：自动启动短期测试（7天），收集基线数据
2. **规则调整时**：启动 A/B 测试验证调整效果
3. **定期评估**：每月自动评估所有规则效果，标记低效规则

#### 13.4.2 用户工作流

```
用户工作流集成 A/B 测试：
1. 应用新规则 → 自动启动 7 天效果测试
2. 收到测试报告 → 查看规则实际效果
3. 基于数据决策 → 保留/调整/移除规则
4. 持续监控 → 定期重新评估规则效果
```

### 13.5 效果评估指标

#### 13.5.1 核心指标

| 指标 | 定义 | 目标值 | 测量方法 |
|------|------|--------|----------|
| **修复率** | 触发后实际修复的比例 | >70% | (修复次数) / (触发次数) |
| **平均修复时间** | 从触发到修复的平均时间 | <30分钟 | 时间戳差值计算 |
| **绕过率** | 故意绕过规则的比例 | <10% | (绕过次数) / (触发次数) |
| **用户满意度** | 用户对规则的评分 | >4.0/5.0 | 定期反馈收集 |
| **误报率** | 错误触发的比例 | <5% | 人工审核样本 |

#### 13.5.2 复合指标

```typescript
interface RuleEffectivenessScore {
  ruleId: string;
  score: number;  // 0-100
  components: {
    fixRate: number;      // 权重: 40%
    userSatisfaction: number; // 权重: 30%
    timeToFix: number;    // 权重: 20%
    bypassRate: number;   // 权重: 10%
  };
  trend: 'improving' | 'stable' | 'declining';
  recommendations: string[];
}
```

### 13.6 实施建议

#### 13.6.1 渐进式实施

1. **MVP 阶段**：基础数据收集 + 简单报告
2. **进阶阶段**：A/B 测试框架 + 统计分析
3. **成熟阶段**：自动优化推荐 + 预测模型

#### 13.6.2 技术选型考虑

- **数据存储**：本地 JSON 文件（简单） vs 轻量数据库（可扩展）
- **分析引擎**：内置统计库 vs 集成外部分析服务
- **可视化**：命令行报告 vs Web 仪表板

#### 13.6.3 隐私与伦理

- **匿名化**：用户数据去标识化处理
- **透明度**：明确告知数据收集目的和使用方式
- **选择权**：允许用户退出数据收集
- **数据最小化**：只收集必要数据


## 14. 认知层 Skills 集成

### 14.1 设计理念

认知层 Skills 与约束层 harness 形成互补：
- **约束层**：防止错误，强制执行规范（what not to do）
- **认知层**：提供指导，帮助理解和决策（how to do it right）

参考文件中的 Skills 概念：在 description 字段匹配时按需触发，适合领域知识和特定工作流。

### 14.2 认知层 Skill 类型

#### 14.2.1 诊断型 Skills

**目的**：分析代码问题，提供根因分析和修复建议

```typescript
interface DiagnosticSkill {
  type: 'diagnostic';
  triggers: string[];  // 触发关键词：如 "为什么", "分析", "诊断"
  capabilities: {
    rootCauseAnalysis: boolean;
    patternRecognition: boolean;
    solutionGeneration: boolean;
  };
  examples: {
    input: "为什么这个组件渲染性能差？";
    output: "分析发现：1) 不必要的重新渲染 2) 大型列表未虚拟化 3) 复杂计算未缓存";
  }[];
}
```

#### 14.2.2 教育型 Skills

**目的**：解释规则原理，提供学习资源和最佳实践

```typescript
interface EducationalSkill {
  type: 'educational';
  triggers: string[];  // 触发关键词：如 "解释", "学习", "教程"
  content: {
    conceptualExplanation: string;
    bestPractices: string[];
    commonPitfalls: string[];
    learningResources: {
      title: string;
      url: string;
      type: 'article' | 'video' | 'documentation';
    }[];
  };
}
```

#### 14.2.3 决策支持型 Skills

**目的**：复杂场景下的决策辅助，权衡利弊

```typescript
interface DecisionSupportSkill {
  type: 'decision_support';
  triggers: string[];  // 触发关键词：如 "选择", "决策", "权衡"
  decisionFramework: {
    criteria: string[];
    weights: number[];
    alternatives: string[];
  };
  output: {
    recommendation: string;
    rationale: string;
    tradeoffs: Record<string, { pros: string[]; cons: string[] }>;
  };
}
```

### 14.3 集成机制

#### 14.3.1 触发条件

1. **显式触发**：用户明确请求认知层帮助
2. **隐式触发**：基于上下文自动建议
   - 重复犯相同错误
   - 复杂决策场景
   - 学习新概念时

#### 14.3.2 上下文传递

```typescript
interface CognitiveContext {
  // 来自约束层
  ruleViolation?: {
    ruleId: string;
    errorMessage: string;
    codeSnippet: string;
  };
  
  // 来自项目上下文
  project: {
    techStack: string;
    phase: string;
    teamSize: string;
  };
  
  // 来自用户上下文
  user: {
    experienceLevel: 'beginner' | 'intermediate' | 'expert';
    recentErrors: string[];
    learningGoals?: string[];
  };
  
  // 对话历史
  conversationHistory: Message[];
}
```

#### 14.3.3 响应生成

```typescript
class CognitiveLayerOrchestrator {
  async handleRequest(context: CognitiveContext): Promise<CognitiveResponse> {
    // 1. 分析请求类型
    const requestType = this.analyzeRequestType(context);
    
    // 2. 选择合适 Skills
    const skills = this.selectSkills(requestType, context);
    
    // 3. 执行 Skills 并整合结果
    const results = await Promise.all(
      skills.map(skill => skill.execute(context))
    );
    
    // 4. 生成综合响应
    return this.synthesizeResponse(results, context);
  }
}
```

### 14.4 在规则定义中集成

#### 14.4.1 规则与认知层关联

```typescript
// 在 RuleDefinition 中扩展认知层支持
interface RuleDefinition {
  // ... 现有字段
  
  cognitiveLayerSupport: {
    required: boolean;
    supportedSkills: CognitiveSkillType[];
    contextRequirements: {
      codeContext: boolean;      // 需要代码上下文
      projectContext: boolean;   // 需要项目上下文
      userContext: boolean;      // 需要用户上下文
    };
    complexity: 'low' | 'medium' | 'high';
  };
  
  // 认知层特定配置
  cognitiveConfig?: {
    diagnosticPrompts: string[];
    educationalResources: EducationalResource[];
    decisionFrameworks: DecisionFramework[];
  };
}
```

#### 14.4.2 自动 Skill 生成

基于规则定义自动生成认知层 Skills：

```typescript
class CognitiveSkillGenerator {
  generateFromRule(rule: RuleDefinition): CognitiveSkill[] {
    const skills: CognitiveSkill[] = [];
    
    // 生成诊断型 Skill
    if (rule.category === 'quality' || rule.category === 'architecture') {
      skills.push(this.createDiagnosticSkill(rule));
    }
    
    // 生成教育型 Skill
    skills.push(this.createEducationalSkill(rule));
    
    // 生成决策支持型 Skill（如需要权衡）
    if (rule.formalizable === 'partial') {
      skills.push(this.createDecisionSupportSkill(rule));
    }
    
    return skills;
  }
}
```

### 14.5 使用场景示例

#### 14.5.1 场景一：复杂规则解释

```
用户: "为什么不能直接使用 eval？"
系统: [触发认知层教育型 Skill]
输出: 
1. 安全风险：eval 允许执行任意代码，可能导致 XSS 攻击
2. 性能问题：eval 阻止 JavaScript 引擎优化
3. 可维护性：eval 代码难以静态分析和重构
4. 替代方案：使用 Function 构造函数（有约束）或 JSON.parse
5. 学习资源：OWASP 安全指南链接
```

#### 14.5.2 场景二：规则冲突解决

```
场景: no-direct-fetch 与 allow-ssr-fetch 规则冲突
系统: [触发认知层决策支持型 Skill]
输出:
决策框架：
- 标准：安全性、性能、可维护性、团队惯例
- 权重：安全性(40%)、性能(30%)、可维护性(20%)、惯例(10%)
- 建议：在 app/api/ 路径下允许直接 fetch，其他路径禁止
- 理由：平衡安全需求与 SSR 性能需求
```

#### 14.5.3 场景三：自适应学习

```
用户: 第三次触发 "no-explicit-any" 规则
系统: [检测到重复错误，触发认知层诊断型 Skill]
输出:
检测到模式：您经常在 API 响应类型中使用 any
建议：
1. 创建通用类型：interface ApiResponse<T> { data: T; error?: string }
2. 使用类型推断：让 TypeScript 自动推断类型
3. 学习资源：TypeScript 高级类型教程
```

### 14.6 实施路线图

#### 14.6.1 阶段一：基础集成（MVP）

- 在规则定义中添加认知层支持标记
- 实现简单的教育型 Skills（规则解释）
- 提供基础的学习资源链接

#### 14.6.2 阶段二：智能触发

- 实现上下文感知的 Skill 触发
- 添加诊断型 Skills（根因分析）
- 集成用户学习历史

#### 14.6.3 阶段三：自适应学习

- 实现个性化学习路径
- 添加决策支持型 Skills
- 与 A/B 测试框架集成，评估认知层效果

### 14.7 效果评估

#### 14.7.1 评估指标

| 指标 | 定义 | 目标 |
|------|------|------|
| **Skill 使用率** | 触发认知层帮助的比例 | >30% |
| **问题解决率** | 使用认知层帮助后问题解决的比例 | >80% |
| **学习效果** | 重复错误减少的比例 | >50% |
| **用户满意度** | 对认知层帮助的评分 | >4.2/5.0 |
| **时间节省** | 平均问题解决时间减少 | >30% |

#### 14.7.2 A/B 测试设计

```typescript
const cognitiveLayerTest: ABTestConfig = {
  ruleId: 'no-explicit-any',
  baselineMedium: 'linter_error',
  testMedium: 'linter_error+cognitive_support',
  durationDays: 14,
  metrics: [
    { name: 'fix_rate', weight: 0.4 },
    { name: 'time_to_fix', weight: 0.3 },
    { name: 'repeat_errors', weight: 0.2 },
    { name: 'user_feedback', weight: 0.1 }
  ]
};
```
