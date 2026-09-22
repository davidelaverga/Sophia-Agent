"""Prompt assembly middleware.

Runs via wrap_model_call to assemble all system_prompt_blocks accumulated by
other middlewares into a single system message prepended to the conversation.

Uses wrap_model_call (not before_model) to have direct control over the
messages sent to the model — this avoids add_messages reducer edge cases
with RemoveMessage and ensures the system prompt is always the first message.
"""

import asyncio
import os
import time
from collections.abc import Awaitable, Callable
from typing import Annotated, NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelCallResult, ModelRequest, ModelResponse, PrivateStateAttr
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from deerflow.agents.middlewares.dangling_tool_call_middleware import patch_dangling_tool_call_messages
from deerflow.agents.sophia_agent.utils import log_middleware

_GOVERNED_MEMORY_GUIDANCE = """<memory_product_guidance>
Journal manages your saved Sophia memories; it is not a separate inaccessible memory store.
Available Journal actions are review, edit and forget. This pilot has no direct Add/Create
memory action in Journal: new memories go through chat, session end and recap approval.
A request to remember something in chat can be extracted for review after the session ends.
During chat, do not claim a candidate already exists, is visible in a queue, or has been saved.
Explain the recap as two steps: first choose Keep on each desired card (selection only, not
yet saved), then press the single Complete button to approve and save all selected cards.
Keep and Complete are both needed. Complete is not a per-card option or a third review choice.
Each card's Let it go action rejects that candidate. Do not claim successful saving until
approval is confirmed. Preserve project scope and explicit synthetic/test labels.
The memory content supplied in this turn, including retrieval results, is refreshed from the
current approved records managed in Journal. It is not a snapshot from when a memory was
first created. After a Journal edit, report the retrieved content as the current saved version;
do not add a caveat that Journal has newer data you cannot access or that recall sees only the
original saved copy. For example: "Your current saved preference is [retrieved preference]."
Forget excludes that memory from subsequent memory use; a historical transcript or forgotten
shelf can still show it. Do not reconstruct forgotten content from earlier assistant replies.
When retrieval has no matching currently available saved memory, say that plainly. An empty
result does not prove an authorization lapse, a session-only permission, that a memory was
never saved, or that Journal cannot be accessed. Do not invent explanations for missing data.
A related search result is not evidence for a different project or preference: use only
content that actually supports the requested fact, and acknowledge when no match is available.
For an empty result, an appropriate explanation is: "I couldn't find a currently saved memory
matching that. In Journal, you can review, edit, or forget your saved Sophia memories."
</memory_product_guidance>"""


class PromptAssemblyState(AgentState):
    system_prompt_blocks: NotRequired[list[str]]
    memory_context_proof: NotRequired[Annotated[dict | None, PrivateStateAttr]]


class PromptAssemblyMiddleware(AgentMiddleware[PromptAssemblyState]):
    """Assemble system_prompt_blocks into the system message.

    Uses wrap_model_call to directly manipulate the messages sent to the model,
    ensuring:
    1. All prior SystemMessages are removed (no duplicates)
    2. The assembled system message is always first
    3. At least one non-system message (HumanMessage) is preserved
    """

    state_schema = PromptAssemblyState

    _SYSTEM_MSG_ID = "sophia-system-prompt"

    def __init__(self, user_id: str | None = None, *, context_id: str | None = None, memory_scope: str = "global"):
        super().__init__()
        self._memory_owner = user_id
        self._memory_context_id = context_id
        self._memory_scope = memory_scope

    def _memory_boundary(self, request):
        """No provenance or current canonical admission means no model dispatch.

        A trusted producer/rotation protocol must supply the private proof. This
        boundary NEVER blesses request state by signing it on the way through.
        The factory-bound owner/context cannot be overridden by checkpoint data.
        """
        from deerflow.sophia.memory_governance.context_state import allows_unversioned_builder_handoff
        from deerflow.sophia.memory_governance.owner_authority import owner_is_definitely_undeclared

        if allows_unversioned_builder_handoff(self._memory_owner):
            return request
        if self._memory_owner and owner_is_definitely_undeclared(self._memory_owner):
            # An owner outside the pilot has no producer, so there is no seal to
            # verify and no canonical row to admit. Demanding one here turned
            # every ordinary non-pilot turn into "memory context could not be
            # verified" -- the same shape of gap as the guard's, at a fourth
            # site, because allows_unversioned_builder_handoff answers False for
            # an undeclared owner exactly as it does for a governed one.
            #
            # This is a pass-through, NOT a blessing: nothing is signed, and a
            # request that somehow carries memory-shaped material still fails
            # closed below, so retained state from a previous governed era or a
            # client-supplied block cannot be reused on this path.
            return self._neutral_request(request)
        try:
            from deerflow.sophia.memory_governance.context_provenance import verify_context_seal
            from deerflow.sophia.memory_governance.flags import memory_feature_flags_for_owner
            from deerflow.sophia.memory_governance.mem0_projection_adapter import Mem0ProjectionAdapter
            from deerflow.sophia.memory_governance.retained_admission import readmit_retained_context
            from deerflow.sophia.memory_governance.service import MemoryProviderContract
            from deerflow.sophia.memory_governance.store import configured_memory_store

            if not self._memory_owner or not self._memory_context_id:
                return None
            if not memory_feature_flags_for_owner(self._memory_owner).governed_runtime_read:
                return None
            manifest = verify_context_seal(value=request.state.get("memory_context_proof"), owner_id=self._memory_owner,
                context_id=self._memory_context_id, messages=request.messages, blocks=request.state.get("system_prompt_blocks", []))
            if manifest is None:
                return None
            result = readmit_retained_context(store=configured_memory_store(), adapter=Mem0ProjectionAdapter(),
                provider=MemoryProviderContract.from_environ(), service_name=os.getenv("RENDER_SERVICE_NAME") or "sophia-langgraph",
                owner_id=self._memory_owner, context=manifest, scope=self._memory_scope, caller="model_retained_context_boundary",
                query="Retained context availability check")
            if result.transition.action != "continue":
                return None
            # Even verified cached memory blocks are not rendered. Rebuild their
            # content from current canonical rows admitted by the atomic RPC.
            blocks = [block for block in request.state.get("system_prompt_blocks", []) if not block.lstrip().startswith(("<memory>", "<memories>"))]
            blocks.append(_GOVERNED_MEMORY_GUIDANCE)
            if result.memories:
                blocks.append("<memories>\n" + "\n".join("- " + memory.canonical_content for memory in result.memories) + "\n</memories>")
            canonical_text = "\n".join("- " + memory.canonical_content for memory in result.memories)
            messages = [message.model_copy(update={"content": canonical_text or "No currently authorized memories.", "artifact": None})
                if isinstance(message, ToolMessage) and message.name in {"retrieve_memories", "search_memories"} else message for message in request.messages]
            return request.override(messages=messages, system_message=None, state={**request.state, "system_prompt_blocks": blocks,
                "injected_memories": [str(memory.memory_id) for memory in result.memories],
                "injected_memory_contents": [memory.canonical_content for memory in result.memories]})
        except Exception:
            return None

    def _neutral_request(self, request):
        """The undeclared owner's request, with nothing memory-shaped in it."""
        state = request.state or {}
        if state.get("memory_context_proof") is not None or state.get("injected_memories"):
            return None
        blocks = state.get("system_prompt_blocks", [])
        if any(block.lstrip().startswith(("<memory>", "<memories>")) for block in blocks):
            return None
        if any(isinstance(message, ToolMessage) and message.name in {"retrieve_memories", "search_memories"}
               for message in request.messages):
            return None
        return request

    def _memory_unavailable(self):
        # No provider/model call and no claim of erasure or successful rotation.
        try:
            from deerflow.sophia.memory_governance.observability import emit_memory_event
            from deerflow.sophia.memory_governance.refs import keyed_ref

            fields = {"owner_ref": keyed_ref("owner", self._memory_owner)} if self._memory_owner else {}
            emit_memory_event("memory.context.transition", service=os.getenv("RENDER_SERVICE_NAME") or "sophia-langgraph",
                outcome="zero_memory", fault_owner_id=self._memory_owner, safe_reason_code="model_context_unavailable", **fields)
        except Exception:
            from deerflow.sophia.memory_governance.observability import record_memory_observation_gap

            record_memory_observation_gap()  # Preserve refusal and expose evidence loss.
        return AIMessage(content="This conversation's memory context could not be verified. Please start a fresh conversation.",
            additional_kwargs={"sophia_memory_status": "context_unavailable"})

    def _assemble_messages(self, request: ModelRequest) -> ModelRequest | None:
        """Build messages with the assembled system prompt prepended."""
        _t0 = time.perf_counter()

        patched_messages = patch_dangling_tool_call_messages(request.messages)
        if patched_messages is not None:
            request = request.override(messages=patched_messages)

        # Access system_prompt_blocks from the current state
        state = request.state
        blocks = state.get("system_prompt_blocks", [])
        if not blocks:
            if patched_messages is not None:
                log_middleware("PromptAssembly", "skipped assembly (patched dangling tool calls)", _t0)
                return request
            log_middleware("PromptAssembly", "skipped (no blocks)", _t0)
            return None

        system_content = "\n\n---\n\n".join(blocks)

        # Filter out any existing SystemMessages from the request messages.
        # Also detect and absorb the SummarizationMiddleware's HumanMessage
        # into the system prompt so the model treats it as context — not as
        # user input that it should echo back.
        non_system: list = []
        summary_block: str | None = None
        for m in request.messages:
            if isinstance(m, SystemMessage):
                continue
            if (
                summary_block is None
                and isinstance(m, HumanMessage)
                and isinstance(m.content, str)
                and m.content.startswith("Here is a summary of the conversation to date:")
            ):
                summary_block = m.content
                continue
            non_system.append(m)

        if not non_system:
            log_middleware("PromptAssembly", "ERROR: no non-system messages found", _t0)
            return None

        # Append absorbed summary to the system prompt so it's treated as
        # context rather than user speech.
        if summary_block:
            system_content += "\n\n---\n\n" + summary_block

        # Prepend the assembled system message
        assembled = [SystemMessage(content=system_content, id=self._SYSTEM_MSG_ID)] + non_system

        log_middleware(
            "PromptAssembly",
            f"{len(blocks)} blocks assembled ({sum(len(b) for b in blocks)} chars), "
            f"{len(non_system)} conversation messages",
            _t0,
        )
        return request.override(messages=assembled)

    @override
    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], ModelResponse],
    ) -> ModelCallResult:
        request = self._memory_boundary(request)
        if request is None:
            return self._memory_unavailable()
        patched = self._assemble_messages(request)
        if patched is not None:
            request = patched
        _t0 = time.perf_counter()
        result = handler(request)
        elapsed = (time.perf_counter() - _t0) * 1000
        log_middleware("LLM", f"model call completed ({elapsed:.0f}ms)", _t0)
        return result

    @override
    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelCallResult:
        request = await asyncio.to_thread(self._memory_boundary, request)
        if request is None:
            return self._memory_unavailable()
        patched = self._assemble_messages(request)
        if patched is not None:
            request = patched
        _t0 = time.perf_counter()
        result = await handler(request)
        elapsed = (time.perf_counter() - _t0) * 1000
        log_middleware("LLM", f"model call completed ({elapsed:.0f}ms)", _t0)
        return result
