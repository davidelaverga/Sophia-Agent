"""Builder task middleware.

Translates the companion's emotional context into behavioral guidance
for the builder agent. Reads ``delegation_context`` from the runtime
config and injects a ``<builder_briefing>`` block into
``system_prompt_blocks``.

Also injects task-type-aware skill files (e.g. ``chart-visualization``
for visual_report) so the builder has the domain reference material it
needs for the requested deliverable type.
"""

import html
import logging
import time
from pathlib import Path
from typing import Any, NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langgraph.runtime import Runtime

from deerflow.agents.sophia_agent.paths import SKILLS_PATH
from deerflow.agents.sophia_agent.utils import log_middleware

logger = logging.getLogger(__name__)

# Mapping from task_type (as sent by the companion) to the list of skill
# directory names under ``skills/public/`` that the builder should have in
# context. Only SKILL.md is loaded per skill — references/ and scripts/
# subdirectories stay on disk and can be opened via read_file as needed.
# ``document`` deliberately maps to no extra skills: the base sandbox tools
# and the companion-supplied brief are enough for plain document writing.
TASK_TYPE_SKILLS: dict[str, list[str]] = {
    "research": ["chart-visualization", "data-analysis", "deep-research"],
    "visual_report": ["chart-visualization", "data-analysis"],
    "presentation": ["chart-visualization", "frontend-design"],
    "frontend": ["frontend-design"],
    "document": [],
}

# Default skills root: ``/skills/public/`` — the parent of the sophia
# skill bundle (``SKILLS_PATH``). Computed lazily so tests can override via
# ``BuilderTaskMiddleware(skills_root=...)``.
_DEFAULT_SKILLS_ROOT = SKILLS_PATH.parent


class BuilderTaskState(AgentState):
    system_prompt_blocks: NotRequired[list[str]]
    delegation_context: NotRequired[dict | None]


class BuilderTaskMiddleware(AgentMiddleware[BuilderTaskState]):
    """Inject builder briefing derived from companion delegation context.

    When the companion delegates a task with ``task_type="research"`` (for
    example), the middleware also reads the relevant skill files and
    prepends them as separate ``system_prompt_blocks`` entries so the
    builder has the domain guidance it needs (chart conventions,
    data-analysis patterns, deep-research protocol, etc.).
    """

    state_schema = BuilderTaskState

    def __init__(
        self,
        *,
        skills_root: Path | None = None,
        task_type_skills: dict[str, list[str]] | None = None,
    ) -> None:
        super().__init__()
        self.skills_root = skills_root or _DEFAULT_SKILLS_ROOT
        self.task_type_skills = task_type_skills if task_type_skills is not None else TASK_TYPE_SKILLS

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

        # --- Load task-type-aware skill files ---
        # These are injected as their own blocks BEFORE the builder_briefing
        # so the briefing can reference them by name without the model
        # scrolling back.
        skill_blocks: list[str] = []
        skill_names_loaded: list[str] = []
        for skill_name in self.task_type_skills.get(task_type, []):
            content = self._read_skill_file(skill_name)
            if content is None:
                continue
            skill_blocks.append(
                f"<builder_skill name=\"{html.escape(skill_name, quote=True)}\">\n"
                f"{content}\n"
                f"</builder_skill>"
            )
            skill_names_loaded.append(skill_name)

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
        # Skill blocks are appended before the briefing so the briefing can
        # reference them. Both stay grouped after whatever upstream files
        # (soul, voice, techniques, AGENTS.md) already wrote.
        blocks.extend(skill_blocks)
        blocks.append(briefing)

        skills_summary = ",".join(skill_names_loaded) if skill_names_loaded else "none"
        log_middleware(
            "BuilderTask",
            f"task_type={task_type} tone={tone_estimate:.1f} ritual={active_ritual or 'none'} "
            f"skills={skills_summary}",
            _t0,
        )
        return {"system_prompt_blocks": blocks}

    def _read_skill_file(self, skill_name: str) -> str | None:
        """Return the contents of ``<skills_root>/<skill_name>/SKILL.md``.

        Returns ``None`` and logs a warning if the file is missing so that
        a packaging gap (e.g. a skill removed from disk) degrades into a
        smaller prompt rather than crashing the builder.
        """
        path = self.skills_root / skill_name / "SKILL.md"
        if not path.is_file():
            logger.warning(
                "[BuilderTask] skill file missing: %s (skill=%s)",
                path,
                skill_name,
            )
            return None
        try:
            return path.read_text(encoding="utf-8")
        except OSError as exc:
            logger.warning(
                "[BuilderTask] failed to read skill file %s: %s",
                path,
                exc,
            )
            return None

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
