#!/usr/bin/env python3
"""操作 TASK.json 任务看板。

用法:
  python3 scripts/task.py list [--status pending|completed|in_progress] [--phase <n>] [--priority high|medium|low|critical]
  python3 scripts/task.py show <id>
  python3 scripts/task.py update <id> <status>
  python3 scripts/task.py summary
"""

import json
import sys
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TASK_FILE = ROOT / "TASK.json"


def load() -> list[dict]:
    with open(TASK_FILE) as f:
        return json.load(f)["tasks"]


def save(tasks: list[dict]) -> None:
    with open(TASK_FILE, "w") as f:
        json.dump({"tasks": tasks}, f, indent=2, ensure_ascii=False)
        f.write("\n")


def cmd_list(args: list[str]) -> None:
    tasks = load()
    filters = {}
    for i in range(0, len(args), 2):
        if args[i].startswith("--"):
            filters[args[i][2:]] = args[i + 1] if i + 1 < len(args) else None

    matched = []
    for t in tasks:
        if "status" in filters and t.get("status") != filters["status"]:
            continue
        if "phase" in filters and str(t.get("phase", "")) != filters["phase"]:
            continue
        if "priority" in filters and t.get("priority") != filters["priority"]:
            continue
        matched.append(t)

    print(f"Total: {len(matched)} tasks")
    for t in matched:
        pid = t["id"]
        status = t["status"]
        title = t["title"]
        phase = t.get("phase", "")
        print(f"  [{status:12s}] {pid} (P{phase}) — {title}")


def cmd_show(args: list[str]) -> None:
    if not args:
        print("Usage: task.py show <id>", file=sys.stderr)
        sys.exit(1)
    task_id = args[0]
    tasks = load()
    for t in tasks:
        if t["id"] == task_id:
            for k, v in t.items():
                print(f"{k:20s} {v}")
            return
    print(f"Task {task_id} not found", file=sys.stderr)
    sys.exit(1)


def cmd_update(args: list[str]) -> None:
    if len(args) < 2:
        print("Usage: task.py update <id> <status>", file=sys.stderr)
        sys.exit(1)
    task_id, new_status = args[0], args[1]
    valid = {"pending", "in_progress", "completed", "deleted"}
    if new_status not in valid:
        print(f"Invalid status: {new_status}. Valid: {valid}", file=sys.stderr)
        sys.exit(1)
    tasks = load()
    for t in tasks:
        if t["id"] == task_id:
            t["status"] = new_status
            save(tasks)
            print(f"Updated {task_id} → {new_status}")
            return
    print(f"Task {task_id} not found", file=sys.stderr)
    sys.exit(1)


def cmd_summary() -> None:
    tasks = load()
    by_status: dict[str, int] = {}
    by_priority: dict[str, int] = {}
    for t in tasks:
        s = t.get("status", "unknown")
        p = t.get("priority", "unknown")
        by_status[s] = by_status.get(s, 0) + 1
        by_priority[p] = by_priority.get(p, 0) + 1
    print(f"Total tasks: {len(tasks)}")
    print("\nBy status:")
    for s, n in sorted(by_status.items()):
        print(f"  {s:15s} {n}")
    print("\nBy priority:")
    for p, n in sorted(by_priority.items()):
        print(f"  {p:10s} {n}")


CMDS = {
    "list": cmd_list,
    "show": cmd_show,
    "update": cmd_update,
    "summary": lambda _: cmd_summary(),
}

if __name__ == "__main__":
    if not TASK_FILE.exists():
        print(f"TASK.json not found at {TASK_FILE}", file=sys.stderr)
        sys.exit(1)
    if len(sys.argv) < 2 or sys.argv[1] not in CMDS:
        print(__doc__, file=sys.stderr)
        sys.exit(1)
    CMDS[sys.argv[1]](sys.argv[2:])
