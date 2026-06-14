"""Brief extraction — the flush-for-delegation (Spec D D-3).

When the parent conversation was long or compacted, one structured Haiku
pass converts the delegation ledger into the brief schema: constraints
over instructions — the SCHEMA, not the phrase "complete self-contained
brief", defines completeness.

Placement (approved divergence from the spec text): this runs
BUILDER-side, in ``BuilderTaskMiddleware``'s briefing assembly — never
companion-side. A Haiku call inside ``start_builder_task`` would add
1-3s to the dispatching companion turn (voice has a 3s target) and would
fire precisely on long sessions, the trigger condition. Builder-side it
costs ~2s of a minutes-long async build, reads the same-disk ledger, and
re-runs naturally on terminal-redirect v2 briefs.

Grounding rule: every populated field must cite turn provenance
``[t{n}]``. Fields that fail validation are NULLED, never invented.
Failure policy mirrors image-gen: extraction failure never stalls the
build — the digest-only brief proceeds, with a logged skip reason.
"""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Any

logger = logging.getLogger(__name__)

_EXTRACTION_MODEL = "claude-haiku-4-5-20251001"
_EXTRACTION_MAX_TOKENS = 1000
_EXTRACTION_TIMEOUT_SECONDS = 30.0

# Deterministic trigger thresholds (Spec D D-3).
_TRIGGER_TURNS = 20
_TRIGGER_DELIVERABLE_INTENT_TURNS = 6

# Last-N recency window joined with deliverable-intent entries as input.
_RECENT_ENTRIES_WINDOW = 10

_STRING_FIELDS = ("audience", "purpose", "format_and_length")
_LIST_FIELDS = (
    "must_include",
    "must_exclude",
    "sources_and_examples",
    "style_preferences",
    "decisions_made",
    "open_questions",
)
BRIEF_SCHEMA_FIELDS: tuple[str, ...] = _STRING_FIELDS + _LIST_FIELDS

_PROVENANCE_PATTERN = re.compile(r"\[t\d+\]")


def extraction_enabled() -> bool:
    """SOPHIA_DELEGATION_EXTRACTION flag (default on)."""
    raw = os.environ.get("SOPHIA_DELEGATION_EXTRACTION", "").strip().lower()
    return raw not in {"0", "false", "off", "no"}


def extraction_triggered(stats: dict[str, Any] | None) -> bool:
    """Deterministic trigger: compacted OR long OR deliverable-heavy.

    ``stats`` is ``delegation_context["delegation_ledger"]`` stamped at
    dispatch (turns / deliverable_intent_turns / was_summarized), or a
    recomputed equivalent. Below every threshold: no model call — the
    deterministic digest alone suffices.
    """
    if not isinstance(stats, dict):
        return False
    if stats.get("was_summarized"):
        return True
    if int(stats.get("turns", 0) or 0) >= _TRIGGER_TURNS:
        return True
    return int(stats.get("deliverable_intent_turns", 0) or 0) >= _TRIGGER_DELIVERABLE_INTENT_TURNS


def _select_entries(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Deliverable-intent entries ∪ the last N, deduped, oldest-first."""
    recent_numbers = {
        entry.get("turn_number") for entry in entries[-_RECENT_ENTRIES_WINDOW:]
    }
    return [
        entry
        for entry in entries
        if entry.get("deliverable_intent") or entry.get("turn_number") in recent_numbers
    ]


def _render_entries(entries: list[dict[str, Any]]) -> str:
    lines: list[str] = []
    for entry in entries:
        text = " ".join(str(entry.get("user_text", "")).split())
        line = f"t{entry.get('turn_number')}: {text}"
        artifact = entry.get("artifact")
        takeaway = artifact.get("takeaway") if isinstance(artifact, dict) else None
        if isinstance(takeaway, str) and takeaway.strip():
            line += f" [takeaway: {takeaway.strip()}]"
        lines.append(line)
    return "\n".join(lines)


def _extraction_prompt(task_type: str, rendered_entries: str) -> str:
    return (
        "You are extracting build-brief constraints from a conversation "
        f"record, for a '{task_type}' deliverable. Reply with ONE JSON "
        "object only — no prose, no code fences — with exactly these "
        "fields:\n"
        '{"audience": str|null, "purpose": str|null, '
        '"format_and_length": str|null, "must_include": [str], '
        '"must_exclude": [str], "sources_and_examples": [str], '
        '"style_preferences": [str], "decisions_made": [str], '
        '"open_questions": [str]}\n\n'
        "Rules:\n"
        "- Extract ONLY what the user expressed. Empty/null is allowed; "
        "invention is forbidden.\n"
        "- EVERY populated value must cite the turn(s) it came from with "
        "an inline marker like [t12] (e.g. \"exclude pricing slides [t25]\").\n"
        "- A value without a [t{n}] marker will be discarded.\n\n"
        f"Conversation record (t{{n}} = turn number):\n{rendered_entries}"
    )


def _validated_field(value: Any) -> Any:
    """Keep a populated value only when it carries [t{n}] provenance."""
    if isinstance(value, str):
        return value if _PROVENANCE_PATTERN.search(value) else None
    if isinstance(value, list):
        return [
            item
            for item in value
            if isinstance(item, str) and _PROVENANCE_PATTERN.search(item)
        ]
    return None


def _parse_and_validate(text: str) -> dict[str, Any] | None:
    """Strip fences → json.loads → type-check → provenance-null."""
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```[a-zA-Z]*\n?", "", cleaned)
        cleaned = re.sub(r"\n?```$", "", cleaned.strip())
    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError:
        return None
    if not isinstance(parsed, dict):
        return None
    schema: dict[str, Any] = {}
    for field in _STRING_FIELDS:
        schema[field] = _validated_field(parsed.get(field))
    for field in _LIST_FIELDS:
        schema[field] = _validated_field(parsed.get(field)) or []
    return schema


def extract_brief(entries: list[dict[str, Any]], task_type: str) -> dict[str, Any] | None:
    """One model call over the ledger → validated brief schema, or None.

    Never raises. Provider-resilient (correction wave 2026-06-12): a
    provider-classified failure on the Anthropic primary (the 2026-06-12
    outage was a 401 on every call) gets ONE retry through the configured
    OpenAI fallback model — Spec D extraction survives primary outages
    instead of dying for their whole duration. The skip reason names the
    provider error class instead of a generic ``model_error``. Any double
    failure still degrades to digest-only.
    """
    if not extraction_enabled():
        return None
    if not entries:
        logger.info("[BriefExtraction] skipped reason=empty_ledger")
        return None
    selected = _select_entries(entries)
    if not selected:
        logger.info("[BriefExtraction] skipped reason=no_selectable_entries")
        return None
    prompt = _extraction_prompt(task_type, _render_entries(selected))
    text = _invoke_extraction_model(prompt)
    if text is None:
        return None
    schema = _parse_and_validate(text or "")
    if schema is None:
        logger.warning("[BriefExtraction] skipped reason=json_parse")
        return None
    populated = sum(1 for value in schema.values() if value)
    logger.info(
        "[BriefExtraction] ok entries=%d populated_fields=%d", len(selected), populated
    )
    return schema


def _invoke_extraction_model(prompt: str) -> str | None:
    """Primary (Haiku) call with one provider-classified fallback retry."""
    from langchain_core.messages import HumanMessage

    try:
        from langchain_anthropic import ChatAnthropic

        model = ChatAnthropic(
            model=_EXTRACTION_MODEL,
            api_key=os.environ.get("ANTHROPIC_API_KEY", ""),
            max_tokens=_EXTRACTION_MAX_TOKENS,
            timeout=_EXTRACTION_TIMEOUT_SECONDS,
            max_retries=0,
        )
        reply = model.invoke([HumanMessage(content=prompt)])
        return reply.text() if callable(getattr(reply, "text", None)) else str(reply.content)
    except Exception as exc:  # noqa: BLE001 — extraction is strictly best-effort
        # Same sophia-layer classifier the builder fallback uses: auth /
        # quota / rate-limit / 5xx are provider-availability errors worth
        # one fallback attempt; anything else (prompt bugs, local errors)
        # is not.
        from deerflow.sophia.builder_provider_fallback import classify_provider_error

        error_class = classify_provider_error(exc)
        if error_class is None:
            logger.warning("[BriefExtraction] skipped reason=model_error", exc_info=True)
            return None
        text = _invoke_fallback_extraction_model(prompt, error_class)
        if text is None:
            logger.warning(
                "[BriefExtraction] skipped reason=%s fallback_attempted=true", error_class
            )
        return text


def _invoke_fallback_extraction_model(prompt: str, error_class: str) -> str | None:
    """One retry via the configured OpenAI fallback model. Best-effort."""
    from langchain_core.messages import HumanMessage

    from deerflow.sophia.builder_provider_fallback import (
        build_fallback_chat_model,
        fallback_enabled,
        fallback_model_name,
        openai_api_key_present,
    )

    if not (fallback_enabled() and openai_api_key_present() and fallback_model_name()):
        logger.warning(
            "[BriefExtraction] skipped reason=%s fallback_attempted=false "
            "fallback_result=fallback_not_configured",
            error_class,
        )
        return None
    try:
        model = build_fallback_chat_model()
        reply = model.invoke([HumanMessage(content=prompt)])
        logger.info(
            "[BriefExtraction] fallback ok provider_error_class=%s final_provider=openai",
            error_class,
        )
        return reply.text() if callable(getattr(reply, "text", None)) else str(reply.content)
    except Exception:  # noqa: BLE001 — double failure degrades to digest-only
        return None
