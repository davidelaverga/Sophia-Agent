"""Deployment guard for Sophia's PDF rendering runtime."""

from pathlib import Path


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
        "lmodern",
        "fonts-dejavu-core",
        "chromium",
    ):
        assert package in contents

    assert "pandoc --version" in contents
    assert "xelatex --version" in contents
    assert "chromium --version" in contents
    assert "deerflow/sophia/js" in contents
    assert "npm ci" in contents
    assert "compile_pptx.mjs" in contents
    assert "pptxgenjs" in contents
    assert "@excalidraw/excalidraw" in contents
    assert "SOPHIA_ARTIFACT_JS_RUNTIME" in contents
    assert "SOPHIA_PPTXGENJS=1" in contents
