#!/usr/bin/env python3
"""操作 CHANGELOG.jsonl 变更记录。

用法:
  python3 scripts/changelog.py add <type> <phase> <description> [--task-id <id>] [--files path1,path2] [--by agent-name]
  python3 scripts/changelog.py list [n]
  python3 scripts/changelog.py search <keyword>
  python3 scripts/changelog.py show <index>   (1-indexed from most recent)

CHANGELOG.jsonl 每条记录的结构:
  timestamp    — ISO 8601 时间戳
  type         — feat | fix | refactor | test | docs | chore | milestone
  phase        — 所属阶段版本号
  description  — 变更说明 (必填)
  taskId       — 关联的任务 ID (可选)
  agent        — 执行变更的 agent (可选)
  relatedFiles — 关联文件路径列表 (可选)
"""

import json
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHANGELOG_FILE = ROOT / "CHANGELOG.jsonl"
TZ = timezone(timedelta(hours=8))

VALID_TYPES = {"feat", "fix", "refactor", "test", "docs", "milestone", "chore"}


def now_iso() -> str:
    return datetime.now(TZ).strftime("%Y-%m-%dT%H:%M:%S+08:00")


def load() -> list[dict]:
    if not CHANGELOG_FILE.exists():
        return []
    entries = []
    with open(CHANGELOG_FILE) as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    entries.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    return entries


def save(entries: list[dict]) -> None:
    with open(CHANGELOG_FILE, "w") as f:
        for e in entries:
            f.write(json.dumps(e, ensure_ascii=False) + "\n")


def parse_list_arg(value: str | None) -> list[str] | None:
    if value is None:
        return None
    return [s.strip() for s in value.split(",") if s.strip()]


def split_positional(args: list[str]) -> tuple[list[str], dict]:
    """Split args into positional (before first --) and keyword (--key value)."""
    kw_start = next((i for i, a in enumerate(args) if a.startswith("--")), len(args))
    positional = args[:kw_start]
    opts: dict = {}
    i = kw_start
    while i < len(args):
        if args[i].startswith("--"):
            key = args[i][2:].replace("-", "_")
            if i + 1 < len(args) and not args[i + 1].startswith("--"):
                opts[key] = args[i + 1]
                i += 2
            else:
                opts[key] = True
                i += 1
        else:
            i += 1
    return positional, opts


# ---- Commands ----


def cmd_add(args: list[str]) -> None:
    positional, opts = split_positional(args)
    if len(positional) < 3:
        print("Usage: changelog.py add <type> <phase> <description> [--task-id <id>] [--files path1,path2] [--by agent-name]", file=sys.stderr)
        sys.exit(1)

    typ = positional[0]
    phase = positional[1]
    desc = " ".join(positional[2:])

    if typ not in VALID_TYPES:
        print(f"Invalid type: {typ}. Valid: {VALID_TYPES}", file=sys.stderr)
        sys.exit(1)

    entry: dict = {
        "timestamp": now_iso(),
        "type": typ,
        "phase": int(phase) if phase.isdigit() else phase,
        "description": desc,
    }

    if "task_id" in opts:
        entry["taskId"] = opts["task_id"]
    if "files" in opts:
        entry["relatedFiles"] = parse_list_arg(opts["files"])
    if "by" in opts:
        entry["agent"] = opts["by"]

    entries = load()
    entries.append(entry)
    save(entries)
    print(f"Added entry #{len(entries)}: [{typ}] P{phase} — {desc[:60]}{'...' if len(desc) > 60 else ''}")


def cmd_list(args: list[str]) -> None:
    n = int(args[0]) if args else 10
    entries = load()
    if not entries:
        print("No entries.")
        return
    for i, e in enumerate(reversed(entries[-n:]), 1):
        ts = e.get("timestamp", "?")[5:19]
        typ = e["type"]
        phase = e.get("phase", "?")
        desc = e["description"][:100]
        task_id = e.get("taskId", "")
        tid = f" [{task_id}]" if task_id else ""
        agent = e.get("agent", "")
        by = f" ({agent})" if agent else ""
        print(f"  #{len(entries) - n + i:3d} [{typ:8s}] P{str(phase):4s} {ts}{tid}{by} — {desc}")


def cmd_search(args: list[str]) -> None:
    if not args:
        print("Usage: changelog.py search <keyword>", file=sys.stderr)
        sys.exit(1)
    keyword = args[0].lower()
    entries = load()
    matched = [e for e in entries if keyword in json.dumps(e, ensure_ascii=False).lower()]
    print(f"Found {len(matched)} entries matching '{keyword}':")
    for e in matched:
        ts = e.get("timestamp", "?")[5:19]
        typ = e["type"]
        desc = e["description"][:100]
        task_id = e.get("taskId", "")
        tid = f" [{task_id}]" if task_id else ""
        print(f"  [{typ:8s}] {ts}{tid} — {desc}")


def cmd_show(args: list[str]) -> None:
    """Show full details of one entry by index (1-indexed, most recent first)."""
    if not args:
        print("Usage: changelog.py show <index>", file=sys.stderr)
        sys.exit(1)
    try:
        idx = int(args[0])
    except ValueError:
        print(f"Index must be an integer, got: {args[0]}", file=sys.stderr)
        sys.exit(1)

    entries = load()
    # reversed list: index 1 = most recent
    if idx < 1 or idx > len(entries):
        print(f"Index out of range: 1-{len(entries)}", file=sys.stderr)
        sys.exit(1)

    e = entries[-(idx)]  # index 1 → -1, 2 → -2, ...
    for k, v in e.items():
        if isinstance(v, list):
            print(f"{k:20s} [{', '.join(v)}]")
        else:
            print(f"{k:20s} {v}")


CMDS = {
    "add": cmd_add,
    "list": cmd_list,
    "search": cmd_search,
    "show": cmd_show,
}

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in CMDS:
        print(__doc__, file=sys.stderr)
        sys.exit(1)
    CMDS[sys.argv[1]](sys.argv[2:])
