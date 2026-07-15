from __future__ import annotations

import json
from unittest.mock import patch

import pytest
from langchain_core.messages import AIMessage, ToolMessage
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode
from pydantic import ValidationError
from test_deck_build_service import _creative_plan, _slides

from deerflow.sophia.deck_build.tool_contract import PrepareDeckBuildInput
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
    assert "register" in prepare_deck_build.args
    assert "deck_register" not in prepare_deck_build.args


def test_compact_v2_requires_object_creative_plan_but_v1_keeps_legacy_string() -> None:
    slides = [
        {
            "title": "Runtime Contract",
            "narrative": "The runtime has one bounded repair.",
            "html_body": '<main class="slide-root" data-deck-id="slide-1"></main>',
        }
    ]
    common = {
        "deck_title": "Runtime Contract",
        "slides": slides,
        "output_path": "/mnt/user-data/outputs/deck.pptx",
        "deck_stylesheet": ".slide-root { width: 1920px; height: 1080px; background: #101820; }",
        "creative_plan": json.dumps(_creative_plan()),
    }

    with pytest.raises(ValidationError) as exc_info:
        PrepareDeckBuildInput.model_validate(
            {**common, "authoring_contract": "compact_model_html_v2"}
        )

    assert exc_info.value.errors()[0]["loc"] == ("creative_plan",)
    assert "must be a JSON object" in exc_info.value.errors()[0]["msg"]
    legacy = PrepareDeckBuildInput.model_validate(
        {**common, "authoring_contract": "compact_model_html_v1"}
    )
    assert legacy.creative_plan.subject == "Technical Deck"


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


def test_real_prepare_deck_build_normalizes_production_shaped_wrapped_slides_through_tool_node() -> None:
    production_body_sizes = [1334, 3802, 2243, 3089, 2912]
    slides = []
    for index, body_size in enumerate(production_body_sizes, start=1):
        slide = dict(_slides()[0])
        slide.pop("html_source")
        slide["title"] = f"Production slide {index}"
        slide["html_body"] = "x" * body_size
        slides.append(slide)
    tool_call = {
        "id": "prepare-runtime-wrapped",
        "name": "prepare_deck_build",
        "args": {
            "deck_title": "Wrapped Runtime Contract",
            "slides": '<parameter name="_arr">\n' + json.dumps(slides),
            "output_path": "/mnt/user-data/outputs/deck.pptx",
            "creative_plan": _creative_plan(),
            "authoring_contract": "compact_model_html_v2",
            "deck_stylesheet": ".slide-root { width: 1920px; height: 1080px; background: #101820; }",
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
    assert len(call["slides"]) == 5
    assert [len(slide["html_body"].encode("utf-8")) for slide in call["slides"]] == production_body_sizes
