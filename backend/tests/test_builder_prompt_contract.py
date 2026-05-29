from __future__ import annotations

from pathlib import Path


def _agents_contract() -> str:
    repo_root = Path(__file__).resolve().parents[2]
    return (repo_root / "skills/public/sophia/AGENTS.md").read_text()


def test_agents_contract_declares_universal_builder_web_research() -> None:
    contract = _agents_contract()

    assert "Web research is available for every builder task type" in contract
    assert "including `frontend`" in contract
    assert "Before the first substantive write/edit/emit step" in contract
    assert "`builder_web_search` or `builder_web_fetch`" in contract


def test_agents_contract_update_guidance_does_not_ban_research() -> None:
    contract = _agents_contract()

    assert "DO NOT re-run web_search" not in contract
    assert "search or fetch that new material before editing" in contract
