from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]


def test_deck_design_skill_mirrors_and_pins_are_current() -> None:
    completed = subprocess.run(
        [sys.executable, str(PROJECT_ROOT / "scripts" / "sync_deck_design_skills.py"), "--check"],
        cwd=PROJECT_ROOT,
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode == 0, completed.stderr or completed.stdout
    expected = {
        "hands-on-deck": "1e94c3aa6bbe810708406ede1c248ebfd651bb2a",
        "deck-impeccable": "630fc2682a5bd39b25a8e61f74b6b3f14f2b1e21",
        "hallmark": "aeb42fb354ff4efa36ab475773a082315a3af2ce",
    }
    lock_paths = {
        "hands-on-deck": PROJECT_ROOT / "skills/public/hands-on-deck/UPSTREAM.lock.json",
        "deck-impeccable": PROJECT_ROOT / "skills/public/deck-impeccable/UPSTREAM.lock.json",
        "hallmark": PROJECT_ROOT / "skills/public/hallmark/UPSTREAM.lock.json",
    }
    for name, path in lock_paths.items():
        assert json.loads(path.read_text(encoding="utf-8"))["upstream_commit"] == expected[name]
