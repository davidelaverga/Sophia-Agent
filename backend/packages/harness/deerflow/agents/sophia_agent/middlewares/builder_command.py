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
    r"(?:^|[.!?]\s*|,\s*)(?:sophia[\s,:-]*)?(?:please\s+)?(?:create|make|draft|write|generate|build)\b",
    re.IGNORECASE,
)
_DOCUMENT_NOUN_RE = re.compile(
    r"\b(document|doc|one[- ]page|single[- ]page|page|brief|memo|report|article|essay|summary|outline)\b",
    re.IGNORECASE,
)
_TOPIC_RE = re.compile(r"\b(?:about|on)\s+(.+?)(?:[.?!]\s*)?$", re.IGNORECASE)
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

    topic_match = _TOPIC_RE.search(cleaned)
    if topic_match is None:
        return None

    topic = topic_match.group(1).strip(" \t\r\n.?!")
    if not topic:
        return None

    artifact_path = f"outputs/{_slugify(topic)}.md"
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


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    slug = slug[:48].strip("-")
    return slug or "requested-document"