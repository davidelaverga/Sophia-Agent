"""Artifact middleware.

Before-phase: injects artifact_instructions.md and conditionally injects
the previous artifact.
After-model: captures emit_artifact tool call output and stores in state.
"""

import json
import logging
import time
from pathlib import Path
from typing import NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import hook_config
from langchain_core.messages import ToolMessage
from langgraph.runtime import Runtime

from deerflow.agents.sophia_agent.utils import log_middleware

logger = logging.getLogger(__name__)

TONE_DELTA_THRESHOLD = 0.3

_VOICE_ARTIFACT_INSTRUCTIONS = """<artifact_contract>
Every turn has two outputs:
- Spoken reply in normal assistant text.
- Exactly one emit_artifact tool call after the spoken reply. Never print JSON in the reply.

emit_artifact is REQUIRED on every turn with these 13 fields:
- session_goal: stable session-level aim unless the topic genuinely shifts.
- active_goal: what you are doing for the user right now.
- next_step: likely best next move for the following turn.
- takeaway: one concrete thing worth remembering.
- reflection: one later question, or null.
- tone_estimate: honest 0.0-4.0 read of where the user ends this turn.
- tone_target: min(tone_estimate + 0.5, 4.0).
- active_tone_band: shutdown | grief_fear | anger_antagonism | engagement | enthusiasm.
- skill_loaded: exact injected skill name, or active_listening if none is visible.
- ritual_phase: ritual.step or freeform.topic.
- voice_emotion_primary: choose the delivery intent, not the user's raw state.
- voice_emotion_secondary: close fallback emotion.
- voice_speed: slow | gentle | normal | engaged | energetic.

Voice defaults:
- shutdown or grief: calm or sympathetic, slow or gentle.
- reflective exploration: curious or contemplative, normal.
- clean challenge or stuck-loop work: determined, confident, or curious, engaged.
- good news, breakthrough, or celebrating_breakthrough: enthusiasm band with excited or proud, engaged or energetic.

First turn:
- Build session_goal from ritual + opening message + known context.

Later turns:
- Keep session_goal stable unless the session truly changes.
- Update active_goal, next_step, tone_estimate, and delivery based on this turn.

After the emit_artifact call, stop. Do not call more tools.
</artifact_contract>"""


class ArtifactState(AgentState):
    skip_expensive: NotRequired[bool]
    current_artifact: NotRequired[dict | None]
    previous_artifact: NotRequired[dict | None]
    system_prompt_blocks: NotRequired[list[str]]
    builder_result: NotRequired[dict | None]
    builder_task: NotRequired[dict | None]
    active_tone_band: NotRequired[str]
    platform: NotRequired[str]


class ArtifactMiddleware(AgentMiddleware[ArtifactState]):
    """Manage artifact instructions and emit_artifact tool call capture."""

    state_schema = ArtifactState

    def __init__(self, artifact_instructions_path: Path):
        super().__init__()
        if not artifact_instructions_path.exists():
            raise FileNotFoundError(f"Artifact instructions not found: {artifact_instructions_path}")
        self._instructions = artifact_instructions_path.read_text(encoding="utf-8")

    @override
    def before_agent(self, state: ArtifactState, runtime: Runtime) -> dict | None:
        _t0 = time.perf_counter()
        if state.get("skip_expensive", False):
            log_middleware("Artifact", "skipped (crisis)", _t0)
            return None

        platform = state.get("platform") or runtime.context.get("platform")
        instructions = _VOICE_ARTIFACT_INSTRUCTIONS if platform in ("voice", "ios_voice") else self._instructions
        blocks = [instructions]
        updates: dict[str, object] = {}

        # --- Builder synthesis injection ---
        builder_result = state.get("builder_result")
        builder_task = state.get("builder_task") or {}
        if builder_result is not None and not builder_task.get("status"):
            builder_task = {**builder_task, "status": "completed"}
            updates["builder_task"] = builder_task

        if builder_result is None:
            recovered_builder_result = self._extract_builder_result_from_messages(state.get("messages", []))
            if recovered_builder_result is not None:
                builder_result = recovered_builder_result
                builder_task = {**builder_task}
                builder_task.setdefault("status", "completed")
                updates["builder_result"] = builder_result
                updates["builder_task"] = builder_task
                log_middleware("Artifact", "recovered builder result from tool message", _t0)

        if builder_result and builder_task.get("status") == "completed":
            # Detect the companion-wakeup turn so the synthesis prompt can
            # add a hard "you must speak and emit_artifact" directive.
            # The flag is set on ``runtime.context`` by ``CompanionWakeup``
            # in the gateway worker; we also fall back to detecting an
            # empty trailing-human message slot, which is the runtime
            # signature of a wakeup (``input={"messages": []}``).
            is_wakeup = bool(runtime.context.get("is_builder_wakeup")) or self._is_wakeup_state(state)
            synthesis_block = self._build_synthesis_prompt(builder_result, state, is_wakeup=is_wakeup)
            blocks.append(synthesis_block)
            # Mark as synthesized to prevent re-injection on subsequent turns
            log_middleware("Artifact", "builder synthesis injected", _t0)
            existing = list(state.get("system_prompt_blocks", []))
            existing.extend(blocks)
            builder_task_updated = {**builder_task, "status": "synthesized"}
            updates.update({
                "builder_result": builder_result,
                "system_prompt_blocks": existing,
                "builder_task": builder_task_updated,
            })
            return updates

        # Conditionally inject previous artifact
        prev = state.get("previous_artifact")
        if prev:
            tone_estimate = prev.get("tone_estimate", 2.5)
            tone_target = prev.get("tone_target", tone_estimate)
            tone_delta = abs(tone_target - tone_estimate)

            if tone_delta > TONE_DELTA_THRESHOLD or prev.get("skill_loaded") in (
                "vulnerability_holding", "challenging_growth", "identity_fluidity_support",
            ):
                blocks.append(
                    "<previous_artifact>\n"
                    + json.dumps(prev, indent=2)
                    + "\n</previous_artifact>"
                )

        existing = list(state.get("system_prompt_blocks", []))
        existing.extend(blocks)
        log_middleware("Artifact", f"instructions injected (platform={platform or 'default'})", _t0)
        updates["system_prompt_blocks"] = existing
        return updates

    @hook_config(can_jump_to=["end"])
    @override
    def after_model(self, state: ArtifactState, runtime: Runtime) -> dict | None:
        """Capture emit_artifact tool call result from latest messages."""
        _t0 = time.perf_counter()
        messages = state.get("messages", [])

        for msg in reversed(messages):
            if getattr(msg, "type", None) == "ai":
                tool_calls = getattr(msg, "tool_calls", []) or []
                if not tool_calls:
                    log_middleware("Artifact", "no artifact in response", _t0)
                    return None

                artifact_calls = [tc for tc in tool_calls if tc.get("name") == "emit_artifact"]
                if not artifact_calls:
                    log_middleware("Artifact", "no artifact in response", _t0)
                    return None

                if len(artifact_calls) != len(tool_calls):
                    log_middleware("Artifact", "mixed tool calls with emit_artifact; loop continues", _t0)
                    return None

                artifact_data = artifact_calls[-1].get("args", {})
                builder_result = state.get("builder_result") or self._extract_builder_result_from_messages(messages)
                # Close the emit_artifact tool_call(s) with synthetic ToolMessages.
                # Without this, each turn leaves a dangling tool_call in the thread
                # state that accumulates across turns (and especially across resumed
                # sessions), bloating the prompt and triggering the dangling-tool-call
                # patch on every model invocation. emit_artifact is a signal-only
                # tool — the LLM never re-consumes these messages because we also
                # jump_to "end", so closing the loop here is purely hygiene for
                # message-history integrity.
                tool_messages = [
                    ToolMessage(
                        content="Artifact recorded.",
                        tool_call_id=tc["id"],
                        name="emit_artifact",
                    )
                    for tc in artifact_calls
                    if tc.get("id")
                ]
                updates = {
                    "messages": tool_messages,
                    "previous_artifact": state.get("current_artifact"),
                    "current_artifact": artifact_data,
                    "jump_to": "end",
                }
                if builder_result:
                    builder_task = {**(state.get("builder_task") or {}), "status": "synthesized"}
                    updates["builder_result"] = builder_result
                    updates["builder_task"] = builder_task
                    log_middleware("Artifact", f"artifact captured with builder handoff: tone={artifact_data.get('tone_estimate')}", _t0)
                else:
                    log_middleware("Artifact", f"artifact captured: tone={artifact_data.get('tone_estimate')}", _t0)
                return updates

        log_middleware("Artifact", "no artifact in response", _t0)
        return None

    # ------------------------------------------------------------------
    # Builder synthesis
    # ------------------------------------------------------------------

    _SYNTHESIS_INSTRUCTIONS = {
        "shutdown": (
            "The user is in a very low state. Keep presentation ultra-brief. "
            "Just tell them it's ready. No details unless they ask."
        ),
        "grief_fear": (
            "The user is carrying weight. Present as something taken care of. "
            "Warm and brief. One or two sentences, then offer the file."
        ),
        "anger_antagonism": (
            "The user was frustrated. Present as forward motion. Be direct. "
            "'Here's what I built. It does X.' State next action clearly."
        ),
        "engagement": (
            "The user has energy. Give more detail about what was built. "
            "Mention 1-2 key decisions. Frame next action as collaboration."
        ),
        "enthusiasm": (
            "The user is high energy. Match that energy. Present with confidence. "
            "Highlight any surprise element. Let them ride the momentum."
        ),
    }

    def _build_synthesis_prompt(self, builder: dict, state: dict, *, is_wakeup: bool = False) -> str:
        """Build the synthesis prompt for presenting builder results.

        When ``is_wakeup`` is True the user did not just send a message —
        the builder finished asynchronously and the gateway scheduled a
        synthetic turn so Sophia proactively announces the artifact in
        chat. Without an explicit "you MUST speak now and emit_artifact"
        directive the model frequently returns empty content + no
        ``emit_artifact`` (logged as ``[Artifact] no artifact in
        response``), and nothing visible reaches the chat surface.
        """
        tone_band = state.get("active_tone_band", "engagement")
        instruction = self._SYNTHESIS_INSTRUCTIONS.get(
            tone_band, self._SYNTHESIS_INSTRUCTIONS["engagement"]
        )

        parts = ["<builder_completed>"]
        parts.append(f"WHAT WAS BUILT: {builder.get('companion_summary', 'Task completed.')}")
        parts.append(
            f"DELIVERABLE: {builder.get('artifact_title', 'Untitled')} "
            f"({builder.get('artifact_type', 'file')})"
        )

        decisions = builder.get("decisions_made", [])
        if decisions:
            parts.append(f"KEY DECISIONS: {'; '.join(decisions)}")

        tone_hint = builder.get("companion_tone_hint", "")
        if tone_hint:
            parts.append(f"BUILDER'S SUGGESTION: {tone_hint}")

        next_action = builder.get("user_next_action")
        if next_action:
            parts.append(f"USER'S NEXT STEP: {next_action}")

        parts.append(f"\nHOW TO PRESENT THIS:\n{instruction}")
        parts.append(
            "\nExpress this result naturally in your voice. Do not list "
            "decisions mechanically. The user should feel this was done "
            "WITH care, not BY a machine."
        )

        if is_wakeup:
            parts.append(
                "\nWAKEUP TURN: There is no new user message — the builder "
                "just finished and you are proactively announcing it. You "
                "MUST: (1) produce an AIMessage that mentions the artifact "
                "title in 1–2 sentences, then (2) call emit_artifact with "
                "the standard 13 fields. Do NOT stay silent and do NOT skip "
                "emit_artifact. This is the only signal the user receives "
                "that the work is done."
            )

        parts.append("</builder_completed>")

        return "\n".join(parts)

    @staticmethod
    def _is_wakeup_state(state: dict) -> bool:
        """Best-effort detection of a wakeup turn from state shape alone.

        Used as a fallback when ``runtime.context.is_builder_wakeup`` is
        not propagated (older callers, tests). A wakeup turn enters with
        no fresh ``HumanMessage`` because ``input={"messages": []}`` —
        the most recent message is therefore an AI/tool/system message
        from a prior turn, never a HumanMessage.
        """
        messages = state.get("messages") or []
        if not messages:
            return True
        last = messages[-1]
        # Be liberal: any non-human latest-message during builder
        # synthesis is treated as wakeup-shaped.
        return getattr(last, "type", None) != "human"

    @staticmethod
    def _extract_builder_result_from_messages(messages: list) -> dict | None:
        """Recover builder_result from the persisted switch_to_builder ToolMessage."""
        for msg in reversed(messages):
            if getattr(msg, "type", None) != "tool":
                continue

            if getattr(msg, "name", None) != "switch_to_builder":
                continue

            status = getattr(msg, "status", None)
            if isinstance(status, str) and status.lower() != "success":
                continue

            content = getattr(msg, "content", None)
            if not isinstance(content, str):
                continue

            _prefix, separator, payload = content.partition("Full result:")
            if not separator:
                continue

            try:
                parsed = json.loads(payload.strip())
            except json.JSONDecodeError:
                continue

            if isinstance(parsed, dict) and parsed:
                return parsed

        return None
