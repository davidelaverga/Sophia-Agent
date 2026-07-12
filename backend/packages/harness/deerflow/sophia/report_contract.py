"""Typed semantic contract and source inspection for model-authored PDF reports."""

from __future__ import annotations

import re
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Literal

import tinycss2
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

_REPORT_ID_RE = re.compile(r"^[a-z][a-z0-9_-]{1,63}$")
_WORD_RE = re.compile(r"\b[\w'-]+\b")
_HIDDEN_STYLE_RE = re.compile(
    r"(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important\s*)?(?:;|$)",
    re.IGNORECASE,
)
_VOID_HTML_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
_COVER_IDS = {"cover", "title-page", "title_page"}
_TOC_IDS = {"toc", "table-of-contents", "table_of_contents"}
_CONCLUSION_IDS = {"conclusion", "conclusions"}
_REFERENCES_IDS = {"references", "bibliography", "sources"}
_SIMPLE_SELECTOR_RE = re.compile(r"^(?P<tag>\*|[a-z][a-z0-9_-]*)?(?P<qualifiers>(?:[.#][a-z_][a-z0-9_-]*)*)$", re.IGNORECASE)


@dataclass(frozen=True)
class _VisibilityRule:
    selector: str
    property_name: str
    value: str
    important: bool
    specificity: int
    order: int


class _ReportStyleParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._in_style = False
        self._parts: list[str] = []
        self.stylesheets: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() == "style":
            self._in_style = True
            self._parts = []

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "style" and self._in_style:
            self.stylesheets.append("".join(self._parts))
            self._in_style = False
            self._parts = []

    def handle_data(self, data: str) -> None:
        if self._in_style:
            self._parts.append(data)


def _stylesheet_visibility_rules(source: str) -> list[_VisibilityRule]:
    collector = _ReportStyleParser()
    collector.feed(source)
    collector.close()
    rules: list[_VisibilityRule] = []
    order = 0
    for stylesheet in collector.stylesheets:
        parsed = tinycss2.parse_stylesheet(stylesheet, skip_comments=True, skip_whitespace=True)
        for rule in _print_visibility_rules(parsed):
            selectors = [item.strip().lower() for item in tinycss2.serialize(rule.prelude).split(",")]
            declarations = tinycss2.parse_declaration_list(rule.content, skip_comments=True, skip_whitespace=True)
            for selector in selectors:
                specificity = _simple_selector_specificity(selector)
                if specificity is None:
                    continue
                for declaration in declarations:
                    property_name = str(getattr(declaration, "lower_name", ""))
                    if getattr(declaration, "type", None) != "declaration" or property_name not in {"display", "visibility"}:
                        continue
                    rules.append(
                        _VisibilityRule(
                            selector=selector,
                            property_name=property_name,
                            value=tinycss2.serialize(declaration.value).strip().lower(),
                            important=bool(declaration.important),
                            specificity=specificity,
                            order=order,
                        )
                    )
                order += 1
    return rules


def _print_visibility_rules(rules: list[object]) -> list[object]:
    qualified: list[object] = []
    for rule in rules:
        rule_type = getattr(rule, "type", None)
        if rule_type == "qualified-rule":
            qualified.append(rule)
            continue
        if rule_type != "at-rule" or str(getattr(rule, "lower_at_keyword", "")) != "media" or not getattr(rule, "content", None):
            continue
        media_query = tinycss2.serialize(rule.prelude).strip().lower()
        if not _media_query_applies_to_print(media_query):
            continue
        nested = tinycss2.parse_rule_list(rule.content, skip_comments=True, skip_whitespace=True)
        qualified.extend(_print_visibility_rules(nested))
    return qualified


def _media_query_applies_to_print(media_query: str) -> bool:
    for query in media_query.split(","):
        identifiers = re.findall(r"[a-z][a-z0-9_-]*", query.lower())
        negated = bool(identifiers and identifiers[0] == "not")
        media_type = next((item for item in identifiers if item in {"all", "print", "screen", "speech"}), None)
        applies = media_type in {None, "all", "print"}
        if applies != negated:
            return True
    return False


def _simple_selector_specificity(selector: str) -> int | None:
    match = _SIMPLE_SELECTOR_RE.fullmatch(selector)
    if not match:
        return None
    qualifiers = match.group("qualifiers") or ""
    return 100 * qualifiers.count("#") + 10 * qualifiers.count(".") + (1 if match.group("tag") not in {None, "*"} else 0)


def _simple_selector_matches(selector: str, tag_name: str, attr_map: dict[str, str]) -> bool:
    match = _SIMPLE_SELECTOR_RE.fullmatch(selector)
    if not match:
        return False
    tag = (match.group("tag") or "").lower()
    if tag not in {"", "*", tag_name}:
        return False
    element_id = attr_map.get("id", "").lower()
    classes = {item.lower() for item in attr_map.get("class", "").split()}
    for prefix, name in re.findall(r"([.#])([a-z_][a-z0-9_-]*)", match.group("qualifiers") or "", re.IGNORECASE):
        if prefix == "#" and element_id != name.lower():
            return False
        if prefix == "." and name.lower() not in classes:
            return False
    return True


class ReportSectionRequirement(BaseModel):
    """One required semantic section in the authored report."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(description="Stable HTML id used by the section and TOC anchor.")
    title: str = Field(min_length=1, max_length=160)
    role: Literal["cover", "toc", "summary", "body", "conclusion", "references"] = "body"

    @field_validator("id")
    @classmethod
    def _valid_id(cls, value: str) -> str:
        normalized = str(value or "").strip().lower()
        if not _REPORT_ID_RE.fullmatch(normalized):
            raise ValueError("must be a lowercase HTML id using letters, digits, hyphen, or underscore")
        return normalized


class ReportVisualRequirement(BaseModel):
    """One required figure/chart/diagram in the authored report."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(description="Stable data-visual-id on the containing figure element.")
    title: str = Field(min_length=1, max_length=160)
    kind: Literal["chart", "diagram", "table", "image", "other"] = "diagram"

    @field_validator("id")
    @classmethod
    def _valid_id(cls, value: str) -> str:
        normalized = str(value or "").strip().lower()
        if not _REPORT_ID_RE.fullmatch(normalized):
            raise ValueError("must be a lowercase visual id using letters, digits, hyphen, or underscore")
        return normalized


class ReportBuildManifest(BaseModel):
    """Model-authored declaration validated against the final HTML source."""

    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["report_manifest_v1"] = "report_manifest_v1"
    sections: list[ReportSectionRequirement] = Field(min_length=1, max_length=32)
    visuals: list[ReportVisualRequirement] = Field(default_factory=list, max_length=24)
    cover_required: bool = True
    toc_required: bool = False
    conclusion_required: bool = False
    references_required: bool = False
    minimum_word_count: int | None = Field(default=None, ge=100, le=20_000)

    @model_validator(mode="after")
    def _unique_ids(self) -> ReportBuildManifest:
        section_ids = [item.id for item in self.sections]
        visual_ids = [item.id for item in self.visuals]
        if len(section_ids) != len(set(section_ids)):
            raise ValueError("section ids must be unique")
        if len(visual_ids) != len(set(visual_ids)):
            raise ValueError("visual ids must be unique")
        return self


class _ReportSourceParser(HTMLParser):
    def __init__(self, visibility_rules: list[_VisibilityRule] | None = None) -> None:
        super().__init__(convert_charrefs=True)
        self._visibility_rules = visibility_rules or []
        self.ids: set[str] = set()
        self.duplicate_ids: set[str] = set()
        self.section_ids: set[str] = set()
        self.visual_ids: set[str] = set()
        self.roles: set[str] = set()
        self.internal_links: set[str] = set()
        self.cover_present = False
        self.toc_present = False
        self.conclusion_present = False
        self.references_present = False
        self.section_count = 0
        self.body_section_count = 0
        self.figure_count = 0
        self._ignored_depth = 0
        self._tag_visibility_stack: list[tuple[str, bool]] = []
        self._text_parts: list[str] = []

    @staticmethod
    def _classes(attrs: dict[str, str]) -> set[str]:
        return {item.strip().lower() for item in attrs.get("class", "").split() if item.strip()}

    def _record_element_id(self, element_id: str) -> None:
        if not element_id:
            return
        if element_id in self.ids:
            self.duplicate_ids.add(element_id)
        self.ids.add(element_id)

    def _record_section(self, tag_name: str, element_id: str, role: str, classes: set[str]) -> None:
        if tag_name not in {"section", "article"}:
            return
        self.section_count += 1
        if element_id:
            self.section_ids.add(element_id)
        non_body = role in {"cover", "toc", "summary", "conclusion", "references"} or bool(classes & {"cover", "toc", "executive-summary", "conclusion", "references"})
        if not non_body:
            self.body_section_count += 1

    def _record_visual(self, tag_name: str, attr_map: dict[str, str]) -> None:
        visual_id = attr_map.get("data-visual-id", "").lower()
        if visual_id:
            self.visual_ids.add(visual_id)
        if tag_name == "figure":
            self.figure_count += 1

    def _record_internal_link(self, attr_map: dict[str, str]) -> None:
        href = attr_map.get("href", "")
        if href.startswith("#") and len(href) > 1:
            self.internal_links.add(href[1:].lower())

    def _record_landmarks(self, element_id: str, role: str, classes: set[str]) -> None:
        self.cover_present = self.cover_present or role == "cover" or "cover" in classes or element_id in _COVER_IDS
        self.toc_present = self.toc_present or role == "toc" or "toc" in classes or element_id in _TOC_IDS
        self.conclusion_present = self.conclusion_present or role == "conclusion" or element_id in _CONCLUSION_IDS
        self.references_present = self.references_present or role == "references" or element_id in _REFERENCES_IDS

    def _element_is_hidden(self, tag_name: str, attr_map: dict[str, str]) -> bool:
        aria_hidden = attr_map.get("aria-hidden", "").strip().lower()
        if tag_name in {"script", "style", "template"} or "hidden" in attr_map or aria_hidden in {"true", "1"}:
            return True

        winners: dict[str, tuple[bool, int, int, str]] = {}
        for rule in self._visibility_rules:
            if not _simple_selector_matches(rule.selector, tag_name, attr_map):
                continue
            candidate = (rule.important, rule.specificity, rule.order, rule.value)
            if rule.property_name not in winners or candidate[:3] >= winners[rule.property_name][:3]:
                winners[rule.property_name] = candidate
        inline_order = len(self._visibility_rules) + 1
        for declaration in tinycss2.parse_declaration_list(attr_map.get("style", ""), skip_comments=True, skip_whitespace=True):
            property_name = str(getattr(declaration, "lower_name", ""))
            if getattr(declaration, "type", None) != "declaration" or property_name not in {"display", "visibility"}:
                continue
            candidate = (bool(declaration.important), 1_000, inline_order, tinycss2.serialize(declaration.value).strip().lower())
            if property_name not in winners or candidate[:3] >= winners[property_name][:3]:
                winners[property_name] = candidate
        return winners.get("display", (False, 0, 0, ""))[3] == "none" or winners.get("visibility", (False, 0, 0, ""))[3] in {"hidden", "collapse"}

    def _enter_element(self, tag_name: str, attr_map: dict[str, str]) -> bool:
        element_hidden = self._element_is_hidden(tag_name, attr_map)
        if tag_name not in _VOID_HTML_TAGS:
            self._tag_visibility_stack.append((tag_name, element_hidden))
            if element_hidden:
                self._ignored_depth += 1
        return element_hidden or self._ignored_depth > 0

    def _leave_element(self, tag_name: str) -> None:
        matching_index = next((index for index in range(len(self._tag_visibility_stack) - 1, -1, -1) if self._tag_visibility_stack[index][0] == tag_name), None)
        if matching_index is None:
            return
        closing = self._tag_visibility_stack[matching_index:]
        del self._tag_visibility_stack[matching_index:]
        self._ignored_depth = max(0, self._ignored_depth - sum(1 for _tag, hidden in closing if hidden))

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag_name = tag.lower()
        attr_map = {str(key).lower(): str(value or "").strip() for key, value in attrs}
        if self._enter_element(tag_name, attr_map):
            return

        element_id = attr_map.get("id", "").lower()
        role = attr_map.get("data-report-role", "").lower()
        if role:
            self.roles.add(role)
        classes = self._classes(attr_map)
        self._record_element_id(element_id)
        self._record_section(tag_name, element_id, role, classes)
        self._record_visual(tag_name, attr_map)
        self._record_internal_link(attr_map)
        self._record_landmarks(element_id, role, classes)

    def handle_endtag(self, tag: str) -> None:
        self._leave_element(tag.lower())

    def handle_data(self, data: str) -> None:
        if self._ignored_depth <= 0 and data.strip():
            self._text_parts.append(data)

    @property
    def word_count(self) -> int:
        return len(_WORD_RE.findall(" ".join(self._text_parts)))


def _positive_int(value: Any) -> int | None:
    return value if isinstance(value, int) and value > 0 else None


def _required_minimum_word_count(manifest: ReportBuildManifest, requirements: dict[str, Any]) -> int:
    candidates = [manifest.minimum_word_count or 0, _positive_int(requirements.get("required_min_word_count")) or 0]
    return max(candidates)


def _parse_report_source(html_path: Path) -> _ReportSourceParser:
    try:
        source = html_path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        source = ""
    parser = _ReportSourceParser(_stylesheet_visibility_rules(source))
    try:
        parser.feed(source)
        parser.close()
    except Exception:  # noqa: BLE001 - malformed HTML is reported as an incomplete contract.
        pass
    return parser


def _presence_problems(
    *,
    parser: _ReportSourceParser,
    cover_required: bool,
    toc_required: bool,
    conclusion_required: bool,
    references_required: bool,
) -> list[str]:
    checks = (
        (cover_required, parser.cover_present, "report_manifest.cover_required"),
        (toc_required, parser.toc_present, "report_manifest.toc_required"),
        (conclusion_required, parser.conclusion_present, "report_manifest.conclusion_required"),
        (references_required, parser.references_present, "report_manifest.references_required"),
    )
    return [code for required, present, code in checks if required and not present]


def _structural_problems(
    *,
    parser: _ReportSourceParser,
    expected_body_count: int,
    expected_visual_count: int,
    minimum_word_count: int,
    toc_required: bool,
    unresolved_toc_targets: list[str],
) -> list[str]:
    problems: list[str] = []
    if parser.body_section_count < expected_body_count:
        problems.append("report_manifest.sections:body_section_count")
    if len(parser.visual_ids) < expected_visual_count:
        problems.append("report_manifest.visuals:visual_count")
    if minimum_word_count > 0 and parser.word_count < minimum_word_count:
        problems.append("report_manifest.minimum_word_count")
    if parser.duplicate_ids:
        problems.append("report_manifest.sections:duplicate_html_ids")
    if toc_required and unresolved_toc_targets:
        problems.append("report_manifest.toc_required:unresolved_targets")
    return problems


def inspect_report_source(
    html_path: Path,
    manifest: ReportBuildManifest,
    *,
    requirements: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Validate a model-authored report manifest against its final HTML source."""

    requirement_map = requirements or {}
    parser = _parse_report_source(html_path)

    expected_section_ids = [item.id for item in manifest.sections]
    expected_visual_ids = [item.id for item in manifest.visuals]
    missing_section_ids = [item for item in expected_section_ids if item not in parser.section_ids]
    missing_visual_ids = [item for item in expected_visual_ids if item not in parser.visual_ids]
    unresolved_toc_targets = sorted(item for item in parser.internal_links if item not in parser.ids)

    expected_body_count = max(
        len([item for item in manifest.sections if item.role == "body"]),
        _positive_int(requirement_map.get("required_body_section_count")) or 0,
    )
    expected_visual_count = max(
        len(manifest.visuals),
        _positive_int(requirement_map.get("required_visual_count")) or 0,
    )
    minimum_word_count = _required_minimum_word_count(manifest, requirement_map)
    cover_required = bool(manifest.cover_required or requirement_map.get("cover_required"))
    toc_required = bool(manifest.toc_required or requirement_map.get("toc_required"))
    conclusion_required = bool(manifest.conclusion_required or requirement_map.get("conclusion_required"))
    references_required = bool(manifest.references_required or requirement_map.get("references_required"))

    problems: list[str] = []
    problems.extend(f"report_manifest.sections[{index}].id:{section_id}" for index, section_id in enumerate(expected_section_ids) if section_id in missing_section_ids)
    problems.extend(f"report_manifest.visuals[{index}].id:{visual_id}" for index, visual_id in enumerate(expected_visual_ids) if visual_id in missing_visual_ids)
    problems.extend(
        _presence_problems(
            parser=parser,
            cover_required=cover_required,
            toc_required=toc_required,
            conclusion_required=conclusion_required,
            references_required=references_required,
        )
    )
    problems.extend(
        _structural_problems(
            parser=parser,
            expected_body_count=expected_body_count,
            expected_visual_count=expected_visual_count,
            minimum_word_count=minimum_word_count,
            toc_required=toc_required,
            unresolved_toc_targets=unresolved_toc_targets,
        )
    )

    return {
        "report_contract_status": "accepted" if not problems else "rejected",
        "report_contract_version": manifest.schema_version,
        "expected_section_count": len(expected_section_ids),
        "found_section_count": len(parser.section_ids),
        "expected_body_section_count": expected_body_count,
        "found_body_section_count": parser.body_section_count,
        "missing_section_ids": missing_section_ids,
        "expected_visual_count": expected_visual_count,
        "found_visual_count": len(parser.visual_ids),
        "missing_visual_ids": missing_visual_ids,
        "minimum_word_count": minimum_word_count or None,
        "source_word_count": parser.word_count,
        "cover_present": parser.cover_present,
        "toc_present": parser.toc_present,
        "conclusion_present": parser.conclusion_present,
        "references_present": parser.references_present,
        "duplicate_html_ids": sorted(parser.duplicate_ids),
        "unresolved_toc_targets": unresolved_toc_targets,
        "report_contract_problems": problems,
    }
