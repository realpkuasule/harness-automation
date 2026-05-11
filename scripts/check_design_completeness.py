#!/usr/bin/env python3
"""
检查设计文档完备性的验证脚本。
运行此脚本验证文档是否包含所有必需章节。
"""

import re
import sys

def read_document():
    """读取设计文档"""
    with open('/Users/zhichao/claude/harness/docs/harness-automation-design.md', 'r', encoding='utf-8') as f:
        return f.read()

def check_sections(content):
    """检查所有必需章节是否存在"""
    required_sections = [
        r'## 1\. 系统概述',
        r'## 2\. 用户交互流程',
        r'## 3\. MCP Server 设计',
        r'## 4\. 状态管理',
        r'## 5\. 错误处理',
        r'## 6\. 决策引擎设计',
        r'## 7\. 规则数据库设计',
        r'## 8\. 配置生成器设计',
        r'## 9\. Skill 设计',
        r'## 10\. 实现路径（MVP）',
        r'## 11\. 验证与测试',
        r'## 12\. 设计总结',
    ]

    missing = []
    present = []

    for pattern in required_sections:
        if re.search(pattern, content):
            present.append(pattern)
        else:
            missing.append(pattern)

    return present, missing

def check_mcp_tools(content):
    """检查MCP工具定义是否完整"""
    required_tools = [
        'evaluate_rules',
        'scan_codebase',
        'generate_config',
        'validate_setup',
        'rollback',
        'confirm_decisions',
        'init_harness',
        'query_state',
    ]

    missing_tools = []
    for tool in required_tools:
        # 检查工具接口定义部分
        pattern = rf'#### 3\.1\.\d+ `{tool}`'
        if not re.search(pattern, content):
            missing_tools.append(tool)

    return missing_tools

def check_rule_database(content):
    """检查规则数据库是否完整（16条规则）"""
    # 检查规则表行数
    lines = content.split('\n')
    in_table = False
    table_rows = 0

    for line in lines:
        if '| ID | 规则名 | 适用栈 |' in line:
            in_table = True
            continue
        if in_table and line.startswith('|--'):
            continue
        if in_table and line.startswith('|'):
            table_rows += 1
        if in_table and not line.startswith('|'):
            in_table = False

    # table_rows 已经是数据行数（规则数量）
    return table_rows

def check_decision_engine(content):
    """检查决策引擎关键函数是否存在"""
    required_functions = [
        'def evaluateAll',
        'def _filterByTechStack',
        'def decide',
        'def _finalDecision',
        'def _specialCases',
    ]

    missing_funcs = []
    for func in required_functions:
        if func not in content:
            missing_funcs.append(func)

    return missing_funcs

def main():
    print("=== 设计文档完备性验证 ===\n")

    content = read_document()

    # 1. 检查章节完整性
    print("1. 检查章节完整性:")
    present, missing = check_sections(content)

    if missing:
        print(f"   ❌ 缺失章节: {len(missing)} 个")
        for m in missing:
            print(f"      - {m}")
    else:
        print(f"   ✅ 所有 {len(present)} 个章节都存在")

    # 2. 检查MCP工具
    print("\n2. 检查MCP工具定义:")
    missing_tools = check_mcp_tools(content)
    if missing_tools:
        print(f"   ❌ 缺失工具: {len(missing_tools)} 个")
        for tool in missing_tools:
            print(f"      - {tool}")
    else:
        print(f"   ✅ 所有 8 个MCP工具都存在")

    # 3. 检查规则数据库
    print("\n3. 检查规则数据库:")
    rule_count = check_rule_database(content)
    if rule_count == 16:
        print(f"   ✅ 规则数据库完整: {rule_count} 条规则")
    else:
        print(f"   ❌ 规则数量不符: 期望 16 条，实际 {rule_count} 条")

    # 4. 检查决策引擎
    print("\n4. 检查决策引擎:")
    missing_funcs = check_decision_engine(content)
    if missing_funcs:
        print(f"   ❌ 缺失函数: {len(missing_funcs)} 个")
        for func in missing_funcs:
            print(f"      - {func}")
    else:
        print(f"   ✅ 决策引擎所有关键函数都存在")

    # 5. 检查测试场景
    print("\n5. 检查测试场景:")
    if '### 11.1 测试场景' in content:
        print(f"   ✅ 测试场景章节存在")
    else:
        print(f"   ❌ 测试场景章节缺失")

    # 6. 检查版本信息
    print("\n6. 检查版本信息:")
    if '**版本**: v3.0' in content:
        print(f"   ✅ 版本信息正确: v3.0")
    else:
        print(f"   ❌ 版本信息缺失或不正确")

    # 总结
    print("\n=== 验证总结 ===")

    issues = len(missing) + len(missing_tools) + (1 if rule_count != 16 else 0) + len(missing_funcs)

    if issues == 0:
        print("✅ 设计文档完备性验证通过：所有关键组件完整")
        return 0
    else:
        print(f"❌ 设计文档完备性验证失败：发现 {issues} 个问题")
        return 1

if __name__ == '__main__':
    sys.exit(main())