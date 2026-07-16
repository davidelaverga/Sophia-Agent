from __future__ import annotations

from pathlib import Path

from pydantic import BaseModel, ConfigDict

from deerflow.sophia.deck_quality.canonical import file_sha256
from deerflow.sophia.deck_quality.schemas import Sha256

_REQUIRED_SECURITY_TOKEN_GROUPS = (
    ("untrusted",),
    ("follow instructions", "embedded"),
    ("do not infer missing slides",),
    ("stable", "slide:n", "selector"),
)


class VersionedPrompt(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    name: str
    version: str
    sha256: Sha256
    content: str


class PromptPack(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    blind_visual: VersionedPrompt
    plan_realization: VersionedPrompt
    large_deck_consolidation: VersionedPrompt


def _load_prompt(path: Path, *, name: str, version: str) -> VersionedPrompt:
    content = path.read_text(encoding="utf-8")
    lowered = " ".join(content.casefold().split())
    missing = [" + ".join(group) for group in _REQUIRED_SECURITY_TOKEN_GROUPS if not all(token in lowered for token in group)]
    if missing:
        raise ValueError(f"prompt {path.name} misses security clauses: {', '.join(missing)}")
    return VersionedPrompt(name=name, version=version, sha256=file_sha256(path), content=content)


def load_prompt_pack(root: Path) -> PromptPack:
    return PromptPack(
        blind_visual=_load_prompt(root / "blind_visual_assessment_v4.md", name="blind_visual_assessment", version="v4"),
        plan_realization=_load_prompt(root / "plan_realization_assessment_v4.md", name="plan_realization_assessment", version="v4"),
        large_deck_consolidation=_load_prompt(root / "large_deck_consolidation_v1.md", name="large_deck_consolidation", version="v1"),
    )
