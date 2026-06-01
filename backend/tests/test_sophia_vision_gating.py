"""``supports_vision`` gate behaviour.

Both Sophia agents instantiate ``ChatAnthropic`` directly rather than
going through ``create_chat_model``, so the harness-side decision about
whether to enable ``view_image_tool`` + ``ViewImageMiddleware`` lives in
``vision_gate.supports_vision``. These tests pin the resolution order:

1. **Explicit** ``app_config.models[*].supports_vision`` (true or
   false) wins. ``model_fields_set`` distinguishes explicit settings
   from defaulted ``False`` — without that distinction, the production
   config (which declares Haiku WITHOUT ``supports_vision:``) would
   silently disable vision for the companion. Locked by
   ``test_production_haiku_shape_falls_back_to_default`` (the codex
   PR #132 P1 regression).
2. Hardcoded fallback covers the default Sophia models when the field
   was omitted (the current production state).
3. Unknown models fail closed.
"""

from __future__ import annotations

from types import SimpleNamespace

from deerflow.agents.sophia_agent import vision_gate
from deerflow.config.model_config import ModelConfig


def test_default_sonnet_falls_back_to_true(monkeypatch) -> None:
    """Sonnet 4.6 is in the fallback set — gate True even without config."""
    monkeypatch.setattr(
        vision_gate, "_DEFAULT_VISION_MODELS", frozenset({"claude-sonnet-4-6"})
    )

    class _NoConfig:
        def get_model_config(self, _name):
            return None

    monkeypatch.setattr(
        "deerflow.config.app_config.get_app_config",
        lambda: _NoConfig(),
    )

    assert vision_gate.supports_vision("claude-sonnet-4-6") is True


def test_default_haiku_falls_back_to_true(monkeypatch) -> None:
    monkeypatch.setattr(
        "deerflow.config.app_config.get_app_config",
        lambda: SimpleNamespace(get_model_config=lambda _n: None),
    )
    assert vision_gate.supports_vision("claude-haiku-4-5-20251001") is True


def test_unknown_model_returns_false(monkeypatch) -> None:
    monkeypatch.setattr(
        "deerflow.config.app_config.get_app_config",
        lambda: SimpleNamespace(get_model_config=lambda _n: None),
    )
    assert vision_gate.supports_vision("gpt-4-unknown") is False


def test_none_model_returns_false() -> None:
    assert vision_gate.supports_vision(None) is False
    assert vision_gate.supports_vision("") is False


def test_explicit_false_in_config_overrides_fallback(monkeypatch) -> None:
    """Operator-configured supports_vision=False wins over the fallback set."""
    # Use a real ModelConfig so model_fields_set reflects the explicit set.
    cfg_with_disabled = ModelConfig(
        name="claude-sonnet-4-6",
        use="langchain_anthropic:ChatAnthropic",
        model="claude-sonnet-4-6",
        supports_vision=False,
    )
    app = SimpleNamespace(
        get_model_config=lambda name: cfg_with_disabled if name == "claude-sonnet-4-6" else None,
    )
    monkeypatch.setattr(
        "deerflow.config.app_config.get_app_config",
        lambda: app,
    )
    assert vision_gate.supports_vision("claude-sonnet-4-6") is False


def test_explicit_true_in_config_for_unknown_model_enables_vision(monkeypatch) -> None:
    """Operator-configured supports_vision=True enables vision for any model."""
    cfg_with_enabled = ModelConfig(
        name="claude-future-99",
        use="langchain_anthropic:ChatAnthropic",
        model="claude-future-99",
        supports_vision=True,
    )
    app = SimpleNamespace(
        get_model_config=lambda name: cfg_with_enabled if name == "claude-future-99" else None,
    )
    monkeypatch.setattr(
        "deerflow.config.app_config.get_app_config",
        lambda: app,
    )
    assert vision_gate.supports_vision("claude-future-99") is True


def test_production_haiku_shape_falls_back_to_default(monkeypatch) -> None:
    """Regression: production config declares Haiku without ``supports_vision``.

    Codex flagged this on PR #132 (P1). ModelConfig.supports_vision
    defaults to False when omitted, so a naïve ``return bool(cfg.supports_vision)``
    silently disables vision for the production companion. The fix:
    consult ``model_fields_set`` so a defaulted False is NOT treated as
    an operator override, and the gate falls through to the default set
    (where Haiku 4.5 lives) → returns True.
    """
    haiku_as_in_production = ModelConfig(
        name="claude-haiku-4-5-20251001",
        use="langchain_anthropic:ChatAnthropic",
        model="claude-haiku-4-5-20251001",
        # NOTE: supports_vision deliberately omitted — mirrors the
        # actual config.production.yaml entry. The Pydantic default
        # makes ``cfg.supports_vision`` evaluate to False, but
        # ``model_fields_set`` must NOT include 'supports_vision'.
    )
    assert "supports_vision" not in haiku_as_in_production.model_fields_set, (
        "Test premise broken: ModelConfig now reports an omitted "
        "supports_vision as explicitly set. Update the gate logic."
    )

    app = SimpleNamespace(
        get_model_config=lambda name: haiku_as_in_production
        if name == "claude-haiku-4-5-20251001"
        else None,
    )
    monkeypatch.setattr(
        "deerflow.config.app_config.get_app_config",
        lambda: app,
    )

    assert vision_gate.supports_vision("claude-haiku-4-5-20251001") is True, (
        "Production Haiku has supports_vision omitted; the gate must fall "
        "through to the default set instead of treating the defaulted "
        "False as an operator override. Otherwise SophiaViewImageMiddleware "
        "is silently dropped and view_user_image loads images that never "
        "reach the model."
    )


def test_app_config_failure_falls_through_to_default(monkeypatch) -> None:
    """If app_config can't be loaded (test env, missing file), still enable for defaults."""
    def _raise():
        raise FileNotFoundError("config.yaml not present")

    monkeypatch.setattr(
        "deerflow.config.app_config.get_app_config",
        _raise,
    )
    assert vision_gate.supports_vision("claude-sonnet-4-6") is True
    assert vision_gate.supports_vision("gpt-4-unknown") is False


# ─── alias-lookup regressions (Codex P2 on PR #132) ──────────────────────────


def _patch_app_config_models(monkeypatch, models: list[ModelConfig]) -> None:
    """Wire a fake AppConfig with the given ModelConfig list.

    ``AppConfig.get_model_config`` only matches on ``name``, so the
    helper preserves that semantic for the ``by_name`` lookup; the
    secondary ``.model`` scan in vision_gate then walks ``.models``.
    """
    app = SimpleNamespace(
        models=models,
        get_model_config=lambda name: next(
            (m for m in models if m.name == name), None
        ),
    )
    monkeypatch.setattr(
        "deerflow.config.app_config.get_app_config",
        lambda: app,
    )


def test_alias_entry_explicit_true_enables_unknown_model(monkeypatch) -> None:
    """Config alias `- name: foo\\n    model: bar` with supports_vision=true
    must enable vision when the caller passes ``bar`` (not ``foo``)."""
    aliased = ModelConfig(
        name="my-custom-vision-alias",
        use="langchain_anthropic:ChatAnthropic",
        model="some-future-vision-model",
        supports_vision=True,
    )
    _patch_app_config_models(monkeypatch, [aliased])

    # Caller passed the provider model string, not the config name.
    assert vision_gate.supports_vision("some-future-vision-model") is True, (
        "Builder's _resolve_builder_model_name returns model_cfg.model, "
        "not model_cfg.name. The gate must scan by .model so operator "
        "overrides on aliased entries are honored."
    )


def test_alias_entry_explicit_false_disables_default_model(monkeypatch) -> None:
    """Config alias targeting a default-set model with supports_vision=false
    must beat the fallback — operator's explicit disable wins."""
    aliased_disable = ModelConfig(
        name="claude-sonnet-aliased",
        use="langchain_anthropic:ChatAnthropic",
        model="claude-sonnet-4-6",
        supports_vision=False,
    )
    _patch_app_config_models(monkeypatch, [aliased_disable])

    # Without the alias lookup, this would return True via the default
    # set (claude-sonnet-4-6 is in _DEFAULT_VISION_MODELS), masking the
    # operator's explicit disable.
    assert vision_gate.supports_vision("claude-sonnet-4-6") is False, (
        "Operator's explicit supports_vision=false on an aliased entry "
        "must beat the default set — otherwise the fallback silently "
        "overrides operator intent."
    )


def test_name_match_wins_over_alias_match(monkeypatch) -> None:
    """If two entries match (one by name, one by .model), the name match
    wins. That's the explicit address; the .model match is the fallback."""
    by_name_entry = ModelConfig(
        name="claude-sonnet-4-6",
        use="langchain_anthropic:ChatAnthropic",
        model="claude-sonnet-4-6",
        supports_vision=True,
    )
    by_model_entry = ModelConfig(
        name="aliased-sonnet",
        use="langchain_anthropic:ChatAnthropic",
        model="claude-sonnet-4-6",
        supports_vision=False,
    )
    # Order shouldn't matter — name match must win regardless.
    _patch_app_config_models(monkeypatch, [by_model_entry, by_name_entry])

    assert vision_gate.supports_vision("claude-sonnet-4-6") is True


def test_alias_entry_omitting_supports_vision_falls_through(monkeypatch) -> None:
    """An alias entry that omits supports_vision must NOT mask the
    default set — same defaulted-vs-explicit distinction as the
    name-match path."""
    aliased_omitted = ModelConfig(
        name="claude-sonnet-aliased",
        use="langchain_anthropic:ChatAnthropic",
        model="claude-sonnet-4-6",
        # supports_vision omitted on purpose
    )
    _patch_app_config_models(monkeypatch, [aliased_omitted])

    assert vision_gate.supports_vision("claude-sonnet-4-6") is True, (
        "Alias entry omitted supports_vision (defaulted to False). The "
        "gate must treat that as 'not configured' and fall through to "
        "the default set, just like it does for the name-match path."
    )
