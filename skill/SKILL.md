---
name: harness-automation
description: >
  为项目自动建立约束体系。当用户说"建立约束体系"、"初始化约束"、"设置harness"、"配置项目约束"、
  "setup harness"、"给我的项目加规则"、"检查项目约束"、"回滚约束配置"、"harness自动化"、
  "配置项目规则"、"应用项目规范"时触发。
---

# Harness Automation Skill

为项目自动建立工程约束体系。通过评估项目规则、生成配置文件、验证配置完整性，帮助项目建立有效的约束体系。

---

## 工作流

### Step 0: 适用性评估

调 MCP 工具 `assess_suitability`，参数：

```json
{
  "projectDir": "<项目绝对路径>",
  "analysisDepth": "quick"
}
```

**根据返回结果判断**:
- `suitable === true` → 继续 Step 1
- `suitable === false` → 向用户说明原因（score/reason/warnings），AskUserQuestion 是否仍然继续。如果用户选择否，结束流程。
- 注意 warnings 数组：`type: "prototype"` 表示项目尚不成熟，`type: "script"` 表示缺少依赖管理

### Step 1: 断点续做检查

调 MCP 工具 `query_state`，参数：

```json
{
  "projectDir": "<项目绝对路径>"
}
```

**根据 phase 值决定路径**:

| phase 值 | 含义 | 跳转到 |
|----------|------|--------|
| `"validated"` | 已完成所有配置 | AskUserQuestion：已完成全部配置，是否重新生成或仅检查现有配置？重新生成 → 重置 state 从 Step 2 开始；仅检查 → 调 validate_setup 后结束 |
| `"generated"` | 已生成配置文件 | 跳过 Step 2-7，从 **Step 8** (validate_setup) 继续 |
| `"confirmed"` | 已确认决策 | 跳过 Step 2-6，从 **Step 7** (generate_config) 继续 |
| `"evaluated"` | 已评估规则 | 跳过 Step 2-3，从 **Step 4** 继续 |
| `null` | 全新开始 | 从 **Step 2** 继续 |

### Step 2: 收集项目信息

AskUserQuestion 收集以下信息（一次问完）：

**1. 技术栈（单选）**:
- "Next.js + TypeScript" → 映射为 `techStack: ["typescript"]`
- "React + Vite + TypeScript" → 映射为 `techStack: ["typescript"]`
- "Node.js + TypeScript" → 映射为 `techStack: ["typescript"]`
- "纯 JavaScript" → 映射为 `techStack: ["javascript"]`
- "Python" → 映射为 `techStack: ["python"]`
- "Go" → 映射为 `techStack: ["go"]`
- "Java" → 映射为 `techStack: ["java"]`
- "其他 / 不确定" → 映射为 `techStack: ["generic"]`

**2. 项目阶段（单选）**:
- "原型期 / 刚起步" → 映射为 `projectPhase: "prototype"`
- "功能开发期 / 快速增长" → 映射为 `projectPhase: "early"`（或 `"growth"`—根据描述判断规模）
- "稳定维护期 / 成熟项目" → 映射为 `projectPhase: "mature"`

**3. 团队规模（单选）**:
- "1-2 人" → 映射为 `teamSize: "solo"`
- "3-5 人" → 映射为 `teamSize: "small"`
- "5-10 人" → 映射为 `teamSize: "medium"`
- "10 人以上" → 映射为 `teamSize: "large"`

**4. Git 平台（单选）**:
- "GitHub" → 映射为 `gitProvider: "github"`
- "GitLab" → 映射为 `gitProvider: "gitlab"`
- "双远程（GitHub 个人备份 + GitLab 团队协作）" → 映射为 `gitProvider: "both"`

**5. 协作模式（单选）**:
- "个人项目" → 映射为 `collaborationMode: "solo"`
- "团队协作（2+ 人）" → 映射为 `collaborationMode: "team"`

### Step 3: evaluate_rules

调 MCP 工具 `evaluate_rules`，参数：

```json
{
  "projectDir": "<项目绝对路径>",
  "techStack": ["<根据 Step 2 映射的值>"],
  "projectPhase": "<根据 Step 2 映射的值>",
  "teamSize": "<根据 Step 2 映射的值>"
}
```

返回结果包含：
- `decisions`: 规则推荐列表（每条含 ruleId、recommendedMedium、confidence、reasons 等）
- `conflicts`: 规则冲突列表
- `summary`: 统计信息（total, byMedium, highConfidence, cognitiveRequired）

**检查返回结果**:
- 如果有 `conflicts`，向用户说明冲突内容以及引擎给出的解决方案
- 如果 `decisions` 为空数组，说明没有适用的规则，向用户说明后结束流程

### Step 4: 是否扫描代码库

AskUserQuestion: "是否需要扫描现有代码库，检测已有违规模式和可以发现的自定义规则？"

**如果用户选择"是"**:
调 MCP 工具 `scan_codebase`，参数：

```json
{
  "projectDir": "<项目绝对路径>",
  "techStack": ["<同 Step 3>"],
  "scanDepth": "full",
  "useCache": false
}
```

将扫描发现合并到规则推荐列表中（向用户说明扫描结果）。

**如果用户选择"否"**: 跳过此步。

### Step 5: 展示推荐 + 用户确认

向用户展示完整的规则推荐列表。展示格式：

```
规则 1: <ruleName>
  - 推荐介质: <recommendedMedium>
  - 依据: <reason>
  - 置信度: <confidence>
  - 是否需要认知层支持: <cognitiveLayerRequired>

规则 2: <ruleName>
  ...
```

AskUserQuestion × 1: "是否接受全部推荐规则？"

**如果接受**: 直接进入 Step 6。

**如果不接受**: AskUserQuestion 逐条调整。让用户选择：
- 对每条规则选择介质：`linter_error` / `linter_warn` / `linter+hook` / `claude_md` / `ci` / `hook` / `settings` / `none`
- 或者完全禁用某条规则（`recommendedMedium: "none"`）

### Step 6: confirm_decisions

调 MCP 工具 `confirm_decisions`，参数：

```json
{
  "projectDir": "<项目绝对路径>",
  "decisions": [
    {
      "ruleId": "<ruleId>",
      "recommendedMedium": "<用户确认或调整后的介质>"
    }
  ]
}
```

**注意**: decisions 数组传入确认后的完整决策列表。如果用户接受了全部推荐，从 Step 3 的返回中提取 decisions 数组；如果用户做了调整，使用调整后的值。

**检查返回**: 确保 status 为 "confirmed"，如有错误向用户说明。

### Step 7: generate_config（先 dry_run 预览）

**Step 7a — dry_run 预览**:

调 MCP 工具 `generate_config`，参数：

```json
{
  "projectDir": "<项目绝对路径>",
  "decisions": [<同 Step 6 的 decisions>],
  "dryRun": true
}
```

向用户展示预览信息：
- 将要创建的文件列表
- 将要修改的文件列表
- 将要跳过的文件列表

**Step 7b — 确认生成**:

AskUserQuestion: "以上是预览结果，确认生成这些配置文件？"

**如果确认**: 调 MCP 工具 `generate_config`，参数相同但 `dryRun: false`：

```json
{
  "projectDir": "<项目绝对路径>",
  "decisions": [<同 Step 6 的 decisions>],
  "dryRun": false
}
```

向用户展示生成结果（files summary、errors 等）。

**如果取消**: 回到 Step 5 让用户重新确认。

**检查返回中的 errors**: 如果有文件写入错误，向用户说明并提供修复建议。同时检查 backupDir，确保备份已创建。

### Step 8: validate_setup

调 MCP 工具 `validate_setup`，参数：

```json
{
  "projectDir": "<项目绝对路径>"
}
```

**根据 status 处理**:
- `"pass"` → 向用户报告验证通过 ✅
- `"warn"` → 显示 warnings 列表，向用户说明注意事项
- `"fail"` → 显示 errors 列表，进入 Step 9 错误恢复

### Step 9: 错误恢复

**当 validate_setup 返回 fail 或用户不满意当前结果时**:

AskUserQuestion: "是否回滚到之前的状态？回滚将恢复备份并清理新生成的文件。"

**如果确认回滚**:

调 MCP 工具 `rollback`，参数：

```json
{
  "projectDir": "<项目绝对路径>"
}
```

（不指定 backupId 则回滚到最新备份）

**检查返回**:
- `status: "success"` → 向用户报告回滚成功
- `status: "partial"` → 显示成功和失败的文件列表
- `status: "failed"` → 报告错误

回滚完成后，AskUserQuestion 是否要重新从 Step 5 开始。

**如果选择不回滚**: 向用户说明可以稍后手动回滚（调 rollback 工具并指定 list=true 查看可用备份）。

### Step 10: A/B 测试（可选）

AskUserQuestion: "是否启动规则效果评估？可以跟踪规则触发率、修复率和绕过率，帮助你持续优化约束体系。"

**如果用户选择"是"**: 引导用户使用以下工具：

1. `start_ab_test` — 启动测试（指定 ruleId、baselineMedium、testMedium）
2. `collect_ab_metrics` — 收集数据点（triggerCount、fixRate、bypassCount）
3. `analyze_ab_results` — 分析结果（返回统计显著性和推荐操作）

具体参数由用户根据想要测试的规则决定。

**如果用户选择"否"**: 跳过此步。

### Step 11: 完成

向用户输出完成摘要：

```
## Harness 约束体系配置完成 ✅

### 已应用的配置
- 规则数量: <total>
- 配置文件: <files 列表>
- 备份位置: .harness/backups/<timestamp>/

### 介质分布
- linter_error: <n>
- linter_warn: <n>
- ...

### 后续建议
- 运行 npm install 安装缺失依赖
- 提交生成的配置文件到版本控制
- 启动效果评估跟踪规则效果
- 使用 `suggest_error_improvement` 查看错误信息模板效果
```

---

### Team/GitLab Mode — Additional Steps

When `gitProvider` is "gitlab" or "both", and `collaborationMode` is "team":

**After generation, the Tech Lead should:**

1. **Configure GitLab project settings**: Review and run the generated script
   ```bash
   bash scripts/gitlab-configure.sh
   ```
   Review the curl commands and execute with a GitLab Personal Access Token.

2. **Read the settings documentation**: `docs/gitlab-settings.md` contains Web UI alternatives.

3. **Verify `.gitlab-ci.yml`**: Ensure CI/CD pipeline is enabled in GitLab project settings.

4. **Distribute to team**: Commit all generated files and ask team members to:
   ```bash
   git pull
   bash scripts/onboard.sh
   ```

5. **Configure GitLab CI variables**: Add `AI_REVIEW_API_KEY` as a CI/CD variable for AI code review.

**For team members onboarding:**
```bash
bash scripts/onboard.sh
```

---

## 枚举映射表

当用户在 AskUserQuestion 中选择友好值后，调用 MCP 工具时需要映射为枚举值：

| 用户选择 | MCP 枚举值 |
|----------|-----------|
| **技术栈** | |
| Next.js + TypeScript | `["typescript"]` |
| React + Vite + TypeScript | `["typescript"]` |
| Node.js + TypeScript | `["typescript"]` |
| 纯 JavaScript | `["javascript"]` |
| Python | `["python"]` |
| Go | `["go"]` |
| Java | `["java"]` |
| 其他 / 不确定 | `["generic"]` |
| **项目阶段** | |
| 原型期 / 刚起步 | `"prototype"` |
| 功能开发期 | `"early"` |
| 快速增长期 | `"growth"` |
| 稳定维护期 / 成熟 | `"mature"` |
| **团队规模** | |
| 1-2 人 | `"solo"` |
| 3-5 人 | `"small"` |
| 5-10 人 | `"medium"` |
| 10 人以上 | `"large"` |
| **Git 平台** | |
| GitHub | `"github"` |
| GitLab | `"gitlab"` |
| 双远程 | `"both"` |
| **协作模式** | |
| 个人项目 | `"solo"` |
| 团队协作 | `"team"` |

---

## 异常处理

每个 MCP 工具调用后，必须检查响应中的 errors/warnings：

- **可恢复错误** (recoverable: true): 向用户说明，提供建议操作
- **不可恢复错误** (recoverable: false): 向用户报告，建议查看日志
- **文件写入错误**: 检查 backupDir，建议手动恢复
- **状态文件缺失**: 提示用户先运行 evaluate_rules

**通用模式**:

```
调 MCP 工具 ← 检查 isError / errors 数组
  ├── 无错误 → 继续下一步
  ├── 可恢复错误 → 显示错误 + AskUserQuestion 下一步操作
  └── 不可恢复错误 → 显示错误 + 结束流程
```

---

## 触发短语

| 用户说 | 触发动作 |
|--------|---------|
| "建立约束体系" | 完整 11 步流程 |
| "初始化约束" | 完整 11 步流程 |
| "设置harness" | 完整 11 步流程 |
| "配置项目约束" | 完整 11 步流程 |
| "setup harness" | 完整 11 步流程 |
| "给我的项目加规则" | 完整 11 步流程 |
| "应用项目规范" | 完整 11 步流程 |
| "检查项目约束" | 仅调 validate_setup |
| "回滚约束配置" | 仅调 rollback (默认最新备份) |
| "查看约束状态" | 仅调 query_state |
| 其他无关任务 | 不触发 |
