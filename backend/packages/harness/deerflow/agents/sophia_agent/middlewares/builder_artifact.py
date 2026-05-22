"""Builder artifact middleware.

After-model: captures emit_builder_artifact tool call output from the
builder agent and stores it in state["builder_result"]. Falls back to a
minimal result when the builder ends with plain text (no tool call).

PR-D (2026-04-24): adds file-existence verification before accepting an
emit_builder_artifact call. When the referenced file is missing on disk
and in Supabase, the emit is rejected via wrap_tool_call with a
Command(goto="model") so the builder gets another turn to retry instead
of completing with a phantom artifact.
"""

import logging
import time
from collections.abc import Awaitable, Callable
from pathlib import Path, PurePosixPath
from typing import Any, NotRequired, override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelRequest, hook_config
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.runtime import Runtime
from langgraph.types import Command

from deerflow.agents.sophia_agent.middlewares.builder_task import BuilderTaskMiddleware
from deerflow.agents.sophia_agent.utils import log_middleware
from deerflow.sophia.builder_events import fire_completion_webhook_from_artifact
from deerflow.sophia.storage import supabase_artifact_store
from deerflow.sophia.storage.supabase_mirror import maybe_mirror_file

logger = logging.getLogger(__name__)


def _emit_skill_usage_logs(tool_calls: list[dict[str, Any]]) -> None:
    """Log builder skill discovery / invocation as INFO breadcrumbs.

    Two distinct events are surfaced so the user can grep one line per
    builder run to answer "did the builder pick a skill?":

    - ``[BuilderSkill] manifest_read: skill=<name>`` — the model called
      ``read_file`` on a SKILL.md, i.e. it discovered the skill workflow.
    - ``[BuilderSkill] script_invoked: skill=<name>`` — the model called
      ``bash`` with a command path under ``skills/<name>/``, i.e. it
      executed a skill-bundled script.

    Without these the existing logs only show ``write_file`` and ``bash``
    tool names, with no signal whether the builder is using a pre-tested
    skill workflow or writing its own ``_generate_*.py`` script.
    """
    relevant = BuilderTaskMiddleware._BUILDER_RELEVANT_SKILLS
    for tc in tool_calls:
        name = tc.get("name")
        args = tc.get("args") or {}
        if name in ("read_file", "read_file_tool"):
            path = args.get("path") or args.get("file_path") or ""
            if isinstance(path, str) and "/skills/" in path and path.endswith("/SKILL.md"):
                # Extract the skill folder name: ``…/skills/<name>/SKILL.md``.
                segment = path.split("/skills/", 1)[1].split("/", 1)[0]
                if segment in relevant:
                    logger.info("[BuilderSkill] manifest_read: skill=%s", segment)
        elif name == "bash":
            cmd = args.get("command")
            if not isinstance(cmd, str) or not cmd:
                continue
            for skill_name in relevant:
                # Match both the host (``skills/<name>/``) and container
                # (``/mnt/skills/<name>/``) layouts so this works in
                # local-sandbox and aio-sandbox modes alike.
                if (
                    f"/skills/{skill_name}/" in cmd
                    or f"/mnt/skills/{skill_name}/" in cmd
                ):
                    logger.info("[BuilderSkill] script_invoked: skill=%s", skill_name)
                    break


_OUTPUTS_VIRTUAL_PREFIX = "/mnt/user-data/outputs/"


def _extract_output_relative_path(artifact_path: str | None) -> str | None:
    """Return the path relative to ``/mnt/user-data/outputs/`` when applicable."""
    if not isinstance(artifact_path, str) or not artifact_path:
        return None
    normalized = artifact_path.strip()
    if not normalized.startswith(_OUTPUTS_VIRTUAL_PREFIX):
        return None
    relative = normalized[len(_OUTPUTS_VIRTUAL_PREFIX):].lstrip("/")
    if not relative:
        return None

    # Reject path traversal so emit verification/mirroring cannot resolve
    # outside the outputs root (e.g. "/mnt/user-data/outputs/../../etc/passwd").
    relative_path = PurePosixPath(relative)
    if relative_path.is_absolute() or ".." in relative_path.parts:
        return None
    return relative_path.as_posix()


def _upload_builder_outputs_to_supabase(
    thread_id: str | None,
    outputs_host_path: str | None,
    artifact_args: dict[str, Any],
) -> None:
    """Best-effort upload of the builder's outputs to Supabase Storage.

    PR-E (Phase 2.2): delegates to ``maybe_mirror_file`` which uses SHA-256
    hash deduplication. Files that were already mirrored at write time by
    the tool hooks are skipped automatically. Any failure is logged and
    swallowed so builder flow never regresses.
    """
    if not thread_id or not outputs_host_path:
        logger.debug(
            "Skipping Supabase upload; missing thread_id=%s outputs_host_path=%s",
            thread_id,
            outputs_host_path,
        )
        return

    candidates: list[str] = []
    primary = artifact_args.get("artifact_path")
    if isinstance(primary, str):
        candidates.append(primary)
    supporting = artifact_args.get("supporting_files")
    if isinstance(supporting, list):
        candidates.extend(path for path in supporting if isinstance(path, str))

    outputs_root = Path(outputs_host_path)
    for candidate in candidates:
        relative = _extract_output_relative_path(candidate)
        if relative is None:
            continue
        host_file = outputs_root / relative
        maybe_mirror_file(str(host_file), thread_id, outputs_host_path)


class BuilderArtifactState(AgentState):
    builder_result: NotRequired[dict | None]
    builder_non_artifact_turns: NotRequired[int]
    builder_last_tool_names: NotRequired[list[str]]
    builder_tool_turn_summaries: NotRequired[list[dict]]
    # PR #94: count consecutive emit attempts rejected for empty/missing
    # ``artifact_path``. When this reaches ``_REJECTION_SHORT_CIRCUIT_AT``
    # we route directly to the hard-ceiling fallback instead of letting
    # the model retry into the LangGraph recursion limit.
    builder_consecutive_empty_emit_rejections: NotRequired[int]
    # Phase 2F.3: idempotency flag. Set once we've injected a path-
    # correction HumanMessage after N consecutive write_file_tool errors,
    # so we don't repeat the correction on every subsequent before_model.
    builder_path_correction_emitted: NotRequired[bool]


class BuilderArtifactMiddleware(AgentMiddleware[BuilderArtifactState]):
    """Capture emit_builder_artifact tool call from the builder agent."""

    state_schema = BuilderArtifactState

    @staticmethod
    def _tool_names(tool_calls: list[dict[str, Any]]) -> list[str]:
        names: list[str] = []
        for call in tool_calls:
            name = call.get("name")
            if isinstance(name, str) and name:
                names.append(name)
        return names

    @staticmethod
    def _append_turn_summary(state: BuilderArtifactState, summary: dict[str, Any]) -> list[dict]:
        history = list(state.get("builder_tool_turn_summaries", []) or [])
        history.append(summary)
        return history[-12:]

    # Ceiling enforcement — MUST stay in sync with _HARD_CEILING in after_model
    # and with builder_task.py's _HARD_CEILING. When the model is within this
    # many turns of termination, we force Anthropic tool_choice to emit so the
    # model literally cannot call any other tool. Prompt-level escalation is
    # not reliable mid-retry-loop; the API-level constraint is.
    #
    # PR-B (2026-04-28): bumped ceiling 20 → 30 after run ``c130c516`` (PDF
    # with diagrams) hit the 20-turn cap mid-progress: write→bash→fix cycles
    # for binary deliverables legitimately need 12-15 turns of build pipeline
    # plus initial planning + final emit. At 20 the model ran out of budget
    # while still iterating productively, then got trapped in 3 wasted forced-
    # write turns (LLM emitted near-empty content because the recovery path
    # for binary tasks is bash, not write_file). Soft warn rescaled to 18
    # (60%) and force-emit at remaining<=3 (turn 27+). Wall-clock force-emit
    # at 70% of per-run timeout (1260s of 1800s) is the backstop for runaway
    # text deliverables — those rarely need 30 turns.
    #
    # PR-A history (2026-04-27): bumped 10 → 20 after a research-heavy task
    # in log ``019dcfbf-f219-7d83-86a4-ffb161ebddf7`` proved 10 too tight.
    # PR-C F6 history (2026-04-24): lowered 20 → 10 because the original
    # ceiling let pathological retries burn the budget. PR-A fixes those
    # retries at the source (two-stage forced-emit + empty-path rejection)
    # so the larger budget no longer enables runaway retry loops.
    _FORCE_EMIT_REMAINING = 3
    _CEILING_FOR_FORCE = 30
    _SOFT_WARN_AT = 18
    # Wall-clock fraction of the per-run timeout at which we activate
    # force-emit even if the turn-count ceiling hasn't been hit. Each
    # write_file LLM call costs ~95s on long-form deliverables; with
    # _resolve_builder_limits returning timeout=1800s, 0.70 leaves ~540s of
    # slack — enough for one final write + emit + network buffer.
    _FORCE_EMIT_WALL_CLOCK_FRACTION = 0.70
    # PR #94: when the model emits ``artifact_path=None`` (or any empty
    # path) under forced ``tool_choice=emit_builder_artifact``, we reject
    # and let it retry. After this many consecutive empty rejections we
    # short-circuit straight to the hard-ceiling fallback — synthesizing
    # ``builder_result`` from disk state — rather than letting the rejection
    # loop burn the remaining LangGraph recursion budget. Threshold of 2
    # leaves room for one transient empty-emit (e.g. a typo on the model's
    # first attempt) while still bounding the loop to ~12 super-steps
    # instead of the ~21 the ceiling-only path costs.
    _REJECTION_SHORT_CIRCUIT_AT = 2

    @staticmethod
    def _should_force_emit(state: BuilderArtifactState) -> bool:
        non_artifact_turns = int(state.get("builder_non_artifact_turns", 0) or 0)
        remaining = BuilderArtifactMiddleware._CEILING_FOR_FORCE - non_artifact_turns
        return remaining <= BuilderArtifactMiddleware._FORCE_EMIT_REMAINING and non_artifact_turns > 0

    @staticmethod
    def _should_force_emit_by_clock(state: BuilderArtifactState, runtime: Runtime | None = None) -> bool:
        """Return True when the wall-clock budget has crossed the force-emit fraction.

        Reads ``builder_timeout_seconds`` and ``builder_task_kickoff_ms`` from
        ``state`` (populated via ``SubagentExecutor``'s ``extra_configurable``
        plumbing in ``switch_to_builder``). Uses ``builder_task_started_at_ms``
        from state when present, falling back to ``builder_task_kickoff_ms``
        (set at queue time) so the very first turn — before ``after_model``
        has had a chance to record ``builder_task_started_at_ms`` — still
        gets the right answer.

        ``runtime`` is accepted for parity with other middleware methods and
        kept as a fallback signal source, but the canonical path is state-only:
        ``executor.py`` already merges ``extra_configurable`` into initial
        state, matching how ``delegation_context`` flows.

        Returns False (today's behavior, turn-count-only) when neither timestamp
        is set or when ``builder_timeout_seconds`` is missing/non-positive. This
        keeps the gate backward-compatible for any caller that doesn't opt in.
        """
        raw_timeout = state.get("builder_timeout_seconds")
        timeout_s = 0
        if isinstance(raw_timeout, (int, float)) and raw_timeout > 0:
            timeout_s = int(raw_timeout)
        if timeout_s <= 0:
            return False

        started_ms = state.get("builder_task_started_at_ms") or 0
        if not isinstance(started_ms, (int, float)) or started_ms <= 0:
            started_ms = state.get("builder_task_kickoff_ms") or 0
        if not isinstance(started_ms, (int, float)) or started_ms <= 0:
            return False

        elapsed_ms = max(0, int(time.time() * 1000) - int(started_ms))
        return elapsed_ms / (timeout_s * 1000) >= BuilderArtifactMiddleware._FORCE_EMIT_WALL_CLOCK_FRACTION

    @staticmethod
    def _forced_tool_choice() -> dict[str, Any]:
        """Anthropic tool_choice payload that forces emit_builder_artifact."""
        return {"type": "tool", "name": "emit_builder_artifact"}

    @staticmethod
    def _forced_write_tool_choice() -> dict[str, Any]:
        """Anthropic tool_choice payload that forces write_file.

        PR-A: used in the two-stage forced-emit path when the model is in the
        forced-emit window but hasn't written any deliverable yet. Forcing
        emit at that point traps the model — it can only call emit, the
        emit gets rejected (no file exists), and the loop spins. By forcing
        write_file for one turn first, we guarantee the model has at least
        one chance to land a file before tool_choice locks to emit.
        """
        return {"type": "tool", "name": "write_file"}

    @staticmethod
    def _forced_bash_tool_choice() -> dict[str, Any]:
        """Anthropic tool_choice payload that forces bash.

        PR-B (2026-04-28): used by the three-stage forced-emit path when a
        generator script (``_generate_*.py``) exists in outputs/ but no
        user-facing binary (pdf/pptx/png/...) has been produced yet. For
        binary deliverables the recovery action is *running* the generator,
        not writing yet another generator. Forcing write_file in that state
        — as PR-A did — traps the model: each forced write produces another
        ``_generate_*.py`` (which ``_has_output_file`` filters out), so the
        gate stays False and the loop spins. Forcing bash gives the model a
        deterministic chance to produce the binary by running what it
        already has on disk. If bash also fails to produce output, the
        hard-ceiling fallback promotes the generator script with
        ``confidence=0.4`` so the user still gets something.
        """
        return {"type": "tool", "name": "bash"}

    @staticmethod
    def _has_output_file(state: BuilderArtifactState) -> bool:
        """Return True if any user-facing file exists in the sandbox outputs dir.

        PR-A: used by ``wrap_model_call`` to decide whether the forced-emit
        window should immediately force ``tool_choice=emit_builder_artifact``
        or first force ``tool_choice=write_file`` to give a not-yet-written
        deliverable a chance to land.

        Files whose name starts with ``_`` (e.g. generator scripts named
        ``_generate_foo.py``) or ``.`` (hidden files) are excluded — those
        aren't user-facing deliverables.
        """
        thread_data = state.get("thread_data") or {}
        outputs_host_path = (
            thread_data.get("outputs_path")
            if isinstance(thread_data, dict)
            else None
        )
        if not isinstance(outputs_host_path, str) or not outputs_host_path:
            # No outputs dir configured — assume the model hasn't written
            # anything. Returning False routes through the safer path
            # (force write_file first) instead of forcing a phantom emit.
            return False

        builder_task_started_at_ms = state.get("builder_task_started_at_ms")
        min_mtime: float | None = None
        if isinstance(builder_task_started_at_ms, (int, float)) and builder_task_started_at_ms > 0:
            # Ignore stale artifacts from prior builder tasks in the same thread.
            # Keep the same 5s grace used by hard-ceiling promotion.
            min_mtime = (float(builder_task_started_at_ms) / 1000.0) - 5.0

        try:
            outputs_root = Path(outputs_host_path)
            if not outputs_root.is_dir():
                return False
            for entry in outputs_root.rglob("*"):
                if not entry.is_file():
                    continue
                if entry.name.startswith("_") or entry.name.startswith("."):
                    continue
                if min_mtime is not None and entry.stat().st_mtime < min_mtime:
                    continue
                return True
        except OSError:
            # Filesystem error (permissions, race) — fall through to True
            # so the existing forced-emit path proceeds. Better to risk one
            # phantom emit than to accidentally trap the model in write_file
            # forcing on every turn when something is genuinely wrong with
            # the sandbox.
            logger.debug(
                "BuilderArtifact._has_output_file: scan failed for outputs_path=%s",
                outputs_host_path,
                exc_info=True,
            )
            return True
        return False

    @staticmethod
    def _build_ceiling_fallback(
        state: BuilderArtifactState,
        *,
        steps_completed: int,
        reason: str,
    ) -> dict[str, Any]:
        """Synthesize a ``builder_result`` dict by scanning ``outputs/`` for
        a deliverable to promote.

        Used by both the hard-ceiling termination path
        (``non_artifact_turns >= _CEILING_FOR_FORCE``) and the
        consecutive-rejection short-circuit path (PR #94, when the model
        emits ``artifact_path=None`` repeatedly under forced emit).

        Promotion priority:

        1. Preferred binary deliverable extension (``.pdf/.pptx/.docx/.xlsx/
           .png/.jpg/.jpeg/.svg/.html/.zip``) — confidence=0.5, "recovered".
        2. Generator script (``_generate_*.py``) — confidence=0.4, partial
           deliverable with a "run it yourself" companion summary.
        3. Apology fallback (``artifact_path=None``, confidence=0.2) — when
           neither category matches.

        ``reason`` is included in log lines so traces can distinguish ceiling
        terminations from rejection short-circuits.
        """
        builder_task_started_at_ms = state.get("builder_task_started_at_ms") or 0

        promoted_path: str | None = None
        promoted_type = "unknown"
        try:
            thread_data_local = state.get("thread_data") or {}
            outputs_host_path_local = (
                thread_data_local.get("outputs_path")
                if isinstance(thread_data_local, dict)
                else None
            )
            if outputs_host_path_local:
                outputs_root_local = Path(outputs_host_path_local)
                if outputs_root_local.is_dir():
                    # Promotion priority is left-to-right; the mtime sort
                    # below then picks the most-recently-written file
                    # within the set, so a fresh ``.pdf`` will still win
                    # over an older ``.md``. The text extensions were
                    # added in PR #126 Phase 4F after a production
                    # markdown-deep-dive failed because ``.md`` wasn't in
                    # the list — the model emitted ``artifact_path=None``
                    # under force-emit, the short-circuit kicked in, the
                    # ceiling fallback scanned outputs/ but found nothing
                    # promotable, and the run coerced to error instead of
                    # delivering the markdown the builder had written.
                    _PROMOTE_EXTS = (
                        # Binary deliverables — high signal, listed first.
                        ".pdf", ".pptx", ".docx", ".xlsx",
                        ".png", ".jpg", ".jpeg", ".svg",
                        ".html", ".zip",
                        # Text deliverables — markdown deep dives, JSON/CSV
                        # data reports, YAML specs.
                        ".md", ".txt", ".csv", ".json", ".yaml", ".yml",
                    )
                    candidates = [
                        p for p in outputs_root_local.rglob("*")
                        if p.is_file()
                        and not p.name.startswith("_")
                        and p.suffix.lower() in _PROMOTE_EXTS
                    ]
                    if builder_task_started_at_ms:
                        min_mtime = (builder_task_started_at_ms / 1000.0) - 5.0
                        candidates = [
                            p for p in candidates
                            if p.stat().st_mtime >= min_mtime
                        ]
                    if candidates:
                        candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
                        best = candidates[0]
                        rel = best.relative_to(outputs_root_local).as_posix()
                        promoted_path = f"/mnt/user-data/outputs/{rel}"
                        ext = best.suffix.lower().lstrip(".")
                        promoted_type = ext or "unknown"
        except Exception as exc:  # noqa: BLE001 — best-effort only
            logger.warning(
                "BuilderArtifact: ceiling fallback scan failed reason=%s error=%s",
                reason,
                exc,
            )

        promoted_generator_path: str | None = None
        if promoted_path is None:
            try:
                thread_data_local = state.get("thread_data") or {}
                outputs_host_path_local = (
                    thread_data_local.get("outputs_path")
                    if isinstance(thread_data_local, dict)
                    else None
                )
                if outputs_host_path_local:
                    outputs_root_local = Path(outputs_host_path_local)
                    if outputs_root_local.is_dir():
                        gen_candidates = [
                            p for p in outputs_root_local.rglob("*")
                            if p.is_file()
                            and p.name.startswith("_generate_")
                            and p.suffix.lower() == ".py"
                        ]
                        if builder_task_started_at_ms:
                            min_mtime = (builder_task_started_at_ms / 1000.0) - 5.0
                            gen_candidates = [
                                p for p in gen_candidates
                                if p.stat().st_mtime >= min_mtime
                            ]
                        if gen_candidates:
                            gen_candidates.sort(
                                key=lambda p: p.stat().st_mtime, reverse=True
                            )
                            best = gen_candidates[0]
                            rel = best.relative_to(outputs_root_local).as_posix()
                            promoted_generator_path = f"/mnt/user-data/outputs/{rel}"
                            logger.warning(
                                "BuilderArtifact: fallback promoting generator script %s "
                                "(reason=%s, no binary deliverable found)",
                                promoted_generator_path,
                                reason,
                            )
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "BuilderArtifact: generator-script fallback scan failed reason=%s error=%s",
                    reason,
                    exc,
                )

        if promoted_path:
            return {
                "artifact_path": promoted_path,
                "artifact_type": promoted_type,
                "artifact_title": "Build task completed (recovered)",
                "steps_completed": steps_completed,
                "decisions_made": [],
                "companion_summary": (
                    "The builder ran long and didn't call emit cleanly, "
                    "but the deliverable is on disk — I'm surfacing it now."
                ),
                "companion_tone_hint": "Reassuring — deliverable recovered despite rough run.",
                "user_next_action": "Open the file and let me know if it lands.",
                "confidence": 0.5,
            }
        if promoted_generator_path:
            return {
                "artifact_path": promoted_generator_path,
                "artifact_type": "code",
                "artifact_title": "Build task partial (generator script only)",
                "steps_completed": steps_completed,
                "decisions_made": [],
                "companion_summary": (
                    "I built the generator script but couldn't produce the final "
                    "binary cleanly — sharing the script so you have something to "
                    "work with."
                ),
                "companion_tone_hint": (
                    "Honest and constructive — partial deliverable; offer to debug "
                    "if the user shares the error from running it."
                ),
                "user_next_action": (
                    "Try running `python <path>` yourself, or send me the error "
                    "and I'll fix it."
                ),
                "confidence": 0.4,
            }
        return {
            "artifact_path": None,
            "artifact_type": "unknown",
            "artifact_title": "Build task force-stopped",
            "steps_completed": steps_completed,
            "decisions_made": [],
            "companion_summary": (
                f"The builder made {steps_completed} edits but didn't finish cleanly. "
                "No final deliverable was produced."
            ),
            "companion_tone_hint": "Apologetic — builder ran out of budget.",
            "user_next_action": "Tell me what to try differently and I'll run it again.",
            "confidence": 0.2,
        }

    @staticmethod
    def _upload_fallback_and_fire(
        state: BuilderArtifactState,
        runtime: Runtime,
        fallback: dict[str, Any],
        status: str,
    ) -> None:
        """Mirror the ceiling-fallback file to Supabase BEFORE firing the
        completion webhook.

        Phase 4L (2026-05-19): the two ceiling-fallback call sites used
        to fire ``fire_completion_webhook_from_artifact`` directly,
        without uploading the promoted file. If ``SOPHIA_SUPABASE_MIRROR_ALL``
        wasn't enabled (or the per-write mirror missed the file), the
        downstream signed-URL mint returned 404 and Telegram delivery
        fell back to plaintext. Mirrors the upload step from the normal
        happy path at ``after_model`` (the lines that resolve
        ``upload_thread_id`` and call ``_upload_builder_outputs_to_supabase``).

        Safe to call when ``fallback["artifact_path"]`` is None:
        ``maybe_mirror_file`` is a no-op for missing paths, and
        ``_upload_builder_outputs_to_supabase`` short-circuits when
        ``outputs_host_path`` or ``thread_id`` is unset. The upload
        helper also documents "Any failure is logged and swallowed so
        builder flow never regresses" — so if the upload raises, the
        webhook still fires (the placeholder is finalized; delivery
        may still degrade to plaintext, which is the pre-Phase-4L
        behavior — i.e. no regression).
        """
        thread_data = state.get("thread_data") or {}
        outputs_host_path = (
            thread_data.get("outputs_path") if isinstance(thread_data, dict) else None
        )
        delegation = state.get("delegation_context")
        parent_thread_id = (
            delegation.get("parent_thread_id") if isinstance(delegation, dict) else None
        )
        builder_thread_id = (
            runtime.context.get("thread_id") if getattr(runtime, "context", None) else None
        )
        upload_thread_id = parent_thread_id or builder_thread_id
        _upload_builder_outputs_to_supabase(
            thread_id=upload_thread_id,
            outputs_host_path=outputs_host_path,
            artifact_args=fallback,
        )
        fire_completion_webhook_from_artifact(
            state=state,
            runtime=runtime,
            artifact=fallback,
            status=status,
        )

    @staticmethod
    def _has_generator_script(state: BuilderArtifactState) -> bool:
        """Return True if a builder-produced ``_generate_*.py`` script exists.

        PR-B (2026-04-28): companion to ``_has_output_file`` for the three-
        stage forced-emit path. The builder prompt instructs binary tasks
        to write ``_generate_<name>.py`` then bash-run it. When no binary
        deliverable has landed yet but a generator script has, the recovery
        action is running the script (force ``bash``), not writing yet
        another script (force ``write_file``).

        Same staleness filtering as ``_has_output_file``: ignores generators
        from prior builder tasks via ``builder_task_started_at_ms``.
        """
        thread_data = state.get("thread_data") or {}
        outputs_host_path = (
            thread_data.get("outputs_path")
            if isinstance(thread_data, dict)
            else None
        )
        if not isinstance(outputs_host_path, str) or not outputs_host_path:
            return False

        builder_task_started_at_ms = state.get("builder_task_started_at_ms")
        min_mtime: float | None = None
        if isinstance(builder_task_started_at_ms, (int, float)) and builder_task_started_at_ms > 0:
            min_mtime = (float(builder_task_started_at_ms) / 1000.0) - 5.0

        try:
            outputs_root = Path(outputs_host_path)
            if not outputs_root.is_dir():
                return False
            for entry in outputs_root.rglob("*"):
                if not entry.is_file():
                    continue
                # Match generator scripts produced by the builder per the
                # binary-deliverable prompt (``_generate_<name>.py``).
                if not (entry.name.startswith("_generate_") and entry.suffix.lower() == ".py"):
                    continue
                if min_mtime is not None and entry.stat().st_mtime < min_mtime:
                    continue
                return True
        except OSError:
            logger.debug(
                "BuilderArtifact._has_generator_script: scan failed for outputs_path=%s",
                outputs_host_path,
                exc_info=True,
            )
            # Conservative on error: report no generator so the existing
            # write_file forcing path proceeds.
            return False
        return False

    @classmethod
    def _artifact_files_exist(
        cls,
        artifact_args: dict[str, Any],
        state: BuilderArtifactState,
        runtime: Runtime,
    ) -> bool:
        """Verify that every file referenced in the emit args exists on disk or in Supabase.

        PR-D (2026-04-24): prevents phantom artifacts where the builder calls
        emit_builder_artifact before the file has actually been written.
        Returns ``True`` only when ALL referenced paths resolve to an existing
        local file OR an existing Supabase object.

        PR-A (2026-04-27): tightened the empty-candidates fast-path. When the
        model is in the forced-emit window (``_should_force_emit`` is True),
        an empty ``artifact_path`` is treated as ESCAPE-HATCH-INVALID: it
        almost always means the model gave up under tool_choice pressure
        and is emitting nothing. We reject so the hard-ceiling fallback
        path (which scans outputs/ and produces a deterministic
        confidence=0.5 promotion or confidence=0.2 apology) can take over.
        Outside the forced-emit window the old behaviour applies — text-only
        / conceptual artifacts are still accepted.
        """
        candidates: list[str] = []
        primary = artifact_args.get("artifact_path")
        if isinstance(primary, str) and primary.strip():
            candidates.append(primary.strip())
        supporting = artifact_args.get("supporting_files")
        if isinstance(supporting, list):
            candidates.extend(
                path for path in supporting
                if isinstance(path, str) and path.strip()
            )

        if not candidates:
            # Reject empty artifact_path under EITHER turn-count pressure
            # (existing) OR wall-clock pressure (new). Both indicate the
            # model is emitting under tool_choice pressure with no real
            # deliverable to point at — let the hard-ceiling fallback
            # promote a real file or surface a deterministic apology.
            if cls._should_force_emit(state) or cls._should_force_emit_by_clock(state, runtime):
                logger.warning(
                    "BuilderArtifact: rejecting empty artifact_path during "
                    "forced-emit (non_artifact_turns=%s) — letting hard "
                    "ceiling fallback promote a real file or surface a "
                    "deterministic apology instead of a phantom emit.",
                    state.get("builder_non_artifact_turns"),
                )
                return False
            # No files referenced AND not under forced-emit pressure —
            # accept (builder may be emitting a text-only or conceptual
            # result).
            return True

        thread_data = state.get("thread_data") or {}
        outputs_host_path = (
            thread_data.get("outputs_path")
            if isinstance(thread_data, dict)
            else None
        )
        thread_id = runtime.context.get("thread_id") if runtime.context else None

        for candidate in candidates:
            relative = _extract_output_relative_path(candidate)
            if relative is None:
                # If the path is under outputs prefix but failed relative-path
                # extraction, treat as invalid (e.g. traversal attempt).
                if isinstance(candidate, str) and candidate.strip().startswith(_OUTPUTS_VIRTUAL_PREFIX):
                    logger.warning(
                        "BuilderArtifact: rejecting invalid outputs artifact path=%s",
                        candidate,
                    )
                    return False
                # Non-virtual path — we can't verify it against the sandbox
                # outputs dir. Accept it and let downstream consumers decide.
                continue

            # 1. Check local disk
            if outputs_host_path:
                host_file = Path(outputs_host_path) / relative
                if host_file.is_file():
                    continue

            # 2. Check Supabase
            if thread_id and supabase_artifact_store.check_artifact_exists(thread_id, relative):
                continue

            # Neither local nor remote — missing.
            logger.warning(
                "BuilderArtifact: file missing for emit verification: "
                "path=%s local=%s supabase=%s",
                candidate,
                bool(outputs_host_path and (Path(outputs_host_path) / relative).is_file()),
                bool(thread_id and supabase_artifact_store.check_artifact_exists(thread_id, relative)),
            )
            return False

        return True

    def _force_choice_for_state(
        self,
        state: BuilderArtifactState,
        runtime: Runtime | None = None,
    ) -> dict[str, Any] | None:
        """Three-stage forced-tool-choice (PR-A + PR-B) with wall-clock awareness.

        Activates when EITHER the turn-count ceiling is imminent
        (``_should_force_emit``) OR the wall-clock fraction of the per-run
        timeout has been crossed (``_should_force_emit_by_clock``). The
        stage selection within the force window is what changed in PR-B
        for binary deliverables that have written a generator but failed
        to produce the final binary.

        Returns the Anthropic ``tool_choice`` payload appropriate for the
        current state:

        - ``None`` when forcing isn't required yet.
        - ``{"type": "tool", "name": "emit_builder_artifact"}`` when a
          user-facing binary already exists on disk — proceed with emit.
        - ``{"type": "tool", "name": "bash"}`` (PR-B) when no binary exists
          but a ``_generate_*.py`` does — recovery for binary deliverables
          is to RUN the generator, not write yet another one. After this
          forced bash either produces a binary (next turn flips to emit)
          or doesn't (hard-ceiling fallback promotes the script itself).
        - ``{"type": "tool", "name": "write_file"}`` when neither a binary
          nor a generator exists — the model has produced nothing on disk
          and needs to land at least one file before emit is forced.
        """
        turn_force = self._should_force_emit(state)
        clock_force = self._should_force_emit_by_clock(state, runtime)
        if not (turn_force or clock_force):
            return None
        force_reason = "turns" if turn_force and not clock_force else (
            "wall_clock" if clock_force and not turn_force else "turns+wall_clock"
        )
        non_artifact_turns = state.get("builder_non_artifact_turns")

        # Stage 1: a real user-facing binary is on disk → force emit.
        if self._has_output_file(state):
            logger.warning(
                "BuilderArtifact: forcing tool_choice=emit_builder_artifact "
                "(non_artifact_turns=%s, ceiling=%s, reason=%s)",
                non_artifact_turns,
                self._CEILING_FOR_FORCE,
                force_reason,
            )
            return self._forced_tool_choice()

        # Stage 2 (PR-B): a generator script exists but no binary yet →
        # force bash so the model runs what it has, instead of writing
        # another generator that gets filtered out by _has_output_file.
        if self._has_generator_script(state):
            logger.warning(
                "BuilderArtifact: forcing tool_choice=bash before emit "
                "(non_artifact_turns=%s, ceiling=%s, reason=%s, generator "
                "script on disk but no binary — three-stage force gives the "
                "model a chance to RUN the generator instead of writing yet "
                "another one)",
                non_artifact_turns,
                self._CEILING_FOR_FORCE,
                force_reason,
            )
            return self._forced_bash_tool_choice()

        # Stage 3: nothing on disk at all → force write_file (PR-A).
        logger.warning(
            "BuilderArtifact: forcing tool_choice=write_file before emit "
            "(non_artifact_turns=%s, ceiling=%s, reason=%s, no output file yet — "
            "force prevents phantom-emit loop)",
            non_artifact_turns,
            self._CEILING_FOR_FORCE,
            force_reason,
        )
        return self._forced_write_tool_choice()

    # Phase 2F.3: after N consecutive write_file_tool errors, inject a
    # corrective HumanMessage so the model breaks out of the loop and
    # writes to the canonical /mnt/user-data/outputs/ path. The threshold
    # is intentionally tight (3) so we recover fast; idempotency is
    # tracked via ``builder_path_correction_emitted`` in state.
    _PATH_CORRECTION_ERROR_THRESHOLD = 3
    _PATH_CORRECTION_LOOKBACK = 8  # cap scan range so we don't walk huge histories

    @staticmethod
    def _count_trailing_write_file_errors(messages: list, lookback: int) -> int:
        """Count trailing ToolMessages from write_file_tool whose content
        starts with "Error". Stops at the first non-error / non-write_file
        ToolMessage so we only count an UNBROKEN trailing streak.

        Other message types (AIMessage, HumanMessage) between the
        trailing tool results are tolerated — we walk backwards through
        the most recent ToolMessages, ignoring intervening ai/human msgs,
        and count only the consecutive write_file ones.
        """
        count = 0
        scanned = 0
        for msg in reversed(messages):
            scanned += 1
            if scanned > lookback:
                break
            if not isinstance(msg, ToolMessage):
                continue
            name = getattr(msg, "name", None) or ""
            if name not in ("write_file", "write_file_tool"):
                # Non-write_file tool result — streak broken.
                return count
            content = getattr(msg, "content", None)
            if isinstance(content, str) and content.startswith("Error"):
                count += 1
            else:
                return count
        return count

    def _maybe_inject_path_correction(
        self, state: BuilderArtifactState
    ) -> dict[str, Any] | None:
        """Phase 2F.3: detect ``write_file_tool`` error loops and inject a
        single corrective HumanMessage so the model recovers.

        Production failure 2026-05-22 19:54-20:14 UTC: builder spent 20+
        minutes retrying write_file_tool with bare filenames (test.md,
        test2.md, etc.), each rejected with PermissionError. The model
        kept retrying with similar bad names. Phase 2F.2 fixes the bare-
        filename case via auto-prefix; Phase 2F.3 is the defensive
        escape hatch for any residual write_file-error loop.

        Idempotent: once we emit the correction (tracked via
        ``builder_path_correction_emitted``), don't emit again on this
        run. The model has already been told; further repetition adds
        noise without value.
        """
        if state.get("builder_path_correction_emitted"):
            return None
        messages = state.get("messages") or []
        count = self._count_trailing_write_file_errors(
            messages, self._PATH_CORRECTION_LOOKBACK
        )
        if count < self._PATH_CORRECTION_ERROR_THRESHOLD:
            return None
        logger.warning(
            "[BuilderArtifact] %d consecutive write_file_tool errors detected "
            "— injecting path-correction directive (Phase 2F.3 escape hatch).",
            count,
        )
        correction = HumanMessage(
            content=(
                "[Sophia/path-correction directive]\n"
                f"Your last {count} write_file_tool calls all failed with "
                "errors. This usually means the path you used is not under "
                "/mnt/user-data/outputs/.\n\n"
                "STOP retrying with the same kind of path. Your NEXT "
                "write_file_tool call MUST use an absolute path starting "
                "with `/mnt/user-data/outputs/`, e.g. "
                "`/mnt/user-data/outputs/my-document.md`. If you only had a "
                "bare filename like `report.md`, prepend "
                "`/mnt/user-data/outputs/` to it.\n\n"
                "After the file is on disk under /mnt/user-data/outputs/, "
                "call emit_builder_artifact with that exact path to deliver "
                "the artifact and end this run."
            )
        )
        return {
            "messages": [correction],
            "builder_path_correction_emitted": True,
        }

    @staticmethod
    def _is_post_interrupt_update(messages: list) -> bool:
        """Detect whether the latest HumanMessage in ``messages`` arrived
        AFTER the builder had already started working — the signal that
        ``update_async_task`` interrupted an in-flight run and appended a
        new user message via deepagents' ``multitask_strategy="interrupt"``.

        Heuristic: the latest message is a ``HumanMessage`` AND somewhere
        earlier in the conversation there is an ``AIMessage`` carrying
        ``tool_calls``. That AIMessage proves the builder did work (made
        tool calls) before the new user instruction landed.

        This is a one-shot trigger: as soon as the model responds, the
        latest message becomes an AIMessage and the heuristic stops
        matching for that turn-cycle. The caller resets the counter once,
        then the normal counter-increment logic runs unchanged.
        """
        if not messages:
            return False
        latest = messages[-1]
        if not isinstance(latest, HumanMessage):
            return False
        # Look backward for any AIMessage with tool_calls (builder did
        # real work before this new instruction).
        for msg in reversed(messages[:-1]):
            if isinstance(msg, AIMessage):
                tool_calls = getattr(msg, "tool_calls", None) or []
                if tool_calls:
                    return True
        return False

    def _maybe_reset_turn_budget(
        self, state: BuilderArtifactState
    ) -> dict[str, Any] | None:
        """Phase 2E.1: when an interrupted builder run resumes with a new
        user instruction, reset ``builder_non_artifact_turns`` to 0 so the
        post-update work gets a fresh turn budget. Without this, the
        pre-interrupt research turns count against the post-update writing
        budget and the builder hits the hard ceiling without producing a
        deliverable (production failure 2026-05-21 21:18-21:46 UTC).
        """
        messages = state.get("messages") or []
        if not self._is_post_interrupt_update(messages):
            return None
        current = int(state.get("builder_non_artifact_turns", 0) or 0)
        if current <= 0:
            return None  # Nothing to reset — fresh run.
        logger.info(
            "[BuilderArtifact] post-interrupt update detected — resetting "
            "builder_non_artifact_turns: %d → 0 (fresh budget for the update)",
            current,
        )
        return {"builder_non_artifact_turns": 0}

    def _combined_before_model_updates(
        self, state: BuilderArtifactState
    ) -> dict | None:
        """Run all before_model state-update probes (Phase 2E.1 turn-budget
        reset + Phase 2F.3 path-correction injection) and merge their
        returns into a single update dict for the langgraph reducer."""
        update: dict[str, Any] = {}
        reset = self._maybe_reset_turn_budget(state)
        if isinstance(reset, dict):
            update.update(reset)
        correction = self._maybe_inject_path_correction(state)
        if isinstance(correction, dict):
            # Merge: ``messages`` reducer concatenates, scalar flags overwrite.
            for key, value in correction.items():
                update[key] = value
        return update or None

    @override
    def before_model(
        self, state: BuilderArtifactState, runtime: Runtime | None = None
    ) -> dict | None:
        return self._combined_before_model_updates(state)

    @override
    async def abefore_model(
        self, state: BuilderArtifactState, runtime: Runtime | None = None
    ) -> dict | None:
        return self._combined_before_model_updates(state)

    @override
    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Any],
    ) -> Any:
        """Force tool_choice when ceiling is imminent (two-stage)."""
        choice = self._force_choice_for_state(request.state, request.runtime)
        if choice is not None:
            request = request.override(tool_choice=choice)
        return handler(request)

    @override
    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[Any]],
    ) -> Any:
        """Async variant — same two-stage logic as wrap_model_call."""
        choice = self._force_choice_for_state(request.state, request.runtime)
        if choice is not None:
            request = request.override(tool_choice=choice)
        return await handler(request)

    @override
    def wrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], ToolMessage | Command],
    ) -> ToolMessage | Command:
        """Intercept emit_builder_artifact to verify the file exists before executing.

        PR-D (2026-04-24): when the referenced file is missing, we bypass the
        normal tool execution (which has ``return_direct=True`` and would end the
        builder graph) and instead return a ``Command(goto=\"model\")`` with an
        error ToolMessage. This lets the model see the rejection and retry.
        """
        if request.tool_call.get("name") != "emit_builder_artifact":
            return handler(request)

        args = request.tool_call.get("args", {})
        if self._artifact_files_exist(args, request.state, request.runtime):
            return handler(request)

        tool_call_id = request.tool_call.get("id", "")
        logger.warning(
            "BuilderArtifact: emit rejected in wrap_tool_call — "
            "artifact_path %s not found. Routing back to model for retry.",
            args.get("artifact_path"),
        )
        return Command(
            update={
                "messages": [
                    ToolMessage(
                        content=(
                            "Error: emit_builder_artifact rejected — the referenced "
                            f"artifact file ({args.get('artifact_path')}) does not exist "
                            "on disk or in remote storage. Please write the file first, "
                            "then call emit_builder_artifact again."
                        ),
                        tool_call_id=tool_call_id,
                        name="emit_builder_artifact",
                        status="error",
                    ),
                ],
            },
            goto="model",
        )

    @override
    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command]],
    ) -> ToolMessage | Command:
        """Async variant — same logic as wrap_tool_call."""
        if request.tool_call.get("name") != "emit_builder_artifact":
            return await handler(request)

        args = request.tool_call.get("args", {})
        if self._artifact_files_exist(args, request.state, request.runtime):
            return await handler(request)

        tool_call_id = request.tool_call.get("id", "")
        logger.warning(
            "BuilderArtifact: emit rejected in awrap_tool_call — "
            "artifact_path %s not found. Routing back to model for retry.",
            args.get("artifact_path"),
        )
        return Command(
            update={
                "messages": [
                    ToolMessage(
                        content=(
                            "Error: emit_builder_artifact rejected — the referenced "
                            f"artifact file ({args.get('artifact_path')}) does not exist "
                            "on disk or in remote storage. Please write the file first, "
                            "then call emit_builder_artifact again."
                        ),
                        tool_call_id=tool_call_id,
                        name="emit_builder_artifact",
                        status="error",
                    ),
                ],
            },
            goto="model",
        )

    @hook_config(can_jump_to=["end"])
    @override
    def after_model(self, state: BuilderArtifactState, runtime: Runtime) -> dict | None:
        """Capture emit_builder_artifact tool call result from latest messages."""
        _t0 = time.perf_counter()

        # Don't overwrite a previously captured result
        if state.get("builder_result") is not None:
            log_middleware("BuilderArtifact", "already captured, skipping", _t0)
            return None

        messages = state.get("messages", [])

        # Scan messages in reverse for an AI message with tool_calls
        for msg in reversed(messages):
            if getattr(msg, "type", None) != "ai":
                continue

            tool_calls = getattr(msg, "tool_calls", []) or []

            # AI message has tool calls -- look for emit_builder_artifact
            if tool_calls:
                # Surface skill-discovery / skill-invocation breadcrumbs
                # before any control-flow branches return. The user
                # complained about zero visibility into which skills the
                # builder picks; this resolves that without changing
                # behaviour.
                _emit_skill_usage_logs(tool_calls)
                artifact_calls = [tc for tc in tool_calls if tc.get("name") == "emit_builder_artifact"]
                tool_names = self._tool_names(tool_calls)

                if artifact_calls and len(artifact_calls) == len(tool_calls):
                    args = artifact_calls[-1].get("args", {})

                    # PR-D (2026-04-24): verify the referenced file exists before
                    # accepting the emit. If missing, let wrap_tool_call handle the
                    # retry (Command(goto="model")) instead of completing with a
                    # phantom artifact.
                    #
                    # Codex fix (2026-04-24): on rejection we MUST still increment
                    # builder_non_artifact_turns. If the builder is in the forced-emit
                    # window (_should_force_emit is True) and the counter stays
                    # frozen, the model is trapped: tool_choice forces emit →
                    # emit is rejected → tool_choice forces emit again → loop.
                    # Incrementing lets the hard ceiling (10) trigger after a few
                    # retries and terminate the run instead of spinning forever.
                    if not self._artifact_files_exist(args, state, runtime):
                        logger.warning(
                            "BuilderArtifact: emit rejected in after_model — "
                            "artifact_path %s not found on disk or in Supabase. "
                            "Builder will retry via wrap_tool_call.",
                            args.get("artifact_path"),
                        )
                        non_artifact_turns = int(state.get("builder_non_artifact_turns", 0) or 0) + 1

                        # PR #94: track *empty* artifact_path rejections separately
                        # so we can short-circuit before the LangGraph recursion
                        # limit blows. The model's ``artifact_path=None`` under
                        # forced ``tool_choice`` is a strong signal that further
                        # retries won't help — collapse to the hard-ceiling
                        # fallback after _REJECTION_SHORT_CIRCUIT_AT consecutive
                        # such rejections.
                        primary = args.get("artifact_path")
                        is_empty_path_rejection = not (
                            isinstance(primary, str) and primary.strip()
                        )
                        consecutive_rejections = int(
                            state.get("builder_consecutive_empty_emit_rejections", 0) or 0
                        )
                        if is_empty_path_rejection:
                            consecutive_rejections += 1
                        else:
                            consecutive_rejections = 0

                        history = self._append_turn_summary(
                            state,
                            {
                                "turn": non_artifact_turns,
                                "tool_names": tool_names,
                                "has_emit_builder_artifact": True,
                                "emit_rejected": True,
                                "empty_artifact_path": is_empty_path_rejection,
                            },
                        )

                        if (
                            is_empty_path_rejection
                            and consecutive_rejections >= self._REJECTION_SHORT_CIRCUIT_AT
                        ):
                            logger.warning(
                                "BuilderArtifact: short-circuiting after %d consecutive "
                                "empty-artifact_path rejections at turn=%d (ceiling=%d) — "
                                "routing to ceiling fallback to avoid GraphRecursionError.",
                                consecutive_rejections,
                                non_artifact_turns,
                                self._CEILING_FOR_FORCE,
                            )
                            fallback = self._build_ceiling_fallback(
                                state,
                                steps_completed=non_artifact_turns,
                                reason=f"consecutive_empty_emit_rejections={consecutive_rejections}",
                            )
                            # Phase 4L: upload the promoted file to
                            # Supabase BEFORE firing the webhook so the
                            # signed-URL mint + Telegram bytes-download
                            # both succeed. Without this the ceiling
                            # fallback delivered plaintext instead of
                            # the actual file (2026-05-19 production
                            # smoke test).
                            self._upload_fallback_and_fire(
                                state=state,
                                runtime=runtime,
                                fallback=fallback,
                                status="completed",
                            )
                            return {
                                "builder_result": fallback,
                                "builder_non_artifact_turns": 0,
                                "builder_last_tool_names": tool_names,
                                "builder_tool_turn_summaries": history,
                                "builder_task_started_at_ms": 0,
                                "builder_consecutive_empty_emit_rejections": 0,
                                "jump_to": "end",
                            }

                        return {
                            "builder_non_artifact_turns": non_artifact_turns,
                            "builder_last_tool_names": tool_names,
                            "builder_tool_turn_summaries": history,
                            "builder_consecutive_empty_emit_rejections": consecutive_rejections,
                        }

                    history = self._append_turn_summary(
                        state,
                        {
                            "turn": int(state.get("builder_non_artifact_turns", 0) or 0) + 1,
                            "tool_names": tool_names,
                            "has_emit_builder_artifact": True,
                        },
                    )
                    thread_data = state.get("thread_data") or {}
                    outputs_host_path = (
                        thread_data.get("outputs_path") if isinstance(thread_data, dict) else None
                    )
                    # Phase-1 async migration created a fresh builder thread
                    # per build (deepagents native dispatch). The Telegram
                    # channel adapter looks up artifact bytes via the
                    # CONVERSATION thread_id (parent / companion), not the
                    # ephemeral build thread, so we namespace the upload
                    # under the parent thread to keep the storage path and
                    # the channel-adapter download path aligned.
                    #
                    # Production traceback (2026-05-06T22:18:16): Telegram
                    # downloaded from sophia_builder/<parent>/<file> and got
                    # 400 because the file lived at sophia_builder/<builder>/<file>.
                    # Switching to parent_thread_id here restores the legacy
                    # SubagentExecutor convention.
                    delegation_for_upload = (
                        state.get("delegation_context")
                        if isinstance(state.get("delegation_context"), dict)
                        else {}
                    )
                    parent_thread_id = (
                        delegation_for_upload.get("parent_thread_id")
                        if isinstance(delegation_for_upload, dict)
                        else None
                    )
                    builder_thread_id = (
                        runtime.context.get("thread_id") if runtime.context else None
                    )
                    upload_thread_id = parent_thread_id or builder_thread_id
                    _upload_builder_outputs_to_supabase(
                        thread_id=upload_thread_id,
                        outputs_host_path=outputs_host_path,
                        artifact_args=args,
                    )
                    log_middleware(
                        "BuilderArtifact",
                        f"builder artifact captured: type={args.get('artifact_type')}, "
                        f"confidence={args.get('confidence')}",
                        _t0,
                    )
                    # Fire the gateway webhook so the Telegram channel adapter
                    # (and webapp SSE) deliver the artifact bytes to the user.
                    # Replaces the deleted ``SubagentExecutor`` terminal-flip
                    # call site after the Phase-1 async migration.
                    fire_completion_webhook_from_artifact(
                        state=state,
                        runtime=runtime,
                        artifact=args,
                        status="completed",
                    )
                    return {
                        "builder_result": args,
                        "builder_non_artifact_turns": 0,
                        "builder_last_tool_names": tool_names,
                        "builder_tool_turn_summaries": history,
                        "builder_task_started_at_ms": 0,
                        "builder_consecutive_empty_emit_rejections": 0,
                        "jump_to": "end",
                    }

                if artifact_calls:
                    log_middleware("BuilderArtifact", "mixed tool calls with builder artifact; loop continues", _t0)
                    return None

                # Has tool calls but none are emit_builder_artifact -- agent loop continues
                non_artifact_turns = int(state.get("builder_non_artifact_turns", 0) or 0) + 1
                # Record task start wall-clock on the first non-emit turn so
                # the ceiling fallback can scan ONLY files produced during
                # this task (prevents promoting a stale file from a prior
                # builder task that ran in the same thread).
                builder_task_started_at_ms = state.get("builder_task_started_at_ms")
                if not isinstance(builder_task_started_at_ms, (int, float)) or builder_task_started_at_ms <= 0:
                    builder_task_started_at_ms = int(time.time() * 1000)
                history = self._append_turn_summary(
                    state,
                    {
                        "turn": non_artifact_turns,
                        "tool_names": tool_names,
                        "has_emit_builder_artifact": False,
                    },
                )
                joined_names = ", ".join(tool_names) if tool_names else "none"

                # PR-C F6 (2026-04-24): soft-warn halfway so the model sees
                # an early wrap-up signal in logs (and future trace events).
                # Emitted exactly once per task, at the ``_SOFT_WARN_AT`` turn.
                if non_artifact_turns == self._SOFT_WARN_AT:
                    logger.warning(
                        "BuilderArtifact: soft ceiling warning at turn=%d "
                        "(hard_ceiling=%d, remaining=%d). Builder should wrap up "
                        "— emit_builder_artifact with what's on disk instead of "
                        "continuing to iterate.",
                        non_artifact_turns,
                        self._CEILING_FOR_FORCE,
                        self._CEILING_FOR_FORCE - non_artifact_turns,
                    )

                # Hard ceiling: force end before hitting the recursion limit.
                # Builds that haven't emitted by this point almost never recover
                # — the budget is better spent recovering whatever file is
                # already on disk than letting bash thrash. PR #94 extracted
                # the fallback-construction logic into ``_build_ceiling_fallback``
                # so the consecutive-rejection short-circuit can reuse it.
                _HARD_CEILING = self._CEILING_FOR_FORCE
                if non_artifact_turns >= _HARD_CEILING:
                    logger.warning(
                        "BuilderArtifact: hard ceiling reached at turn=%d, tools=%s — forcing end with fallback",
                        non_artifact_turns,
                        joined_names,
                    )
                    fallback = self._build_ceiling_fallback(
                        state,
                        steps_completed=non_artifact_turns,
                        reason="hard_ceiling",
                    )
                    # Phase 4L: upload-before-webhook (see
                    # ``_upload_fallback_and_fire`` docstring). Same
                    # contract as the consecutive-rejection short-circuit
                    # above — ensures the ceiling-fallback file actually
                    # lands in Supabase before the channel adapter
                    # tries to download bytes for the user.
                    self._upload_fallback_and_fire(
                        state=state,
                        runtime=runtime,
                        fallback=fallback,
                        status="completed",
                    )
                    return {
                        "builder_result": fallback,
                        "builder_non_artifact_turns": 0,
                        "builder_last_tool_names": tool_names,
                        "builder_tool_turn_summaries": history,
                        "builder_task_started_at_ms": 0,
                        "builder_consecutive_empty_emit_rejections": 0,
                        "jump_to": "end",
                    }

                log_middleware(
                    "BuilderArtifact",
                    f"tool calls present but no builder artifact: turn={non_artifact_turns}, tools={joined_names}",
                    _t0,
                )
                return {
                    "builder_non_artifact_turns": non_artifact_turns,
                    "builder_last_tool_names": tool_names,
                    "builder_tool_turn_summaries": history,
                    "builder_task_started_at_ms": builder_task_started_at_ms,
                    # PR #94: any non-emit turn breaks the empty-rejection
                    # streak. Reset so the short-circuit only fires on
                    # *consecutive* empty emits.
                    "builder_consecutive_empty_emit_rejections": 0,
                }

            # AI message with NO tool calls -- agent ending with plain text, create fallback
            fallback = {
                "artifact_path": None,
                "artifact_type": "unknown",
                "artifact_title": "Build task completed",
                "steps_completed": 0,
                "decisions_made": [],
                "companion_summary": "The build task was completed.",
                "companion_tone_hint": "Neutral \u2014 no builder context available.",
                "user_next_action": None,
                "confidence": 0.3,
            }
            history = self._append_turn_summary(
                state,
                {
                    "turn": int(state.get("builder_non_artifact_turns", 0) or 0) + 1,
                    "tool_names": [],
                    "has_emit_builder_artifact": False,
                    "ended_with_plain_text": True,
                },
            )
            log_middleware("BuilderArtifact", "no builder artifact tool call, using fallback", _t0)
            # Fire the gateway webhook (phantom-success guard will likely
            # coerce this to an error card since the fallback has no
            # artifact_path and confidence=0.3).
            fire_completion_webhook_from_artifact(
                state=state,
                runtime=runtime,
                artifact=fallback,
                status="completed",
            )
            return {
                "builder_result": fallback,
                "builder_non_artifact_turns": 0,
                "builder_last_tool_names": [],
                "builder_tool_turn_summaries": history,
                "builder_consecutive_empty_emit_rejections": 0,
            }

        log_middleware("BuilderArtifact", "no AI message found", _t0)
        return None
