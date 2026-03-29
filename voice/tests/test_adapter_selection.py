from __future__ import annotations

from voice.adapters import build_backend_adapter
from voice.adapters.deerflow import DeerFlowBackendAdapter
from voice.adapters.shim import ShimBackendAdapter
from voice.tests.conftest import make_settings


def test_build_backend_adapter_returns_shim() -> None:
    adapter = build_backend_adapter(make_settings(backend_mode="shim"))

    assert isinstance(adapter, ShimBackendAdapter)


def test_build_backend_adapter_returns_deerflow() -> None:
    adapter = build_backend_adapter(make_settings(backend_mode="deerflow"))

    assert isinstance(adapter, DeerFlowBackendAdapter)