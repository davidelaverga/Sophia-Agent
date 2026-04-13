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
    builder_non_artifact_turns: NotRequired[int]
    builder_last_tool_names: NotRequired[list[str]]
    builder_search_sources: NotRequired[list[dict]]
    allow_web_research: NotRequired[bool]


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
        allow_web_research = bool(
            state.get("allow_web_research", delegation_context.get("allow_web_research", False))
        )
        tracked_sources = [
            source for source in (state.get("builder_search_sources") or []) if isinstance(source, dict)
        ]
        non_artifact_turns = int(state.get("builder_non_artifact_turns", 0) or 0)
        recent_tool_names = [
            str(name).strip()
            for name in (state.get("builder_last_tool_names") or [])
            if str(name).strip()
        ]

        # --- Build briefing sections ---
        sections: list[str] = []

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

        if task_type == "research":
            sections.append(
                "<research_output_requirements>\n"
                "- For factual claims from external sources, use inline citations in the format [citation:Title](URL).\n"
                "- End the report with a Sources section using [Title](URL) - note format.\n"
                "- emit_builder_artifact.sources_used must include structured {title, url} entries for the sources you actually used.\n"
                "</research_output_requirements>"
            )
        elif allow_web_research:
            sections.append(
                "<source_output_requirements>\n"
                "- If you use external sources, include a concise Sources appendix in the deliverable or create a small sidecar markdown file.\n"
                "- emit_builder_artifact.sources_used must include structured {title, url} entries for the sources you actually used.\n"
                "</source_output_requirements>"
            )

        if tracked_sources:
            source_lines = [
                f"- {source.get('title', source.get('url', 'Untitled'))} — {source.get('url', '')}"
                for source in tracked_sources[:8]
            ]
            sections.append("<tracked_sources>\n" + "\n".join(source_lines) + "\n</tracked_sources>")

        # Completion instruction
        sections.append(
            "<completion_instruction>\n"
            "When your work is done, you MUST call emit_builder_artifact as your final action.\n"
            "</completion_instruction>"
        )

        if non_artifact_turns > 0:
            joined_tools = ", ".join(recent_tool_names) if recent_tool_names else "unknown"
            escalation = (
                "<builder_endgame>\n"
                f"You already produced {non_artifact_turns} tool-call turn(s) without emit_builder_artifact.\n"
                f"Most recent tool calls: {joined_tools}.\n"
                "If the deliverable is ready, your NEXT action must be emit_builder_artifact.\n"
                "Do not end with plain text and do not call any tools after emit_builder_artifact.\n"
            )
            if non_artifact_turns >= 2:
                escalation += (
                    "Only call another build tool if a critical output file is still missing. "
                    "Otherwise finalize now with emit_builder_artifact.\n"
                )
            escalation += "</builder_endgame>"
            sections.append(escalation)

        briefing = "<builder_briefing>\n" + "\n\n".join(sections) + "\n</builder_briefing>"

        blocks = list(state.get("system_prompt_blocks", []))
        blocks.append(briefing)

        log_middleware(
            "BuilderTask",
            f"task_type={task_type} tone={tone_estimate:.1f} ritual={active_ritual or 'none'} "
            f"non_artifact_turns={non_artifact_turns}",
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
