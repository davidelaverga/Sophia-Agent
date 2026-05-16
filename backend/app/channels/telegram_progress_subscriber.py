"""BuilderProgressSubscriber — one v3 stream subscription per builder task.

Owns the lifecycle of a single Telegram progress message:

1. The companion's manager publishes a plain-text placeholder
   (``"Working on it…"``) carrying ``metadata["builder_progress"]``
   with the builder's task_id + run_id + user_id.
2. ``TelegramChannel.send`` sees the marker, sends the placeholder
   normally, and after capturing the resulting ``message_id`` spawns
   a ``BuilderProgressSubscriber`` task that:
   - Opens ``client.runs.join_stream(thread_id, run_id, stream_mode=...)``
   - Iterates ``StreamPart(event, data, id)`` chunks
   - Renders each via ``ProgressRenderer.apply``
   - Edits the placeholder via ``bot.edit_message_text`` (rate-limited)
   - On stream end: marks the renderer done and pushes a final edit

The subscriber runs ON the EI bot's ``_tg_loop`` so bot calls are
loop-affine and no cross-loop bridges are required. The existing
``_on_builder_completion`` path (subscribed to
``bus.publish_builder_completion``) still delivers the artifact as a
separate document attachment when the builder fires the terminal
webhook — this subscriber does NOT also try to deliver.

Spec reference: the v3 streaming migration plan, Phase 4D.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any

from app.channels.telegram_progress_renderer import ProgressRenderer

logger = logging.getLogger(__name__)


_DEFAULT_EDIT_INTERVAL_MS = 800       # Telegram editMessageText rate-limit
_DEFAULT_PER_EVENT_TIMEOUT_S = 120    # generous; runs go quiet during bash/build
_DEFAULT_TOTAL_TIMEOUT_S = 1800       # 30 min hard cap; matches BuilderArtifactMiddleware
_DEFAULT_LANGGRAPH_URL = "http://localhost:2024"


def _resolved_int(env_key: str, default: int) -> int:
    try:
        return int(os.environ.get(env_key, default))
    except (TypeError, ValueError):
        return default


def _streaming_enabled() -> bool:
    """Master kill switch — operator can flip with no code redeploy."""
    return os.environ.get("BUILDER_PROGRESS_ENABLED", "true").lower() not in {"0", "false", "no"}


class BuilderProgressSubscriber:
    """Lifecycle owner for one builder run's progress placeholder.

    Construction is cheap; :meth:`run` opens the stream. Callers spawn
    it via ``asyncio.create_task`` on the EI bot's ``_tg_loop``.
    """

    def __init__(
        self,
        *,
        bot: Any,
        chat_id: int,
        message_id: int,
        thread_id: str,
        run_id: str,
        task_id: str,
        langgraph_url: str | None = None,
    ) -> None:
        self._bot = bot
        self._chat_id = chat_id
        self._message_id = message_id
        self._thread_id = thread_id
        self._run_id = run_id
        self._task_id = task_id
        self._langgraph_url = langgraph_url or os.environ.get("LANGGRAPH_URL", _DEFAULT_LANGGRAPH_URL)
        self._renderer = ProgressRenderer()
        self._edit_interval_ms = _resolved_int("BUILDER_PROGRESS_EDIT_INTERVAL_MS", _DEFAULT_EDIT_INTERVAL_MS)
        self._per_event_timeout_s = _resolved_int("BUILDER_PROGRESS_PER_EVENT_TIMEOUT_S", _DEFAULT_PER_EVENT_TIMEOUT_S)
        self._total_timeout_s = _resolved_int("BUILDER_PROGRESS_TOTAL_TIMEOUT_S", _DEFAULT_TOTAL_TIMEOUT_S)
        self._last_pushed_body: str = ""
        self._last_edit_ts: float = 0.0

    async def run(self) -> None:
        """Subscribe to the builder run and push placeholder edits.

        Returns when the stream ends, errors out, or hits a timeout.
        Exceptions are logged and swallowed — the artifact-delivery
        path via ``_on_builder_completion`` is independent and is the
        durability backstop.

        Phase 4F: tracks the exit reason ("outcome") so the final
        placeholder edit reflects reality. A per-event timeout does
        NOT mean the build is done — it means the gateway lost the
        live signal. ``mark_stalled`` keeps the placeholder honest
        ("still working, no events for Ns") instead of pushing a
        misleading "[ Done ]" edit.
        """
        if not _streaming_enabled():
            logger.info(
                "[ProgressSubscriber] BUILDER_PROGRESS_ENABLED=false — skipping task_id=%s",
                self._task_id,
            )
            return
        logger.info(
            "[ProgressSubscriber] opened stream task_id=%s thread_id=%s run_id=%s chat_id=%s message_id=%s",
            self._task_id,
            self._thread_id,
            self._run_id,
            self._chat_id,
            self._message_id,
        )
        # Inner outcome is mutated by ``_run_inner`` (or left at its
        # default if we never get there). The outer try/except may
        # overwrite it on timeout / cancel / error.
        self._outcome: str = "stream_complete"
        try:
            await asyncio.wait_for(self._run_inner(), timeout=self._total_timeout_s)
        except TimeoutError:
            self._outcome = "total_timeout"
            logger.warning(
                "[ProgressSubscriber] total timeout exceeded task_id=%s timeout=%ds",
                self._task_id,
                self._total_timeout_s,
            )
        except asyncio.CancelledError:
            self._outcome = "cancelled"
            logger.info("[ProgressSubscriber] cancelled task_id=%s", self._task_id)
            raise
        except Exception:
            self._outcome = "error"
            logger.warning(
                "[ProgressSubscriber] run raised task_id=%s",
                self._task_id,
                exc_info=True,
            )
        finally:
            # Push a final edit appropriate to the exit reason. The
            # placeholder must not sit on "Working on it…" forever, but
            # it ALSO must not lie about completion when we merely lost
            # the live signal.
            try:
                self._finalize(self._outcome)
                await self._push_edit(force=True)
            except Exception:
                logger.warning(
                    "[ProgressSubscriber] final edit failed task_id=%s outcome=%s",
                    self._task_id,
                    self._outcome,
                    exc_info=True,
                )

    def _finalize(self, outcome: str) -> None:
        """Map an exit reason onto the renderer's terminal call.

        ``stream_complete`` → ``[ Done ]``       (natural iterator exhaustion)
        ``per_event_timeout`` / ``total_timeout`` → ``[ Still working ]``
            (NOT terminal — the build may keep going; artifact path is independent)
        ``error`` / ``cancelled`` → ``[ Stopped ]`` (terminal — subscriber won't edit again)
        """
        if outcome == "stream_complete":
            self._renderer.mark_done()
            return
        if outcome == "per_event_timeout":
            self._renderer.mark_stalled(reason=f"no events for {self._per_event_timeout_s}s")
            return
        if outcome == "total_timeout":
            self._renderer.mark_stalled(
                reason=f"hit {self._total_timeout_s // 60}-min ceiling"
            )
            return
        # error / cancelled / unknown
        self._renderer.mark_stopped(reason=outcome)

    async def _run_inner(self) -> None:
        client = await self._build_client()
        if client is None:
            return
        stream_iter = self._open_stream(client)
        if stream_iter is None:
            return

        chunk_count = 0
        async for chunk in self._iter_with_event_timeout(stream_iter):
            chunk_count += 1
            event_name = getattr(chunk, "event", None) or "unknown"
            payload = getattr(chunk, "data", None)
            result = self._renderer.apply(event_name, payload)
            if result.state_changed:
                await self._push_edit()
            if result.terminal:
                # Renderer self-marked terminal (rare — most streams
                # just end via stop-iteration). Treat as natural exit.
                self._outcome = "stream_complete"
                return
        logger.info(
            "[ProgressSubscriber] stream completed task_id=%s chunks=%d",
            self._task_id,
            chunk_count,
        )
        # Reach here only on natural iterator exhaustion (StopAsyncIteration)
        # or per-event timeout. ``_iter_with_event_timeout`` sets
        # ``self._outcome = "per_event_timeout"`` on the timeout path; on
        # natural completion the outcome stays at its default
        # ``"stream_complete"``.

    async def _build_client(self) -> Any | None:
        try:
            from langgraph_sdk import get_client  # type: ignore[import-not-found]
        except ImportError:
            logger.error("[ProgressSubscriber] langgraph_sdk not installed — task_id=%s", self._task_id)
            return None
        try:
            return get_client(url=self._langgraph_url)
        except Exception:
            logger.warning(
                "[ProgressSubscriber] failed to construct SDK client url=%s task_id=%s",
                self._langgraph_url,
                self._task_id,
                exc_info=True,
            )
            return None

    def _open_stream(self, client: Any) -> Any | None:
        try:
            return client.runs.join_stream(
                self._thread_id,
                self._run_id,
                stream_mode=["messages", "updates", "custom"],
            )
        except Exception:
            logger.warning(
                "[ProgressSubscriber] runs.join_stream failed task_id=%s thread_id=%s run_id=%s",
                self._task_id,
                self._thread_id,
                self._run_id,
                exc_info=True,
            )
            return None

    async def _iter_with_event_timeout(self, stream_iter: Any):
        """Yield chunks with a per-event-arrival timeout.

        A long bash build can run silently for minutes; the per-event
        timeout is generous (120s default) so quiet builds don't get
        cut off. The total timeout is the real ceiling.

        Phase 4F: on per-event timeout we record
        ``self._outcome = "per_event_timeout"`` so the finalizer can
        choose ``[ Still working ]`` instead of the misleading
        ``[ Done ]`` edit. ``StopAsyncIteration`` is natural completion
        and leaves the outcome at its ``"stream_complete"`` default.
        """
        iterator = stream_iter.__aiter__()
        while True:
            try:
                chunk = await asyncio.wait_for(iterator.__anext__(), timeout=self._per_event_timeout_s)
            except TimeoutError:
                self._outcome = "per_event_timeout"
                logger.warning(
                    "[ProgressSubscriber] per-event timeout task_id=%s timeout=%ds — closing stream",
                    self._task_id,
                    self._per_event_timeout_s,
                )
                return
            except StopAsyncIteration:
                return
            except Exception:
                self._outcome = "error"
                logger.warning(
                    "[ProgressSubscriber] iterator raised task_id=%s",
                    self._task_id,
                    exc_info=True,
                )
                return
            yield chunk

    async def _push_edit(self, *, force: bool = False) -> None:
        """Push the current rendered body to Telegram, rate-limited.

        Plain text (no parse_mode) — Telegram's Markdown parser chokes
        on unescaped tool-arg content (URLs with ``_``, file paths
        with ``[]``, shell commands with ``*``).
        """
        body = self._renderer.render()
        if not body:
            return
        now = time.monotonic()
        elapsed_ms = (now - self._last_edit_ts) * 1000.0
        if not force and elapsed_ms < self._edit_interval_ms:
            return
        if body == self._last_pushed_body:
            return
        try:
            await self._bot.edit_message_text(
                chat_id=self._chat_id,
                message_id=self._message_id,
                text=body,
            )
            self._last_pushed_body = body
            self._last_edit_ts = now
        except Exception:
            logger.warning(
                "[ProgressSubscriber] edit_message_text failed task_id=%s chat_id=%s message_id=%s",
                self._task_id,
                self._chat_id,
                self._message_id,
                exc_info=True,
            )


__all__ = ["BuilderProgressSubscriber"]
