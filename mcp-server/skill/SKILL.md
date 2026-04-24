# Harness Automation Skill

引导用户完成 Harness 约束体系的自动配置流程。

## 工作流

### Step 1: 收集项目信息

向用户提以下问题（一次性收集）：

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

### Step 2: 评估规则

调用 `evaluate_rules` 工具：

```
projectDir: <项目绝对路径>
projectPhase: <用户选择>
teamSize: <用户选择>
techStack: [<用户选择>]
```

### Step 3: 展示结果

将决策结果以用户友好的方式展示：
- 按介质分类列出规则
- 高置信度规则优先
- 认知层规则特殊标注
- 询问用户是否需要调整

### Step 4: 确认决策

调用 `confirm_decisions` 工具将用户确认的决策写入状态：

```
projectDir: <项目绝对路径>
decisions: [<用户确认或有调整后的决策列表>]
```

系统将状态推进到 `confirmed`，记录确认时间。只有状态为 `evaluated`/`confirmed`/`generated`/`validated` 时允许确认。

### Step 5: 生成配置

确认后，调用 `generate_config` 工具：

- 生成 CLAUDE.md（软约束）
- 生成 ESLint 配置（硬约束）
- 生成 settings.json（harness 强制）
- 生成 .gitignore 条目

### Step 6: 验证与后续

- 提示用户验证生成的文件
- 展示状态查询方法
- 提供回滚建议

## 使用示例

```
我来帮你配置项目的 Harness 约束体系。

首先，请告诉我：
1. 项目当前处于什么阶段？（prototype/early/growth/mature）
2. 团队有几人？
3. 使用什么技术栈？

...
```
