# Harness Automation System 开发计划 v1.0

## 项目概述

基于《Harness Automation System Design v3.0》文档，实现一个自动化约束系统，将Harness Engineering方法论转化为可执行的工具链。系统采用Skill + MCP Server双层架构，通过一次性问卷收集项目信息，自动生成完整的约束体系配置。

**核心价值**：
- 将手动配置过程自动化，降低使用门槛
- 基于工程最佳实践提供数据驱动的决策
- 支持渐进增强和个性化调整
- 提供完整的生命周期管理（适用性评估 → 效果验证）

**技术栈**：
- **MCP Server**: TypeScript + Node.js
- **Skill层**: Claude Code Skill（Markdown格式）
- **配置生成**: ESLint, Husky, GitHub Actions, CLAUDE.md, settings.json
- **数据存储**: JSON文件（状态管理、规则数据库）

## 总体时间线

| 阶段 | 时间估算 | 关键里程碑 | 总耗时 |
|------|----------|------------|--------|
| **Phase 1: 核心决策引擎** | 1-2天 | MVP可运行，生成基础配置 | 2天 |
| **Phase 2: 代码分析 + 扩展** | 2-3天 | 完整配置生成，支持代码扫描 | 5天 |
| **Phase 3: 验证 + 优化** | 2天 | 配置验证，自适应调整 | 7天 |
| **Phase 4: 高级功能** | 3-5天 | 可选扩展功能完成 | 12天 |

**总计**: 7-12个工作日（1.5-2.5周）

## Phase 1: 核心决策引擎（1-2天）

### 目标
实现系统核心功能：规则数据库、决策引擎、基础配置生成器。

### 详细任务分解

#### Day 1: 项目初始化与核心引擎
1. **项目结构搭建** (0.5天)
   - 创建MCP Server项目结构
   - 配置TypeScript、ESLint、Prettier
   - 设置package.json依赖

2. **类型定义系统** (0.5天)
   - 实现`types.ts`：RuleDefinition, RuleRecommendation, RuleDecision等接口
   - 定义MCP工具输入输出类型
   - 创建状态管理接口（HarnessState）

3. **规则数据库** (0.5天)
   - 创建`rules.json`：16条内置规则（参考设计文档第7.3节）
   - 实现规则加载和过滤逻辑
   - 添加技术栈过滤功能

4. **决策引擎实现** (0.5天)
   - 实现四问题判定流（`engine.ts`）
   - 实现`_checkFormalizable`, `_adjustCost`, `_estimateFrequency`, `_finalDecision`
   - 集成特殊规则处理（`_specialCases`）

#### Day 2: 配置生成与状态管理
5. **状态管理系统** (0.5天)
   - 实现`state.ts`：状态文件读写
   - 支持状态机：null → evaluated → confirmed → generated → validated
   - 实现断点续做支持

6. **配置生成器** (1天)
   - `claude_md.ts`: CLAUDE.md模板生成
   - `eslint.ts`: ESLint配置生成（支持规则合并）
   - `settings_json.ts`: settings.json生成
   - `gitignore.ts`: .gitignore条目添加
   - 实现dry_run预览模式

7. **MCP Server集成** (0.5天)
   - 实现`index.ts`: MCP Server入口
   - 注册核心工具：`evaluate_rules`, `generate_config`, `query_state`
   - 添加错误处理和日志

8. **Skill层设计** (0.5天)
   - 创建`skill/SKILL.md`: 用户交互流程
   - 实现项目参数收集问卷
   - 集成MCP工具调用

### 交付物
```
mcp-server/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts            # MCP Server 入口
│   ├── engine.ts           # 决策引擎（四问题判定流）
│   ├── rules.json          # 规则数据库（16条内置规则）
│   ├── state.ts            # 状态管理（.harness/state.json）
│   ├── generators/
│   │   ├── claude_md.ts    # CLAUDE.md 生成器
│   │   ├── eslint.ts       # ESLint 配置生成器
│   │   ├── settings_json.ts # settings.json 生成器
│   │   └── gitignore.ts    # .gitignore 生成器
│   └── types.ts            # 类型定义
└── skill/
    └── SKILL.md            # Skill 层工作流
```

### 验收标准
1. ✅ 能够读取规则数据库并过滤
2. ✅ 决策引擎输出合理的介质推荐
3. ✅ 生成CLAUDE.md、ESLint配置、settings.json、.gitignore
4. ✅ dry_run模式正常工作
5. ✅ 状态文件正确保存和读取
6. ✅ Skill能够引导用户完成流程

## Phase 2: 代码分析 + 扩展（2-3天）

### 目标
扩展系统能力：代码扫描、完整配置生成、依赖管理。

### 详细任务分解

#### Day 3: 代码扫描与分析
1. **AST分析器** (1天)
   - 实现`code_scanner.ts`: TypeScript/JavaScript AST解析
   - 检测潜在规则模式（如直接fetch、console.log等）
   - 生成规则建议和置信度评分

2. **CLAUDE.md解析器** (0.5天)
   - 实现`claude_extractor.ts`: 提取现有项目中的规则
   - 解析CLAUDE.md格式，识别规则声明
   - 与内置规则数据库合并

3. **扫描结果集成** (0.5天)
   - 扩展`scan_codebase`工具接口
   - 实现扫描结果与决策引擎的合并逻辑
   - 更新状态管理支持扫描数据

#### Day 4: 扩展配置生成
4. **Husky hook生成器** (0.5天)
   - 实现`husky.ts`: pre-commit, commit-msg hook生成
   - 集成ESLint检查、commitlint验证
   - 支持hook可执行权限设置

5. **CI工作流生成器** (0.5天)
   - 实现`ci.ts`: GitHub Actions工作流生成
   - 包含ESLint检查、测试运行、安全扫描
   - 支持PR检查和工作流触发条件

6. **package.json合并器** (0.5天)
   - 实现`package_json.ts`: 依赖包合并
   - 检测并添加缺失的devDependencies
   - 支持package.json合并策略

7. **依赖管理检查** (0.5天)
   - 实现`deps.ts`: 依赖包安装状态检查
   - 提供安装命令建议
   - 集成到配置验证流程

#### Day 5: 集成与测试
8. **完整流程集成** (1天)
   - 集成所有生成器到主流程
   - 实现`init_harness`快捷入口
   - 添加回滚机制（`rollback`工具）
   - 完善错误处理和用户反馈

### 交付物
```
mcp-server/src/
├── scanners/
│   ├── code_scanner.ts     # AST 分析器
│   └── claude_extractor.ts # CLAUDE.md 解析器
├── generators/
│   ├── husky.ts            # Husky hook 生成器
│   ├── ci.ts               # CI 工作流生成器
│   └── package_json.ts     # package.json 合并器
└── deps.ts                 # 依赖管理检查
```

### 验收标准
1. ✅ 能够扫描代码库发现潜在规则
2. ✅ 解析现有CLAUDE.md中的规则
3. ✅ 生成完整的Husky hooks
4. ✅ 生成GitHub Actions工作流
5. ✅ 正确合并package.json依赖
6. ✅ 依赖检查工具正常工作

## Phase 3: 验证 + 优化（2天）

### 目标
完善系统健壮性：配置验证、效果统计、自适应调整。

### 详细任务分解

#### Day 6: 验证系统
1. **配置验证器** (1天)
   - 实现`validate_setup`工具
   - 检查文件存在性和语法正确性
   - 验证ESLint配置、JSON语法、hook可执行性
   - 提供修复建议和命令

2. **规则效果统计** (0.5天)
   - 实现基础数据收集框架
   - 统计规则触发频率和修复率
   - 存储使用数据到状态文件

3. **自适应调整建议** (0.5天)
   - 基于使用数据提供规则调整建议
   - 实现介质升级/降级推荐逻辑
   - 考虑项目阶段和团队规模变化

#### Day 7: 优化与分享
4. **规则导入/导出** (0.5天)
   - 实现规则配置的序列化/反序列化
   - 支持分享和复用规则集
   - 提供预设配置模板

5. **性能优化** (0.5天)
   - 优化AST扫描性能（增量扫描）
   - 改进决策引擎算法复杂度
   - 添加缓存机制

6. **文档与测试** (1天)
   - 完善用户文档和API文档
   - 创建集成测试套件
   - 测试多种项目场景（参考设计文档第11.1节）

### 交付物
```
mcp-server/src/
├── validators/
│   └── setup_validator.ts  # 配置验证器
├── analytics/
│   └── rule_analytics.ts   # 规则效果统计
└── adapters/
    └── rule_adapter.ts     # 自适应调整
```

### 验收标准
1. ✅ 配置验证工具能检测常见问题
2. ✅ 规则使用数据正确收集
3. ✅ 自适应调整建议合理
4. ✅ 规则导入/导出功能正常
5. ✅ 系统性能满足要求（扫描大型项目<30秒）
6. ✅ 通过所有测试场景

## Phase 4: 高级功能（3-5天）

### 目标
实现可选高级功能：适用性评估、A/B测试、错误信息优化、认知层Skills。

### 详细任务分解

#### Day 8-9: 适用性评估与A/B测试基础
1. **适用性评估器** (1天)
   - 实现`assess_suitability`工具
   - 原型阶段检测（git历史、文件结构）
   - 一次性脚本识别
   - 维护成本评估

2. **A/B测试框架基础** (1天)
   - 实现`start_ab_test`工具
   - 测试配置管理和状态跟踪
   - 基础数据收集框架

3. **数据收集器** (1天)
   - 实现`collect_ab_metrics`工具
   - 从git hooks、CI、linter收集数据
   - 数据标准化和存储

#### Day 10: 分析与优化
4. **统计分析引擎** (1天)
   - 实现`analyze_ab_results`工具
   - 统计显著性检验（t-test, chi-square）
   - 效果大小评估和置信区间计算

5. **错误信息优化框架** (1天)
   - 实现错误信息模板库系统
   - 上下文感知的错误信息生成
   - 集成A/B测试验证效果

#### Day 11-12: 认知层集成
6. **认知层Skills基础** (1天)
   - 实现认知层上下文管理
   - 创建诊断型、教育型、决策支持型Skill框架
   - 基础触发机制

7. **Skill实现与集成** (1天)
   - 实现具体认知层Skills
   - 集成到决策引擎和错误信息生成
   - 用户反馈收集和优化

8. **高级功能集成测试** (1天)
   - 测试高级功能与核心系统的集成
   - 性能基准测试
   - 用户验收测试

### 交付物
```
mcp-server/src/
├── suitability/
│   └── assessor.ts         # 适用性评估器
├── ab_test/
│   ├── manager.ts          # A/B测试管理器
│   ├── collector.ts        # 数据收集器
│   ├── analyzer.ts         # 统计分析引擎
│   └── recommender.ts      # 规则调整推荐
├── error_optimization/
│   ├── templates.ts        # 错误信息模板库
│   ├── generator.ts        # 上下文感知生成器
│   └── evaluator.ts        # 效果评估器
└── cognitive_layer/
    ├── skills/
    │   ├── diagnostic.ts   # 诊断型Skills
    │   ├── educational.ts  # 教育型Skills
    │   └── decision_support.ts # 决策支持型Skills
    ├── orchestrator.ts     # 认知层协调器
    └── context.ts          # 上下文管理
```

### 验收标准
1. ✅ 适用性评估准确识别不适合的场景
2. ✅ A/B测试框架能够正确运行和收集数据
3. ✅ 统计分析提供有意义的结论
4. ✅ 错误信息优化提高修复率
5. ✅ 认知层Skills提供有价值的辅助
6. ✅ 高级功能作为可选模块不影响核心系统

## 依赖关系与风险

### 技术依赖
1. **TypeScript/JavaScript生态**
   - ESLint插件可用性
   - AST解析器（@typescript-eslint/parser）
   - Husky、commitlint兼容性

2. **MCP协议支持**
   - Claude Code MCP Server规范
   - 工具调用和权限管理

3. **目标项目环境**
   - Node.js版本兼容性
   - Git版本控制
   - 包管理器（npm/yarn/pnpm）

### 风险与缓解措施

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|----------|
| **AST分析复杂度高** | 扫描性能差，误报率高 | 中 | 1. 使用成熟的parser库 2. 实现增量扫描 3. 提供可调节的扫描深度 |
| **规则冲突处理复杂** | 生成矛盾配置 | 中 | 1. 实现冲突检测器 2. 提供明确的解决建议 3. 用户确认机制 |
| **配置合并问题** | 破坏现有项目配置 | 高 | 1. 完善的备份机制 2. dry_run预览模式 3. 渐进式合并策略 |
| **用户接受度低** | 工具不被采用 | 中 | 1. 提供清晰的收益说明 2. 渐进式约束强度 3. 完善的文档和示例 |
| **维护成本高** | 规则数据库过时 | 低 | 1. 社区规则共享机制 2. 自动更新检查 3. 向后兼容设计 |

### 团队角色建议
- **1名全栈工程师**：核心开发（Phase 1-3）
- **1名前端/工具链专家**：AST分析、配置生成（Phase 2）
- **1名数据工程师**（兼职）：A/B测试框架、统计分析（Phase 4）
- **1名技术文档工程师**：文档、示例、用户引导

## 成功指标

### 技术指标
1. **决策准确率**：>90%（与人工决策对比）
2. **配置完整性**：100%（生成所有声明文件）
3. **扫描性能**：大型项目（10万行）扫描<30秒
4. **用户满意度**：>80%（通过反馈收集）
5. **规则修复率**：>70%（触发后实际修复比例）

### 业务指标
1. **采用率**：目标团队中>50%的项目使用
2. **配置时间节省**：从数小时减少到<10分钟
3. **错误减少**：约束相关错误减少>60%
4. **团队效率提升**：代码评审时间减少>30%

## 后续演进路线

### v1.1（发布后1个月）
- 更多技术栈支持（Python、Go、Java）
- 社区规则库共享
- 可视化配置仪表板

### v1.2（发布后3个月）
- 机器学习驱动的规则推荐
- 跨项目规则效果分析
- 团队级约束策略管理

### v2.0（发布后6个月）
- 实时协作约束编辑
- 智能冲突解决
- 企业级部署和管理

---

**文档版本**: v1.0  
**创建日期**: 2026-04-23  
**基于设计文档**: `harness-automation-design.md` (v3.0)  
**负责人**: [待分配]  
**下次评审**: Phase 1完成后