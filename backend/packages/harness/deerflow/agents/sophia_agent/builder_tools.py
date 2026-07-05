"""Sophia builder tool list assembly.

Kept separate from ``builder_agent.py`` so the LangGraph entry-point module
does not absorb every concrete tool import and trip the structural fan-out
gate. Behavior remains owned by the builder factory tests.
"""

from __future__ import annotations

import os

from deerflow.sandbox.tools import bash_tool, ls_tool, read_file_tool, str_replace_tool, write_file_tool
from deerflow.sophia.tools.build_deck_from_slides import build_deck_from_slides
from deerflow.sophia.tools.builder_web_fetch import builder_web_fetch
from deerflow.sophia.tools.builder_web_search import builder_web_search
from deerflow.sophia.tools.create_pdf_artifact import create_pdf_artifact
from deerflow.sophia.tools.emit_builder_artifact import emit_builder_artifact
from deerflow.sophia.tools.prepare_deck_build import prepare_deck_build
from deerflow.sophia.tools.prepare_pptx_image_manifest import prepare_pptx_image_manifest
from deerflow.sophia.tools.read_session_context import read_session_context, read_tool_enabled
from deerflow.sophia.tools.render_html_to_pdf import render_html_to_pdf
from deerflow.tools.builtins.view_image_tool import view_image_tool

_PRESENTATION_TASK_TYPES = {"presentation", "slides", "slide_deck", "deck"}
_REPORT_TASK_TYPES = {"document", "pdf", "report", "research", "research_report", "visual_report", "data_analysis"}
_FALSEY_VALUES = {"0", "false", "no", "off"}
_TRUTHY_VALUES = {"1", "true", "yes", "on"}
_PPTX_DECK_SERVICE_TOOL = "prepare_deck_build"
_PPTX_LEGACY_DECK_TOOLS = {
    "prepare_pptx_image_manifest",
    "build_deck_from_slides",
}


def deck_build_service_enabled() -> bool:
    raw_value = os.getenv("SOPHIA_DECK_BUILD_SERVICE_ENABLED")
    if raw_value is None or not raw_value.strip():
        return True
    return raw_value.strip().lower() not in _FALSEY_VALUES


def deck_build_service_flag_value() -> str:
    raw_value = os.getenv("SOPHIA_DECK_BUILD_SERVICE_ENABLED")
    if raw_value is None or not raw_value.strip():
        return "unset_default_on"
    normalized = raw_value.strip().lower()
    if normalized in _FALSEY_VALUES:
        return normalized
    if normalized in _TRUTHY_VALUES:
        return normalized
    return "custom_default_on"


def _normalized_task_type(task_type: str | None) -> str:
    return str(task_type or "").strip().lower()


def _normalized_target_ext(artifact_target_ext: str | None = None) -> str:
    ext = str(artifact_target_ext or "").strip().lower()
    if ext and not ext.startswith("."):
        ext = f".{ext}"
    return ext


def _presentation_toolset_required(task_type: str | None, artifact_target_ext: str | None = None) -> bool:
    normalized_task_type = _normalized_task_type(task_type)
    target_ext = _normalized_target_ext(artifact_target_ext)
    if target_ext:
        return target_ext in {".ppt", ".pptx"} or (
            target_ext == ".pdf" and normalized_task_type in _PRESENTATION_TASK_TYPES
        )
    return normalized_task_type in _PRESENTATION_TASK_TYPES


def _deck_build_service_target(task_type: str | None, artifact_target_ext: str | None = None) -> bool:
    if not _presentation_toolset_required(task_type, artifact_target_ext):
        return False
    target_ext = _normalized_target_ext(artifact_target_ext)
    return not target_ext or target_ext in {".ppt", ".pptx"}


def deck_route_for_task(task_type: str | None, artifact_target_ext: str | None = None) -> str | None:
    if not _presentation_toolset_required(task_type, artifact_target_ext):
        return None
    if _deck_build_service_target(task_type, artifact_target_ext) and deck_build_service_enabled():
        return "deck_build_service"
    return "legacy_html_slide_to_pptx"


def deck_tool_contract_snapshot(
    tools: list,
    *,
    task_type: str | None,
    artifact_target_ext: str | None = None,
) -> dict[str, object] | None:
    route = deck_route_for_task(task_type, artifact_target_ext)
    if route is None:
        return None
    tool_names = [getattr(tool, "name", "") for tool in tools if getattr(tool, "name", "")]
    lower_level_tools = sorted(name for name in tool_names if name in _PPTX_LEGACY_DECK_TOOLS)
    deck_service_target = _deck_build_service_target(task_type, artifact_target_ext)
    return {
        "route": route,
        "deck_build_service_enabled": deck_build_service_enabled(),
        "deck_build_service_flag": deck_build_service_flag_value(),
        "legacy_reason": (
            ("deck_build_service_disabled" if deck_service_target else "non_pptx_presentation_target")
            if route == "legacy_html_slide_to_pptx"
            else None
        ),
        "task_type": task_type,
        "artifact_target_ext": artifact_target_ext,
        "tool_names": tool_names,
        "prepare_deck_build_exposed": _PPTX_DECK_SERVICE_TOOL in tool_names,
        "lower_level_deck_tools_exposed": lower_level_tools,
    }


def assert_deck_tool_contract(
    tools: list,
    *,
    task_type: str | None,
    artifact_target_ext: str | None = None,
) -> dict[str, object] | None:
    snapshot = deck_tool_contract_snapshot(
        tools,
        task_type=task_type,
        artifact_target_ext=artifact_target_ext,
    )
    if snapshot is None:
        return None
    if snapshot["route"] == "deck_build_service":
        if not snapshot["prepare_deck_build_exposed"] or snapshot["lower_level_deck_tools_exposed"]:
            raise RuntimeError(
                "Fresh PPTX deck tool contract drift: expected only prepare_deck_build "
                "for DeckBuildService route."
            )
    elif snapshot["prepare_deck_build_exposed"]:
        raise RuntimeError(
            "Fresh PPTX deck tool contract drift: prepare_deck_build exposed while "
            "legacy deck mode is explicitly enabled."
        )
    return snapshot


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
        insert_at = tools.index(emit_builder_artifact)
        if _deck_build_service_target(task_type, artifact_target_ext) and deck_build_service_enabled():
            tools.insert(insert_at, prepare_deck_build)
        else:
            # Emergency legacy route: model-facing HTML-slide path. P-1 keeps
            # this only behind the disabled feature flag while the harness-owned
            # DeckBuildService rolls out.
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
