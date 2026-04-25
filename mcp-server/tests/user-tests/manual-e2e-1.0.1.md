# Harness E2E 手动走查 v1.0.1

用一个测试项目把整个工具跑一遍，看看每个环节的效果。

---

## 准备

```bash
# 1. 创建测试项目
mkdir -p /tmp/harness-e2e/src
cd /tmp/harness-e2e

# 2. 放一个有问题的源文件
cat > src/index.ts << 'EOF'
console.log("hello");
debugger;
if (x > 30000) return;
EOF

# 3. 放一个 package.json（验证器会检查）
echo '{"name":"test","version":"0.0.0"}' > package.json

# 4. 构建 server
cd /Users/zhichao/claude/harness/mcp-server && npm run build
```

**测试方式**：用 MCP Inspector（`npx @modelcontextprotocol/inspector node dist/index.js`）或 Claude Desktop，逐个调用工具。

---

## 第一步：评估规则

**工具：`evaluate_rules`**

参数：
```
projectDir: /tmp/harness-e2e
projectPhase: growth
teamSize: medium
techStack: ["typescript"]
```

看返回：
- ✅ 有 `decisions` 数组，里面一条条规则
- ✅ 每条有 confidence (0~1)、recommendedMedium、reasons
- ✅ `summary.total` = decisions 数量
- ✅ `summary.byMedium` 列了至少 3 种类型

再看磁盘：
- ✅ `.harness/state.json` 已创建，`status: "evaluated"`

再试试不同阶段：
```bash
# 分别调用两次 evaluate_rules，对比结果
# 第一次：phase=prototype, teamSize=solo
# 第二次：phase=mature, teamSize=large
```
- ✅ prototype 的 hook/ci 建议 ≤ mature 的 hook/ci 建议

---

## 第二步：确认决策 + 生成配置

**工具：`confirm_decisions`**

把上一步返回的 decisions 取前 2~3 条（完整字段），传回来。

```
projectDir: /tmp/harness-e2e
decisions: [第一条, 第二条]  ← 从 evaluate_rules 返回值里复制
```

- ✅ 返回 `status: "confirmed"`
- ✅ `query_state` 看到的 status 也是 `confirmed`

**工具：`generate_config`**

```
projectDir: /tmp/harness-e2e
decisions: []
```

看返回：
- ✅ `files[]` 里列出了生成的文件
- ✅ 一定包含 `CLAUDE.md`、`.claude/settings.json`、`.gitignore`
- ✅ 可能还有 `eslint.config.json`、`.husky/`、`.github/workflows/ci.yml`
- ✅ `query_state` 的 status 变成 `generated`

此时磁盘上**还没有**这些文件（server 只返回内容，客户端负责写入）。

---

## 第三步：一键初始化

**工具：`init_harness`**

```bash
# 为了备份测试，换一个新目录
mkdir -p /tmp/harness-e2e-init
cd /tmp/harness-e2e-init
echo '{"name":"test","version":"0.0.0"}' > package.json
```

```
projectDir: /tmp/harness-e2e-init
projectPhase: growth
teamSize: medium
techStack: ["typescript"]
```

- ✅ 返回 `files[]`，内容跟 `generate_config` 一样
- ✅ `summary.backupDir: null`（第一次，没东西可备份）

**关键一步**：把文件写到磁盘（如果用的是 Claude Desktop 它会自动写，MCP Inspector 需要手动复制内容保存）：

```bash
# 把 init_harness 返回的文件写到磁盘
# CLAUDE.md → /tmp/harness-e2e-init/CLAUDE.md
# .claude/settings.json → /tmp/harness-e2e-init/.claude/settings.json
# .gitignore → /tmp/harness-e2e-init/.gitignore
# 等等
```

写完后看一眼内容：
- ✅ `CLAUDE.md` 开头有 `# ... Harness Rules`，末尾有版本号
- ✅ `.claude/settings.json` 是合法 JSON
- ✅ `.husky/pre-commit` 以 `#!/bin/sh` 开头（如果有）
- ✅ `.github/workflows/ci.yml` 有 name/on/jobs（如果有）

```bash
# hook 文件需要加执行权限，否则验证器会报错
chmod +x .husky/pre-commit .husky/commit-msg 2>/dev/null || true
```

**再调一次 `init_harness`**（同样参数）：
- ✅ `summary.backupDir` 不为 null（有了备份）
- ✅ `.harness/backups/` 下有备份目录
- ✅ 备份目录里有刚才生成的文件

---

## 第四步：回滚

**工具：`rollback`**

```bash
# 先改一下 CLAUDE.md
echo "MANUALLY MODIFIED" >> /tmp/harness-e2e-init/CLAUDE.md
```

```
projectDir: /tmp/harness-e2e-init
```
（不指定 backupId，用最新的）

- ✅ 返回 `Restored from backup '...'`
- ✅ `restored[]` 列出恢复的文件
- ✅ CLAUDE.md 内容回到备份版本（不再含 "MANUALLY MODIFIED"）

`list: true` 查看备份：
- ✅ 返回 `backups[]`，每个有 id、files、createdAt

---

## 第五步：验证配置

**工具：`validate_setup`**

```
projectDir: /tmp/harness-e2e-init
```

- ✅ `summary.passed: true`
- ✅ `summary.errors: 0`

```bash
# 删除 CLAUDE.md，再验证一次
rm /tmp/harness-e2e-init/CLAUDE.md
```
```
projectDir: /tmp/harness-e2e-init
```
- ✅ `summary.passed: false`
- ✅ findings 里有 `File not found: CLAUDE.md`

---

## 第六步：代码扫描

```bash
# 回到有代码的项目
cd /tmp/harness-e2e
```

**工具：`scan_codebase`**

```
projectDir: /tmp/harness-e2e
techStack: ["typescript"]
projectPhase: growth
teamSize: medium
```

- ✅ `scanSummary.suggestions` 包含 `no-console-log`、`no-debugger`、`no-magic-numbers`
- ✅ `decisions` 有规则列表
- ✅ `query_state` 的 status=evaluated

再加一个 CLAUDE.md：
```bash
cat > /tmp/harness-e2e/CLAUDE.md << 'EOF'
### my-custom-rule
This is a custom project rule.
EOF
```
再扫一次：
- ✅ `extractedRules > 0`
- ✅ decisions 里出现了 `my-custom-rule`

---

## 第七步：统计与导出

**工具：`get_rule_stats`**

```
projectDir: /tmp/harness-e2e
collect: true
```

- ✅ 有 `summary`（totalRules、byMedium、averageConfidence）
- ✅ 有 `rules[]`
- ✅ `.harness/analytics.json` 已创建

**工具：`analyze_rule_adjustments`**

```
projectDir: /tmp/harness-e2e
```

- ✅ 有 `summary`（total、upgrade、downgrade、keep）
- ✅ `total = upgrade + downgrade + keep`

**工具：`export_rules`**

```
projectDir: /tmp/harness-e2e
saveToFile: false
```

- ✅ `export.version = "1.0"`
- ✅ `export.rules[]` 有数据

```
saveToFile: true
filename: "my-export.json"
```

- ✅ `savedPath` 是完整路径
- ✅ 文件在磁盘上，内容合法 JSON

**工具：`list_rule_exports`**
- ✅ 列表里有 `my-export.json`

**工具：`import_rules`**（预设导入）

```
presetId: "web-app-ts"
```

- ✅ `total: 16`
- ✅ `decisions` 被 enrich 为完整字段

**工具：`list_rule_presets`**
- ✅ 无参数返回 5 个预设
- ✅ `techStack: ["python"]` 过滤后更少

---

## 第八步：清理

**工具：`reset_state`**

```
projectDir: /tmp/harness-e2e
```

- ✅ 返回 `State reset successfully`
- ✅ `query_state` 的 status=null

---

## 走查清单

| # | 步骤 | 结果 |
|---|------|------|
| 1 | evaluate_rules 返回 decisions + summary | □ 通过 |
| 2 | confirm_decisions 确认后 state.confirmed | □ 通过 |
| 3 | generate_config 返回文件列表 | □ 通过 |
| 4 | init_harness 一键生成（含备份） | □ 通过 |
| 5 | rollback 恢复被修改的文件 | □ 通过 |
| 6 | validate_setup 通过 + 缺失检测 | □ 通过 |
| 7 | scan_codebase 检测代码问题 | □ 通过 |
| 8 | get_rule_stats 收集统计 | □ 通过 |
| 9 | analyze_rule_adjustments 出建议 | □ 通过 |
| 10 | export/import 规则可移植 | □ 通过 |
| 11 | 异常情况优雅处理 | □ 通过 |
| 12 | reset_state 重置状态 | □ 通过 |

---

## 几个实际发现（供参考）

- `confirm_decisions` 接受精简格式 `{ruleId, recommendedMedium}`，缺少的字段会自动 enrich（信心值默认 0.8）
- `init_harness` / `generate_config` **不写磁盘**，只返回内容。Claude Desktop 会帮你写，MCP Inspector 需要手动保存
- `validate_setup` 会检查 `package.json` 存在性和 hook 文件的可执行权限
- magic number 检测跳过 `const x = 数字` 这种写法，用 `if (x > 30000)` 才能触发
- `export_rules` 返回的 `savedPath` 是绝对路径

*Test plan generated by Harness Automation System v1.0 — 2026-04-24*
