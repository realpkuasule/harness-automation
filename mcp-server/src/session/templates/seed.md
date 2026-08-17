【固定前缀块】
项目：{{projectName}}
仓库：{{repoUrl}}
规则文件：先运行 harness `context` 并读取 .harness/generated/effective-policy.md；策略与不变量以仓库 skill/SKILL.md 与 .harness 策略文件为准。
报告协议：每轮汇报必须包含改了什么（完整路径）、生成物路径、测试/验收结果、遗留问题。

【目标】{{goal}}
【现状】已完成见 {{handoffPath}}；待办与已知问题同上
【验收】{{acceptance}}
【约束】{{constraints}}
【第一步】先读 {{handoffPath}} 并运行 harness `context`，
输出 3 行执行计划 + 需要人确认的问题，确认后再动手。
完成报告必须包含：改了什么、生成物完整路径、验收结果。
