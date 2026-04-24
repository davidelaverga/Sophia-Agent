"""share_builder_artifact tool.

Re-attaches the most recent builder deliverable for the current Sophia thread.
"""

from typing import Annotated, Any

from langchain.tools import InjectedToolCallId, ToolRuntime, tool
from langchain_core.messages import ToolMessage
from langgraph.types import Command
from langgraph.typing import ContextT
from pydantic import BaseModel

from deerflow.sophia.tools._tool_call_id import resolve_tool_call_id
from deerflow.sophia.tools.builder_delivery import build_builder_delivery_payload

TOOL_NAME = "share_builder_artifact"


class ShareBuilderArtifactInput(BaseModel):
    """Explicit empty schema so tool binding stays JSON-serializable."""

    pass


def _extract_thread_id(runtime: ToolRuntime[ContextT, dict[str, Any]] | None) -> str | None:
    if runtime is None:
        return None
    if runtime.context:
        thread_id = runtime.context.get("thread_id")
        if isinstance(thread_id, str) and thread_id:
            return thread_id
    if runtime.config:
        thread_id = runtime.config.get("configurable", {}).get("thread_id")
        if isinstance(thread_id, str) and thread_id:
            return thread_id
    return None


@tool(args_schema=ShareBuilderArtifactInput)
def share_builder_artifact(
    runtime: ToolRuntime[ContextT, dict[str, Any]] | None = None,
    tool_call_id: Annotated[str, InjectedToolCallId] = "",
) -> Command:
    """Re-attach a builder deliverable that was already produced in THIS chat.

    Only call this when the user asks you to RESEND, REATTACH, or SHARE AGAIN
    the most recent document Sophia already built in the current conversation.
    Do NOT call this in the same turn as `switch_to_builder` or right after a
    new builder run completes — `switch_to_builder` already attaches its own
    deliverable through `state["builder_delivery"]`.
    """

    resolved_tool_call_id = resolve_tool_call_id(
        runtime,
        tool_call_id,
        tool_name=TOOL_NAME,
    )

    state = runtime.state or {} if runtime is not None else {}
    builder_result = state.get("builder_result")
    if not isinstance(builder_result, dict):
        return Command(
            update={
                "messages": [
                    ToolMessage(
                        "There is no previous builder deliverable available to share in this chat.",
                        tool_call_id=resolved_tool_call_id,
                        name=TOOL_NAME,
                    )
                ]
            }
        )

    builder_delivery = build_builder_delivery_payload(
        thread_id=_extract_thread_id(runtime),
        builder_result=builder_result,
    )
    if builder_delivery is None:
        title = builder_result.get("artifact_title") or "the latest deliverable"
        return Command(
            update={
                "messages": [
                    ToolMessage(
                        f"{title} exists, but it could not be attached for delivery right now. Explain that clearly to the user.",
                        tool_call_id=resolved_tool_call_id,
                        name=TOOL_NAME,
                    )
                ]
            }
        )

    title = builder_result.get("artifact_title") or "the latest deliverable"
    return Command(
        update={
            "builder_delivery": builder_delivery,
            "messages": [
                ToolMessage(
                    f"{title} is attached for this reply. Briefly tell the user that you are sending it now.",
                    tool_call_id=resolved_tool_call_id,
                    name=TOOL_NAME,
                )
            ],
        }
    )
