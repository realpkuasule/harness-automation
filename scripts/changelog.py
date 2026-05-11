#!/usr/bin/env python3
"""操作 CHANGELOG.jsonl 变更记录。

用法:
  python3 scripts/changelog.py add <type> <phase> <description>
  python3 scripts/changelog.py list [n]
  python3 scripts/changelog.py search <keyword>
"""

import json
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHANGELOG_FILE = ROOT / "CHANGELOG.jsonl"

TZ = timezone(timedelta(hours=8))

VALID_TYPES = {"feat", "fix", "refactor", "test", "docs", "milestone", "chore"}


def load() -> list[dict]:
    if not CHANGELOG_FILE.exists():
        return []
    entries = []
    with open(CHANGELOG_FILE) as f:
        for line in f:
            line = line.strip()
            if line:
                entries.append(json.loads(line))
    return entries


def save(entries: list[dict]) -> None:
    with open(CHANGELOG_FILE, "w") as f:
        for e in entries:
            f.write(json.dumps(e, ensure_ascii=False) + "\n")


def cmd_add(args: list[str]) -> None:
    if len(args) < 3:
        print("Usage: changelog.py add <type> <phase> <description>", file=sys.stderr)
        sys.exit(1)
    typ = args[0]
    phase = args[1]
    desc = " ".join(args[2:])
    if typ not in VALID_TYPES:
        print(f"Invalid type: {typ}. Valid: {VALID_TYPES}", file=sys.stderr)
        sys.exit(1)

    now = datetime.now(TZ).strftime("%Y-%m-%dT%H:%M:%S+08:00")
    entry = {"timestamp": now, "type": typ, "phase": int(phase) if phase.isdigit() else phase, "description": desc}
    entries = load()
    entries.append(entry)
    save(entries)
    print(f"Added entry: [{typ}] P{phase} — {desc[:60]}{'...' if len(desc) > 60 else ''}")


def cmd_list(args: list[str]) -> None:
    n = int(args[0]) if args else 10
    entries = load()
    for e in entries[-n:]:
        ts = e.get("timestamp", "?")[5:19]
        typ = e["type"]
        phase = e.get("phase", "?")
        desc = e["description"][:80]
        print(f"  [{typ:8s}] P{phase} {ts} — {desc}")


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
        desc = e["description"][:80]
        print(f"  [{typ:8s}] {ts} — {desc}")


CMDS = {
    "add": cmd_add,
    "list": cmd_list,
    "search": cmd_search,
}

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in CMDS:
        print(__doc__, file=sys.stderr)
        sys.exit(1)
    CMDS[sys.argv[1]](sys.argv[2:])
