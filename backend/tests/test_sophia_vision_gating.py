"""``supports_vision`` gate behaviour.

Both Sophia agents instantiate ``ChatAnthropic`` directly rather than
going through ``create_chat_model``, so the harness-side decision about
whether to enable ``view_image_tool`` + ``ViewImageMiddleware`` lives in
``vision_gate.supports_vision``. These tests pin the resolution order:

1. ``app_config.models`` wins when the model is configured.
2. Hardcoded fallback covers the default Sophia models when config is
   missing or partial (the current production state — no models declared
   in ``config.production.yaml``).
3. Unknown models fail closed.
"""

from __future__ import annotations

from types import SimpleNamespace

from deerflow.agents.sophia_agent import vision_gate


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


def test_app_config_overrides_fallback(monkeypatch) -> None:
    """Operator-configured supports_vision=False wins over the fallback set."""
    cfg_with_disabled = SimpleNamespace(
        get_model_config=lambda name: SimpleNamespace(supports_vision=False)
        if name == "claude-sonnet-4-6"
        else None,
    )
    monkeypatch.setattr(
        "deerflow.config.app_config.get_app_config",
        lambda: cfg_with_disabled,
    )
    assert vision_gate.supports_vision("claude-sonnet-4-6") is False


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
