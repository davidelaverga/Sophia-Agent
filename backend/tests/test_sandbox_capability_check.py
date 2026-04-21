"""Tests for ``scripts/sandbox_capability_check.py``.

The script is a post-deploy diagnostic rather than runtime code, but we
still test it so a future refactor can't silently break the signal it
produces or the exit code it uses for CI/health checks.
"""

from __future__ import annotations

import importlib.util
import io
import json
import subprocess
import sys
from pathlib import Path

SCRIPT_PATH = (
    Path(__file__).resolve().parent.parent
    / "scripts"
    / "sandbox_capability_check.py"
)


def _load_module():
    # Register the module in sys.modules BEFORE exec so that @dataclass's
    # type-resolution (which calls ``sys.modules.get(cls.__module__)``) can
    # find the module when the class is created. Without this, Python 3.12's
    # dataclass machinery raises AttributeError.
    module_name = "sandbox_capability_check"
    spec = importlib.util.spec_from_file_location(module_name, SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        sys.modules.pop(module_name, None)
        raise
    return module


def test_script_file_exists():
    assert SCRIPT_PATH.is_file()


def test_collect_results_probes_every_declared_capability():
    mod = _load_module()
    results = mod.collect_results()
    names = {r.name for r in results}
    # Everything in the declared lists should appear in the report.
    for binary, _ in mod.BINARY_CAPABILITIES:
        assert binary in names, f"missing probe for binary {binary}"
    for package, _ in mod.PY_PACKAGE_CAPABILITIES:
        assert package in names, f"missing probe for python package {package}"


def test_probe_binary_missing_sets_available_false():
    mod = _load_module()
    result = mod._probe_binary("definitely-not-a-real-binary-xyz", required=True)
    assert result.kind == "binary"
    assert result.available is False
    assert result.required is True
    assert "not on PATH" in result.detail


def test_probe_python_package_missing_sets_available_false():
    mod = _load_module()
    result = mod._probe_python_package("definitely_not_a_module_xyz", required=False)
    assert result.kind == "python_package"
    assert result.available is False
    assert result.required is False


def test_main_json_emits_report_and_exit_code(monkeypatch, capsys):
    mod = _load_module()

    # Force all required capabilities to appear present so exit is 0.
    def fake_collect_results():
        return [
            mod.CapabilityResult(
                name="pandoc",
                kind="binary",
                available=True,
                detail="/usr/bin/pandoc (pandoc 3.0)",
                required=True,
            ),
            mod.CapabilityResult(
                name="matplotlib",
                kind="python_package",
                available=True,
                detail="version=3.8.0",
                required=True,
            ),
        ]

    monkeypatch.setattr(mod, "collect_results", fake_collect_results)

    exit_code = mod.main(["--json"])
    captured = capsys.readouterr().out
    assert exit_code == 0

    payload = json.loads(captured)
    assert payload["all_required_present"] is True
    assert {r["name"] for r in payload["results"]} == {"pandoc", "matplotlib"}


def test_main_non_zero_when_required_missing(monkeypatch, capsys):
    mod = _load_module()

    def fake_collect_results():
        return [
            mod.CapabilityResult(
                name="pandoc",
                kind="binary",
                available=False,
                detail="not on PATH",
                required=True,
            )
        ]

    monkeypatch.setattr(mod, "collect_results", fake_collect_results)
    exit_code = mod.main([])
    captured = capsys.readouterr().out
    assert exit_code == 1
    assert "MISSING REQUIRED" in captured


def test_script_runs_as_subprocess():
    # End-to-end check: the script at least executes without raising when
    # invoked as a subprocess. Exit code can be 0 or 1 depending on local
    # tooling; either is acceptable here.
    result = subprocess.run(
        [sys.executable, str(SCRIPT_PATH), "--json"],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert result.returncode in {0, 1}
    assert result.stdout.strip(), "script produced no stdout"
    payload = json.loads(result.stdout)
    assert "results" in payload
    assert "all_required_present" in payload

    # Also guard against accidental pollution of stdout: it must be parseable
    # as JSON.
    io.StringIO(result.stdout)
