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


def _dockerfile_logical_instructions(contents: str) -> tuple[str, ...]:
    """Collapse backslash-continued Dockerfile instructions for assertions."""
    instructions: list[str] = []
    current: list[str] = []
    for raw_line in contents.splitlines():
        line = raw_line.strip()
        if not current and (not line or line.startswith("#")):
            continue
        current.append(line.removesuffix("\\").strip())
        if not line.endswith("\\"):
            instructions.append(" ".join(current))
            current = []
    assert not current, "Dockerfile ends inside a continued instruction"
    return tuple(instructions)


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
        "libreoffice-impress",
        "poppler-utils",
        "chromium",
        "nodejs",
    ):
        assert package in contents

    # Keep the large TeX, office, browser, and Node runtimes in bounded apt
    # transactions. A single 1.5+ GiB acquisition exhausts the production-like
    # 4 GiB builder before dpkg can release its archive set.
    instructions = _dockerfile_logical_instructions(contents)
    apt_install_runs = tuple(
        instruction
        for instruction in instructions
        if instruction.startswith("RUN ") and "apt-get install -y" in instruction
    )
    assert len(apt_install_runs) == 7
    for instruction in apt_install_runs:
        assert "--mount=type=cache,target=/var/cache/apt,sharing=locked" in instruction
        assert "--mount=type=cache,target=/var/lib/apt/lists,sharing=locked" in instruction

    def apt_run_for(package: str) -> str:
        matching = tuple(
            instruction
            for instruction in apt_install_runs
            if re.search(rf"(?<![A-Za-z0-9_-]){re.escape(package)}(?![A-Za-z0-9_-])", instruction)
        )
        assert len(matching) == 1, f"expected one apt RUN for {package}, got {len(matching)}"
        return matching[0]

    pandoc_run = apt_run_for("pandoc")
    assert apt_run_for("texlive-xetex") == pandoc_run
    assert apt_run_for("texlive-latex-extra") != pandoc_run
    heavy_runs = {
        pandoc_run,
        apt_run_for("texlive-fonts-extra"),
        apt_run_for("libreoffice-impress"),
        apt_run_for("chromium"),
        apt_run_for("nodejs"),
    }
    assert len(heavy_runs) == 5

    assert "pandoc --version" in contents
    assert "xelatex --version" in contents
    assert "soffice --version" in contents
    assert "pdftoppm -v" in contents
    assert "chromium --version" in contents
    assert "node --version" in contents
    assert "dot -V" in contents  # graphviz present
    assert "UV_HTTP_TIMEOUT=120 uv sync" in contents
    assert "PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT=120000" in contents
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
