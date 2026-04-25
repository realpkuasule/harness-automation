# 08-deps-edge-cases.test.ts — 依赖管理边界测试

**Priority**: P3
**File under test**: `src/deps.ts`

## Test Cases

### checkDependencies — 环境检测 (6 tests)

| # | Scenario | Setup | Expect |
|---|----------|-------|--------|
| 1 | 无 package.json | 空目录 | hasPackageJson=false, hasNodeModules=false, pm="unknown" |
| 2 | 仅有 package.json | package.json 无 node_modules | hasNodeModules=false, pm="npm" |
| 3 | npm 项目 | package.json + node_modules | hasNodeModules=true, pm="npm" |
| 4 | yarn 项目 | yarn.lock + package.json | pm="yarn" |
| 5 | pnpm 项目 | pnpm-lock.yaml + package.json | pm="pnpm" |
| 6 | 安装命令对应 | 各 package manager | installCommand 匹配 |

### checkDependencies — 工具检测 (3 tests)

| # | Scenario | Setup | Expect |
|---|----------|-------|--------|
| 7 | 已安装 eslint | devDependencies 含 eslint | missing 不含 eslint |
| 8 | 未安装 husky | devDependencies 无 husky | missing 含 husky |
| 9 | 部分安装 | 含 eslint 无 @commitlint | missing 含 @commitlint |

### checkDependencies — npm outdated (3 tests)

| # | Scenario | Setup | Expect |
|---|----------|-------|--------|
| 10 | 无 node_modules | 无 node_modules | outdated=[] |
| 11 | node_modules 存在但不是 npm 项目 | node_modules 但无 package.json | pm="unknown", hasNodeModules=true |
| 12 | package.json 无 dep | 空 dependencies | missing 正确 |

### suggestInstall — 安装命令 (3 tests)

| # | Package Manager | 期望命令 |
|---|----------------|---------|
| 13 | npm | `npm install --save-dev eslint` |
| 14 | pnpm | `pnpm add -D eslint` |
| 15 | yarn | `yarn add --dev eslint` |
