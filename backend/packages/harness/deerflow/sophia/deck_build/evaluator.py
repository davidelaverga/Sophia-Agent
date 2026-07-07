from __future__ import annotations

import re
from pathlib import Path

from deerflow.agents.sophia_agent.middlewares.slide_quality import SlideQualityInspector, SlideSignals
from deerflow.sophia.deck_build.models import DeckBuild, DeckEvaluation, DeckQualityIssue

_OUTPUTS_PREFIX = "/mnt/user-data/outputs/"
_HARD_CHECKS = {"overflow", "chrome", "visual_contract"}
_NEGATED_RULE_RE = re.compile(r"(?:\bno\b|\bnot\b|\bwithout\b|\bavoid\b|\bnever\b|\bdo\s+not\b)\W*$", re.I)
_STYLE_RULES_WITH_EXPLICIT_ALLOW = {"deck_neon_cyber_default", "deck_chalkboard_unrequested"}


class DesignRule:
    def __init__(self, rule_id: str, pattern: str, check: str, severity: str, detail: str) -> None:
        self.id = rule_id
        self.pattern = re.compile(pattern, re.I)
        self.check = check
        self.severity = severity
        self.detail = detail


DESIGN_RULES = [
    DesignRule("deck_generic_saas_copy", r"\b(unlock|seamless|empower|transform your)\b", "copy", "soft", "generic SaaS phrasing"),
    DesignRule("deck_too_many_cards", r"\bcard\b", "visual_style", "soft", "too many card-like panels"),
    DesignRule("deck_neon_cyber_default", r"\b(neon|cyberpunk|glowing grid|matrix)\b", "visual_style", "hard", "unrequested neon/cyber styling"),
    DesignRule("deck_chalkboard_unrequested", r"\b(chalkboard|blackboard|whiteboard|handwritten|sketch)\b", "visual_style", "hard", "unrequested classroom/sketch styling"),
    DesignRule("deck_tiny_text", r"font-size\s*:\s*(?:[0-9]|1[0-9]|2[0-3])px\b", "density", "soft", "text smaller than the P-1 floor"),
    DesignRule("deck_nested_cards", r"\bcard[^<]{0,160}\bcard\b", "visual_style", "soft", "nested card-like structure"),
    DesignRule("deck_repeated_eyebrow", r"\beyebrow\b", "chrome", "hard", "repeated eyebrow chrome"),
    DesignRule("deck_gradient_text", r"background-clip\s*:\s*text", "visual_style", "soft", "gradient text styling"),
]


class DeckEvaluator:
    def __init__(self, inspector: SlideQualityInspector | None = None) -> None:
        self._inspector = inspector or SlideQualityInspector()

    def evaluate(
        self,
        deck: DeckBuild,
        *,
        output_host_path: Path | None = None,
        allowed_style_terms: set[str] | None = None,
    ) -> DeckEvaluation:
        hard: list[DeckQualityIssue] = []
        soft: list[DeckQualityIssue] = []
        outputs_root = _outputs_root_for_deck(deck, output_host_path)

        if deck.requested_slide_count != len(deck.slides):
            hard.append(self._issue("slide_count_mismatch", "deck", "slide_count", "slide count mismatch"))
        if deck.visual_policy == "required" and deck.expected_visual_count != deck.successful_visual_count:
            hard.append(self._issue("visuals_incomplete", "deck", "visual_contract", "required visuals incomplete"))

        for slide in deck.slides:
            html_path = _host_for_outputs_path(slide.html_source_path, outputs_root)
            if not html_path or not html_path.is_file():
                hard.append(self._issue("missing_slide_html", slide.selector, "html", "slide HTML was not rendered"))
            visual_path = _host_for_outputs_path(slide.visual_asset_path, outputs_root)
            if deck.visual_policy == "required" and (not visual_path or not visual_path.is_file()):
                hard.append(self._issue("missing_visual_asset", slide.selector, "visual_contract", "visual asset missing"))
            if bool(slide.gate_results.get("chrome_detected")):
                hard.append(self._issue("invented_chrome", slide.selector, "chrome", "slide contains invented page chrome"))

        if output_host_path is not None and not output_host_path.is_file():
            hard.append(self._issue("missing_pptx", "deck", "compile", "PPTX file missing after compile"))

        allowed_styles = allowed_style_terms or set()
        signals = _signals_from_deck(deck, outputs_root, allowed_style_terms=allowed_styles)
        for gap in self._inspector.inspect(signals):
            issue = self._issue(f"slide_{gap.check}", gap.slide, gap.check, gap.detail)
            if gap.check in _HARD_CHECKS:
                hard.append(issue)
            else:
                soft.append(issue)
        for issue in _design_rule_issues(signals, allowed_style_terms=allowed_styles):
            if issue.severity == "hard":
                hard.append(issue)
            else:
                soft.append(issue)

        quality_warning = "deck_quality_warning" if soft and not hard else None
        return DeckEvaluation(
            passed=not hard,
            hard_failures=hard,
            soft_warnings=soft,
            quality_warning=quality_warning,
        )

    @staticmethod
    def _issue(issue_id: str, selector: str, check: str, detail: str, *, severity: str = "hard") -> DeckQualityIssue:
        return DeckQualityIssue(
            id=issue_id,
            severity=severity,
            selector=selector,
            check=check,
            detail=detail,
            repair_hint="Regenerate or revise this slide through DeckBuildService.",
        )


def _host_for_outputs_path(virtual_path: str | None, outputs_root: Path | None) -> Path | None:
    if not virtual_path or outputs_root is None:
        return None
    if not virtual_path.startswith(_OUTPUTS_PREFIX):
        return None
    relative = virtual_path[len(_OUTPUTS_PREFIX) :].lstrip("/")
    if not relative or ".." in Path(relative).parts:
        return None
    return outputs_root / relative


def _signals_from_deck(deck: DeckBuild, outputs_root: Path | None, *, allowed_style_terms: set[str]) -> SlideSignals:
    slide_sources: list[tuple[str, str]] = []
    prompt_sources: list[tuple[str, str]] = []
    for slide in deck.slides:
        html_path = _host_for_outputs_path(slide.html_source_path, outputs_root)
        if html_path is not None and html_path.is_file():
            slide_sources.append((slide.selector, html_path.read_text(encoding="utf-8", errors="replace")))
        prompt_path = _host_for_outputs_path(slide.visual_prompt_path, outputs_root)
        if prompt_path is not None and prompt_path.is_file():
            prompt_sources.append((slide.selector, prompt_path.read_text(encoding="utf-8", errors="replace")))
    return SlideSignals(
        slide_sources=slide_sources,
        prompt_sources=prompt_sources,
        overflow_slides=deck.compile_overflow_slides,
        allowed_style_terms=allowed_style_terms,
    )


def _outputs_root_for_deck(deck: DeckBuild, output_host_path: Path | None) -> Path | None:
    if output_host_path is None:
        return None
    virtual_output = deck.output_path
    if not virtual_output.startswith(_OUTPUTS_PREFIX):
        return output_host_path.parent
    relative = virtual_output[len(_OUTPUTS_PREFIX) :].lstrip("/")
    if not relative or ".." in Path(relative).parts:
        return output_host_path.parent
    parents_to_root = len(Path(relative).parts) - 1
    root = output_host_path
    for _ in range(parents_to_root + 1):
        root = root.parent
    return root


def _design_rule_issues(signals: SlideSignals, *, allowed_style_terms: set[str]) -> list[DeckQualityIssue]:
    issues: list[DeckQualityIssue] = []
    allowed_styles = {_normalize_style_term(term) for term in allowed_style_terms}
    sources = [*signals.slide_sources, *signals.prompt_sources]
    for selector, source in sources:
        for rule in DESIGN_RULES:
            allowed_match = False
            unallowed_match = False
            for match in rule.pattern.finditer(source):
                prefix = source[max(0, match.start() - 32) : match.start()]
                if _NEGATED_RULE_RE.search(prefix):
                    continue
                if rule.id in _STYLE_RULES_WITH_EXPLICIT_ALLOW and _normalize_style_term(match.group(0)) in allowed_styles:
                    allowed_match = True
                    continue
                unallowed_match = True
                break
            if not unallowed_match:
                continue
            issues.append(
                DeckQualityIssue(
                    id=rule.id,
                    severity=rule.severity,
                    selector=selector,
                    check=rule.check,
                    detail=rule.detail,
                    repair_hint=(
                        "Use the explicitly requested style consistently."
                        if allowed_match
                        else "Use restrained professional technical styling and simpler slide structure."
                    ),
                )
            )
    return issues


def _normalize_style_term(value: str) -> str:
    return re.sub(r"[_-]+", " ", value.lower())
