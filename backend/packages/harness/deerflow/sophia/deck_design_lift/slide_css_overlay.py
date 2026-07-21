"""Exact-byte composition for authenticated slide CSS and DQ-2 overlays."""

COMPACT_V2_SLIDE_CSS_MAX_UTF8_BYTES = 1_024
SLIDE_CSS_REPAIR_OVERLAY_SEPARATOR = "\n\n"
SLIDE_CSS_REPAIR_OVERLAY_PROBE = ".__sophia_dq2_overlay_probe__{width:1px}"


def compose_authenticated_slide_css(
    *,
    baseline: str,
    overlay: str,
) -> str:
    """Return compiler input while preserving a nonempty baseline exactly."""

    if not baseline:
        return overlay
    prefix = baseline + SLIDE_CSS_REPAIR_OVERLAY_SEPARATOR
    if overlay.startswith(prefix):
        raise ValueError("slide CSS repair overlay is already composed")
    return prefix + overlay


def recover_authenticated_slide_css_overlay(
    *,
    baseline: str,
    composed: str,
) -> str:
    """Authenticate the exact baseline prefix and return only the repair overlay."""

    if not baseline:
        return composed
    prefix = baseline + SLIDE_CSS_REPAIR_OVERLAY_SEPARATOR
    if not composed.startswith(prefix):
        raise ValueError("compiled slide CSS does not preserve its authenticated prefix")
    return composed[len(prefix) :]


def repair_overlay_utf8_budget(*, baseline: str) -> int:
    """Return the remaining compact-v2 byte budget for an appended overlay."""

    if not baseline:
        return COMPACT_V2_SLIDE_CSS_MAX_UTF8_BYTES
    return (
        COMPACT_V2_SLIDE_CSS_MAX_UTF8_BYTES
        - len(baseline.encode("utf-8"))
        - len(SLIDE_CSS_REPAIR_OVERLAY_SEPARATOR.encode("utf-8"))
    )


__all__ = [
    "COMPACT_V2_SLIDE_CSS_MAX_UTF8_BYTES",
    "SLIDE_CSS_REPAIR_OVERLAY_PROBE",
    "SLIDE_CSS_REPAIR_OVERLAY_SEPARATOR",
    "compose_authenticated_slide_css",
    "recover_authenticated_slide_css_overlay",
    "repair_overlay_utf8_budget",
]
