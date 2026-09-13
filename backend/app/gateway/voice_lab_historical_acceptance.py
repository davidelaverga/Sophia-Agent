"""Operator acceptance of exact historical closure gaps, never cleanup proof."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from datetime import UTC, datetime

ENV_KEY = "SOPHIA_VOICE_LAB_HISTORICAL_ACCEPTANCE_JSON"
_HASH = re.compile(r"^[a-f0-9]{64}$")


@dataclass(frozen=True)
class HistoricalAcceptance:
    authorization_sha256: str
    accepted_before: datetime
    obligations: frozenset[tuple[str, str]]

    def accepts(self, *, cleanup_id: str, test_run_id: str,
                deadline: datetime, scenario_id: str, now: datetime) -> bool:
        # This lane handles the identified ordinary historical provider gap.
        # D02's separate ownership/termination proof contract is unchanged.
        return (
            scenario_id != "V-D02"
            and deadline.tzinfo is not None
            and now.tzinfo is not None
            and deadline <= self.accepted_before <= now
            and (hashlib.sha256(cleanup_id.encode()).hexdigest(),
                 hashlib.sha256(test_run_id.encode()).hexdigest()) in self.obligations
        )


def parse_historical_acceptance(raw: str | None) -> HistoricalAcceptance | None:
    if raw is None:
        return None
    try:
        if not isinstance(raw, str) or not 1 <= len(raw.encode()) <= 2_000_000:
            raise ValueError
        value = json.loads(raw)
        if not isinstance(value, dict) or set(value) != {
            "schema", "authorization_sha256", "accepted_before", "obligations"
        } or value["schema"] != "sophia.voice-lab.historical-acceptance.v1":
            raise ValueError
        authorization = value["authorization_sha256"]
        if not isinstance(authorization, str) or not _HASH.fullmatch(authorization):
            raise ValueError
        before = datetime.fromisoformat(value["accepted_before"].replace("Z", "+00:00"))
        if before.tzinfo is None or before.astimezone(UTC).isoformat(
            timespec="milliseconds"
        ).replace("+00:00", "Z") != value["accepted_before"]:
            raise ValueError
        entries = value["obligations"]
        if not isinstance(entries, list) or not 1 <= len(entries) <= 10_000:
            raise ValueError
        pairs = []
        for entry in entries:
            if not isinstance(entry, dict) or set(entry) != {
                "cleanup_obligation_id_sha256", "test_run_id_sha256"
            }:
                raise ValueError
            pair = (entry["cleanup_obligation_id_sha256"], entry["test_run_id_sha256"])
            if not all(isinstance(item, str) and _HASH.fullmatch(item) for item in pair):
                raise ValueError
            pairs.append(pair)
        if len({pair[0] for pair in pairs}) != len(pairs):
            raise ValueError
        return HistoricalAcceptance(authorization, before, frozenset(pairs))
    except (ValueError, TypeError, AttributeError, OverflowError):
        # Never include configuration bytes in startup logs or exception chains.
        raise ValueError("Historical acceptance configuration is invalid") from None
