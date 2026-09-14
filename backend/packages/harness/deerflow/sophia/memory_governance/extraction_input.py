"""Immutable inputs for the existing extractor; no model/provider reconfiguration."""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, date, datetime

from .models import ExtractionInputContext
from .refs import keyed_ref
from .store import MemoryGovernanceUnavailable


def capture_context(*, context_mode: str, session_date: str | None = None) -> ExtractionInputContext:
    from deerflow.sophia.extraction import _load_template

    return ExtractionInputContext.model_validate({
        "schema": "mem00.extract-input.v1",
        "session_date": session_date or datetime.now(UTC).date().isoformat(),
        "context_mode": context_mode,
        "template_sha256": hashlib.sha256(_load_template().encode()).hexdigest(),
    })


def context_is_current(context: ExtractionInputContext, *, context_mode: str) -> bool:
    from deerflow.sophia.extraction import _load_template

    try:
        date.fromisoformat(context.session_date)
        return context.context_mode == context_mode and context.template_sha256 == hashlib.sha256(_load_template().encode()).hexdigest()
    except Exception:
        raise MemoryGovernanceUnavailable("memory_extractor_context_unavailable") from None


def prompt_input_ref(*, owner_id: str, session_id: str, prompt: str, model: str) -> str:
    # Bind the actual inference request, including model and unchanged max_tokens.
    request = {"owner_id": owner_id, "session_id": session_id, "model": model, "max_tokens": 4096,
        "messages": [{"role": "user", "content": prompt}]}
    return keyed_ref("extractor-input", json.dumps(request, sort_keys=True, separators=(",", ":")))


def extraction_input_ref(*, owner_id: str, session_id: str, messages: list[dict], context: ExtractionInputContext, model: str) -> str:
    from deerflow.sophia.extraction import _load_template, _render_extraction_prompt

    if not context_is_current(context, context_mode=context.context_mode):
        raise MemoryGovernanceUnavailable("memory_extractor_template_changed")
    metadata = {"session_date": context.session_date, "context_mode": context.context_mode}
    prompt = _render_extraction_prompt(_load_template(), session_id=session_id, messages=messages, metadata=metadata)
    return prompt_input_ref(owner_id=owner_id, session_id=session_id, prompt=prompt, model=model)
