from typing import Annotated, NotRequired

from langchain.agents import AgentState

from deerflow.agents.thread_state import ViewedImageData, merge_viewed_images


def merge_async_tasks(
    existing: dict[str, dict] | None,
    update: dict[str, dict] | None,
) -> dict[str, dict]:
    """Merge async task metadata by task_id.

    Deep Agents v0.5 stores async subagent task IDs in a dedicated state
    channel so they survive message compaction. The channel must merge updates
    instead of replacing the whole mapping when a new task is launched.
    """
    merged = dict(existing or {})
    if update:
        merged.update(update)
    return merged


def _merge_builder_web_budget(
    current: dict | None, update: dict | None
) -> dict:
    """Reducer for ``builder_web_budget``.

    Two key/value classes are mixed in this dict and require different merge
    semantics:

    - ``*_calls`` keys are SUMMED (delta semantics). The guarded builder web
      tools (``builder_web_search``, ``builder_web_fetch``) write **deltas**
      via ``Command.update={"builder_web_budget": {"<key>_calls": 1}}`` —
      each tool call contributes its own +1, and LangGraph applies parallel
      updates sequentially through this reducer so concurrent bursts add up
      correctly. The earlier ``max`` reducer collapsed concurrent
      increments (two parallel tools both reading 5 and writing 6 yielded
      ``max(6, 6) = 6``, losing one increment), which under-reported usage
      and let requests exceed the per-task budget. Codex bot review on
      PR #81 surfaced this; the fix moves to delta+sum semantics together
      with the ``_budget_guard`` change in
      ``backend/packages/harness/deerflow/sophia/tools/builder_web_search.py``.

    - All other keys (notably ``*_limit``) use LAST-WINS. They are static
      config seeded once by ``BuilderResearchPolicyMiddleware`` from
      ``make_builder_web_budget(task_type)`` and never mutated by the
      tools.

    Sum is associative and order-independent, so LangGraph's sequential
    application of concurrent updates is safe regardless of dispatch order.

    Caller contract: tools MUST write only the keys they intend to mutate,
    not the whole budget dict. The reducer preserves any unmodified keys
    from the current state. Writing the whole dict (the OLD pattern that
    used absolute counter values) would over-count under sum semantics —
    the schema-invariant test guards against re-introducing that pattern.
    """
    if current is None and update is None:
        return {}
    if current is None:
        return dict(update or {})
    if update is None:
        return dict(current)

    merged = dict(current)
    for key, value in update.items():
        if (
            isinstance(key, str)
            and key.endswith("_calls")
            and isinstance(value, int)
            and isinstance(merged.get(key), int)
        ):
            merged[key] = merged[key] + value
        else:
            merged[key] = value
    return merged


def _union_string_list(
    current: list[str] | None, update: list[str] | None
) -> list[str]:
    """Reducer for list-of-string state fields written by parallel tool calls.

    Preserves insertion order, deduplicates. Same rationale as
    ``_merge_builder_web_budget``: concurrent tool writes must merge instead
    of colliding. Because each tool already read-merge-writes the full list,
    this reducer is a no-op in the single-writer case.
    """
    seen: dict[str, None] = {}
    for value in current or []:
        if isinstance(value, str):
            seen[value] = None
    for value in update or []:
        if isinstance(value, str):
            seen[value] = None
    return list(seen)


def _merge_search_sources(
    current: list[dict] | None, update: list[dict] | None
) -> list[dict]:
    """Reducer for ``builder_search_sources`` (list of dicts keyed by url).

    Multiple parallel ``builder_web_search`` / ``builder_web_fetch`` tool
    calls can emit source records in the same super-step. Merge by ``url``
    and let the latest write win for any overlapping record.
    """
    merged: dict[str, dict] = {}
    for source in current or []:
        if isinstance(source, dict) and source.get("url"):
            merged[str(source["url"])] = dict(source)
    for source in update or []:
        if isinstance(source, dict) and source.get("url"):
            merged[str(source["url"])] = dict(source)
    return list(merged.values())


def _merge_builder_write_diagnostics(
    current: dict | None, update: dict | None
) -> dict:
    """Reducer for safe builder write diagnostics.

    Write tools may run in parallel, so count fields are deltas and all
    non-count fields use last-wins metadata from the latest applied update.
    """
    if current is None and update is None:
        return {}
    if current is None:
        return dict(update or {})
    if update is None:
        return dict(current)

    merged = dict(current)
    for key, value in update.items():
        _merge_builder_write_diagnostic_value(merged, key, value)
    return merged


def _merge_builder_write_diagnostic_value(
    merged: dict, key: str, value: object
) -> None:
    if key in {"success_count", "error_count"} and isinstance(value, int):
        merged[key] = int(merged.get(key, 0) or 0) + value
        return
    if key in {"successful_output_paths", "successful_deliverable_output_paths"} and isinstance(value, list):
        merged[key] = _merge_string_list(merged.get(key), value)
        return
    merged[key] = value


def _merge_builder_pptx_diagnostics(
    current: dict | None, update: dict | None
) -> dict:
    """Reducer for safe PPTX/image-generation diagnostics."""
    if current is None and update is None:
        return {}
    if current is None:
        return dict(update or {})
    if update is None:
        return dict(current)

    merged = dict(current)
    for key, value in update.items():
        if key.endswith("_count") and isinstance(value, int):
            merged[key] = int(merged.get(key, 0) or 0) + value
            continue
        if key in {"image_output_paths", "pptx_output_paths"} and isinstance(value, list):
            merged[key] = _merge_string_list(merged.get(key), value)
            continue
        if key.endswith("_bytes_total") and isinstance(value, int):
            merged[key] = int(merged.get(key, 0) or 0) + value
            continue
        merged[key] = value
    return merged


def _merge_builder_visual_diagnostics(
    current: dict | None, update: dict | None
) -> dict:
    """Reducer for safe visual-design / visual-asset diagnostics."""
    if current is None and update is None:
        return {}
    if current is None:
        return dict(update or {})
    if update is None:
        return dict(current)

    merged = dict(current)
    for key, value in update.items():
        if key.endswith("_count") and isinstance(value, int):
            merged[key] = int(merged.get(key, 0) or 0) + value
            continue
        if key in {"visual_asset_paths", "visual_svg_paths", "visual_png_paths"} and isinstance(value, list):
            merged[key] = _merge_string_list(merged.get(key), value)
            continue
        if key.endswith("_bytes_total") and isinstance(value, int):
            merged[key] = int(merged.get(key, 0) or 0) + value
            continue
        merged[key] = value
    return merged


def _merge_string_list(current: object, update: list) -> list[str]:
    seen = {str(item): None for item in current if isinstance(item, str)} if isinstance(current, list) else {}
    for item in update:
        if isinstance(item, str):
            seen[item] = None
    return list(seen)


class SophiaState(AgentState):
    """State schema for the Sophia companion agent.

    Extends AgentState (which provides `messages`) with companion-specific
    fields for platform, tone, skills, rituals, memory, and artifacts.
    """

    # Platform and mode
    platform: NotRequired[str]  # "voice" | "text" | "ios_voice"
    active_mode: NotRequired[str]  # "companion" | "builder"
    turn_count: NotRequired[int]

    # User context
    user_id: NotRequired[str]
    context_mode: NotRequired[str]  # "work" | "gaming" | "life"

    # Ritual state
    active_ritual: NotRequired[str | None]  # "prepare" | "debrief" | "vent" | "reset" | None
    ritual_phase: NotRequired[str | None]

    # Crisis fast-path
    force_skill: NotRequired[str | None]
    skip_expensive: NotRequired[bool]

    # Tone and skill
    active_tone_band: NotRequired[str]
    active_skill: NotRequired[str]
    skill_session_data: NotRequired[dict]

    # Artifacts
    current_artifact: NotRequired[dict | None]
    previous_artifact: NotRequired[dict | None]

    # Memory
    injected_memories: NotRequired[list[str]]
    injected_memory_contents: NotRequired[list[str]]

    # NOTE: current-turn attachments are intentionally NOT a state
    # field. They travel on the per-run ``config.configurable`` channel
    # (``current_turn_attached_files``), read by
    # ``start_builder_task._read_current_turn_attached_files``. Codex P2
    # PR #132 (latest iteration): a state channel persists under its
    # LAST_VALUE reducer, so a turn that omitted attachments inherited
    # the prior turn's list and re-copied private images into a new
    # builder sandbox. ``config.configurable`` is per-run and never
    # persisted, giving clean per-run reset semantics for free.

    # Builder
    builder_task: NotRequired[dict | None]
    builder_result: NotRequired[dict | None]
    last_builder_artifact: NotRequired[dict | None]
    delegation_context: NotRequired[dict | None]
    async_tasks: Annotated[NotRequired[dict[str, dict]], merge_async_tasks]
    builder_non_artifact_turns: NotRequired[int]
    builder_last_tool_names: NotRequired[list[str]]
    builder_tool_turn_summaries: NotRequired[list[dict]]
    builder_update_epoch: NotRequired[int]
    builder_update_required_urls: NotRequired[Annotated[list[str], _union_string_list]]
    builder_artifact_target_path: NotRequired[str]
    builder_last_successful_output_path: NotRequired[str | None]
    builder_write_diagnostics: NotRequired[Annotated[dict, _merge_builder_write_diagnostics]]
    builder_pptx_diagnostics: NotRequired[Annotated[dict, _merge_builder_pptx_diagnostics]]
    builder_visual_diagnostics: NotRequired[Annotated[dict, _merge_builder_visual_diagnostics]]
    last_shell_command: NotRequired[dict | None]
    recent_shell_commands: NotRequired[list[dict] | None]
    # These three fields are written by the builder's web tools
    # (`builder_web_search`, `builder_web_fetch`). When the model emits
    # parallel tool calls in a single AI message, LangGraph dispatches both
    # tool executions in the same super-step and both try to write the same
    # field. The Annotated reducers below let those writes merge instead of
    # crashing with `InvalidUpdateError: At key '<field>': Can receive only
    # one value per step`. The `tests/test_sophia_state_schema_invariants.py`
    # guard locks these reducers in place at import time.
    builder_allowed_urls: NotRequired[Annotated[list[str], _union_string_list]]
    builder_search_sources: NotRequired[Annotated[list[dict], _merge_search_sources]]
    builder_web_budget: NotRequired[Annotated[dict, _merge_builder_web_budget]]
    allow_web_research: NotRequired[bool]
    explicit_user_urls: NotRequired[list[str]]
    # Hard cost/token ceiling for a builder run, enforced by
    # ``BuilderBudgetMiddleware`` (see builder_budget.py). Seeded once per run
    # by ``start_builder_task`` and never mutated (frozen, like
    # ``builder_web_budget``'s caps), so a plain field — no reducer needed.
    builder_budget: NotRequired[dict | None]

    # Planning
    todos: NotRequired[list | None]

    # Prompt assembly — accumulated manually by before_agent middlewares for the current turn
    # only, then assembled in PromptAssemblyMiddleware before the model call. This must not
    # use an additive reducer because each middleware already extends the list explicitly.
    system_prompt_blocks: NotRequired[list[str]]

    # Title
    title: NotRequired[str | None]

    # Vision — image_path -> {base64, mime_type}. Written by view_image_tool
    # (builder) and view_user_image (companion); consumed by ViewImageMiddleware
    # to inject image content blocks into the next model turn. The reducer
    # merges parallel writes and supports {} to clear after processing — both
    # behaviours come from upstream's ThreadState definition.
    viewed_images: Annotated[dict[str, ViewedImageData], merge_viewed_images]
