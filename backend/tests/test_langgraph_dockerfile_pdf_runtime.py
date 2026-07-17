"""Deployment guard for Sophia's PDF rendering runtime."""

import ast
import re
from pathlib import Path


def _compose_langgraph_block(path: Path) -> str:
    text = path.read_text(encoding="utf-8")
    start = text.index("  langgraph:")
    next_service = re.search(r"^  [A-Za-z0-9_-]+:", text[start + len("  langgraph:") :], re.MULTILINE)
    if next_service is None:
        return text[start:]
    return text[start : start + len("  langgraph:") + next_service.start()]


def _builder_relevant_skills(repo_root: Path) -> tuple[str, ...]:
    middleware_path = (
        repo_root
        / "backend/packages/harness/deerflow/agents/sophia_agent/middlewares/builder_task.py"
    )
    tree = ast.parse(middleware_path.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.AnnAssign)
            and isinstance(node.target, ast.Name)
            and node.target.id == "_BUILDER_RELEVANT_SKILLS"
        ):
            value = ast.literal_eval(node.value)
            assert isinstance(value, tuple)
            return value
    raise AssertionError("BuilderTaskMiddleware._BUILDER_RELEVANT_SKILLS not found")


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
        "util-linux",
        "lmodern",
        "fonts-dejavu-core",
        "fonts-crosextra-caladea",
        "fonts-crosextra-carlito",
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
    assert "python -m playwright install chromium" in contents
    assert "PLAYWRIGHT_BROWSERS_PATH=/ms-playwright" in contents
    assert 'chmod -R a+rX "$PLAYWRIGHT_BROWSERS_PATH"' in contents
    assert "third_party/hands_on_deck/skills/hands-on-deck/scripts/html2patch.py --help" in contents
    assert "from playwright.sync_api import sync_playwright" in contents
    # The mermaid→excalidraw diagram stack was retired (graphviz port); the
    # Node verify block no longer resolves excalidraw or tests compile_diagram.
    assert "@excalidraw/excalidraw" not in contents
    # The build no longer verifies/depends on the retired diagram compiler
    # (an explanatory comment may still mention the file by name).
    assert "test -f compile_diagram.mjs" not in contents
    assert "SOPHIA_ARTIFACT_JS_RUNTIME" in contents
    assert "SOPHIA_PPTXGENJS=1" in contents


def test_docker_context_includes_builder_skill_runtime_assets() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    dockerignore = (repo_root / ".dockerignore").read_text(encoding="utf-8")

    required_skill_dirs = {
        "chart-visualization",
        "sophia",
        *_builder_relevant_skills(repo_root),
    }
    for skill_dir in required_skill_dirs:
        assert f"!skills/public/{skill_dir}/" in dockerignore
        assert f"!skills/public/{skill_dir}/**" in dockerignore

    assert "skills/public/**/__pycache__/" in dockerignore
    assert "skills/public/**/*.py[cod]" in dockerignore


def test_compose_langgraph_uses_artifact_runtime_image() -> None:
    repo_root = Path(__file__).resolve().parents[2]

    for compose_file in (
        repo_root / "docker" / "docker-compose.yaml",
        repo_root / "docker" / "docker-compose-dev.yaml",
    ):
        langgraph_block = _compose_langgraph_block(compose_file)
        assert "dockerfile: backend/Dockerfile.langgraph" in langgraph_block
        assert "dockerfile: backend/Dockerfile\n" not in langgraph_block


def test_production_compose_preserves_langgraph_worker_concurrency() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    langgraph_block = _compose_langgraph_block(repo_root / "docker" / "docker-compose.yaml")

    assert "--n-jobs-per-worker 10" in langgraph_block
