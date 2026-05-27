"""Vision-capability gate for Sophia agents.

Both Sophia factories (companion and builder) bypass ``create_chat_model``
and instantiate ``ChatAnthropic`` directly, so they cannot rely on the
upstream factory pulling ``supports_vision`` from ``app_config.models``.
This module provides a single helper they share: ``supports_vision(name)``
returns the harness-side decision for whether to enable
``view_image_tool`` and ``ViewImageMiddleware`` for a given model.

Resolution order:

1. ``app_config.models[*].supports_vision`` — but ONLY when the operator
   *explicitly* set the field. ``ModelConfig.supports_vision`` defaults
   to ``False`` when the YAML entry omits the key (the current
   production state — ``config.production.yaml`` declares the Haiku
   entry without ``supports_vision:``). A defaulted ``False`` must NOT
   masquerade as an operator override, otherwise the gate would silently
   disable vision for known-good Sophia models the moment they appear
   in config without an explicit declaration.

   We use Pydantic v2's ``model_fields_set`` to distinguish the two
   cases: present in the set = explicit, absent = defaulted.

   **Lookup matches on either ``ModelConfig.name`` OR
   ``ModelConfig.model``.** Callers can pass either the config entry's
   ``name`` (companion does this with the hardcoded Haiku string) OR
   the provider model string (builder's ``_resolve_builder_model_name``
   returns ``model_cfg.model``, not ``model_cfg.name``). An alias-style
   config entry like
   ``- name: claude-sonnet\n    model: claude-sonnet-4-6`` must surface
   its explicit ``supports_vision`` override regardless of which of the
   two strings the agent factory happens to pass. Codex P2 on PR #132.

2. ``_DEFAULT_VISION_MODELS`` fallback — applied when the model isn't
   in config OR when it's in config but ``supports_vision`` is omitted.
   The Sophia default models (Sonnet 4.6 and Haiku 4.5) both support
   vision natively; falling back here lets the agents boot correctly
   without requiring a ``config.production.yaml`` edit. Add new
   vision-capable Sophia models to this set as they're introduced.

3. ``False`` for unknown models — fail closed.

This was the fix to PR #132 codex P1 review: previously the resolver
returned ``bool(cfg.supports_vision)`` unconditionally on any cfg hit,
which collapsed "explicit false" and "field omitted" into the same
branch and broke vision for production Haiku. The follow-up Codex P2
review then surfaced the alias-lookup gap addressed above.
"""

from __future__ import annotations

import logging
from typing import Any

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


def _find_model_config(model_name: str) -> Any | None:
    """Locate a ModelConfig that matches either ``name`` or ``model``.

    The upstream ``AppConfig.get_model_config`` only matches on
    ``name``. Callers of ``supports_vision`` may pass either:

    - the config entry's ``name`` (e.g. ``claude-haiku-4-5-20251001``
      when ``name`` and ``model`` are the same string — the common
      Sophia case), or
    - the provider model string itself (e.g. the builder's
      ``_resolve_builder_model_name`` returns ``model_cfg.model``
      directly when no parent passes ``model_name`` explicitly).

    To honor operator overrides regardless of which form the agent
    factory uses, we first try the canonical ``name`` lookup (which
    wins ties), then fall back to scanning by ``.model``. Returns
    ``None`` when no entry matches either field.
    """
    from deerflow.config.app_config import get_app_config

    app = get_app_config()

    by_name = app.get_model_config(model_name)
    if by_name is not None:
        return by_name

    for entry in getattr(app, "models", None) or []:
        if getattr(entry, "model", None) == model_name:
            return entry

    return None


def supports_vision(model_name: str | None) -> bool:
    """Return True if ``model_name`` supports image input.

    Honors an *explicit* ``supports_vision`` setting in
    ``app_config.models`` (operator override, true or false) — matched
    against either ``ModelConfig.name`` or ``ModelConfig.model``;
    otherwise falls back to the hardcoded Sophia default set. Returns
    ``False`` for unknown models with no default-set entry.
    """
    if not model_name:
        return False

    explicit_config_value: bool | None = None
    try:
        cfg = _find_model_config(model_name)
        if cfg is not None:
            # ``model_fields_set`` is Pydantic v2's record of which
            # fields the caller actually supplied (defaulted fields are
            # NOT in the set). Only honor the config value when the
            # operator explicitly typed ``supports_vision: ...`` — a
            # silently-defaulted False must not bypass the default set.
            fields_set = getattr(cfg, "model_fields_set", None) or set()
            if "supports_vision" in fields_set:
                explicit_config_value = bool(cfg.supports_vision)
    except Exception:
        # AppConfig load can fail in test environments without config.yaml.
        # Fall through to the hardcoded set rather than failing the gate.
        logger.debug(
            "vision_gate: app_config lookup failed for %r; using default set",
            model_name,
            exc_info=True,
        )

    if explicit_config_value is not None:
        return explicit_config_value

    return model_name in _DEFAULT_VISION_MODELS
