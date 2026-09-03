#!/usr/bin/env python3
"""操作 TASK.json 任务看板。

用法:
  添加 --local-only 可改用 <git-common-dir>/harness/local-tracking/TASK.json；不得因 GitHub 故障自动添加。
  python3 scripts/task.py add <phase> <title> <description> [--priority high|medium|low] [--blocked-by id1,id2] [--blocks id1,id2] [--files path1,path2] [--by agent-name]
  python3 scripts/task.py list [--status pending|completed|in_progress|deleted] [--phase <n>] [--priority high|medium|low|critical]
  python3 scripts/task.py show <id>
  python3 scripts/task.py update <id> [--status <s>] [--expected-status <s>] [--title <t>] [--description <d>] [--phase <n>] [--priority <p>] [--blocked-by id1,id2] [--blocks id1,id2] [--files path1,path2] [--by agent-name]
  python3 scripts/task.py summary

TASK.json 每条任务的结构:
  id           — 唯一标识，如 "P1-3" (phase 1 的第 3 个任务)
  phase        — 所属阶段版本号
  status       — pending | in_progress | completed | deleted
  title        — 简要标题
  description  — 详细说明
  priority     — high | medium | low (默认 medium)
  blockedBy    — 前置任务 ID 列表
  blocks       — 后续任务 ID 列表
  createdAt    — 创建时间戳 (ISO 8601)
  updatedAt    — 更新时间戳 (ISO 8601)
  createdBy    — 创建 agent
  updatedBy    — 更新 agent
  relatedFiles — 关联文件路径列表
"""

import json
import sys
from contextlib import nullcontext
from datetime import datetime, timezone, timedelta
from pathlib import Path
from local_tracking import atomic_write, load_json, locked, reject_symlink, storage_root

LOCAL_ONLY = "--local-only" in sys.argv[1:]
ARGV = [argument for argument in sys.argv[1:] if argument != "--local-only"]
ROOT = Path(__file__).resolve().parent.parent
TRACKING_ROOT = storage_root() if LOCAL_ONLY else ROOT
TASK_FILE = TRACKING_ROOT / "TASK.json"
TZ = timezone(timedelta(hours=8))

VALID_STATUS = {"pending", "in_progress", "completed", "deleted"}
VALID_PRIORITY = {"high", "medium", "low", "critical"}


def now_iso() -> str:
    return datetime.now(TZ).strftime("%Y-%m-%dT%H:%M:%S+08:00")


TASK_FIELDS = {
    "id", "phase", "status", "title", "description", "priority",
    "blockedBy", "blocks", "createdAt", "updatedAt", "createdBy",
    "updatedBy", "relatedFiles",
}


def validate_task(task: object, index: int) -> dict:
    if not isinstance(task, dict) or set(task) != TASK_FIELDS:
        raise ValueError(f"LOCAL_TRACKING_TASK_SCHEMA_INVALID: task[{index}] fields")
    if not isinstance(task["id"], str) or not task["id"]:
        raise ValueError(f"LOCAL_TRACKING_TASK_SCHEMA_INVALID: task[{index}].id")
    if not isinstance(task["phase"], int) or isinstance(task["phase"], bool) or task["phase"] < 0:
        raise ValueError(f"LOCAL_TRACKING_TASK_SCHEMA_INVALID: task[{index}].phase")
    if task["status"] not in VALID_STATUS or task["priority"] not in VALID_PRIORITY:
        raise ValueError(f"LOCAL_TRACKING_TASK_SCHEMA_INVALID: task[{index}] status/priority")
    for field in ("title", "description", "createdAt", "updatedAt", "createdBy", "updatedBy"):
        if not isinstance(task[field], str) or not task[field]:
            raise ValueError(f"LOCAL_TRACKING_TASK_SCHEMA_INVALID: task[{index}].{field}")
    for field in ("blockedBy", "blocks", "relatedFiles"):
        if not isinstance(task[field], list) or not all(isinstance(value, str) and value for value in task[field]):
            raise ValueError(f"LOCAL_TRACKING_TASK_SCHEMA_INVALID: task[{index}].{field}")
    return task


def validate_tasks(tasks: object) -> list[dict]:
    if not isinstance(tasks, list):
        raise ValueError("LOCAL_TRACKING_TASK_SCHEMA_INVALID: tasks")
    validated = [validate_task(task, index) for index, task in enumerate(tasks)]
    identifiers = [task["id"] for task in validated]
    if len(identifiers) != len(set(identifiers)):
        raise ValueError("LOCAL_TRACKING_TASK_SCHEMA_INVALID: duplicate task id")
    return validated


def load_board() -> dict:
    reject_symlink(TASK_FILE)
    if not TASK_FILE.exists():
        return {"schemaVersion": "1.0", "meta": {"project": "local", "updated": now_iso()}, "tasks": []}
    data = load_json(TASK_FILE)
    if not isinstance(data, dict) or set(data) != {"schemaVersion", "meta", "tasks"} or data["schemaVersion"] != "1.0":
        raise ValueError("LOCAL_TRACKING_TASK_SCHEMA_INVALID: root")
    meta = data["meta"]
    if not isinstance(meta, dict) or set(meta) != {"project", "updated"} or not all(isinstance(meta[key], str) and meta[key] for key in meta):
        raise ValueError("LOCAL_TRACKING_TASK_SCHEMA_INVALID: meta")
    tasks = validate_tasks(data["tasks"])
    return {"schemaVersion": "1.0", "meta": meta, "tasks": tasks}


def load_tasks() -> list[dict]:
    if not LOCAL_ONLY:
        if not TASK_FILE.exists():
            return []
        with open(TASK_FILE, encoding="utf-8") as handle:
            data = json.load(handle)
        if isinstance(data, dict) and isinstance(data.get("tasks"), list):
            return data["tasks"]
        if isinstance(data, list):
            return data
        return []
    return load_board()["tasks"]


def save_tasks(tasks: list[dict]) -> None:
    if not LOCAL_ONLY:
        meta = {"project": ROOT.name, "updated": now_iso()}
        if TASK_FILE.exists():
            try:
                with open(TASK_FILE, encoding="utf-8") as handle:
                    existing = json.load(handle)
                if isinstance(existing, dict) and isinstance(existing.get("meta"), dict):
                    meta = {**existing["meta"], **meta}
            except (json.JSONDecodeError, KeyError):
                pass
        with open(TASK_FILE, "w", encoding="utf-8") as handle:
            json.dump({"meta": meta, "tasks": tasks}, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
        return
    board = load_board()
    validated = validate_tasks(tasks)
    board["meta"]["updated"] = now_iso()
    board["tasks"] = validated
    atomic_write(TASK_FILE, json.dumps(board, indent=2, ensure_ascii=False) + "\n")


def command_lock():
    return locked(TRACKING_ROOT) if LOCAL_ONLY else nullcontext()


def next_id(phase: int, tasks: list[dict]) -> str:
    """生成下一个任务 ID: P{phase}-{counter}"""
    prefix = f"P{phase}-"
    max_counter = 0
    for t in tasks:
        tid = t.get("id", "")
        suffix = tid[len(prefix):] if tid.startswith(prefix) else ""
        if suffix.isdigit():
            max_counter = max(max_counter, int(suffix))
    return f"P{phase}-{max_counter + 1}"


def parse_list_arg(value: str | None) -> list[str] | None:
    """将 'id1,id2' 解析为 ['id1', 'id2']，None → None"""
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
        print("Usage: task.py add <phase> <title> <description> [--priority high|medium|low] [--blocked-by id1,id2] [--blocks id1,id2] [--files path1,path2] [--by agent-name]", file=sys.stderr)
        sys.exit(1)

    phase_str = positional[0]
    try:
        phase = int(phase_str)
    except ValueError:
        print(f"Phase must be an integer, got: {phase_str}", file=sys.stderr)
        sys.exit(1)

    title = positional[1]
    description = " ".join(positional[2:])

    priority = opts.get("priority", "medium")
    if priority not in VALID_PRIORITY:
        print(f"Invalid priority: {priority}. Valid: {VALID_PRIORITY}", file=sys.stderr)
        sys.exit(1)

    with command_lock():
        tasks = load_tasks()
        agent = opts.get("by", "unknown")
        task = {
            "id": next_id(phase, tasks),
            "phase": phase,
            "status": "pending",
            "title": title,
            "description": description,
            "priority": priority,
            "blockedBy": parse_list_arg(opts.get("blocked_by")) or [],
            "blocks": parse_list_arg(opts.get("blocks")) or [],
            "createdAt": now_iso(),
            "updatedAt": now_iso(),
            "createdBy": agent,
            "updatedBy": agent,
            "relatedFiles": parse_list_arg(opts.get("files")) or [],
        }
        tasks.append(task)
        save_tasks(tasks)
    print(f"Created {task['id']}: [{priority}] {title}")


def cmd_list(args: list[str]) -> None:
    with command_lock():
        tasks = load_tasks()
    opts: dict = {}
    i = 0
    while i < len(args):
        a = args[i]
        if a.startswith("--"):
            key = a[2:].replace("-", "_")
            if i + 1 < len(args) and not args[i + 1].startswith("--"):
                opts[key] = args[i + 1]
                i += 2
            else:
                opts[key] = True
                i += 1
        else:
            i += 1

    matched = []
    for t in tasks:
        if "status" in opts and t.get("status") != opts["status"]:
            continue
        if "phase" in opts and str(t.get("phase", "")) != opts["phase"]:
            continue
        if "priority" in opts and t.get("priority") != opts["priority"]:
            continue
        matched.append(t)

    print(f"Total: {len(matched)} tasks")
    for t in matched:
        tid = t["id"]
        status = t.get("status", "?")
        title = t.get("title", "?")
        phase = t.get("phase", "")
        priority = t.get("priority", "")
        blocked = t.get("blockedBy", [])
        blk = f" ←[{','.join(blocked)}]" if blocked else ""
        print(f"  [{status:12s}] {tid:8s} (P{phase}) [{priority:6s}] — {title}{blk}")


def cmd_show(args: list[str]) -> None:
    if not args:
        print("Usage: task.py show <id>", file=sys.stderr)
        sys.exit(1)
    task_id = args[0]
    with command_lock():
        tasks = load_tasks()
        for t in tasks:
            if t["id"] != task_id:
                continue
            for k, v in t.items():
                if isinstance(v, list):
                    print(f"{k:20s} [{', '.join(v)}]")
                else:
                    print(f"{k:20s} {v}")
            return
    print(f"Task {task_id} not found", file=sys.stderr)
    sys.exit(1)


def cmd_update(args: list[str]) -> None:
    positional, opts = split_positional(args)
    if len(positional) < 1:
        print("Usage: task.py update <id> [--status <s>] [--expected-status <s>] [--title <t>] [--description <d>] [--phase <n>] [--priority <p>] [--blocked-by id1,id2] [--blocks id1,id2] [--files path1,path2] [--by agent-name]", file=sys.stderr)
        sys.exit(1)

    task_id = positional[0]

    if not opts:
        print("No fields to update.", file=sys.stderr)
        sys.exit(1)

    with command_lock():
        tasks = load_tasks()
        for t in tasks:
            if t["id"] != task_id:
                continue
            if "expected_status" in opts:
                expected = opts["expected_status"]
                if expected not in VALID_STATUS:
                    print(f"Invalid expected status: {expected}. Valid: {VALID_STATUS}", file=sys.stderr)
                    sys.exit(1)
                if t["status"] != expected:
                    print(
                        f"LOCAL_TRACKING_STATUS_CAS_FAILED: {task_id}: expected {expected}, found {t['status']}",
                        file=sys.stderr,
                    )
                    sys.exit(1)
            if "status" in opts:
                s = opts["status"]
                if s not in VALID_STATUS:
                    print(f"Invalid status: {s}. Valid: {VALID_STATUS}", file=sys.stderr)
                    sys.exit(1)
                t["status"] = s
            if "title" in opts:
                t["title"] = opts["title"]
            if "description" in opts:
                t["description"] = opts["description"]
            if "phase" in opts:
                try:
                    t["phase"] = int(opts["phase"])
                except ValueError:
                    print(f"Phase must be an integer, got: {opts['phase']}", file=sys.stderr)
                    sys.exit(1)
            if "priority" in opts:
                p = opts["priority"]
                if p not in VALID_PRIORITY:
                    print(f"Invalid priority: {p}. Valid: {VALID_PRIORITY}", file=sys.stderr)
                    sys.exit(1)
                t["priority"] = p
            if "blocked_by" in opts:
                t["blockedBy"] = parse_list_arg(opts["blocked_by"]) or []
            if "blocks" in opts:
                t["blocks"] = parse_list_arg(opts["blocks"]) or []
            if "files" in opts:
                t["relatedFiles"] = parse_list_arg(opts["files"]) or []
            agent = opts.get("by", "unknown")
            t["updatedAt"] = now_iso()
            t["updatedBy"] = agent
            save_tasks(tasks)
            print(f"Updated {task_id}")
            return
    print(f"Task {task_id} not found", file=sys.stderr)
    sys.exit(1)


def cmd_summary() -> None:
    with command_lock():
        tasks = load_tasks()
    if not tasks:
        print("No tasks.")
        return

    by_status: dict[str, int] = {}
    by_priority: dict[str, int] = {}
    by_phase: dict[str, int] = {}
    blocked: list[dict] = []

    for t in tasks:
        s = t.get("status", "unknown")
        p = t.get("priority", "medium")
        ph = str(t.get("phase", "?"))
        by_status[s] = by_status.get(s, 0) + 1
        by_priority[p] = by_priority.get(p, 0) + 1
        by_phase[ph] = by_phase.get(ph, 0) + 1
        if t.get("blockedBy"):
            blocked.append(t)

    print(f"Total tasks: {len(tasks)}")
    print(f"\nBy status:")
    for s in ["pending", "in_progress", "completed", "deleted"]:
        if s in by_status:
            print(f"  {s:15s} {by_status[s]}")
    print(f"\nBy priority:")
    for p in ["critical", "high", "medium", "low"]:
        if p in by_priority:
            print(f"  {p:10s} {by_priority[p]}")
    print(f"\nBy phase:")
    for ph in sorted(by_phase, key=lambda x: int(x) if x.isdigit() else 0):
        print(f"  P{ph:4s} {by_phase[ph]}")
    if blocked:
        print(f"\nBlocked tasks ({len(blocked)}):")
        for t in blocked:
            print(f"  {t['id']} ← [{', '.join(t.get('blockedBy', []))}]")


CMDS = {
    "add": cmd_add,
    "list": cmd_list,
    "show": cmd_show,
    "update": cmd_update,
    "summary": lambda _: cmd_summary(),
}

if __name__ == "__main__":
    if not ARGV or ARGV[0] not in CMDS:
        print(__doc__, file=sys.stderr)
        sys.exit(1)
    try:
        if LOCAL_ONLY:
            reject_symlink(TASK_FILE)
        if not TASK_FILE.exists() and ARGV[0] != "add":
            print(f"TASK.json not found at {TASK_FILE}", file=sys.stderr)
            sys.exit(1)
        CMDS[ARGV[0]](ARGV[1:])
    except (json.JSONDecodeError, OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
