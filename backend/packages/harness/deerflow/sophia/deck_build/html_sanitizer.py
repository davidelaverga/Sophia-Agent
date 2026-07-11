from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from html.parser import HTMLParser
from typing import Any
from urllib.parse import unquote, urlsplit

from deerflow.sophia.deck_build.compiler_capabilities import (
    lossy_css_in_html,
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
_CSS_URL_RE = re.compile(r"\burl\s*\(", re.I)
_CSS_IMAGE_SET_RE = re.compile(r"\b(?:-webkit-)?image-set\s*\(", re.I)
_URL_ATTRIBUTE_NAMES = {"src", "href", "poster", "background", "data"}
_LEGACY_SUBRESOURCE_ATTRIBUTE_NAMES = {"poster", "background", "data"}
_DECK_ID_RE = re.compile(r"^[a-z][a-z0-9-]{0,63}$")


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
<style>
html, body {{ margin: 0; padding: 0; width: 1920px; height: 1080px; overflow: hidden; }}
main {{ width: 1920px; height: 1080px; box-sizing: border-box; overflow: hidden; }}
{deck_stylesheet}
{slide_css or ""}
</style>
</head>
<body>
<main class="slide-root" style="width: 1920px; height: 1080px;">
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
        self.body_attrs: dict[str, str] = {}
        self.main_attrs: dict[str, str] = {}
        self.source_elements: list[dict[str, Any]] = []
        self.in_style = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        clean_tag = tag.lower()
        self.tags.append(clean_tag)
        attr_map = self._scan_attributes(clean_tag, attrs)
        if clean_tag in _FORBIDDEN_TAGS:
            self.errors.append(f"forbidden tag <{clean_tag}>")
        if clean_tag == "link" and attr_map.get("rel", "").lower() == "stylesheet":
            self.errors.append("external stylesheet links are forbidden")
        if clean_tag == "body":
            self.body_attrs = attr_map
        if clean_tag == "main" and not self.main_attrs:
            self.main_attrs = attr_map
        if clean_tag == "style":
            self.in_style = True
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
            if name in seen and local_name in _URL_ATTRIBUTE_NAMES | {"srcset"}:
                self.errors.append(f"duplicate URL attribute {name} is forbidden")
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

    def handle_data(self, data: str) -> None:
        if self.in_style:
            self.styles.append(data)


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
    validation.sanitized = sanitized != source
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
        *(_selector_rule_body(css, "main") for css in scanner.styles),
        *(_selector_rule_body(css, ".canvas") for css in scanner.styles),
        *(_selector_rule_body(css, "body") for css in scanner.styles),
        *(_selector_rule_body(css, "html, body") for css in scanner.styles),
        *(_selector_rule_body(css, "html") for css in scanner.styles),
    ]


def _canvas_backgrounds(scanner: _HtmlScanner) -> list[str]:
    values: list[str] = []
    for candidate in _canvas_style_candidates(scanner):
        match = re.search(r"\bbackground(?:-color)?\s*:\s*([^;{}]+)", candidate, re.I)
        if match:
            values.append(match.group(1).strip().lower())
    return values


def _background_is_opaque(value: str) -> bool:
    if "transparent" in value:
        return False
    return not ("rgba(" in value and re.search(r"rgba\([^)]*,\s*0(?:\.0+)?\s*\)", value))


def _selector_rule_body(css: str, selector: str) -> str:
    selector_pattern = re.escape(selector).replace(r"\ ", r"\s*")
    match = re.search(rf"(^|[}}])\s*{selector_pattern}\s*\{{([^}}]+)\}}", css, re.I | re.S)
    return match.group(2) if match else ""


def _validate_css_urls(css: str, validation: HtmlSourceValidation) -> None:
    if _CSS_URL_RE.search(css):
        validation.errors.append("CSS url(...) subresources are forbidden; use planned <img> assets")
    if _CSS_IMAGE_SET_RE.search(css):
        validation.errors.append("CSS image-set(...) subresources are forbidden; use planned <img> assets")
