import hashlib
import json
from datetime import UTC, datetime, timedelta

import pytest

from app.gateway.voice_lab_historical_acceptance import parse_historical_acceptance

NOW = datetime(2026, 9, 14, tzinfo=UTC)


def policy():
    return {"schema": "sophia.voice-lab.historical-acceptance.v1",
            "authorization_sha256": "a" * 64,
            "accepted_before": "2026-09-13T00:00:00.000Z",
            "obligations": [{"cleanup_obligation_id_sha256": hashlib.sha256(b"old-cleanup").hexdigest(),
                             "test_run_id_sha256": hashlib.sha256(b"old-run").hexdigest()}]}


def test_absent_acceptance_has_no_effect():
    assert parse_historical_acceptance(None) is None


@pytest.mark.parametrize("mutation", [
    {}, {"cleanup_id": "new-cleanup"}, {"test_run_id": "new-run"},
    {"deadline": NOW}, {"scenario_id": "V-D02"},
    {"now": NOW - timedelta(days=2)}, {"deadline": NOW.replace(tzinfo=None)},
])
def test_only_exact_expired_non_d02_history_is_accepted(mutation):
    acceptance = parse_historical_acceptance(json.dumps(policy()))
    args = dict(cleanup_id="old-cleanup", test_run_id="old-run",
                deadline=NOW - timedelta(days=2), scenario_id="V-P01", now=NOW)
    args.update(mutation)
    assert acceptance.accepts(**args) is (not mutation)


@pytest.mark.parametrize("mutation", [
    {"schema": "unknown"}, {"extra": True}, {"authorization_sha256": "private-secret"},
    {"accepted_before": "2026-09-13"}, {"accepted_before": 1}, {"obligations": []},
    {"obligations": [{"cleanup_obligation_id_sha256": "a" * 64}]},
    {"obligations": policy()["obligations"] * 2},
])
def test_invalid_acceptance_refuses_without_exposing_configuration(mutation):
    with pytest.raises(ValueError, match="^Historical acceptance configuration is invalid$"):
        parse_historical_acceptance(json.dumps({**policy(), **mutation}))


@pytest.mark.parametrize("raw", ["", "private-secret", "null", "[]", "x" * 2_000_001])
def test_malformed_input_refuses(raw):
    with pytest.raises(ValueError, match="^Historical acceptance configuration is invalid$"):
        parse_historical_acceptance(raw)
