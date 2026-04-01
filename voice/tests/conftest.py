from __future__ import annotations

from voice.config import VoiceSettings


def make_settings(**overrides: object) -> VoiceSettings:
    values = {
        "backend_mode": "shim",
        "langgraph_base_url": "http://127.0.0.1:2024",
        "assistant_id": "sophia_companion",
        "platform": "voice",
        "context_mode": "life",
        "ritual": None,
        "agent_user_id": "sophia-agent",
        "agent_user_name": "Sophia",
        "cartesia_voice_id": "voice-id",
        "cartesia_model_id": "sonic-3",
        "cartesia_sample_rate": 16000,
        "deepgram_model": "nova-2",
        "deepgram_language": None,
        "smart_turn_silence_ms": 1200,
        "smart_turn_speech_threshold": 0.6,
        "smart_turn_pre_speech_buffer_ms": 200,
        "smart_turn_vad_reset_seconds": 5.0,
        "backend_timeout_seconds": 20.0,
        "readiness_timeout_seconds": 5.0,
        "shim_response_text": "Let's stay with this for a second.",
        "shim_chunk_delay_ms": 0,
        "shim_failure_stage": None,
        "shim_failure_message": "Forced shim failure for testing.",
        "shim_emit_invalid_artifact": False,
        "adaptive_silence_short_ms": 1000,
        "adaptive_silence_medium_ms": 1500,
        "adaptive_silence_long_ms": 2000,
        "adaptive_silence_ceiling_ms": 2800,
        "adaptive_silence_continuation_bonus_ms": 800,
        "fragile_window_ms": 600,
        "merge_min_new_words": 2,
        "rhythm_min_sessions": 5,
        "rhythm_base_min_ms": 800,
        "rhythm_base_max_ms": 2400,
    }
    values.update(overrides)
    return VoiceSettings(**values)