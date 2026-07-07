from __future__ import annotations

import os
from pathlib import Path

_SCRIPT_ROOT = Path("skills") / "hands-on-deck" / "scripts"


def repo_root() -> Path:
    return Path(__file__).resolve().parents[6]


def hands_on_deck_root() -> Path:
    configured = os.getenv("SOPHIA_HANDS_ON_DECK_ROOT")
    if configured:
        return Path(configured).expanduser().resolve()
    return repo_root() / "third_party" / "hands_on_deck"


def hands_on_deck_scripts_dir() -> Path:
    return hands_on_deck_root() / _SCRIPT_ROOT


def deck_cli_path() -> Path:
    return hands_on_deck_scripts_dir() / "deck.py"


def html2patch_cli_path() -> Path:
    return hands_on_deck_scripts_dir() / "html2patch.py"
