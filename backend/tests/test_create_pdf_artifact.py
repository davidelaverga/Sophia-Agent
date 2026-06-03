import json
from types import SimpleNamespace

from langchain_core.messages import ToolMessage

from deerflow.agents.sophia_agent.middlewares.builder_artifact import BuilderArtifactMiddleware
from deerflow.sophia.tools import create_pdf_artifact as pdf_tool


def _payload(result: str) -> dict:
    return json.loads(result)


def test_create_pdf_artifact_writes_valid_pdf_under_outputs(tmp_path) -> None:
    outputs = tmp_path / "outputs"
    result = _payload(
        pdf_tool._impl(
            pdf_path=None,
            title=None,
            subtitle=None,
            summary_bullets=None,
            improvement_bullets=None,
            thread_data={"outputs_path": str(outputs)},
            state=None,
        )
    )

    pdf_path = outputs / "simple-product-review.pdf"
    assert result["success"] is True
    assert result["pdf_path"] == "/mnt/user-data/outputs/simple-product-review.pdf"
    assert result["content_type"] == "application/pdf"
    assert result["page_count"] == 2
    assert pdf_path.read_bytes().startswith(b"%PDF-")
    assert pdf_path.stat().st_size == result["size_bytes"]


def test_create_pdf_artifact_normalizes_plain_filename(tmp_path) -> None:
    outputs = tmp_path / "outputs"
    result = _payload(
        pdf_tool._impl(
            pdf_path="Simple Product Review",
            title=None,
            subtitle=None,
            summary_bullets=None,
            improvement_bullets=None,
            thread_data={"outputs_path": str(outputs)},
            state=None,
        )
    )

    assert result["success"] is True
    assert result["pdf_path"] == "/mnt/user-data/outputs/simple-product-review.pdf"
    assert (outputs / "simple-product-review.pdf").is_file()


def test_create_pdf_artifact_uses_builder_target_path(tmp_path) -> None:
    outputs = tmp_path / "outputs"
    state = {"builder_artifact_target_path": "/mnt/user-data/outputs/custom-review.pdf"}
    result = _payload(
        pdf_tool._impl(
            pdf_path=None,
            title=None,
            subtitle=None,
            summary_bullets=None,
            improvement_bullets=None,
            thread_data={"outputs_path": str(outputs)},
            state=state,
        )
    )

    assert result["success"] is True
    assert result["pdf_path"] == "/mnt/user-data/outputs/custom-review.pdf"
    assert (outputs / "custom-review.pdf").read_bytes().startswith(b"%PDF-")


def test_create_pdf_artifact_rejects_path_traversal(tmp_path) -> None:
    outputs = tmp_path / "outputs"
    result = _payload(
        pdf_tool._impl(
            pdf_path="/mnt/user-data/outputs/../../secret.pdf",
            title=None,
            subtitle=None,
            summary_bullets=None,
            improvement_bullets=None,
            thread_data={"outputs_path": str(outputs)},
            state=None,
        )
    )

    assert result == {
        "success": False,
        "error_type": "invalid_input",
        "error": "pdf_path must stay under /mnt/user-data/outputs/ and must not contain traversal",
    }
    assert not (tmp_path / "secret.pdf").exists()


def test_create_pdf_artifact_generation_failure_returns_safe_reason(tmp_path, monkeypatch) -> None:
    outputs = tmp_path / "outputs"

    def fail_render(**_kwargs):
        raise RuntimeError(f"boom at {outputs / 'secret.txt'}")

    monkeypatch.setattr(pdf_tool, "_render_simple_pdf_bytes", fail_render)

    result = _payload(
        pdf_tool._impl(
            pdf_path=None,
            title=None,
            subtitle=None,
            summary_bullets=None,
            improvement_bullets=None,
            thread_data={"outputs_path": str(outputs)},
            state=None,
        )
    )

    assert result["success"] is False
    assert result["error_type"] == "pdf_generation_failed"
    assert result["error"] == "pdf_generation_failed"
    assert result["error_class"] == "RuntimeError"
    assert "secret.txt" not in json.dumps(result)


def test_simple_pdf_request_forces_pdf_writer() -> None:
    middleware = BuilderArtifactMiddleware()
    state = {
        "builder_artifact_target_path": "/mnt/user-data/outputs/simple-product-review.pdf",
        "delegation_context": {
            "task": "Create a simple product review PDF artifact for the canvas smoke test.",
        },
    }

    assert middleware._force_choice_for_state(state) == {
        "type": "tool",
        "name": "create_pdf_artifact",
    }


def test_pdf_writer_success_result_forces_emit_next(tmp_path) -> None:
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    (outputs / "simple-product-review.pdf").write_bytes(b"%PDF-1.4\n")
    middleware = BuilderArtifactMiddleware()
    state = {
        "thread_data": {"outputs_path": str(outputs)},
        "builder_artifact_target_path": "/mnt/user-data/outputs/simple-product-review.pdf",
        "builder_pdf_render_result": {
            "success": True,
            "pdf_path": "/mnt/user-data/outputs/simple-product-review.pdf",
            "layout_quality": "ok",
        },
    }

    assert middleware._force_choice_for_state(state) == {
        "type": "tool",
        "name": "emit_builder_artifact",
    }


def test_pdf_writer_failure_ends_with_safe_builder_result(monkeypatch) -> None:
    fired: list[dict] = []

    def fake_fire(**kwargs):
        fired.append(kwargs)

    middleware = BuilderArtifactMiddleware()
    monkeypatch.setattr(middleware, "_upload_fallback_and_fire", fake_fire)
    request = SimpleNamespace(
        tool_call={"name": "create_pdf_artifact"},
        state={"builder_non_artifact_turns": 2},
        runtime=SimpleNamespace(context={"thread_id": "task-thread"}),
    )
    result = ToolMessage(
        content=json.dumps({
            "success": False,
            "error_type": "pdf_generation_failed",
            "error": "pdf_generation_failed",
        }),
        tool_call_id="tool-1",
        name="create_pdf_artifact",
    )

    command = middleware._pdf_result_command(request, result)

    assert command.goto == "end"
    assert command.update["builder_result"]["artifact_path"] is None
    assert command.update["builder_result"]["error_reason"] == "pdf_generation_failed"
    assert command.update["builder_result"]["artifact_title"] == "PDF generation failed"
    assert fired[0]["status"] == "failed"
    assert fired[0]["fallback"]["error_reason"] == "pdf_generation_failed"
