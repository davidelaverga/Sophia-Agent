"""Deterministic Builder command routing for explicit document requests.

When a user issues a direct document creation command such as
"Sophia create a dummy document of one page about X", the companion should
skip the clarification roulette and route straight into Builder with sane
defaults. This middleware synthesizes a switch_to_builder tool call before the
model is invoked so the rest of the Builder pipeline remains unchanged.
"""

from __future__ import annotations

import json
import re
import time
import uuid
from collections.abc import Awaitable, Callable
from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelCallResult, ModelRequest, ModelResponse
from langchain_core.messages import AIMessage

from deerflow.agents.sophia_agent.utils import extract_last_message_text, log_middleware

_WAKE_WORD_RE = re.compile(r"^\s*sophia[\s,:-]*", re.IGNORECASE)
_DIRECT_DOCUMENT_COMMAND_RE = re.compile(
    r"(?:^|[.!?]\s*|,\s*)(?:sophia[\s,:-]*)?(?:please\s+)?(?:(?:create|make|draft|write|generate|build)\b|(?:(?:give|send)\s+me\b)|(?:i\s+(?:need|want)\s+(?:a|an|another|one|some|this)\b))",
    re.IGNORECASE,
)
_DOCUMENT_NOUN_RE = re.compile(
    r"\b(document|doc|one[- ]page|single[- ]page|page|brief|memo|report|article|essay|summary|outline|pdf|markdown|html|file)\b",
    re.IGNORECASE,
)
_TOPIC_RE = re.compile(r"\b(?:about|on)\s+(.+?)(?:[.?!]\s*)?$", re.IGNORECASE)
_QUOTED_TITLE_RE = re.compile(r"\b(?:titled|called|named)\s+['\"]([^'\"]+)['\"]", re.IGNORECASE)
_UNQUOTED_TITLE_RE = re.compile(
    r"\b(?:titled|called|named)\s+(.+?)(?:[.?!]\s*|\s+(?:page|with|about|on|that|including|include|containing)\b|$)",
    re.IGNORECASE,
)
_DELIVERABLE_FORMAT_RE = re.compile(r"\b(pdf|markdown|html)\b", re.IGNORECASE)
_PAGE_COUNT_RE = re.compile(r"\b(\d+)[- ]page\b", re.IGNORECASE)
_DUMMY_RE = re.compile(r"\bdummy\b", re.IGNORECASE)


class BuilderCommandMiddleware(AgentMiddleware[AgentState]):
    """Fast-path explicit document commands into switch_to_builder."""

    state_schema = AgentState

    def _build_direct_tool_call(self, request: ModelRequest) -> AIMessage | None:
        _t0 = time.perf_counter()

        if request.state.get("skip_expensive"):
            log_middleware("BuilderCommand", "skipped on crisis path", _t0)
            return None

        if not request.messages:
            log_middleware("BuilderCommand", "skipped (no messages)", _t0)
            return None

        last_message = request.messages[-1]
        if getattr(last_message, "type", None) not in {"human", "user"}:
            log_middleware("BuilderCommand", "skipped (latest message is not user input)", _t0)
            return None

        user_text = extract_last_message_text(request.messages)
        direct_task = _build_direct_document_task(user_text)
        if direct_task is None:
            log_middleware("BuilderCommand", "skipped (no explicit document command)", _t0)
            return None

        tool_call_id = f"builder-direct-{uuid.uuid4().hex[:8]}"
        log_middleware("BuilderCommand", "direct document command routed to Builder", _t0)
        return AIMessage(
            content="",
            id=f"sophia-builder-direct-{uuid.uuid4().hex[:8]}",
            tool_calls=[
                {
                    "name": "switch_to_builder",
                    "id": tool_call_id,
                    "args": {
                        "task": direct_task,
                        "task_type": "document",
                    },
                }
            ],
        )

    @override
    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], ModelResponse],
    ) -> ModelCallResult:
        direct_tool_call = self._build_direct_tool_call(request)
        if direct_tool_call is not None:
            return direct_tool_call
        return handler(request)

    @override
    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelCallResult:
        direct_tool_call = self._build_direct_tool_call(request)
        if direct_tool_call is not None:
            return direct_tool_call
        return await handler(request)


def _build_direct_document_task(user_text: str) -> str | None:
    """Convert an explicit one-page document command into a concrete Builder brief."""
    if not user_text:
        return None

    command_match = _DIRECT_DOCUMENT_COMMAND_RE.search(user_text)
    if command_match is None:
        return None

    cleaned = user_text[command_match.start():].lstrip(" \t\r\n,.;:-")
    cleaned = _WAKE_WORD_RE.sub("", cleaned).strip()

    if not _DOCUMENT_NOUN_RE.search(cleaned):
        return None

    requested_format = _extract_requested_format(cleaned)
    if requested_format is not None:
        title = _extract_request_title(cleaned) or _extract_request_topic(cleaned)
        if title is None:
            return None
        return _build_explicit_file_task(
            user_text=user_text,
            cleaned_text=cleaned,
            title=title,
            requested_format=requested_format,
        )

    topic = _extract_request_topic(cleaned)
    if topic is None:
        return None

    return _build_default_markdown_task(user_text=user_text, cleaned_text=cleaned, topic=topic)


def _extract_request_topic(cleaned_text: str) -> str | None:
    topic_match = _TOPIC_RE.search(cleaned_text)
    if topic_match is None:
        return None

    topic = topic_match.group(1).strip(" \t\r\n.?!")
    if not topic:
        return None

    return topic


def _extract_request_title(cleaned_text: str) -> str | None:
    quoted_match = _QUOTED_TITLE_RE.search(cleaned_text)
    if quoted_match is not None:
        title = quoted_match.group(1).strip()
        return title or None

    unquoted_match = _UNQUOTED_TITLE_RE.search(cleaned_text)
    if unquoted_match is None:
        return None

    title = unquoted_match.group(1).strip(" \t\r\n'\".?!")
    return title or None


def _extract_requested_format(cleaned_text: str) -> str | None:
    format_match = _DELIVERABLE_FORMAT_RE.search(cleaned_text)
    if format_match is None:
        return None

    return format_match.group(1).lower()


def _build_default_markdown_task(user_text: str, cleaned_text: str, topic: str) -> str:
    artifact_path = f"/mnt/user-data/outputs/{_slugify(topic)}.md"
    artifact_title = f"One-Page Document: {topic}"
    companion_summary = f"Created the requested one-page document about {topic}."
    simplicity_note = (
        "The user called this a dummy document, so keep it simple but complete. "
        if _DUMMY_RE.search(cleaned_text)
        else ""
    )

    return (
        f"Create exactly one markdown file at {artifact_path}. "
        "Do not ask clarifying questions. Treat missing specs as approved defaults. "
        f"Original request: {user_text.strip()} "
        f"Topic: {topic}. "
        "Length: about one page (roughly 450-600 words). "
        "Audience: a general reader. "
        "Tone: clear, direct, and neutral. "
        "Structure: a descriptive title, a short introduction, 3 headed sections, and a brief conclusion. "
        "Write the deliverable directly to /mnt/user-data/outputs using that absolute path. "
        f"{simplicity_note}"
        "Create no other files unless strictly necessary. "
        "After writing the file, call emit_builder_artifact as your final action with "
        f"artifact_path={json.dumps(artifact_path)}, "
        "artifact_type='document', "
        f"artifact_title={json.dumps(artifact_title)}, "
        "steps_completed=3, "
        "decisions_made=['Used default audience and tone', 'Created a single markdown deliverable', 'Filled missing specs without follow-up questions'], "
        f"companion_summary={json.dumps(companion_summary)}, "
        "companion_tone_hint='Confident', "
        "user_next_action='Open or download the document and tell me what to revise next.', "
        "confidence=0.86."
    )


def _build_explicit_file_task(
    user_text: str,
    cleaned_text: str,
    title: str,
    requested_format: str,
) -> str:
    extension_by_format = {
        "pdf": ".pdf",
        "markdown": ".md",
        "html": ".html",
    }
    deliverable_label = {
        "pdf": "PDF",
        "markdown": "markdown file",
        "html": "standalone HTML file",
    }
    format_specific_guidance = {
        "pdf": "Produce a real PDF file, not a markdown or source-script substitute. ",
        "markdown": "Use plain markdown with no wrapper prose outside the deliverable. ",
        "html": "Ensure the HTML is standalone, valid, and ready to open directly in a browser. ",
    }
    companion_summary = {
        "pdf": f"Created the requested PDF '{title}'.",
        "markdown": f"Created the requested markdown file '{title}'.",
        "html": f"Created the requested HTML file '{title}'.",
    }
    next_action = {
        "pdf": "Open the PDF and review it.",
        "markdown": "Open the markdown file and review it.",
        "html": "Open the HTML file in a browser and review it.",
    }

    extension = extension_by_format[requested_format]
    artifact_path = f"/mnt/user-data/outputs/{_slugify(title)}{extension}"
    page_count_match = _PAGE_COUNT_RE.search(cleaned_text)
    page_requirement = ""
    verification_requirement = ""
    execution_requirement = ""
    if requested_format == "pdf" and page_count_match is not None:
        page_count = page_count_match.group(1)
        page_requirement = f"Length: exactly {page_count} pages. "
        verification_requirement = (
            f"Before emit_builder_artifact, verify with pypdf that the final PDF has exactly {page_count} pages. "
            "If the page count is wrong, fix or regenerate the PDF and verify again before finalizing. "
        )
        execution_requirement = (
            "Implement it as a single short reportlab.pdfgen.canvas generator script at "
            f"/mnt/user-data/outputs/_generate_{_slugify(title)}.py with one showPage() call per required page. "
            "Keep all page content inline in that script or in a single JSON sidecar only. "
            "Do not use local helper modules, packages, or auto-paginating Platypus/flowables. "
        )

    return (
        f"Create exactly one {deliverable_label[requested_format]} at {artifact_path}. "
        "Do not ask clarifying questions. Treat missing specs as approved defaults. "
        f"Original request: {user_text.strip()} "
        f"Title: {title}. "
        f"{page_requirement}"
        "Follow the user's explicit structure, section, page, bullet-count, and formatting requirements exactly. "
        f"{format_specific_guidance[requested_format]}"
        f"{verification_requirement}"
        f"{execution_requirement}"
        "Write the deliverable directly to /mnt/user-data/outputs using that absolute path. "
        "Create no other files unless strictly necessary. For PDFs and other binary deliverables, do NOT "
        "create Python helper modules or packages; keep the work in one generator script or one JSON sidecar "
        "only, and avoid producing __pycache__/ or .pyc byproducts. "
        "After writing the file, call emit_builder_artifact as your final action with "
        f"artifact_path={json.dumps(artifact_path)}, "
        "artifact_type='document', "
        f"artifact_title={json.dumps(title)}, "
        "steps_completed=3, "
        "decisions_made=['Used the requested output format', 'Created a single deliverable', 'Followed the provided specs without follow-up questions'], "
        f"companion_summary={json.dumps(companion_summary[requested_format])}, "
        "companion_tone_hint='Confident', "
        f"user_next_action={json.dumps(next_action[requested_format])}, "
        "confidence=0.88."
    )


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    slug = slug[:48].strip("-")
    return slug or "requested-document"