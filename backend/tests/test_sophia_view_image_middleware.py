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


# ─── Codex P2 PR #132 (later iteration) — clear stale on failure ──


def test_sophia_subclass_skips_injection_when_viewed_images_empty() -> None:
    """Codex P2 on PR #132 (later iteration). When ``view_user_image``
    fails (filename not found, oversize, unsupported format), the tool
    clears ``viewed_images: {}`` via the ``merge_viewed_images``
    sentinel. The middleware MUST then skip injection — otherwise
    upstream's ``_create_image_details_message`` synthesizes a
    misleading "No images have been viewed." HumanMessage into the
    next turn.

    Without this skip, the cleared-on-failure state would still
    trigger an injection (upstream's ``_should_inject_image_message``
    only checks for tool calls + completion, not for image presence)
    and Sophia would see a confusing "no images" injection right
    after the error ToolMessage.
    """
    mw = SophiaViewImageMiddleware()

    # AIMessage has a view_user_image call, ToolMessage with the error
    # is present, viewed_images is EMPTY (tool-side fix cleared it).
    state = {
        "messages": [
            HumanMessage(content="describe nonexistent.png"),
            _ai_with_tool("view_user_image", tool_call_id="tc-fail"),
            ToolMessage(
                content="Error: image 'nonexistent.png' not found in this thread.",
                tool_call_id="tc-fail",
            ),
        ],
        "viewed_images": {},
    }

    update = mw.before_model(state, runtime=None)
    assert update is None, (
        "Empty viewed_images must NOT trigger the upstream 'No images "
        "have been viewed.' HumanMessage injection. Tool clears on "
        "failure; middleware must respect the cleared state."
    )


def test_sophia_subclass_skips_injection_when_viewed_images_absent_entirely() -> None:
    """The state-key-missing case (vs explicit empty dict). Defense
    in depth: even on first-ever turn with no view_user_image calls
    yet AND no viewed_images key in state, the middleware shouldn't
    inject anything.
    """
    mw = SophiaViewImageMiddleware()
    state = {
        "messages": [
            HumanMessage(content="describe nonexistent.png"),
            _ai_with_tool("view_user_image", tool_call_id="tc-fail"),
            ToolMessage(
                content="Error: image 'nonexistent.png' not found.",
                tool_call_id="tc-fail",
            ),
        ],
        # viewed_images key omitted entirely.
    }
    assert mw.before_model(state, runtime=None) is None


def test_view_user_image_failure_clears_viewed_images() -> None:
    """Tool-side regression: every failure path returns
    ``viewed_images: {}`` to clear the per-session image registry.
    Without this, a prior successful view would re-inject into the
    next turn — leaving Sophia answering about the wrong image.

    Asserts the failure Command's update dict contains the clear
    sentinel for each documented failure path.
    """
    from langchain_core.messages import ToolMessage as _ToolMessage

    from deerflow.sophia.tools.view_user_image import _failure_update

    update = _failure_update(_ToolMessage(content="anything", tool_call_id="tc-1"))
    assert update.get("viewed_images") == {}, (
        "_failure_update must include 'viewed_images': {} so the "
        "merge_viewed_images reducer wipes any prior successful load. "
        "Without it, SophiaViewImageMiddleware re-injects the stale "
        "image and Sophia answers about the wrong file."
    )
    # And the error ToolMessage is still surfaced.
    assert len(update.get("messages", [])) == 1


def test_full_round_trip_failure_then_next_turn_does_not_re_inject() -> None:
    """End-to-end: success turn loads image1, failure turn clears,
    middleware on the next opportunity skips injection. Pins the full
    pipeline contract (Codex P2 PR #132 later iteration).
    """
    mw = SophiaViewImageMiddleware()

    # Simulate state after a successful view_user_image(image1.png)
    # in turn 1, then a failed view_user_image(nonexistent.png) in
    # turn 2 that cleared viewed_images via _failure_update.
    state = {
        "messages": [
            HumanMessage(content="describe image1.png"),
            _ai_with_tool("view_user_image", tool_call_id="tc-success"),
            ToolMessage(content="Loaded image1.png", tool_call_id="tc-success"),
            # The middleware injected the image-details HumanMessage
            # in turn 1; mirror that here so the 'already-injected'
            # check is realistic.
            HumanMessage(content="Here are the images you've viewed: [image1]"),
            # AI response in turn 1 (no tool calls — just description).
            AIMessage(content="That's a sunset."),
            # Turn 2: user asks about nonexistent.
            HumanMessage(content="now describe nonexistent.png"),
            _ai_with_tool("view_user_image", tool_call_id="tc-fail"),
            ToolMessage(
                content="Error: image 'nonexistent.png' not found",
                tool_call_id="tc-fail",
            ),
        ],
        # Tool's _failure_update cleared the prior image1 entry.
        "viewed_images": {},
    }

    update = mw.before_model(state, runtime=None)
    assert update is None, (
        "After a failed view_user_image call clears viewed_images, "
        "the middleware must not re-inject the prior image. Otherwise "
        "Sophia sees image1 + 'describe nonexistent.png' and answers "
        "about the wrong file."
    )


# ─── Codex P2 PR #132 (latest iteration) — accumulation guard ──


def test_sophia_subclass_clears_viewed_images_after_injection() -> None:
    """The middleware must clear ``state["viewed_images"]`` after
    injecting the image-details HumanMessage, so subsequent
    ``view_user_image`` calls REPLACE the registry rather than
    accumulate base64.

    Without this clear, viewing multiple ~10 MiB images across a
    session would compound the per-request payload until it exceeds
    Anthropic's 32 MB envelope. The model also doesn't need stale
    images re-injected once they're already in conversation history
    (the just-injected HumanMessage carries the base64 blocks).
    """
    mw = SophiaViewImageMiddleware()
    state = {
        "messages": [
            HumanMessage(content="look at this"),
            _ai_with_tool("view_user_image", tool_call_id="tc-1"),
            ToolMessage(content="Loaded a.png", tool_call_id="tc-1"),
        ],
        "viewed_images": {
            "/mnt/user-data/uploads/a.png": {
                "base64": "aGVsbG8=",
                "mime_type": "image/png",
            },
        },
    }
    update = mw.before_model(state, runtime=None)
    assert update is not None
    # The HumanMessage with image blocks gets injected (the model
    # sees the image this turn via conversation history).
    assert len(update["messages"]) == 1
    # AND viewed_images is reset via the merge_viewed_images empty-
    # dict sentinel so the NEXT view_user_image call's update
    # replaces rather than accumulates.
    assert update.get("viewed_images") == {}, (
        "Middleware must clear viewed_images after injection so "
        "subsequent view_user_image calls don't compound base64 "
        "across turns. See merge_viewed_images reducer in "
        "thread_state.py."
    )


def test_sophia_subclass_does_not_emit_clear_when_no_injection() -> None:
    """When the middleware decides NOT to inject (e.g. viewed_images
    is empty, or no view_user_image tool call), it must NOT emit a
    ``viewed_images: {}`` clear. Returning ``None`` is the only
    correct outcome — otherwise a no-op call would still wipe state.
    """
    mw = SophiaViewImageMiddleware()
    # Case 1: viewed_images empty → returns None.
    state_empty = {
        "messages": [
            HumanMessage(content="hello"),
            _ai_with_tool("view_user_image", tool_call_id="tc-1"),
            ToolMessage(content="Error: not found", tool_call_id="tc-1"),
        ],
        "viewed_images": {},
    }
    assert mw.before_model(state_empty, runtime=None) is None
    # Case 2: no view-image tool call at all → returns None.
    state_no_tool = {
        "messages": [
            HumanMessage(content="hello"),
            AIMessage(content="just talking"),
        ],
        "viewed_images": {
            "/mnt/user-data/uploads/leftover.png": {
                "base64": "xxx",
                "mime_type": "image/png",
            },
        },
    }
    assert mw.before_model(state_no_tool, runtime=None) is None
