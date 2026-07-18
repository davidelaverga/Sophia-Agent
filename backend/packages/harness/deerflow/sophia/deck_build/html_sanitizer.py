from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from html.parser import HTMLParser
from typing import Any
from urllib.parse import unquote, urlsplit

import tinycss2
from tinycss2.color3 import parse_color

from deerflow.sophia.deck_build.compiler_capabilities import (
    lossy_css_in_html,
    meta_attributes_are_inert,
    unsupported_css_in_html,
    unsupported_tags_in_html,
)
from deerflow.sophia.deck_build.models import DeckSlideSpec
from deerflow.sophia.deck_build.tracing import safe_excerpt

SLIDE_WIDTH_PX = 1920
SLIDE_HEIGHT_PX = 1080

_FORBIDDEN_TAGS = {"script", "iframe", "object", "embed", "base"}
_FORBIDDEN_STYLE_RE = re.compile(
    r"(@import\b|@font-face\b|filter\s*:|backdrop-filter\s*:|mix-blend-mode\s*:|"
    r"background-blend-mode\s*:|animation\s*:|transition\s*:)",
    re.I,
)
_WARN_STYLE_RE = re.compile(r"(box-shadow\s*:|text-shadow\s*:|letter-spacing\s*:\s*-[^;]+)", re.I)
_REMOTE_URI_RE = re.compile(r"^(?:https?:)?//|^https?:", re.I)
_DATA_URI_RE = re.compile(r"^data:", re.I)
_FILE_URI_RE = re.compile(r"^file:", re.I)
_URL_ATTRIBUTE_NAMES = {"src", "href", "poster", "background", "data"}
_LEGACY_SUBRESOURCE_ATTRIBUTE_NAMES = {"poster", "background", "data"}
_DECK_ID_RE = re.compile(r"^[a-z][a-z0-9-]{0,63}$")
_VOID_TAGS = frozenset(
    {
        "area",
        "base",
        "br",
        "col",
        "embed",
        "hr",
        "img",
        "input",
        "link",
        "meta",
        "param",
        "source",
        "track",
        "wbr",
    }
)
_STABLE_REQUIRED_CONTAINER_TAGS = frozenset(
    {
        "article",
        "aside",
        "div",
        "figcaption",
        "figure",
        "footer",
        "header",
        "main",
        "nav",
        "section",
    }
)
_CONTEXTUAL_HTML_TAGS = frozenset(
    {
        "a",
        "button",
        "colgroup",
        "dd",
        "dt",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "li",
        "math",
        "nobr",
        "optgroup",
        "option",
        "p",
        "rb",
        "rp",
        "rt",
        "rtc",
        "select",
        "svg",
        "table",
        "tbody",
        "td",
        "template",
        "tfoot",
        "th",
        "thead",
        "tr",
    }
)
_SEMANTIC_ATTRIBUTE_NAMES = frozenset({"data-deck-id", "data-deck-required", "data-deck-role"})
_HEADING_TAGS = frozenset({"h1", "h2", "h3", "h4", "h5", "h6"})
_TABLE_STRUCTURE_TAGS = frozenset(
    {
        "caption",
        "col",
        "colgroup",
        "table",
        "tbody",
        "td",
        "tfoot",
        "th",
        "thead",
        "tr",
    }
)
_TABLE_SECTION_TAGS = frozenset({"tbody", "tfoot", "thead"})
_TABLE_PARAGRAPH_TEXT_STYLE_PROPERTIES = frozenset(
    {
        "color",
        "font-family",
        "font-size",
        "font-style",
        "font-weight",
        "line-height",
        "margin",
        "margin-bottom",
        "margin-left",
        "margin-right",
        "margin-top",
        "text-align",
        "text-decoration",
        "text-transform",
    }
)
_POSITIVE_TEXT_MEASURE_RE = re.compile(
    r"^(?P<number>(?:\d+(?:\.\d+)?|\.\d+))(?:px|pt|em|rem|%)?$",
    re.I,
)
_ZERO_MEASURE_RE = re.compile(r"^[+-]?0(?:\.0+)?(?:px|pt|em|rem|%)?$", re.I)


def assemble_compact_slide_html(
    *,
    deck_stylesheet: str,
    html_body: str,
    slide_css: str | None = None,
) -> str:
    """Wrap model-owned CSS and markup in a content-free compiler shell."""

    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style data-deck-harness="true">
html, body {{ margin: 0; padding: 0; width: 1920px; height: 1080px; overflow: hidden; }}
main {{ width: 1920px; height: 1080px; box-sizing: border-box; overflow: hidden; }}
</style>
<style data-deck-author="true">
{deck_stylesheet}
{slide_css or ""}
</style>
</head>
<body>
<main class="slide-root" data-slide-canvas="true" style="width: 1920px; height: 1080px;">
{html_body}
</main>
</body>
</html>
"""


@dataclass
class HtmlSourceValidation:
    selector: str
    valid: bool
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    image_refs: list[str] = field(default_factory=list)
    canvas_width_px: int | None = None
    canvas_height_px: int | None = None
    unsupported_tags: list[str] = field(default_factory=list)
    unsupported_css: list[str] = field(default_factory=list)
    source_elements: list[dict[str, Any]] = field(default_factory=list)
    sanitized: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class _HtmlScanner(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.tags: list[str] = []
        self.errors: list[str] = []
        self.warnings: list[str] = []
        self.image_refs: list[str] = []
        self.styles: list[str] = []
        self.author_styles: list[str] = []
        self.body_attrs: dict[str, str] = {}
        self.main_attrs: dict[str, str] = {}
        self.source_elements: list[dict[str, Any]] = []
        self.in_style = False
        self.in_harness_style = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        clean_tag = tag.lower()
        self.tags.append(clean_tag)
        attr_map = self._scan_attributes(clean_tag, attrs)
        if clean_tag in _FORBIDDEN_TAGS:
            self.errors.append(f"forbidden tag <{clean_tag}>")
        if clean_tag == "link" and attr_map.get("rel", "").lower() == "stylesheet":
            self.errors.append("external stylesheet links are forbidden")
        if clean_tag == "meta" and not meta_attributes_are_inert(attr_map):
            self.errors.append('meta directives are forbidden; only <meta charset="utf-8"> is allowed')
        if clean_tag == "body":
            self.body_attrs = attr_map
        if clean_tag == "main" and not self.main_attrs:
            self.main_attrs = attr_map
        if clean_tag == "style":
            self.in_style = True
            self.in_harness_style = attr_map.get("data-deck-harness", "").lower() == "true"
        self._record_source_element(clean_tag, attr_map)

    def _scan_attributes(
        self,
        tag: str,
        attrs: list[tuple[str, str | None]],
    ) -> dict[str, str]:
        attr_map: dict[str, str] = {}
        seen: set[str] = set()
        for raw_name, raw_value in attrs:
            name = raw_name.lower()
            value = raw_value or ""
            local_name = _attribute_local_name(name)
            if name in seen:
                if local_name in _URL_ATTRIBUTE_NAMES | {"srcset"}:
                    self.errors.append(f"duplicate URL attribute {name} is forbidden")
                if name in _SEMANTIC_ATTRIBUTE_NAMES:
                    self.errors.append(f"duplicate semantic attribute {name} is forbidden")
            seen.add(name)
            attr_map.setdefault(name, value)
            if local_name.startswith("on"):
                self.errors.append(f"inline event handler {name} is forbidden")
            self.errors.extend(_subresource_attribute_errors(local_name))
            if local_name in _URL_ATTRIBUTE_NAMES:
                _validate_uri(value, errors=self.errors)
                if tag == "img" and local_name == "src":
                    self.image_refs.append(value)
            if local_name == "style":
                self.styles.append(value)
        return attr_map

    def _record_source_element(self, tag: str, attrs: dict[str, str]) -> None:
        source_id = attrs.get("data-deck-id", "").strip()
        source_role = attrs.get("data-deck-role", "").strip()
        source_required = attrs.get("data-deck-required", "").strip().lower() == "true"
        if source_id or source_role or source_required:
            self.source_elements.append(
                {
                    "tag": tag,
                    "source_id": source_id,
                    "source_role": source_role,
                    "source_required": source_required,
                }
            )

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "style":
            self.in_style = False
            self.in_harness_style = False

    def handle_data(self, data: str) -> None:
        if self.in_style:
            self.styles.append(data)
            if not self.in_harness_style:
                self.author_styles.append(data)


class _CanonicalTableStructureValidator(HTMLParser):
    """Accept only table structure whose cell ancestry is source-explicit."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.stack: list[str] = []
        self.valid = True

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        del attrs
        self._handle_start(tag.lower(), self_closing=False)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        del attrs
        self._handle_start(tag.lower(), self_closing=True)

    def _handle_start(self, tag: str, *, self_closing: bool) -> None:
        if not self.valid:
            return
        if tag not in _TABLE_STRUCTURE_TAGS:
            if self.stack and self.stack[-1] not in {"caption", "td", "th"}:
                self.valid = False
            return
        if tag == "col":
            if not self.stack or self.stack[-1] != "colgroup":
                self.valid = False
            return
        if self_closing:
            self.valid = False
            return
        if tag == "table":
            if self.stack:
                self.valid = False
                return
        elif tag in {"caption", "colgroup"} | _TABLE_SECTION_TAGS:
            if self.stack != ["table"]:
                self.valid = False
                return
        elif tag == "tr":
            if self.stack not in (
                ["table"],
                ["table", "thead"],
                ["table", "tbody"],
                ["table", "tfoot"],
            ):
                self.valid = False
                return
        elif tag in {"td", "th"}:
            if not self.stack or self.stack[-1] != "tr":
                self.valid = False
                return
        self.stack.append(tag)

    def handle_endtag(self, tag: str) -> None:
        clean_tag = tag.lower()
        if not self.valid or clean_tag not in _TABLE_STRUCTURE_TAGS:
            return
        if clean_tag == "col" or not self.stack or self.stack[-1] != clean_tag:
            self.valid = False
            return
        self.stack.pop()

    def handle_data(self, data: str) -> None:
        if self.valid and self.stack and self.stack[-1] not in {"caption", "td", "th"} and data.strip():
            self.valid = False


@dataclass
class _ParagraphTextCandidate:
    start: int
    safe: bool
    has_text: bool = False


class _TableParagraphCoverageCollector(HTMLParser):
    """Locate source-explicit paragraphs that the native table preserves as text."""

    def __init__(self, source: str) -> None:
        super().__init__(convert_charrefs=True)
        self.source = source
        self.covered_starts: set[int] = set()
        self.open_elements: list[tuple[str, _ParagraphTextCandidate | None]] = []
        self.active_candidates: list[_ParagraphTextCandidate] = []
        self.line_offsets: list[int] = []
        offset = 0
        for line in source.splitlines(keepends=True):
            self.line_offsets.append(offset)
            offset += len(line)
        if not self.line_offsets:
            self.line_offsets.append(0)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        clean_tag = tag.lower()
        nested_in_paragraph = bool(self.active_candidates)
        for candidate in self.active_candidates:
            candidate.safe = False
        candidate = None
        if clean_tag == "p":
            candidate = _ParagraphTextCandidate(
                start=self._current_start_offset(),
                safe=not nested_in_paragraph and _paragraph_attrs_are_statically_textual(attrs),
            )
            self.active_candidates.append(candidate)
        if clean_tag not in _VOID_TAGS:
            self.open_elements.append((clean_tag, candidate))

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        del tag, attrs
        for candidate in self.active_candidates:
            candidate.safe = False

    def handle_data(self, data: str) -> None:
        if not data.strip() or not self.open_elements:
            return
        tag, candidate = self.open_elements[-1]
        if tag == "p" and candidate is not None:
            candidate.has_text = True

    def handle_endtag(self, tag: str) -> None:
        clean_tag = tag.lower()
        for index in range(len(self.open_elements) - 1, -1, -1):
            if self.open_elements[index][0] != clean_tag:
                continue
            removed = self.open_elements[index:]
            del self.open_elements[index:]
            for removed_tag, candidate in removed:
                if candidate is None:
                    continue
                if candidate in self.active_candidates:
                    self.active_candidates.remove(candidate)
                if (
                    clean_tag == "p"
                    and removed_tag == "p"
                    and candidate.safe
                    and candidate.has_text
                ):
                    self.covered_starts.add(candidate.start)
            return

    def _current_start_offset(self) -> int:
        line, column = self.getpos()
        if line <= 0 or line > len(self.line_offsets):
            return -1
        return self.line_offsets[line - 1] + column


class _RequiredSemanticNormalizer(HTMLParser):
    """Normalize safe required semantics without reserializing authored HTML."""

    def __init__(
        self,
        source: str,
        *,
        allow_required_table_coverage: bool,
        table_text_covered_starts: set[int],
    ) -> None:
        super().__init__(convert_charrefs=True)
        self.source = source
        self.allow_required_table_coverage = allow_required_table_coverage
        self.table_text_covered_starts = table_text_covered_starts
        self.replacements: list[tuple[int, int, str]] = []
        self.open_elements: list[tuple[str, bool, bool, bool, bool]] = []
        self.valid_required_depth = 0
        self.contextual_html_depth = 0
        self.valid_required_table_depth = 0
        self.inferred_role_count = 0
        self.removed_required_count = 0
        self.line_offsets: list[int] = []
        offset = 0
        for line in source.splitlines(keepends=True):
            self.line_offsets.append(offset)
            offset += len(line)
        if not self.line_offsets:
            self.line_offsets.append(0)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self._handle_start(tag, attrs, push=tag.lower() not in _VOID_TAGS)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self._handle_start(tag, attrs, push=False)

    def _handle_start(
        self,
        tag: str,
        attrs: list[tuple[str, str | None]],
        *,
        push: bool,
    ) -> None:
        attr_map: dict[str, str] = {}
        attr_counts: dict[str, int] = {}
        for raw_name, raw_value in attrs:
            clean_name = raw_name.lower()
            attr_map.setdefault(clean_name, raw_value or "")
            attr_counts[clean_name] = attr_counts.get(clean_name, 0) + 1
        source_required = attr_map.get("data-deck-required", "").strip().lower() == "true"
        source_id = attr_map.get("data-deck-id", "").strip()
        source_role = attr_map.get("data-deck-role", "").strip()
        class_tokens = set(attr_map.get("class", "").lower().split())
        semantic_attrs_are_unique = all(attr_counts.get(name, 0) <= 1 for name in _SEMANTIC_ATTRIBUTE_NAMES)
        has_role_attribute = attr_counts.get("data-deck-role", 0) == 1
        valid_source_id = bool(_DECK_ID_RE.fullmatch(source_id))

        has_stable_required_coverage = bool(
            self.valid_required_depth > 0 and self.contextual_html_depth == 0
        )
        has_required_table_text_coverage = bool(
            tag.lower() == "p"
            and self._current_start_offset() in self.table_text_covered_starts
            and self.allow_required_table_coverage
            and self.valid_required_table_depth > 0
            and self._is_direct_child_of_required_table_cell()
        )
        has_covered_required_ancestor = bool(
            has_stable_required_coverage or has_required_table_text_coverage
        )
        inferred_role = _inferred_required_role(
            tag.lower(),
            class_tokens,
            inside_table=any(element[0] == "table" for element in self.open_elements),
        )
        role_was_inferred = bool(source_required and valid_source_id and not source_role and not has_role_attribute and semantic_attrs_are_unique and inferred_role and self._record_inferred_role(inferred_role))
        effective_role = source_role or (inferred_role if role_was_inferred else "")
        redundant_unaddressable = bool(
            source_required
            and not role_was_inferred
            and (not source_id or (valid_source_id and not source_role and not has_role_attribute))
            and has_covered_required_ancestor
            and semantic_attrs_are_unique
            and self._record_required_attribute_removal()
        )
        valid_required = bool(source_required and not redundant_unaddressable and valid_source_id and effective_role)
        if push:
            stable_required_container = valid_required and tag.lower() in _STABLE_REQUIRED_CONTAINER_TAGS
            contextual_html = tag.lower() in _CONTEXTUAL_HTML_TAGS
            valid_required_table = valid_required and tag.lower() == "table"
            valid_required_table_cell = bool(tag.lower() in {"td", "th"} and self._has_open_required_table_row_for_cell())
            self.open_elements.append(
                (
                    tag.lower(),
                    stable_required_container,
                    contextual_html,
                    valid_required_table,
                    valid_required_table_cell,
                )
            )
            if stable_required_container:
                self.valid_required_depth += 1
            if contextual_html:
                self.contextual_html_depth += 1
            if valid_required_table:
                self.valid_required_table_depth += 1

    def _has_open_required_table_row_for_cell(self) -> bool:
        if not self.allow_required_table_coverage:
            return False
        required_table_index = next(
            (index for index in range(len(self.open_elements) - 1, -1, -1) if self.open_elements[index][3]),
            None,
        )
        if required_table_index is None:
            return False
        lineage = [element[0] for element in self.open_elements[required_table_index + 1 :]]
        return lineage in (
            ["tr"],
            ["thead", "tr"],
            ["tbody", "tr"],
            ["tfoot", "tr"],
        )

    def _is_direct_child_of_required_table_cell(self) -> bool:
        if not self.open_elements:
            return False
        tag, _valid, _context, _required_table, required_cell = self.open_elements[-1]
        return tag in {"td", "th"} and required_cell

    def _record_required_attribute_removal(self) -> bool:
        raw_tag = self.get_starttag_text() or ""
        attributes = [(start, end) for name, value, start, end in _start_tag_attributes(raw_tag) if name == "data-deck-required" and value.strip().lower() == "true"]
        if len(attributes) != 1:
            return False
        start, end = attributes[0]
        normalized_tag = f"{raw_tag[:start]}{raw_tag[end:]}"
        if not self._record_tag_replacement(raw_tag, normalized_tag):
            return False
        self.removed_required_count += 1
        return True

    def _record_inferred_role(self, role: str) -> bool:
        raw_tag = self.get_starttag_text() or ""
        closing = re.search(r"\s*/?>$", raw_tag)
        if closing is None:
            return False
        normalized_tag = f'{raw_tag[: closing.start()]} data-deck-role="{role}"{raw_tag[closing.start() :]}'
        if not self._record_tag_replacement(raw_tag, normalized_tag):
            return False
        self.inferred_role_count += 1
        return True

    def _record_tag_replacement(self, raw_tag: str, normalized_tag: str) -> bool:
        if normalized_tag == raw_tag:
            return False
        start = self._current_start_offset()
        if start < 0:
            return False
        end = start + len(raw_tag)
        if self.source[start:end] != raw_tag:
            return False
        self.replacements.append((start, end, normalized_tag))
        return True

    def _current_start_offset(self) -> int:
        line, column = self.getpos()
        if line <= 0 or line > len(self.line_offsets):
            return -1
        return self.line_offsets[line - 1] + column

    def handle_endtag(self, tag: str) -> None:
        clean_tag = tag.lower()
        for index in range(len(self.open_elements) - 1, -1, -1):
            if self.open_elements[index][0] != clean_tag:
                continue
            removed = self.open_elements[index:]
            del self.open_elements[index:]
            self.valid_required_depth -= sum(1 for _tag, valid, _context, _table, _cell in removed if valid)
            self.contextual_html_depth -= sum(1 for _tag, _valid, contextual, _table, _cell in removed if contextual)
            self.valid_required_table_depth -= sum(1 for _tag, _valid, _context, required_table, _cell in removed if required_table)
            return


def validate_and_sanitize_slide_html(
    slide: DeckSlideSpec,
    *,
    allowed_asset_refs: set[str],
) -> tuple[str, HtmlSourceValidation]:
    source = slide.html_source or ""
    validation = HtmlSourceValidation(selector=slide.selector, valid=False)
    if not source.strip():
        validation.errors.append("html_source is required")
        return source, validation
    (
        source,
        inferred_role_count,
        removed_required_count,
        canonical_table_structure,
    ) = _normalize_required_semantics(source)
    if inferred_role_count:
        validation.warnings.append(f"inferred {inferred_role_count} missing required data-deck-role marker(s)")
    if removed_required_count:
        validation.warnings.append(f"removed {removed_required_count} redundant nested data-deck-required marker(s)")
    if not canonical_table_structure:
        validation.errors.append("table structure must use explicit canonical table, section, row, and cell nesting")
    scanner = _HtmlScanner()
    try:
        scanner.feed(source)
    except Exception as exc:  # noqa: BLE001 - parser failures become model repair feedback.
        validation.errors.append(f"html parse failed: {type(exc).__name__}")
        return source, validation
    validation.errors.extend(scanner.errors)
    validation.warnings.extend(scanner.warnings)
    validation.image_refs = list(dict.fromkeys(scanner.image_refs))
    validation.source_elements = scanner.source_elements
    validation.unsupported_tags = unsupported_tags_in_html(source)
    validation.unsupported_css = unsupported_css_in_html(source)
    for tag in validation.unsupported_tags:
        validation.errors.append(f"unsupported_native_deck_tag: {tag}")
    for prop in validation.unsupported_css:
        validation.errors.append(f"unsupported_native_deck_css: {prop}")
    for prop in lossy_css_in_html(source):
        validation.errors.append(f"lossy_native_deck_css: {prop}")
    _validate_source_elements(scanner.source_elements, validation)
    _validate_canvas(source, scanner, validation)
    _validate_background(scanner, validation)
    _validate_css(scanner.styles, validation)
    _validate_image_refs(validation.image_refs, allowed_asset_refs, validation)
    sanitized = _sanitize_css(source)
    validation.sanitized = bool(inferred_role_count or removed_required_count) or sanitized != source
    validation.valid = not validation.errors
    return sanitized, validation


def validation_summary(results: list[HtmlSourceValidation]) -> dict[str, Any]:
    errors = [{"selector": result.selector, "error": error} for result in results for error in result.errors]
    warnings = [{"selector": result.selector, "warning": warning} for result in results for warning in result.warnings]
    return {
        "valid": not errors,
        "slide_count": len(results),
        "error_count": len(errors),
        "warning_count": len(warnings),
        "errors": errors[:12],
        "warnings": warnings[:12],
        "image_refs": {result.selector: result.image_refs for result in results if result.image_refs},
        "unsupported_tags": {result.selector: result.unsupported_tags for result in results if result.unsupported_tags},
        "unsupported_css": {result.selector: result.unsupported_css for result in results if result.unsupported_css},
    }


def _normalize_required_semantics(source: str) -> tuple[str, int, int, bool]:
    """Normalize only semantics that retain deterministic required coverage.

    A required element with a valid stable ID receives a role only when its
    authored tag or component class determines one unambiguously. An incomplete
    nested marker is removed only when a stable, fully valid required container
    covers its descendants and no contextual or optional-end-tag parser state can
    reparent the node. A valid required table also covers descendants inside a
    structurally explicit row and cell. All other incomplete semantics remain
    untouched and retain validation errors.
    """

    table_validator = _CanonicalTableStructureValidator()
    try:
        table_validator.feed(source)
        table_validator.close()
    except Exception:  # noqa: BLE001 - conservative normalization fallback.
        table_validator.valid = False
    canonical_table_structure = table_validator.valid and not table_validator.stack
    table_text_covered_starts: set[int] = set()
    if canonical_table_structure:
        table_text_collector = _TableParagraphCoverageCollector(source)
        try:
            table_text_collector.feed(source)
            table_text_collector.close()
        except Exception:  # noqa: BLE001 - conservative normalization fallback.
            table_text_collector.covered_starts.clear()
        table_text_covered_starts = table_text_collector.covered_starts
    normalizer = _RequiredSemanticNormalizer(
        source,
        allow_required_table_coverage=canonical_table_structure,
        table_text_covered_starts=table_text_covered_starts,
    )
    try:
        normalizer.feed(source)
    except Exception:  # noqa: BLE001 - validation will report parser failures later.
        return source, 0, 0, canonical_table_structure
    if not normalizer.replacements:
        return source, 0, 0, canonical_table_structure
    normalized = source
    for start, end, replacement in reversed(normalizer.replacements):
        normalized = f"{normalized[:start]}{replacement}{normalized[end:]}"
    return (
        normalized,
        normalizer.inferred_role_count,
        normalizer.removed_required_count,
        canonical_table_structure,
    )


def _inferred_required_role(
    tag: str,
    class_tokens: set[str],
    *,
    inside_table: bool,
) -> str | None:
    if inside_table:
        return "narrative" if tag == "p" else None
    if tag in _HEADING_TAGS:
        return "title"
    if tag in {"p", "li"}:
        return "narrative"
    if tag == "table":
        return "comparison"
    class_roles = {role for class_name, role in (("node-box", "diagram"), ("card", "content")) if class_name in class_tokens}
    return next(iter(class_roles)) if len(class_roles) == 1 else None


def _paragraph_attrs_are_statically_textual(
    attrs: list[tuple[str, str | None]],
) -> bool:
    attr_map: dict[str, str] = {}
    attr_counts: dict[str, int] = {}
    for raw_name, raw_value in attrs:
        name = raw_name.lower()
        attr_map.setdefault(name, raw_value or "")
        attr_counts[name] = attr_counts.get(name, 0) + 1
    if any(attr_counts.get(name, 0) > 1 for name in {"class", "hidden", "style"}):
        return False
    if attr_map.get("class", "").strip() or "hidden" in attr_map or "inert" in attr_map:
        return False
    if attr_map.get("aria-hidden", "").strip().lower() == "true":
        return False
    style = attr_map.get("style", "")
    if not style.strip():
        return True
    declarations = tinycss2.parse_declaration_list(
        style,
        skip_comments=True,
        skip_whitespace=True,
    )
    for declaration in declarations:
        if declaration.type != "declaration":
            return False
        name = declaration.lower_name
        value = tinycss2.serialize(declaration.value).strip().lower()
        if name not in _TABLE_PARAGRAPH_TEXT_STYLE_PROPERTIES or not value or "var(" in value:
            return False
        if name in {"font-size", "line-height"}:
            match = _POSITIVE_TEXT_MEASURE_RE.fullmatch(value)
            if match is None or float(match.group("number")) <= 0:
                return False
        if name == "color":
            color_tokens = [
                token
                for token in declaration.value
                if token.type not in {"comment", "whitespace"}
            ]
            color = parse_color(color_tokens[0]) if len(color_tokens) == 1 else None
            if color is None or not hasattr(color, "alpha") or color.alpha <= 0:
                return False
        if name.startswith("margin") and not all(
            _ZERO_MEASURE_RE.fullmatch(part) for part in value.split()
        ):
            return False
    return True


def _start_tag_attributes(raw_tag: str) -> list[tuple[str, str, int, int]]:
    """Return source-preserving attribute spans from one authored start tag."""

    attributes: list[tuple[str, str, int, int]] = []
    index = 1
    length = len(raw_tag)
    while index < length and raw_tag[index].isspace():
        index += 1
    while index < length and not raw_tag[index].isspace() and raw_tag[index] not in "/>":
        index += 1
    while index < length:
        span_start = index
        while index < length and raw_tag[index].isspace():
            index += 1
        if index >= length or raw_tag[index] in "/>":
            break
        name_start = index
        while index < length and not raw_tag[index].isspace() and raw_tag[index] not in "=/>":
            index += 1
        name = raw_tag[name_start:index].lower()
        while index < length and raw_tag[index].isspace():
            index += 1
        value = ""
        if index < length and raw_tag[index] == "=":
            index += 1
            while index < length and raw_tag[index].isspace():
                index += 1
            if index < length and raw_tag[index] in "\"'":
                quote = raw_tag[index]
                index += 1
                value_start = index
                while index < length and raw_tag[index] != quote:
                    index += 1
                value = raw_tag[value_start:index]
                if index < length:
                    index += 1
            else:
                value_start = index
                while index < length and not raw_tag[index].isspace() and raw_tag[index] not in ">":
                    index += 1
                value = raw_tag[value_start:index]
        attributes.append((name, value, span_start, index))
    return attributes


def _validate_uri(value: str, *, errors: list[str]) -> None:
    clean = value.strip()
    if _REMOTE_URI_RE.search(clean):
        errors.append("remote http(s) URLs are forbidden")
    if _DATA_URI_RE.search(clean):
        errors.append("data URIs are forbidden")
    if _FILE_URI_RE.search(clean):
        errors.append("file URIs are forbidden")


def _attribute_local_name(name: str) -> str:
    return name.rsplit(":", 1)[-1]


def _subresource_attribute_errors(name: str) -> list[str]:
    if name == "srcset":
        return ["srcset subresources are forbidden; use one planned src asset"]
    if name in _LEGACY_SUBRESOURCE_ATTRIBUTE_NAMES:
        return [f"{name} subresource attributes are forbidden; use a planned img src asset"]
    return []


def _validate_canvas(source: str, scanner: _HtmlScanner, validation: HtmlSourceValidation) -> None:
    width, height = _canvas_size(scanner)
    validation.canvas_width_px = width
    validation.canvas_height_px = height
    if width != SLIDE_WIDTH_PX or height != SLIDE_HEIGHT_PX:
        validation.errors.append(f"slide canvas must be {SLIDE_WIDTH_PX}x{SLIDE_HEIGHT_PX}px")
    if not any(tag in scanner.tags for tag in ("body", "main")):
        validation.errors.append("html must include a body/main slide canvas")


def _validate_background(scanner: _HtmlScanner, validation: HtmlSourceValidation) -> None:
    backgrounds = _canvas_backgrounds(scanner)
    if not backgrounds:
        validation.errors.append("slide canvas must declare an opaque background")
        return
    if not any(_background_is_opaque(value) for value in backgrounds):
        validation.errors.append("slide background must be opaque")


def _validate_css(styles: list[str], validation: HtmlSourceValidation) -> None:
    css = "\n".join(styles)
    if _FORBIDDEN_STYLE_RE.search(css):
        validation.errors.append("CSS uses unsupported active/external/fragile features")
    _validate_css_urls(css, validation)
    if _WARN_STYLE_RE.search(css):
        validation.warnings.append("CSS contains fragile decorative effects that may be sanitized")
    if "position: fixed" in css.lower():
        validation.errors.append("position: fixed overlays are forbidden")


def _validate_source_elements(elements: list[dict[str, Any]], validation: HtmlSourceValidation) -> None:
    seen: set[str] = set()
    for element in elements:
        source_id = str(element.get("source_id") or "")
        source_role = str(element.get("source_role") or "")
        required = bool(element.get("source_required"))
        if source_id and not _DECK_ID_RE.fullmatch(source_id):
            validation.errors.append(f"invalid data-deck-id: {safe_excerpt(source_id, limit=80)}")
        if source_id in seen:
            validation.errors.append(f"duplicate data-deck-id: {safe_excerpt(source_id, limit=80)}")
        if source_id:
            seen.add(source_id)
        if required and not source_id:
            validation.errors.append("data-deck-required=true requires data-deck-id")
        if required and not source_role:
            validation.errors.append(f"required element {source_id or '<unknown>'} requires data-deck-role")


def _validate_image_refs(refs: list[str], allowed_asset_refs: set[str], validation: HtmlSourceValidation) -> None:
    for ref in refs:
        normalized = _canonical_planned_asset_ref(ref)
        if normalized is not None:
            basename = normalized.removeprefix("../assets/")
            if basename in allowed_asset_refs or normalized in allowed_asset_refs:
                continue
        normalized = ref.replace("\\", "/").strip()
        validation.errors.append(f"unplanned image asset reference: {safe_excerpt(normalized, limit=120)}")


def _canonical_planned_asset_ref(ref: str) -> str | None:
    try:
        parsed = urlsplit(ref.strip())
    except ValueError:
        return None
    if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment:
        return None
    normalized = unquote(parsed.path).replace("\\", "/")
    prefix = "../assets/"
    if not normalized.startswith(prefix):
        return None
    basename = normalized.removeprefix(prefix)
    if not basename or basename in {".", ".."} or "/" in basename:
        return None
    return f"{prefix}{basename}"


def _sanitize_css(source: str) -> str:
    sanitized = re.sub(r"\bbox-shadow\s*:\s*[^;{}]+;?", "", source, flags=re.I)
    sanitized = re.sub(r"\btext-shadow\s*:\s*[^;{}]+;?", "", sanitized, flags=re.I)
    sanitized = re.sub(r"\bletter-spacing\s*:\s*-\d+(?:\.\d+)?(?:px|em|rem);?", "letter-spacing: 0;", sanitized, flags=re.I)
    return sanitized


def _first_px(source: str, prop: str) -> int | None:
    match = re.search(rf"\b{re.escape(prop)}\s*:\s*(\d+)px\b", source, re.I)
    if not match:
        return None
    try:
        return int(match.group(1))
    except ValueError:
        return None


def _canvas_size(scanner: _HtmlScanner) -> tuple[int | None, int | None]:
    for candidate in _canvas_style_candidates(scanner):
        if not candidate:
            continue
        width = _first_px(candidate, "width")
        height = _first_px(candidate, "height")
        if width is not None and height is not None:
            return width, height
    return None, None


def _canvas_style_candidates(scanner: _HtmlScanner) -> list[str]:
    return [
        scanner.main_attrs.get("style", ""),
        scanner.body_attrs.get("style", ""),
        *(_selector_rule_bodies(scanner.styles, _CANVAS_SELECTORS)),
    ]


def _canvas_backgrounds(scanner: _HtmlScanner) -> list[str]:
    values = _effective_canvas_backgrounds(scanner.author_styles)
    for candidate in (
        scanner.body_attrs.get("style", ""),
        scanner.main_attrs.get("style", ""),
    ):
        inline_value = _last_background_declaration(candidate)
        if inline_value:
            values.append(inline_value)
    return values


def _background_is_opaque(value: str) -> bool:
    normalized = value.strip().lower()
    if not normalized or "transparent" in normalized or "var(" in normalized:
        return False
    rgba = re.search(r"rgba\([^)]*,\s*(0|0?\.\d+|1(?:\.0+)?)\s*\)", normalized)
    if rgba and float(rgba.group(1)) < 1:
        return False
    modern_rgb = re.search(r"rgba?\([^)]*?/\s*(0|0?\.\d+|1(?:\.0+)?|\d+(?:\.\d+)?%)\s*\)", normalized)
    if modern_rgb:
        alpha = modern_rgb.group(1)
        if alpha.endswith("%"):
            return float(alpha[:-1]) >= 100
        return float(alpha) >= 1
    hex_match = re.fullmatch(r"#(?:[0-9a-f]{4}|[0-9a-f]{8})", normalized)
    if hex_match:
        alpha_hex = normalized[-1] * 2 if len(normalized) == 5 else normalized[-2:]
        return int(alpha_hex, 16) == 255
    return True


_CANVAS_SELECTORS = frozenset(
    {
        "html",
        "body",
        "main",
        ".canvas",
        ".slide-root",
        "main.slide-root",
        "[data-slide-canvas]",
        '[data-slide-canvas="true"]',
    }
)


def _normalized_selector(selector: str) -> str:
    return re.sub(r"\s+", " ", selector.strip().lower())


def _selector_rule_bodies(styles: list[str], selectors: frozenset[str]) -> list[str]:
    bodies: list[str] = []
    for css in styles:
        for rule in tinycss2.parse_stylesheet(css, skip_comments=True, skip_whitespace=True):
            if getattr(rule, "type", None) != "qualified-rule":
                continue
            selector_text = tinycss2.serialize(rule.prelude)
            rule_selectors = {_normalized_selector(item) for item in selector_text.split(",")}
            if rule_selectors & selectors:
                bodies.append(tinycss2.serialize(rule.content))
    return bodies


def _effective_canvas_backgrounds(styles: list[str]) -> list[str]:
    winners: dict[str, tuple[int, int, str]] = {}
    order = 0
    for css in styles:
        for rule in tinycss2.parse_stylesheet(css, skip_comments=True, skip_whitespace=True):
            if getattr(rule, "type", None) != "qualified-rule":
                continue
            value = _last_background_declaration(rule.content)
            if not value:
                continue
            selector_text = tinycss2.serialize(rule.prelude)
            for raw_selector in selector_text.split(","):
                selector = _normalized_selector(raw_selector)
                if selector not in _CANVAS_SELECTORS:
                    continue
                target = "main" if selector in {"main", ".canvas", ".slide-root", "main.slide-root", "[data-slide-canvas]", '[data-slide-canvas="true"]'} else selector
                specificity = _canvas_selector_specificity(selector)
                current = winners.get(target)
                if current is None or (specificity, order) >= current[:2]:
                    winners[target] = (specificity, order, value)
            order += 1
    return [winner[2] for winner in winners.values()]


def _canvas_selector_specificity(selector: str) -> int:
    return 10 * selector.count(".") + 10 * selector.count("[") + (1 if selector.startswith(("main", "body", "html")) else 0)


def _last_background_declaration(css: str | list[object]) -> str | None:
    tokens = tinycss2.parse_component_value_list(css) if isinstance(css, str) else css
    winner: str | None = None
    for declaration in tinycss2.parse_declaration_list(tokens, skip_comments=True, skip_whitespace=True):
        if getattr(declaration, "type", None) != "declaration":
            continue
        if str(declaration.lower_name) not in {"background", "background-color"}:
            continue
        winner = tinycss2.serialize(declaration.value).strip().lower()
    return winner


def _validate_css_urls(css: str, validation: HtmlSourceValidation) -> None:
    subresources = _css_subresource_kinds(css)
    if "url" in subresources:
        validation.errors.append("CSS url(...) subresources are forbidden; use planned <img> assets")
    if "image-set" in subresources:
        validation.errors.append("CSS image-set(...) subresources are forbidden; use planned <img> assets")
    if "import" in subresources:
        validation.errors.append("CSS @import subresources are forbidden; author styles inline")


def _css_subresource_kinds(css: str) -> set[str]:
    """Return decoded CSS subresource constructs, including escaped identifiers."""

    found: set[str] = set()

    def visit(tokens: list[object]) -> None:
        for token in tokens:
            token_type = str(getattr(token, "type", ""))
            if token_type == "url":
                found.add("url")
            elif token_type == "function":
                name = str(getattr(token, "lower_name", getattr(token, "name", ""))).lower()
                if name == "url":
                    found.add("url")
                elif name in {"image-set", "-webkit-image-set"}:
                    found.add("image-set")
            elif token_type == "at-keyword" and str(getattr(token, "value", "")).lower() == "import":
                found.add("import")

            for child_name in ("arguments", "content"):
                children = getattr(token, child_name, None)
                if children:
                    visit(list(children))

    visit(list(tinycss2.parse_component_value_list(css, skip_comments=True)))
    return found
