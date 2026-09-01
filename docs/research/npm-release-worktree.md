# npm release 与 Git worktree 调研

日期：2026-08-31
对应需求：`docs/PRD.md`
对应 Issue：`realpkuasule/harness-automation#67`

## 结论

保留现有 tag 驱动的 GitHub Actions 发布流程，不引入新的发布框架，也不为 npm release 创建 linked worktree。该需求只需要跨 Agent 的 procedural/cognitive 约束和分发检查。

## 一手证据

### Git worktree

- 官方文档：https://git-scm.com/docs/git-worktree.html
- Git 将 `git worktree add` 定义为创建额外 linked worktree，用于同时检出其他 branch、实验或临时工作；每个 linked worktree 会在 common Git dir 下增加独立管理元数据。
- 与本需求的关系：npm release 不需要同时开发另一条 branch。专用 release worktree只会增加 checkout 和管理状态，没有额外发布能力。

### npm publish

- 官方文档：https://docs.npmjs.com/cli/commands/npm-publish/
- npm 从当前目录或指定 package/tarball 发布；同一 name/version 一经发布不能复用。
- 生命周期文档：https://docs.npmjs.com/cli/using-npm/scripts/
- 与本需求的关系：npm 不要求 Git linked worktree。现有 `prepublishOnly` 和 dry-run/pack 验证可以在 primary/management checkout 完成。

### GitHub Actions checkout

- 官方仓库：https://github.com/actions/checkout
- 许可证：MIT。
- 维护状态：官方仓库持续发布；当前项目已将 action 固定到精确 commit。
- 与本需求的关系：`actions/checkout` 会把触发 workflow 的 ref/SHA 检出到 `$GITHUB_WORKSPACE`。本项目的 tag workflow 已自行 checkout，因此本地再建 release worktree不会为 CI 提供隔离。

### semantic-release

- 官方仓库：https://github.com/semantic-release/semantic-release
- 许可证：MIT。
- 能力：自动计算版本、生成 release notes、发布 package，并要求采用相应 commit convention 和 CI 集成。
- 维护状态：活跃的官方项目，生态成熟。
- 结论：拒绝引入。它能替换整套版本与发布流程，但本需求只禁止一种无价值的本地 checkout 行为；引入依赖、配置、commit 约定和迁移成本明显超出范围。

## 设计决定

1. 继续使用现有 `.github/workflows/publish.yml`。
2. 不修改 worktree CLI、schema 或 branch contract；这些层无法可靠推断“发布意图”。
3. 在全局 Agent 护栏和随包分发的 `manage-worktree-delivery` Skill 中加入 npm release 例外。
4. 通过安装测试证明规则被分发；把语义结果如实标为 procedural/cognitive guidance，不宣称确定性 enforcement。
