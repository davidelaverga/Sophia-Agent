"""Deployment guard for Sophia's PDF rendering runtime."""

import re
from pathlib import Path


def _compose_langgraph_block(path: Path) -> str:
    text = path.read_text(encoding="utf-8")
    start = text.index("  langgraph:")
    next_service = re.search(r"^  [A-Za-z0-9_-]+:", text[start + len("  langgraph:") :], re.MULTILINE)
    if next_service is None:
        return text[start:]
    return text[start : start + len("  langgraph:") + next_service.start()]


def test_langgraph_dockerfile_installs_pdf_runtime() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    dockerfile = repo_root / "backend" / "Dockerfile.langgraph"
    contents = dockerfile.read_text(encoding="utf-8")

    for package in (
        "pandoc",
        "texlive-xetex",
        "texlive-latex-recommended",
        "texlive-latex-extra",
        "texlive-fonts-recommended",
        # Artifact Visual System: TeX Gyre brand fonts (PDF) + graphviz (the
        # `dot` binary backing the ported diagram tool).
        "texlive-fonts-extra",
        "graphviz",
        "lmodern",
        "fonts-dejavu-core",
        "chromium",
    ):
        assert package in contents

    assert "pandoc --version" in contents
    assert "xelatex --version" in contents
    assert "chromium --version" in contents
    assert "dot -V" in contents  # graphviz present
    assert "deerflow/sophia/js" in contents
    assert "npm ci" in contents
    assert "compile_pptx.mjs" in contents
    assert "pptxgenjs" in contents
    assert "COPY third_party/hands_on_deck ./third_party/hands_on_deck" in contents
    assert "third_party/hands_on_deck/skills/hands-on-deck/scripts/deck.py --help" in contents
    # The mermaid→excalidraw diagram stack was retired (graphviz port); the
    # Node verify block no longer resolves excalidraw or tests compile_diagram.
    assert "@excalidraw/excalidraw" not in contents
    # The build no longer verifies/depends on the retired diagram compiler
    # (an explanatory comment may still mention the file by name).
    assert "test -f compile_diagram.mjs" not in contents
    assert "SOPHIA_ARTIFACT_JS_RUNTIME" in contents
    assert "SOPHIA_PPTXGENJS=1" in contents


def test_compose_langgraph_uses_artifact_runtime_image() -> None:
    repo_root = Path(__file__).resolve().parents[2]

    for compose_file in (
        repo_root / "docker" / "docker-compose.yaml",
        repo_root / "docker" / "docker-compose-dev.yaml",
    ):
        langgraph_block = _compose_langgraph_block(compose_file)
        assert "dockerfile: backend/Dockerfile.langgraph" in langgraph_block
        assert "dockerfile: backend/Dockerfile\n" not in langgraph_block
