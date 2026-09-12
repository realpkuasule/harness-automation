## 单人维护与主线基准

- 本仓库由本人单人维护。本地管理检出的 `main` 是核心工作成果和默认集成基线；`origin/main` 用于同步，不因位于远端而具有更高优先级。
- 新开发分支或 worktree 默认基于当前本地 `main`。不得仅因本地领先远端，就从 `origin/main` 重建基线、重置本地主线，或通过重新挑选提交替代已有完整成果。
- 保护本地独有提交及未提交内容；未提交内容不会自动进入新 worktree，接续相关工作前须核对其归属。
- 已授权的交付按“验证并合入本地 `main` → 普通推送同步远端 → 确认远端包含交付提交后清理”推进。
- 若远端出现本地没有的提交，先检查来源和差异；不得自动丢弃任一侧成果或强推覆盖，无法稳妥整合时交由本人决定。

<!-- harness-automation:v2:start -->
## Harness engineering continuity

Effective policy digest: `10ddb928aa12b352f3666bf2298bb9b9f0f21db9c709ccf42a6b5945385d1111`

Before editing code in a new session:

1. Run `harness-automation context --project .` and read `.harness/generated/effective-policy.md`.
2. Search for the existing implementation and identify the owning module before adding a new one.
3. Treat shared APIs, RPC, database schemas, queues, and generated code as contracts.
4. Run `harness-automation check --project .` before declaring work complete.
5. Never edit `.harness/generated/**` or this managed block directly.

<!-- harness-automation:v2:end -->
