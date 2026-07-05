from __future__ import annotations

from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[2]
SURFACES = [
    PROJECT_ROOT / "skills" / "public" / "ppt-generation" / "SKILL.md",
    PROJECT_ROOT / "skills" / "public" / "image-generation" / "SKILL.md",
    PROJECT_ROOT / "skills" / "public" / "sophia" / "visual_composition.md",
    PROJECT_ROOT / "skills" / "public" / "sophia" / "builder_obligations.md",
    PROJECT_ROOT / "skills" / "public" / "sophia" / "coordination_core.md",
    PROJECT_ROOT
    / "backend"
    / "packages"
    / "harness"
    / "deerflow"
    / "agents"
    / "sophia_agent"
    / "middlewares"
    / "builder_task.py",
]


def _surface_text() -> str:
    return "\n".join(path.read_text(encoding="utf-8") for path in SURFACES)


def test_fresh_deck_prompt_surfaces_route_to_prepare_deck_build() -> None:
    text = _surface_text()

    assert "prepare_deck_build" in text
    assert "DeckBuildService" in text
    assert "slide intent" in text
    assert "visual_policy" in text
    assert "layout_kind" in text


def test_fresh_deck_prompt_surfaces_do_not_teach_old_workflow() -> None:
    text = _surface_text().lower()

    forbidden = [
        "call prepare_pptx_image_manifest(prompt_files",
        "then call prepare_pptx_image_manifest",
        "run generate.py --manifest",
        "run the returned manifest_path",
        "author one self-contained html file per slide",
        "call build_deck_from_slides(",
        "then call build_deck_from_slides",
        "write one prompt json file per slide",
    ]
    for phrase in forbidden:
        assert phrase not in text
