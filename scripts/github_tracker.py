#!/usr/bin/env python3
"""GitHub Issue / Project workflow helper for this repository.

Usage:
  python3 scripts/github_tracker.py doctor
  python3 scripts/github_tracker.py summary
  python3 scripts/github_tracker.py list [--state open|closed|all] [--limit 30]
  python3 scripts/github_tracker.py show <issue-number>
  python3 scripts/github_tracker.py create --title <title> [--body <text> | --body-file <path>] [--label a,b] [--assignee login] [--milestone name] [--status <status>] [--priority critical|high|medium|low]
  python3 scripts/github_tracker.py status <issue-number> <status>
  python3 scripts/github_tracker.py priority <issue-number> critical|high|medium|low
  python3 scripts/github_tracker.py close <issue-number> [--comment <text>] [--reason completed|not planned|duplicate] [--status <status>]

The repository source of truth is GitHub Issues plus one configured GitHub
Project. Configuration lives in .github/project-workflow.json.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any, NoReturn

ROOT = Path(__file__).resolve().parent.parent
CONFIG_FILE = ROOT / ".github" / "project-workflow.json"
PRIORITIES = ("critical", "high", "medium", "low")


def fail(message: str) -> NoReturn:
    print(message, file=sys.stderr)
    raise SystemExit(1)


def run(argv: list[str], *, cwd: Path = ROOT, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        argv,
        cwd=str(cwd),
        text=True,
        capture_output=True,
        check=False,
    )
    if check and result.returncode != 0:
        stderr = (result.stderr or result.stdout or "").strip()
        fail(stderr or f"Command failed: {' '.join(argv)}")
    return result


def load_config() -> dict[str, Any]:
    if not CONFIG_FILE.exists():
        fail(f"Missing config: {CONFIG_FILE}")
    with open(CONFIG_FILE, "r", encoding="utf-8") as handle:
        return json.load(handle)


def git_remote_repo() -> str | None:
    result = run(["git", "remote", "get-url", "origin"], check=False)
    if result.returncode != 0:
        return None
    remote = result.stdout.strip()
    if remote.startswith("git@github.com:"):
        slug = remote.split(":", 1)[1]
    elif remote.startswith("https://github.com/"):
        slug = remote.split("https://github.com/", 1)[1]
    else:
        return None
    return slug[:-4] if slug.endswith(".git") else slug


def repo_slug(config: dict[str, Any]) -> str:
    configured = str(config.get("repo") or "").strip()
    if configured:
        return configured
    derived = git_remote_repo()
    if derived:
        return derived
    fail("Unable to determine repository slug. Set `repo` in .github/project-workflow.json.")


def project_config(config: dict[str, Any]) -> dict[str, Any]:
    return config.get("project") or {}


def project_number(config: dict[str, Any]) -> int | None:
    value = project_config(config).get("number")
    return value if isinstance(value, int) else None


def project_owner(config: dict[str, Any], repo: str) -> str:
    owner = str(project_config(config).get("owner") or "").strip()
    if owner:
        return owner
    return repo.split("/", 1)[0]


def status_field_name(config: dict[str, Any]) -> str:
    return str(project_config(config).get("statusField") or "Status")


def default_status(config: dict[str, Any]) -> str:
    return str(project_config(config).get("defaultStatus") or "Todo")


def priority_field_name(config: dict[str, Any]) -> str:
    return str(project_config(config).get("priorityField") or "Priority")


def default_priority(config: dict[str, Any]) -> str:
    return str(project_config(config).get("defaultPriority") or "medium")


def gh_json(argv: list[str]) -> Any:
    result = run(["gh", *argv])
    stdout = result.stdout.strip()
    if not stdout:
        return None
    return json.loads(stdout)


def ensure_gh() -> None:
    result = run(["gh", "--version"], check=False)
    if result.returncode != 0:
        fail("GitHub CLI (`gh`) is not installed or not available on PATH.")


def coerce_items(payload: Any) -> list[dict[str, Any]]:
    if payload is None:
        return []
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if isinstance(payload, dict):
        for key in ("items", "nodes", "projects", "fields"):
            value = payload.get(key)
            if isinstance(value, list):
                return [item for item in value if isinstance(item, dict)]
    return []


def nested_find(node: Any, predicate) -> dict[str, Any] | None:
    if isinstance(node, dict):
        if predicate(node):
            return node
        for value in node.values():
            found = nested_find(value, predicate)
            if found is not None:
                return found
    elif isinstance(node, list):
        for value in node:
            found = nested_find(value, predicate)
            if found is not None:
                return found
    return None


def extract_project_id(payload: Any) -> str | None:
    if isinstance(payload, dict):
        for key in ("id", "projectId"):
            value = payload.get(key)
            if isinstance(value, str) and value:
                return value
    found = nested_find(payload, lambda item: isinstance(item.get("id"), str))
    return str(found["id"]) if found and isinstance(found.get("id"), str) else None


def extract_item_id(item: dict[str, Any]) -> str | None:
    if isinstance(item.get("id"), str):
        return str(item["id"])
    content = item.get("content")
    if isinstance(content, dict) and isinstance(content.get("id"), str):
        return str(content["id"])
    return None


def extract_added_item_id(payload: Any) -> str | None:
    if isinstance(payload, dict):
        direct = extract_item_id(payload)
        if direct:
            return direct
    found = nested_find(payload, lambda item: isinstance(item.get("id"), str))
    return str(found["id"]) if found and isinstance(found.get("id"), str) else None


def extract_issue_number(item: dict[str, Any]) -> int | None:
    content = item.get("content")
    if isinstance(content, dict) and isinstance(content.get("number"), int):
        return int(content["number"])
    if isinstance(item.get("number"), int):
        return int(item["number"])
    return None


def extract_issue_url(item: dict[str, Any]) -> str | None:
    content = item.get("content")
    if isinstance(content, dict) and isinstance(content.get("url"), str):
        return str(content["url"])
    if isinstance(item.get("url"), str):
        return str(item["url"])
    return None


def extract_status_from_value(node: Any, field_name: str) -> str | None:
    if isinstance(node, dict):
        field = node.get("field")
        if isinstance(field, dict):
            field_title = field.get("name") or field.get("title")
            if field_title == field_name:
                for key in ("name", "optionName", "text", "value"):
                    value = node.get(key)
                    if isinstance(value, str) and value != field_name:
                        return value
                option = node.get("option")
                if isinstance(option, dict):
                    for key in ("name", "title", "value"):
                        value = option.get(key)
                        if isinstance(value, str):
                            return value
        if node.get("name") == field_name or node.get("title") == field_name:
            for key in ("optionName", "text", "value"):
                value = node.get(key)
                if isinstance(value, str):
                    return value
        for value in node.values():
            found = extract_status_from_value(value, field_name)
            if found:
                return found
    elif isinstance(node, list):
        for value in node:
            found = extract_status_from_value(value, field_name)
            if found:
                return found
    return None


def extract_status(item: dict[str, Any], field_name: str) -> str | None:
    direct = item.get("status")
    if isinstance(direct, str):
        return direct
    return extract_status_from_value(item, field_name)


def find_project_field(fields: list[dict[str, Any]], field_name: str) -> dict[str, Any] | None:
    for field in fields:
        candidate = field.get("name") or field.get("title")
        if candidate == field_name:
            return field
    return None


def resolve_project_field(fields: list[dict[str, Any]], field_name: str) -> dict[str, Any]:
    field = find_project_field(fields, field_name)
    if field:
        return field
    fail(f"Project field `{field_name}` not found.")


def project_field_options(field: dict[str, Any]) -> list[dict[str, Any]]:
    options = field.get("options") or field.get("settings", {}).get("options") or []
    if not isinstance(options, list):
        return []
    return [option for option in options if isinstance(option, dict)]


def resolve_single_select_option_id(
    field: dict[str, Any],
    option_name: str,
    field_name: str,
) -> str:
    options = project_field_options(field)
    if not options:
        fail(f"`{field_name}` options are missing from GitHub Project metadata.")
    for option in options:
        if option.get("name") == option_name or option.get("title") == option_name:
            option_id = option.get("id")
            if isinstance(option_id, str) and option_id:
                return option_id
    available = ", ".join(
        sorted(
            str(option.get("name") or option.get("title"))
            for option in options
            if isinstance(option, dict) and (option.get("name") or option.get("title"))
        )
    )
    fail(f"`{option_name}` not found in project field `{field_name}`. Available: {available}")


def project_items(config: dict[str, Any], *, limit: int = 100) -> list[dict[str, Any]]:
    number = project_number(config)
    if number is None:
        fail("GitHub Project number is not configured in .github/project-workflow.json.")
    owner = project_owner(config, repo_slug(config))
    payload = gh_json(["project", "item-list", str(number), "--owner", owner, "--limit", str(limit), "--format", "json"])
    return coerce_items(payload)


def project_metadata(config: dict[str, Any], field_name: str) -> tuple[str, dict[str, Any]]:
    number = project_number(config)
    if number is None:
        fail("GitHub Project number is not configured in .github/project-workflow.json.")
    repo = repo_slug(config)
    owner = project_owner(config, repo)
    view = gh_json(["project", "view", str(number), "--owner", owner, "--format", "json"])
    project_id = extract_project_id(view)
    if not project_id:
        fail("Unable to resolve GitHub Project ID from `gh project view`.")
    field_payload = gh_json(["project", "field-list", str(number), "--owner", owner, "--format", "json"])
    fields = coerce_items(field_payload)
    return project_id, resolve_project_field(fields, field_name)


def issue_url(repo: str, number: int) -> str:
    return f"https://github.com/{repo}/issues/{number}"


def find_project_item_id(config: dict[str, Any], number: int) -> str | None:
    items = project_items(config, limit=200)
    for item in items:
        if extract_issue_number(item) == number:
            item_id = extract_item_id(item)
            if item_id:
                return item_id
    return None


def ensure_project_item(config: dict[str, Any], number: int) -> str:
    existing_item_id = find_project_item_id(config, number)
    if existing_item_id:
        return existing_item_id

    repo = repo_slug(config)
    owner = project_owner(config, repo)
    project_no = project_number(config)
    added = gh_json([
        "project",
        "item-add",
        str(project_no),
        "--owner",
        owner,
        "--url",
        issue_url(repo, number),
        "--format",
        "json",
    ])
    added_item_id = extract_added_item_id(added)
    if added_item_id:
        return added_item_id

    # GitHub Projects can be briefly eventually consistent after item-add.
    # Keep retries bounded and use the exact issue number rather than re-adding.
    for delay in (0.25, 0.5, 1.0, 2.0):
        time.sleep(delay)
        item_id = find_project_item_id(config, number)
        if item_id:
            return item_id
    fail(f"Unable to find GitHub Project item for issue #{number} after adding it to the project.")


def set_project_single_select(
    config: dict[str, Any],
    item_id: str,
    field_name: str,
    option_name: str,
) -> None:
    project_id, field = project_metadata(config, field_name)
    option_id = resolve_single_select_option_id(field, option_name, field_name)
    run([
        "gh",
        "project",
        "item-edit",
        "--id",
        item_id,
        "--project-id",
        project_id,
        "--field-id",
        str(field["id"]),
        "--single-select-option-id",
        option_id,
    ])


def cmd_doctor(args: argparse.Namespace) -> None:
    ensure_gh()
    config = load_config()
    repo = repo_slug(config)
    project_no = project_number(config)
    print(f"Repository: {repo}")
    auth = run(["gh", "auth", "status"], check=False)
    print("GitHub auth:", "ok" if auth.returncode == 0 else "blocked")
    if auth.returncode != 0:
        print((auth.stderr or auth.stdout).strip())
    repo_view = run(["gh", "repo", "view", repo], check=False)
    print("Repository access:", "ok" if repo_view.returncode == 0 else "blocked")
    if project_no is None:
        print(f"Project: not configured (`.github/project-workflow.json` → project.number)")
        return
    owner = project_owner(config, repo)
    view = run(["gh", "project", "view", str(project_no), "--owner", owner], check=False)
    print(f"Project #{project_no} ({owner}):", "ok" if view.returncode == 0 else "blocked")
    if view.returncode != 0:
        print((view.stderr or view.stdout).strip())
        return
    field_list = run([
        "gh",
        "project",
        "field-list",
        str(project_no),
        "--owner",
        owner,
        "--format",
        "json",
    ], check=False)
    if field_list.returncode != 0:
        print("Project fields: blocked")
        print((field_list.stderr or field_list.stdout).strip())
        return
    try:
        fields = coerce_items(json.loads(field_list.stdout))
    except json.JSONDecodeError:
        print("Project fields: blocked (invalid JSON)")
        return
    required_fields = (
        (status_field_name(config), default_status(config)),
        (priority_field_name(config), default_priority(config)),
    )
    for field_name, default_value in required_fields:
        field = find_project_field(fields, field_name)
        if field is None:
            print(f"Project field `{field_name}`: blocked (missing)")
            continue
        options = {
            str(option.get("name") or option.get("title"))
            for option in project_field_options(field)
        }
        if default_value not in options:
            print(f"Project field `{field_name}`: blocked (missing option `{default_value}`)")
            continue
        print(f"Project field `{field_name}`: ok")


def cmd_summary(args: argparse.Namespace) -> None:
    config = load_config()
    repo = repo_slug(config)
    issues = gh_json([
        "issue",
        "list",
        "--repo",
        repo,
        "--state",
        "all",
        "--limit",
        str(args.limit),
        "--json",
        "number,state,title",
    ]) or []
    counts = Counter(issue.get("state", "unknown") for issue in issues if isinstance(issue, dict))
    print(f"Repository: {repo}")
    print(f"Issues: open={counts.get('OPEN', 0)} closed={counts.get('CLOSED', 0)} total={len(issues)}")
    project_no = project_number(config)
    if project_no is None:
        print("Project: not configured")
        return
    status_counts: Counter[str] = Counter()
    missing = 0
    for item in project_items(config, limit=max(args.limit, 100)):
        status = extract_status(item, status_field_name(config))
        if status:
            status_counts[status] += 1
        else:
            missing += 1
    print(f"Project #{project_no}:")
    for status, count in sorted(status_counts.items()):
        print(f"  {status}: {count}")
    if missing:
        print(f"  unknown-status: {missing}")


def cmd_list(args: argparse.Namespace) -> None:
    config = load_config()
    repo = repo_slug(config)
    issues = gh_json([
        "issue",
        "list",
        "--repo",
        repo,
        "--state",
        args.state,
        "--limit",
        str(args.limit),
        "--json",
        "number,title,state,labels,assignees,updatedAt",
    ]) or []
    for issue in issues:
        labels = ",".join(label["name"] for label in issue.get("labels", []) if isinstance(label, dict))
        print(
            f"#{issue['number']:4d} [{issue['state'].lower():6s}] "
            f"{issue['title']} | labels={labels or '-'} | updated={issue.get('updatedAt', '-')}"
        )


def cmd_show(args: argparse.Namespace) -> None:
    config = load_config()
    repo = repo_slug(config)
    result = run(["gh", "issue", "view", str(args.issue), "--repo", repo])
    sys.stdout.write(result.stdout)


def cmd_create(args: argparse.Namespace) -> None:
    config = load_config()
    repo = repo_slug(config)
    argv = ["gh", "issue", "create", "--repo", repo, "--title", args.title]
    if args.body:
        argv.extend(["--body", args.body])
    if args.body_file:
        argv.extend(["--body-file", args.body_file])
    if args.label:
        for label in args.label.split(","):
            label = label.strip()
            if label:
                argv.extend(["--label", label])
    if args.assignee:
        argv.extend(["--assignee", args.assignee])
    if args.milestone:
        argv.extend(["--milestone", args.milestone])
    result = run(argv)
    url = result.stdout.strip().splitlines()[-1]
    print(f"Created issue: {url}")
    project_no = project_number(config)
    status = args.status or default_status(config)
    if project_no is None:
        print("Project is not configured yet; issue was created without project status.")
        return
    issue_no = int(url.rstrip("/").split("/")[-1])
    item_id = ensure_project_item(config, issue_no)
    set_project_single_select(config, item_id, status_field_name(config), status)
    print(f"Project status: {status}")
    priority = args.priority or default_priority(config)
    set_project_single_select(config, item_id, priority_field_name(config), priority)
    print(f"Project priority: {priority}")


def cmd_status(args: argparse.Namespace) -> None:
    config = load_config()
    item_id = ensure_project_item(config, args.issue)
    set_project_single_select(config, item_id, status_field_name(config), args.status)
    print(f"Issue #{args.issue} -> {args.status}")


def cmd_priority(args: argparse.Namespace) -> None:
    config = load_config()
    item_id = ensure_project_item(config, args.issue)
    set_project_single_select(config, item_id, priority_field_name(config), args.priority)
    print(f"Issue #{args.issue} priority -> {args.priority}")


def cmd_close(args: argparse.Namespace) -> None:
    config = load_config()
    repo = repo_slug(config)
    argv = ["gh", "issue", "close", str(args.issue), "--repo", repo]
    if args.comment:
        argv.extend(["--comment", args.comment])
    if args.reason:
        argv.extend(["--reason", args.reason])
    run(argv)
    print(f"Closed issue #{args.issue}")
    if project_number(config) is not None:
        status = args.status or "Done"
        status_args = argparse.Namespace(issue=args.issue, status=status)
        cmd_status(status_args)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="GitHub Issue / Project workflow helper")
    subparsers = parser.add_subparsers(dest="command", required=True)

    doctor = subparsers.add_parser("doctor")
    doctor.set_defaults(func=cmd_doctor)

    summary = subparsers.add_parser("summary")
    summary.add_argument("--limit", type=int, default=200)
    summary.set_defaults(func=cmd_summary)

    listing = subparsers.add_parser("list")
    listing.add_argument("--state", choices=["open", "closed", "all"], default="open")
    listing.add_argument("--limit", type=int, default=30)
    listing.set_defaults(func=cmd_list)

    show = subparsers.add_parser("show")
    show.add_argument("issue", type=int)
    show.set_defaults(func=cmd_show)

    create = subparsers.add_parser("create")
    create.add_argument("--title", required=True)
    body_group = create.add_mutually_exclusive_group()
    body_group.add_argument("--body")
    body_group.add_argument("--body-file")
    create.add_argument("--label")
    create.add_argument("--assignee")
    create.add_argument("--milestone")
    create.add_argument("--status")
    create.add_argument("--priority", choices=PRIORITIES)
    create.set_defaults(func=cmd_create)

    status = subparsers.add_parser("status")
    status.add_argument("issue", type=int)
    status.add_argument("status")
    status.set_defaults(func=cmd_status)

    priority = subparsers.add_parser("priority")
    priority.add_argument("issue", type=int)
    priority.add_argument("priority", choices=PRIORITIES)
    priority.set_defaults(func=cmd_priority)

    close = subparsers.add_parser("close")
    close.add_argument("issue", type=int)
    close.add_argument("--comment")
    close.add_argument("--reason", choices=["completed", "not planned", "duplicate"], default="completed")
    close.add_argument("--status")
    close.set_defaults(func=cmd_close)
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
