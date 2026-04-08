from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Any

from langchain_core.language_models.fake_chat_models import FakeListChatModel
from langchain_core.runnables import Runnable
from langchain_core.tools import BaseTool


class ToolFriendlyFakeListChatModel(FakeListChatModel):
    """Development fake chat model that tolerates tool binding.

    DeerFlow's lead agent always calls ``bind_tools`` before invoking the model.
    LangChain's stock ``FakeListChatModel`` raises ``NotImplementedError`` there,
    which makes local smoke tests fail before the graph can complete a turn.
    For development-only configs, we can safely ignore the tool definitions and
    return the model itself as a runnable that emits the configured fake text.
    """

    def bind_tools(
        self,
        tools: Sequence[dict[str, Any] | type | Callable | BaseTool],
        *,
        tool_choice: str | None = None,
        **kwargs: Any,
    ) -> Runnable:
        del tools, tool_choice, kwargs
        return self