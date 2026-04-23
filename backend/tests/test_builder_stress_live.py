"""Live builder validation for Sophia companion via runs/stream.

This module intentionally stays opt-in because it requires a running LangGraph
API, real model credentials, and enough time for delegated builder work to
finish.

Supported suites:
    - stress: concurrent PDF-only regression gate for the artifact path already
      hardened in backend middleware.
    - soak: longer mixed-format soak across PDF, markdown, and standalone HTML
      prompts that exercise builder routing and artifact validation together.

Usage:
    RUN_LIVE_BUILDER_STRESS=1 uv run pytest tests/test_builder_stress_live.py -q -s -k stress
    RUN_LIVE_BUILDER_SOAK=1 uv run pytest tests/test_builder_stress_live.py -q -s -k soak

Useful overrides:
    BUILDER_STRESS_LANGGRAPH_URL=http://127.0.0.1:2024
    BUILDER_STRESS_LOG_PATH=../logs/langgraph.log
    BUILDER_STRESS_REQUESTS=8
    BUILDER_STRESS_MAX_IN_FLIGHT=4
    BUILDER_STRESS_PAGE_COUNT=4
    BUILDER_SOAK_REQUESTS=18
    BUILDER_SOAK_MAX_IN_FLIGHT=4
    BUILDER_SOAK_PDF_PAGE_COUNT=4
    BUILDER_LIVE_VALIDATE_QUALITY=1
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
import uuid
from dataclasses import asdict, dataclass
from difflib import SequenceMatcher
from html import unescape
from pathlib import Path

import httpx
import pytest
from pypdf import PdfReader

from deerflow.config.paths import Paths

RUN_STRESS = os.environ.get("RUN_LIVE_BUILDER_STRESS") == "1"
RUN_SOAK = os.environ.get("RUN_LIVE_BUILDER_SOAK") == "1"

if not RUN_STRESS and not RUN_SOAK:
    pytest.skip(
        "Set RUN_LIVE_BUILDER_STRESS=1 or RUN_LIVE_BUILDER_SOAK=1 to run live builder validation",
        allow_module_level=True,
    )


BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
LANGGRAPH_URL = os.environ.get("BUILDER_STRESS_LANGGRAPH_URL", "http://127.0.0.1:2024")
LOG_PATH = Path(os.environ.get("BUILDER_STRESS_LOG_PATH", REPO_ROOT / "logs" / "langgraph.log"))
STRESS_REQUEST_COUNT = int(os.environ.get("BUILDER_STRESS_REQUESTS", "6"))
STRESS_MAX_IN_FLIGHT = int(os.environ.get("BUILDER_STRESS_MAX_IN_FLIGHT", "3"))
STRESS_PAGE_COUNT = int(os.environ.get("BUILDER_STRESS_PAGE_COUNT", "3"))
SOAK_REQUEST_COUNT = int(os.environ.get("BUILDER_SOAK_REQUESTS", "18"))
SOAK_MAX_IN_FLIGHT = int(os.environ.get("BUILDER_SOAK_MAX_IN_FLIGHT", "4"))
SOAK_PDF_PAGE_COUNT = int(os.environ.get("BUILDER_SOAK_PDF_PAGE_COUNT", "4"))
STREAM_TIMEOUT_SECONDS = float(os.environ.get("BUILDER_STRESS_STREAM_TIMEOUT_SECONDS", "120"))
STREAM_ACCEPT_TIMEOUT_SECONDS = float(
    os.environ.get("BUILDER_STRESS_STREAM_ACCEPT_TIMEOUT_SECONDS", "10")
)
SNAPSHOT_APPEAR_TIMEOUT_SECONDS = float(
    os.environ.get("BUILDER_STRESS_SNAPSHOT_APPEAR_TIMEOUT_SECONDS", "60")
)
SNAPSHOT_TIMEOUT_SECONDS = float(os.environ.get("BUILDER_STRESS_SNAPSHOT_TIMEOUT_SECONDS", "420"))
POLL_INTERVAL_SECONDS = float(os.environ.get("BUILDER_STRESS_POLL_INTERVAL_SECONDS", "1"))
VALIDATE_QUALITY = os.environ.get(
    "BUILDER_LIVE_VALIDATE_QUALITY",
    os.environ.get("BUILDER_STRESS_VALIDATE_QUALITY", "1"),
) == "1"
MIN_PAGE_TEXT_CHARS = int(os.environ.get("BUILDER_STRESS_MIN_PAGE_TEXT_CHARS", "180"))
MIN_TOTAL_TEXT_CHARS = int(os.environ.get("BUILDER_STRESS_MIN_TOTAL_TEXT_CHARS", "900"))
MAX_PAGE_SIMILARITY = float(os.environ.get("BUILDER_STRESS_MAX_PAGE_SIMILARITY", "0.92"))
PATHS = Paths(BACKEND_ROOT / ".deer-flow")
TERMINAL_STATUSES = {"completed", "failed", "timed_out", "cancelled"}
_WORD_RE = re.compile(r"[a-z0-9]+")
_MARKDOWN_BULLET_RE = re.compile(r"(?m)^\s*[-*]\s+")
_HTML_LIST_ITEM_RE = re.compile(r"<li\b", re.IGNORECASE)
_HTML_SCRIPT_STYLE_RE = re.compile(r"<(script|style)\b.*?</\1>", re.IGNORECASE | re.DOTALL)
_HTML_TAG_RE = re.compile(r"<[^>]+>")
_PEAR_TOPIC_GROUPS = {
    2: ("varieties", ("variet", "bartlett", "anjou", "bosc", "comice", "concorde")),
    3: ("storage_serving", ("storage", "store", "serv", "ripen", "refrigerat", "pairing")),
}
PDF_PROMPT_TEMPLATES = [
    "Sophia, please create a {pages}-page PDF titled '{title}'. {section_brief}",
    "I need a real {pages}-page PDF called '{title}'. Keep it polished and make sure {section_brief_lower}.",
    "Generate a {pages}-page PDF named '{title}'. Make it something I can actually open, with {section_brief_lower}.",
    "Create a {pages}-page PDF titled '{title}' for me. I want {section_brief_lower}.",
]


@dataclass(frozen=True)
class LiveCaseSpec:
    case_id: str
    title: str
    prompt: str
    artifact_kind: str
    expected_suffix: str
    expected_page_count: int | None = None
    min_total_text_chars: int = 0
    min_item_count: int = 0
    required_terms: tuple[str, ...] = ()
    required_html_tags: tuple[str, ...] = ()


@dataclass
class StressCaseResult:
    user_id: str
    thread_id: str
    case_id: str
    title: str
    artifact_kind: str
    expected_suffix: str
    expected_page_count: int | None
    task_id: str | None
    trace_id: str | None
    status: str
    detail: str | None
    error: str | None
    builder_result_present: bool
    artifact_path: str | None
    resolved_artifact_path: str | None
    observed_page_count: int | None
    observed_text_length: int | None
    page_text_lengths: list[int] | None
    quality_issues: list[str] | None


def _build_pdf_prompt(index: int, title: str, *, page_count: int) -> str:
    template = PDF_PROMPT_TEMPLATES[index % len(PDF_PROMPT_TEMPLATES)]
    sections = [
        "page 1 covering pear basics",
        "page 2 comparing common pear varieties",
        "page 3 with storage and serving guidance",
    ]
    if page_count > len(sections):
        for page_number in range(len(sections) + 1, page_count + 1):
            sections.append(f"page {page_number} with additional practical pear notes")

    selected_sections = sections[:page_count]
    if len(selected_sections) == 1:
        section_brief = f"Include {selected_sections[0]}."
    else:
        section_brief = "Include " + ", ".join(selected_sections[:-1]) + f", and {selected_sections[-1]}."

    return template.format(
        title=title,
        pages=page_count,
        section_brief=section_brief,
        section_brief_lower=section_brief[0].lower() + section_brief[1:],
    )


def _build_stress_case(index: int) -> LiveCaseSpec:
    title = f"Stress Prompt Atlas {index}"
    return LiveCaseSpec(
        case_id=f"stress-pdf-{index}",
        title=title,
        prompt=_build_pdf_prompt(index, title, page_count=STRESS_PAGE_COUNT),
        artifact_kind="pdf",
        expected_suffix=".pdf",
        expected_page_count=STRESS_PAGE_COUNT,
        min_total_text_chars=max(MIN_TOTAL_TEXT_CHARS, STRESS_PAGE_COUNT * 220),
        required_terms=("pear", "variet", "storage", "serv"),
    )


def _build_soak_case(index: int) -> LiveCaseSpec:
    case_index = (index - 1) % 6

    if case_index == 0:
        title = f"Soak Fruit Atlas {index}"
        return LiveCaseSpec(
            case_id=f"soak-pdf-a-{index}",
            title=title,
            prompt=_build_pdf_prompt(index, title, page_count=SOAK_PDF_PAGE_COUNT),
            artifact_kind="pdf",
            expected_suffix=".pdf",
            expected_page_count=SOAK_PDF_PAGE_COUNT,
            min_total_text_chars=max(MIN_TOTAL_TEXT_CHARS, SOAK_PDF_PAGE_COUNT * 220),
            required_terms=("pear", "variet", "storage", "serv"),
        )

    if case_index == 1:
        title = f"Pear Notes {index}"
        return LiveCaseSpec(
            case_id=f"soak-md-a-{index}",
            title=title,
            prompt=(
                f"Sophia, give me a markdown document titled '{title}' with a level 1 heading and exactly six "
                "bullet points about buying, ripening, storing, and serving pears."
            ),
            artifact_kind="markdown",
            expected_suffix=".md",
            min_total_text_chars=160,
            min_item_count=6,
            required_terms=("pear", "buy", "ripen", "stor", "serv"),
        )

    if case_index == 2:
        title = f"Fruit Quick View {index}"
        return LiveCaseSpec(
            case_id=f"soak-html-a-{index}",
            title=title,
            prompt=(
                f"Sophia, send me a standalone HTML file titled '{title}' with a title, one short intro paragraph, "
                "and two short unordered lists comparing pears and apples."
            ),
            artifact_kind="html",
            expected_suffix=".html",
            min_total_text_chars=140,
            min_item_count=4,
            required_terms=("pear", "apple"),
            required_html_tags=("<html", "<ul", "<li"),
        )

    if case_index == 3:
        title = f"Pear Serving Dossier {index}"
        page_count = max(3, SOAK_PDF_PAGE_COUNT - 1)
        return LiveCaseSpec(
            case_id=f"soak-pdf-b-{index}",
            title=title,
            prompt=(
                f"I need a real {page_count}-page PDF called '{title}'. Keep it polished and make sure "
                "page 1 covers pear basics and buying cues, page 2 compares common pear varieties, and "
                "page 3 covers storage, ripening, and serving pairings."
            ),
            artifact_kind="pdf",
            expected_suffix=".pdf",
            expected_page_count=page_count,
            min_total_text_chars=max(MIN_TOTAL_TEXT_CHARS, page_count * 220),
            required_terms=("pear", "variet", "storage", "pairing"),
        )

    if case_index == 4:
        title = f"Pear Buying Checklist {index}"
        return LiveCaseSpec(
            case_id=f"soak-md-b-{index}",
            title=title,
            prompt=(
                f"I need a markdown document called '{title}'. Start with a short heading, then give me exactly "
                "five bullet points and a final short checklist about choosing, ripening, and storing pears."
            ),
            artifact_kind="markdown",
            expected_suffix=".md",
            min_total_text_chars=150,
            min_item_count=5,
            required_terms=("pear", "choos", "ripen", "stor", "checklist"),
        )

    title = f"Pear Storage Quick View {index}"
    return LiveCaseSpec(
        case_id=f"soak-html-b-{index}",
        title=title,
        prompt=(
            f"Sophia, give me a standalone HTML file titled '{title}' with an h1, one short intro paragraph, "
            "and two sections with unordered lists for pear buying tips and storage tips."
        ),
        artifact_kind="html",
        expected_suffix=".html",
        min_total_text_chars=130,
        min_item_count=4,
        required_terms=("pear", "buy", "stor", "tip"),
        required_html_tags=("<html", "<h1", "<ul", "<li"),
    )


def _snapshot_dir(user_id: str) -> Path:
    return REPO_ROOT / "users" / user_id / "builder_tasks"


def _existing_task_ids(user_id: str) -> set[str]:
    task_dir = _snapshot_dir(user_id)
    if not task_dir.exists():
        return set()
    return {path.stem for path in task_dir.glob("*.json")}


def _read_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def _read_appended_log(start_offset: int) -> str:
    if not LOG_PATH.exists():
        return ""
    with LOG_PATH.open("rb") as handle:
        handle.seek(start_offset)
        return handle.read().decode("utf-8", errors="ignore")


def _normalize_artifact_path(thread_id: str, artifact_path: str | None) -> Path | None:
    if not artifact_path:
        return None

    candidate = artifact_path.strip()
    if not candidate:
        return None

    if candidate.startswith("/mnt/user-data/"):
        return PATHS.resolve_virtual_path(thread_id, candidate)

    if not candidate.startswith("/"):
        return PATHS.resolve_virtual_path(thread_id, f"/mnt/user-data/{candidate}")

    return None


def _read_pdf_page_count(path: Path | None) -> int | None:
    if path is None or not path.exists() or path.suffix.lower() != ".pdf":
        return None
    return len(PdfReader(str(path)).pages)


def _normalize_text(text: str) -> str:
    return " ".join(_WORD_RE.findall(text.lower()))


def _contains_title_text(document_text: str, requested_title: str) -> bool:
    normalized_title = _normalize_text(requested_title)
    if not normalized_title:
        return True
    if normalized_title in document_text:
        return True

    title_tokens = [token for token in normalized_title.split() if len(token) > 1 or token.isdigit()]
    if not title_tokens:
        return True
    return all(token in document_text for token in title_tokens)


def _read_pdf_page_texts(path: Path | None) -> list[str]:
    if path is None or not path.exists() or path.suffix.lower() != ".pdf":
        return []
    reader = PdfReader(str(path))
    return [_normalize_text(page.extract_text() or "") for page in reader.pages]


def _strip_html_markup(raw_html: str) -> str:
    without_scripts = _HTML_SCRIPT_STYLE_RE.sub(" ", raw_html)
    without_tags = _HTML_TAG_RE.sub(" ", without_scripts)
    return unescape(without_tags)


def _validate_pdf_quality(
    path: Path | None,
    *,
    title: str,
    page_count: int,
    min_total_text_chars: int,
    required_terms: tuple[str, ...],
) -> tuple[int | None, list[int] | None, list[str]]:
    if not VALIDATE_QUALITY:
        return None, None, []

    page_texts = _read_pdf_page_texts(path)
    if not page_texts:
        return None, None, ["PDF text extraction returned no content"]

    page_text_lengths = [len(text) for text in page_texts]
    full_text = " ".join(page_texts)
    issues: list[str] = []

    if not _contains_title_text(full_text, title):
        issues.append("deliverable text does not contain the requested title")

    if len(full_text) < min_total_text_chars:
        issues.append(f"deliverable text is too short ({len(full_text)} < {min_total_text_chars})")

    short_pages = [index + 1 for index, length in enumerate(page_text_lengths) if length < MIN_PAGE_TEXT_CHARS]
    if short_pages:
        issues.append(
            "pages with too little extracted text: "
            + ", ".join(str(page_number) for page_number in short_pages)
        )

    repeated_pairs: list[str] = []
    for left_index in range(len(page_texts)):
        for right_index in range(left_index + 1, len(page_texts)):
            similarity = SequenceMatcher(None, page_texts[left_index], page_texts[right_index]).ratio()
            if similarity > MAX_PAGE_SIMILARITY:
                repeated_pairs.append(f"{left_index + 1}-{right_index + 1}:{similarity:.2f}")
    if repeated_pairs:
        issues.append("pages are too similar: " + ", ".join(repeated_pairs))

    missing_topics = [
        name
        for required_page, (name, stems) in _PEAR_TOPIC_GROUPS.items()
        if page_count >= required_page and not any(stem in full_text for stem in stems)
    ]
    if missing_topics:
        issues.append("missing expected topic coverage: " + ", ".join(missing_topics))

    missing_terms = [term for term in required_terms if term not in full_text]
    if missing_terms:
        issues.append("missing expected terms: " + ", ".join(missing_terms))

    return len(full_text), page_text_lengths, issues


def _validate_text_document_quality(path: Path | None, spec: LiveCaseSpec) -> tuple[int | None, list[str]]:
    if not VALIDATE_QUALITY:
        return None, []

    if path is None or not path.exists():
        return None, ["text artifact is missing"]

    raw_text = path.read_text(encoding="utf-8", errors="ignore")
    raw_lower = raw_text.lower()

    if spec.artifact_kind == "html":
        missing_tags = [tag for tag in spec.required_html_tags if tag not in raw_lower]
        normalized_text = _normalize_text(_strip_html_markup(raw_text))
        item_count = len(_HTML_LIST_ITEM_RE.findall(raw_text))
    else:
        missing_tags = []
        normalized_text = _normalize_text(raw_text)
        item_count = len(_MARKDOWN_BULLET_RE.findall(raw_text))

    issues: list[str] = []
    if not _contains_title_text(normalized_text, spec.title):
        issues.append("deliverable text does not contain the requested title")

    if len(normalized_text) < spec.min_total_text_chars:
        issues.append(f"deliverable text is too short ({len(normalized_text)} < {spec.min_total_text_chars})")

    if spec.min_item_count and item_count < spec.min_item_count:
        issues.append(f"deliverable has too few list items ({item_count} < {spec.min_item_count})")

    if missing_tags:
        issues.append("deliverable is missing expected HTML tags: " + ", ".join(missing_tags))

    missing_terms = [term for term in spec.required_terms if term not in normalized_text]
    if missing_terms:
        issues.append("missing expected terms: " + ", ".join(missing_terms))

    return len(normalized_text), issues


def _validate_artifact_quality(
    path: Path | None,
    spec: LiveCaseSpec,
) -> tuple[int | None, int | None, list[int] | None, list[str]]:
    if path is None:
        return None, None, None, ["artifact path could not be resolved"]
    if not path.exists():
        return None, None, None, [f"resolved artifact does not exist: {path}"]

    issues: list[str] = []
    observed_suffix = path.suffix.lower()
    if observed_suffix != spec.expected_suffix:
        issues.append(
            f"artifact extension mismatch ({observed_suffix or '<none>'} != {spec.expected_suffix})"
        )

    if spec.artifact_kind == "pdf":
        observed_page_count = _read_pdf_page_count(path)
        observed_text_length, page_text_lengths, pdf_issues = _validate_pdf_quality(
            path,
            title=spec.title,
            page_count=spec.expected_page_count or 1,
            min_total_text_chars=spec.min_total_text_chars,
            required_terms=spec.required_terms,
        )
        issues.extend(pdf_issues)
        return observed_page_count, observed_text_length, page_text_lengths, issues

    observed_text_length, text_issues = _validate_text_document_quality(path, spec)
    issues.extend(text_issues)
    return None, observed_text_length, None, issues


async def _create_thread(client: httpx.AsyncClient) -> str:
    response = await client.post(f"{LANGGRAPH_URL}/threads", json={})
    response.raise_for_status()
    return response.json()["thread_id"]


async def _stream_turn(client: httpx.AsyncClient, *, thread_id: str, user_id: str, prompt: str) -> None:
    payload = {
        "assistant_id": "sophia_companion",
        "input": {"messages": [{"role": "user", "content": prompt}]},
        "config": {
            "configurable": {
                "user_id": user_id,
                "thread_id": thread_id,
                "platform": "text",
                "ritual": None,
                "context_mode": "life",
            }
        },
    }

    async with client.stream(
        "POST",
        f"{LANGGRAPH_URL}/threads/{thread_id}/runs/stream",
        json=payload,
        timeout=STREAM_TIMEOUT_SECONDS,
    ) as response:
        response.raise_for_status()
        line_iter = response.aiter_lines().__aiter__()
        deadline = time.monotonic() + STREAM_ACCEPT_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            remaining = max(deadline - time.monotonic(), 0.1)
            try:
                line = await asyncio.wait_for(anext(line_iter), timeout=min(POLL_INTERVAL_SECONDS, remaining))
            except StopAsyncIteration:
                return
            except TimeoutError:
                continue
            if line.strip():
                return


async def _wait_for_snapshot(user_id: str, existing_ids: set[str]) -> Path | None:
    deadline = time.monotonic() + SNAPSHOT_APPEAR_TIMEOUT_SECONDS
    task_dir = _snapshot_dir(user_id)
    while time.monotonic() < deadline:
        if task_dir.exists():
            current_ids = {path.stem for path in task_dir.glob("*.json")}
            new_ids = sorted(current_ids - existing_ids)
            if new_ids:
                return task_dir / f"{new_ids[-1]}.json"
        await asyncio.sleep(POLL_INTERVAL_SECONDS)
    return None


async def _wait_for_terminal_snapshot(snapshot_path: Path) -> dict:
    deadline = time.monotonic() + SNAPSHOT_TIMEOUT_SECONDS
    last_payload: dict | None = None

    while time.monotonic() < deadline:
        payload = _read_json(snapshot_path)
        if isinstance(payload, dict):
            last_payload = payload
            status = str(payload.get("status", ""))
            if status in TERMINAL_STATUSES:
                return payload
        await asyncio.sleep(POLL_INTERVAL_SECONDS)

    if last_payload is not None:
        return last_payload

    return {
        "task_id": snapshot_path.stem,
        "status": "missing",
        "detail": "snapshot unreadable",
    }


async def _run_case(
    spec: LiveCaseSpec,
    semaphore: asyncio.Semaphore,
    *,
    suite_name: str,
    index: int,
) -> StressCaseResult:
    async with semaphore:
        user_id = f"builder-{suite_name}-{int(time.time())}-{index}-{uuid.uuid4().hex[:6]}"
        existing_ids = _existing_task_ids(user_id)

        async with httpx.AsyncClient(timeout=None) as client:
            thread_id = await _create_thread(client)
            await _stream_turn(
                client,
                thread_id=thread_id,
                user_id=user_id,
                prompt=spec.prompt,
            )

        snapshot_path = await _wait_for_snapshot(user_id, existing_ids)
        if snapshot_path is None:
            return StressCaseResult(
                user_id=user_id,
                thread_id=thread_id,
                case_id=spec.case_id,
                title=spec.title,
                artifact_kind=spec.artifact_kind,
                expected_suffix=spec.expected_suffix,
                expected_page_count=spec.expected_page_count,
                task_id=None,
                trace_id=None,
                status="missing_snapshot",
                detail="No builder task snapshot was created.",
                error=None,
                builder_result_present=False,
                artifact_path=None,
                resolved_artifact_path=None,
                observed_page_count=None,
                observed_text_length=None,
                page_text_lengths=None,
                quality_issues=None,
            )

        payload = await _wait_for_terminal_snapshot(snapshot_path)
        builder_result = payload.get("builder_result") if isinstance(payload.get("builder_result"), dict) else None
        artifact_path = builder_result.get("artifact_path") if builder_result else None
        resolved_artifact_path = _normalize_artifact_path(thread_id, artifact_path)
        observed_page_count, observed_text_length, page_text_lengths, quality_issues = _validate_artifact_quality(
            resolved_artifact_path,
            spec,
        )

        return StressCaseResult(
            user_id=user_id,
            thread_id=thread_id,
            case_id=spec.case_id,
            title=spec.title,
            artifact_kind=spec.artifact_kind,
            expected_suffix=spec.expected_suffix,
            expected_page_count=spec.expected_page_count,
            task_id=payload.get("task_id", snapshot_path.stem),
            trace_id=payload.get("trace_id"),
            status=str(payload.get("status", "missing")),
            detail=payload.get("detail"),
            error=payload.get("error"),
            builder_result_present=builder_result is not None,
            artifact_path=artifact_path,
            resolved_artifact_path=str(resolved_artifact_path) if resolved_artifact_path else None,
            observed_page_count=observed_page_count,
            observed_text_length=observed_text_length,
            page_text_lengths=page_text_lengths,
            quality_issues=quality_issues,
        )


async def _run_all_cases(
    case_specs: list[LiveCaseSpec],
    *,
    max_in_flight: int,
    suite_name: str,
) -> list[StressCaseResult]:
    semaphore = asyncio.Semaphore(max_in_flight)
    return await asyncio.gather(
        *(
            _run_case(spec, semaphore, suite_name=suite_name, index=index)
            for index, spec in enumerate(case_specs, start=1)
        )
    )


def _validate_configuration(*, suite_name: str, request_count: int, max_in_flight: int) -> None:
    if request_count < 1:
        raise ValueError(f"{suite_name}: request_count must be >= 1")
    if max_in_flight < 1:
        raise ValueError(f"{suite_name}: max_in_flight must be >= 1")


def _run_live_suite(case_specs: list[LiveCaseSpec], *, suite_name: str, max_in_flight: int) -> None:
    _validate_configuration(
        suite_name=suite_name,
        request_count=len(case_specs),
        max_in_flight=max_in_flight,
    )

    log_offset = LOG_PATH.stat().st_size if LOG_PATH.exists() else 0

    started = time.monotonic()
    results = asyncio.run(_run_all_cases(case_specs, max_in_flight=max_in_flight, suite_name=suite_name))
    elapsed_ms = round((time.monotonic() - started) * 1000, 1)

    appended_log = _read_appended_log(log_offset)
    event_loop_lines = [line for line in appended_log.splitlines() if "Event loop is closed" in line]
    async_failure_lines = [
        line for line in appended_log.splitlines() if "Subagent sophia_builder async execution failed" in line
    ]
    graph_recursion_lines = [
        line
        for line in appended_log.splitlines()
        if "GraphRecursionError" in line or "Recursion limit of 25 reached" in line
    ]

    artifact_kind_counts = {
        kind: sum(1 for item in results if item.artifact_kind == kind)
        for kind in sorted({item.artifact_kind for item in results})
    }
    summary = {
        "suite": suite_name,
        "request_count": len(case_specs),
        "max_in_flight": max_in_flight,
        "quality_validation_enabled": VALIDATE_QUALITY,
        "elapsed_ms": elapsed_ms,
        "artifact_kind_counts": artifact_kind_counts,
        "completed_count": sum(1 for item in results if item.status == "completed"),
        "failed_count": sum(1 for item in results if item.status not in {"completed"}),
        "event_loop_closed_count": len(event_loop_lines),
        "async_failure_count": len(async_failure_lines),
        "graph_recursion_count": len(graph_recursion_lines),
        "quality_failure_count": sum(1 for item in results if item.status == "completed" and item.quality_issues),
        "results": [asdict(item) for item in results],
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))

    incomplete = [item for item in results if item.status != "completed"]
    missing_artifact = [
        item
        for item in results
        if item.status == "completed"
        and (not item.resolved_artifact_path or not Path(item.resolved_artifact_path).exists())
    ]
    wrong_extension = [
        item
        for item in results
        if item.status == "completed"
        and item.resolved_artifact_path
        and Path(item.resolved_artifact_path).suffix.lower() != item.expected_suffix
    ]
    wrong_page_count = [
        item
        for item in results
        if item.status == "completed"
        and item.expected_page_count is not None
        and item.observed_page_count is not None
        and item.observed_page_count != item.expected_page_count
    ]
    quality_failures = [item for item in results if item.status == "completed" and item.quality_issues]

    assert not event_loop_lines, "Detected 'Event loop is closed' in the appended LangGraph log"
    assert not async_failure_lines, "Detected background builder async execution failures in the appended LangGraph log"
    assert not graph_recursion_lines, "Detected GraphRecursionError in the appended LangGraph log"
    assert not incomplete, f"Some builder tasks did not complete: {[item.task_id for item in incomplete]}"
    assert not missing_artifact, (
        "Completed tasks are missing a resolvable artifact path: "
        f"{[item.task_id for item in missing_artifact]}"
    )
    assert not wrong_extension, (
        "Completed tasks resolved to the wrong artifact format: "
        f"{[(item.task_id, item.resolved_artifact_path) for item in wrong_extension]}"
    )
    assert not wrong_page_count, (
        "Completed PDFs did not match the requested page count: "
        f"{[(item.task_id, item.observed_page_count, item.expected_page_count) for item in wrong_page_count]}"
    )
    assert not quality_failures, (
        "Completed deliverables failed content quality validation: "
        f"{[(item.task_id, item.quality_issues) for item in quality_failures]}"
    )


def test_live_builder_concurrency_stress():
    if not RUN_STRESS:
        pytest.skip("Set RUN_LIVE_BUILDER_STRESS=1 to run the live PDF stress gate")

    case_specs = [_build_stress_case(index) for index in range(1, STRESS_REQUEST_COUNT + 1)]
    _run_live_suite(case_specs, suite_name="stress", max_in_flight=STRESS_MAX_IN_FLIGHT)


def test_live_builder_mixed_format_soak():
    if not RUN_SOAK:
        pytest.skip("Set RUN_LIVE_BUILDER_SOAK=1 to run the live mixed-format soak suite")

    case_specs = [_build_soak_case(index) for index in range(1, SOAK_REQUEST_COUNT + 1)]
    _run_live_suite(case_specs, suite_name="soak", max_in_flight=SOAK_MAX_IN_FLIGHT)