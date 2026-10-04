"""Content-free launch-timeline diagnostics.

``diag_event(name, **fields)`` logs exactly one ``sophia_diag {json}`` line.
Joins come from identifiers that already exist on every hop (source
``message_id``, companion ``thread_id``, child ``task_id``/``run_id``); inside
a LangGraph run the server also stamps ``run_id``/``thread_id``/``request_id``
on the record itself. No wire format changes.

Every field must be on a fixed key allowlist and pass the MEM00 denied-key
validator. Values are limited to ints, finite floats (milliseconds), bools,
short lowercase codes, UUIDs and keyed references, plus small nested maps of
the same. Anything else is dropped and counted: owner IDs, message text,
prompts, tool content, exception messages, URLs and bodies cannot be logged
through this helper. Nothing in this module may raise into a caller or change
an outcome; the per-run accumulators only add numbers.
"""

from __future__ import annotations

import functools
import inspect
import json
import logging
import math
import re
import sys
import threading
import time
from collections import OrderedDict
from collections.abc import Mapping
from contextvars import ContextVar
from typing import Any
from uuid import UUID

logger = logging.getLogger(__name__)

SLOW_GUARD_OP_MS = 750

_CODE = re.compile(r"^[a-z0-9_.:-]{1,64}$")
_UUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
_KEYED_REF = re.compile(r"^hmac-sha256:[a-z0-9._-]{1,64}:[0-9a-f]{64}$")
# Two keys carry identifiers that are not lowercase codes. Both are program
# structure, never content: a model-issued tool call id and a Python class name.
_OPAQUE_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
_KEY_VALUE_PATTERNS = {"tool_call_id": _OPAQUE_ID, "error_type": _IDENTIFIER}
_MAX_NESTED_DEPTH = 3
_MAX_COLLECTION = 48

_ALLOWED_KEYS = frozenset(
    {
        # Identity joins. Raw owner identifiers are never on this list.
        "thread_id",
        "run_id",
        "task_id",
        "child_thread_id",
        "child_run_id",
        "parent_thread_id",
        "source_message_id",
        "message_id",
        "tool_call_id",
        "handoff_event_id",
        "binding_event_id",
        "session_ref",
        # Fixed codes.
        "authority",
        "branch",
        "error_type",
        "event",
        "graph",
        "kind",
        "lane",
        "native_status",
        "op",
        "outcome",
        "phase",
        "reason",
        "route",
        "scope",
        "site",
        "store_scope",
        "task_type",
        # Durations in milliseconds.
        "bind_ms",
        "check_ms",
        "compile_ms",
        "duration_ms",
        "foundation_probe_ms",
        "guard_check_ms",
        "guard_init_ms",
        "issue_ms",
        "lag_ms",
        "mem0_ms",
        "ms",
        "observe_ms",
        "owner_authority_ms",
        "post_ms",
        "register_ms",
        "seed_ms",
        "since_run_created_ms",
        "since_run_start_ms",
        "store_ms",
        "total_ms",
        # Counts, flags and small aggregate maps.
        "applied",
        "by_op",
        "by_site",
        "check_count",
        "check_total_ms",
        "confirmed",
        "delivered",
        "denied",
        "dropped",
        "exports",
        "for_execution",
        "http_status",
        "mem0_client_ms",
        "mem0_client_new",
        "mem0_search_count",
        "mem0_search_ms",
        "readmit_count",
        "readmit_total_ms",
        "readmits",
        "replay",
        "seq",
        "slow_ops",
        "store_by_resource",
        "store_errors",
        "store_requests",
        "store_total_ms",
        "subscribers",
        "synthetic",
        "web_delivered",
    }
)
_RESERVED_KEYS = frozenset({"ev", "t_ms", "dropped_fields"})

_STATS_LOCK = threading.Lock()
_STATS = {"emitted": 0, "dropped_fields": 0, "failed": 0}


def _count(name: str, amount: int = 1) -> None:
    with _STATS_LOCK:
        _STATS[name] += amount


def diag_stats() -> dict[str, int]:
    """Process counters for tests and health checks, never per-owner."""
    with _STATS_LOCK:
        return dict(_STATS)


_VALIDATOR: Any = None


def _structural_validator():
    """The MEM00 denied-key validator, imported on first use.

    Imported lazily so governance modules can import this helper without an
    import cycle. If it cannot be loaded every field is dropped (fail closed).
    """
    global _VALIDATOR
    if _VALIDATOR is None:
        from deerflow.sophia.memory_governance.observability import _validate_structural_payload

        _VALIDATOR = _validate_structural_payload
    return _VALIDATOR


def _safe_value(key: str, value: object, depth: int = 0) -> tuple[bool, object]:
    if isinstance(value, bool):
        return True, value
    if isinstance(value, int):
        return True, value
    if isinstance(value, float):
        return (True, round(value, 1)) if math.isfinite(value) else (False, None)
    if isinstance(value, str):
        pattern = _KEY_VALUE_PATTERNS.get(key)
        if pattern is not None:
            return (True, value) if pattern.fullmatch(value) else (False, None)
        if _UUID.fullmatch(value):
            return True, value.lower()
        if _KEYED_REF.fullmatch(value) or _CODE.fullmatch(value):
            return True, value
        return False, None
    if isinstance(value, Mapping) and depth < _MAX_NESTED_DEPTH and len(value) <= _MAX_COLLECTION:
        result: dict[str, object] = {}
        for nested_key, nested in value.items():
            if not isinstance(nested_key, str) or not _CODE.fullmatch(nested_key):
                return False, None
            ok, safe = _safe_value(nested_key, nested, depth + 1)
            if not ok:
                return False, None
            result[nested_key] = safe
        return True, result
    if isinstance(value, (list, tuple)) and depth < _MAX_NESTED_DEPTH and len(value) <= _MAX_COLLECTION:
        items = []
        for nested in value:
            if isinstance(nested, (Mapping, list, tuple)):
                return False, None
            ok, safe = _safe_value(key, nested, depth + 1)
            if not ok:
                return False, None
            items.append(safe)
        return True, items
    return False, None


def validated_fields(fields: Mapping[str, object]) -> tuple[dict[str, object], int]:
    """Return the loggable subset of ``fields`` and how many were dropped.

    ``None`` means "not measured" and is skipped without counting.
    """
    safe: dict[str, object] = {}
    dropped = 0
    for key, value in fields.items():
        if value is None:
            continue
        if not isinstance(key, str) or key in _RESERVED_KEYS or key not in _ALLOWED_KEYS:
            dropped += 1
            continue
        try:
            # The MEM00 denied-key validator covers nested maps as well.
            _structural_validator()({key: value})
        except Exception:
            dropped += 1
            continue
        ok, normalized = _safe_value(key, value)
        if not ok:
            dropped += 1
            continue
        safe[key] = normalized
    return safe, dropped


def diag_event(name: str, /, *, _level: int = logging.INFO, **fields: object) -> None:
    """Log one content-free ``sophia_diag`` line. Never raises."""
    try:
        if not logger.isEnabledFor(_level):
            return
        safe, dropped = validated_fields(fields)
        record: dict[str, object] = {"ev": name if isinstance(name, str) and _CODE.fullmatch(name) else "invalid_event", "t_ms": int(time.time() * 1000), **safe}
        if dropped:
            record["dropped_fields"] = dropped
            _count("dropped_fields", dropped)
        logger.log(_level, "sophia_diag %s", json.dumps(record, sort_keys=True, separators=(",", ":"), allow_nan=False))
        _count("emitted")
    except Exception:  # noqa: BLE001 - diagnostics can never change an outcome.
        try:
            _count("failed")
        except Exception:
            pass


def elapsed_ms(started: float) -> int:
    """Whole milliseconds since a ``time.perf_counter()`` reading."""
    return int((time.perf_counter() - started) * 1000)


def safe_ref(domain: str, value: object) -> str | None:
    """Keyed reference for an identifier, or ``None`` when it cannot be made."""
    try:
        if not isinstance(value, str) or not value:
            return None
        from deerflow.sophia.memory_governance.refs import keyed_ref

        return keyed_ref(domain, value)
    except Exception:
        return None


def code_or_none(value: object) -> str | None:
    """Pass through a short lowercase code; anything else becomes ``None``."""
    return value if isinstance(value, str) and _CODE.fullmatch(value) else None


# ---------------------------------------------------------------------------
# Run timing
# ---------------------------------------------------------------------------

_RUN_STARTS: OrderedDict[str, float] = OrderedDict()
_RUN_STARTS_LOCK = threading.Lock()
_MAX_RUN_STARTS = 512


def _uuid_text(value: object) -> str | None:
    if value is None:
        return None
    try:
        return str(UUID(str(value)))
    except (TypeError, ValueError, AttributeError):
        return None


def current_run_identity() -> tuple[str | None, str | None]:
    """``(run_id, thread_id)`` of the LangGraph run executing this code, if any."""
    try:
        from langchain_core.runnables.config import var_child_runnable_config

        config = var_child_runnable_config.get() or {}
        configurable = config.get("configurable") or {}
        metadata = config.get("metadata") or {}
        run_id = _uuid_text(configurable.get("run_id") or metadata.get("run_id"))
        thread_id = _uuid_text(configurable.get("thread_id") or metadata.get("thread_id"))
        return run_id, thread_id
    except Exception:
        return None, None


def mark_run_start(run_id: object) -> None:
    run = _uuid_text(run_id)
    if run is None:
        return
    with _RUN_STARTS_LOCK:
        _RUN_STARTS.setdefault(run, time.time())
        while len(_RUN_STARTS) > _MAX_RUN_STARTS:
            _RUN_STARTS.popitem(last=False)


def run_timing(run_id: object = None) -> dict[str, int]:
    """Milliseconds since this run's graph factory ran, and since its UUIDv7 id was minted."""
    result: dict[str, int] = {}
    try:
        run = _uuid_text(run_id) or current_run_identity()[0]
        if run is None:
            return result
        now = time.time()
        with _RUN_STARTS_LOCK:
            started = _RUN_STARTS.get(run)
        if started is not None:
            result["since_run_start_ms"] = int((now - started) * 1000)
        parsed = UUID(run)
        if parsed.version == 7:
            created_ms = parsed.int >> 80
            age = int(now * 1000) - created_ms
            if 0 <= age < 86_400_000:
                result["since_run_created_ms"] = age
    except Exception:
        return result
    return result


# ---------------------------------------------------------------------------
# Per-run accumulator (governance store, Mem0 adapter, structural exports)
# ---------------------------------------------------------------------------

_RESOURCE = re.compile(r"^[a-z0-9_/]{1,80}$")


class RunDiag:
    """Counters for one run. Names and numbers only; safe to share across threads.

    The current accumulator lives in a context variable that holds this
    mutable object, so work started with ``asyncio.to_thread`` (which copies
    the context) adds to the same counters as the coroutine that started it.
    """

    def __init__(self, *, run_scoped: bool = False) -> None:
        # True only when the graph factory installed this for a whole run;
        # otherwise it counts work inside guard operations only.
        self.run_scoped = run_scoped
        self._lock = threading.Lock()
        self._store: dict[str, list[float]] = {}
        self._mem0 = {"client_new": 0, "client_ms": 0.0, "search": 0, "search_ms": 0.0}
        self._exports: dict[str, list[float]] = {}
        self.store_requests = 0
        self.store_ms = 0.0
        self.store_errors = 0

    def record_store(self, resource: str, ms: float, status_code: int | None) -> None:
        name = resource.replace("/", ".")[:64] if isinstance(resource, str) and _RESOURCE.fullmatch(resource) else "other"
        with self._lock:
            entry = self._store.setdefault(name, [0, 0.0, 0.0])
            entry[0] += 1
            entry[1] += ms
            entry[2] = max(entry[2], ms)
            self.store_requests += 1
            self.store_ms += ms
            if status_code is None or status_code >= 400:
                self.store_errors += 1

    def record_mem0(self, kind: str, ms: float) -> None:
        with self._lock:
            if kind == "client_new":
                self._mem0["client_new"] += 1
                self._mem0["client_ms"] += ms
            elif kind == "search":
                self._mem0["search"] += 1
                self._mem0["search_ms"] += ms

    def record_export(self, status: object, ms: float) -> None:
        name = status if isinstance(status, str) and _CODE.fullmatch(status) else "unknown"
        with self._lock:
            entry = self._exports.setdefault(name, [0, 0.0])
            entry[0] += 1
            entry[1] += ms

    def totals(self) -> tuple[int, float, float, int]:
        """Cheap ``(store_requests, store_ms, mem0_ms, exports)`` for deltas."""
        with self._lock:
            return (self.store_requests, self.store_ms, self._mem0["client_ms"] + self._mem0["search_ms"], sum(int(item[0]) for item in self._exports.values()))

    def snapshot(self, *, top: int = 12) -> dict[str, object]:
        with self._lock:
            resources = sorted(self._store.items(), key=lambda item: item[1][1], reverse=True)[:top]
            return {
                "store_requests": self.store_requests,
                "store_total_ms": int(self.store_ms),
                "store_errors": self.store_errors,
                "store_by_resource": {name: {"n": int(n), "ms": int(total), "max_ms": int(peak)} for name, (n, total, peak) in resources},
                "mem0_client_new": int(self._mem0["client_new"]),
                "mem0_client_ms": int(self._mem0["client_ms"]),
                "mem0_search_count": int(self._mem0["search"]),
                "mem0_search_ms": int(self._mem0["search_ms"]),
                "exports": {name: {"n": int(n), "ms": int(total)} for name, (n, total) in sorted(self._exports.items())},
            }


_RUN_DIAG: ContextVar[RunDiag | None] = ContextVar("sophia_run_diag", default=None)


def current_run_diag() -> RunDiag | None:
    return _RUN_DIAG.get()


def install_run_diag(diag: RunDiag | None = None):
    """Make ``diag`` (or a new accumulator) current; returns ``(diag, token)``."""
    diag = diag if diag is not None else RunDiag()
    return diag, _RUN_DIAG.set(diag)


def bind_run_diag(diag: RunDiag | None):
    """Make ``diag`` current unless it already is; returns a token or ``None``."""
    try:
        if diag is None or _RUN_DIAG.get() is diag:
            return None
        return _RUN_DIAG.set(diag)
    except Exception:
        return None


def reset_run_diag(token) -> None:
    if token is None:
        return
    try:
        _RUN_DIAG.reset(token)
    except Exception:
        pass


def record_store_request(resource: object, started: float, status_code: object) -> None:
    try:
        diag = _RUN_DIAG.get()
        if diag is not None:
            diag.record_store(str(resource), (time.perf_counter() - started) * 1000, status_code if isinstance(status_code, int) and not isinstance(status_code, bool) else None)
    except Exception:
        pass


def record_mem0(kind: str, ms: float) -> None:
    try:
        diag = _RUN_DIAG.get()
        if diag is not None:
            diag.record_mem0(kind, ms)
    except Exception:
        pass


def record_export(status: object, ms: float) -> None:
    try:
        diag = _RUN_DIAG.get()
        if diag is not None:
            diag.record_export(status, ms)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Memory guard per-run statistics
# ---------------------------------------------------------------------------


class GuardStats:
    """Per-guard operation counters. A guard is factory-local to one run."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.depth = 0
        self.ops: dict[str, list[float]] = {}
        self.sites: dict[str, list[Any]] = {}
        self.readmit = [0, 0.0]
        self.slow_ops = 0
        self.denied = 0
        self.summary_emitted = False

    def record_op(self, op: str, ms: float, *, site: str | None, denied: bool) -> None:
        with self._lock:
            entry = self.ops.setdefault(op, [0, 0.0])
            entry[0] += 1
            entry[1] += ms
            if site is not None:
                place = self.sites.setdefault(site, [0, 0.0, op])
                place[0] += 1
                place[1] += ms
                if ms > SLOW_GUARD_OP_MS:
                    self.slow_ops += 1
            if denied:
                self.denied += 1

    def record_readmit(self, ms: float) -> None:
        with self._lock:
            self.readmit[0] += 1
            self.readmit[1] += ms

    def readmit_count(self) -> int:
        with self._lock:
            return int(self.readmit[0])

    def summary(self) -> dict[str, object]:
        with self._lock:
            check = self.ops.get("check", [0, 0.0])
            sites = sorted(self.sites.items(), key=lambda item: item[1][1], reverse=True)[:_MAX_COLLECTION]
            return {
                "check_count": int(check[0]),
                "check_total_ms": int(check[1]),
                "readmit_count": int(self.readmit[0]),
                "readmit_total_ms": int(self.readmit[1]),
                "by_op": {op: {"n": int(n), "ms": int(ms)} for op, (n, ms) in sorted(self.ops.items())},
                "by_site": {site: {"n": int(n), "ms": int(ms), "op": op} for site, (n, ms, op) in sites},
                "slow_ops": self.slow_ops,
                "denied": self.denied,
            }


_SITE_SKIP_PREFIXES = ("deerflow.sophia.diag", "deerflow.agents.sophia_agent.middlewares.memory_context")


def site_label(explicit: str | None = None) -> str:
    """Program-structure label for a guard operation: LangGraph node plus caller.

    The node name survives ``asyncio.to_thread`` through the copied runnable
    config. The caller is the nearest ``deerflow`` frame outside the guard,
    available only for synchronous calls. Labels hold code names only.
    """
    try:
        parts: list[str] = []
        try:
            from langchain_core.runnables.config import var_child_runnable_config

            node = ((var_child_runnable_config.get() or {}).get("metadata") or {}).get("langgraph_node")
            if isinstance(node, str) and node:
                parts.append(node)
        except Exception:
            pass
        if explicit:
            parts.append(explicit)
        else:
            frame = sys._getframe(1)
            for _ in range(12):
                if frame is None:
                    break
                module = frame.f_globals.get("__name__", "")
                if isinstance(module, str) and module.startswith("deerflow.") and not module.startswith(_SITE_SKIP_PREFIXES):
                    parts.append(f"{module.rsplit('.', 1)[-1]}.{frame.f_code.co_name}")
                    break
                frame = frame.f_back
        label = ":".join(parts).lower().replace("middleware", "")
        label = re.sub(r"[^a-z0-9_.:-]", "_", label)[:64]
        return label if _CODE.fullmatch(label) else "unknown"
    except Exception:
        return "unknown"


# ---------------------------------------------------------------------------
# Graph factory timing
# ---------------------------------------------------------------------------


class _FactoryTiming:
    __slots__ = ("graph", "started", "segments", "marks", "token", "diag", "diag_token", "before", "config")

    def __init__(self, graph: str, config: object) -> None:
        self.graph = graph
        self.config = config
        self.started = time.perf_counter()
        self.segments: dict[str, float] = {}
        self.marks: dict[str, float] = {}
        self.token = None
        self.diag: RunDiag | None = None
        self.diag_token = None
        self.before = (0, 0.0, 0.0, 0)


_FACTORY: ContextVar[_FactoryTiming | None] = ContextVar("sophia_graph_factory_timing", default=None)


def _configurable(config: object) -> Mapping[str, object]:
    if isinstance(config, Mapping):
        configurable = config.get("configurable")
        if isinstance(configurable, Mapping):
            return configurable
    return {}


def _start_factory(graph: str, config: object) -> _FactoryTiming | None:
    try:
        timing = _FactoryTiming(graph, config)
        configurable = _configurable(config)
        for_execution = configurable.get("__is_for_execution__") is True
        current = _RUN_DIAG.get()
        if for_execution:
            # The server calls the factory inside the run's own task, so this
            # accumulator is visible to every node and worker thread of the run.
            # It is intentionally not reset; the task ends with the run.
            timing.diag, _ = install_run_diag(RunDiag(run_scoped=True))
            mark_run_start(configurable.get("run_id"))
        elif current is not None:
            timing.diag = current
        else:
            timing.diag, timing.diag_token = install_run_diag()
        timing.before = timing.diag.totals()
        timing.token = _FACTORY.set(timing)
        return timing
    except Exception:
        return None


def _finish_factory(timing: _FactoryTiming | None, error: BaseException | None = None) -> None:
    if timing is None:
        return
    try:
        total = (time.perf_counter() - timing.started) * 1000
        if timing.token is not None:
            _FACTORY.reset(timing.token)
        after = timing.diag.totals() if timing.diag is not None else timing.before
        reset_run_diag(timing.diag_token)
        configurable = _configurable(timing.config)
        pre_compile = timing.marks.get("pre_compile")
        diag_event(
            "graph.factory",
            graph=code_or_none(timing.graph),
            outcome="error" if error is not None else "ok",
            error_type=type(error).__name__ if error is not None else None,
            total_ms=int(total),
            guard_init_ms=int(timing.segments["guard_init"]) if "guard_init" in timing.segments else None,
            foundation_probe_ms=int(timing.segments["foundation_probe"]) if "foundation_probe" in timing.segments else None,
            compile_ms=int(total - pre_compile) if pre_compile is not None else None,
            store_requests=after[0] - timing.before[0],
            store_ms=int(after[1] - timing.before[1]),
            for_execution=configurable.get("__is_for_execution__") is True,
            run_id=_uuid_text(configurable.get("run_id")),
            thread_id=_uuid_text(configurable.get("thread_id")),
        )
    except Exception:
        pass


def factory_segment_add(name: str, ms: float) -> None:
    """Add a measured sub-step to the graph factory call in progress, if any."""
    try:
        timing = _FACTORY.get()
        if timing is not None:
            timing.segments[name] = timing.segments.get(name, 0.0) + ms
    except Exception:
        pass


def factory_mark(name: str) -> None:
    """Record elapsed factory time at a named point (first mark wins)."""
    try:
        timing = _FACTORY.get()
        if timing is not None:
            timing.marks.setdefault(name, (time.perf_counter() - timing.started) * 1000)
    except Exception:
        pass


class factory_segment:
    """``with factory_segment("foundation_probe"):`` times a factory sub-step."""

    __slots__ = ("name", "started")

    def __init__(self, name: str) -> None:
        self.name = name
        self.started = 0.0

    def __enter__(self):
        self.started = time.perf_counter()
        return self

    def __exit__(self, exc_type, exc, tb):
        factory_segment_add(self.name, (time.perf_counter() - self.started) * 1000)
        return False


class _TimedAsyncFactory:
    """Times an async-context-manager factory from entry until it yields a graph."""

    def __init__(self, inner: Any, graph: str, config: object) -> None:
        self._inner = inner
        self._graph = graph
        self._config = config

    async def __aenter__(self):
        timing = _start_factory(self._graph, self._config)
        try:
            value = await self._inner.__aenter__()
        except BaseException as exc:
            _finish_factory(timing, exc)
            raise
        _finish_factory(timing)
        return value

    async def __aexit__(self, exc_type, exc, tb):
        return await self._inner.__aexit__(exc_type, exc, tb)


def _config_argument(args: tuple, kwargs: Mapping[str, object]) -> object:
    if "config" in kwargs:
        return kwargs["config"]
    return args[0] if args else None


def timed_graph_factory(graph: str):
    """Decorate a registered graph factory with one ``graph.factory`` event per call.

    The wrapped callable keeps its signature (the server classifies factories
    by it) and return value. A nested decorated factory inside an outer one is
    passed through, so one server factory call emits one event.
    """

    def decorate(factory):
        # An @asynccontextmanager factory runs its body only when the server
        # enters it, so it is timed there rather than at the call.
        async_context = inspect.isasyncgenfunction(inspect.unwrap(factory))

        @functools.wraps(factory)
        def wrapper(*args, **kwargs):
            if _FACTORY.get() is not None:
                return factory(*args, **kwargs)
            config = _config_argument(args, kwargs)
            if async_context:
                return _TimedAsyncFactory(factory(*args, **kwargs), graph, config)
            timing = _start_factory(graph, config)
            try:
                result = factory(*args, **kwargs)
            except BaseException as exc:
                _finish_factory(timing, exc)
                raise
            _finish_factory(timing)
            return result

        return wrapper

    return decorate
