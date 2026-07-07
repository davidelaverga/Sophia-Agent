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

The Todo factory and the observability middlewares are imported through
``builder_chain_support`` (single bridge edge) so this assembler stays
under sentrux's god-file fan-out threshold.
"""

from __future__ import annotations

from langchain.agents.middleware import AgentMiddleware
from langchain_anthropic.middleware.prompt_caching import AnthropicPromptCachingMiddleware

from deerflow.agents.middlewares.anthropic_content_block_sanitizer import AnthropicContentBlockSanitizerMiddleware
from deerflow.agents.middlewares.dangling_tool_call_middleware import DanglingToolCallMiddleware
from deerflow.agents.middlewares.tool_error_handling_middleware import build_subagent_runtime_middlewares
from deerflow.agents.sophia_agent.builder_chain_support import (
    BuilderBudgetMiddleware,
    BuilderProgressMiddleware,
    LoopDetectionMiddleware,
    create_builder_todo_middleware,
    log_builder_tracing_startup_status,
    wrap_builder_agent_for_observability,
)
from deerflow.agents.sophia_agent.middlewares.builder_artifact import BuilderArtifactMiddleware
from deerflow.agents.sophia_agent.middlewares.builder_provider_fallback import BuilderProviderFallbackMiddleware
from deerflow.agents.sophia_agent.middlewares.builder_research_policy import BuilderResearchPolicyMiddleware
from deerflow.agents.sophia_agent.middlewares.builder_task import BuilderTaskMiddleware
from deerflow.agents.sophia_agent.middlewares.file_injection import FileInjectionMiddleware
from deerflow.agents.sophia_agent.middlewares.mem0_retrieval import BuilderMem0RetrievalMiddleware
from deerflow.agents.sophia_agent.middlewares.prompt_assembly import PromptAssemblyMiddleware
from deerflow.agents.sophia_agent.middlewares.user_identity import UserIdentityMiddleware
from deerflow.agents.sophia_agent.middlewares.view_image import (
    ClearOnInjectViewImageMiddleware,
)
from deerflow.agents.sophia_agent.paths import SKILLS_PATH

__all__ = [
    "build_builder_middleware_chain",
    "log_builder_tracing_startup_status",
    "wrap_builder_agent_for_observability",
]


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
    2. ``FileInjectionMiddleware`` — soul.md + coordination_core.md +
       builder_obligations.md. Builder doesn't speak, so voice.md is
       intentionally absent.
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
    8. ``create_builder_todo_middleware()`` — always-on planning.
    9. ``BuilderArtifactMiddleware`` — captures emit_builder_artifact
       and uploads to Supabase under the parent thread_id.
    9a. ``ClearOnInjectViewImageMiddleware`` (conditional on
        ``vision_enabled``) — injects base64 image content blocks into
        the next model turn when ``view_image_tool`` calls have
        completed, AND clears ``state["viewed_images"]`` after
        injection so subsequent view-image calls REPLACE rather than
        accumulate (Codex P2 PR #132 latest iteration — without this
        clear, viewing multiple ~10 MiB images in a build would
        exceed Anthropic's 32 MB request envelope). Sits AFTER
        BuilderArtifactMiddleware (so artifact emission isn't shadowed
        by mid-stream image injection) and BEFORE PromptAssembly /
        DanglingToolCall so the injected HumanMessage participates in
        prompt finalization and tool-call patching.
    10. ``PromptAssemblyMiddleware`` — concatenates system_prompt_blocks
        into the system message.
    11. ``DanglingToolCallMiddleware`` — patches dangling AIMessage
        tool_use blocks. MUST sit AFTER PromptAssembly so the patched
        message list reaches the model.
    12. ``AnthropicContentBlockSanitizerMiddleware`` — strips provider-private
        thinking blocks that cannot be replayed as historical assistant content.
    """
    middlewares = build_subagent_runtime_middlewares(lazy_init=True)
    chain_tail: list[AgentMiddleware] = [
        # Provider fallback (Anthropic primary → optional OpenAI retry).
        # Uses ONLY wrap_model_call/awrap_model_call, so its position among
        # the before/after-hook middlewares below is behavior-neutral; it
        # sits first in the tail so its model-call wrapper is outermost.
        # Default-off via SOPHIA_BUILDER_OPENAI_FALLBACK_ENABLED — with the
        # flag unset the only delta on provider errors is one log line.
        BuilderProviderFallbackMiddleware(),
        FileInjectionMiddleware(
            (SKILLS_PATH / "soul.md", False),
            (SKILLS_PATH / "coordination_core.md", False),
            (SKILLS_PATH / "builder_obligations.md", False),
        ),
        UserIdentityMiddleware(user_id),
        BuilderMem0RetrievalMiddleware(),
        # Pass ``vision_enabled`` through so the uploaded-images briefing
        # only mentions ``view_image`` when the tool is actually wired in.
        # Codex P2 PR #132: when vision is gated off (e.g. an operator
        # disabled it for a build), telling the model to call a tool that
        # doesn't exist would either error or burn tool-call budget on
        # nothing. The middleware renders a different prompt block in that
        # case (acknowledges the uploads, instructs the model NOT to try
        # ``view_image``).
        BuilderTaskMiddleware(vision_enabled=vision_enabled),
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
        create_builder_todo_middleware(),
        # Budget circuit-breaker. Listed BEFORE BuilderArtifactMiddleware so
        # that — because after_model hooks run in REVERSE list order — it runs
        # AFTER it. That lets a turn which legitimately emits an artifact claim
        # the one-shot completion-webhook dedup with "completed" first (deliver
        # the work), while a genuine runaway turn (no artifact) lets this
        # middleware's "timed_out" budget kill win uncontended. See its module
        # docstring. Caps seeded per-run via start_builder_task; 0 disables.
        BuilderBudgetMiddleware(),
        BuilderArtifactMiddleware(),
        LoopDetectionMiddleware(),
    ]
    if vision_enabled:
        chain_tail.append(ClearOnInjectViewImageMiddleware())
    chain_tail.extend(
        [
            PromptAssemblyMiddleware(),
            DanglingToolCallMiddleware(),
            AnthropicContentBlockSanitizerMiddleware(),
            # Phase 2 — prompt caching. MUST be last (innermost) so it keys off
            # the message list AFTER DanglingToolCall repairs dangling tool_use/
            # tool_result pairs, mirroring the companion's ordering in agent.py.
            # On the direct Anthropic API this caches system + tools + an
            # incremental message-prefix breakpoint that advances as the
            # conversation grows.
            AnthropicPromptCachingMiddleware(ttl="5m", unsupported_model_behavior="ignore"),
        ]
    )
    middlewares.extend(chain_tail)
    return middlewares
