from __future__ import annotations

import hashlib
from pathlib import Path
from types import SimpleNamespace

import pytest

from deerflow.config.build_foundation_config import BuildFoundationConfig
from deerflow.sophia.build_manifest import (
    DECK_STYLE_ROOT_SELECTOR,
    BuildManifest,
    component_dependency_closure,
    resolve_component_source_role,
)
from deerflow.sophia.build_sources import materialize_compact_deck_sources
from deerflow.sophia.deck_build.foundation import (
    BuildFoundationPersistenceError,
    materialize_deck_foundation,
    materialize_deck_foundation_safely,
)


def _slide(number: int) -> SimpleNamespace:
    body = f'<h1 data-deck-id="title-{number}">Slide {number}</h1>'
    css = f'[data-deck-id="title-{number}"]{{font-size:64px}}'
    return SimpleNamespace(
        selector=f"slide:{number}",
        index=number,
        html_body=body,
        slide_css=css,
        speaker_notes=f"Notes {number}",
        html_source=f"<!doctype html><html><body>{body}<style>{css}</style></body></html>",
        visual_asset_path=None,
    )


def test_legacy_v1_manifest_loads_without_address_fields() -> None:
    manifest = BuildManifest.model_validate(
        {
            "schema_version": "sophia-build-manifest/v1",
            "manifest_revision": 1,
            "build_id": "build-legacy",
            "user_id": "user-1",
            "thread_id": "thread-1",
            "format": "pptx",
            "status": "complete",
            "components": [
                {
                    "id": "component-1",
                    "selector": "slide:1",
                    "type": "slide",
                    "index": 1,
                    "source_path": "/legacy/slide-1.html",
                    "status": "gated",
                    "current_version_id": "component-version-1",
                }
            ],
        }
    )

    component = manifest.components[0]
    assert manifest.schema_version == "sophia-build-manifest/v1"
    assert component.source_path == "/legacy/slide-1.html"
    assert component.source_roles == {}
    assert component.source_hashes == {}
    assert component.shared_dependencies == []
    assert resolve_component_source_role(manifest, selector="slide:1", source_role="body") == component.source_path
    with pytest.raises(ValueError, match="unknown source role"):
        resolve_component_source_role(manifest, selector="slide:1", source_role="notes")


def test_compact_sources_materialize_explicit_style_and_slide_roles(tmp_path: Path) -> None:
    materialized = materialize_compact_deck_sources(
        build_id="build-addressed",
        root=tmp_path,
        deck_stylesheet="body{margin:0}",
        slides=[_slide(1)],
    )

    style = materialized.stylesheet_version
    assert style.selector == DECK_STYLE_ROOT_SELECTOR
    assert set(style.source_roles) == {"deck_css"}
    assert Path(style.source_roles["deck_css"]).read_text(encoding="utf-8") == "body{margin:0}"
    assert style.source_hashes == {
        "deck_css": hashlib.sha256(b"body{margin:0}").hexdigest(),
    }

    slide = materialized.versions[0]
    assert set(slide.source_roles) == {"body", "slide_css", "notes", "assembled"}
    assert all(Path(path).is_file() for path in slide.source_roles.values())
    assert slide.source_hashes["deck.css"] == style.source_hashes["deck_css"]


def test_fresh_foundation_projects_style_root_and_dependency_closure(tmp_path: Path) -> None:
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    (outputs / "deck.pptx").write_bytes(b"native-pptx-placeholder")
    deck = SimpleNamespace(
        user_id="user-1",
        thread_id="thread-1",
        build_id="build-addressed",
        deck_authoring_contract="compact_model_html_v1",
        deck_stylesheet="body{margin:0}",
        slides=[_slide(1), _slide(2)],
        pptx_path="/mnt/user-data/outputs/deck.pptx",
        mechanical_gate_results={"passed": True},
        source_retention_report={"passed": True},
    )
    runtime = SimpleNamespace(
        state={
            "thread_data": {
                "outputs_path": str(outputs),
                "workspace_path": str(tmp_path / "workspace"),
                "uploads_path": str(tmp_path / "uploads"),
            }
        },
        context={
            "build_foundation_config": BuildFoundationConfig(
                enabled=True,
                manifest_mode="shadow",
            )
        },
        config={},
    )

    materialize_deck_foundation(deck, runtime)

    manifest_path = outputs / ".builder" / "builds" / deck.build_id / "manifest" / "manifest-r1.json"
    manifest = BuildManifest.model_validate_json(manifest_path.read_text(encoding="utf-8"))
    assert [component.selector for component in manifest.components] == [
        DECK_STYLE_ROOT_SELECTOR,
        "slide:1",
        "slide:2",
    ]
    style, *slides = manifest.components
    assert style.type == "deck_style"
    assert style.source_roles.keys() == {"deck_css"}
    assert style.source_hashes.keys() == {"deck_css"}
    for slide in slides:
        assert slide.source_path == slide.source_roles["body"]
        assert set(slide.source_roles) == {"body", "slide_css", "notes", "assembled"}
        assert set(slide.source_hashes) == {"body", "slide_css", "notes", "assembled", "deck_css"}
        assert slide.source_hashes["deck_css"] == style.source_hashes["deck_css"]
        assert slide.shared_dependencies == [DECK_STYLE_ROOT_SELECTOR]
    assert resolve_component_source_role(manifest, selector="slide:1", source_role="notes").endswith("notes.txt")

    assert component_dependency_closure(manifest, ["slide:1"]) == ("slide:1",)
    assert component_dependency_closure(manifest, [DECK_STYLE_ROOT_SELECTOR]) == (
        DECK_STYLE_ROOT_SELECTOR,
        "slide:1",
        "slide:2",
    )
    with pytest.raises(ValueError, match="unknown component selector"):
        component_dependency_closure(manifest, ["slide:99"])


def test_dependency_closure_rejects_unresolved_shared_dependency() -> None:
    manifest = BuildManifest.model_validate(
        {
            "manifest_revision": 1,
            "build_id": "build-invalid-dependency",
            "user_id": "user-1",
            "thread_id": "thread-1",
            "format": "pptx",
            "status": "complete",
            "components": [
                {
                    "id": "component-1",
                    "selector": "slide:1",
                    "type": "slide",
                    "index": 1,
                    "source_path": "/source/body.html",
                    "status": "gated",
                    "current_version_id": "component-version-1",
                    "shared_dependencies": [DECK_STYLE_ROOT_SELECTOR],
                }
            ],
        }
    )

    with pytest.raises(ValueError, match="unknown shared dependencies"):
        component_dependency_closure(manifest, ["slide:1"])


def _foundation_runtime(
    tmp_path: Path,
    *,
    user_id: str,
    build_id: str,
    config: BuildFoundationConfig,
) -> tuple[SimpleNamespace, SimpleNamespace]:
    outputs = tmp_path / build_id / "outputs"
    outputs.mkdir(parents=True)
    (outputs / "deck.pptx").write_bytes(b"native-pptx-placeholder")
    deck = SimpleNamespace(
        user_id=user_id,
        thread_id="thread-1",
        build_id=build_id,
        deck_authoring_contract="compact_model_html_v1",
        deck_stylesheet="body{margin:0}",
        slides=[_slide(1)],
        pptx_path="/mnt/user-data/outputs/deck.pptx",
        mechanical_gate_results={"passed": True},
        source_retention_report={"passed": True},
    )
    runtime = SimpleNamespace(
        state={
            "thread_data": {
                "outputs_path": str(outputs),
                "workspace_path": str(tmp_path / build_id / "workspace"),
                "uploads_path": str(tmp_path / build_id / "uploads"),
            }
        },
        context={"build_foundation_config": config},
        config={},
    )
    return deck, runtime


def test_canary_enforcement_config_is_exact_and_canonical() -> None:
    config = BuildFoundationConfig(
        manifest_mode="canary_enforce",
        enforce_canary_user_ids=" canary-user,canary-user ",
    )

    assert config.enforce_canary_user_ids == frozenset({"canary-user"})
    assert config.effective_manifest_mode("canary-user") == "enforce"
    assert config.effective_manifest_mode("ordinary-user") == "shadow"
    assert config.effective_manifest_mode(None) == "shadow"

    with pytest.raises(ValueError, match="nonempty canary"):
        BuildFoundationConfig(manifest_mode="canary_enforce")
    with pytest.raises(ValueError, match="canonical"):
        BuildFoundationConfig(
            manifest_mode="canary_enforce",
            enforce_canary_user_ids={"../escape"},
        )
    with pytest.raises(ValueError, match="only with canary_enforce"):
        BuildFoundationConfig(
            manifest_mode="shadow",
            enforce_canary_user_ids={"canary-user"},
        )


def test_canary_enforcement_preserves_ordinary_shadow_behavior(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from deerflow.sophia.deck_build import foundation

    config = BuildFoundationConfig(
        manifest_mode="canary_enforce",
        enforce_canary_user_ids={"canary-user"},
    )
    enforced: list[str] = []

    def enforce(**kwargs: object) -> None:
        deck = kwargs["deck"]
        assert isinstance(deck, SimpleNamespace)
        enforced.append(deck.user_id)
        deck.foundation_status = "enforced"

    monkeypatch.setattr(foundation, "_enforce_manifest", enforce)
    canary_deck, canary_runtime = _foundation_runtime(
        tmp_path,
        user_id="canary-user",
        build_id="build-canary",
        config=config,
    )
    ordinary_deck, ordinary_runtime = _foundation_runtime(
        tmp_path,
        user_id="ordinary-user",
        build_id="build-ordinary",
        config=config,
    )

    materialize_deck_foundation(canary_deck, canary_runtime)
    materialize_deck_foundation(ordinary_deck, ordinary_runtime)

    assert enforced == ["canary-user"]
    assert canary_deck.foundation_status == "enforced"
    assert ordinary_deck.foundation_status == "shadow_written"


def test_canary_persistence_failure_is_terminal_but_ordinary_failure_is_shadowed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from deerflow.sophia.deck_build import foundation

    config = BuildFoundationConfig(
        manifest_mode="canary_enforce",
        enforce_canary_user_ids={"canary-user"},
    )

    def fail_write(*_args: object, **_kwargs: object) -> str:
        raise BuildFoundationPersistenceError("synthetic persistence failure")

    monkeypatch.setattr(foundation, "_write_immutable_json", fail_write)
    canary_deck, canary_runtime = _foundation_runtime(
        tmp_path,
        user_id="canary-user",
        build_id="build-canary-failure",
        config=config,
    )
    ordinary_deck, ordinary_runtime = _foundation_runtime(
        tmp_path,
        user_id="ordinary-user",
        build_id="build-ordinary-failure",
        config=config,
    )

    with pytest.raises(BuildFoundationPersistenceError, match="synthetic persistence"):
        materialize_deck_foundation_safely(canary_deck, canary_runtime)
    materialize_deck_foundation_safely(ordinary_deck, ordinary_runtime)

    assert ordinary_deck.foundation_status == "shadow_failed"
    assert ordinary_deck.foundation_warning == "BuildFoundationPersistenceError"
