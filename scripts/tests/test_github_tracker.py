import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock


from scripts import github_tracker


class GitHubTrackerTests(unittest.TestCase):
    def test_extract_status_from_project_item(self) -> None:
        item = {
            "id": "ITEM_1",
            "content": {"number": 24, "url": "https://github.com/example/repo/issues/24"},
            "fieldValues": [
                {
                    "field": {"name": "Status"},
                    "optionName": "In Progress",
                }
            ],
        }
        self.assertEqual(github_tracker.extract_status(item, "Status"), "In Progress")

    def test_extract_issue_number_and_url(self) -> None:
        item = {
            "id": "ITEM_2",
            "content": {
                "number": 42,
                "url": "https://github.com/example/repo/issues/42",
            },
        }
        self.assertEqual(github_tracker.extract_issue_number(item), 42)
        self.assertEqual(github_tracker.extract_issue_url(item), "https://github.com/example/repo/issues/42")

    def test_ensure_project_item_uses_item_add_result_without_relisting(self) -> None:
        config = {
            "repo": "owner/repo",
            "project": {"owner": "owner", "number": 7},
        }
        with (
            mock.patch.object(github_tracker, "project_items", return_value=[]),
            mock.patch.object(github_tracker, "gh_json", return_value={"id": "ITEM_NEW"}) as gh_json,
        ):
            item_id = github_tracker.ensure_project_item(config, 42)

        self.assertEqual(item_id, "ITEM_NEW")
        gh_json.assert_called_once_with(
            [
                "project",
                "item-add",
                "7",
                "--owner",
                "owner",
                "--url",
                "https://github.com/owner/repo/issues/42",
                "--format",
                "json",
            ]
        )

    def test_ensure_project_item_retries_eventual_consistency(self) -> None:
        config = {
            "repo": "owner/repo",
            "project": {"owner": "owner", "number": 7},
        }
        project_snapshots = [
            [],
            [],
            [{"id": "ITEM_42", "content": {"number": 42}}],
        ]
        with (
            mock.patch.object(github_tracker, "project_items", side_effect=project_snapshots),
            mock.patch.object(github_tracker, "gh_json", return_value={}),
            mock.patch.object(github_tracker.time, "sleep") as sleep,
        ):
            item_id = github_tracker.ensure_project_item(config, 42)

        self.assertEqual(item_id, "ITEM_42")
        sleep.assert_has_calls([mock.call(0.25), mock.call(0.5)])

    def test_load_config_reads_repo_and_project_defaults(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".github").mkdir()
            (root / ".github" / "project-workflow.json").write_text(
                json.dumps(
                    {
                        "repo": "owner/repo",
                        "project": {
                            "owner": "owner",
                            "number": 7,
                            "statusField": "Status",
                            "defaultStatus": "Todo",
                            "priorityField": "Priority",
                            "defaultPriority": "medium",
                        },
                    }
                ),
                encoding="utf-8",
            )
            with mock.patch.object(github_tracker, "CONFIG_FILE", root / ".github" / "project-workflow.json"):
                config = github_tracker.load_config()
            self.assertEqual(github_tracker.repo_slug(config), "owner/repo")
            self.assertEqual(github_tracker.project_number(config), 7)
            self.assertEqual(github_tracker.project_owner(config, "owner/repo"), "owner")
            self.assertEqual(github_tracker.default_status(config), "Todo")
            self.assertEqual(github_tracker.priority_field_name(config), "Priority")
            self.assertEqual(github_tracker.default_priority(config), "medium")

    def test_set_project_single_select_uses_exact_field_and_option_ids(self) -> None:
        config = {"repo": "owner/repo", "project": {"number": 7}}
        field = {
            "id": "FIELD_PRIORITY",
            "name": "Priority",
            "options": [{"id": "OPTION_HIGH", "name": "high"}],
        }
        with (
            mock.patch.object(
                github_tracker,
                "project_metadata",
                return_value=("PROJECT_7", field),
            ) as project_metadata,
            mock.patch.object(github_tracker, "run") as run,
        ):
            github_tracker.set_project_single_select(
                config,
                "ITEM_42",
                "Priority",
                "high",
            )

        project_metadata.assert_called_once_with(config, "Priority")
        run.assert_called_once_with(
            [
                "gh",
                "project",
                "item-edit",
                "--id",
                "ITEM_42",
                "--project-id",
                "PROJECT_7",
                "--field-id",
                "FIELD_PRIORITY",
                "--single-select-option-id",
                "OPTION_HIGH",
            ]
        )

    def test_create_reuses_one_project_metadata_snapshot(self) -> None:
        config = {
            "repo": "owner/repo",
            "project": {
                "number": 7,
                "statusField": "Status",
                "priorityField": "Priority",
            },
        }
        metadata = (
            "PROJECT_7",
            [
                {"id": "STATUS", "name": "Status", "options": [{"id": "TODO", "name": "Todo"}]},
                {"id": "PRIORITY", "name": "Priority", "options": [{"id": "MEDIUM", "name": "medium"}]},
            ],
        )
        args = mock.Mock(
            title="Title",
            body=None,
            body_file=None,
            label=None,
            assignee=None,
            milestone=None,
            status="Todo",
            priority="medium",
        )
        with (
            mock.patch.object(github_tracker, "load_config", return_value=config),
            mock.patch.object(
                github_tracker,
                "run",
                return_value=mock.Mock(stdout="https://github.com/owner/repo/issues/42\n"),
            ),
            mock.patch.object(github_tracker, "ensure_project_item", return_value="ITEM_42"),
            mock.patch.object(github_tracker, "load_project_metadata", return_value=metadata) as load,
            mock.patch.object(github_tracker, "set_project_single_select") as set_field,
        ):
            github_tracker.cmd_create(args)

        load.assert_called_once_with(config)
        self.assertEqual(set_field.call_count, 2)
        self.assertTrue(all(call.args[-1] is metadata for call in set_field.call_args_list))

    def test_show_uses_rest_issue_endpoint(self) -> None:
        with (
            mock.patch.object(github_tracker, "load_config", return_value={"repo": "owner/repo"}),
            mock.patch.object(github_tracker, "gh_json", return_value={"number": 42}) as gh_json,
            mock.patch("builtins.print"),
        ):
            github_tracker.cmd_show(mock.Mock(issue=42))

        gh_json.assert_called_once_with([
            "api", "--method", "GET", "repos/owner/repo/issues/42",
        ])


if __name__ == "__main__":
    unittest.main()
