from __future__ import annotations

import json
from unittest.mock import patch

from langchain_core.messages import AIMessage, ToolMessage
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode
from test_deck_build_service import _creative_plan, _slides

from deerflow.sophia.tools.prepare_deck_build import prepare_deck_build


class _SuccessfulDeckResult:
    success = True
    retryable = False
    failure_code = None
    repair_instruction = None

    def to_dict(self) -> dict:
        return {
            "success": True,
            "build_id": "deck-runtime",
            "deck_build_path": "/mnt/user-data/outputs/deck_build/build.json",
            "pptx_path": "/mnt/user-data/outputs/deck.pptx",
            "slide_count": 3,
            "quality_status": "passed",
        }


def test_prepare_deck_build_runtime_is_injected_and_hidden_from_model_schema() -> None:
    assert prepare_deck_build._injected_args_keys == frozenset({"runtime"})
    schema = prepare_deck_build.args_schema.model_json_schema()
    assert "runtime" not in schema["properties"]
    assert "deck_stylesheet" in schema["required"]
    assert "authoring_contract" in schema["required"]
    assert schema["properties"]["authoring_contract"]["const"] == "compact_model_html_v2"
    slide_schema = schema["$defs"]["DeckSlideInput"]
    assert "html_body" in slide_schema["required"]
    assert "html_source" not in slide_schema["properties"]


def test_real_prepare_deck_build_executes_through_tool_node_with_runtime() -> None:
    tool_call = {
        "id": "prepare-runtime-1",
        "name": "prepare_deck_build",
        "args": {
            "deck_title": "Runtime Contract",
            "slides": _slides(),
            "output_path": "/mnt/user-data/outputs/deck.pptx",
            "creative_plan": _creative_plan(),
        },
    }
    node = ToolNode([prepare_deck_build])
    builder = StateGraph(MessagesState)
    builder.add_node("tools", node)
    builder.add_edge(START, "tools")
    builder.add_edge("tools", END)
    graph = builder.compile()
    with patch("deerflow.sophia.tools.prepare_deck_build.DeckBuildService") as service_type:
        service_type.return_value.prepare_and_build.return_value = _SuccessfulDeckResult()
        result = graph.invoke({"messages": [AIMessage(content="", tool_calls=[tool_call])]})

    message = result["messages"][-1]
    assert isinstance(message, ToolMessage)
    assert json.loads(message.content)["success"] is True
    call = service_type.return_value.prepare_and_build.call_args.kwargs
    assert call["runtime"] is not None
    assert call["deck_title"] == "Runtime Contract"
