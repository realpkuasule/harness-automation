# GitHub Governance Audit Reference

```bash
harness-automation github audit \
  --project /absolute/repository \
  [--organization xiaozhiaixue]
```

`audit` derives `origin` from the local checkout and only accepts a GitHub repository remote. It uses read-only Git (`remote get-url`, `rev-parse`) and read-only `gh api` / `gh project view` calls. It never fetches, changes refs, modifies the checkout, refreshes authentication, opens a browser, writes GitHub state, or keeps a cache.

The normalized result contains the repository identity and HEAD, repository rulesets and branch protection, required and latest checks, local CODEOWNERS and workflow observations, Actions settings, environments, Issue/Project mapping, capability limits, sorted blockers/warnings/unavailable evidence, and `observedHash`. The hash excludes itself and is stable for equivalent observed state.

`--organization` is optional. When supplied, the command paginates the accessible organization repositories and records organization rulesets. A 403, 404, invalid pagination response, or missing Project evidence is never treated as an empty compliant result: it is reported in `unavailable` and returns exit code `2`. The command never requests additional GitHub scopes.

Exit status is `0` for a passing report (warnings are allowed), `2` for a deterministic blocker or unavailable requested evidence, and `1` for invalid input or an unexpected runtime error. Missing CODEOWNERS, approving reviews, Actions workflows, or environments are observations, not generic blockers.

GitHub Actions is not a target-project requirement. `harness-automation check --mode ci` runs discovered repository-owned argv locally or in any CI provider; v2 planning and apply do not create or edit CI files. The audit merely observes an existing repository's Actions configuration.

For this repository, `realpkuasule/harness-automation` and personal Project #2 remain canonical. The approved solo-maintainer baseline has no CODEOWNERS, independent reviewer, or required approving review. Creating or activating rulesets, changing Actions/Dependabot/environment settings, expanding token scope, or releasing remains a separate human action.
