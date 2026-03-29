from __future__ import annotations

import logging
import time
from types import SimpleNamespace

import pytest

from voice.sophia_llm import SophiaLLM
from voice.tests.conftest import make_settings


@pytest.mark.anyio
async def test_turn_metrics_log_first_text_and_audio(caplog) -> None:
    llm = SophiaLLM(make_settings())
    participant = SimpleNamespace(user_id="user-1")

    caplog.set_level(logging.INFO)

    llm.note_turn_end(participant)
    time.sleep(0.001)
    llm.note_first_text_emitted("user-1")
    time.sleep(0.001)
    llm.note_tts_audio_emitted("user-1")
    await llm.events.wait()

    assert "metric=first_text_ms" in caplog.text
    assert "metric=first_audio_ms" in caplog.text