from __future__ import annotations

from voice.adapters.base import BackendAdapter
from voice.adapters.deerflow import DeerFlowBackendAdapter
from voice.adapters.shim import ShimBackendAdapter
from voice.config import VoiceSettings


def build_backend_adapter(settings: VoiceSettings) -> BackendAdapter:
    if settings.backend_mode == "shim":
        return ShimBackendAdapter(settings)
    if settings.backend_mode == "deerflow":
        return DeerFlowBackendAdapter(settings)
    raise ValueError(f"Unsupported backend mode: {settings.backend_mode!r}")


__all__ = [
    "BackendAdapter",
    "DeerFlowBackendAdapter",
    "ShimBackendAdapter",
    "build_backend_adapter",
]