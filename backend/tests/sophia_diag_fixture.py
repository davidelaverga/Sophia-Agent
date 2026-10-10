"""Content-free launch-timeline diagnostics (``sophia_diag`` lines).

Each instrumented hop emits exactly one event, carries only join identifiers,
codes and numbers, and never changes the outcome it observes. Inputs use
sentinel strings so any leak of owner identity or content is detectable.
"""

from __future__ import annotations

import json
import logging
import random
import time
from pathlib import Path
from uuid import UUID, uuid4

import httpx
import pytest
from mem00_owner_fixture import declare_memory_owners  # noqa: F401 - pytest fixture, used by name

OWNER = "owner-sentinel-q7z"
CONTENT = "SENTINEL PRIVATE CONTENT 4471"
SECRET_DETAIL = "SENTINEL EXCEPTION DETAIL 9902"
DIAG_LOGGER = "deerflow.sophia.diag"
BACKEND = Path(__file__).resolve().parents[1]


def _events(caplog, name=None):
    found = []
    for record in caplog.records:
        message = record.getMessage()
        if message.startswith("sophia_diag "):
            payload = json.loads(message[len("sophia_diag ") :])
            if name is None or payload["ev"] == name:
                found.append((record.levelno, payload))
    return found


def _one(caplog, name):
    events = _events(caplog, name)
    assert len(events) == 1, events
    return events[0]


def _assert_content_free(caplog, *extra):
    text = caplog.text
    for sentinel in (OWNER, CONTENT, SECRET_DETAIL, *extra):
        assert sentinel not in text


def _uuid7() -> str:
    millis = int(time.time() * 1000)
    value = (millis << 80) | (0x7 << 76) | (random.getrandbits(12) << 64) | (0b10 << 62) | random.getrandbits(62)
    return str(UUID(int=value))


@pytest.fixture
def diag_logs(caplog):
    caplog.set_level(logging.DEBUG, logger=DIAG_LOGGER)
    return caplog




def _mock_store(requests=None):
    from deerflow.sophia.memory_governance.store import SupabaseMemoryGovernanceStore

    def handler(request: httpx.Request) -> httpx.Response:
        if requests is not None:
            requests.append(request)
        path = request.url.path
        if path.endswith("/sophia_memory_contract"):
            return httpx.Response(200, json=[{"contract_epoch": 1, "schema_version": "mem00.v1", "mode": "enforced", "updated_at": "2026-09-01T00:00:00Z"}])
        if path.endswith("/sophia_memory_user_governance"):
            return httpx.Response(200, json=[{"user_id": OWNER, "user_catalog_generation": 1, "user_revocation_epoch": 0, "provider_subject": "synthetic-subject"}])
        if path.endswith("/rpc/sophia_memory_record_prompt_admission"):
            return httpx.Response(200, json=str(uuid4()))
        return httpx.Response(503, json={"message": SECRET_DETAIL})

    return SupabaseMemoryGovernanceStore(url="https://synthetic.supabase.test", service_role_key="k" * 40, client=httpx.Client(transport=httpx.MockTransport(handler)))
