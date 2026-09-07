"""Offline boundary tests for the read-only certification marker inventory."""

import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

spec = importlib.util.spec_from_file_location("marker_inventory", Path(__file__).with_name("mem00_provider_marker_inventory.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ContentTrap(dict):
    def get(self, key, *args):
        assert key not in {"memory", "text", "content"}, "content_access_forbidden"
        return super().get(key, *args)

    def __getitem__(self, key):
        assert key not in {"memory", "text", "content"}, "content_access_forbidden"
        return super().__getitem__(key)


def run(pages, **kwargs):
    calls = []

    def get_all(**request):
        calls.append(request)
        assert set(request["filters"]) == {"OR"}
        return pages[len(calls) - 1]

    result = module.inventory(SimpleNamespace(get_all=get_all), lambda domain, value: f"keyed:{domain}", certification_subject="test-subject", **kwargs)
    return result, calls


def test_short_page_requires_explicit_empty_and_content_never_accessed():
    row = ContentTrap(id="private-id", user_id="ordinary-owner", metadata={}, memory="PRIVATE_CONTENT")
    result, calls = run([{"count": 1, "results": [row], "next": None}, {"count": 1, "results": [], "next": None}])
    assert len(calls) == 2
    assert result["page_counts"] == [1, 0]
    assert result["marker_rows"] == 0
    assert "private" not in json.dumps(result).lower()
    assert not result["terminal_zero_certified"]


def test_all_marker_rows_are_redacted_and_unknown_is_not_adopted():
    rows = [ContentTrap(id="a", user_id="test-subject", metadata={}), ContentTrap(id="b", user_id="another-owner", metadata={"certification_run_id": "MEM00-unknown", "projection_operation_id": "raw-op"})]
    result, _ = run([{"count": 2, "results": rows}, {"count": 2, "results": []}])
    assert result["marker_rows"] == 2
    assert result["unknown_marker_rows"] == 1
    assert "raw-op" not in json.dumps(result)
    assert "another-owner" not in json.dumps(result)
    assert result["mutations"] == 0


@pytest.mark.parametrize("pages,reason", [
    ([{}], "inventory_response_shape"),
    ([{"count": True, "results": []}], "inventory_count_unstable"),
    ([{"count": 1, "results": []}], "inventory_terminal_count_mismatch"),
    ([{"count": 0, "results": [], "next": "another"}], "inventory_terminal_count_mismatch"),
    ([{"count": 1, "results": [{"id": "a"}]}, {"count": 2, "results": []}], "inventory_count_unstable"),
    ([{"count": 2, "results": [{"id": "a"}, {"id": "a"}]}], "inventory_duplicate_or_missing_id"),
    ([{"count": 1, "results": [{"id": "a", "metadata": "bad"}]}], "inventory_metadata_shape"),
])
def test_uncertainty_is_not_zero(pages, reason):
    with pytest.raises(ValueError, match=reason):
        run(pages)


def test_page_cap_is_not_clean():
    with pytest.raises(ValueError, match="inventory_page_cap"):
        run([{"count": 1, "results": [{"id": "a"}]}], max_pages=1)


def test_transport_failure_is_not_zero():
    def unavailable(**kwargs):
        raise RuntimeError("provider_unavailable")

    with pytest.raises(RuntimeError, match="provider_unavailable"):
        module.inventory(SimpleNamespace(get_all=unavailable), lambda *args: "ref", certification_subject="test-subject")
