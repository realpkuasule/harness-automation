#!/usr/bin/env python3
"""Shared durable storage primitives for local-only tracking scripts."""

from __future__ import annotations

import json
import math
import os
import stat
import subprocess
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, TextIO


def reject_symlink(path: Path) -> None:
    try:
        if stat.S_ISLNK(path.lstat().st_mode):
            raise ValueError(f"LOCAL_TRACKING_SYMLINK_REJECTED: {path}")
    except FileNotFoundError:
        return


def open_text_read(path: Path) -> TextIO:
    reject_symlink(path)
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        reject_symlink(path)
        return os.fdopen(descriptor, "r", encoding="utf-8")
    except Exception:
        os.close(descriptor)
        raise


def storage_root() -> Path:
    requested = Path(os.environ.get("HARNESS_REPO_ROOT", Path.cwd())).resolve()
    result = subprocess.run(
        ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
        cwd=requested,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0 or not result.stdout.strip():
        detail = (result.stderr or result.stdout).strip() or "not a Git repository"
        raise ValueError(f"LOCAL_TRACKING_REPOSITORY_REQUIRED: {detail}")
    common_dir = Path(result.stdout.strip())
    if not common_dir.is_absolute():
        raise ValueError("LOCAL_TRACKING_COMMON_DIR_INVALID: git returned a relative common dir")
    harness_root = common_dir.resolve() / "harness"
    reject_symlink(harness_root)
    harness_root.mkdir(exist_ok=True)
    reject_symlink(harness_root)
    root = harness_root / "local-tracking"
    reject_symlink(root)
    root.mkdir(exist_ok=True)
    reject_symlink(root)
    return root


@contextmanager
def locked(root: Path) -> Iterator[None]:
    """Serialize both task and changelog updates with one common-dir lock."""
    lock_path = root / ".lock"
    reject_symlink(root)
    reject_symlink(lock_path)
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(lock_path, flags, 0o600)
    with os.fdopen(descriptor, "r+b") as handle:
        reject_symlink(lock_path)
        if os.name == "nt":
            import msvcrt

            if lock_path.stat().st_size == 0:
                handle.write(b"\0")
                handle.flush()
                os.fsync(handle.fileno())
            handle.seek(0)
        else:
            import fcntl

        raw_timeout = os.environ.get("HARNESS_LOCAL_TRACKING_LOCK_TIMEOUT", "10")
        try:
            timeout = float(raw_timeout)
        except ValueError as error:
            raise ValueError("LOCAL_TRACKING_LOCK_TIMEOUT_INVALID") from error
        if not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("LOCAL_TRACKING_LOCK_TIMEOUT_INVALID")
        deadline = time.monotonic() + timeout
        while True:
            try:
                if os.name == "nt":
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except (BlockingIOError, OSError):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ValueError("LOCAL_TRACKING_LOCK_TIMEOUT")
                time.sleep(min(0.05, remaining))
        try:
            yield
        finally:
            if os.name == "nt":
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def load_json(path: Path) -> Any:
    try:
        with open_text_read(path) as handle:
            return json.load(handle)
    except json.JSONDecodeError as error:
        raise ValueError(f"LOCAL_TRACKING_CORRUPT_JSON: {path}: {error}") from error


def atomic_write(path: Path, content: str) -> None:
    reject_symlink(path.parent)
    reject_symlink(path)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        reject_symlink(path.parent)
        reject_symlink(path)
        os.replace(temporary, path)
        if os.name != "nt":
            directory = os.open(
                path.parent,
                os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0),
            )
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
