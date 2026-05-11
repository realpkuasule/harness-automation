# Harness Automation — Claude Code Skill Usage Guide

> 将 Harness Automation 作为 Claude Code Skill 使用，为任意项目自动建立工程约束体系。

---

## 快速开始

### 前置条件

- **Claude Code** 已安装并可用
- 目标项目是 **Git 仓库**
- 已安装 **Node.js >= 18**

### 安装

```bash
# 1. 进入目标项目目录
cd /path/to/your-project

# 2. 运行安装脚本
/path/to/harness-automation/skill/install.sh

# 3. 在 Claude Code 中触发
claude
# 然后输入: "给我的项目建立约束体系"
```

安装脚本会：
1. 通过 `claude mcp add --scope user` 注册 MCP Server（写入 `~/.claude.json`）
2. 安装 SKILL.md 到 `~/.claude/skills/harness-automation/`
3. 将规则数据库复制到 `.harness/rules.json`

### 验证安装

在目标项目目录中打开 Claude Code，输入：

```
检查项目约束
```

如果返回验证结果，说明安装成功。

---

## 工作流说明

当触发 `harness-automation` Skill 后，Claude Code 会按以下步骤自动执行：

### Step 0: 适用性评估

系统自动检查项目是否适合应用约束体系：

- **Git 历史** — 检查提交次数（>3 次为佳）
- **文件结构** — 检查源文件数量
- **依赖管理** — 检查 package.json / requirements.txt 等
- **测试覆盖** — 检查测试文件存在性

**可能的结果**：
| 评估结果 | 含义 | 建议 |
|---------|------|------|
| `suitable: true` | 项目适合 | 继续工作流 |
| 警告: prototype | Git 历史太浅或文件太少 | 可继续，但建议积累更多 |
| 警告: script | 无依赖管理文件 | 先建立依赖管理 |
| 警告: overhead | 项目太小收益有限 | 可继续，预期收益较低 |

### Step 1: 断点续做

如果之前进行过半的配置流程，系统自动从断点处继续：

| 上次完成状态 | 跳过步骤 | 从哪里继续 |
|-------------|---------|-----------|
| 已评估规则 (evaluated) | Step 0-3 | Step 4 询问是否扫描 |
| 已确认决策 (confirmed) | Step 0-6 | Step 7 生成配置 |
| 已生成文件 (generated) | Step 0-7 | Step 8 验证 |
| 已验证完成 (validated) | 全部 | 询问是否重新生成 |

### Step 2: 信息收集

系统会一次问完三个问题：

1. **技术栈** — 选择项目使用的技术
2. **项目阶段** — 原型期 / 功能开发期 / 稳定维护期
3. **团队规模** — 1-2人 / 3-5人 / 5-10人 / 10人以上

> 所有信息只用于规则推荐，不会被上传或共享。

### Step 3: 规则评估

系统自动加载规则数据库，根据项目信息过滤并推荐适用规则。每条规则附带：

- **推荐介质**（约束强度）
- **依据说明**（为什么推荐这条规则）
- **置信度**（推荐的确信程度）
- **认知层需求**（是否需要额外解释支持）

### Step 4: 代码库扫描（可选）

询问是否需要扫描现有代码库。如果选择"是"，系统会分析代码中已经存在的违规模式，并合并到推荐结果中。

**扫描内容**：
- ESLint 配置中已有的规则
- CLAUDE.md 中已有的约束
- 代码中存在的违规模式

### Step 5: 推荐确认

系统展示完整的规则推荐列表，你可以：

- **全部接受** — 直接确认
- **逐条调整** — 修改每条规则的约束介质
- **禁用规则** — 将某条规则设为 `none`

**约束介质强度**（从强到弱）：
| 介质 | 说明 | 适用场景 |
|------|------|---------|
| `linter_error` | ESLint 错误级别 | 必须遵守的规则 |
| `linter_warn` | ESLint 警告级别 | 建议遵守 |
| `linter+hook` | Lint + Git Hooks 双重检查 | 关键规则 |
| `claude_md` | CLAUDE.md 文档约束 | 知会性规则 |
| `hook` | 仅 Git Hooks | 提交前检查 |
| `ci` | 仅 CI 检查 | PR 时检查 |
| `settings` | IDE 设置 | 辅助性 |
| `none` | 禁用 | 不使用 |

### Step 6: 确认决策

将最终确认的决策写入状态文件。

### Step 7: 生成配置

**先预览，再生成**：

1. 系统先以 `dryRun=true` 模式运行，显示将要创建/修改的文件
2. 用户确认后再实际写入

**生成的文件**：
| 文件 | 说明 |
|------|------|
| `CLAUDE.md` | 项目约束说明文档 |
| `eslint.config.js` | ESLint 配置 |
| `.claude/settings.json` | Claude Code 设置 |
| `.gitignore` | Git 忽略规则追加 |
| `.husky/pre-commit` | Git Hooks（可选） |
| `.husky/commit-msg` | 提交信息检查（可选） |
| `.github/workflows/ci.yml` | CI 工作流（可选） |

写文件前自动备份现有文件到 `.harness/backups/{timestamp}/`。

### Step 8: 验证

验证所有已生成文件的完整性、语法正确性和依赖完整性。

### Step 9: 回滚

如果验证失败或不满意结果：

```
系统: "检测到 N 个错误，是否回滚到之前的状态？"
用户: "是"
→ 自动恢复到备份状态
```

### Step 10: 效果评估（可选）

启动 A/B 测试跟踪规则效果：
- **触发率** — 规则被触发的频率
- **修复率** — 触发后实际修复的比例
- **绕过率** — 故意绕过规则的比例

---

## 触发短语

在 Claude Code 中输入以下任一短语即可触发：

| 触发短语 | 动作 |
|---------|------|
| "给我的项目建立约束体系" | 完整 11 步工作流 |
| "初始化约束" | 完整 11 步工作流 |
| "设置harness" | 完整 11 步工作流 |
| "配置项目约束" | 完整 11 步工作流 |
| "setup harness" | 完整 11 步工作流 |
| "给我的项目加规则" | 完整 11 步工作流 |
| "应用项目规范" | 完整 11 步工作流 |
| "检查项目约束" | 仅运行 validate_setup |
| "回滚约束配置" | 仅运行 rollback（最新备份） |
| "查看约束状态" | 仅运行 query_state |

---

## 认知层 Skills

Harness Automation 内置三种认知层技能，提供更深层次的帮助：

### 诊断型（diagnostic）

分析代码问题，提供根因分析和修复建议。

**触发方式**：
```
调 cognitive_skill({ skillType: "diagnostic", ruleId: "xxx", codePattern: "..." })
```

### 教育型（educational）

解释规则原理，提供学习资源和最佳实践。

**自动触发**：当同一规则在短期内反复触发时，系统会自动检测并提供教育型帮助。

### 决策支持型（decision-support）

在复杂决策场景（如规则冲突时）提供权衡分析和推荐方案。

---

## 常见问题

### 安装后 Claude Code 不识别触发短语？

确认 MCP Server 已注册。可以通过以下命令查看：

```bash
# 查看已注册的 MCP 服务器列表
claude mcp list

# 确认输出中包含 harness-automation
```

如果没有注册，手动添加：

```bash
claude mcp add --scope user harness-automation \
  node /path/to/harness/mcp-server/dist/index.js
```

添加后重新启动 Claude Code 生效。

### 如何更新规则数据库？

重新运行安装脚本即可更新 `.harness/rules.json`：

```bash
./skill/install.sh --dir /path/to/project
```

### 如何完全卸载？

```bash
# 1. 从 Claude Code 中移除 MCP Server
claude mcp remove harness-automation

# 2. 删除 .harness/ 目录（可选，包含备份和状态）
rm -rf .harness
```

### 回滚后文件仍然有问题？

可以选择指定备份 ID 回滚到特定版本：

```bash
# 先列出可用备份
rollback({ projectDir: ".", list: true })
# 回滚到指定备份
rollback({ projectDir: ".", backupId: "2026-04-25T19-00-00-000Z" })
```

---

## 进阶：MCP 工具参考

完整工具列表和详细参数请参考 [OpenAPI 规范](./api/openapi.yaml)。核心工具：

| 工具 | 作用 | Skill 调用时机 |
|------|------|---------------|
| `assess_suitability` | 评估项目适用性 | Step 0 |
| `query_state` | 查询当前状态，断点续做 | Step 1 |
| `evaluate_rules` | 评估并推荐规则 | Step 3 |
| `scan_codebase` | 扫描代码库发现违规 | Step 4 |
| `confirm_decisions` | 确认决策并持久化 | Step 6 |
| `generate_config` | 生成配置文件 | Step 7 |
| `validate_setup` | 验证配置完整性 | Step 8 |
| `rollback` | 回滚到备份状态 | Step 9 |
| `cognitive_skill` | 认知层技能调用 | 满足条件时自动触发 |
| `suggest_error_improvement` | 错误信息模板优化建议 | 独立工具 |
| `start_ab_test` | 启动 A/B 测试 | Step 10 |
| `collect_ab_metrics` | 收集 A/B 测试数据 | Step 10 |
| `analyze_ab_results` | 分析 A/B 测试结果 | Step 10 |
