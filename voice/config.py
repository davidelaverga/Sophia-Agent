from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv


ROOT_DIR = Path(__file__).resolve().parents[1]
VOICE_DIR = ROOT_DIR / "voice"

for env_file in (VOICE_DIR / ".env", ROOT_DIR / ".env"):
    if env_file.exists():
        load_dotenv(env_file, override=False)


SUPPORTED_BACKEND_MODES = {"shim", "deerflow"}
SUPPORTED_PLATFORMS = {"voice", "text", "ios_voice"}
SUPPORTED_SHIM_FAILURE_STAGES = {"ready", "request", "stream", "artifact", "timeout"}


def _env_int(name: str, default: int) -> int:
    value = os.getenv(name)
    return int(value) if value else default


def _env_float(name: str, default: float) -> float:
    value = os.getenv(name)
    return float(value) if value else default


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _env_first(names: tuple[str, ...], default: str | None = None) -> str | None:
    for name in names:
        value = os.getenv(name)
        if value is None:
            continue
        value = value.strip()
        if value:
            return value
    return default


def _env_optional(name: str) -> str | None:
    value = os.getenv(name)
    if value is None:
        return None
    value = value.strip()
    return value or None


@dataclass(frozen=True)
class VoiceSettings:
    backend_mode: str
    langgraph_base_url: str
    assistant_id: str
    platform: str
    context_mode: str
    ritual: str | None
    agent_user_id: str
    agent_user_name: str
    cartesia_voice_id: str | None
    cartesia_model_id: str
    cartesia_sample_rate: int
    deepgram_model: str
    deepgram_language: str | None
    smart_turn_silence_ms: int
    smart_turn_speech_threshold: float
    smart_turn_pre_speech_buffer_ms: int
    smart_turn_vad_reset_seconds: float
    backend_timeout_seconds: float
    readiness_timeout_seconds: float
    shim_response_text: str
    shim_chunk_delay_ms: int
    shim_failure_stage: str | None
    shim_failure_message: str
    shim_emit_invalid_artifact: bool
    adaptive_silence_short_ms: int
    adaptive_silence_medium_ms: int
    adaptive_silence_long_ms: int
    adaptive_silence_ceiling_ms: int
    adaptive_silence_continuation_bonus_ms: int
    adaptive_silence_fragment_bonus_ms: int
    backend_stall_timeout_ms: int
    fragile_window_ms: int
    merge_min_new_words: int
    rhythm_min_sessions: int
    rhythm_base_min_ms: int
    rhythm_base_max_ms: int
    same_turn_repeat_debounce_ms: int

    @property
    def llm_label(self) -> str:
        if self.backend_mode == "shim":
            return "shim"
        return f"deerflow:{self.assistant_id}"

    @property
    def instructions(self) -> str:
        return (
            "You are Sophia, an emotionally attuned voice companion. "
            "Speak naturally and keep replies to 1-3 sentences. "
            "Be warm, grounded, and specific. Ask at most one focused question at a time. "
            "Do not sound clinical, robotic, or like a generic assistant."
        )

    def validate(self) -> None:
        if self.backend_mode not in SUPPORTED_BACKEND_MODES:
            supported = ", ".join(sorted(SUPPORTED_BACKEND_MODES))
            raise ValueError(
                f"Unsupported SOPHIA_BACKEND_MODE={self.backend_mode!r}. Use one of: {supported}."
            )

        if self.platform not in SUPPORTED_PLATFORMS:
            supported = ", ".join(sorted(SUPPORTED_PLATFORMS))
            raise ValueError(
                f"Unsupported SOPHIA_PLATFORM={self.platform!r}. Use one of: {supported}."
            )

        required_env = [
            "STREAM_API_KEY",
            "STREAM_API_SECRET",
            "DEEPGRAM_API_KEY",
            "CARTESIA_API_KEY",
        ]
        missing = [name for name in required_env if not os.getenv(name)]
        if missing:
            joined = ", ".join(missing)
            raise ValueError(f"Missing required voice environment variables: {joined}.")

        if self.backend_mode == "deerflow":
            if not self.langgraph_base_url:
                raise ValueError(
                    "SOPHIA_LANGGRAPH_BASE_URL is required when SOPHIA_BACKEND_MODE=deerflow."
                )
            if not self.assistant_id:
                raise ValueError(
                    "SOPHIA_ASSISTANT_ID is required when SOPHIA_BACKEND_MODE=deerflow."
                )

        if (
            self.shim_failure_stage is not None
            and self.shim_failure_stage not in SUPPORTED_SHIM_FAILURE_STAGES
        ):
            supported = ", ".join(sorted(SUPPORTED_SHIM_FAILURE_STAGES))
            raise ValueError(
                f"Unsupported SOPHIA_SHIM_FAILURE_STAGE={self.shim_failure_stage!r}. "
                f"Use one of: {supported}."
            )


@lru_cache(maxsize=1)
def get_settings() -> VoiceSettings:
    backend_mode = os.getenv("SOPHIA_BACKEND_MODE") or os.getenv("SOPHIA_LLM_MODE") or "shim"
    backend_mode = backend_mode.strip().lower()
    if backend_mode == "anthropic":
        backend_mode = "shim"

    legacy_buffer_seconds = _env_first(("SOPHIA_BUFFER_IN_SECONDS",))
    silence_ms_default = 1200
    if legacy_buffer_seconds is not None:
        silence_ms_default = int(float(legacy_buffer_seconds) * 1000)

    confidence_threshold_default = 0.6
    legacy_confidence_threshold = _env_first(("SOPHIA_CONFIDENCE_THRESHOLD",))
    if legacy_confidence_threshold is not None:
        confidence_threshold_default = float(legacy_confidence_threshold)

    settings = VoiceSettings(
        backend_mode=backend_mode,
        langgraph_base_url=_env_first(
            ("SOPHIA_LANGGRAPH_BASE_URL", "SOPHIA_BACKEND_BASE_URL"),
            "http://127.0.0.1:2024",
        ).rstrip("/"),
        assistant_id=os.getenv("SOPHIA_ASSISTANT_ID", "sophia_companion").strip(),
        platform=os.getenv("SOPHIA_PLATFORM", "voice").strip(),
        context_mode=os.getenv("SOPHIA_CONTEXT_MODE", "life").strip(),
        ritual=_env_optional("SOPHIA_RITUAL"),
        agent_user_id=os.getenv("SOPHIA_AGENT_USER_ID", "sophia-agent"),
        agent_user_name=os.getenv("SOPHIA_AGENT_USER_NAME", "Sophia"),
        cartesia_voice_id=_env_optional("SOPHIA_VOICE_ID"),
        cartesia_model_id=os.getenv("SOPHIA_CARTESIA_MODEL", "sonic-3"),
        cartesia_sample_rate=_env_int("SOPHIA_CARTESIA_SAMPLE_RATE", 16000),
        deepgram_model=os.getenv("SOPHIA_DEEPGRAM_MODEL", "flux-general-en"),
        deepgram_language=_env_optional("SOPHIA_DEEPGRAM_LANGUAGE"),
        smart_turn_silence_ms=_env_int(
            "SOPHIA_SMART_TURN_SILENCE_MS", silence_ms_default
        ),
        smart_turn_speech_threshold=_env_float(
            "SOPHIA_SMART_TURN_SPEECH_THRESHOLD", confidence_threshold_default
        ),
        smart_turn_pre_speech_buffer_ms=_env_int(
            "SOPHIA_SMART_TURN_PRE_SPEECH_BUFFER_MS", 200
        ),
        smart_turn_vad_reset_seconds=_env_float(
            "SOPHIA_SMART_TURN_VAD_RESET_SECONDS", 5.0
        ),
        backend_timeout_seconds=_env_float("SOPHIA_BACKEND_TIMEOUT_SECONDS", 20.0),
        readiness_timeout_seconds=_env_float("SOPHIA_READINESS_TIMEOUT_SECONDS", 5.0),
        shim_response_text=os.getenv(
            "SOPHIA_SHIM_RESPONSE_TEXT",
            "Let's stay with this for a second.",
        ).strip(),
        shim_chunk_delay_ms=_env_int("SOPHIA_SHIM_CHUNK_DELAY_MS", 40),
        shim_failure_stage=_env_optional("SOPHIA_SHIM_FAILURE_STAGE"),
        shim_failure_message=os.getenv(
            "SOPHIA_SHIM_FAILURE_MESSAGE",
            "Forced shim failure for testing.",
        ).strip(),
        shim_emit_invalid_artifact=_env_bool("SOPHIA_SHIM_EMIT_INVALID_ARTIFACT", False),
        adaptive_silence_short_ms=_env_int("SOPHIA_ADAPTIVE_SILENCE_SHORT_MS", 600),
        adaptive_silence_medium_ms=_env_int("SOPHIA_ADAPTIVE_SILENCE_MEDIUM_MS", 800),
        adaptive_silence_long_ms=_env_int("SOPHIA_ADAPTIVE_SILENCE_LONG_MS", 1200),
        adaptive_silence_ceiling_ms=_env_int("SOPHIA_ADAPTIVE_SILENCE_CEILING_MS", 1400),
        adaptive_silence_continuation_bonus_ms=_env_int(
            "SOPHIA_ADAPTIVE_SILENCE_CONTINUATION_BONUS_MS", 300
        ),
        adaptive_silence_fragment_bonus_ms=_env_int(
            "SOPHIA_ADAPTIVE_SILENCE_FRAGMENT_BONUS_MS", 500
        ),
        backend_stall_timeout_ms=_env_int("SOPHIA_BACKEND_STALL_TIMEOUT_MS", 8000),
        fragile_window_ms=_env_int("SOPHIA_FRAGILE_WINDOW_MS", 600),
        merge_min_new_words=_env_int("SOPHIA_MERGE_MIN_NEW_WORDS", 2),
        rhythm_min_sessions=_env_int("SOPHIA_RHYTHM_MIN_SESSIONS", 5),
        rhythm_base_min_ms=_env_int("SOPHIA_RHYTHM_BASE_MIN_MS", 800),
        rhythm_base_max_ms=_env_int("SOPHIA_RHYTHM_BASE_MAX_MS", 2400),
        same_turn_repeat_debounce_ms=_env_int(
            "SOPHIA_SAME_TURN_REPEAT_DEBOUNCE_MS", 1200
        ),
    )
    settings.validate()
    return settings
