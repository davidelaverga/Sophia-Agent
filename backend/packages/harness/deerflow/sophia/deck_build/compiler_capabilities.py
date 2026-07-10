"""Authoritative model-facing capability contract for native deck HTML."""

from __future__ import annotations

import re
from html.parser import HTMLParser

SUPPORTED_TAGS = frozenset(
    {
        "html",
        "head",
        "meta",
        "style",
        "body",
        "main",
        "section",
        "article",
        "header",
        "footer",
        "div",
        "figure",
        "figcaption",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "p",
        "span",
        "strong",
        "em",
        "small",
        "b",
        "i",
        "u",
        "a",
        "code",
        "sup",
        "sub",
        "ul",
        "ol",
        "li",
        "table",
        "thead",
        "tbody",
        "tfoot",
        "tr",
        "th",
        "td",
        "img",
        "blockquote",
        "br",
    }
)

REJECTED_TAGS = frozenset(
    {
        "svg",
        "circle",
        "ellipse",
        "line",
        "path",
        "polyline",
        "polygon",
        "foreignobject",
        "canvas",
        "video",
        "audio",
        "script",
        "iframe",
        "object",
        "embed",
        "base",
        "link",
    }
)

SUPPORTED_AUTHORING_FEATURES = (
    "text blocks and styled inline runs",
    "lists",
    "tables",
    "solid fills",
    "borders and border radii",
    "linear gradients",
    "planned local images",
    "flex, grid, and absolute positioning",
    "rotation and vertical writing",
)

SUPPORTED_CSS_FEATURES = frozenset(
    {
        "absolute-positioning",
        "borders",
        "border-radius",
        "color",
        "dimensions",
        "flex",
        "font-family",
        "font-size",
        "font-style",
        "font-weight",
        "grid",
        "line-height",
        "linear-gradient",
        "margin",
        "padding",
        "rotate-transform",
        "solid-fill",
        "text-align",
        "vertical-align",
        "writing-mode",
    }
)

REJECTED_CSS_PROPERTIES = frozenset(
    {
        "filter",
        "backdrop-filter",
        "mix-blend-mode",
        "background-blend-mode",
        "animation",
        "animation-name",
        "transition",
        "position-fixed",
    }
)

LOSSY_CSS_PROPERTIES = frozenset(
    {
        "box-shadow",
        "text-shadow",
        "letter-spacing",
        "opacity",
    }
)

_STYLE_PROPERTY_RE = re.compile(r"(?:^|[;{])\s*([a-zA-Z-]+)\s*:", re.M)
_STYLE_BLOCK_RE = re.compile(r"<style\b[^>]*>(.*?)</style\s*>", re.I | re.S)
_STYLE_ATTRIBUTE_RE = re.compile(r"\bstyle\s*=\s*([\"'])(.*?)\1", re.I | re.S)
_TRANSFORM_RE = re.compile(r"\btransform\s*:\s*([^;}{]+)", re.I)


class _TagScanner(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.tags: list[str] = []
        self.namespaced_attributes: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.tags.append(tag.lower())
        self.namespaced_attributes.extend(name.lower() for name, _ in attrs if ":" in name)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)


def compiler_capability_prompt_excerpt() -> str:
    supported = ", ".join(SUPPORTED_AUTHORING_FEATURES)
    rejected = ", ".join(sorted(REJECTED_TAGS))
    lossy = ", ".join(sorted(LOSSY_CSS_PROPERTIES))
    return (
        f"Use only native PPTX-compatible HTML/CSS: {supported}. "
        f"Rejected tags include: {rejected}. Inline SVG is unsupported. "
        f"Lossy CSS that must not carry semantics: {lossy}. "
        "The Sophia canvas is 1920x1080 CSS px with an opaque background."
    )


def unsupported_tags_in_html(source: str) -> list[str]:
    scanner = _TagScanner()
    try:
        scanner.feed(source or "")
    except Exception:
        return ["html_parse_error"]
    unsupported = {
        tag
        for tag in scanner.tags
        if tag in REJECTED_TAGS or tag not in SUPPORTED_TAGS
    }
    if any(name.startswith(("xlink:", "svg:")) for name in scanner.namespaced_attributes):
        unsupported.add("svg_namespace")
    return sorted(unsupported)


def rejected_css_in_html(source: str) -> list[str]:
    css = _css_text(source)
    properties = set(_properties(css))
    rejected = properties & REJECTED_CSS_PROPERTIES
    if re.search(r"\bposition\s*:\s*fixed\b", css, re.I):
        rejected.add("position-fixed")
    for match in _TRANSFORM_RE.finditer(css):
        value = match.group(1).strip().lower()
        if value != "none" and not re.fullmatch(r"rotate\(\s*-?[\d.]+(?:deg|rad|turn)\s*\)", value):
            rejected.add("transform")
    return sorted(rejected)


def lossy_css_in_html(source: str) -> list[str]:
    css = _css_text(source)
    return sorted(set(_properties(css)) & LOSSY_CSS_PROPERTIES)


def unsupported_css_in_html(source: str) -> list[str]:
    return sorted(set(rejected_css_in_html(source)) | set(lossy_css_in_html(source)))


def _css_text(source: str) -> str:
    blocks = _STYLE_BLOCK_RE.findall(source or "")
    attributes = [value for _, value in _STYLE_ATTRIBUTE_RE.findall(source or "")]
    return "\n".join([*blocks, *attributes])


def _properties(css: str) -> list[str]:
    return [match.group(1).strip().lower() for match in _STYLE_PROPERTY_RE.finditer(css)]
