from __future__ import annotations

import argparse
import json
from pathlib import Path

from deerflow.sophia.deck_quality.rubric import (
    build_rubric_lock,
    compile_rubric,
    render_rubric_markdown,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
SOURCE = REPO_ROOT / "skills/public/sophia/deck_rubric.yaml"
MARKDOWN = REPO_ROOT / "skills/public/sophia/deck_rubric.md"
LOCK = REPO_ROOT / "skills/public/sophia/deck_rubric.lock.json"


def expected_outputs() -> tuple[str, str]:
    compiled = compile_rubric(SOURCE)
    markdown = render_rubric_markdown(compiled)
    lock = build_rubric_lock(
        compiled,
        source_path="skills/public/sophia/deck_rubric.yaml",
    )
    lock_json = json.dumps(lock.model_dump(mode="json"), indent=2, sort_keys=True) + "\n"
    return markdown, lock_json


def main() -> int:
    parser = argparse.ArgumentParser(description="Compile and verify the DQ-1 deck rubric")
    parser.add_argument("--check", action="store_true", help="fail if generated artifacts drift")
    args = parser.parse_args()
    markdown, lock_json = expected_outputs()
    if args.check:
        mismatches = []
        if not MARKDOWN.is_file() or MARKDOWN.read_text(encoding="utf-8") != markdown:
            mismatches.append(str(MARKDOWN.relative_to(REPO_ROOT)))
        if not LOCK.is_file() or LOCK.read_text(encoding="utf-8") != lock_json:
            mismatches.append(str(LOCK.relative_to(REPO_ROOT)))
        if mismatches:
            parser.error("generated rubric artifacts drifted: " + ", ".join(mismatches))
        return 0
    MARKDOWN.write_text(markdown, encoding="utf-8")
    LOCK.write_text(lock_json, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
