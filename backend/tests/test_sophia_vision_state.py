"""SophiaState must declare ``viewed_images`` with the upstream reducer.

Acceptance criterion #1 from the Sophia vision-port spec
(``docs/sophia_vision_port_builder_companion_spec.md`` §9): the state
field both agents share must use ``merge_viewed_images`` so parallel
``view_image_tool`` / ``view_user_image`` writes don't collide and the
``{}`` clear semantic works for downstream cleanup.

Locks the wiring in place so a future refactor that drops the field, or
swaps the reducer for ``LastValue``, fails the build.
"""

from __future__ import annotations

from typing import get_type_hints

from deerflow.agents.sophia_agent.state import SophiaState
from deerflow.agents.thread_state import ViewedImageData, merge_viewed_images


def test_sophia_state_has_viewed_images_field() -> None:
    hints = get_type_hints(SophiaState, include_extras=True)
    assert "viewed_images" in hints, (
        "SophiaState must declare a `viewed_images` field so the upstream "
        "view_image_tool / ViewImageMiddleware path works for both builder "
        "and companion (they share SophiaState as state_schema)."
    )


def test_viewed_images_uses_upstream_reducer() -> None:
    """LangGraph wires reducers via the Annotated metadata on the field type."""
    hints = get_type_hints(SophiaState, include_extras=True)
    annotated = hints["viewed_images"]
    metadata = getattr(annotated, "__metadata__", ())
    assert merge_viewed_images in metadata, (
        "viewed_images must be annotated with the upstream `merge_viewed_images` "
        "reducer so parallel writes merge correctly and `{}` clears the registry. "
        "Falling back to LastValue would corrupt state under concurrent tool calls."
    )


def test_viewed_image_data_shape_unchanged() -> None:
    """If upstream changes ViewedImageData, this catches the schema drift."""
    fields = getattr(ViewedImageData, "__annotations__", {})
    assert set(fields.keys()) == {"base64", "mime_type"}, (
        f"ViewedImageData shape changed upstream (got {sorted(fields)}). "
        "view_user_image and SophiaViewImageMiddleware encode/decode against "
        "this shape — review them before bumping deerflow."
    )
