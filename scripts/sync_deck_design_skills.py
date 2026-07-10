#!/usr/bin/env python3
"""Synchronize pinned deck-design references into runtime skill folders."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

HANDS_ON_DECK_COMMIT = "1e94c3aa6bbe810708406ede1c248ebfd651bb2a"
IMPECCABLE_COMMIT = "630fc2682a5bd39b25a8e61f74b6b3f14f2b1e21"
HALLMARK_COMMIT = "aeb42fb354ff4efa36ab475773a082315a3af2ce"

HANDS_ON_DECK_FILES = (
    (
        "third_party/hands_on_deck/skills/hands-on-deck/designing-slides.md",
        "skills/public/hands-on-deck/designing-slides.md",
    ),
    (
        "third_party/hands_on_deck/docs/html2patch-spec.md",
        "skills/public/hands-on-deck/docs/html2patch-spec.md",
    ),
    ("third_party/hands_on_deck/LICENSE", "skills/public/hands-on-deck/LICENSE"),
)

IMPECCABLE_FILES = tuple(
    (
        f"third_party/impeccable/reference/{name}.md",
        f"skills/public/deck-impeccable/reference/{name}.md",
    )
    for name in ("layout", "critique", "polish", "bolder", "quieter")
) + (
    ("third_party/impeccable/LICENSE", "skills/public/deck-impeccable/LICENSE"),
    ("third_party/impeccable/NOTICE.md", "skills/public/deck-impeccable/NOTICE.md"),
)

HALLMARK_FILES = tuple(
    f"skills/public/hallmark/{path}"
    for path in (
        "SKILL.md",
        "references/structure.md",
        "references/anti-patterns.md",
        "references/slop-test.md",
    )
)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _sync_group(
    *,
    name: str,
    source_url: str,
    commit: str,
    files: tuple[tuple[str, str], ...],
    lock_path: str,
    check: bool,
) -> list[str]:
    errors: list[str] = []
    records: list[dict[str, str]] = []
    for source_rel, mirror_rel in files:
        source = ROOT / source_rel
        mirror = ROOT / mirror_rel
        if not source.is_file():
            errors.append(f"missing source: {source_rel}")
            continue
        if check:
            if not mirror.is_file():
                errors.append(f"missing mirror: {mirror_rel}")
                continue
        else:
            mirror.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, mirror)
        source_sha = _sha256(source)
        mirror_sha = _sha256(mirror)
        if source_sha != mirror_sha:
            errors.append(f"mirror drift: {mirror_rel}")
        records.append(
            {
                "source_path": source_rel,
                "mirror_path": mirror_rel,
                "source_sha256": source_sha,
                "mirror_sha256": mirror_sha,
            }
        )
    lock = ROOT / lock_path
    if check:
        if not lock.is_file():
            errors.append(f"missing lock: {lock_path}")
        else:
            payload = json.loads(lock.read_text(encoding="utf-8"))
            if payload.get("upstream_commit") != commit:
                errors.append(f"unexpected upstream commit in {lock_path}")
            locked = payload.get("files")
            if not isinstance(locked, list) or locked != records:
                errors.append(f"stale lock contents: {lock_path}")
    else:
        lock.parent.mkdir(parents=True, exist_ok=True)
        lock.write_text(
            json.dumps(
                {
                    "name": name,
                    "source_url": source_url,
                    "upstream_commit": commit,
                    "synced_at": datetime.now(timezone.utc).isoformat(),  # noqa: UP017
                    "files": records,
                },
                indent=2,
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )
    return errors


def _write_or_check_hallmark_lock(*, check: bool) -> list[str]:
    lock_path = ROOT / "skills/public/hallmark/UPSTREAM.lock.json"
    files = [
        {"path": path, "sha256": _sha256(ROOT / path)}
        for path in HALLMARK_FILES
    ]
    if check:
        if not lock_path.is_file():
            return ["missing lock: skills/public/hallmark/UPSTREAM.lock.json"]
        payload = json.loads(lock_path.read_text(encoding="utf-8"))
        if payload.get("upstream_commit") != HALLMARK_COMMIT or payload.get("files") != files:
            return ["stale Hallmark upstream lock"]
        return []
    lock_path.write_text(
        json.dumps(
            {
                "name": "hallmark",
                "source_url": "https://github.com/Nutlope/hallmark",
                "upstream_commit": HALLMARK_COMMIT,
                "synced_at": datetime.now(timezone.utc).isoformat(),  # noqa: UP017
                "files": files,
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    return []


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="verify mirrors without writing")
    args = parser.parse_args()
    errors: list[str] = []
    errors.extend(
        _sync_group(
            name="hands-on-deck",
            source_url="https://github.com/EveryInc/hands-on-deck",
            commit=HANDS_ON_DECK_COMMIT,
            files=HANDS_ON_DECK_FILES,
            lock_path="skills/public/hands-on-deck/UPSTREAM.lock.json",
            check=args.check,
        )
    )
    errors.extend(
        _sync_group(
            name="impeccable",
            source_url="https://github.com/pbakaus/impeccable",
            commit=IMPECCABLE_COMMIT,
            files=IMPECCABLE_FILES,
            lock_path="skills/public/deck-impeccable/UPSTREAM.lock.json",
            check=args.check,
        )
    )
    errors.extend(_write_or_check_hallmark_lock(check=args.check))
    if errors:
        for error in errors:
            print(error)
        return 1
    print("deck design skill mirrors are synchronized")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
