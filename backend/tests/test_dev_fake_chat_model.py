from __future__ import annotations

from langchain_core.messages import HumanMessage

from deerflow.models.dev_fake import ToolFriendlyFakeListChatModel


def test_tool_friendly_fake_chat_model_ignores_tool_binding_and_still_invokes() -> None:
    model = ToolFriendlyFakeListChatModel(
        model="local-dev-fake",
        responses=["Local development model response."],
    )

    bound = model.bind_tools([])
    response = bound.invoke([HumanMessage(content="hello")])

    assert bound is model
    assert response.content == "Local development model response."