from deerflow.agents.sophia_agent.middlewares.builder_artifact import (
    _requested_simple_pdf_artifact,
)


def _pdf_state(task: str) -> dict:
    return {
        "builder_artifact_target_path": "/mnt/user-data/outputs/report.pdf",
        "delegation_context": {"task": task},
    }


def test_normal_pdf_artifact_request_does_not_use_smoke_helper() -> None:
    assert _requested_simple_pdf_artifact(
        _pdf_state("Create a real PDF artifact report with charts and diagrams.")
    ) is False


def test_explicit_simple_pdf_request_can_use_smoke_helper() -> None:
    assert _requested_simple_pdf_artifact(
        _pdf_state("Create a simple PDF smoke test artifact.")
    ) is True
