import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "changelog.py"


class ChangelogIssueRefTests(unittest.TestCase):
    def test_add_supports_issue_ref(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "scripts").mkdir()
            subprocess.run(
                [
                    "python3",
                    str(SCRIPT),
                    "add",
                    "feat",
                    "11",
                    "Use GitHub issues",
                    "--issue",
                    "realpkuasule/harness-automation#123",
                ],
                cwd=root,
                check=True,
                text=True,
                capture_output=True,
                env={**os.environ, "HARNESS_REPO_ROOT": str(root)},
            )
            entries = [
                json.loads(line)
                for line in (root / "CHANGELOG.jsonl").read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            self.assertEqual(entries[0]["issueRef"], "realpkuasule/harness-automation#123")


if __name__ == "__main__":
    unittest.main()
