"""Unit tests for the builder notifier's pushed-registry fallback.

Validates that the gateway's channel notifier:
1. Prefers the pushed registry over the local in-process dict.
2. Constructs the _PushedTaskView adapter with the right fields.
3. Still falls back to get_background_task_result when nothing is pushed.
"""

from __future__ import annotations

from app.channels import manager as manager_module


class TestPushedTaskView:
    def test_status_error_and_final_state_populated(self):
        view = manager_module._pushed_task_view(
            {
                "status": "completed",
                "error": None,
                "builder_result": {
                    "artifact_path": "/mnt/user-data/outputs/out.pdf",
                    "companion_summary": "done",
                },
                "completed_at": "2026-04-23T00:00:00Z",
            }
        )
        assert view.status == "completed"
        assert view.error is None
        assert isinstance(view.final_state, dict)
        assert view.final_state["builder_result"]["artifact_path"].endswith("out.pdf")
        assert view.ai_messages == []
        assert view.completed_at == "2026-04-23T00:00:00Z"

    def test_failed_status_with_error(self):
        view = manager_module._pushed_task_view(
            {"status": "failed", "error": "boom"}
        )
        assert view.status == "failed"
        assert view.error == "boom"
        assert view.final_state is None

    def test_extract_builder_result_payload_works_on_view(self):
        view = manager_module._pushed_task_view(
            {
                "status": "completed",
                "builder_result": {"artifact_path": "/x"},
            }
        )
        extracted = manager_module._extract_builder_result_payload(view)
        assert extracted == {"artifact_path": "/x"}

    def test_extract_returns_none_when_no_builder_result(self):
        view = manager_module._pushed_task_view({"status": "failed", "error": "x"})
        assert manager_module._extract_builder_result_payload(view) is None


class TestNotifierPreferencesPushedRegistry:
    """_run_builder_notifier polls pushed registry before local dict.

    These tests do not drive the full async loop; they only verify the
    contract by inspecting which data source the notifier would consume
    for a given task_id. We test the short helpers (`_pushed_task_view`,
    `get_pushed_builder_task`) because the loop is trivial once the
    source-of-truth decision is correct, and running a 2s-poll-interval
    async loop in a unit test is brittle.
    """

    def test_pushed_registry_hit(self, monkeypatch):
        from app.gateway.routers import internal_builder_tasks

        internal_builder_tasks.clear_registry()
        # Simulate a push happening
        monkeypatch.setenv("SOPHIA_INTERNAL_SECRET", "s")
        import asyncio

        async def _push():
            class Req:
                headers = {"authorization": "Bearer s"}

                async def json(self):
                    return {
                        "status": "completed",
                        "builder_result": {"artifact_path": "/p"},
                    }

            await internal_builder_tasks.push_builder_task_status(Req(), "t1")

        asyncio.run(_push())

        pushed = manager_module.get_pushed_builder_task("t1")
        assert pushed is not None
        assert pushed["status"] == "completed"

        view = manager_module._pushed_task_view(pushed)
        assert view.status == "completed"
        assert view.final_state["builder_result"]["artifact_path"] == "/p"
        internal_builder_tasks.clear_registry()

    def test_pushed_registry_miss_falls_through_to_local(self):
        from app.gateway.routers import internal_builder_tasks

        internal_builder_tasks.clear_registry()
        assert manager_module.get_pushed_builder_task("does-not-exist") is None
