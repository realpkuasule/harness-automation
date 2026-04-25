# Harness Automation Skill

引导用户完成 Harness 约束体系的自动配置流程。本 Skill 实现设计 v3.0 §9 定义的 11 步工作流，包含交互式收集、断点续做、错误恢复。

## 工作流

### Step 1: 检查现有状态（断点续做）

在开始新流程前，先调用 `query_state` 检查项目是否已有进行中的状态：

```
query_state: { projectDir: "<项目绝对路径>" }
```

根据返回的 `phase` 值决定起点：
- `null` → 从 Step 2 开始（全新流程）
- `evaluated` → 从 Step 4 开始（已评估，待确认）
- `confirmed` → 从 Step 6 开始（已确认，待生成）
- `generated` → 从 Step 8 开始（已生成，待验证）
- `validated` → 提示用户配置已完成，询问是否需要重新配置

### Step 2: 收集项目信息

一次性向用户提问以下信息：

1. **项目阶段**：
   - `prototype` — 原型阶段，核心抽象未固定
   - `early` — 早期开发，结构还在变化
   - `growth` — 快速增长，需要约束
   - `mature` — 成熟稳定，严格约束

2. **团队规模**：
   - `solo` — 独立开发者
   - `small` — 2-5 人
   - `medium` — 6-15 人
   - `large` — 15+ 人

3. **技术栈**（可多选）：
   - `typescript` / `javascript` / `python` / `go` / `java` / `generic`

> **AskUserQuestion 话术模板**：
> ```
> 我来帮你配置项目的 Harness 约束体系。先了解一下项目情况：
>
> 1. 项目当前处于什么阶段？
>    - prototype（原型阶段）
>    - early（早期开发）
>    - growth（快速增长期）
>    - mature（成熟稳定期）
>
> 2. 团队规模如何？
>    - solo（独立开发）
>    - small（2-5 人）
>    - medium（6-15 人）
>    - large（15+ 人）
>
> 3. 使用什么技术栈？（可多选）
>    - TypeScript / JavaScript / Python / Go / Java / 其他
> ```

### Step 3: 调用 init_harness 或 evaluate_rules

提供两种入口：

**快捷方式**（推荐）：调用 `init_harness` 一次性完成评估和生成：
```json
{
  "projectDir": "<项目绝对路径>",
  "projectPhase": "<用户选择>",
  "teamSize": "<用户选择>",
  "techStack": ["<用户选择>"]
}
```

**分步方式**：先调用 `evaluate_rules` 仅做评估：
```json
{
  "projectDir": "<项目绝对路径>",
  "projectPhase": "<用户选择>",
  "teamSize": "<用户选择>",
  "techStack": ["<用户选择>"]
}
```

### Step 4: 展示评估结果

将决策结果以用户友好的方式展示：
- 按介质分类列出规则（linter / hook / CI / CLAUDE.md / settings.json）
- 高置信度规则优先展示
- 认知层规则特殊标注（需人工参与）
- 如有冲突规则（`conflicts` 数组非空），提示用户注意并给出解决建议
- 询问用户是否需要调整介质分配

### Step 5: AskUserQuestion — 确认/调整决策

对于需要调整的规则，使用 AskUserQuestion 交互式确认：
```
以下规则建议通过 linter 自动执行：
- no-console-log（置信度 0.85）
- type-annotations（置信度 0.85）
...

是否需要将某条规则调整到其他介质？
```

如果用户要求调整，记录修改后的决策列表。

### Step 6: 确认决策

调用 `confirm_decisions` 工具将用户确认的决策写入状态：
```json
{
  "projectDir": "<项目绝对路径>",
  "decisions": [<用户确认或调整后的决策列表>]
}
```

系统将状态推进到 `confirmed`，记录确认时间。只有状态为 `evaluated`/`confirmed`/`generated`/`validated` 时允许确认。

### Step 7: 生成配置文件

确认后，调用 `generate_config` 工具生成配置文件：
```json
{
  "projectDir": "<项目绝对路径>",
  "decisions": []
}
```

将生成以下文件：
- **CLAUDE.md** — 软约束（认知层规则 + 参考规则列表）
- **ESLint 配置** — 硬约束（自动检查）
- **.claude/settings.json** — Claude 设置（formatOnSave 等）
- **.gitignore** — 追加 Harness 相关忽略条目

可选：先使用 `dryRun: true` 预览生成内容，用户确认后再正式执行。

### Step 8: 验证配置完整性

调用 `validate_setup` 验证生成的文件：
```json
{
  "projectDir": "<项目绝对路径>"
}
```

检查：
- 所有必需文件是否存在
- 语法是否正确（JSON 解析、YAML 结构）
- 文件权限是否正确（hook 可执行）
- 依赖是否已安装

检查 `summary.status`：
- `"pass"` → 验证通过
- `"warn"` → 有警告但不影响使用（如 missing .gitignore entries）
- `"fail"` → 有错误需要修复

### Step 9: 错误恢复引导

如果 Step 8 验证失败，引导用户修复：

**文件缺失** → 重新调用 `generate_config`：
```
部分配置文件未生成，重新运行 generate_config 将自动补充缺失文件。
```

**语法错误** → 指出具体文件和错误位置，建议手动修复或回滚：
```
CLAUDE.md 格式有误，请检查后重试。如需回滚到之前状态：
- 使用 rollback 查看备份：{ list: true }
- 使用 rollback 恢复：{ backupId: "<id>" }
```

**依赖缺失** → 提示安装命令：
```
缺少依赖 eslint，请运行：npm install --save-dev eslint
```

### Step 10: 展示下一步指南

指导用户后续操作：

1. **启用 Husky 钩子**（如生成了 hook 规则）：
   ```
   cd <项目目录> && npx husky init
   ```
   验证钩子生效：`npx husky`

2. **查看状态**：使用 `query_state` 随时查看当前状态

3. **监控效果**：使用 `get_rule_stats` 查看规则触发/修复/绕过统计

4. **规则调整**：使用 `analyze_rule_adjustments` 获取介质调整建议

5. **规则导入导出**：使用 `export_rules` / `import_rules` 备份或迁移配置

### Step 11: 收尾

- 告知用户配置已完成
- 提醒可以随时通过 `query_state` 查看状态
- 提醒可以通过 `rollback` 回滚配置
- 提醒可以通过 `analyze_rule_adjustments` 获取优化建议

## 使用示例

```
我来帮你配置项目的 Harness 约束体系。

首先，请告诉我：
1. 项目当前处于什么阶段？（prototype/early/growth/mature）
2. 团队有几人？
3. 使用什么技术栈？

...
```

## 错误处理

| 场景 | 处理方式 |
|------|---------|
| 状态异常 | 调用 `reset_state` 重新开始 |
| 文件冲突 | 自动备份后覆盖，可通过 `rollback` 恢复 |
| 验证失败 | 根据 `findings` 逐项修复 |
| 依赖缺失 | 提示安装命令 |
