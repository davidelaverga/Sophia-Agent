import hashlib
import re
from dataclasses import dataclass
from html import escape
from pathlib import PurePosixPath
from typing import Any


@dataclass(frozen=True)
class HtmlQuickPatchResult:
    ok: bool
    result: str
    html: str | None = None
    fallback_reason: str | None = None
    safe_summary: str | None = None


_TITLE_KIND = "title"
_SUBTITLE_KIND = "subtitle"
_BUTTON_KIND = "button_text"
_PARAGRAPH_KIND = "paragraph"
_CARDS_DARKER_KIND = "cards_darker"
_CARD_COLOR_KIND = "card_color"
_ACCENT_COLOR_KIND = "accent_color"

_SUPPORTED_KINDS = {
    _TITLE_KIND,
    _SUBTITLE_KIND,
    _BUTTON_KIND,
    _PARAGRAPH_KIND,
    _CARDS_DARKER_KIND,
    _CARD_COLOR_KIND,
    _ACCENT_COLOR_KIND,
}

_SAFE_COLOR_NAMES = {
    "black": "#111827",
    "white": "#f8fafc",
    "slate": "#1f2937",
    "gray": "#374151",
    "grey": "#374151",
    "zinc": "#27272a",
    "neutral": "#262626",
    "stone": "#292524",
    "red": "#991b1b",
    "orange": "#9a3412",
    "amber": "#92400e",
    "yellow": "#854d0e",
    "lime": "#3f6212",
    "green": "#166534",
    "emerald": "#047857",
    "teal": "#0f766e",
    "cyan": "#0e7490",
    "sky": "#0369a1",
    "blue": "#1d4ed8",
    "indigo": "#4338ca",
    "violet": "#6d28d9",
    "purple": "#7e22ce",
    "fuchsia": "#a21caf",
    "pink": "#be185d",
    "rose": "#be123c",
}


def apply_html_quick_patch(
    html: str,
    *,
    quick_edit_kind: str,
    target_fields: dict[str, Any] | None = None,
) -> HtmlQuickPatchResult:
    if quick_edit_kind not in _SUPPORTED_KINDS:
        return _unsupported("unsupported_quick_edit_kind")
    if not _looks_like_html(html):
        return _unsupported("source_not_html")

    fields = target_fields or {}
    if quick_edit_kind == _TITLE_KIND:
        patched = _patch_title(html, _field_text(fields, "titleText"))
    elif quick_edit_kind == _SUBTITLE_KIND:
        patched = _patch_subtitle(html, _field_text(fields, "subtitleText"))
    elif quick_edit_kind == _BUTTON_KIND:
        patched = _patch_button_text(html, _field_text(fields, "buttonText"))
    elif quick_edit_kind == _PARAGRAPH_KIND:
        patched = _patch_paragraph(html, _field_text(fields, "paragraphText"))
    elif quick_edit_kind == _CARDS_DARKER_KIND:
        patched = _patch_cards_darker(html)
    elif quick_edit_kind == _CARD_COLOR_KIND:
        patched = _patch_card_color(html, _field_text(fields, "colorValue"))
    else:
        patched = _patch_accent_color(html, _field_text(fields, "colorValue"))

    if not patched.ok or patched.html is None:
        return patched
    if patched.html == html:
        return _unsupported("quick_patch_no_change")
    if not _valid_enough_html(patched.html):
        return HtmlQuickPatchResult(
            ok=False,
            result="failed",
            fallback_reason="quick_patch_invalid_html",
            safe_summary="Quick patch was not saved because HTML validation failed.",
        )
    return patched


def revision_artifact_path(source_artifact_path: str, content: str, request: str) -> str:
    normalized = source_artifact_path.strip().replace("\\", "/").lstrip("/")
    pure = PurePosixPath(normalized)
    suffix = pure.suffix or ".html"
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", pure.stem).strip("-._") or "artifact"
    digest = hashlib.sha256(
        f"{normalized}\n{request}\n{hashlib.sha256(content.encode()).hexdigest()}".encode(),
    ).hexdigest()[:8]
    revision_name = f"{stem}-quick-{digest}{suffix}"
    parent = pure.parent.as_posix()
    if parent in {"", "."}:
        return revision_name
    return f"{parent}/{revision_name}"


def stable_path_hash(path: str | None) -> str | None:
    if not path:
        return None
    normalized = path.strip().replace("\\", "/").lstrip("/")
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]


def content_hash(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def _patch_title(html: str, title_text: str | None) -> HtmlQuickPatchResult:
    if not title_text:
        return _unsupported("missing_title_text")
    patched = html
    title_replaced = False
    heading_replaced = False
    patched, title_replaced = _replace_first_tag_text(patched, "title", title_text)
    patched, heading_replaced = _replace_first_tag_text(patched, "h1", title_text)
    if not title_replaced and not heading_replaced:
        return _unsupported("title_target_not_found")
    return _patched(patched, "Updated HTML title and primary heading.")


def _patch_subtitle(html: str, subtitle_text: str | None) -> HtmlQuickPatchResult:
    if not subtitle_text:
        return _unsupported("missing_subtitle_text")
    patched, replaced = _replace_first_classed_tag_text(
        html,
        r"(?:subtitle|subheading|subhead|tagline|dek|lead)",
        subtitle_text,
    )
    if not replaced:
        patched, replaced = _replace_first_tag_text(html, "h2", subtitle_text)
    if not replaced:
        return _unsupported("subtitle_target_not_found")
    return _patched(patched, "Updated HTML subtitle text.")


def _patch_button_text(html: str, button_text: str | None) -> HtmlQuickPatchResult:
    if not button_text:
        return _unsupported("missing_button_text")
    patched, replaced = _replace_first_classed_tag_text(html, r"(?:cta|button|btn)", button_text)
    if not replaced:
        patched, replaced = _replace_first_tag_text(html, "button", button_text)
    if not replaced:
        patched, replaced = _replace_first_tag_text(html, "a", button_text)
    if not replaced:
        return _unsupported("button_target_not_found")
    return _patched(patched, "Updated HTML button text.")


def _patch_paragraph(html: str, paragraph_text: str | None) -> HtmlQuickPatchResult:
    if not paragraph_text:
        return _unsupported("missing_paragraph_text")
    patched, replaced = _replace_first_classed_tag_text(
        html,
        r"(?:intro|lead|summary|description|paragraph)",
        paragraph_text,
    )
    if replaced:
        return _patched(patched, "Updated HTML paragraph text.")

    h1_pattern = re.compile(r"(<h1\b[^>]*>.*?</h1>)", re.IGNORECASE | re.DOTALL)
    if not h1_pattern.search(html):
        return _unsupported("paragraph_target_not_found")
    paragraph = f"<p>{escape(paragraph_text, quote=False)}</p>"
    patched = h1_pattern.sub(lambda match: f"{match.group(1)}\n{paragraph}", html, count=1)
    return _patched(patched, "Added short HTML paragraph.")


def _patch_cards_darker(html: str) -> HtmlQuickPatchResult:
    patched, count = _replace_card_variables(html, {
        "--card-bg": "#151821",
        "--card-background": "#151821",
        "--card-surface": "#151821",
        "--card-border": "#2b3446",
    })
    if count > 0:
        return _patched(patched, "Darkened HTML card CSS variables.")

    patched, count = _update_card_css_blocks(
        html,
        {
            "background": "#151821",
            "border-color": "#2b3446",
            "box-shadow": "0 18px 48px rgba(0, 0, 0, 0.32)",
        },
    )
    if count == 0:
        return _unsupported("card_css_target_not_found")
    return _patched(patched, "Darkened HTML card styling.")


def _patch_card_color(html: str, color_value: str | None) -> HtmlQuickPatchResult:
    color = _safe_color(color_value)
    if not color:
        return _unsupported("missing_or_unsafe_card_color")
    patched, count = _replace_card_variables(html, {
        "--card-bg": color,
        "--card-background": color,
        "--card-surface": color,
    })
    if count > 0:
        return _patched(patched, "Updated HTML card color variables.")
    patched, count = _update_card_css_blocks(html, {"background": color})
    if count == 0:
        return _unsupported("card_css_target_not_found")
    return _patched(patched, "Updated HTML card color.")


def _patch_accent_color(html: str, color_value: str | None) -> HtmlQuickPatchResult:
    color = _safe_color(color_value)
    if not color:
        return _unsupported("missing_or_unsafe_accent_color")
    patched, count = _replace_css_variables(html, {
        "--accent": color,
        "--accent-color": color,
        "--primary": color,
        "--primary-color": color,
    })
    if count == 0:
        return _unsupported("accent_css_target_not_found")
    return _patched(patched, "Updated HTML accent color variables.")


def _replace_first_tag_text(html: str, tag: str, text: str) -> tuple[str, bool]:
    pattern = re.compile(rf"(<{tag}\b[^>]*>)(.*?)(</{tag}>)", re.IGNORECASE | re.DOTALL)
    if not pattern.search(html):
        return html, False
    escaped = escape(text, quote=False)
    return pattern.sub(lambda match: f"{match.group(1)}{escaped}{match.group(3)}", html, count=1), True


def _replace_first_classed_tag_text(html: str, class_pattern: str, text: str) -> tuple[str, bool]:
    pattern = re.compile(
        rf"(<(?:p|h1|h2|h3|a|button|span|div)\b[^>]*class=[\"'][^\"']*{class_pattern}[^\"']*[\"'][^>]*>)(.*?)(</(?:p|h1|h2|h3|a|button|span|div)>)",
        re.IGNORECASE | re.DOTALL,
    )
    if not pattern.search(html):
        return html, False
    escaped = escape(text, quote=False)
    return pattern.sub(lambda match: f"{match.group(1)}{escaped}{match.group(3)}", html, count=1), True


def _replace_card_variables(html: str, replacements: dict[str, str]) -> tuple[str, int]:
    card_replacements = {
        key: value
        for key, value in replacements.items()
        if "card" in key
    }
    return _replace_css_variables(html, card_replacements)


def _replace_css_variables(html: str, replacements: dict[str, str]) -> tuple[str, int]:
    patched = html
    count = 0
    for name, value in replacements.items():
        pattern = re.compile(rf"({re.escape(name)}\s*:\s*)[^;}}]+", re.IGNORECASE)
        patched, changed = pattern.subn(rf"\g<1>{value}", patched)
        count += changed
    return patched, count


def _update_card_css_blocks(html: str, properties: dict[str, str]) -> tuple[str, int]:
    pattern = re.compile(
        r"(?P<selector>[^{}]*\.[A-Za-z0-9_-]*card[A-Za-z0-9_-]*[^{}]*)\{(?P<body>[^{}]*)\}",
        re.IGNORECASE | re.DOTALL,
    )

    def replace(match: re.Match[str]) -> str:
        body = match.group("body")
        for name, value in properties.items():
            body = _upsert_css_property(body, name, value)
        return f"{match.group('selector')}{{{body}}}"

    return pattern.subn(replace, html, count=1)


def _upsert_css_property(body: str, name: str, value: str) -> str:
    pattern = re.compile(rf"({re.escape(name)}\s*:\s*)[^;]+;?", re.IGNORECASE)
    if pattern.search(body):
        return pattern.sub(rf"\g<1>{value};", body, count=1)
    separator = "\n  " if "\n" in body else " "
    suffix = "" if body.rstrip().endswith(";") or not body.strip() else ";"
    return f"{body.rstrip()}{suffix}{separator}{name}: {value};"


def _safe_color(value: str | None) -> str | None:
    if not value:
        return None
    normalized = value.strip().lower()
    if re.fullmatch(r"#[0-9a-f]{3}(?:[0-9a-f]{3})?(?:[0-9a-f]{2})?", normalized):
        return normalized
    return _SAFE_COLOR_NAMES.get(normalized)


def _field_text(fields: dict[str, Any], key: str) -> str | None:
    value = fields.get(key)
    if not isinstance(value, str):
        return None
    normalized = re.sub(r"\s+", " ", value).strip()
    if not normalized or len(normalized) > 240:
        return None
    return normalized


def _looks_like_html(value: str) -> bool:
    return bool(re.search(r"<(?:!doctype\s+html|html\b|body\b|main\b|section\b|div\b|h1\b)", value, re.IGNORECASE))


def _valid_enough_html(value: str) -> bool:
    has_document = bool(re.search(r"<html\b", value, re.IGNORECASE) and re.search(r"<body\b", value, re.IGNORECASE))
    has_tags = bool(re.search(r"</(?:html|body|main|section|div|h1|p|style|title)>", value, re.IGNORECASE))
    return has_document or has_tags


def _patched(html: str, safe_summary: str) -> HtmlQuickPatchResult:
    return HtmlQuickPatchResult(ok=True, result="patched", html=html, safe_summary=safe_summary)


def _unsupported(reason: str) -> HtmlQuickPatchResult:
    return HtmlQuickPatchResult(ok=False, result="unsupported", fallback_reason=reason)
