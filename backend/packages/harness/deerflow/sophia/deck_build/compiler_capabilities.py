"""Authoritative model-facing capability contract for native deck HTML."""

from __future__ import annotations

import re
from html.parser import HTMLParser
from typing import NamedTuple

import tinycss2

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

_STYLE_BLOCK_RE = re.compile(r"<style\b[^>]*>(.*?)</style\s*>", re.I | re.S)
_STYLE_ATTRIBUTE_RE = re.compile(r"\bstyle\s*=\s*([\"'])(.*?)\1", re.I | re.S)


class _CssDeclaration(NamedTuple):
    name: str
    value: str


class _TagScanner(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.tags: list[str] = []
        self.namespaced_attributes: list[str] = []
        self.active_meta_directive = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        clean_tag = tag.lower()
        self.tags.append(clean_tag)
        self.namespaced_attributes.extend(name.lower() for name, _ in attrs if ":" in name)
        if clean_tag == "meta" and not meta_attributes_are_inert(dict(attrs)):
            self.active_meta_directive = True

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)


def compiler_capability_prompt_excerpt() -> str:
    supported = ", ".join(SUPPORTED_AUTHORING_FEATURES)
    rejected = ", ".join(sorted(REJECTED_TAGS))
    rejected_css = ", ".join(sorted(REJECTED_CSS_PROPERTIES))
    lossy = ", ".join(sorted(LOSSY_CSS_PROPERTIES))
    return (
        f"Use only native PPTX-compatible HTML/CSS: {supported}. "
        f"Rejected tags include: {rejected}. Inline SVG is unsupported. Meta tags may declare UTF-8 charset only. "
        f"Do not use rejected CSS properties: {rejected_css}. Do not use lossy CSS properties: {lossy}. "
        "For transform, rotate(...) is the only supported operation; do not translate, scale, or skew. "
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
    if scanner.active_meta_directive:
        unsupported.add("meta-directive")
    return sorted(unsupported)


def meta_attributes_are_inert(attrs: dict[str, str | None]) -> bool:
    normalized = {str(name).strip().lower(): str(value or "").strip().lower() for name, value in attrs.items()}
    return set(normalized) == {"charset"} and normalized["charset"] in {"utf-8", "utf8"}


def rejected_css_in_html(source: str) -> list[str]:
    declarations = _css_declarations(source)
    properties = {declaration.name for declaration in declarations}
    rejected = properties & REJECTED_CSS_PROPERTIES
    if any(
        declaration.name == "position" and declaration.value.strip().lower() == "fixed"
        for declaration in declarations
    ):
        rejected.add("position-fixed")
    for declaration in declarations:
        if declaration.name != "transform":
            continue
        value = declaration.value.strip().lower()
        if value != "none" and not re.fullmatch(r"rotate\(\s*-?[\d.]+(?:deg|rad|turn)\s*\)", value):
            rejected.add("transform")
    return sorted(rejected)


def lossy_css_in_html(source: str) -> list[str]:
    return sorted({declaration.name for declaration in _css_declarations(source)} & LOSSY_CSS_PROPERTIES)


def unsupported_css_in_html(source: str) -> list[str]:
    return rejected_css_in_html(source)


def _css_declarations(source: str) -> list[_CssDeclaration]:
    declarations: list[_CssDeclaration] = []
    for block in _STYLE_BLOCK_RE.findall(source or ""):
        rules = tinycss2.parse_stylesheet(block, skip_comments=True, skip_whitespace=True)
        declarations.extend(_parse_rule_declarations(rules))
    for _quote, attribute in _STYLE_ATTRIBUTE_RE.findall(source or ""):
        declarations.extend(
            _parse_declaration_tokens(
                tinycss2.parse_component_value_list(attribute),
            )
        )
    return declarations


def _parse_rule_declarations(rules: list[object]) -> list[_CssDeclaration]:
    declarations: list[_CssDeclaration] = []
    for rule in rules:
        content = getattr(rule, "content", None)
        if content is None:
            continue
        rule_type = getattr(rule, "type", None)
        if rule_type == "qualified-rule":
            declarations.extend(_parse_declaration_tokens(content))
            continue
        if rule_type != "at-rule":
            continue

        # Grouping at-rules such as @media, @supports, and @layer contain
        # nested rules. Declaration-bearing at-rules such as @page and
        # @font-face are also inspected to preserve the previous behavior.
        declarations.extend(_parse_declaration_tokens(content))
        nested_rules = tinycss2.parse_rule_list(content, skip_comments=True, skip_whitespace=True)
        declarations.extend(_parse_rule_declarations(nested_rules))
    return declarations


def _parse_declaration_tokens(tokens: list[object]) -> list[_CssDeclaration]:
    parsed = tinycss2.parse_declaration_list(tokens, skip_comments=True, skip_whitespace=True)
    return [
        _CssDeclaration(
            name=str(item.lower_name),
            value=tinycss2.serialize(item.value).strip(),
        )
        for item in parsed
        if getattr(item, "type", None) == "declaration"
    ]
