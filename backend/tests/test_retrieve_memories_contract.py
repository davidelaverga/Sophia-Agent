from __future__ import annotations

import json

from deerflow.sophia.tools.retrieve_memories_contract import (
    MAX_RETRIEVE_MEMORIES_QUERY_CHARS,
    MAX_RETRIEVE_MEMORIES_TEXT_CHARS,
    REALTIME_RETRIEVE_MEMORIES_LIMIT,
    RETRIEVE_MEMORIES_REALTIME_DESCRIPTION,
    RealtimeRetrieveMemoriesInput,
    redacted_retrieve_memories_diagnostic,
    retrieve_memories_for_realtime,
)


def test_empty_query_returns_invalid_query_without_search() -> None:
    calls: list[dict] = []

    def search_func(**kwargs):  # noqa: ANN202
        calls.append(kwargs)
        return []

    result = retrieve_memories_for_realtime(
        user_id="user-1",
        query="  null  ",
        search_func=search_func,
        provider_available_func=lambda: True,
    )

    assert result["ok"] is False
    assert result["status"] == "invalid_query"
    assert result["provider_reason"] == "empty_query"
    assert result["count"] == 0
    assert "Ask the user directly" in result["message"]
    assert "clearer memory question" in result["guidance"]
    assert calls == []


def test_realtime_tool_description_guides_memory_routing() -> None:
    description = RETRIEVE_MEMORIES_REALTIME_DESCRIPTION.lower()

    for expected in [
        "what do you remember about me",
        "do you remember what i use to stay calm when gaming",
        "do you remember my favorite childhood movie",
        "what did we talk about last time",
        "have i told you about",
        "what do you know about my thesis/project/work/workout",
        "later specific recall question is a new retrieval opportunity",
        "simple greetings",
        "what is my name",
        "preferred name is already in setup context",
        "facts already visible in the current conversation",
        "present-moment clarifying questions",
        "every turn",
        "only model-facing argument is query",
    ]:
        assert expected in description

    schema = RealtimeRetrieveMemoriesInput.model_json_schema()
    assert set(schema["properties"]) == {"query"}
    assert "user_id" not in schema["properties"]
    assert "categories" not in schema["properties"]


def test_query_is_sanitized_and_capped_before_search() -> None:
    calls: list[dict] = []
    long_query = "  " + ("pressure " * 80) + "  "

    def search_func(**kwargs):  # noqa: ANN202
        calls.append(kwargs)
        return [{"content": "Uses the phrase I'm in control.", "category": "preference"}]

    result = retrieve_memories_for_realtime(
        user_id="user-1",
        query=long_query,
        search_func=search_func,
        provider_available_func=lambda: True,
    )

    assert len(calls[0]["query"]) <= MAX_RETRIEVE_MEMORIES_QUERY_CHARS
    assert result["query"] == calls[0]["query"]
    assert result["diagnostics"]["query_was_truncated"] is True


def test_result_count_and_memory_text_are_capped() -> None:
    long_memory = "A" * (MAX_RETRIEVE_MEMORIES_TEXT_CHARS + 80)

    def search_func(**_kwargs):  # noqa: ANN202
        return [
            {"content": f"{long_memory} {index}", "category": "lesson", "score": 0.9}
            for index in range(10)
        ]

    result = retrieve_memories_for_realtime(
        user_id="user-1",
        query="gaming pressure cue",
        search_func=search_func,
        provider_available_func=lambda: True,
    )

    assert result["ok"] is True
    assert result["status"] == "success"
    assert result["count"] == REALTIME_RETRIEVE_MEMORIES_LIMIT
    assert len(result["memories"]) == REALTIME_RETRIEVE_MEMORIES_LIMIT
    assert all(len(memory["text"]) <= MAX_RETRIEVE_MEMORIES_TEXT_CHARS for memory in result["memories"])
    assert result["memories"][0]["text"].endswith("...")
    assert "matching fact appears in the returned memories" in result["guidance"]
    assert "Do not treat setup context" in result["guidance"]
    assert result["diagnostics"]["result_text_lengths"][0] <= MAX_RETRIEVE_MEMORIES_TEXT_CHARS


def test_no_results_response_is_model_friendly() -> None:
    result = retrieve_memories_for_realtime(
        user_id="user-1",
        query="favorite childhood movie",
        search_func=lambda **_kwargs: [],
        provider_available_func=lambda: True,
    )

    assert result["ok"] is True
    assert result["status"] == "no_results"
    assert result["provider_status"] == "available"
    assert result["provider_reason"] == "available"
    assert result["memories"] == []
    assert "No relevant stored memories" in result["message"]
    assert "Ask the user directly" in result["message"]
    assert "Do not pretend to remember" in result["guidance"]
    assert "label guesses as guesses" in result["guidance"]
    assert "current-session knowledge" in result["guidance"]


def test_unavailable_response_is_model_friendly_and_skips_search() -> None:
    calls: list[dict] = []

    def search_func(**kwargs):  # noqa: ANN202
        calls.append(kwargs)
        return [{"content": "Should not be called"}]

    result = retrieve_memories_for_realtime(
        user_id="user-1",
        query="what do you remember about me",
        search_func=search_func,
        provider_available_func=lambda: False,
    )

    assert result["ok"] is False
    assert result["status"] == "unavailable"
    assert result["provider_reason"] == "client_unavailable"
    assert result["memories"] == []
    assert "current conversation context" in result["message"]
    assert "cannot check stored memory" in result["guidance"]
    assert "memory does not exist" in result["guidance"]
    assert calls == []


def test_search_error_response_is_model_friendly() -> None:
    def search_func(**_kwargs):  # noqa: ANN202
        raise RuntimeError("provider exploded")

    result = retrieve_memories_for_realtime(
        user_id="user-1",
        query="what do you remember about me",
        search_func=search_func,
        provider_available_func=lambda: True,
    )

    assert result["ok"] is False
    assert result["status"] == "error"
    assert result["provider_reason"] == "provider_exception"
    assert result["count"] == 0
    assert "current conversation context" in result["message"]
    assert "failed right now" in result["guidance"]
    assert "Do not expose provider details" in result["guidance"]


def test_null_like_memory_values_are_ignored() -> None:
    def search_func(**_kwargs):  # noqa: ANN202
        return [
            {"content": None, "category": "fact"},
            {"content": "null", "category": "fact"},
            {"memory": "Uses a breathing cue before ranked games.", "category": "preference"},
        ]

    result = retrieve_memories_for_realtime(
        user_id="user-1",
        query="gaming calm cue",
        search_func=search_func,
        provider_available_func=lambda: True,
    )

    assert result["count"] == 1
    assert result["memories"][0]["text"] == "Uses a breathing cue before ranked games."


def test_internal_categories_are_usable_but_not_model_facing() -> None:
    schema = RealtimeRetrieveMemoriesInput.model_json_schema()
    assert set(schema["properties"]) == {"query"}
    assert "user_id" not in schema["properties"]
    assert "categories" not in schema["properties"]

    calls: list[dict] = []

    def search_func(**kwargs):  # noqa: ANN202
        calls.append(kwargs)
        return [{"content": "Prefers direct, concise reflection.", "category": "preference"}]

    result = retrieve_memories_for_realtime(
        user_id="trusted-user",
        query="communication preference",
        categories=["preference", "preference", "null"],
        search_func=search_func,
        provider_available_func=lambda: True,
    )

    assert calls[0]["user_id"] == "trusted-user"
    assert calls[0]["categories"] == ["preference"]
    assert result["diagnostics"]["internal_category_count"] == 1


def test_diagnostics_do_not_duplicate_raw_memory_text() -> None:
    secret_memory = "Secret cue phrase: silver anchor."

    result = retrieve_memories_for_realtime(
        user_id="user-1",
        query="private cue",
        search_func=lambda **_kwargs: [{"content": secret_memory, "category": "preference"}],
        provider_available_func=lambda: True,
    )

    assert result["memories"][0]["text"] == secret_memory
    assert secret_memory not in json.dumps(result["diagnostics"])


def test_success_diagnostics_include_safe_result_attribution() -> None:
    memory_text = "Luis said his favorite childhood movie is The Lord of the Rings."

    result = retrieve_memories_for_realtime(
        user_id="user-1",
        query="favorite childhood movie lord rings",
        search_func=lambda **_kwargs: [{"content": memory_text, "category": "preference", "score": 0.91}],
        provider_available_func=lambda: True,
    )

    diagnostics = result["diagnostics"]
    fingerprints = diagnostics["result_fingerprints"]

    assert result["status"] == "success"
    assert result["answer_hint"].startswith("The memories are ranked")
    assert diagnostics["has_results"] is True
    assert diagnostics["query_fingerprint"].startswith("sha256:")
    assert diagnostics["raw_query_excluded"] is True
    assert diagnostics["result_preview_included"] is False
    assert diagnostics["raw_memory_text_excluded"] is True
    assert diagnostics["any_result_exact_query_terms_present"] is True
    assert diagnostics["max_query_terms_matched_count"] == diagnostics["query_term_count"]
    assert fingerprints == [
        {
            "rank": 1,
            "text_fingerprint": fingerprints[0]["text_fingerprint"],
            "text_length": len(memory_text),
            "query_terms_matched_count": diagnostics["query_term_count"],
            "query_term_count": diagnostics["query_term_count"],
            "exact_query_terms_present": True,
            "category": "preference",
            "score": 0.91,
        }
    ]
    assert fingerprints[0]["text_fingerprint"].startswith("sha256:")
    assert memory_text not in json.dumps(diagnostics)
    assert "answer directly" in result["guidance"]


def test_redacted_diagnostics_keep_attribution_but_drop_raw_preview_fields() -> None:
    secret_memory = "Secret recall fact: blue comet."
    result = retrieve_memories_for_realtime(
        user_id="user-1",
        query="secret recall fact",
        search_func=lambda **_kwargs: [{"content": secret_memory, "category": "fact"}],
        provider_available_func=lambda: True,
    )
    result["diagnostics"]["raw_preview"] = secret_memory
    result["diagnostics"]["result_fingerprints"][0]["raw_preview"] = secret_memory

    redacted = redacted_retrieve_memories_diagnostic(result)
    serialized = json.dumps(redacted)

    assert redacted["has_results"] is True
    assert redacted["raw_memory_text_excluded"] is True
    assert redacted["raw_query_excluded"] is True
    assert redacted["diagnostics"]["result_fingerprints"][0]["text_fingerprint"].startswith("sha256:")
    assert "raw_preview" not in redacted["diagnostics"]["result_fingerprints"][0]
    assert "raw_preview" not in redacted["diagnostics"]
    assert secret_memory not in serialized


def test_provider_status_mapping_missing_config_returns_unavailable_reason() -> None:
    calls: list[dict] = []

    def search_func(**kwargs):  # noqa: ANN202
        calls.append(kwargs)
        return []

    result = retrieve_memories_for_realtime(
        user_id="user-1",
        query="what do you remember about me",
        search_func=search_func,
        provider_available_func=lambda: {
            "available": False,
            "provider_status": "unavailable",
            "provider_reason": "missing_api_key",
        },
    )

    assert result["ok"] is False
    assert result["status"] == "unavailable"
    assert result["provider_reason"] == "missing_api_key"
    assert result["diagnostics"]["provider_reason"] == "missing_api_key"
    assert calls == []


def test_diagnostic_search_no_matches_remains_no_results() -> None:
    result = retrieve_memories_for_realtime(
        user_id="user-1",
        query="thesis memory",
        search_func=lambda **_kwargs: {
            "memories": [],
            "provider_status": "available",
            "provider_reason": "rest_fallback",
            "provider_transport": "mem0_rest",
            "cache_status": "miss",
        },
        provider_available_func=lambda: {
            "available": True,
            "provider_status": "available",
            "provider_reason": "rest_fallback",
        },
    )

    assert result["ok"] is True
    assert result["status"] == "no_results"
    assert result["provider_reason"] == "rest_fallback"
    assert result["diagnostics"]["provider_transport"] == "mem0_rest"
    assert result["diagnostics"]["cache_status"] == "miss"


def test_search_unavailable_exception_keeps_unavailable_status() -> None:
    class MissingProvider(RuntimeError):
        reason = "missing_mem0_sdk"

    def search_func(**_kwargs):  # noqa: ANN202
        raise MissingProvider("missing mem0")

    result = retrieve_memories_for_realtime(
        user_id="user-1",
        query="what did we talk about last time",
        search_func=search_func,
        provider_available_func=lambda: {
            "available": True,
            "provider_status": "available",
            "provider_reason": "sdk_client",
        },
    )

    assert result["ok"] is False
    assert result["status"] == "unavailable"
    assert result["provider_reason"] == "missing_mem0_sdk"


def test_invalid_user_skips_search() -> None:
    calls: list[dict] = []

    def search_func(**kwargs):  # noqa: ANN202
        calls.append(kwargs)
        return []

    result = retrieve_memories_for_realtime(
        user_id="  ",
        query="what do you remember about me",
        search_func=search_func,
        provider_available_func=lambda: True,
    )

    assert result["ok"] is False
    assert result["status"] == "unavailable"
    assert result["provider_reason"] == "invalid_user"
    assert calls == []