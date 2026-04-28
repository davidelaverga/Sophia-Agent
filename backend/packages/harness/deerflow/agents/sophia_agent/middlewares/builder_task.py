"""Builder task middleware.

Translates the companion's emotional context into behavioral guidance
for the builder agent. Reads ``delegation_context`` from the runtime
config and injects a ``<builder_briefing>`` block into
``system_prompt_blocks``.
"""

import html
import logging
import time
from pathlib import Path
from typing import Any, NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langgraph.runtime import Runtime

from deerflow.agents.sophia_agent.utils import log_middleware

logger = logging.getLogger(__name__)


# PR #94: max number of files to enumerate in the CRITICAL endgame block.
# Keeps the prompt budget bounded even on chaotic builds with dozens of
# scratch files; the model only needs the most recently-modified
# candidates to pick a path.
_ENDGAME_MAX_FILES = 10


def _list_outputs_for_prompt(state: "BuilderTaskState") -> list[dict[str, Any]]:
    """Return up to ``_ENDGAME_MAX_FILES`` recent files in the builder's
    ``outputs/`` directory, sorted by mtime descending.

    Each entry is a dict with ``path`` (virtual sandbox path under
    ``/mnt/user-data/outputs/``), ``size_bytes``, ``mtime``, and a
    ``category`` that flags how the model should treat the file
    (``"deliverable"``, ``"generator"``, or ``"intermediate"``).

    Same staleness filtering as ``BuilderArtifactMiddleware._has_output_file``
    — files modified before ``builder_task_started_at_ms - 5s`` are ignored
    so a prior task's leftovers aren't surfaced as candidates.

    Returns an empty list when ``outputs_path`` is missing, the directory
    doesn't exist, or the scan fails (best-effort — never blocks the
    prompt assembly).
    """
    thread_data = state.get("thread_data") or {}
    outputs_host_path = (
        thread_data.get("outputs_path") if isinstance(thread_data, dict) else None
    )
    if not isinstance(outputs_host_path, str) or not outputs_host_path:
        return []

    builder_task_started_at_ms = state.get("builder_task_started_at_ms")
    min_mtime: float | None = None
    if isinstance(builder_task_started_at_ms, (int, float)) and builder_task_started_at_ms > 0:
        min_mtime = (float(builder_task_started_at_ms) / 1000.0) - 5.0

    _DELIVERABLE_EXTS = {
        ".pdf", ".pptx", ".docx", ".xlsx",
        ".png", ".jpg", ".jpeg", ".svg",
        ".html", ".zip",
    }
    _INTERMEDIATE_EXTS = {".json", ".csv", ".tsv", ".txt"}

    try:
        outputs_root = Path(outputs_host_path)
        if not outputs_root.is_dir():
            return []
        candidates: list[tuple[Path, float]] = []
        for entry in outputs_root.rglob("*"):
            if not entry.is_file():
                continue
            if entry.name.startswith("."):
                continue
            stat = entry.stat()
            if min_mtime is not None and stat.st_mtime < min_mtime:
                continue
            candidates.append((entry, stat.st_mtime))
        candidates.sort(key=lambda pair: pair[1], reverse=True)
    except OSError:
        logger.debug(
            "BuilderTask._list_outputs_for_prompt: scan failed for outputs_path=%s",
            outputs_host_path,
            exc_info=True,
        )
        return []

    listing: list[dict[str, Any]] = []
    for path, mtime in candidates[:_ENDGAME_MAX_FILES]:
        rel = path.relative_to(outputs_root).as_posix()
        suffix = path.suffix.lower()
        name = path.name
        if name.startswith("_generate") and suffix == ".py":
            category = "generator"
        elif suffix in _DELIVERABLE_EXTS:
            category = "deliverable"
        elif suffix in _INTERMEDIATE_EXTS or name.startswith("_"):
            category = "intermediate"
        else:
            # Unknown extension — treat as a possible deliverable rather
            # than intermediate. Markdown/text reports written without an
            # explicit ``.md`` (rare) fall here too.
            category = "deliverable"
        try:
            size = path.stat().st_size
        except OSError:
            size = 0
        listing.append(
            {
                "path": f"/mnt/user-data/outputs/{rel}",
                "size_bytes": int(size),
                "mtime": float(mtime),
                "category": category,
            }
        )
    return listing


def _format_size(num_bytes: int) -> str:
    """Format a byte count for the prompt — concise but readable."""
    if num_bytes < 1024:
        return f"{num_bytes} B"
    if num_bytes < 1024 * 1024:
        return f"{num_bytes / 1024:.1f} KB"
    return f"{num_bytes / (1024 * 1024):.1f} MB"


def _format_age(now_s: float, mtime: float) -> str:
    delta = max(0.0, now_s - mtime)
    if delta < 60:
        return f"{int(delta)}s ago"
    if delta < 3600:
        return f"{int(delta / 60)}m ago"
    return f"{int(delta / 3600)}h ago"


class BuilderTaskState(AgentState):
    system_prompt_blocks: NotRequired[list[str]]
    delegation_context: NotRequired[dict | None]
    builder_non_artifact_turns: NotRequired[int]
    builder_last_tool_names: NotRequired[list[str]]
    # NOTE: builder_search_sources is NOT redeclared here. SophiaState already
    # declares it with the `_merge_search_sources` reducer; redeclaring it as
    # plain `NotRequired[list[dict]]` would shadow that reducer via
    # langchain.agents.create_agent's set-based schema merge, downgrade the
    # channel to LastValue, and crash parallel `builder_web_search` /
    # `builder_web_fetch` writes. The
    # `tests/test_sophia_state_schema_invariants.py` guard locks this.
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

        # Wall-clock budget awareness — sourced from extra_configurable which
        # SubagentExecutor merges into initial state (see executor.py:835).
        # ``builder_task_kickoff_ms`` is the queue-time fallback for the very
        # first turn before BuilderArtifactMiddleware has had a chance to
        # write ``builder_task_started_at_ms``. Both keys are missing for
        # non-builder agents that don't opt in, in which case the wall-clock
        # prompt fragment is suppressed and behavior is identical to today.
        builder_timeout_seconds = 0
        raw_timeout = state.get("builder_timeout_seconds")
        if isinstance(raw_timeout, (int, float)) and raw_timeout > 0:
            builder_timeout_seconds = int(raw_timeout)
        started_ms = state.get("builder_task_started_at_ms") or 0
        if not isinstance(started_ms, (int, float)) or started_ms <= 0:
            started_ms = state.get("builder_task_kickoff_ms") or 0
        wall_clock_pct: int | None = None
        wall_clock_elapsed_s: int | None = None
        if (
            builder_timeout_seconds > 0
            and isinstance(started_ms, (int, float))
            and started_ms > 0
        ):
            elapsed_ms = max(0, int(time.time() * 1000) - int(started_ms))
            wall_clock_elapsed_s = int(elapsed_ms / 1000)
            wall_clock_pct = int(round(elapsed_ms / (builder_timeout_seconds * 1000) * 100))

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
        sections.append(
            "<output_contract>\n"
            "- Write every user-facing deliverable and supporting file under /mnt/user-data/outputs/ using absolute paths.\n"
            "- Do NOT use relative paths like outputs/report.md or ./outputs/report.md.\n"
            "- When you call emit_builder_artifact, artifact_path and supporting_files must use the same /mnt/user-data/outputs/... absolute paths.\n"
            "</output_contract>"
        )

        sections.append(
            "<preinstalled_libraries>\n"
            "The sandbox already has these Python libraries installed. Import them directly — do NOT run pip install:\n"
            "- PDF: reportlab, fpdf2 (fpdf), pypdf\n"
            "- Office: python-pptx (pptx), python-docx (docx), openpyxl\n"
            "- Images: pillow (PIL)\n"
            "- Charts / data: matplotlib, seaborn, numpy, pandas, duckdb\n"
            "- Other: markdown, requests, httpx\n"
            "If you ever see ModuleNotFoundError for one of these, the import path is wrong — check the module name above. "
            "Never call `pip install` via bash_tool; it wastes your turn budget.\n"
            "</preinstalled_libraries>"
        )

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

        # Completion instruction — always present, includes budget so the model
        # plans from turn 0 instead of discovering the limit mid-loop.
        # MUST stay in sync with BuilderArtifactMiddleware._CEILING_FOR_FORCE in
        # builder_artifact.py — otherwise the model's budget math lies and it
        # over-commits to retries past its advertised limit.
        # PR-B (2026-04-28): bumped 20 → 30 so binary deliverables (PDF/PPTX
        # with diagrams) have room for write→bash→fix cycles before being
        # forced to emit. See builder_artifact.py for the full rationale.
        _HARD_CEILING = 30
        remaining = max(_HARD_CEILING - non_artifact_turns, 0)

        wall_clock_line = ""
        if wall_clock_pct is not None and wall_clock_elapsed_s is not None:
            wall_clock_line = (
                f"Wall-clock budget: {wall_clock_elapsed_s}s of {builder_timeout_seconds}s used "
                f"({wall_clock_pct}%). Once you cross 70% of the wall-clock budget, your NEXT action "
                "MUST be emit_builder_artifact regardless of remaining turn count. Each long write "
                "costs 90+ seconds of LLM output, so re-writing the same file twice burns the budget.\n"
            )

        sections.append(
            "<completion_instruction>\n"
            f"You have a STRICT budget of {_HARD_CEILING} tool-call turns total. "
            f"Currently on turn {non_artifact_turns}/{_HARD_CEILING} ({remaining} remaining).\n"
            f"{wall_clock_line}"
            "Plan your work to fit within this budget:\n"
            "- Turn 1: call write_todos with a short plan (3–5 steps) so the UI can track progress.\n"
            "- For text deliverables (markdown, html, plain text, code): write the complete file in a single "
            "write_file_tool call. Do NOT split the same file across multiple write_file_tool calls and do NOT "
            "call write_file_tool repeatedly to the same path — overwriting a long document costs 90+ seconds "
            "per turn and burns the wall-clock budget. If output risks exceeding the write budget, ship a "
            "tighter draft instead of fragmenting.\n"
            "- For binary deliverables (pdf, pptx, docx, xlsx, png): the DELIVERABLE IS THE BINARY, NOT THE SCRIPT. You MUST:\n"
            "    (a) Turn 2: write ONE generator script to /mnt/user-data/outputs/_generate_<name>.py that produces "
            "the whole binary end-to-end. Keep the script under 120 lines with minimal styling — a tight script "
            "generates 3-5x faster than an elaborate one, and time saved here is time you have to recover from "
            "errors. If content risks exceeding ~120 lines, split into data.json + a short generator script in two "
            "sequential write_file_tool calls.\n"
            "    (b) Turn 3: run it with bash_tool (e.g. `python /mnt/user-data/outputs/_generate_<name>.py`). This step is MANDATORY — skipping it leaves the user with a useless .py file.\n"
            "    (c) Turn 4: verify the binary exists with ls_tool on /mnt/user-data/outputs/. If the binary is "
            "missing or bash_tool returned an error, fix the script and re-run — BUT at most 2 fix-and-retry cycles. "
            "After 2 failed retries, call emit_builder_artifact with whatever partial deliverable is on disk "
            "(the generator .py or a degraded binary), set confidence<=0.5, and put a clear explanation in "
            "companion_tone_hint. NEVER exit without calling emit_builder_artifact.\n"
            "    (d) emit_builder_artifact.artifact_path MUST point to the BINARY file (e.g. .pdf, .pptx, .png) — "
            "never to the generator .py script. The .py may appear in supporting_files, but artifact_path must be "
            "the final deliverable the user asked for.\n"
            "    Libraries listed in <preinstalled_libraries> are already available — do NOT pip install.\n"
            "- After each meaningful step (write_file, successful bash run), call write_todos again to mark the "
            "corresponding item 'completed' or 'in-progress'. This is how the user sees the progress bar advance — "
            "skipping these updates leaves the UI stuck.\n"
            "- Make targeted edits only if critical fixes are needed.\n"
            "- Final turn: Call emit_builder_artifact. This is MANDATORY — without it your work is lost.\n"
            "Do NOT iterate endlessly to perfect the output. Ship a complete first draft, then finalize.\n"
            "</completion_instruction>"
        )

        if non_artifact_turns > 0:
            joined_tools = ", ".join(recent_tool_names) if recent_tool_names else "unknown"
            escalation = (
                "<builder_endgame>\n"
                f"Turn budget: {non_artifact_turns}/{_HARD_CEILING} used. "
                f"{remaining} turn(s) remaining before forced termination.\n"
                f"Most recent tool calls: {joined_tools}.\n"
            )
            if wall_clock_pct is not None and wall_clock_elapsed_s is not None:
                escalation += (
                    f"Wall-clock: {wall_clock_elapsed_s}s of {builder_timeout_seconds}s used "
                    f"({wall_clock_pct}%).\n"
                )
            # PR-A (2026-04-27): thresholds rescaled for the bumped ceiling
            # (10 → 20). Same proportions as before — CRITICAL at the last
            # ~15% of the budget (remaining<=3), WARNING at the last ~30%
            # (remaining<=6) so the model gets graduated wrap-up pressure.
            #
            # Wall-clock-aware promotion: when the per-run wall-clock budget
            # has crossed 70%, escalate to CRITICAL even if turn-count
            # remaining > 3. This matches BuilderArtifactMiddleware's
            # _FORCE_EMIT_WALL_CLOCK_FRACTION so the prompt and the API-level
            # tool_choice forcing agree.
            wall_clock_critical = (
                wall_clock_pct is not None
                and wall_clock_pct >= 70
            )
            if remaining <= 3 or wall_clock_critical:
                escalation += (
                    "CRITICAL: You are about to be terminated. "
                    "Your NEXT action MUST be emit_builder_artifact — DO NOT call write_todos, "
                    "write_file, bash_tool, or any other tool on this turn. "
                    "Ship what you have NOW, even if partial. "
                    "Use artifact_path pointing to the best file that exists on disk; "
                    "if only a generator .py exists, emit that with confidence<=0.4 and "
                    "explain in companion_tone_hint.\n"
                    "Do NOT emit with artifact_path=null. If you cannot decide, pick the "
                    "first file marked 'deliverable' (or 'generator' if no deliverable exists) "
                    "from the list below.\n"
                )
                # PR #94: enumerate actual files in outputs/ so the model
                # can pick a real path under tool_choice pressure instead
                # of emitting artifact_path=null. Run ``675c2c35`` (PDF +
                # diagrams) ended in a GraphRecursionError because the
                # model emitted None repeatedly under forced emit; giving
                # it a concrete file list eliminates that guessing step.
                outputs_listing = _list_outputs_for_prompt(state)
                if outputs_listing:
                    now_s = time.time()
                    file_lines: list[str] = []
                    has_deliverable = any(
                        item["category"] == "deliverable" for item in outputs_listing
                    )
                    has_generator = any(
                        item["category"] == "generator" for item in outputs_listing
                    )
                    for item in outputs_listing:
                        size_str = _format_size(item["size_bytes"])
                        age_str = _format_age(now_s, item["mtime"])
                        if item["category"] == "deliverable":
                            tag = "← preferred (final deliverable)"
                            if has_deliverable:
                                # Mark only the most recent deliverable as preferred.
                                # After we tag the first one, downgrade the rest.
                                has_deliverable = False
                            else:
                                tag = "(another deliverable)"
                        elif item["category"] == "generator":
                            if not has_deliverable and has_generator:
                                tag = "(generator script — emit with confidence<=0.4 if no deliverable works)"
                                has_generator = False
                            else:
                                tag = "(generator script)"
                        else:
                            tag = "(intermediate — do NOT emit as final)"
                        file_lines.append(
                            f"  - {item['path']}  ({size_str}, modified {age_str})  {tag}"
                        )
                    escalation += (
                        "Files currently in /mnt/user-data/outputs/ that you may emit:\n"
                        + "\n".join(file_lines)
                        + "\n"
                    )
                else:
                    escalation += (
                        "No files were detected in /mnt/user-data/outputs/. "
                        "Emit with artifact_path=null is INVALID — "
                        "write at least one file before emit_builder_artifact, "
                        "or accept the force-stop fallback.\n"
                    )
            elif remaining <= 6:
                escalation += (
                    "WARNING: Running low on turns. Wrap up edits and call "
                    "emit_builder_artifact within the next 1-2 turns. "
                    "Stop re-planning with write_todos; that wastes a turn.\n"
                )
            else:
                escalation += (
                    "If the deliverable is ready, your NEXT action must be emit_builder_artifact.\n"
                )
            escalation += (
                "Do not end with plain text and do not call any tools after emit_builder_artifact.\n"
                "</builder_endgame>"
            )
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
