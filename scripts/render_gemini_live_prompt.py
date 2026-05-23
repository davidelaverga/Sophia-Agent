from __future__ import annotations

import json
import re
from pathlib import Path

from voice.config import get_settings
from voice.realtime.dogfood_session import (
    _dogfood_tool_declarations,
    _instructions_for_selection,
    _model_for_selection,
)
from voice.realtime.gemini_live import build_gemini_live_setup_config
from voice.realtime.runtime_selection import VoiceRuntimeMode


ROOT_DIR = Path(__file__).resolve().parents[1]
OUTPUT_PATH = ROOT_DIR / "docs" / "debug" / "gemini-live-fully-rendered-sophia-prompt.md"
PLACEHOLDER_PATTERNS = (
    re.compile(r"\{\{[^{}]+\}\}"),
    re.compile(r"\{[A-Za-z_][A-Za-z0-9_]*\}"),
)


def _extract_system_instruction_text(setup: dict[str, object]) -> str:
    system_instruction = setup.get("systemInstruction")
    if not isinstance(system_instruction, dict):
        raise ValueError("Gemini setup did not include systemInstruction.")

    parts = system_instruction.get("parts")
    if not isinstance(parts, list) or not parts:
        raise ValueError("Gemini setup systemInstruction.parts was empty.")

    first_part = parts[0]
    if not isinstance(first_part, dict):
        raise ValueError("Gemini setup systemInstruction.parts[0] was not an object.")

    text = first_part.get("text")
    if not isinstance(text, str) or not text:
        raise ValueError("Gemini setup systemInstruction.parts[0].text was empty.")
    return text


def _find_unresolved_placeholders(text: str) -> list[str]:
    matches: set[str] = set()
    for pattern in PLACEHOLDER_PATTERNS:
        matches.update(pattern.findall(text))
    return sorted(matches)


def main() -> int:
    settings = get_settings()
    settings.validate()

    selection = settings.voice_runtime_selection
    if selection.mode != VoiceRuntimeMode.GEMINI_LIVE:
        raise SystemExit(
            "Gemini Live prompt render requires SOPHIA_VOICE_RUNTIME_MODE=gemini_live; "
            f"current mode is {selection.mode.value!r}."
        )

    instructions = _instructions_for_selection(settings, selection.mode, None)
    setup = build_gemini_live_setup_config(
        instructions=instructions,
        model=_model_for_selection(settings, selection.mode),
        tools=_dogfood_tool_declarations(selection.mode),
    )
    rendered_prompt = _extract_system_instruction_text(setup)

    if rendered_prompt != instructions:
        raise SystemExit(
            "Gemini setup wrapped a different systemInstruction text than the dogfood "
            "instructions path produced."
        )

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(rendered_prompt, encoding="utf-8")

    unresolved_placeholders = _find_unresolved_placeholders(rendered_prompt)
    summary = {
        "output_path": str(OUTPUT_PATH),
        "assembly_function": "voice.realtime.sophia_prompt.build_gemini_live_realtime_setup_instructions",
        "assembly_path": "voice.server:start_gemini_browser_dogfood_session -> voice.realtime.gemini_browser_dogfood.GeminiBrowserDogfoodSessionManager.start_browser_session -> voice.realtime.dogfood_session.RealtimeDogfoodSessionManager.start_session -> voice.realtime.dogfood_session._instructions_for_selection -> voice.realtime.sophia_prompt.build_gemini_live_realtime_setup_instructions -> voice.realtime.gemini_live.build_gemini_live_setup_config",
        "platform": settings.platform,
        "context_mode": settings.context_mode,
        "ritual": settings.ritual,
        "model": _model_for_selection(settings, selection.mode),
        "unresolved_placeholders": unresolved_placeholders,
    }
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())