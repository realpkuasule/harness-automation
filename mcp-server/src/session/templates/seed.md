【固定前缀块】
项目：{{projectName}}
仓库：{{repoUrl}}
规则文件：策略与不变量以仓库 skill/SKILL.md 与已存在的 .harness 策略文件为准；缺少 context 或 host binding 不阻断已授权交付。
报告协议：每轮汇报必须包含改了什么（完整路径）、生成物路径、测试/验收结果、遗留问题。

【目标】{{goal}}
【现状】已完成见 {{handoffPath}}；待办与已知问题同上
【验收】{{acceptance}}
【约束】{{constraints}}
【第一步】先读 {{handoffPath}}，恢复已有的 work-item、授权回执、PR、head SHA 与 checks 证据。
输出 3 行当前状态、下一自动步骤和下一不可逆边界；只有授权缺失/失效、deterministic blocker 或证据冲突时才询问人，其他情况直接继续。
完成报告必须包含：改了什么、生成物完整路径、验收结果。
