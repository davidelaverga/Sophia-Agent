from __future__ import annotations

import ast
from pathlib import Path

BACKEND = Path(__file__).parents[1]
PRODUCTION_ROOTS = (BACKEND / "app" / "gateway", BACKEND / "packages" / "harness" / "deerflow")
ADAPTER = BACKEND / "packages" / "harness" / "deerflow" / "sophia" / "memory_governance" / "mem0_projection_adapter.py"


def test_no_production_mem0_sdk_import_exists_outside_adapter() -> None:
    violations: list[str] = []
    for root in PRODUCTION_ROOTS:
        for path in root.rglob("*.py"):
            if path == ADAPTER:
                continue
            tree = ast.parse(path.read_text(), filename=str(path))
            for node in ast.walk(tree):
                if isinstance(node, ast.Import) and any(alias.name == "mem0" or alias.name.startswith("mem0.") for alias in node.names):
                    violations.append(str(path.relative_to(BACKEND)))
                if isinstance(node, ast.ImportFrom) and (node.module == "mem0" or (node.module or "").startswith("mem0.")):
                    violations.append(str(path.relative_to(BACKEND)))
    assert violations == []


def test_mem0_network_paths_exist_only_in_provider_adapter() -> None:
    violations: list[str] = []
    for root in PRODUCTION_ROOTS:
        for path in root.rglob("*.py"):
            if path == ADAPTER:
                continue
            text = path.read_text()
            if "api.mem0.ai" in text or "/v1/memories/" in text or "/v2/memories/" in text:
                violations.append(str(path.relative_to(BACKEND)))
    assert violations == []


def test_memory_consumer_logs_do_not_embed_raw_query_content_or_identifiers() -> None:
    targets = (
        BACKEND / "packages" / "harness" / "deerflow" / "sophia" / "mem0_client.py",
        BACKEND
        / "packages"
        / "harness"
        / "deerflow"
        / "agents"
        / "sophia_agent"
        / "middlewares"
        / "mem0_memory.py",
        BACKEND
        / "packages"
        / "harness"
        / "deerflow"
        / "agents"
        / "sophia_agent"
        / "middlewares"
        / "mem0_retrieval.py",
    )
    denied_fragments = (
        "query='%s'",
        "query=\"%s\"",
        "memory's content preview",
        "content preview for debugging",
        "failed for user %s",
        "thread_id=%s",
        "first_item_id=%s",
    )

    violations = {
        str(path.relative_to(BACKEND)): fragment
        for path in targets
        for fragment in denied_fragments
        if fragment in path.read_text()
    }
    assert violations == {}
