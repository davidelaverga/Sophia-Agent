from __future__ import annotations

import pytest

from voice.adapters.base import BackendStageError
from voice.server import validate_runtime
from voice.tests.conftest import make_settings


class FakeLLM:
    def __init__(self, error: Exception | None = None) -> None:
        self.error = error
        self.probed = False

    async def probe(self) -> None:
        self.probed = True
        if self.error is not None:
            raise self.error


@pytest.mark.anyio
async def test_validate_runtime_calls_probe() -> None:
    llm = FakeLLM()

    await validate_runtime(make_settings(), llm)

    assert llm.probed is True


@pytest.mark.anyio
async def test_validate_runtime_propagates_backend_stage_errors() -> None:
    llm = FakeLLM(BackendStageError("backend-ready", "probe failed"))

    with pytest.raises(BackendStageError, match="probe failed"):
        await validate_runtime(make_settings(), llm)