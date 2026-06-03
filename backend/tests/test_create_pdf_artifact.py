import json
from types import SimpleNamespace

from langchain_core.messages import ToolMessage
from pypdf import PdfReader

from deerflow.agents.sophia_agent.middlewares.builder_artifact import BuilderArtifactMiddleware
from deerflow.sophia.tools import create_pdf_artifact as pdf_tool


def _payload(result: str) -> dict:
    return json.loads(result)


def _pdf_page_texts(path) -> list[str]:
    reader = PdfReader(str(path))
    return [page.extract_text() or "" for page in reader.pages]


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
    assert result["structure_source"] == "fallback"
    assert result["structure_safe_reason"] == "no_explicit_page_structure"
    assert pdf_path.read_bytes().startswith(b"%PDF-")
    assert pdf_path.stat().st_size == result["size_bytes"]


def test_create_pdf_artifact_two_page_length_request_still_creates_two_pages(tmp_path) -> None:
    outputs = tmp_path / "outputs"
    result = _payload(
        pdf_tool._impl(
            pdf_path="Simple Product Review",
            title=None,
            subtitle=None,
            summary_bullets=None,
            improvement_bullets=None,
            thread_data={"outputs_path": str(outputs)},
            state={
                "delegation_context": {
                    "task": "Create a 2-page simple product review PDF artifact. Length: 2 pages.",
                },
            },
        )
    )

    pdf_path = outputs / "simple-product-review.pdf"
    assert result["success"] is True
    assert result["page_count"] == 2
    assert result["structure_source"] == "requested_page_count"
    assert result["structure_safe_reason"] == "length_requested_without_explicit_page_headings"
    assert len(_pdf_page_texts(pdf_path)) == 2
    assert pdf_path.read_bytes().startswith(b"%PDF-")


def test_create_pdf_artifact_explicit_four_page_request_creates_requested_pages(tmp_path) -> None:
    outputs = tmp_path / "outputs"
    prompt = "\n".join(
        [
            "Create a PDF for Review Together.",
            "Length: 4 pages",
            "Page 1 \u2014 Cover",
            "- Visual Artifact Review Deck",
            "- Prepared for Sophia review",
            "Page 2 \u2014 Current State",
            "- The canvas now opens real PDF artifacts.",
            "Page 3 \u2014 Visual Gaps",
            "- Page count used to collapse into a smoke template.",
            "Page 4 \u2014 Next Improvements",
            "- Make page navigation and thumbnails more polished.",
        ]
    )

    result = _payload(
        pdf_tool._impl(
            pdf_path="visual-artifact-review-deck.pdf",
            title=None,
            subtitle=None,
            summary_bullets=None,
            improvement_bullets=None,
            thread_data={"outputs_path": str(outputs)},
            state={"delegation_context": {"task": prompt}},
        )
    )

    pdf_path = outputs / "visual-artifact-review-deck.pdf"
    page_texts = _pdf_page_texts(pdf_path)
    assert result["success"] is True
    assert result["pdf_path"] == "/mnt/user-data/outputs/visual-artifact-review-deck.pdf"
    assert result["page_count"] == 4
    assert result["page_titles"] == ["Cover", "Current State", "Visual Gaps", "Next Improvements"]
    assert result["structure_source"] == "explicit_page_headings"
    assert result["structure_safe_reason"] is None
    assert len(page_texts) == 4
    assert "Visual Artifact Review Deck" in page_texts[0]
    assert "Current State" in page_texts[1]
    assert "Visual Gaps" in page_texts[2]
    assert "Next Improvements" in page_texts[3]
    assert pdf_path.read_bytes().startswith(b"%PDF-")


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


def test_pdf_writer_recovery_emits_artifact_path_from_successful_render(tmp_path) -> None:
    outputs = tmp_path / "outputs"
    result = _payload(
        pdf_tool._impl(
            pdf_path="Visual Artifact Review Deck",
            title=None,
            subtitle=None,
            summary_bullets=None,
            improvement_bullets=None,
            thread_data={"outputs_path": str(outputs)},
            state={
                "delegation_context": {
                    "task": (
                        "Create a PDF. Length: 4 pages\n"
                        "Page 1 - Cover\n"
                        "- Visual Artifact Review Deck\n"
                        "Page 2 - Current State\n"
                        "- Current State\n"
                        "Page 3 - Visual Gaps\n"
                        "- Visual Gaps\n"
                        "Page 4 - Next Improvements\n"
                        "- Next Improvements"
                    ),
                },
            },
        )
    )
    middleware = BuilderArtifactMiddleware()
    state = {
        "thread_data": {"outputs_path": str(outputs)},
        "builder_artifact_target_path": result["pdf_path"],
        "builder_pdf_render_result": result,
    }

    recovered = middleware._recover_emit_args_from_last_write(
        {"artifact_path": None},
        state,
        SimpleNamespace(context={"thread_id": "task-thread"}, config={}),
    )

    assert recovered is not None
    assert recovered["artifact_path"] == "/mnt/user-data/outputs/visual-artifact-review-deck.pdf"


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
