"""SophiaViewImageMiddleware must recognize both view_image and view_user_image.

Upstream ``ViewImageMiddleware._has_view_image_tool`` hardcodes the check
to ``"view_image"`` only. The companion exposes ``view_user_image``, so
without the subclass the middleware would never fire on companion turns
and viewed images would never reach the model.

This test pins the subclass behaviour so a future refactor that "DRYs out
back to the upstream class" or renames the recognized set breaks the build.
"""

from __future__ import annotations

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from deerflow.agents.middlewares.view_image_middleware import ViewImageMiddleware
from deerflow.agents.sophia_agent.middlewares.view_image import SophiaViewImageMiddleware


def _ai_with_tool(name: str, tool_call_id: str = "tc-1") -> AIMessage:
    return AIMessage(
        content="",
        tool_calls=[{"id": tool_call_id, "name": name, "args": {}}],
    )


def test_sophia_subclass_recognizes_view_user_image() -> None:
    mw = SophiaViewImageMiddleware()
    assert mw._has_view_image_tool(_ai_with_tool("view_user_image")) is True


def test_sophia_subclass_recognizes_upstream_view_image() -> None:
    mw = SophiaViewImageMiddleware()
    assert mw._has_view_image_tool(_ai_with_tool("view_image")) is True


def test_sophia_subclass_ignores_unrelated_tools() -> None:
    mw = SophiaViewImageMiddleware()
    assert mw._has_view_image_tool(_ai_with_tool("retrieve_memories")) is False
    assert mw._has_view_image_tool(AIMessage(content="hi")) is False


def test_upstream_middleware_does_not_recognize_view_user_image() -> None:
    """The whole reason for the subclass: locks why we can't just use upstream."""
    mw = ViewImageMiddleware()
    assert mw._has_view_image_tool(_ai_with_tool("view_user_image")) is False
    assert mw._has_view_image_tool(_ai_with_tool("view_image")) is True


def test_sophia_subclass_injects_image_blocks_when_companion_tool_completed() -> None:
    """Full round-trip: AIMessage→ToolMessage→middleware injects image content."""
    mw = SophiaViewImageMiddleware()

    state = {
        "messages": [
            HumanMessage(content="look at this"),
            _ai_with_tool("view_user_image", tool_call_id="tc-1"),
            ToolMessage(content="Loaded test.png", tool_call_id="tc-1"),
        ],
        "viewed_images": {
            "/mnt/user-data/uploads/test.png": {
                "base64": "aGVsbG8=",
                "mime_type": "image/png",
            },
        },
    }

    update = mw.before_model(state, runtime=None)
    assert update is not None, (
        "When view_user_image has completed and viewed_images has content, "
        "the middleware must inject a HumanMessage with image blocks."
    )

    injected = update["messages"][0]
    assert isinstance(injected, HumanMessage)
    content = injected.content
    # Content is a list of mixed blocks (text + image_url) per upstream.
    image_blocks = [b for b in content if isinstance(b, dict) and b.get("type") == "image_url"]
    assert len(image_blocks) == 1
    assert image_blocks[0]["image_url"]["url"].startswith("data:image/png;base64,")
