# Harness Automation Repository Workflow

This repository now uses GitHub Issues and one configured GitHub Project as the
active development source of truth.

## Source Of Truth

- GitHub Issues track every non-trivial development task.
- The configured GitHub Project tracks workflow state as `Todo`,
  `In Progress`, and `Done`, plus `critical`, `high`, `medium`, and `low`
  priority.
- `TASK.json` is a historical archive only. Do not add new entries or treat it
  as the active tracker for this repository.

## Repo Commands

Use these commands instead of `scripts/task.py` for repository work:

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

The tracker reads `.github/project-workflow.json`. Set the GitHub Project number
there once the repository project exists.

## Changelog

Keep using `scripts/changelog.py`, but reference GitHub issues instead of local
task IDs:

```bash
python3 scripts/changelog.py add feat 11 "Implement x" --issue realpkuasule/harness-automation#123
```

## Workflow

1. Create or identify the GitHub Issue before starting meaningful work.
2. Move the issue into the configured GitHub Project and set its status.
3. Implement the change.
4. Record user-facing or repository-significant changes in `CHANGELOG.jsonl`.
5. Close the issue and update the project status when done.

Compatibility note: the product still ships legacy `task-board` support for
existing users. That compatibility layer is not the source of truth for this
repository's own development workflow.

<!-- harness-automation:v2:start -->
## Harness engineering continuity

Effective policy digest: `e0324dabea6ff12927d13b519040d55771424ea03e636deca1c3a7bb0dba5cf8`

Before editing code in a new session:

1. Run `harness-automation context --project .` and read `.harness/generated/effective-policy.md`.
2. Search for the existing implementation and identify the owning module before adding a new one.
3. Treat shared APIs, RPC, database schemas, queues, and generated code as contracts.
4. Run `harness-automation check --project .` before declaring work complete.
5. Never edit `.harness/generated/**` or this managed block directly.

<!-- harness-automation:v2:end -->
