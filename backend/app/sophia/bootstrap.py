"""BootstrapFewShot — injects golden turn examples into voice.md.

Week 6 feature. Scans traces for golden turns, formats as examples,
and appends to voice.md as "Real Session Examples" section.

IMPORTANT: soul.md is NEVER modified. It is architecturally excluded.
"""

from __future__ import annotations

from pathlib import Path

VOICE_MD_PATH = Path("skills/public/sophia/voice.md")


def inject_examples_into_voice_md(golden_turns: list[dict]) -> None:
    """Append golden turn examples to voice.md.

    IMPORTANT: This modifies voice.md only. soul.md is permanently immutable.
    """
    if not golden_turns:
        return

    if not VOICE_MD_PATH.exists():
        return

    content = VOICE_MD_PATH.read_text()

    # Remove existing examples section if present
    marker = "\n## Real Session Examples"
    if marker in content:
        content = content[: content.index(marker)]

    # Build examples section
    examples = [marker, ""]
    for i, turn in enumerate(golden_turns, 1):
        examples.append(f"### Example {i} (tone_delta: +{turn.get('tone_delta', 0):.1f})")
        examples.append(f"- **Skill:** {turn.get('skill_loaded', 'unknown')}")
        examples.append(f"- **Emotion:** {turn.get('voice_emotion_primary', 'unknown')}")
        examples.append(f"- **Speed:** {turn.get('voice_speed', 'normal')}")
        examples.append(f"- **Band:** {turn.get('active_tone_band', 'unknown')}")
        examples.append("")

    content += "\n".join(examples)
    VOICE_MD_PATH.write_text(content)
