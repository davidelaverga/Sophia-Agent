from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from html.parser import HTMLParser
from typing import Any

from deerflow.sophia.deck_build.models import DeckSlideSpec
from deerflow.sophia.deck_build.tracing import safe_excerpt

SLIDE_WIDTH_PX = 1920
SLIDE_HEIGHT_PX = 1080

_FORBIDDEN_TAGS = {"script", "iframe", "object", "embed"}
_FORBIDDEN_STYLE_RE = re.compile(
    r"(@import\b|@font-face\b|filter\s*:|backdrop-filter\s*:|mix-blend-mode\s*:|"
    r"background-blend-mode\s*:|animation\s*:|transition\s*:)",
    re.I,
)
_WARN_STYLE_RE = re.compile(r"(box-shadow\s*:|text-shadow\s*:|letter-spacing\s*:\s*-[^;]+)", re.I)
_REMOTE_URI_RE = re.compile(r"^(?:https?:)?//|^https?:", re.I)
_DATA_URI_RE = re.compile(r"^data:", re.I)
_CSS_URL_RE = re.compile(r"url\(\s*(['\"]?)([^)'\"\s]+)\1\s*\)", re.I)


@dataclass
class HtmlSourceValidation:
    selector: str
    valid: bool
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    image_refs: list[str] = field(default_factory=list)
    canvas_width_px: int | None = None
    canvas_height_px: int | None = None
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
        self.in_style = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        clean_tag = tag.lower()
        self.tags.append(clean_tag)
        attr_map = {name.lower(): value or "" for name, value in attrs}
        if clean_tag in _FORBIDDEN_TAGS:
            self.errors.append(f"forbidden tag <{clean_tag}>")
        if clean_tag == "link" and attr_map.get("rel", "").lower() == "stylesheet":
            self.errors.append("external stylesheet links are forbidden")
        for name, value in attr_map.items():
            if name.startswith("on"):
                self.errors.append(f"inline event handler {name} is forbidden")
            if name in {"src", "href"}:
                _validate_uri(value, errors=self.errors)
                if clean_tag == "img" and name == "src":
                    self.image_refs.append(value)
            if name == "style":
                self.styles.append(value)
        if clean_tag == "body":
            self.body_attrs = attr_map
        if clean_tag == "main" and not self.main_attrs:
            self.main_attrs = attr_map
        if clean_tag == "style":
            self.in_style = True

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
    _validate_canvas(source, scanner, validation)
    _validate_background(source, scanner, validation)
    _validate_css(scanner.styles, validation)
    _validate_image_refs(validation.image_refs, allowed_asset_refs, validation)
    sanitized = _sanitize_css(source)
    validation.sanitized = sanitized != source
    validation.valid = not validation.errors
    return sanitized, validation


def validation_summary(results: list[HtmlSourceValidation]) -> dict[str, Any]:
    errors = [
        {"selector": result.selector, "error": error}
        for result in results
        for error in result.errors
    ]
    warnings = [
        {"selector": result.selector, "warning": warning}
        for result in results
        for warning in result.warnings
    ]
    return {
        "valid": not errors,
        "slide_count": len(results),
        "error_count": len(errors),
        "warning_count": len(warnings),
        "errors": errors[:12],
        "warnings": warnings[:12],
        "image_refs": {
            result.selector: result.image_refs
            for result in results
            if result.image_refs
        },
    }


def _validate_uri(value: str, *, errors: list[str]) -> None:
    clean = value.strip()
    if _REMOTE_URI_RE.search(clean):
        errors.append("remote http(s) URLs are forbidden")
    if _DATA_URI_RE.search(clean):
        errors.append("data URIs are forbidden")


def _validate_canvas(source: str, scanner: _HtmlScanner, validation: HtmlSourceValidation) -> None:
    width, height = _canvas_size(scanner)
    validation.canvas_width_px = width
    validation.canvas_height_px = height
    if width != SLIDE_WIDTH_PX or height != SLIDE_HEIGHT_PX:
        validation.errors.append(f"slide canvas must be {SLIDE_WIDTH_PX}x{SLIDE_HEIGHT_PX}px")
    if not any(tag in scanner.tags for tag in ("body", "main")):
        validation.errors.append("html must include a body/main slide canvas")


def _validate_background(source: str, scanner: _HtmlScanner, validation: HtmlSourceValidation) -> None:
    haystack = "\n".join(scanner.styles + [scanner.body_attrs.get("style", ""), scanner.main_attrs.get("style", ""), source[:5000]])
    background_match = re.search(r"\bbackground(?:-color)?\s*:\s*([^;{}]+)", haystack, re.I)
    if not background_match:
        validation.errors.append("slide canvas must declare an opaque background")
        return
    value = background_match.group(1).strip().lower()
    if "transparent" in value or "rgba(" in value and re.search(r"rgba\([^)]*,\s*0(?:\.0+)?\s*\)", value):
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


def _validate_image_refs(refs: list[str], allowed_asset_refs: set[str], validation: HtmlSourceValidation) -> None:
    for ref in refs:
        normalized = ref.replace("\\", "/").strip()
        if normalized.startswith("../assets/"):
            basename = normalized.rsplit("/", 1)[-1]
            if basename in allowed_asset_refs or normalized in allowed_asset_refs:
                continue
        validation.errors.append(f"unplanned image asset reference: {safe_excerpt(normalized, limit=120)}")


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
    candidates = [
        scanner.main_attrs.get("style", ""),
        scanner.body_attrs.get("style", ""),
        *(_selector_rule_body(css, "main") for css in scanner.styles),
        *(_selector_rule_body(css, ".canvas") for css in scanner.styles),
        *(_selector_rule_body(css, "body") for css in scanner.styles),
        *(_selector_rule_body(css, "html, body") for css in scanner.styles),
        *(_selector_rule_body(css, "html") for css in scanner.styles),
    ]
    for candidate in candidates:
        if not candidate:
            continue
        width = _first_px(candidate, "width")
        height = _first_px(candidate, "height")
        if width is not None and height is not None:
            return width, height
    return None, None


def _selector_rule_body(css: str, selector: str) -> str:
    selector_pattern = re.escape(selector).replace(r"\ ", r"\s*")
    match = re.search(rf"(^|[}}])\s*{selector_pattern}\s*\{{([^}}]+)\}}", css, re.I | re.S)
    return match.group(2) if match else ""


def _validate_css_urls(css: str, validation: HtmlSourceValidation) -> None:
    for match in _CSS_URL_RE.finditer(css):
        uri = match.group(2).strip()
        if _REMOTE_URI_RE.search(uri) or _DATA_URI_RE.search(uri) or uri.lower().startswith("file:"):
            validation.errors.append("CSS url(...) subresources are forbidden")
            return
        normalized = uri.replace("\\", "/")
        if normalized.startswith("../assets/"):
            validation.errors.append("CSS url(...) asset references are forbidden; use planned <img> assets")
            return
