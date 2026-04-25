import type { ErrorMessageTemplate } from "../types.js";

const templates: ErrorMessageTemplate[] = [
  {
    id: "no-explicit-any",
    name: "禁止使用 explicit any",
    structure: {
      why: "使用 `any` 会禁用 TypeScript 的类型检查，使类型保护失效，导致运行时类型错误难以追踪",
      whatInstead: "使用 `unknown` 并在使用时进行类型收窄，或定义明确的接口类型",
      reference: "TypeScript 文档: The `unknown` Type (https://www.typescriptlang.org/docs/handbook/2/functions.html#unknown)",
      context: "在函数参数、变量声明和泛型约束中避免使用 any 类型",
      learningTip: "可以将 `any` 视为「放弃类型检查」，`unknown` 视为「需要先验证再使用」",
    },
    applicableScenarios: ["function parameter", "variable declaration", "generic constraint", "type cast"],
  },
  {
    id: "no-console-log",
    name: "禁止提交 console.log",
    structure: {
      why: "console.log 在生产环境中会泄漏内部信息，增加日志噪音，且可能包含敏感数据",
      whatInstead: "使用结构化日志库（如 winston、pino）或框架内置的 Logger",
      reference: "项目 CLAUDE.md — 代码质量章节",
      context: "console.log 仅用于本地调试，提交代码前应移除",
      learningTip: "配置 ESLint 的 no-console 规则，或者使用 `// eslint-disable-next-line no-console` 临时豁免并注明原因",
    },
    applicableScenarios: ["debugging output", "production code", "console statement"],
  },
  {
    id: "no-debugger",
    name: "禁止提交 debugger 语句",
    structure: {
      why: "debugger 语句会使浏览器或 Node.js 在运行到该位置时自动暂停，影响生产环境执行",
      whatInstead: "使用断点调试工具（VS Code 内置断点、Chrome DevTools）进行调试",
      reference: "项目 CLAUDE.md — 代码质量章节",
      context: "debugger 语句是调试残留，提交代码前应全部移除",
      learningTip: "配置 ESLint 规则 no-debugger: error 来硬性阻止 debugger 语句提交",
    },
    applicableScenarios: ["debugging statement", "breakpoint", "dev tool"],
  },
  {
    id: "no-untyped-fetch",
    name: "fetch 调用缺少类型",
    structure: {
      why: "未类型的 fetch 调用返回 any 类型，丢失响应数据的类型安全保障",
      whatInstead: "封装带泛型参数的 fetch 函数：`fetch<T>(url): Promise<T>`",
      reference: "TypeScript 泛型文档 (https://www.typescriptlang.org/docs/handbook/2/generics.html)",
      context: "所有 HTTP 请求都应该有明确的响应类型定义",
      learningTip: "创建一个 `apiClient` 工具函数，统一管理请求/响应类型",
    },
    applicableScenarios: ["HTTP request", "API call", "network request"],
  },
  {
    id: "unhandled-async-error",
    name: "未处理的异步错误",
    structure: {
      why: "未 catch 的 Promise 拒绝会导致 unhandledRejection，Node.js 进程会退出",
      whatInstead: "使用 try/catch 包裹 await 调用，或链式调用 .catch()",
      reference: "Node.js 文档: Error Handling (https://nodejs.org/api/process.html#event-unhandledrejection)",
      context: "所有异步操作必须有错误处理路径",
      learningTip: "使用 ESLint 的 no-floating-promises 规则确保所有 Promise 被正确处理",
    },
    applicableScenarios: ["async/await", "Promise chain", "event handler"],
  },
  {
    id: "no-magic-numbers",
    name: "禁止魔术数字",
    structure: {
      why: "直接书写的数字字面量无法表达其业务含义，降低代码可读性和可维护性",
      whatInstead: "将数字定义为具名常量：`const MAX_RETRY_COUNT = 3;`",
      reference: "Clean Code 第 17 章: 代码气味（魔术数字）",
      context: "具有业务含义的数字应提取为命名常量",
      learningTip: "在文件顶部定义常量或抽取为 config 模块，方便集中管理和修改",
    },
    applicableScenarios: ["numeric literal", "configuration value", "business constant"],
  },
  {
    id: "missing-type-annotation",
    name: "缺少类型注解",
    structure: {
      why: "缺少类型注解的函数参数和返回值会使调用者不确定数据类型，增加运行时错误风险",
      whatInstead: "为所有函数参数和返回值添加显式类型注解",
      reference: "TypeScript 最佳实践: 显式类型优于隐式类型",
      context: "公开 API 的函数必须包含类型注解，内部函数建议添加",
      learningTip: "启用 TypeScript 的 noImplicitAny 和 strict 模式来强制类型注解",
    },
    applicableScenarios: ["function parameter", "return type", "interface property"],
  },
  {
    id: "prefer-early-return",
    name: "优先使用提前返回",
    structure: {
      why: "深层嵌套的条件语句降低代码可读性，增加认知负担和维护难度",
      whatInstead: "使用提前返回（early return）减少嵌套层级，使主流程保持平铺",
      reference: "Refactoring 第 10 章: Replace Nested Conditional with Guard Clauses",
      context: "当函数嵌套超过 3 层时应该考虑提前返回重构",
      learningTip: "先处理异常/边界条件，然后返回；主流程保持最低嵌套",
    },
    applicableScenarios: ["nested condition", "guard clause", "function flow"],
  },
  {
    id: "no-duplicate-code",
    name: "禁止重复代码",
    structure: {
      why: "重复代码导致修改时需要同步多处，容易引入不一致的 bug",
      whatInstead: "提取公共逻辑为函数、类或模块，通过参数化处理差异",
      reference: "DRY 原则（Don't Repeat Yourself），Refactoring 第 7 章",
      context: "当同一段代码出现 3 次或以上时应该提取为公共函数",
      learningTip: "使用 ESLint 的 no-duplicate 规则或 sonarjs/no-duplicate-string 检测重复",
    },
    applicableScenarios: ["code duplication", "copy-paste", "similar logic"],
  },
  {
    id: "error-handling",
    name: "错误处理完整性",
    structure: {
      why: "不完整的错误处理会导致系统在异常状态下继续运行，产生数据损坏或安全漏洞",
      whatInstead: "覆盖所有错误路径，对可恢复错误进行处理，对不可恢复错误清晰上报",
      reference: "项目 CLAUDE.md — 错误处理章节",
      context: "每个可能出错的调用都需要对应的错误处理策略",
      learningTip: "使用 Either/Result 类型（如 neverthrow）强制调用方处理错误情况",
    },
    applicableScenarios: ["try/catch", "error boundary", "error propagation"],
  },
];

export function getAllTemplates(): ErrorMessageTemplate[] {
  return templates;
}

export function getTemplateById(id: string): ErrorMessageTemplate | undefined {
  return templates.find((t) => t.id === id);
}

export function findTemplatesByScenario(scenario: string): ErrorMessageTemplate[] {
  const lower = scenario.toLowerCase();
  return templates.filter((t) =>
    t.applicableScenarios.some((s) => s.toLowerCase().includes(lower)),
  );
}
