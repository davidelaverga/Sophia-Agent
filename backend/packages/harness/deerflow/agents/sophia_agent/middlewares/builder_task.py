"""Builder task middleware.

Translates the companion's emotional context into behavioral guidance
for the builder agent. Reads ``delegation_context`` from the runtime
config and injects a ``<builder_briefing>`` block into
``system_prompt_blocks``.

Two invocation paths:

- **Companion-subagent path** (existing): ``start_builder_task.py`` builds
  ``delegation_context`` from the companion's session state and seeds it
  on the builder's input. This middleware reads it as-is.
- **Builder-as-Main path** (Stage 1 of Phase-3 Telegram diagnostic): the
  ``TelegramWorkChannel`` invokes Builder directly via ``runs.wait`` with
  no ``delegation_context``. ``abefore_agent`` detects the missing dict,
  runs a single Haiku classifier call (``_classify_brief``) to produce
  ``{task_type, demo_mode, normalized_brief}``, and synthesises a
  ``delegation_context`` matching the companion-side shape so the rest of
  the chain (``BuilderResearchPolicyMiddleware``, etc.) reads identical
  fields downstream.

Spec: ``docs/specs/sophia_builder_as_main_work_bot_spec.md`` §6.
"""

from __future__ import annotations

import html
import json
import logging
import os
import time
from pathlib import Path
from typing import Any, NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langgraph.runtime import Runtime

from deerflow.agents.sophia_agent.utils import log_middleware

logger = logging.getLogger(__name__)


# Synthetic-delegation branch (Builder-as-Main / Work bot DM path).
_SYNTHETIC_DELEGATION_SOURCE = "work_bot_dm"
_BRIEF_CLASSIFICATION_MODEL = "claude-haiku-4-5-20251001"
_BRIEF_CLASSIFICATION_MAX_TOKENS = 512
_BRIEF_CLASSIFICATION_PROMPT_PATH = (
    Path(__file__).resolve().parent.parent / "prompts" / "builder_brief_classification.md"
)
_NORMALIZED_BRIEF_MAX_CHARS = 500
_VALID_BRIEF_TASK_TYPES = (
    "research", "code", "writing", "data_analysis", "visual", "other",
)


# PR #94: max number of files to enumerate in the CRITICAL endgame block.
# Keeps the prompt budget bounded even on chaotic builds with dozens of
# scratch files; the model only needs the most recently-modified
# candidates to pick a path.
_ENDGAME_MAX_FILES = 10

# Task types that hit the image-generation skill (directly or via the
# ppt-generation orchestration). When OPENAI_API_KEY is missing, builds of
# these types loop for ~21 minutes until the hard turn cap fires; the
# pre-flight gate below short-circuits to a clean missing-capability emit
# within ~1 turn instead.
_VISUAL_TASK_TYPES = frozenset({"presentation", "visual_report"})


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
        # Match the same prefix the rest of the builder pipeline uses
        # for generator scripts (``_generate_<name>.py``). The trailing
        # underscore is load-bearing — without it any name starting with
        # ``_generate`` (rare but possible scratch file) would be tagged
        # as a generator. Stays in sync with
        # ``BuilderArtifactMiddleware._has_generator_script``.
        if name.startswith("_generate_") and suffix == ".py":
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
    """Inject builder briefing derived from companion delegation context.

    On the Builder-as-Main path (no companion in front), the async hook
    ``abefore_agent`` synthesises a ``delegation_context`` via a single
    Haiku classification call before delegating to the sync rendering
    logic in ``before_agent``. See module docstring for the two paths.
    """

    state_schema = BuilderTaskState

    @override
    async def abefore_agent(
        self, state: BuilderTaskState, runtime: Runtime
    ) -> dict | None:
        """Async hook — synthesise delegation_context if missing, then render.

        - When ``delegation_context`` is already populated (companion path),
          this short-circuits to the sync rendering path with no Haiku call.
        - When missing (Builder-as-Main / Work bot DM path), runs the
          classifier, persists ``delegation_context`` into state, then
          calls the sync render so the ``<builder_briefing>`` block is
          appended to ``system_prompt_blocks`` in this same turn.
        """
        delegation = state.get("delegation_context")
        synthesized: dict[str, Any] | None = None

        if not delegation:
            last_human = self._extract_last_human_text(state)
            if not last_human:
                logger.warning(
                    "builder_task.no_human_message thread_id=%s",
                    self._resolve_thread_id(runtime),
                )
                # Let the sync path early-return on empty delegation. The
                # builder's first turn will likely ask a clarifying
                # question; better than crashing.
                return self.before_agent(state, runtime)

            classification = await self._classify_brief(last_human)
            synthesized = {
                "task_brief": classification["normalized_brief"],
                "task_type": classification["task_type"],
                "demo_mode": classification["demo_mode"],
                "normalized_brief": classification["normalized_brief"],
                "source": _SYNTHETIC_DELEGATION_SOURCE,
                "parent_thread_id": None,  # D3 — Builder-as-Main mode marker
                "companion_artifact": None,
                "active_ritual": None,
                "ritual_phase": None,
                "memories_for_builder": None,
                "relevant_memories": [],
                "allow_web_research": False,  # Policy MW will reconsider per task_type
            }
            # Mutate state so the sync render below sees it. Returning a
            # dict from this hook merges into state before the next hook
            # runs, but we also want this turn's render to use the
            # synthesised context.
            state["delegation_context"] = synthesized

            logger.info(
                "builder_task.synthetic_delegation thread_id=%s task_type=%s demo_mode=%s brief_len=%d",
                self._resolve_thread_id(runtime),
                synthesized["task_type"],
                synthesized["demo_mode"],
                len(synthesized["normalized_brief"]),
            )

        # Delegate to the sync rendering path so the briefing block is
        # appended in the same turn as the synthesis.
        rendered = self.before_agent(state, runtime)

        if synthesized is None:
            return rendered

        # Merge the synthesised delegation_context into the returned dict
        # so the state update lands atomically. ``before_agent`` returns
        # ``{"system_prompt_blocks": [...]}`` or None; combine both.
        result: dict[str, Any] = {"delegation_context": synthesized}
        if isinstance(rendered, dict):
            result.update(rendered)
        return result

    async def _classify_brief(self, user_brief: str) -> dict[str, Any]:
        """Single Haiku call → ``{task_type, demo_mode, normalized_brief}``.

        Uses Anthropic's tool-call structured output (same reason
        ``emit_artifact`` does) so we get guaranteed-valid JSON instead of
        parsing free-form text. Falls back to a conservative default on
        any failure so the run never crashes here.

        Cost: ~$0.0001 per call (Haiku, ~1k input + ~200 output tokens).
        Latency: ~200-400ms p95.
        """
        fallback = {
            "task_type": "other",
            "demo_mode": False,
            "normalized_brief": user_brief.strip()[:_NORMALIZED_BRIEF_MAX_CHARS],
        }

        api_key = (os.environ.get("ANTHROPIC_API_KEY") or "").strip()
        if not api_key:
            logger.warning("builder_task.classify_no_api_key — using fallback")
            return fallback

        try:
            template = _BRIEF_CLASSIFICATION_PROMPT_PATH.read_text(encoding="utf-8")
        except OSError:
            logger.warning(
                "builder_task.classify_template_missing path=%s — using fallback",
                _BRIEF_CLASSIFICATION_PROMPT_PATH,
                exc_info=True,
            )
            return fallback

        prompt = template.replace("{user_brief}", user_brief.strip())

        try:
            from anthropic import AsyncAnthropic
        except ImportError:
            logger.warning("builder_task.classify_anthropic_missing — using fallback")
            return fallback

        try:
            client = AsyncAnthropic(api_key=api_key)
            response = await client.messages.create(
                model=_BRIEF_CLASSIFICATION_MODEL,
                max_tokens=_BRIEF_CLASSIFICATION_MAX_TOKENS,
                messages=[{"role": "user", "content": prompt}],
                tools=[{
                    "name": "classify_brief",
                    "description": "Return classification fields for the brief.",
                    "input_schema": {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["task_type", "demo_mode", "normalized_brief"],
                        "properties": {
                            "task_type": {
                                "type": "string",
                                "enum": list(_VALID_BRIEF_TASK_TYPES),
                                "description": "Top-level Builder task category.",
                            },
                            "demo_mode": {
                                "type": "boolean",
                                "description": "True when the user is testing/exploring rather than requesting real work.",
                            },
                            "normalized_brief": {
                                "type": "string",
                                "description": "1-3 sentence cleaned-up restatement of the user's request, ≤500 chars.",
                            },
                        },
                    },
                }],
                tool_choice={"type": "tool", "name": "classify_brief"},
            )
        except Exception as exc:
            logger.warning(
                "builder_task.classify_call_failed error=%s — using fallback",
                type(exc).__name__,
                exc_info=True,
            )
            return fallback

        for block in getattr(response, "content", []) or []:
            block_type = getattr(block, "type", None)
            block_name = getattr(block, "name", None)
            if block_type == "tool_use" and block_name == "classify_brief":
                payload = getattr(block, "input", None)
                if isinstance(payload, str):
                    try:
                        payload = json.loads(payload)
                    except json.JSONDecodeError:
                        payload = None
                if isinstance(payload, dict):
                    return self._validate_classification(payload, user_brief)

        logger.warning("builder_task.classify_no_tool_use_block — using fallback")
        return fallback

    @staticmethod
    def _validate_classification(payload: dict[str, Any], user_brief: str) -> dict[str, Any]:
        """Normalise classifier output to the canonical shape, with safe defaults."""
        task_type = payload.get("task_type")
        if task_type not in _VALID_BRIEF_TASK_TYPES:
            task_type = "other"

        demo_mode = bool(payload.get("demo_mode", False))

        normalized_brief = payload.get("normalized_brief")
        if not isinstance(normalized_brief, str) or not normalized_brief.strip():
            normalized_brief = user_brief.strip()
        normalized_brief = normalized_brief.strip()[:_NORMALIZED_BRIEF_MAX_CHARS]

        return {
            "task_type": task_type,
            "demo_mode": demo_mode,
            "normalized_brief": normalized_brief,
        }

    @staticmethod
    def _extract_last_human_text(state: BuilderTaskState) -> str | None:
        """Return the text content of the last human message, or None."""
        for msg in reversed(state.get("messages") or []):
            msg_type = getattr(msg, "type", None) or getattr(msg, "role", None)
            content = getattr(msg, "content", None)
            if msg_type is None and isinstance(msg, dict):
                msg_type = msg.get("type") or msg.get("role")
                content = msg.get("content")
            if msg_type not in {"human", "user"}:
                continue
            if isinstance(content, str) and content.strip():
                return content.strip()
            if isinstance(content, list):
                parts: list[str] = []
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "text":
                        parts.append(str(block.get("text", "")))
                    elif isinstance(block, str):
                        parts.append(block)
                text = "".join(parts).strip()
                if text:
                    return text
        return None

    @staticmethod
    def _resolve_thread_id(runtime: Runtime) -> str | None:
        """Best-effort thread_id extraction for log lines."""
        if runtime is None:
            return None
        try:
            ctx = getattr(runtime, "context", None) or {}
            if isinstance(ctx, dict) and ctx.get("thread_id"):
                return str(ctx["thread_id"])
        except Exception:
            pass
        try:
            cfg = getattr(runtime, "config", None) or {}
            configurable = cfg.get("configurable", {}) if isinstance(cfg, dict) else {}
            if isinstance(configurable, dict) and configurable.get("thread_id"):
                return str(configurable["thread_id"])
        except Exception:
            pass
        return None

    @override
    def before_agent(self, state: BuilderTaskState, runtime: Runtime) -> dict | None:
        _t0 = time.perf_counter()

        delegation_context: dict[str, Any] = state.get("delegation_context") or {}

        if not delegation_context:
            log_middleware("BuilderTask", "no delegation_context", _t0)
            return None

        # ``or {}`` handles the Builder-as-Main synthesised path where
        # ``companion_artifact`` is explicitly None (no companion to source it
        # from). Spec Appendix B shows the canonical synthesised shape.
        companion_artifact: dict[str, Any] = delegation_context.get("companion_artifact") or {}
        task_type: str = delegation_context.get("task_type", "unknown")
        relevant_memories: list[str] = delegation_context.get("relevant_memories") or []
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

        # Pre-flight gate: when this build will need image-generation but the
        # required API key isn't configured, tell the model to STOP rather
        # than burning 30 turns on a doomed loop. Spec-aligned per
        # AGENTS.md: "When the task cannot be completed because a required
        # capability is missing, STOP — do not loop retrying the same
        # command. Call emit_builder_artifact with low confidence and
        # explain the missing capability in companion_summary."
        api_key = (os.environ.get("OPENAI_API_KEY") or "").strip()
        if task_type in _VISUAL_TASK_TYPES and not api_key:
            sections.append(
                "<missing_capability>\n"
                "OPENAI_API_KEY is not set in this environment. The image-generation skill "
                "(used directly and by ppt-generation) cannot run. DO NOT attempt to write "
                "your own python-pptx / matplotlib / Pillow code as a workaround — that path "
                "consumes the turn budget without producing a viable deliverable.\n"
                "STOP IMMEDIATELY. On your NEXT tool call, emit_builder_artifact with:\n"
                "- artifact_path: the most useful intermediate file you have on disk if any "
                "(e.g. a JSON plan or markdown outline under /mnt/user-data/outputs/), or "
                "an empty plan written in this turn.\n"
                "- artifact_type: 'document'.\n"
                "- confidence: 0.1 (capability missing, not your fault).\n"
                "- companion_summary: tell the user plainly that visual generation isn't "
                "configured and offer alternatives (text/markdown summary, or wait until "
                "the operator sets OPENAI_API_KEY).\n"
                "- companion_tone_hint: 'apologetic-pragmatic'.\n"
                "</missing_capability>"
            )

        sections.append(
            "<output_contract>\n"
            "- Write every user-facing deliverable and supporting file under /mnt/user-data/outputs/ using absolute paths.\n"
            "- Do NOT use relative paths like outputs/report.md or ./outputs/report.md.\n"
            "- When you call emit_builder_artifact, artifact_path and supporting_files must use the same /mnt/user-data/outputs/... absolute paths.\n"
            "</output_contract>"
        )

        # PR Phase B (2026-04-29): inject the skills inventory so the
        # builder knows the pre-tested generation workflows
        # (chart-visualization, ppt-generation, image-generation,
        # data-analysis) are available. Without this block the model
        # falls back to writing its own matplotlib/reportlab code, which
        # is the failure pattern PR #93/#94 spent recovery machinery on.
        skills_block = self._build_skills_inventory_block()
        if skills_block:
            sections.append(skills_block)

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
            "Note: prefer skills (above) over writing your own generator code "
            "for PDF/PPTX/charts/data-analysis. The skills wrap pre-tested "
            "generators that handle font/encoding/embedding correctly.\n"
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
            "BEFORE planning, check <skill_system> above. If a listed skill matches "
            "the deliverable type (e.g. chart-visualization for any chart, "
            "ppt-generation for slide decks, image-generation for standalone "
            "images, data-analysis for tabular data), USE IT — read its SKILL.md "
            "via read_file_tool and follow its workflow. ONLY if no listed skill "
            "applies should you write a _generate_<name>.py script from scratch. "
            "Writing your own matplotlib/reportlab/python-pptx code is the "
            "fragile path PR #93/#94 spent recovery machinery on.\n"
            "Plan your work to fit within this budget:\n"
            "- Turn 1: call write_todos with a short plan (3–5 steps) so the UI can track progress.\n"
            "- For text deliverables (markdown, html, plain text, code): write the complete file in a single "
            "write_file_tool call. Do NOT split the same file across multiple write_file_tool calls and do NOT "
            "call write_file_tool repeatedly to the same path — overwriting a long document costs 90+ seconds "
            "per turn and burns the wall-clock budget. If output risks exceeding the write budget, ship a "
            "tighter draft instead of fragmenting.\n"
            "- For binary deliverables (pdf, pptx, docx, xlsx, png, charts): the DELIVERABLE IS THE BINARY. "
            "**Use skills and tools that wrap pre-tested generators — do NOT write your own matplotlib / "
            "reportlab / python-pptx code.** Past attempts failed repeatedly on font/encoding/image-embedding "
            "errors. Picks by deliverable shape:\n"
            "    * **PDF** (technical report, document with diagrams):\n"
            "      1. For each diagram or chart, use the chart-visualization skill (read its SKILL.md, then "
            "         invoke the appropriate generate_*_chart script via bash_tool). The skill outputs PNG/SVG "
            "         to a path under /mnt/user-data/outputs/.\n"
            "      2. Compose a Markdown source file in /mnt/user-data/outputs/<name>.md with image embeds "
            "         pointing to the chart files. Write it once with write_file_tool — single call.\n"
            "      3. Call render_markdown_to_pdf(markdown_path=<.md>, pdf_path=<.pdf>) to produce the binary. "
            "         This tool wraps pandoc and handles fonts/unicode/embedding correctly.\n"
            "      4. emit_builder_artifact.artifact_path = the .pdf path.\n"
            "      If render_markdown_to_pdf returns success=false with error_type='pandoc_missing' or "
            "      'pandoc_error', SHIP THE MARKDOWN as the artifact instead (artifact_type='document', "
            "      artifact_path = the .md file) with confidence<=0.5 and explain in companion_tone_hint.\n"
            "    * **PPTX / presentation**: use the ppt-generation skill (read its SKILL.md). The skill "
            "      orchestrates image-generation per slide and composes them into a PPTX. Do not write your own "
            "      python-pptx code.\n"
            "    * **Standalone chart / image**: use the chart-visualization or image-generation skill. The "
            "      generated PNG/SVG is the deliverable.\n"
            "    * **Data analysis / spreadsheet**: use the data-analysis skill (DuckDB-based) for SQL over "
            "      tabular data. Output CSV/JSON/Markdown directly.\n"
            "    * **xlsx / docx / other formats not covered by a skill**: as a LAST RESORT, write a short "
            "      generator script to /mnt/user-data/outputs/_generate_<name>.py and bash-run it. This path "
            "      is fragile (the very pattern PR #93/#94 spent recovery machinery on). Prefer a skill if at "
            "      all possible. If you must use a generator script: keep it under 120 lines, run it with "
            "      bash_tool, verify with ls_tool, and at most 2 fix-and-retry cycles before shipping the .py "
            "      with confidence<=0.4.\n"
            "    Libraries listed in <preinstalled_libraries> are already available — do NOT pip install. "
            "    The render_markdown_to_pdf tool encapsulates the PDF rendering pipeline; you do not need to "
            "    install anything to use it.\n"
            "- After each meaningful step (write_file, successful skill invocation, render_markdown_to_pdf), "
            "call write_todos again to mark the corresponding item 'completed' or 'in-progress'. This is how "
            "the user sees the progress bar advance — skipping these updates leaves the UI stuck.\n"
            "- Make targeted edits only if critical fixes are needed.\n"
            "- Final turn: Call ONLY emit_builder_artifact pointing artifact_path at the FINAL DELIVERABLE "
            "(the .pdf, .pptx, .png, .md, etc. — never a generator .py unless that is the explicit fallback "
            "above). Do NOT pair emit_builder_artifact with any other tool call on the same turn — not "
            "write_todos, not bash, not write_file, not anything. The artifact card surfaces the file to "
            "the user automatically once emit_builder_artifact is captured; you do not need to flag the "
            "file separately. emit_builder_artifact alone is MANDATORY — without it your work is lost.\n"
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

    # Skills the builder is steered toward for binary deliverables.
    # Phase B (2026-04-29): inject these into the system prompt so the
    # model uses pre-tested generators instead of writing matplotlib /
    # reportlab / python-pptx code itself. Limited to the binary-
    # generation skills relevant to builder workflows; other skills
    # (sophia, bootstrap, surprise-me, …) are noise here.
    _BUILDER_RELEVANT_SKILLS: tuple[str, ...] = (
        "chart-visualization",
        "ppt-generation",
        "image-generation",
        "data-analysis",
    )

    @classmethod
    def _build_skills_inventory_block(cls) -> str | None:
        """Return a ``<skill_system>`` block listing builder-relevant skills.

        Reuses the central skills loader so SKILL.md descriptions stay
        in sync with what the lead_agent sees. When ``load_skills`` is
        unavailable (offline tests, packaging issue) or no relevant
        skills are enabled, returns ``None`` and the model falls back
        to the pre-Phase-B "_generate_*.py" path explicitly described
        in <completion_instruction>.
        """
        try:
            from deerflow.skills import load_skills  # local import: package may be optional in tests
        except Exception:  # pragma: no cover — defensive
            logger.warning("BuilderTask: deerflow.skills unavailable; skipping skills inventory block")
            return None

        try:
            # Intentionally NOT ``enabled_only=True``. The
            # ``_BUILDER_RELEVANT_SKILLS`` whitelist below already pins
            # the four binary-generation skills the builder always needs,
            # and gating them through ``extensions_config.json`` adds a
            # silent failure mode: when that file is missing (e.g. fresh
            # checkout, render deploy without operator config), the
            # loader's exception path leaves every skill ``enabled=False``
            # and ``enabled_only=True`` filters them all out — so the
            # ``<skill_system>`` block never reaches the prompt and the
            # model falls back to writing matplotlib/reportlab loops.
            # The whitelist is the correct gate; per-skill enable state
            # is operator policy that doesn't apply to the builder's
            # intrinsic tooling.
            skills = load_skills(enabled_only=False)
        except Exception:  # pragma: no cover — defensive
            logger.warning("BuilderTask: load_skills failed; skipping skills inventory block", exc_info=True)
            return None

        relevant = [s for s in skills if getattr(s, "name", None) in cls._BUILDER_RELEVANT_SKILLS]
        # Log either way so "did the builder see skills this run?" is
        # answerable from a single grep on the langgraph-server logs.
        # Without this, the only signal in the existing logs is the
        # absence of a ``<skill_system>`` line — which is invisible.
        logger.info(
            "[BuilderTask] skills_inventory: %d skills injected (%s)",
            len(relevant),
            ", ".join(sorted(s.name for s in relevant)) if relevant else "none",
        )
        if not relevant:
            return None

        try:
            from deerflow.config import get_app_config

            container_base = get_app_config().skills.container_path
        except Exception:
            container_base = "/mnt/skills"

        items: list[str] = []
        for skill in relevant:
            name = getattr(skill, "name", "")
            description = (getattr(skill, "description", "") or "").strip()
            try:
                location = skill.get_container_file_path(container_base)
            except Exception:
                location = f"{container_base}/{name}/SKILL.md"
            items.append(
                f"  <skill>\n"
                f"    <name>{name}</name>\n"
                f"    <description>{description}</description>\n"
                f"    <location>{location}</location>\n"
                f"  </skill>"
            )

        return (
            "<skill_system>\n"
            "Pre-tested workflows for binary deliverables. Strongly preferred over "
            "writing your own matplotlib/reportlab/python-pptx code — past attempts at "
            "ad-hoc Python generation failed repeatedly on font/encoding/image-embedding "
            "errors.\n"
            "\n"
            "How to use a skill:\n"
            "1. read_file_tool on the skill's SKILL.md to learn its workflow.\n"
            "2. Follow the SKILL.md instructions — usually involves invoking the bundled "
            "script via bash_tool with structured input (a JSON spec, not custom code).\n"
            "3. The script writes its output (PNG/SVG/PPTX/JSON/CSV) to a path you pass it.\n"
            "4. Compose downstream artifacts (e.g. a Markdown document referencing chart "
            "images) using the skill's output paths.\n"
            "\n"
            "<available_skills>\n"
            + "\n".join(items)
            + "\n</available_skills>\n"
            "</skill_system>"
        )

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
