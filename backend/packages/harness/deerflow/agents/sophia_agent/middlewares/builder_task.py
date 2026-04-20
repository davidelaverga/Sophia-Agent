"""Builder task middleware.

Translates the companion's emotional context into behavioral guidance
for the builder agent. Reads ``delegation_context`` from the runtime
config and injects a ``<builder_briefing>`` block into
``system_prompt_blocks``.
"""

import html
import logging
import time
from typing import Any, NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langgraph.runtime import Runtime

from deerflow.agents.sophia_agent.utils import log_middleware

logger = logging.getLogger(__name__)


class BuilderTaskState(AgentState):
    system_prompt_blocks: NotRequired[list[str]]
    delegation_context: NotRequired[dict | None]


class BuilderTaskMiddleware(AgentMiddleware[BuilderTaskState]):
    """Inject builder briefing derived from companion delegation context."""

    state_schema = BuilderTaskState

    @override
    def before_agent(self, state: BuilderTaskState, runtime: Runtime) -> dict | None:
        _t0 = time.perf_counter()

        delegation_context: dict[str, Any] = state.get("delegation_context") or {}

        if not delegation_context:
            log_middleware("BuilderTask", "no delegation_context", _t0)
            return None

        companion_artifact: dict[str, Any] = delegation_context.get("companion_artifact", {})
        task_type: str = delegation_context.get("task_type", "unknown")
        relevant_memories: list[str] = delegation_context.get("relevant_memories", [])
        active_ritual: str | None = delegation_context.get("active_ritual")
        ritual_phase: str | None = delegation_context.get("ritual_phase")
        resume_context: dict | None = delegation_context.get("resume_context")

        # --- Build briefing sections ---
        sections: list[str] = []

        # Resume-from block (highest priority for the builder's attention)
        # is rendered first so the model reads it before any other context
        # and knows not to redo completed work.
        if resume_context:
            resume_section = self._resume_from_guidance(resume_context)
            if resume_section:
                sections.append(f"<resume_from>\n{resume_section}\n</resume_from>")

        # Tone guidance
        tone_estimate: float = companion_artifact.get("tone_estimate", 2.5)
        active_tone_band: str = companion_artifact.get("active_tone_band", "engagement")
        tone_section = self._tone_guidance(tone_estimate, active_tone_band)
        sections.append(f"<tone_guidance>\n{tone_section}\n</tone_guidance>")

        # Ritual guidance (validate + escape to prevent prompt injection via crafted values)
        _VALID_RITUALS = {"prepare", "debrief", "vent", "reset"}
        if active_ritual and active_ritual in _VALID_RITUALS:
            ritual_section = self._ritual_guidance(active_ritual, ritual_phase)
            safe_phase = html.escape(str(ritual_phase or "none"), quote=True)
            if ritual_section:
                sections.append(f"<ritual_guidance ritual=\"{active_ritual}\" phase=\"{safe_phase}\">\n{ritual_section}\n</ritual_guidance>")

        # Session context from companion artifact
        session_fields = {
            "session_goal": companion_artifact.get("session_goal"),
            "active_goal": companion_artifact.get("active_goal"),
            "takeaway": companion_artifact.get("takeaway"),
            "reflection": companion_artifact.get("reflection"),
        }
        context_lines = [f"- {k}: {v}" for k, v in session_fields.items() if v]
        if context_lines:
            sections.append("<session_context>\n" + "\n".join(context_lines) + "\n</session_context>")

        # Relevant memories (max 5)
        if relevant_memories:
            capped = relevant_memories[:5]
            memory_lines = [f"- {m}" for m in capped]
            sections.append("<memories>\n" + "\n".join(memory_lines) + "\n</memories>")

        # Task type
        sections.append(f"<task_type>{task_type}</task_type>")

        # Completion instruction
        sections.append(
            "<completion_instruction>\n"
            "You are not done until the companion has everything needed to share the deliverable.\n"
            "When the user-facing files are ready, call present_files for every final output in /mnt/user-data/outputs.\n"
            "Immediately after present_files, call emit_builder_artifact exactly once as your final action.\n"
            "Do not call bash, read_file, write_file, str_replace, web_search, web_fetch, or any other tool after emit_builder_artifact.\n"
            "If the files already exist and you know the summary, stop iterating and finish with emit_builder_artifact now.\n"
            "</completion_instruction>"
        )

        briefing = "<builder_briefing>\n" + "\n\n".join(sections) + "\n</builder_briefing>"

        blocks = list(state.get("system_prompt_blocks", []))
        blocks.append(briefing)

        log_middleware(
            "BuilderTask",
            f"task_type={task_type} tone={tone_estimate:.1f} ritual={active_ritual or 'none'}",
            _t0,
        )
        return {"system_prompt_blocks": blocks}

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _tone_guidance(tone_estimate: float, band: str) -> str:
        """Map tone_estimate to behavioral instructions for the builder."""
        if tone_estimate < 1.0 or band == "shutdown":
            return (
                "User is very low. Make ALL decisions yourself. Keep simple. "
                "Minimize user input. Quality over ambition."
            )
        if tone_estimate < 1.5 or band == "grief_fear":
            return (
                "User is low. Make most decisions. Keep clean. "
                "Deliverable should feel like relief."
            )
        if tone_estimate < 2.5 or band == "anger_antagonism":
            return (
                "User is frustrated. Be direct and efficient. No flourishes. "
                "Solve problems, don't flag them."
            )
        if tone_estimate < 3.5 or band == "engagement":
            return (
                "User has energy. Can be more ambitious. Include thoughtful details. "
                "1-2 decision points OK."
            )
        # tone >= 3.5 or enthusiasm
        return (
            "User is high energy. Be ambitious. Add surprise element. "
            "Don't play it safe."
        )

    @staticmethod
    def _resume_from_guidance(resume_context: dict) -> str | None:
        """Render a builder-facing briefing from resume_context.

        The block is meant to be read before the main task description and
        tell the builder:
          1. You are continuing a paused build — do NOT redo completed work.
          2. These files already exist in /mnt/user-data/outputs.
          3. Here is the summary of what was done, as context.

        Returns None when the context is too empty to be worth rendering.
        """
        completed_files = resume_context.get("completed_files") or []
        summary = resume_context.get("summary_of_done")
        if not completed_files and not summary:
            return None

        previous_task_id = resume_context.get("previous_task_id")
        previous_status = resume_context.get("previous_status")
        turns_used = resume_context.get("turns_used")
        turn_cap = resume_context.get("turn_cap")

        lines: list[str] = [
            "You are RESUMING a paused builder run. Read this carefully:",
            "",
            "- Do NOT redo work listed below. Open those files with read_file if",
            "  you need their contents, then continue with what is still missing.",
            "- Do NOT start from scratch. Build on top of completed_files.",
            "- Finish with emit_builder_artifact when the deliverable is ready.",
        ]
        if previous_task_id:
            lines.append(f"- previous_task_id: {html.escape(str(previous_task_id), quote=True)}")
        if previous_status:
            lines.append(f"- previous_status: {html.escape(str(previous_status), quote=True)}")
        if turns_used is not None and turn_cap is not None:
            lines.append(f"- previous_turns: {turns_used}/{turn_cap}")

        if completed_files:
            lines.append("- completed_files:")
            for path in completed_files[:25]:
                lines.append(f"    - {html.escape(str(path), quote=True)}")
            if len(completed_files) > 25:
                lines.append(f"    - … and {len(completed_files) - 25} more")

        if summary:
            safe_summary = html.escape(str(summary), quote=True)
            lines.append("- summary_of_done:")
            lines.append(f"    {safe_summary}")

        return "\n".join(lines)

    @staticmethod
    def _ritual_guidance(ritual: str, phase: str | None) -> str | None:
        """Map active ritual to builder behavioral guidance."""
        guidance_map: dict[str, str] = {
            "prepare": (
                "User is getting ready for something important. "
                "Output should feel like armor, not homework."
            ),
            "debrief": (
                "User is processing what happened. Structure around "
                "what happened \u2192 what worked \u2192 what didn't \u2192 what's next."
            ),
            "vent": (
                "User moved from venting to action. Keep simple. "
                "Don't add complexity."
            ),
            "reset": (
                "User is clearing the deck. Output should feel clean "
                "and forward-looking."
            ),
        }
        return guidance_map.get(ritual)
