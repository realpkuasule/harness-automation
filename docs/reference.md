[Harness Engineering 时代下有哪些优秀样例？](https://www.zhihu.com/question/2021986352292537180/answer/2028563228460852446)

[![情酱](https://picx.zhimg.com/50/v2-60e8d1d2074a195295e23a835fb06080_l.jpg?source=b6762063)](https://www.zhihu.com/people/QingJ)

[情酱](https://www.zhihu.com/people/QingJ)

带你走过AI从0-1的成长之路

112 人赞同了该回答

一个常见的场景。开发者打开新项目，在 [CLAUDE.md](https://zhida.zhihu.com/search?content_id=777905473&content_type=Answer&match_order=1&q=CLAUDE.md&zhida_source=entity) 里写下”代码风格要简洁”。三天后他发现 Agent 还是在写冗长的代码：函数过长、抽象层叠、注释比代码多。他加重语气，把那行规则改成”代码风格必须简洁，禁止冗余”。又过了三天，Agent 写出来的代码几乎没变。开发者开始怀疑模型是不是变笨了，或者 CLAUDE.md 这个机制是不是失效了。

这两个怀疑都不对。问题在这条规则一开始就被写在了错误的介质上。”代码风格简洁”是一个无法被精确定义的要求，模型每次都在用自己对”简洁”的理解去判断，而它的判断和开发者的判断从来不是同一个。这不是一个能通过加强语气来解决的问题，这是一个介质选择的问题。

写过几个项目的开发者都积累过这种困惑。CLAUDE.md 越写越长，规则越定越细，效果却越来越不稳定。原因不在 Agent，在于项目里的所有规则都被堆在同一个介质里，而不同性质的规则需要不同的介质。

在展开之前，先用三句话把前面两篇的判断立起来，方便没读过的读者跟上。[Harness engineering](https://zhida.zhihu.com/search?content_id=777905473&content_type=Answer&match_order=1&q=Harness+engineering&zhida_source=entity)不是在补模型的能力短板，是在承担模型结构上不该承担的工作。承担的方式是把那些”模型做不好的事”交给外部结构去处理。具体怎么交，取决于你把每件事放在了哪种介质上。

项目层的 harness 有五种主要介质：CLAUDE.md、settings.json、自定义 [linter](https://zhida.zhihu.com/search?content_id=777905473&content_type=Answer&match_order=1&q=linter&zhida_source=entity)、CI、Git hook。每一种介质都有自己的力量和代价，也都有自己适合承载的事情。判断一条规则该放在哪里，是项目 harness 落地的核心方法论。这一篇讲清楚这件事，并给出可以直接复制的落地配置。

### 一、五种介质的”力学特性”

### CLAUDE.md：软约束

它的力量在灵活，可以表达任何不能形式化的东西：项目的设计哲学、命名习惯的倾向、什么场景下偏好用 server components、面对模糊需求时的默认假设。它的代价已经在第二篇讲过：优先级低于 system prompt，被系统标记为”可能不相关”，越具体的规则越容易遵守，越模糊的规则越容易漂移。

一条好的 CLAUDE.md 规则长什么样：

```text
## 修改既有代码时

- 如果一段代码本身没有改动，不要修改它的注释格式或措辞
- 不要为了"统一风格"重命名你正在修改的函数附近的其他函数
- 重构必须由用户明确要求，不要"顺手"重构
```

注意三件事：每条都是具体动作（”不要修改注释格式”而非”保持代码整洁”），每条都有否定词（明确禁止比模糊提倡有效），整段控制在一屏之内（CLAUDE.md 越长每一条的相对权重越低）。

### 自定义 linter：硬约束

力量在确定性。一条规则被写进 linter 之后，Agent 没办法绕过：要么改对，要么报错。代价是写起来贵：必须把规则形式化成 AST 模式或者类型检查规则。

最简单的自定义 linter 形态是 [ESLint](https://zhida.zhihu.com/search?content_id=777905473&content_type=Answer&match_order=1&q=ESLint&zhida_source=entity) 的 no-restricted-syntax 规则，不需要写插件：

```text
{
  "rules": {
    "no-restricted-syntax": [
      "error",
      {
        "selector": "CallExpression[callee.name='fetch']:not(:has(MemberExpression[object.name='services']))",
        "message": "API 调用必须经过 services/ 层。在组件里直接 fetch 会绕过 service 层的错误处理和缓存。请使用 services/api.ts 里对应的方法。"
      }
    ]
  }
}
```

这条规则禁止在非 services 目录的代码里直接用 fetch。十几行配置，零行代码，覆盖了一个真实的架构边界。

### Git hook：过程拦截

力量在拦截时机最早。pre-commit 在 Agent 刚要把代码提交进 git 时触发，pre-push 在推到远端时触发。比 CI 早，比 linter 晚。Hook 的代价在配置和维护：hook 是本地的，跨开发者一致性需要 husky 这类工具保证。

最常见的 pre-commit 配置（用 husky + lint-staged）：

```text
# .husky/pre-commit
npx lint-staged
// package.json
{
  "lint-staged": {
    "*.{ts,tsx}": ["eslint --max-warnings=0", "prettier --write"],
    "*.md": ["prettier --write"]
  }
}
```

这套配置保证了：每次 commit 前，被改动的 TypeScript 文件必须通过 ESLint（任何 warning 都阻断），自动格式化。这一步把”运行 linter”从”开发者记得运行”变成”系统强制运行”，是约束力的关键提升。

### CI：终极防线

力量在拦截彻底。通不过 CI 进不了主分支。代价在反馈延迟，要等 push 之后才知道。

最小的 CI 配置（[GitHub Actions](https://zhida.zhihu.com/search?content_id=777905473&content_type=Answer&match_order=1&q=GitHub+Actions&zhida_source=entity)）：

```text
# .github/workflows/check.yml
name: check
on: [pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm' }
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
```

CI 适合承载那些”绝对不能让它流到生产环境”的规则：测试覆盖率、安全扫描、构建必须通过、依赖必须无漏洞。

### settings.json：harness 强制行为

第五种介质常常被忽略，因为它不像前四种那样起源于传统软件工程。Claude Code 的 `.claude/settings.json` 是一个直接配置 harness 本身行为的文件。它不是给 Agent 看的（不像 CLAUDE.md），也不是约束 Agent 写出来的代码（不像 linter / hook / CI），它直接告诉 harness “这件事不要让 Agent 做”。

它的力量在确定性。当一条规则被写进 settings.json 之后，Agent 不知道这条规则存在，但这条规则会在 harness 层强制生效。这是和 CLAUDE.md 最关键的区别：CLAUDE.md 是劝告，模型可能遵守也可能漂移；settings.json 是机制，模型根本没有机会违反。

最常见的几种用法：

```text
// .claude/settings.json
{
  "permissions": {
    "allow": [
      "Bash(git:*)",
      "Bash(npm:*)",
      "Bash(prisma:*)"
    ],
    "deny": [
      "Bash(rm -rf:*)",
      "Bash(sudo:*)",
      "Edit(.env)",
      "Edit(.env.*)"
    ]
  },
  "attribution": {
    "commit": ""
  },
  "model": "claude-opus-4-6",
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "command": "npm run lint --silent"
      }
    ]
  }
}
```

这份配置做了四件事：限制了 Bash 命令的白名单和黑名单（`rm -rf` 和 `sudo` 永远不会被执行）、禁止 Agent 修改 `.env` 文件、清空 git commit 的 attribution 字段（不再自动加 Co-Authored-By）、锁定使用 Opus 4.6 模型、每次文件编辑后自动跑 linter。

settings.json 解决的是 CLAUDE.md 解决不了的一类问题：**当你想强制某种行为而不是建议某种行为时**。在 CLAUDE.md 里写”不要修改 .env 文件”，模型可能记得也可能忘；在 settings.json 里写 `"deny": ["Edit(.env)"]`，模型根本就调不动那个工具，连忘的机会都没有。同样，”不要在 commit 里加 Co-Authored-By” 这种行为如果只写进 CLAUDE.md，每次都要碰运气；写进 settings.json 一次，永久生效。

settings.json 的代价是它只能控制 harness 提供的能力。它不能定义新的检查规则，只能开关 harness 已经有的东西。如果你需要的检查不在 harness 已有能力范围内，还是要回到 linter。 

![](https://pic4.zhimg.com/v2-4b8586afbd664a172f3866478f944463_1440w.jpg)

  

### 为什么是这五种

因为这五种覆盖了 Agent 工作流里的五个关键介入时机：

|介入时机|介质|Agent 收到反馈的方式|
|---|---|---|
|harness 启动时|settings.json|工具被禁用，Agent 调不动|
|生成时|CLAUDE.md|通过 prompt 注入提前知道规则|
|写代码时|linter|IDE 实时报错，Agent 当场修|
|提交时|hook|commit 被拒绝，Agent 知道要修|
|合并前|CI|PR 失败，Agent 收到日志|

介质不是工具列表，是介入时机的分类。每个时机有自己的力学，决定了它能承担什么样的事情。理解了这一层，下一步就是判断：一条具体的规则应该放在哪一种介质上。

需要补充一条决策口诀。当你纠结一条规则该放 CLAUDE.md 还是 settings.json 时，问自己：**这件事我希望模型理解并主动遵守，还是我希望它根本没有机会违反？** 前者是 CLAUDE.md，后者是 settings.json。”不要使用废弃的 API” 属于前者（模型需要理解为什么），”不要修改 .env” 属于后者（不需要解释，根本就不该让它碰）。

### 二、四个问题决定一条规则该放哪里

四个问题，顺序固定，不能跳过。它们之间是一条收敛的判定流，不是一组平行的投票。每回答一个问题，都会收窄下一个问题的选项空间。

### 问题一：这条规则可以被形式化吗？

形式化的意思是，这条规则能不能被翻译成一段代码可以执行的检查。

判断标准很具体。你能不能写出一个函数 `function check(code: string): boolean`，给它一段代码就能说出”违反/不违反”？”不允许使用 any 类型”可以，TypeScript 编译器或 ESLint 都能检查。”组件文件不超过 300 行”可以，一个数行数的脚本就够。”代码风格要简洁”不可以，什么叫简洁？同一段代码不同的人有不同的判断。

**这道题答完之后做什么：**

- 形式化失败：规则只有一条出路，CLAUDE.md。停止后续判断，直接跳到”如何写一条好的 CLAUDE.md 规则”。
- 形式化成功：进入硬约束领域，继续走问题二、三、四。

最常见的两类误判：

**误判一：把”难形式化”当成”不能形式化”。** “代码必须有意义命名”完整形式化不了，但它的几个最常见违反模式都可以：禁止单字母变量（除了循环索引）、禁止数字后缀命名（a1/b2）、禁止纯拼音命名。把”难形式化”的规则拆成”部分可形式化 + 部分软约束”两条，分别交给 linter 和 CLAUDE.md。

**误判二：把”能形式化”当成”应该形式化”。** “不要在未修改的代码里乱改注释”理论上可以形式化（diff 检查 + 注释行检测），但实现复杂、性能差、误报率高。一条规则即使技术上能形式化，如果代价过高也应该放回 CLAUDE.md。形式化是必要条件，不是充分条件。

形式化成功的规则进入下一题。

### 问题二：违反这条规则的代价有多高？

代价的衡量标准不是”写代码的人觉得难看”，是”如果违反了，要花多大成本来修复”。

具体分三档：

- **极高代价**：数据丢失、生产事故、不可逆的架构腐化、安全漏洞
- **中等代价**：返工、PR 被打回、技术债积累
- **低代价**：风格不统一、看着别扭

**这道题答完之后做什么：**

- 极高代价 → 进入 CI 或 hook 阻断流程。后面问题三决定具体放哪个。
- 中等代价 → 进 linter 的 error 级别。构建失败但本地能继续工作。
- 低代价 → 进 linter 的 warn 级别。给提示就够，不阻断流程。

具体配置上的差别：

```text
// 极高代价规则：CI + hook 双重拦截
// .github/workflows/check.yml 里有对应的 job
// .husky/pre-push 里也有对应的检查

// 中等代价规则：linter error
{ "rules": { "no-explicit-any": "error" } }

// 低代价规则：linter warn  
{ "rules": { "max-lines": ["warn", 300] } }
```

这道题在判定流里的位置很关键。它必须排在”可形式化吗”之后，不能排在前面。如果先问代价再问可形式化，就会把不可形式化的高代价规则塞进 linter，造成大量误报和绕过。”架构必须保持清晰”是高代价规则，但它不可形式化，所以归宿是 CLAUDE.md，不是 linter，即便它代价很高。

最常见的误判是高估代价。开发者写规则时倾向于把所有事都说得像生死攸关，但真要量化”违反了会怎样”，大部分规则的代价其实是低的。把所有规则都设成 error 的项目，最后会出现一种典型现象：开发者养成习惯每次都用 `--no-verify` 跳过检查，因为太多假警报让流程不可用。Harness 的硬度必须和真实代价匹配，过硬反而比过软更糟。

### 问题三：反馈速度需要多快？

同样是硬约束，在 linter 里和在 CI 里效果完全不同。linter 在 Agent 写代码的当下就报错，Agent 在下一轮就能修复；CI 要等 push 之后才报错，Agent 已经写完一大段代码，反馈到来时上下文都已经过期了。

判断标准：**这条规则被违反之后，Agent 是不是需要立刻知道，否则会继续在错误前提上写更多代码？**

**这道题答完之后做什么：**

- 需要立刻知道 → linter（如果可形式化）或 hook（如果是动作时刻必须拦截，比如 commit 信息）
- 可以晚一点 → CI 兜底就够

具体到不同位置的配置策略：

|这条规则违反之后会传染吗|推荐位置|配置示例|
|---|---|---|
|会（类型错误、import 错误、API 误用）|linter|.eslintrc 里 error 级别|
|在动作发生时必须拦截（提交格式）|hook|.husky/commit-msg|
|不会传染但必须最终拦截（测试覆盖率、构建）|CI|.github/workflows/|

这道题的核心是”上下文成本”。Agent 的上下文是有限的，反馈来得越晚，错误造成的污染越深。一条类型错误如果在 IDE 里立即被 linter 报出，Agent 在下一轮直接修；如果等到 CI 报错，Agent 可能已经在错误的类型基础上写了五个相关函数，这五个函数全部需要回头改。反馈延迟的真实代价不是”晚一点知道”，是”在错误前提上累积了多少新工作”。

这道题也解释了为什么有些团队的 CI 看起来很完整但实际效果很差：所有检查都堆在 CI 里，本地什么都没有。Agent 在写代码时拿不到任何反馈，等到 PR 阶段一次性收到几十条违规，改一遍重 push，再一次几十条，陷入循环。把检查从 CI 往 linter 迁移，本质上是在把反馈时机往前移，降低上下文成本。

### 问题四：这条规则会被多频繁地接触？

最后一道题是细分介质的最后一个维度。同一条规则，在一个 5 人项目和一个 50 人项目里，值得投入的 harness 成本是不一样的。

判断标准：这条规则在一周内会被多少次 commit 触及？会被多少个 session 的 Agent 看到？

**这道题答完之后做什么：**

- 高频（每周 5 次以上）→ 即便写 linter 贵也值得，长期摊薄成本。可以投入写自定义 ESLint 插件、写复杂的 hook。
- 低频（每月几次）→ 即便能形式化也优先放 CLAUDE.md。投资硬介质不划算。

举个具体例子。”提交信息必须是 [conventional commits](https://zhida.zhihu.com/search?content_id=777905473&content_type=Answer&match_order=1&q=conventional+commits&zhida_source=entity) 格式”，这条规则一天可能触发十几次（每次 commit），写一个 commitlint 配置（10 行）极其值。”数据库迁移文件不能用 .ts 扩展名”，一周可能触发一次，写一个自定义 ESLint 规则（要写插件、写测试、维护）就不值，CLAUDE.md 一句话搞定。

这道题是经济学题，不是工程题。前三题决定了”这条规则可以放在哪里”，这道题决定了”值不值得放在那里”。

### 把四题串起来

四个问题串起来，得到一个三步的判定流：

```text
规则 → [可形式化吗?]
         │
    ┌────┴────┐
   不可       可
    │         │
 CLAUDE.md   [代价多高?]
              │
        ┌─────┼─────┐
       极高   中     低
        │    │      │
      CI/hook linter linter
       error  error   warn
        │
       [反馈要多快?]
        │
   ┌────┴────┐
  立刻      可慢
   │        │
  linter    CI
  + hook    only
        │
       [频率多高?]
        │
   ┌────┴────┐
  高        低
   │        │
 写自定义   降级到
 linter     CLAUDE.md
```

配张图

![](https://pic4.zhimg.com/v2-c4153c037f9e71d1778802e634462e71_1440w.jpg)

这个流程的反向使用同样有用，拿一条已经在 CLAUDE.md 里的规则，逐一过这四个问题，经常会发现它本来应该进 linter 或 hook，只是当时没想清楚。

讲清楚了方法论，下一节用四条具体规则演示完整的落地动作。

### 三、实战：四条规则的完整落地

挑四条具有代表性的规则，每条用 二 的四个问题判断，然后给出完整的配置代码。这一节是 二 框架的可执行版本。

### 规则一：不允许使用 any 类型

- 形式化吗？可以（ESLint 直接支持）
- 代价高吗？中等（any 会污染类型推导，但不会立即引发事故）
- 反馈要多快？要快（any 会传染）
- 多频繁？极高频（每个文件都可能涉及）

→ **linter error，配上为 Agent 写的错误信息。**

```text
// .eslintrc.json
{
  "rules": {
    "@typescript-eslint/no-explicit-any": ["error", {
      "ignoreRestArgs": false,
      "fixToUnknown": false
    }],
    "no-restricted-syntax": ["error", {
      "selector": "TSAnyKeyword",
      "message": "禁止使用 any。如果类型确实是动态的，使用 unknown 并在使用前 narrow。如果结构已知，在 src/types/ 里定义 interface。参考：src/types/api.ts 的 response 类型，src/utils/parseJson.ts 的 unknown 处理。"
    }]
  }
}
```

注意 message 部分。这是 五 会展开的”错误信息是 prompt”原则的具体应用。

### 规则二：不要在未修改的代码里乱改注释

- 形式化吗？理论上可以（diff 比对 + 注释检测），实际上代价过高且误报率高。**第一题就停。**

→ **CLAUDE.md，写得足够具体。**

```text
## 修改代码的边界

当你被要求修改某段代码时：

- 只修改与任务直接相关的代码
- 不要修改未被任务涉及的注释（即使你认为措辞可以更好）
- 不要为了"统一格式"重新格式化整个文件
- 不要"顺手"重命名变量、提取函数、抽象重复代码

如果你强烈认为某处代码应该改但不在任务范围内，在回复末尾用一段
"建议的额外改动"列出来，让我决定要不要做，不要直接动手。
```

具体到这种程度，Agent 才会真的遵守。模糊的”保持代码整洁”会被忽略。

### 规则三：数据库 migration 必须经过 review

- 形式化吗？部分可以（检测 migrations 目录有改动）
- 代价高吗？极高（一次错误的 migration 可能丢数据）
- 反馈要多快？可以慢（migration 不是高频操作）
- 多频繁？低频（一周几次）

→ **CI 检查 + 强制人工 review 流程。**

```text
# .github/workflows/migration-check.yml
name: migration-review-required
on: [pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - name: Detect migration changes
        id: detect
        run: |
          if git diff --name-only origin/main...HEAD | grep -q '^migrations/'; then
            echo "has_migration=true" >> $GITHUB_OUTPUT
          fi
      - name: Require manual review label
        if: steps.detect.outputs.has_migration == 'true'
        uses: actions/github-script@v7
        with:
          script: |
            const labels = context.payload.pull_request.labels.map(l => l.name);
            if (!labels.includes('migration-reviewed')) {
              core.setFailed('包含 migration 文件的 PR 必须由数据库负责人审核后添加 "migration-reviewed" 标签才能合并。');
            }
```

这是”形式化只能解决一半”的典型。能形式化的部分（检测 migration 文件存在）用 CI 自动化，不能形式化的部分（判断 migration 是否安全）用强制流程交给人。

### 规则四：优先用 server components

- 形式化吗？部分可以（可以检测哪些组件用了 ‘use client’）
- 代价？低（用错了性能差一点，不会出事故）
- 反馈？中（发现晚一点也能改）
- 频率？高（每个新组件都涉及）

→ **CLAUDE.md + linter warn 组合。**

CLAUDE.md 部分：

```text
## React 组件类型选择

默认使用 server component。只在以下情况下用 client component：

- 需要 useState / useEffect 等 hooks
- 需要事件处理（onClick / onChange 等）
- 需要浏览器 API（window / localStorage 等）
- 需要 React Context 的 Provider

不要把整个页面做成 client component。把交互的部分拆成小的 client 组件，
其余保持 server。具体例子参考 app/dashboard/page.tsx 的结构。
```

linter 部分：

```text
{
  "rules": {
    "no-restricted-syntax": [
      "warn",
      {
        "selector": "Program > ExpressionStatement:first-child > Literal[value='use client']",
        "message": "这是一个 client component。如果只是因为需要事件处理，考虑把交互部分单独拆成小的 client 组件，让父组件保持 server。详见 CLAUDE.md 的 React 组件类型选择。"
      }
    ]
  }
}
```

CLAUDE.md 提供”为什么和怎么做”的完整心智模型，linter 在 Agent 真要写 ‘use client’ 时给一个温和的提醒，并指向 CLAUDE.md 的对应章节。两种介质各自承担自己擅长的部分。

### 四条规则的总结

四条规则覆盖了四种典型决策路径：

|规则|决策路径|落地形态|
|---|---|---|
|不允许 any|全过四题|linter error + 详细 message|
|不要乱改注释|第一题就停|CLAUDE.md 具体段落|
|migration 必须 review|形式化只解决一半|CI 检测 + 强制人工标签|
|优先 server components|部分形式化|CLAUDE.md + linter warn 双层|

这四种路径基本覆盖了项目里 80% 的规则。剩下 20% 是介质组合更复杂的，但用同样的方法可以判断。

### 四、一个反向案例：当五种介质都不是答案

到这里，约束层的方法论已经讲完了，落地动作也给出来了。但要诚实地说，这套方法论有边界。有些规则用任何一种介质都解不好。

举一个最常见的例子：你希望 Agent 在写新功能前，先理解项目里已有的抽象，不要重复造轮子。一个项目里已经有 formatDate 工具函数，Agent 应该用它，而不是自己写一个新的 myFormatDate。

这件事用 二 的四个问题判断会得到什么结论？

写进 CLAUDE.md，加一句”写新功能前先 grep utils/“。Agent 经常忘。

写进 settings.json，没有对应的开关。settings.json 控制的是工具能不能调用，不控制 Agent 知道什么。

写进自定义 linter，根本无法形式化”是否重复造轮子”。要判断 myFormatDate 和 formatDate 是不是同一件事，需要语义理解，linter 做不到。

写进 CI，只能在事后扫描整个代码库找近似函数，发现重复时代码已经写好提交了。预防失效。

写进 hook，同样事后，而且粒度太粗。

五种介质都不行。

为什么？因为这件事的本质不是”约束 Agent 的行为”，是”重塑 Agent 的认知”。前者属于约束层，工具是 一 讲的那五种介质。后者属于认知层，需要的是另一类工具。

认知层在 2026 年有一个明确的主流答案：**Skills**。

Skills 是 Claude Code 提供的一类机制，它在 `.claude/skills/<name>/SKILL.md` 里定义一段”按需触发”的工作流。它和 CLAUDE.md 最重要的区别是：CLAUDE.md 每次 session 都会被加载，所以适合放”广泛适用”的内容；Skills 只在 description 字段匹配到当前任务时才被加载，所以适合放”按需触发”的内容。Anthropic 官方的最新建议（2026 年 4 月版本的 Claude Code 文档）已经把这件事写得很明确：

> CLAUDE.md is loaded every session, so only include things that apply broadly. For domain knowledge or workflows that are only relevant sometimes, use skills instead.

回到 formatDate 那个例子。正确的解决方案不是加一条规则，是写一个 skill：

```text
---
name: using-project-utils
description: When implementing any utility-like functionality (date formatting, string parsing, validation, etc.), check existing utilities first.
---

# 项目 utils 使用规范

在写以下任何一类功能前，必须先 grep `lib/utils/` 看是否已存在：

- 日期/时间格式化
- 字符串处理
- 数据校验
- API 响应解析

具体步骤：

1. 运行 `grep -r "function.*$keyword" lib/utils/`
2. 如果找到，直接 import 使用
3. 如果没找到但功能接近某个现有函数，扩展那个函数而不是新写一个
4. 如果完全是新功能，添加到 lib/utils/ 而不是散落在组件里

参考 lib/utils/date.ts 的组织方式。
```

当 Agent 接到一个涉及”日期格式化”的任务时，description 字段会被命中，这个 skill 会被加载到上下文。Agent 收到的不是一条 CLAUDE.md 里的孤立规则，是一段完整的”做这类事的标准流程”。

这是一个值得停下来想想的发现：**项目 harness 有约束层，也有认知层**。

约束层回答的是”Agent 不应该做什么”：用 CLAUDE.md / settings.json / linter / CI / hook 设界。认知层回答的是”Agent 应该知道什么、什么时候知道”：用 Skills 在合适的时机把合适的信息推给它。两层的方法论完全不同，工具完全不同，但都属于项目 harness。

这一篇主要讲约束层。认知层（Skills 的设计原则、什么时候建一个新 skill、skills 之间怎么组合）是一个独立话题，会在第下篇展开。但在这篇就要建立这个边界，因为开发者经常在认知层的问题上滥用约束层的工具，结果是 CLAUDE.md 越写越长、linter 越加越多，问题却没解决。

判断一条规则属于哪一层有一个简单的标准：**这条规则是想约束 Agent 已经知道该做什么但有时做错（约束层），还是想让 Agent 知道一件它本来不知道的事（认知层）？**前者用五种介质，后者用 Skills。混用会导致两边都不顺手。

![](https://pica.zhimg.com/v2-9f0fc1ac73838d5f427e03c8e16f4078_1440w.jpg)

  

### 五、一个常被忽略的事：错误信息本身就是 prompt

回到约束层。在结束方法论之前，有一件事必须单独拎出来说，因为它是 OpenAI 那篇 Codex 实践文章里最被低估的洞察。

传统软件工程里，错误信息是写给开发者看的：简短、准确、不啰嗦。但在 Agent 工作流里，错误信息是写给 Agent 看的。一个 Agent 触发了 linter 错误后，这个错误信息会被回传到下一轮 prompt 里，成为它判断”接下来该做什么”的输入。错误信息不是终点，是下一轮工作的起点。

这意味着 harness 流回模型的所有信号都是上下文的一部分：linter 错误、CI 失败描述、hook 拦截理由、test 失败信息。这些东西过去都被当成”系统反馈”，写得越简洁越好。在 Agent 工作流里，要反过来：写得越能引导下一步行动越好。

举个对比。

传统的 ESLint 错误信息：

```text
Unexpected any. Specify a different type.
```

这条信息对人来说够了，对 Agent 来说太薄。它知道”any 不行”，但不知道该用什么替代，也不知道为什么。下一轮它可能写出 unknown，也可能写出一个过于具体的类型，也可能干脆禁掉这一行的检查。

为 Agent 设计的 linter 错误信息应该是这样：

```text
Avoid using `any`. If the type is truly dynamic, use `unknown` and narrow it
before access. If the shape is known, define an explicit interface in src/types/.
Examples: see src/types/api.ts for response types, src/utils/parseJson.ts for
unknown handling.
```

包含三件事：为什么不能这么做、应该用什么替代、去哪里看正确的例子。这条信息在 Agent 的下一轮 prompt 里几乎相当于一段”现场指导”，修复成功率会显著提高。

这件事可以提升到一个更普遍的原则：**所有从 harness 流回模型的信号都是上下文工程的一部分**。它们不只是反馈，是引导。一个项目的 harness 设计成熟度，不只看它配了多少 linter 规则，也看这些 linter 的错误信息是怎么写的。

这件事的成本极低，改一条错误信息就是几行文本。但收益和写一条新 linter 规则差不多。一个常见的优化路径是：不要急着加新规则，先把已有规则的错误信息按”给 Agent 看”的方式重写一遍。很多时候，Agent 反复犯同一类错误的原因不是规则不够，是错误信息不够具体。

### 六、A/B 测试你的 harness 改动

讲完了五种介质和它们的判定流，最后要补一个工程实践，因为它在 2026 年的社区里被反复强调，但很多人没认真做。

每加一条规则之前和之后，跑一次同样的任务，对比结果。

这个做法听起来很基础，但绝大多数项目在加 harness 时是凭直觉的。开发者觉得”应该加一条这个规则”，加上之后看下一次任务感觉好像好了一点，就把规则保留下来。这种做法的问题是没有对照——你不知道改进是因为这条规则，还是因为这次任务本来就比上次简单，或者因为模型那天状态好。

A/B 测试 harness 的具体做法很朴素：

1. 找一个有代表性的真实任务（不是测试任务，是你项目里下一个要做的功能）
2. 把它写成一段 prompt，让 Agent 跑一次。记录结果：花了多少轮、有没有偏题、产出符不符合预期
3. 加上你想加的 harness 改动（一条 linter 规则、一段 CLAUDE.md、一个 hook）
4. 重置对话，用同一段 prompt 让 Agent 再跑一次
5. 对比两次结果。如果改动后明显更好，保留；如果没变化或者更差，撤掉

这个流程的最大价值是它对抗 harness 膨胀。开发者的本能是不停加规则，因为加比删容易，加了也不会立刻出问题。问题是几个月之后，linter 配了 50 条规则、CLAUDE.md 写了 200 行、hook 装了七八个，没人记得每一条为什么存在。这个状态下 harness 已经从助力变成了负担——回到第二篇里 Anthropic 那句话：每个 harness 组件都编码了一个假设，假设可能过时。

A/B 测试是这个膨胀的解药。它强迫每一条规则用结果证明自己的存在价值。一条加了之后没改善任何任务的规则，就是膨胀，应该被撤掉。

实操中可以更轻量一点。不需要每次都搞完整 A/B，但至少在以下三个时机要做：

- 加一条新的硬约束规则（linter error / CI 阻断）之前
- 觉得 CLAUDE.md “应该再补一段” 的时候
- 项目运行半年之后，定期 audit 已有规则

这件事被很多文章列为”区分一般 harness 工程师和优秀 harness 工程师的关键”。它的核心不是技术，是承认一件事：**关于 harness 该长什么样，你的直觉经常是错的，需要让真实任务来告诉你**。

### 七、什么时候不要做 harness

不是所有项目都值得搭 harness。三种场景下做 harness 是亏的。

**原型阶段**。项目还在探索期，核心抽象、技术栈、设计哲学都没固定。这时候搭 harness 等于把”还没想清楚的判断”固化下来。原型阶段最重要的是迭代速度，任何阻断流程的检查都是负收益。等项目稳定下来再考虑 harness。判断标准：如果你在过去一周里推翻过项目的某个核心决定，现在不是搭 harness 的时候。

**一次性脚本**。写完就扔的东西不需要 harness。一个跑数据迁移的脚本、一个抓数据的爬虫、一个临时分析任务，这些东西的生命周期可能就几小时到几天，投入 harness 的时间会超过节省的时间。

**维护成本超过收益**。这是最容易被忽略的一种。一个项目跑了一年，linter 配了 50 条规则，其中 30 条是过去某个时刻的临时需要，现在已经没人记得为什么加。新加规则没人审，旧规则没人删，每次 commit 触发的警告越来越多，开发者养成了忽略警告的习惯。这种状态下 harness 已经从助力变成了负担。这一节讲的 A/B 测试就是在阻止这件事的发生。

判断一个项目要不要搭 harness，有一个简单的问题：这个项目里有”未来的对话”吗？未来的对话可以是另一个 session 的 Agent、另一个团队成员、半年后的自己。Harness 是给”未来的对话”准备的礼物。如果一个项目预期生命周期短、只有自己一个 session 在用、没有协作者，跳过 harness 不是懒，是对的判断。

### 八、一个最小可行 harness 长什么样

讲完了所有方法论，最后给一份完整的最小可行 harness，可以直接复制到一个新项目里启动。这份配置假设是 Next.js + TypeScript 项目，但思路对其他栈通用。

### 文件清单

```text
project/
├── CLAUDE.md                    # 软约束 + 项目认知
├── .claude/
│   └── settings.json            # harness 强制行为（仅 Claude Code）
├── .eslintrc.json              # linter 硬约束
├── .husky/
│   ├── pre-commit              # 本地拦截
│   └── commit-msg              # commit 信息格式
├── .github/workflows/
│   └── check.yml               # CI 终极防线
└── package.json                # lint-staged 配置
```

### CLAUDE.md（约 60 行的骨架）

```text
# Project Name

简短描述（一句话）。

## 技术栈
- Next.js 15 (App Router)
- TypeScript
- PostgreSQL + Prisma
- Tailwind CSS

## 目录结构
- `app/`: 路由和页面
- `components/`: 可复用组件
- `services/`: 所有外部 API 调用必须在这里
- `lib/`: 工具函数和共享逻辑
- `types/`: 共享类型定义
- `migrations/`: 数据库迁移

## 编码约定

### 修改既有代码时
- 只修改与任务直接相关的代码
- 不要修改未被任务涉及的注释
- 不要为了"统一风格"重新格式化文件
- 不要"顺手"重构

### React 组件
- 默认使用 server component
- 需要交互时把交互部分拆成小的 client 组件
- 组件文件超过 200 行时考虑拆分

### 类型
- 禁止使用 any。用 unknown 加 narrow，或定义明确的 interface
- API 响应类型放在 src/types/api.ts
- 共享业务类型放在 src/types/

### 数据库
- 所有 DB 操作必须经过 services/db/
- 不要在组件或 API 路由里直接调用 prisma
- migration 文件必须经过 review，不要在 PR 里自动 merge

## 常用命令
- `npm run dev`: 启动开发服务器
- `npm run build`: 构建生产版本
- `npm run lint`: 运行 linter
- `npm run typecheck`: 类型检查
- `npm test`: 运行测试
- `npm run db:migrate`: 应用数据库迁移
```

控制在 60-80 行。这是 OpenAI 那篇文章里强调的”地图而非百科全书”原则，细节推到 docs/ 里，CLAUDE.md 只放索引和最重要的几条具体规则。

### .claude/settings.json（如果使用 Claude Code）

```text
{
  "permissions": {
    "allow": [
      "Bash(git:*)",
      "Bash(npm:*)",
      "Bash(npx:*)",
      "Bash(prisma:*)"
    ],
    "deny": [
      "Bash(rm -rf:*)",
      "Bash(sudo:*)",
      "Edit(.env)",
      "Edit(.env.*)",
      "Edit(prisma/migrations/**)"
    ]
  },
  "attribution": {
    "commit": ""
  },
  "model": "claude-opus-4-6"
}
```

这份 settings.json 强制了三件事：Bash 只能跑白名单里的命令（`rm -rf` 和 `sudo` 永远不会被执行）；`.env` 文件和已有的 migration 文件不能被 Agent 修改；commit 信息不会自动加 Co-Authored-By。这些都是不需要 Agent 理解的硬约束，写 CLAUDE.md 不可靠，写 settings.json 就一劳永逸。

### .eslintrc.json（关键配置）

```text
{
  "extends": [
    "next/core-web-vitals",
    "next/typescript"
  ],
  "rules": {
    "@typescript-eslint/no-explicit-any": ["error", {
      "fixToUnknown": false
    }],
    "no-restricted-syntax": [
      "error",
      {
        "selector": "TSAnyKeyword",
        "message": "禁止 any。用 unknown 加 narrow，或在 src/types/ 定义 interface。参考 src/types/api.ts。"
      },
      {
        "selector": "CallExpression[callee.name='fetch']",
        "message": "API 调用必须经过 services/ 层，不要在组件或路由里直接 fetch。"
      },
      {
        "selector": "ImportDeclaration[source.value='@prisma/client'] ~ *",
        "message": "Prisma 客户端不能在组件或路由里直接 import。所有 DB 操作走 services/db/。"
      }
    ],
    "max-lines": ["warn", {
      "max": 200,
      "skipBlankLines": true,
      "skipComments": true
    }]
  }
}
```

### .husky/pre-commit

```text
#!/usr/bin/env sh
. "$(dirname -- "$0")/_/husky.sh"

npx lint-staged
```

### .husky/commit-msg

```text
#!/usr/bin/env sh
. "$(dirname -- "$0")/_/husky.sh"

npx --no -- commitlint --edit ${1}
```

### package.json 关键片段

```text
{
  "scripts": {
    "lint": "next lint",
    "typecheck": "tsc --noEmit",
    "prepare": "husky install"
  },
  "lint-staged": {
    "*.{ts,tsx}": [
      "eslint --max-warnings=0",
      "prettier --write"
    ],
    "*.md": ["prettier --write"]
  },
  "commitlint": {
    "extends": ["@commitlint/config-conventional"]
  }
}
```

### .github/workflows/check.yml

```text
name: check
on:
  pull_request:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm' }
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
  
  migration-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - name: Require review label for migrations
        uses: actions/github-script@v7
        with:
          script: |
            const { execSync } = require('child_process');
            const changed = execSync('git diff --name-only origin/main...HEAD').toString();
            if (changed.includes('migrations/')) {
              const labels = context.payload.pull_request.labels.map(l => l.name);
              if (!labels.includes('migration-reviewed')) {
                core.setFailed('包含 migration 的 PR 必须有 migration-reviewed 标签');
              }
            }
```

### 这份配置里发生了什么

五种介质各自承担了自己擅长的部分：

- **CLAUDE.md** 提供项目地图、设计倾向、和不能形式化的具体约束（”不要乱改注释”等）
- **settings.json** 锁定模型、限制工具白名单、禁止 Agent 修改敏感文件（如果使用 Claude Code）
- **linter** 把可形式化的硬约束做成 IDE 实时报错（禁用 any、强制 services 层、组件长度提示）
- **hook** 在 commit 时强制运行 linter 和检查 commit 信息格式
- **CI** 是兜底，任何本地绕过的违规都在 PR 阶段被拦截，加上 migration 这种需要人工审核的特殊流程

这份配置可以在 30 分钟内复制到一个新项目里运行起来。它不是终点。随着项目演进，会有新的规则需要加，旧的规则需要删，错误信息需要按 五 的原则改写。每一次改动都应该按 六 的方法 A/B 测试一次。但这是一个起点，比”啥都不配”和”配了一堆但不知道为什么”都好。

### 九、尾声

这一篇讲的是项目 harness 落地阶段最关键的判断：每件事应该被放在哪种介质上。五种介质各有力学特性，四个问题构成一条收敛的判定流，判定完得到的不是”性质标签”，是具体的配置文件和代码片段。

这套方法论也有边界。它解决的是约束层的问题：什么不该让 Agent 做。它解决不了认知层的问题：Agent 应该知道什么。约束层用 CLAUDE.md / settings.json / linter / CI / hook，认知层用 Skills。把约束层的方法论用在认知层的问题上，会越用越累。

项目 harness 的成熟度不在于”做了多少”，在于”每件事都被放在了合适的介质上”，并且每一条都经得起 A/B 测试的检验。一个有 50 条 CLAUDE.md 规则但没有任何 linter 的项目，比一个只有 10 条规则但每条都对应正确介质的项目更脆弱。规则的数量是表象，介质的合理和必要性的可验证才是内里。

下一篇讲沉淀：怎么让 harness 自己进化，怎么让一次次踩坑变成项目的长期资产，怎么把约束层和认知层连起来。

---

### 参考资料

- OpenAI,《Harness Engineering: Leveraging Codex in an Agent-First World》
- Anthropic,《Effective harnesses for long-running agents》
- Khalil Gao,《深入浅出 Claude Code（一）：从源码理解 CLAUDE.md》
- ESLint, no-restricted-syntax 文档
- Husky, lint-staged 官方文档
- linux.do 社区关于 Trellis、CCG-workflow、自定义 linter 的多篇讨论帖