"""Sophia builder tool list assembly.

Kept separate from ``builder_agent.py`` so the LangGraph entry-point module
does not absorb every concrete tool import and trip the structural fan-out
gate. Behavior remains owned by the builder factory tests.
"""

from __future__ import annotations

from deerflow.sandbox.tools import bash_tool, ls_tool, read_file_tool, str_replace_tool, write_file_tool
from deerflow.sophia.tools.build_deck_from_slides import build_deck_from_slides
from deerflow.sophia.tools.builder_web_fetch import builder_web_fetch
from deerflow.sophia.tools.builder_web_search import builder_web_search
from deerflow.sophia.tools.create_pdf_artifact import create_pdf_artifact
from deerflow.sophia.tools.emit_builder_artifact import emit_builder_artifact
from deerflow.sophia.tools.prepare_pptx_image_manifest import prepare_pptx_image_manifest
from deerflow.sophia.tools.read_session_context import read_session_context, read_tool_enabled
from deerflow.sophia.tools.render_html_to_pdf import render_html_to_pdf
from deerflow.tools.builtins.view_image_tool import view_image_tool

_PRESENTATION_TASK_TYPES = {"presentation", "slides", "slide_deck", "deck"}
_REPORT_TASK_TYPES = {"document", "pdf", "report", "research", "research_report", "visual_report", "data_analysis"}


def _normalized_task_type(task_type: str | None) -> str:
    return str(task_type or "").strip().lower()


def _normalized_target_ext(artifact_target_ext: str | None = None) -> str:
    ext = str(artifact_target_ext or "").strip().lower()
    if ext and not ext.startswith("."):
        ext = f".{ext}"
    return ext


def _presentation_toolset_required(task_type: str | None, artifact_target_ext: str | None = None) -> bool:
    target_ext = _normalized_target_ext(artifact_target_ext)
    if target_ext:
        return target_ext in {".ppt", ".pptx"}
    return _normalized_task_type(task_type) in _PRESENTATION_TASK_TYPES


def build_builder_tools_for_task_type(
    task_type: str | None,
    *,
    vision_enabled: bool,
    artifact_target_ext: str | None = None,
) -> list:
    """Build the Builder's tool list for the concrete delegated task type."""
    tools = [
        bash_tool,
        ls_tool,
        read_file_tool,
        write_file_tool,
        str_replace_tool,
        builder_web_search,
        builder_web_fetch,
        create_pdf_artifact,
        emit_builder_artifact,
    ]
    if _presentation_toolset_required(task_type, artifact_target_ext):
        # Decks (HTML-slide path, restored 2026-06-29): the model authors one
        # self-contained 1920x1080 HTML file per slide (real DOM title/narrative +
        # one embedded VISUAL-ONLY generated image by relative ../assets path),
        # with the manifest JSON prepared by prepare_pptx_image_manifest and
        # compiled by build_deck_from_slides. The model never writes python-pptx,
        # pptxgenjs, ad hoc manifest JSON, or deck compiler code.
        insert_at = tools.index(emit_builder_artifact)
        tools.insert(insert_at, prepare_pptx_image_manifest)
        insert_at = tools.index(emit_builder_artifact)
        tools.insert(insert_at, build_deck_from_slides)
    else:
        # Report/document builds render via HTML→PDF (headless Chromium): the
        # model authors ONE HTML file with inline <svg> charts/diagrams, then
        # calls render_html_to_pdf. Both the remote generate_chart (GPT-Vis,
        # rendered empty charts in prod) and the markdown→pandoc path are
        # retired for reports — see the 2026-06-25 visual-render-regression
        # forensics. Their tool files stay on disk (shared page-count-gate
        # helpers + tests) but are no longer offered to the builder.
        insert_at = tools.index(emit_builder_artifact)
        tools.insert(insert_at, render_html_to_pdf)

    # Vision is gated by the same ``supports_vision`` decision that governs
    # ViewImageMiddleware inclusion, keeping the tool list and middleware
    # chain in lock-step.
    if vision_enabled:
        tools.append(view_image_tool)

    # Scoped recall over the parent companion session's delegation ledger.
    if read_tool_enabled():
        tools.append(read_session_context)
    return tools
