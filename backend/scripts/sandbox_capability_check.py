"""Sandbox capability diagnostic.

Run this against a Render / Docker / local sandbox to verify which of the
builder's heavy-lift capabilities are installed. It is intentionally a
standalone script (no deerflow imports, no side effects) so it can be
executed in any sandbox shape, including minimal containers where the
full harness has not been installed.

Usage::

    # From the backend directory:
    uv run python scripts/sandbox_capability_check.py

    # Or directly in a sandbox:
    python scripts/sandbox_capability_check.py

Exit code is 0 when every required capability is present, 1 otherwise.
The ``--json`` flag emits a machine-readable report instead of human text.

The script is a diagnostic only \u2014 it is not wired into runtime code. PR G
adds it so post-deploy ops can confirm the sandbox matches the builder's
assumptions before users see a ``failed_terminal`` from a missing
capability.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from dataclasses import asdict, dataclass

# ---------------------------------------------------------------------------
# Capability definitions
# ---------------------------------------------------------------------------


@dataclass
class CapabilityResult:
    name: str
    kind: str  # "binary" | "python_package"
    available: bool
    detail: str  # version string or error message
    required: bool


BINARY_CAPABILITIES: list[tuple[str, bool]] = [
    # (binary_name, required)
    ("pandoc", True),   # document conversion (md -> pdf/docx/html)
]


PY_PACKAGE_CAPABILITIES: list[tuple[str, bool]] = [
    # (module_name, required)
    ("weasyprint", False),   # html -> pdf
    ("reportlab", False),    # pdf generation
    ("matplotlib", True),    # chart rendering
    ("PIL", True),           # pillow image manipulation
]


# ---------------------------------------------------------------------------
# Probes
# ---------------------------------------------------------------------------


def _probe_binary(name: str, required: bool) -> CapabilityResult:
    path = shutil.which(name)
    if path is None:
        return CapabilityResult(
            name=name,
            kind="binary",
            available=False,
            detail="not on PATH",
            required=required,
        )
    version = "unknown"
    try:
        completed = subprocess.run(
            [path, "--version"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        # First line of --version usually carries the semantic version.
        first_line = (completed.stdout or completed.stderr or "").splitlines()
        if first_line:
            version = first_line[0].strip()
    except (OSError, subprocess.TimeoutExpired) as exc:
        version = f"version probe failed: {exc}"
    return CapabilityResult(
        name=name,
        kind="binary",
        available=True,
        detail=f"{path} ({version})",
        required=required,
    )


def _probe_python_package(name: str, required: bool) -> CapabilityResult:
    try:
        mod = __import__(name)
    except Exception as exc:  # noqa: BLE001 - any import error is a negative probe
        return CapabilityResult(
            name=name,
            kind="python_package",
            available=False,
            detail=f"{type(exc).__name__}: {exc}",
            required=required,
        )
    version = getattr(mod, "__version__", "unknown")
    return CapabilityResult(
        name=name,
        kind="python_package",
        available=True,
        detail=f"version={version}",
        required=required,
    )


def collect_results() -> list[CapabilityResult]:
    results: list[CapabilityResult] = []
    for binary, required in BINARY_CAPABILITIES:
        results.append(_probe_binary(binary, required))
    for package, required in PY_PACKAGE_CAPABILITIES:
        results.append(_probe_python_package(package, required))
    return results


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------


def _format_human(results: list[CapabilityResult]) -> str:
    lines: list[str] = ["Sandbox capability report:"]
    for r in results:
        mark = "OK " if r.available else "MISS"
        req_tag = "REQUIRED" if r.required else "optional"
        lines.append(f"  [{mark}] {r.kind:<15} {r.name:<15} {req_tag:<8} {r.detail}")
    missing_required = [r for r in results if r.required and not r.available]
    if missing_required:
        lines.append("")
        lines.append(
            f"MISSING REQUIRED: {', '.join(r.name for r in missing_required)}"
        )
    else:
        lines.append("")
        lines.append("All required capabilities present.")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit a JSON report instead of human-readable text.",
    )
    args = parser.parse_args(argv)

    results = collect_results()

    if args.json:
        payload = {
            "results": [asdict(r) for r in results],
            "all_required_present": all(
                r.available for r in results if r.required
            ),
        }
        print(json.dumps(payload, indent=2))
    else:
        print(_format_human(results))

    return 0 if all(r.available for r in results if r.required) else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
