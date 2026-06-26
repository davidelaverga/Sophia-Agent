"""Regression tests for the 2026-06-26 deck-delivery + PDF-render fixes.

Forensics: docs/audits/sophia-builder-deck-failure-and-pdf-render-forensics-2026-06-26.md

- A1: `_authoritative_pptx_emit_args` repoints a deck emit to a validly-compiled
  `.pptx` under outputs/ when the model emitted an off-target/missing path
  (the `t.pptx`-vs-slug mismatch that terminal-halted prod run 019f0178).
- A2: `_post_webhook` retries transient failures (transport/5xx), stops on 4xx,
  so a ceiling-fallback success event is not silently dropped.
- B: report.css wraps `<pre>` code blocks and offers a safe `.cols-2` primitive.
- C1: `download_artifact` treats Supabase 400 like 404 (missing), not an error.
"""

from __future__ import annotations

import zipfile
from pathlib import Path
from types import SimpleNamespace

from deerflow.agents.sophia_agent.middlewares.builder_artifact import BuilderArtifactMiddleware

_OUTPUTS = "/mnt/user-data/outputs/"
_REPO = Path(__file__).resolve().parents[2]


def _runtime() -> SimpleNamespace:
    return SimpleNamespace(context={}, config={})


def _write_fake_pptx(path: Path) -> None:
    """A structurally-valid minimal .pptx (the entries the integrity gate requires)."""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_STORED) as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
        archive.writestr("_rels/.rels", "<Relationships/>")
        archive.writestr("ppt/presentation.xml", b"<presentation/>" + b" " * 2048)


def _deck_state(outputs_dir: Path, target: str = f"{_OUTPUTS}deck.pptx") -> dict:
    return {
        "thread_data": {"outputs_path": str(outputs_dir)},
        "builder_artifact_target_path": target,
        "delegation_context": {"task_type": "presentation"},
    }


# ---- A1: authoritative pptx emit -------------------------------------------


def test_authoritative_pptx_repoints_offtarget_deck(tmp_path):
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    # The model compiled a valid deck under the wrong name.
    _write_fake_pptx(outputs / "t.pptx")
    state = _deck_state(outputs)
    # ...but emitted the slug target path, which does not exist.
    args = {"artifact_path": f"{_OUTPUTS}deck.pptx", "artifact_type": "presentation"}

    result = BuilderArtifactMiddleware._authoritative_pptx_emit_args(args, state, _runtime())

    assert result is not None, "a valid .pptx under outputs/ must be promoted, not rejected"
    assert result["artifact_path"] == f"{_OUTPUTS}t.pptx"
    assert result["artifact_is_fallback"] is False
    assert result["artifact_type"] == "presentation"


def test_authoritative_pptx_keeps_valid_emitted_deck(tmp_path):
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    _write_fake_pptx(outputs / "deck.pptx")
    state = _deck_state(outputs)
    # The emitted path already exists and is a .pptx — do not override it.
    args = {"artifact_path": f"{_OUTPUTS}deck.pptx", "artifact_type": "presentation"}

    assert BuilderArtifactMiddleware._authoritative_pptx_emit_args(args, state, _runtime()) is None


def test_authoritative_pptx_noop_when_no_deck_exists(tmp_path):
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    state = _deck_state(outputs)
    args = {"artifact_path": f"{_OUTPUTS}deck.pptx", "artifact_type": "presentation"}

    # Nothing to promote → no override (genuine failure path is preserved).
    assert BuilderArtifactMiddleware._authoritative_pptx_emit_args(args, state, _runtime()) is None


def test_authoritative_pptx_noop_for_non_pptx_target(tmp_path):
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    _write_fake_pptx(outputs / "t.pptx")
    state = _deck_state(outputs, target=f"{_OUTPUTS}report.pdf")  # PDF target
    args = {"artifact_path": f"{_OUTPUTS}report.pdf", "artifact_type": "pdf"}

    assert BuilderArtifactMiddleware._authoritative_pptx_emit_args(args, state, _runtime()) is None


# ---- A2: webhook delivery retry --------------------------------------------


class _FakeResp:
    def __init__(self, status: int) -> None:
        self.status_code = status
        self.text = "body"


class _FakeClient:
    def __init__(self, calls: list, statuses: list) -> None:
        self._calls = calls
        self._statuses = statuses

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def post(self, url, json=None):  # noqa: A002
        idx = len(self._calls)
        self._calls.append(url)
        status = self._statuses[min(idx, len(self._statuses) - 1)]
        if isinstance(status, Exception):
            raise status
        return _FakeResp(status)


def _patch_webhook(monkeypatch, statuses: list) -> list:
    import deerflow.sophia.builder_events as be

    calls: list = []
    monkeypatch.setattr(be.httpx, "Client", lambda *a, **k: _FakeClient(calls, statuses))
    monkeypatch.setattr(be.time, "sleep", lambda *_a, **_k: None)
    monkeypatch.setattr(be, "_gateway_url", lambda: "http://gw")
    monkeypatch.setattr(be, "_warn_if_misconfigured", lambda *_a, **_k: None)
    return calls


def test_webhook_retries_5xx_then_succeeds(monkeypatch):
    import deerflow.sophia.builder_events as be

    calls = _patch_webhook(monkeypatch, [500, 500, 200])
    be._post_webhook({"thread_id": "t", "task_id": "x"})
    assert len(calls) == 3  # two failures retried, third delivered


def test_webhook_does_not_retry_4xx(monkeypatch):
    import deerflow.sophia.builder_events as be

    calls = _patch_webhook(monkeypatch, [400])
    be._post_webhook({"thread_id": "t", "task_id": "x"})
    assert len(calls) == 1  # 4xx is a contract bug, not retried


def test_webhook_retries_transport_error_bounded(monkeypatch):
    import httpx

    import deerflow.sophia.builder_events as be

    err = httpx.ConnectError("boom")
    calls = _patch_webhook(monkeypatch, [err, err, err, err])
    be._post_webhook({"thread_id": "t", "task_id": "x"})
    # max_attempts = len(backoffs)+1 = 4
    assert len(calls) == 4


# ---- B: report.css render-fidelity rules -----------------------------------


def test_report_css_wraps_code_blocks_and_has_safe_columns():
    css = (_REPO / "skills/public/pdf-report/assets/report.css").read_text(encoding="utf-8")
    assert "pre {" in css
    assert "white-space: pre-wrap" in css
    assert "overflow-wrap: anywhere" in css
    assert ".cols-2" in css
    assert "min-width: 0" in css  # the actual fix for column collision
    assert ".section-label" in css


# ---- R2-3: page-count overshoot + near-blank pages --------------------------


def test_report_css_caps_figure_media_height():
    css = (_REPO / "skills/public/pdf-report/assets/report.css").read_text(encoding="utf-8")
    # A small diagram must not reserve a whole page (the near-blank-page cause).
    assert "max-height: 150mm" in css


def test_pdf_report_skill_has_length_and_figure_sizing_guidance():
    text = (_REPO / "skills/public/pdf-report/SKILL.md").read_text(encoding="utf-8")
    assert "Length and figure sizing" in text
    assert "FIRST draft" in text
    assert "never pad" in text.lower()


def test_pdf_page_count_repair_budget_is_two():
    # One repair can't converge an under→over swing (2→11 vs 8); 2 can. (R2-3)
    from deerflow.agents.sophia_agent.middlewares.builder_artifact import _PDF_PAGE_COUNT_REPAIR_MAX

    assert _PDF_PAGE_COUNT_REPAIR_MAX == 2


# ---- C1: Supabase 400 tolerance --------------------------------------------


def test_download_artifact_treats_400_like_missing(monkeypatch):
    import deerflow.sophia.storage.supabase_artifact_store as store

    monkeypatch.setattr(store, "_load_config", lambda: SimpleNamespace(service_role_key="k"))
    monkeypatch.setattr(store, "_object_path", lambda t, f: f"{t}/{f}")
    monkeypatch.setattr(store, "_object_url", lambda c, p: f"http://x/{p}")

    class _Resp:
        status_code = 400

        def raise_for_status(self):  # pragma: no cover - must not be reached on 400
            raise AssertionError("400 should be treated as missing, not raised")

    class _Client:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def get(self, url, headers=None):
            return _Resp()

        def close(self):
            pass

    monkeypatch.setattr(store.httpx, "Client", lambda *a, **k: _Client())
    assert store.download_artifact("thread", "deck.pptx") is None
