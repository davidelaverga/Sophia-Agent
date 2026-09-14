"""Synthetic file-read races at the real identity middleware boundary."""
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from test_mem00_owner_authority_foundation import store
from deerflow.agents.sophia_agent.middlewares import user_identity
from deerflow.sophia.memory_governance import owner_authority


@pytest.mark.parametrize("after", ["governed", "unknown", "outage", "wrong_owner", "legacy"])
def test_identity_read_does_not_carry_old_owner_authority_into_prompt(monkeypatch, after):
    current = [store("legacy")]
    reads = []
    monkeypatch.setattr(owner_authority, "configured_memory_store", lambda: current[0])
    def read_text(**kwargs):
        reads.append(True)
        if after == "outage":
            current[0] = SimpleNamespace(get_contract=Mock(side_effect=RuntimeError("SYNTHETIC PRIVATE DATABASE")))
        elif after == "wrong_owner":
            current[0] = store("legacy", owner="other-owner")
        else:
            current[0] = store(after)
        return "SYNTHETIC LEGACY IDENTITY"
    monkeypatch.setattr(user_identity, "safe_user_path", lambda *args: SimpleNamespace(exists=lambda: True, read_text=read_text))
    result = user_identity.UserIdentityMiddleware("owner").before_agent({}, SimpleNamespace(context={}))
    assert reads == [True]
    if after == "legacy":
        assert result["system_prompt_blocks"] == ["<user_identity>\nSYNTHETIC LEGACY IDENTITY\n</user_identity>"]
    else:
        assert result == {"user_id": "owner"}
