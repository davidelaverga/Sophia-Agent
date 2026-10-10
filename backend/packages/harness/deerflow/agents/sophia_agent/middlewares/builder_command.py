"""Deterministic Builder command routing for explicit document requests.

When a user issues a direct document creation command such as
"Sophia create a dummy document of one page about X", the companion should
skip the clarification roulette and route straight into Builder with sane
defaults. This middleware synthesizes a ``start_builder_task`` tool call
before the model is invoked so the rest of the Builder pipeline remains
unchanged.

PR-B (2026-05): the synthesized tool call name was migrated from
``switch_to_builder`` to ``start_builder_task`` as part of the deepagents
async-subagent migration. The synthesized brief produced by
``_build_direct_document_task`` is unchanged — only the tool name and arg
key (``task`` → ``description``) differ.

Voice build requests (2026-09-30): the web voice bridge sends the companion a
``[Voice build request]`` message after the voice model has already called its
own ``start_builder_task`` and the browser has checked that the user explicitly
asked for it. That message is routed here too, so the build no longer depends
on the companion model choosing the tool a second time (R-016: it answered
without launching). The route only chooses the tool. Source authority, the
sealed handoff and the single-run binding are still enforced downstream.
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
from deerflow.sophia.diag import diag_event, run_timing

_WAKE_WORD_RE = re.compile(r"^\s*sophia[\s,:-]*", re.IGNORECASE)
_DIRECT_DOCUMENT_COMMAND_RE = re.compile(
    r"(?:^|[.!?]\s*|,\s*)(?:sophia[\s,:-]*)?(?:please\s+)?(?:create|make|draft|write|generate|build)\b",
    re.IGNORECASE,
)
_DOCUMENT_NOUN_RE = re.compile(
    r"\b(document|doc|one[- ]page|single[- ]page|page|brief|memo|report|article|essay|summary|outline)\b",
    re.IGNORECASE,
)
_TOPIC_RE = re.compile(r"\b(?:about|on)\s+(.+?)(?:[.?!]\s*)?$", re.IGNORECASE)
_DUMMY_RE = re.compile(r"\bdummy\b", re.IGNORECASE)
_EXPLICIT_PDF_TARGET_RE = re.compile(
    r"\b(?:"
    r"pdf\s+(?:document|file|report|brief|deliverable|output)"
    r"|(?:document|file|report|brief|deliverable|output)\s+(?:as|in|to)\s+(?:an?\s+)?pdf"
    r"|(?:create|make|generate|produce|write|render|export)\s+(?:an?\s+)?pdf\b"
    r"|(?:save|export|deliver|render|output)\b[^.?!\n]{0,48}\.pdf\b"
    r")",
    re.IGNORECASE,
)
_TRAILING_OUTPUT_CLAUSE_RE = re.compile(
    r"(?:\band\b|\bthen\b|[.;])\s*"
    r"(?:deliver|export|save|render|provide|return|output|convert)\b"
    r"(?P<prefix>[^.?!\n]{0,80}?)\b(?:as|to|in|into)\s+(?:an?\s+)?"
    r"(?:(?:editable|native|downloadable|final|single)\s+){0,3}"
    r"(?P<format>pdf|pptx|power\s*point|docx|word\s+document|xlsx|excel(?:\s+workbook)?|"
    r"html|web\s*page|csv|json|markdown|md)\b",
    re.IGNORECASE,
)
_TRAILING_DIRECT_DELIVERY_RE = re.compile(
    r"(?:\band\b|\bthen\b|[.;])\s*deliver\s+(?:an?\s+|the\s+)?(?:editable\s+)?"
    r"(?P<format>pdf|pptx|power\s*point|docx|word\s+document|xlsx|excel(?:\s+workbook)?|"
    r"html|web\s*page|csv|json|markdown|md)\b",
    re.IGNORECASE,
)
_TRAILING_FILE_DELIVERY_RE = re.compile(
    r"(?:\band\b|\bthen\b|[.;])\s*"
    r"(?:deliver|export|save|render|provide|return|output|convert)\b[^.?!\n]{0,80}?"
    r"(?P<format>\.pdf|\.pptx|\.docx|\.xlsx|\.html|\.csv|\.json|\.md)\b",
    re.IGNORECASE,
)
_OUTPUT_CLAUSE_NEGATION_RE = re.compile(
    r"\b(?:not|no|without|avoid|do\s+not|don't|instead\s+of|rather\s+than)\b",
    re.IGNORECASE,
)
# Mirrors buildVoiceBuilderStartMessage in
# frontend/src/app/lib/voice-builder-actions.ts. Corrections use a different
# header and stay with the model, which picks the update or edit tool.
_VOICE_BUILD_REQUEST_HEADER = "[Voice build request]"
_VOICE_BUILD_CORRECTION_HEADER = "[Voice build correction]"
_VOICE_BUILD_BRIEF_PREFIX = "Brief:"
_VOICE_BUILD_TASK_TYPE_RE = re.compile(r"^\s*Task type:\s*(?P<task_type>\S+)\s*$", re.IGNORECASE)
# Same set as start_builder_task's task_type Literal (Hard Constraint 13).
_VOICE_BUILD_TASK_TYPES = frozenset({"document", "research", "presentation", "frontend", "visual_report"})


class BuilderCommandMiddleware(AgentMiddleware[AgentState]):
    """Fast-path explicit document commands into ``start_builder_task``."""

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
        voice_request = parse_voice_build_request(user_text)
        if voice_request is not None:
            brief, task_type = voice_request
            call = _start_builder_task_call(brief, task_type)
            tool_call_id = call.tool_calls[0]["id"]
            timing = run_timing()
            log_middleware("BuilderCommand", f"voice build request routed to Builder (task_type={task_type} tool_call_id={tool_call_id} "
                f"since_run_start_ms={timing.get('since_run_start_ms')})", _t0)
            diag_event("builder.command.routed", route="voice", task_type=task_type, tool_call_id=tool_call_id, **timing)
            return call

        if _opens_with_voice_envelope(user_text):
            # A correction, or a malformed request: the model picks the update,
            # edit or start tool. A sentence inside it is never a new command.
            log_middleware("BuilderCommand", "skipped (voice correction or malformed voice request)", _t0)
            return None

        direct_task = _build_direct_document_task(user_text)
        if direct_task is None:
            log_middleware("BuilderCommand", "skipped (no explicit document command)", _t0)
            return None

        call = _start_builder_task_call(direct_task, "document")
        tool_call_id = call.tool_calls[0]["id"]
        timing = run_timing()
        log_middleware("BuilderCommand", f"direct document command routed to Builder (tool_call_id={tool_call_id} "
            f"since_run_start_ms={timing.get('since_run_start_ms')})", _t0)
        diag_event("builder.command.routed", route="direct", task_type="document", tool_call_id=tool_call_id, **timing)
        return call

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


def _start_builder_task_call(description: str, task_type: str) -> AIMessage:
    return AIMessage(
        content="",
        id=f"sophia-builder-direct-{uuid.uuid4().hex[:8]}",
        tool_calls=[
            {
                "name": "start_builder_task",
                "id": f"builder-direct-{uuid.uuid4().hex[:8]}",
                "args": {
                    "description": description,
                    "task_type": task_type,
                },
            }
        ],
    )


def _opens_with_voice_envelope(user_text: str) -> bool:
    first_line = (user_text or "").strip().split("\n", 1)[0].strip()
    return first_line in {_VOICE_BUILD_REQUEST_HEADER, _VOICE_BUILD_CORRECTION_HEADER}


def parse_voice_build_request(user_text: str) -> tuple[str, str] | None:
    """Return ``(brief, task_type)`` for a voice bridge build request.

    The header must be the first line and a non-empty ``Brief:`` must follow.
    Everything after ``Brief:`` is the brief, including later lines. A missing
    or unknown task type falls back to ``document``.
    """
    envelope = _parse_voice_build_envelope(user_text)
    if envelope is None:
        return None
    brief, task_type = envelope
    return brief, task_type or "document"


def voice_build_task_type(user_text: str) -> str | None:
    """Return the canonical task type a valid voice build request states, if any."""
    envelope = _parse_voice_build_envelope(user_text)
    return envelope[1] if envelope is not None else None


def _parse_voice_build_envelope(user_text: str) -> tuple[str, str | None] | None:
    lines = (user_text or "").strip().split("\n")
    if lines[0].strip() != _VOICE_BUILD_REQUEST_HEADER:
        return None
    for index, line in enumerate(lines[1:], start=1):
        stripped = line.lstrip()
        if stripped.startswith(_VOICE_BUILD_BRIEF_PREFIX):
            brief = "\n".join([stripped[len(_VOICE_BUILD_BRIEF_PREFIX):], *lines[index + 1:]]).strip()
            preamble = lines[1:index]
            break
    else:
        return None
    if not brief:
        return None
    task_type = None
    for line in preamble:
        match = _VOICE_BUILD_TASK_TYPE_RE.match(line)
        if match and match.group("task_type").lower() in _VOICE_BUILD_TASK_TYPES:
            task_type = match.group("task_type").lower()
    return brief, task_type


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

    topic_match = _TOPIC_RE.search(cleaned)
    if topic_match is None:
        return None

    # This middleware always synthesizes a Markdown document. Resolve only the
    # requested object before ``about``/``on`` and defer an explicit
    # non-Markdown target to the canonical current-turn router. Scoping the
    # check is important: format-like words in the topic (for example,
    # "a document about websites" or "a brief on Excel spreadsheets") are
    # subject matter, not requested output formats. Conversely, a PowerPoint
    # target followed by incidental document language such as "page numbers"
    # must not be stolen by this Markdown fast path.
    #
    # Import lazily to keep agent middleware initialization free of the
    # start_builder_task module's dispatch dependencies.
    from deerflow.sophia.tools.start_builder_task import (
        _requested_output_extension_match_with_vetoes,
    )

    target_scope = cleaned[: topic_match.start()].strip()
    requested_ext, _rule, _vetoed_rules = (
        _requested_output_extension_match_with_vetoes(target_scope)
    )
    # The canonical resolver intentionally defaults a bare ``create a report``
    # object to PDF. That is not an explicit format choice and must not change
    # this legacy Markdown fast path; a real PDF veto always contains ``PDF``
    # in the target-object scope.
    generic_report_pdf = requested_ext == "pdf" and not _has_affirmative_explicit_pdf_target(target_scope)
    if (
        requested_ext is not None
        and requested_ext not in {"md", "markdown"}
        and not generic_report_pdf
    ):
        return None

    if _suffix_requests_non_markdown_output(cleaned[topic_match.start():]):
        return None

    topic = topic_match.group(1).strip(" \t\r\n.?!")
    if not topic:
        return None

    artifact_path = f"/mnt/user-data/outputs/{_slugify(topic)}.md"
    artifact_title = f"One-Page Document: {topic}"
    companion_summary = f"Created the requested one-page document about {topic}."
    simplicity_note = (
        "The user called this a dummy document, so keep it simple but complete. "
        if _DUMMY_RE.search(cleaned)
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


def _suffix_requests_non_markdown_output(suffix: str) -> bool:
    for pattern in (
        _TRAILING_OUTPUT_CLAUSE_RE,
        _TRAILING_DIRECT_DELIVERY_RE,
        _TRAILING_FILE_DELIVERY_RE,
    ):
        for match in pattern.finditer(suffix):
            prefix = str(match.groupdict().get("prefix") or "")
            if _OUTPUT_CLAUSE_NEGATION_RE.search(prefix):
                continue
            requested_format = str(match.group("format") or "").lower().lstrip(".")
            if requested_format not in {"md", "markdown"}:
                return True
    return False


def _has_affirmative_explicit_pdf_target(target_scope: str) -> bool:
    for match in _EXPLICIT_PDF_TARGET_RE.finditer(target_scope):
        local_prefix = target_scope[max(0, match.start() - 24) : match.start()]
        if _OUTPUT_CLAUSE_NEGATION_RE.search(local_prefix):
            continue
        return True
    return False


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    slug = slug[:48].strip("-")
    return slug or "requested-document"
