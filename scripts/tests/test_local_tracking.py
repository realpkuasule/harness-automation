import json
import os
import shutil
import subprocess
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
TASK = ROOT / "scripts" / "task.py"
CHANGELOG = ROOT / "scripts" / "changelog.py"


def run(
    script: Path,
    *args: str,
    cwd: Path,
    check: bool = True,
    local_only: bool = False,
    extra_env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["python3", str(script), *(["--local-only"] if local_only else []), *args],
        cwd=cwd,
        check=check,
        text=True,
        capture_output=True,
        env={**os.environ, "HARNESS_REPO_ROOT": str(cwd), **(extra_env or {})},
    )


def repository(root: Path) -> Path:
    root.mkdir(parents=True)
    subprocess.run(["git", "init", "-b", "main"], cwd=root, check=True, capture_output=True)
    subprocess.run(["git", "config", "user.email", "harness@example.test"], cwd=root, check=True)
    subprocess.run(["git", "config", "user.name", "Harness Test"], cwd=root, check=True)
    (root / "README.md").write_text("fixture\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=root, check=True)
    subprocess.run(["git", "commit", "-m", "fixture"], cwd=root, check=True, capture_output=True)
    return root


def tracking(root: Path) -> Path:
    common = subprocess.run(
        ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
        cwd=root,
        check=True,
        text=True,
        capture_output=True,
    ).stdout.strip()
    return Path(common) / "harness" / "local-tracking"


class LocalTrackingTests(unittest.TestCase):
    def test_worktrees_share_one_common_dir_store(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = repository(Path(tmp) / "repo")
            worktree = Path(tmp) / "feature"
            subprocess.run(["git", "worktree", "add", "-b", "feature", str(worktree), "HEAD"], cwd=root, check=True, capture_output=True)

            run(TASK, "add", "3", "First", "from main", cwd=root, local_only=True)
            run(CHANGELOG, "add", "feat", "3", "from feature", cwd=worktree, local_only=True)

            store = tracking(root)
            self.assertEqual(json.loads((store / "TASK.json").read_text())["tasks"][0]["id"], "P3-1")
            self.assertEqual(json.loads((store / "CHANGELOG.jsonl").read_text().strip())["description"], "from feature")
            self.assertFalse((root / "TASK.json").exists())
            self.assertFalse((worktree / "CHANGELOG.jsonl").exists())

    def test_multidigit_phase_task_ids_and_concurrent_appends_are_lossless(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = repository(Path(tmp) / "repo")

            run(TASK, "add", "12", "Task first", "sequential", cwd=root, local_only=True)
            run(TASK, "update", "P12-1", "--phase", "13", cwd=root, local_only=True)
            run(TASK, "add", "12", "Task second", "sequential", cwd=root, local_only=True)

            with ThreadPoolExecutor(max_workers=8) as executor:
                task_results = list(executor.map(
                    lambda index: run(TASK, "add", "12", f"Task {index}", "parallel", cwd=root, local_only=True),
                    range(16),
                ))
                change_results = list(executor.map(
                    lambda index: run(CHANGELOG, "add", "feat", "7", f"Change {index}", cwd=root, local_only=True),
                    range(16),
                ))

            self.assertTrue(all(result.returncode == 0 for result in task_results + change_results))
            store = tracking(root)
            tasks = json.loads((store / "TASK.json").read_text())["tasks"]
            entries = [json.loads(line) for line in (store / "CHANGELOG.jsonl").read_text().splitlines()]
            self.assertEqual({task["id"] for task in tasks}, {f"P12-{index}" for index in range(1, 19)})
            self.assertEqual(next(task["phase"] for task in tasks if task["id"] == "P12-1"), 13)
            self.assertEqual(len(entries), 16)

    def test_corrupt_or_ambiguous_state_fails_closed_without_rewrite(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = repository(Path(tmp) / "repo")
            store = tracking(root)
            store.mkdir(parents=True)
            task_file = store / "TASK.json"
            task_file.write_text('{"tasks": []}\n', encoding="utf-8")
            before_task = task_file.read_bytes()
            task_result = run(TASK, "add", "1", "No", "rewrite", cwd=root, check=False, local_only=True)
            self.assertNotEqual(task_result.returncode, 0)
            self.assertIn("LOCAL_TRACKING_TASK_SCHEMA_INVALID", task_result.stderr)
            self.assertEqual(task_file.read_bytes(), before_task)

            changelog_file = store / "CHANGELOG.jsonl"
            changelog_file.write_text('{"timestamp":"broken"}\nnot-json\n', encoding="utf-8")
            before_changelog = changelog_file.read_bytes()
            changelog_result = run(CHANGELOG, "add", "feat", "1", "No rewrite", cwd=root, check=False, local_only=True)
            self.assertNotEqual(changelog_result.returncode, 0)
            self.assertIn("LOCAL_TRACKING_CHANGELOG_SCHEMA_INVALID", changelog_result.stderr)
            self.assertEqual(changelog_file.read_bytes(), before_changelog)

            task_file.write_text('{"schemaVersion":"1.0","schemaVersion":"2.0","meta":{},"tasks":[]}\n', encoding="utf-8")
            before_task = task_file.read_bytes()
            task_result = run(TASK, "list", cwd=root, check=False, local_only=True)
            self.assertNotEqual(task_result.returncode, 0)
            self.assertIn("LOCAL_TRACKING_DUPLICATE_KEY: schemaVersion", task_result.stderr)
            self.assertEqual(task_file.read_bytes(), before_task)

            changelog_file.write_text('{"timestamp":"a","type":"feat","phase":1,"description":"first","description":"second"}\n', encoding="utf-8")
            before_changelog = changelog_file.read_bytes()
            changelog_result = run(CHANGELOG, "list", cwd=root, check=False, local_only=True)
            self.assertNotEqual(changelog_result.returncode, 0)
            self.assertIn("LOCAL_TRACKING_DUPLICATE_KEY: description", changelog_result.stderr)
            self.assertEqual(changelog_file.read_bytes(), before_changelog)

    def test_non_repository_does_not_create_a_fallback_store(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            result = run(TASK, "add", "1", "No", "fallback", cwd=root, check=False, local_only=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("LOCAL_TRACKING_REPOSITORY_REQUIRED", result.stderr)
            self.assertFalse((root / "TASK.json").exists())

    @unittest.skipIf(os.name == "nt", "fcntl fixture is Unix-only")
    def test_lock_wait_is_bounded(self) -> None:
        import fcntl

        with tempfile.TemporaryDirectory() as tmp:
            root = repository(Path(tmp) / "repo")
            store = tracking(root)
            store.mkdir(parents=True)
            lock_path = store / ".lock"
            lock_path.touch()
            with open(lock_path, "r+b") as handle:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
                result = run(
                    TASK,
                    "add",
                    "1",
                    "Blocked",
                    "lock",
                    cwd=root,
                    check=False,
                    local_only=True,
                    extra_env={"HARNESS_LOCAL_TRACKING_LOCK_TIMEOUT": "0.1"},
                )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("LOCAL_TRACKING_LOCK_TIMEOUT", result.stderr)
            self.assertFalse((store / "TASK.json").exists())

    def test_non_finite_lock_timeouts_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = repository(Path(tmp) / "repo")
            for value in ("nan", "inf", "-inf"):
                result = run(
                    TASK,
                    "add",
                    "1",
                    "Invalid",
                    value,
                    cwd=root,
                    check=False,
                    local_only=True,
                    extra_env={"HARNESS_LOCAL_TRACKING_LOCK_TIMEOUT": value},
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("LOCAL_TRACKING_LOCK_TIMEOUT_INVALID", result.stderr)

    @unittest.skipIf(os.name == "nt", "symlink creation may require elevated Windows privileges")
    def test_symlinked_store_lock_and_data_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = repository(Path(tmp) / "repo")
            store = tracking(root)
            store.mkdir(parents=True)
            external = Path(tmp) / "external.txt"
            external.write_text("sentinel", encoding="utf-8")

            (store / "TASK.json").symlink_to(external)
            data_result = run(TASK, "add", "1", "No", "data link", cwd=root, check=False, local_only=True)
            self.assertIn("LOCAL_TRACKING_SYMLINK_REJECTED", data_result.stderr)
            self.assertEqual(external.read_text(encoding="utf-8"), "sentinel")
            (store / "TASK.json").unlink()

            (store / "CHANGELOG.jsonl").symlink_to(external)
            changelog_result = run(CHANGELOG, "list", cwd=root, check=False, local_only=True)
            self.assertIn("LOCAL_TRACKING_SYMLINK_REJECTED", changelog_result.stderr)
            self.assertEqual(external.read_text(encoding="utf-8"), "sentinel")
            (store / "CHANGELOG.jsonl").unlink()

            broken = Path(tmp) / "missing"
            (store / "TASK.json").symlink_to(broken)
            broken_task = run(TASK, "list", cwd=root, check=False, local_only=True)
            self.assertIn("LOCAL_TRACKING_SYMLINK_REJECTED", broken_task.stderr)
            (store / "TASK.json").unlink()
            (store / "CHANGELOG.jsonl").symlink_to(broken)
            broken_changelog = run(CHANGELOG, "list", cwd=root, check=False, local_only=True)
            self.assertIn("LOCAL_TRACKING_SYMLINK_REJECTED", broken_changelog.stderr)
            (store / "CHANGELOG.jsonl").unlink()

            (store / ".lock").unlink()
            (store / ".lock").symlink_to(external)
            lock_result = run(CHANGELOG, "add", "feat", "1", "No lock link", cwd=root, check=False, local_only=True)
            self.assertIn("LOCAL_TRACKING_SYMLINK_REJECTED", lock_result.stderr)
            self.assertEqual(external.read_text(encoding="utf-8"), "sentinel")

            second = repository(Path(tmp) / "second")
            second_store = tracking(second)
            second_store.parent.mkdir(parents=True)
            external_dir = Path(tmp) / "external-store"
            external_dir.mkdir()
            second_store.symlink_to(external_dir, target_is_directory=True)
            store_result = run(TASK, "add", "1", "No", "store link", cwd=second, check=False, local_only=True)
            self.assertIn("LOCAL_TRACKING_SYMLINK_REJECTED", store_result.stderr)
            self.assertEqual(list(external_dir.iterdir()), [])

    def test_default_mode_preserves_legacy_root_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = repository(Path(tmp) / "repo")
            scripts = root / "scripts"
            scripts.mkdir()
            for source in (TASK, CHANGELOG, ROOT / "scripts" / "local_tracking.py"):
                shutil.copy2(source, scripts / source.name)

            run(scripts / "task.py", "add", "2", "Legacy", "task", cwd=root)
            run(
                scripts / "changelog.py",
                "add",
                "feat",
                "2",
                "Legacy changelog",
                "--issue",
                "example/repository#2",
                cwd=root,
            )

            self.assertEqual(json.loads((root / "TASK.json").read_text())["tasks"][0]["id"], "P2-1")
            self.assertEqual(json.loads((root / "CHANGELOG.jsonl").read_text())["issueRef"], "example/repository#2")
            self.assertFalse(tracking(root).exists())

            if os.name != "nt":
                (root / "CHANGELOG.jsonl").unlink()
                external = root / "legacy-changelog.jsonl"
                external.write_text("", encoding="utf-8")
                (root / "CHANGELOG.jsonl").symlink_to(external)
                run(CHANGELOG, "add", "fix", "2", "Follow legacy symlink", cwd=root)
                self.assertEqual(json.loads(external.read_text())["description"], "Follow legacy symlink")


if __name__ == "__main__":
    unittest.main()
