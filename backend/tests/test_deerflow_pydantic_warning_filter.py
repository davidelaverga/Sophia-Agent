"""Regression test: deerflow package installs the Pydantic serializer warning filter.

The LangChain/LangGraph tool runtime emits
``PydanticSerializationUnexpectedValue`` on the ``context`` RunnableConfig
field every tool call. The gateway process silences it via
``app.gateway.app``. The LangGraph process must silence it via
``deerflow/__init__.py`` — this test locks the latter in place so a future
refactor cannot silently drop it and reintroduce log noise.
"""

from __future__ import annotations

import warnings


def test_deerflow_import_installs_pydantic_context_warning_filter():
    """Importing deerflow registers a filter for the noisy context warning."""
    import deerflow

    # Re-arm the filter inside pytest's per-test ``catch_warnings()`` window.
    # In the full suite, ``deerflow`` is typically already in ``sys.modules``
    # (some earlier test imported ``deerflow.agents.sophia_agent.agent``), so
    # the import-time side effect happened in a prior test's window and is no
    # longer visible. Calling the install function explicitly makes the
    # assertion deterministic regardless of import-cache state.
    deerflow._install_pydantic_context_warning_filter()

    matching = [
        entry
        for entry in warnings.filters
        if entry[0] == "ignore"
        and entry[1] is not None
        and "PydanticSerializationUnexpectedValue" in entry[1].pattern
        and "context" in entry[1].pattern
    ]
    assert matching, (
        "Expected deerflow/__init__.py to register an 'ignore' filter for "
        "PydanticSerializationUnexpectedValue on the context field. Found "
        f"{len(warnings.filters)} total filters, none matching."
    )


def test_pydantic_context_warning_is_suppressed_end_to_end():
    """Fire the warning shape LangGraph produces; confirm deerflow's filter eats it."""
    import deerflow  # noqa: F401

    with warnings.catch_warnings(record=True) as caught:
        warnings.resetwarnings()
        # Re-register the deerflow filter after reset (simulates the runtime
        # state on import order).
        warnings.filterwarnings(
            "ignore",
            message=r".*PydanticSerializationUnexpectedValue.*context.*",
            category=UserWarning,
        )
        warnings.warn(
            "PydanticSerializationUnexpectedValue(Expected `none` - "
            "serialized value may not be as expected [field_name='context', "
            "input_value={'thread_id': 'abc', 'sandbox_id': 'local'}, input_type=dict])",
            UserWarning,
            stacklevel=2,
        )
        # Unrelated Pydantic warning must still surface.
        warnings.warn(
            "PydanticSerializationUnexpectedValue(Expected `str` - something else)",
            UserWarning,
            stacklevel=2,
        )

    assert len(caught) == 1, (
        f"Expected 1 warning to pass the filter (the unrelated one); got {len(caught)}: "
        f"{[str(w.message) for w in caught]}"
    )
    assert "context" not in str(caught[0].message)
