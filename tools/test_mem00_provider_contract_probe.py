"""Offline safety tests for the bounded provider certification instrument."""
import contextlib
import importlib.util
import io
import os
from pathlib import Path
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("probe", Path(__file__).with_name("mem00_provider_contract_probe.py"))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class Adapter:
    def __init__(self):
        self.rows = {}
        self.project_id, self.org_id = "project", "org"
        self.delete_error = False
        self.change_text = False
        self.stringify_list = False

    def _get_client(self):
        return self

    def _all_pages(self, *, provider_subject, **kwargs):
        for row in self.rows.values():
            if row["subject"] == provider_subject:
                listed = {**row, "metadata": {k: str(v) if type(v) in (bool, int) else v for k, v in row["metadata"].items()}} if self.stringify_list else row
                yield [listed]
        yield []

    def project_revision(self, *, canonical_content, provider_subject, metadata):
        identity = str(len(self.rows) + 1)
        self.rows[identity] = dict(id=identity, memory="changed" if self.change_text else canonical_content, subject=provider_subject, metadata=metadata)
        return types.SimpleNamespace(provider_ids=(identity,), metadata_verified=True)

    def get(self, identity):
        return self.rows[identity]

    def find_by_operation_marker(self, *, provider_subject, projection_operation_id, **kwargs):
        return tuple(i for i, r in self.rows.items() if r["subject"] == provider_subject and r["metadata"]["projection_operation_id"] == projection_operation_id)

    def search_ids(self, *, provider_subject, **kwargs):
        return tuple(types.SimpleNamespace(provider_memory_id=i) for i, r in self.rows.items() if r["subject"] == provider_subject)

    def delete_ids(self, identities, **kwargs):
        if self.delete_error:
            raise RuntimeError("SENSITIVE_PROVIDER_ERROR_MUST_NOT_APPEAR")
        for identity in identities:
            del self.rows[identity]


class ProbeTests(unittest.TestCase):
    def setUp(self):
        self.adapter = Adapter()
        self.pin = dict(commit="3c3a6362804ef1eee6f7cbe615121836ce383ed9", reference_key_fingerprint="sha256:70c4ec6052335991", credential_fingerprint="sha256:8388812563a212e0", sdk="1.0.9", endpoint_matches_pin=True, provider_project_matches=True, flags=dict(PROVIDER_PROJECTION=False, GOVERNED_RUNTIME_READ=False))

    def run_probe(self, count=1):
        modules = {
            "deerflow.sophia.memory_governance.mem0_projection_adapter": types.SimpleNamespace(Mem0ProjectionAdapter=lambda: self.adapter),
            "deerflow.sophia.memory_governance.runtime_pin": types.SimpleNamespace(runtime_pin=lambda: self.pin),
        }
        output = io.StringIO()
        with patch.dict("sys.modules", modules), patch.dict(os.environ, MEM0_PROJECT_ID="project", MEM0_ORG_ID="org"), contextlib.redirect_stdout(output):
            result = probe.probe("mem00-dp007-20260905T211800Z", count, expected_commit="3c3a6362804ef1eee6f7cbe615121836ce383ed9")
        self.assertNotIn("SENSITIVE_PROVIDER_ERROR", output.getvalue())
        self.assertNotIn("imaginary test badge", output.getvalue())
        return result

    def test_preflight_and_full_cleanup(self):
        for count in (1, 3):
            with self.subTest(count=count):
                result = self.run_probe(count)
                self.assertEqual(result["status"], "passed")
                self.assertEqual(result["created"], count)
                self.assertEqual(self.adapter.rows, {})

    def test_delete_failure_never_reports_success(self):
        self.adapter.delete_error = True
        result = self.run_probe()
        self.assertEqual(result["status"], "failed")
        self.assertFalse(result["cleanup"][0]["verified_zero"])
        self.assertEqual(len(self.adapter.rows), 1)

    def test_stringified_list_uses_verified_ids_for_cleanup(self):
        self.adapter.stringify_list = True
        result = self.run_probe(3)
        self.assertEqual(result["status"], "passed")
        self.assertEqual(self.adapter.rows, {})

    def test_unverified_id_is_not_deleted(self):
        self.adapter.find_by_operation_marker = lambda **kwargs: ()
        result = self.run_probe()
        self.assertEqual(result["status"], "failed")
        self.assertFalse(result["cleanup"][0]["verified_zero"])
        self.assertEqual(len(self.adapter.rows), 1)

    def test_different_commit_stops_before_provider_write(self):
        self.pin["commit"] = "a" * 40
        with self.assertRaises(AssertionError):
            self.run_probe()
        self.assertEqual(self.adapter.rows, {})

    def test_direct_content_change_fails_and_cleans(self):
        self.adapter.change_text = True
        result = self.run_probe()
        self.assertEqual(result["status"], "failed")
        self.assertEqual(self.adapter.rows, {})

    def test_wrong_runtime_stops_before_provider_write(self):
        self.pin["sdk"] = "3.0.0"
        with self.assertRaises(AssertionError):
            self.run_probe()
        self.assertEqual(self.adapter.rows, {})

    def test_reused_nonempty_subject_is_not_adopted_or_purged(self):
        self.adapter.rows["unknown"] = dict(id="unknown", subject=probe.subject_for("mem00-dp007-20260905T211800Z", 0), metadata={})
        with self.assertRaises(AssertionError):
            self.run_probe()
        self.assertIn("unknown", self.adapter.rows)

    def test_subject_requires_explicit_synthetic_domain(self):
        with self.assertRaises(ValueError):
            probe.subject_for("real-user", 0)


if __name__ == "__main__":
    unittest.main()
