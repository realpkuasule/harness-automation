# GitHub Issue / Project Workflow

This repository no longer uses `TASK.json` as the active development tracker.
The active source of truth is:

- GitHub Issues for scoped work items
- one configured GitHub Project for workflow state

`TASK.json` remains in the repository only as a historical archive of earlier
work.

## Configuration

Repository tracking config lives in
[`/.github/project-workflow.json`](/Users/zhichao/codex/harness-automation/.github/project-workflow.json).

Set:

- `repo`: repository slug such as `realpkuasule/harness-automation`
- `project.owner`: user or org that owns the GitHub Project
- `project.number`: GitHub Project number
- `project.statusField`: usually `Status`
- `project.defaultStatus`: `Todo` for the configured Project
- `project.priorityField`: `Priority`
- `project.defaultPriority`: `medium`

The configured Project uses `critical`, `high`, `medium`, and `low` priority
options so legacy task priorities map without translation.

## Prerequisites

1. Install GitHub CLI.
2. Authenticate with repo access: `gh auth login`
3. Add Project scope if you will manage project status:
   `gh auth refresh -s project`

## Daily Commands

```bash
python3 scripts/github_tracker.py doctor
python3 scripts/github_tracker.py summary
python3 scripts/github_tracker.py list --state open
python3 scripts/github_tracker.py show 123
python3 scripts/github_tracker.py create --title "Title" --body "Details" --priority high
python3 scripts/github_tracker.py status 123 "In Progress"
python3 scripts/github_tracker.py priority 123 critical
python3 scripts/github_tracker.py close 123 --comment "Done"
```

The packaged v3 tracking facade exposes the same GitHub source of truth without
falling back to local files when GitHub is unavailable:

```bash
harness-automation tracking list --project .
harness-automation tracking show --issue 123 --project .
harness-automation tracking create --title "Title" --body "Details" --priority high --project .
harness-automation tracking update --issue 123 --status "In Progress" --project .
```

Every Issue and configured Project write is reread and checked. Repository
Issues, Project items, and Project fields are cursor-paginated to completion;
missing cursors, malformed pages, API failures, or readback mismatches fail
closed.

`phase` maps to a GitHub Milestone, dependency IDs map to linked Issues, and
`relatedFiles` belongs in the Issue body. GitHub owns timestamps and assignees.

## Changelog Convention

Keep using `scripts/changelog.py`, but attach GitHub issues rather than local
task IDs:

```bash
python3 scripts/changelog.py add feat 11 "Replace TASK.json workflow" \
  --issue realpkuasule/harness-automation#123
```

## Local-only Scripts

Only an explicit `--local-only` invocation makes `scripts/task.py` and
`scripts/changelog.py` resolve the repository's absolute Git common dir and
operate these files:

- `<git-common-dir>/harness/local-tracking/TASK.json`
- `<git-common-dir>/harness/local-tracking/CHANGELOG.jsonl`

All worktrees therefore share one local authority. Both scripts use one
common-dir lock, strict schemas, and fsync plus atomic replacement. Corrupt or
ambiguous input is rejected without rewriting it. Existing root-level files
are never imported or migrated implicitly. Without `--local-only`, both scripts
retain their legacy root-file behavior for compatibility.

```bash
python3 scripts/task.py --local-only add 1 "Title" "Details"
python3 scripts/changelog.py --local-only add feat 1 "Describe change"
```

## Migration Rules

- Do not create new entries in `TASK.json`.
- Do not treat `scripts/task.py` as the active repo workflow tool.
- Use `--local-only` only after Local-only mode is explicitly selected; GitHub
  outages never authorize switching modes.
