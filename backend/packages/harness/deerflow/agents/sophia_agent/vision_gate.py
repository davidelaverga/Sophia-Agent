"""Vision-capability gate for Sophia agents.

Both Sophia factories (companion and builder) bypass ``create_chat_model``
and instantiate ``ChatAnthropic`` directly, so they cannot rely on the
upstream factory pulling ``supports_vision`` from ``app_config.models``.
This module provides a single helper they share: ``supports_vision(name)``
returns the harness-side decision for whether to enable
``view_image_tool`` and ``ViewImageMiddleware`` for a given model.

Resolution order:

1. ``app_config.models`` — if the operator has explicitly declared the
   model with ``supports_vision: true|false``, that wins. Allows runtime
   override without code changes.
2. ``_DEFAULT_VISION_MODELS`` fallback — the Sophia default models
   (Sonnet 4.6 and Haiku 4.5) both support vision; falling back here lets
   the agents boot correctly without requiring an explicit
   ``config.production.yaml`` entry. Add new vision-capable Sophia models
   to this set as they're introduced.
3. ``False`` for unknown models — fail closed.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


# Sophia models known to support vision input natively. Kept in sync with
# the model strings used by ``builder_agent.py`` (Sonnet) and ``agent.py``
# (Haiku). Adding a new vision-capable Sophia model is a one-line change
# here; the gate then enables the tool + middleware automatically.
_DEFAULT_VISION_MODELS: frozenset[str] = frozenset(
    {
        "claude-sonnet-4-6",
        "claude-haiku-4-5-20251001",
    }
)


def supports_vision(model_name: str | None) -> bool:
    """Return True if ``model_name`` supports image input.

    Consults ``app_config.models`` first (operator-overridable); falls
    back to the hardcoded Sophia default set when the model isn't in
    config (the current production state). Returns ``False`` for unknown
    models.
    """
    if not model_name:
        return False

    try:
        from deerflow.config.app_config import get_app_config

        cfg = get_app_config().get_model_config(model_name)
        if cfg is not None:
            return bool(cfg.supports_vision)
    except Exception:
        # AppConfig load can fail in test environments without config.yaml.
        # Fall through to the hardcoded set rather than failing the gate.
        logger.debug(
            "vision_gate: app_config lookup failed for %r; using default set",
            model_name,
            exc_info=True,
        )

    return model_name in _DEFAULT_VISION_MODELS
