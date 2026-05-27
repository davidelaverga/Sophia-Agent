"""Builder middleware chain assembly.

Extracted from ``builder_agent.py`` so that file's import fan-out drops
below sentrux's god-files threshold. Both files are co-located in the
same module (``deerflow.agents.sophia_agent``) so this is a pure
extract-method refactor — no layer crossings change.

Why split:

- Pre-extract: ``builder_agent.py`` directly imported all 9 builder
  middleware classes plus ``SKILLS_PATH`` plus ``TodoMiddleware``,
  reaching fan-out=19 (over the 15 threshold). Sentrux flagged it as
  a god-file.
- Post-extract: ``builder_agent.py`` imports a single
  ``build_builder_middleware_chain`` factory from this module and only
  the model/tool/state classes it needs to instantiate the agent.
  Fan-out drops to ≈9.

Behavioral parity:

The assembled middleware list is byte-identical to what
``builder_agent.py`` previously constructed inline. The order of
middleware (`build_subagent_runtime_middlewares` → file injection →
identity → mem0 retrieval → task briefing → research policy → todo →
artifact → prompt assembly → dangling-tool-call patcher) is locked by
``tests/test_sophia_builder_flow.py``; do NOT reorder without updating
that test.

The ``_create_builder_todo_middleware`` helper that builds the always-on
Todo middleware sits here too because it's only used in the chain assembly
and was a private helper of ``builder_agent.py``.
"""

from __future__ import annotations

from langchain.agents.middleware import AgentMiddleware

from deerflow.agents.middlewares.dangling_tool_call_middleware import DanglingToolCallMiddleware
from deerflow.agents.middlewares.todo_middleware import TodoMiddleware
from deerflow.agents.middlewares.tool_error_handling_middleware import build_subagent_runtime_middlewares
from deerflow.agents.middlewares.view_image_middleware import ViewImageMiddleware
from deerflow.agents.sophia_agent.middlewares.builder_artifact import BuilderArtifactMiddleware
from deerflow.agents.sophia_agent.middlewares.builder_progress import BuilderProgressMiddleware
from deerflow.agents.sophia_agent.middlewares.builder_research_policy import BuilderResearchPolicyMiddleware
from deerflow.agents.sophia_agent.middlewares.builder_task import BuilderTaskMiddleware
from deerflow.agents.sophia_agent.middlewares.file_injection import FileInjectionMiddleware
from deerflow.agents.sophia_agent.middlewares.mem0_retrieval import BuilderMem0RetrievalMiddleware
from deerflow.agents.sophia_agent.middlewares.prompt_assembly import PromptAssemblyMiddleware
from deerflow.agents.sophia_agent.middlewares.user_identity import UserIdentityMiddleware
from deerflow.agents.sophia_agent.paths import SKILLS_PATH

__all__ = ["build_builder_middleware_chain"]


_BUILDER_TODO_SYSTEM_PROMPT = """
<builder_todo_system>
You are the Sophia builder. Keep a live todo list while executing delegated build tasks.
- Use `write_todos` only for genuinely multi-step work.
- Create the initial todo list once near the start, then keep working.
- Do NOT rewrite the todo list after every small tool call.
- Update todos only when the plan materially changes, a major milestone finishes, or right before the final handoff.
- Keep at least one item in progress until the task is finished.
- Mark items completed as soon as a meaningful step is done.
</builder_todo_system>
"""

_BUILDER_TODO_TOOL_DESCRIPTION = (
    "Use this tool to maintain your execution todo list while building. "
    "Create it once for multi-step work, then update it only at meaningful milestones."
)

_BUILDER_TODO_REMINDER = (
    "Only call `write_todos` again if the plan materially changed, a major milestone finished, "
    "or you are preparing the final handoff."
)


def _create_builder_todo_middleware() -> TodoMiddleware:
    """Always-on Todo middleware tuned for delegated build execution."""
    return TodoMiddleware(
        system_prompt=_BUILDER_TODO_SYSTEM_PROMPT,
        tool_description=_BUILDER_TODO_TOOL_DESCRIPTION,
        reminder_instruction=_BUILDER_TODO_REMINDER,
    )


def build_builder_middleware_chain(
    user_id: str,
    *,
    vision_enabled: bool = False,
) -> list[AgentMiddleware]:
    """Return the canonical builder middleware chain (order is load-bearing).

    The chain assembled here is identical to what ``builder_agent.py``
    previously built inline. The order is enforced by the regression
    test ``tests/test_sophia_builder_flow.py`` — do NOT reorder.

    Position notes:

    1. ``build_subagent_runtime_middlewares`` — sandbox + tool-error
       handling provided by deerflow harness; sits at the front.
    2. ``FileInjectionMiddleware`` — soul.md + AGENTS.md (the
       companion↔builder coordination contract). Builder doesn't speak,
       so voice.md is intentionally absent.
    3. ``UserIdentityMiddleware`` — identity file shapes what builder
       creates.
    4. ``BuilderMem0RetrievalMiddleware`` (Phase-3 Stage 1) — pre-fetches
       top-K memories for both companion-subagent AND Builder-as-Main
       paths. Best-effort with 2.0s timeout; never blocks the run.
    5. ``BuilderTaskMiddleware`` — translates companion artifact (or, on
       the no-companion path, a synthesised delegation_context via single
       Haiku classifier call) into the ``<builder_briefing>`` block.
    6. ``BuilderResearchPolicyMiddleware`` — builder-only web research
       rules and budget initialisation.
    7. ``BuilderProgressMiddleware`` (Phase 4G) — emits ``custom``-mode
       phase events to the langgraph stream so the gateway-side
       ``BuilderProgressSubscriber`` can render live phase headers.
    8. ``_create_builder_todo_middleware()`` — always-on planning.
    9. ``BuilderArtifactMiddleware`` — captures emit_builder_artifact
       and uploads to Supabase under the parent thread_id.
    9a. ``ViewImageMiddleware`` (conditional on ``vision_enabled``) —
        injects base64 image content blocks into the next model turn
        when ``view_image_tool`` calls have completed. Sits AFTER
        BuilderArtifactMiddleware (so artifact emission isn't shadowed
        by mid-stream image injection) and BEFORE PromptAssembly /
        DanglingToolCall so the injected HumanMessage participates in
        prompt finalization and tool-call patching.
    10. ``PromptAssemblyMiddleware`` — concatenates system_prompt_blocks
        into the system message.
    11. ``DanglingToolCallMiddleware`` — patches dangling AIMessage
        tool_use blocks. MUST sit AFTER PromptAssembly so the patched
        message list reaches the model.
    """
    middlewares = build_subagent_runtime_middlewares(lazy_init=True)
    chain_tail: list[AgentMiddleware] = [
        FileInjectionMiddleware(
            (SKILLS_PATH / "soul.md", False),
            (SKILLS_PATH / "AGENTS.md", False),
        ),
        UserIdentityMiddleware(user_id),
        BuilderMem0RetrievalMiddleware(),
        BuilderTaskMiddleware(),
        BuilderResearchPolicyMiddleware(),
        # Phase 4G — emits ``custom``-mode phase events
        # (``starting`` / ``researching`` / ``drafting`` /
        # ``finalizing`` / ``done``) into the langgraph stream so
        # ``BuilderProgressSubscriber`` (gateway-side) renders the
        # live UX the user described: phase headers + emoji-prefixed
        # tool-call activity lines inside the Telegram placeholder.
        # Position: after research-policy (so brief is built before
        # we emit ``starting``), before todo + artifact (so the
        # tool-call inspection in ``after_model`` runs against the
        # raw model output before artifact rewrites it).
        BuilderProgressMiddleware(),
        _create_builder_todo_middleware(),
        BuilderArtifactMiddleware(),
    ]
    if vision_enabled:
        chain_tail.append(ViewImageMiddleware())
    chain_tail.extend(
        [
            PromptAssemblyMiddleware(),
            DanglingToolCallMiddleware(),
        ]
    )
    middlewares.extend(chain_tail)
    return middlewares
