"""BuilderBudgetMiddleware — deterministic cost/token circuit-breaker.

Proves the runaway-cost incident cannot recur regardless of model/loop: when
cumulative usage crosses a cap the middleware fires a terminal ``timed_out``
completion webhook + ends the run, and the pricing is cache-aware (no
double-counting of cache tokens, which langchain-anthropic folds into
``input_tokens``).
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from langchain_core.messages import AIMessage

from deerflow.agents.sophia_agent.middlewares import builder_budget as bb_mod
from deerflow.agents.sophia_agent.middlewares.builder_budget import (
    USER_BUDGET_COST_MESSAGE,
    USER_BUDGET_TIMEOUT_MESSAGE,
    BuilderBudgetMiddleware,
    _estimate_cost_usd,
    _price_for,
    _sum_usage,
)


def _ai(
    content: str = "",
    *,
    input_tokens: int = 0,
    output_tokens: int = 0,
    cache_read: int = 0,
    cache_creation: int = 0,
    tool_calls: list | None = None,
) -> AIMessage:
    return AIMessage(
        content=content,
        tool_calls=tool_calls or [],
        usage_metadata={
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "total_tokens": input_tokens + output_tokens,
            "input_token_details": {"cache_read": cache_read, "cache_creation": cache_creation},
        },
    )


def _runtime() -> SimpleNamespace:
    return SimpleNamespace(context={"thread_id": "t1"}, config={"configurable": {"thread_id": "t1"}})


def _capture_webhook(monkeypatch) -> list[dict]:
    calls: list[dict] = []
    monkeypatch.setattr(
        bb_mod,
        "fire_completion_webhook_from_artifact",
        lambda **kw: (calls.append(kw), True)[1],
    )
    return calls


# ─── pricing / accumulation ──────────────────────────────────────────────────


def test_pricing_does_not_double_count_cache_tokens():
    price = _price_for("claude-sonnet-4-6")  # {"in": 3.0, "out": 15.0}
    # All input is cache_read → uncached input is 0; only the 10% surcharge.
    totals = {"input": 1_000_000, "output": 0, "cache_read": 1_000_000, "cache_creation": 0}
    assert _estimate_cost_usd(totals, price) == pytest.approx(0.30)
    # Plain 1M in + 1M out, no cache.
    totals2 = {"input": 1_000_000, "output": 1_000_000, "cache_read": 0, "cache_creation": 0}
    assert _estimate_cost_usd(totals2, price) == pytest.approx(3.0 + 15.0)


def test_price_for_unknown_model_falls_back_to_sonnet():
    assert _price_for("some-future-model") == _price_for("claude-sonnet-4-6")
    assert _price_for(None) == {"in": 3.0, "out": 15.0}


def test_sum_usage_accumulates_across_ai_messages():
    msgs = [
        _ai(input_tokens=100, output_tokens=10, cache_read=40),
        AIMessage(content="no usage metadata"),  # contributes 0
        _ai(input_tokens=200, output_tokens=20, cache_creation=50),
    ]
    assert _sum_usage(msgs) == {"input": 300, "output": 30, "cache_read": 40, "cache_creation": 50}


# ─── enforcement ─────────────────────────────────────────────────────────────


def test_under_cap_is_noop(monkeypatch):
    calls = _capture_webhook(monkeypatch)
    mw = BuilderBudgetMiddleware()
    state = {
        "builder_budget": {"max_cost_usd": 5.0, "max_total_tokens": 2_000_000, "cost_model_key": "claude-sonnet-4-6"},
        "messages": [_ai(input_tokens=1000, output_tokens=100)],
    }
    assert mw.after_model(state, _runtime()) is None
    assert calls == []


def test_token_cap_trips_fires_timed_out_and_strips_tool_calls(monkeypatch):
    calls = _capture_webhook(monkeypatch)
    mw = BuilderBudgetMiddleware()
    last = _ai(
        content="still working",
        input_tokens=600,
        output_tokens=600,  # 1200 total >= 1000 cap
        tool_calls=[{"name": "write_file", "args": {}, "id": "x", "type": "tool_call"}],
    )
    state = {
        "builder_budget": {"max_cost_usd": 0.0, "max_total_tokens": 1000, "cost_model_key": "claude-sonnet-4-6"},
        "messages": [last],
    }
    out = mw.after_model(state, _runtime())
    assert out is not None
    assert out["jump_to"] == "end"
    # Deterministic stop: tool_calls stripped from the last AIMessage.
    assert out["messages"][0].tool_calls == []
    # Terminal webhook fired with a native terminal status + budget reason.
    assert len(calls) == 1
    assert calls[0]["status"] == "timed_out"
    assert calls[0]["artifact"]["budget_stop_reason"] == "token_limit"
    assert calls[0]["artifact"]["companion_summary"] == USER_BUDGET_TIMEOUT_MESSAGE
    assert "budget exceeded" in calls[0]["error_message"].lower()
    assert "tokens=1200>=1000" in calls[0]["error_message"]


def test_cost_cap_trips(monkeypatch):
    calls = _capture_webhook(monkeypatch)
    mw = BuilderBudgetMiddleware()
    # 2M output * $15/M = $30 >> $5 cap; token cap disabled.
    state = {
        "builder_budget": {"max_cost_usd": 5.0, "max_total_tokens": 0, "cost_model_key": "claude-sonnet-4-6"},
        "messages": [_ai(output_tokens=2_000_000)],
    }
    out = mw.after_model(state, _runtime())
    assert out is not None and out["jump_to"] == "end"
    assert calls[0]["status"] == "timed_out"
    assert calls[0]["artifact"]["budget_stop_reason"] == "cost_limit"
    assert calls[0]["artifact"]["companion_summary"] == USER_BUDGET_COST_MESSAGE
    assert "cost limit" in calls[0]["error_message"]
    assert "cost=$" in calls[0]["error_message"]
    assert "token limit" not in calls[0]["error_message"]


def test_caps_disabled_never_trips(monkeypatch):
    calls = _capture_webhook(monkeypatch)
    mw = BuilderBudgetMiddleware()
    state = {
        "builder_budget": {"max_cost_usd": 0.0, "max_total_tokens": 0},
        "messages": [_ai(input_tokens=9_000_000, output_tokens=9_000_000)],
    }
    assert mw.after_model(state, _runtime()) is None
    assert calls == []


def test_missing_budget_uses_module_default(monkeypatch):
    calls = _capture_webhook(monkeypatch)
    mw = BuilderBudgetMiddleware()
    # No builder_budget seeded → DEFAULT_BUILDER_BUDGET ($5.00) backstops the run.
    # 3M output * $15/M = $45 >> $5.
    state = {"messages": [_ai(output_tokens=3_000_000)]}
    out = mw.after_model(state, _runtime())
    assert out is not None and out["jump_to"] == "end"
    assert calls[0]["status"] == "timed_out"


def test_async_after_model_enforces_too(monkeypatch):
    calls = _capture_webhook(monkeypatch)
    mw = BuilderBudgetMiddleware()
    state = {
        "builder_budget": {"max_cost_usd": 5.0, "max_total_tokens": 0},
        "messages": [_ai(output_tokens=2_000_000)],
    }
    out = asyncio.run(mw.aafter_model(state, _runtime()))
    assert out is not None and out["jump_to"] == "end"
    assert calls[0]["status"] == "timed_out"


def test_image_generation_cost_counts_toward_cost_cap(monkeypatch):
    calls = _capture_webhook(monkeypatch)
    mw = BuilderBudgetMiddleware()
    # Token cost alone is tiny (~$0.0045); 10 tracked image calls add $0.70
    # and push the total over a $0.50 cap.
    state = {
        "builder_budget": {"max_cost_usd": 0.5, "max_total_tokens": 0, "cost_model_key": "claude-sonnet-4-6"},
        "messages": [_ai(input_tokens=1000, output_tokens=100)],
        "builder_pptx_diagnostics": {"image_generation_attempt_count": 10},
    }
    out = mw.after_model(state, _runtime())
    assert out is not None
    assert out["jump_to"] == "end"
    assert len(calls) == 1
    assert calls[0]["status"] == "timed_out"


def test_image_generation_cost_under_cap_is_noop(monkeypatch):
    calls = _capture_webhook(monkeypatch)
    mw = BuilderBudgetMiddleware()
    state = {
        "builder_budget": {"max_cost_usd": 5.0, "max_total_tokens": 0, "cost_model_key": "claude-sonnet-4-6"},
        "messages": [_ai(input_tokens=1000, output_tokens=100)],
        "builder_pptx_diagnostics": {"image_generation_attempt_count": 3},
    }
    assert mw.after_model(state, _runtime()) is None
    assert calls == []
