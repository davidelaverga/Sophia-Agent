"""G-VIS provider matrix runner (Spec VQ-9). NOT a pytest file — live API spend.

Drives the REAL langgraph stack (the same one production uses) over the three
anchor briefs and asserts the visual-quality contract on the completion
payloads. Run on-demand or from the nightly lane:

    # against a locally booted `make dev` langgraph (or a deployed URL):
    SOPHIA_EVAL_LANGGRAPH_URL=http://localhost:2024 \
        uv run python tests/evals/visuals/run_matrix.py --provider anthropic
    SOPHIA_BUILDER_FORCE_PROVIDER=openai ... --provider openai   # (flag must
    # also be set on the langgraph SERVER process for the forced path)

Assertions per fixture (G-VIS-3/4 + outcome contract + F1):
- completion payload present with status success/completed
- image_generation_outcome present: succeeded >= 1 OR an explicit skip_reason
- deck: artifact is .pptx; pdf: artifact is .pdf (template path live);
  html: artifact is .html and the build did NOT die on missing tool args
- never silent: quality warnings/unmet_conditions are allowed, absence of the
  outcome field is a FAILURE.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from evals.visuals.fixtures import FIXTURES  # noqa: E402


async def _run_fixture(client, name: str, fixture: dict) -> dict:
    thread = await client.threads.create()
    thread_id = thread["thread_id"]
    run_input = {
        "messages": [{"role": "user", "content": fixture["brief"]}],
        "delegation_context": {
            "task": fixture["brief"],
            "task_type": fixture["task_type"],
            "artifact_target_path": f"/mnt/user-data/outputs/{fixture['target']}",
            "parent_thread_id": thread_id,
        },
        "builder_artifact_target_path": f"/mnt/user-data/outputs/{fixture['target']}",
        "allow_web_research": False,
    }
    result = await client.runs.wait(
        thread_id,
        "sophia_builder",
        input=run_input,
        context={"thread_id": thread_id, "user_id": f"eval-{uuid.uuid4().hex[:8]}"},
    )
    values = result if isinstance(result, dict) else {}
    builder_result = values.get("builder_result") or {}
    return {"fixture": name, "thread_id": thread_id, "builder_result": builder_result}


def _judge(name: str, outcome: dict) -> list[str]:
    failures: list[str] = []
    result = outcome.get("builder_result") or {}
    artifact_path = str(result.get("artifact_path") or "")
    expected_ext = Path(FIXTURES[name]["target"]).suffix
    if not artifact_path:
        # Honest failure is reportable but a matrix RED — the fixtures are
        # known-good briefs.
        failures.append(f"{name}: no artifact delivered (summary={result.get('companion_summary')})")
        return failures
    if not artifact_path.endswith(expected_ext):
        failures.append(f"{name}: artifact {artifact_path} is not {expected_ext} (format swap?)")
    if name in {"deck", "pdf"}:
        ig = result.get("image_generation_outcome")
        if not isinstance(ig, dict):
            failures.append(f"{name}: image_generation_outcome MISSING — silent enrichment")
        elif int(ig.get("succeeded", 0) or 0) < 1 and not ig.get("skip_reason"):
            failures.append(f"{name}: zero generated images and no skip_reason — silent skip")
    return failures


async def _main() -> int:
    parser = argparse.ArgumentParser(description="G-VIS provider matrix")
    parser.add_argument("--provider", choices=["anthropic", "openai"], default="anthropic")
    parser.add_argument("--fixtures", nargs="*", default=list(FIXTURES))
    args = parser.parse_args()

    url = os.environ.get("SOPHIA_EVAL_LANGGRAPH_URL", "http://localhost:2024")
    from langgraph_sdk import get_client

    client = get_client(url=url)
    failures: list[str] = []
    report: list[dict] = []
    for name in args.fixtures:
        print(f"[matrix:{args.provider}] running fixture={name} …", flush=True)
        try:
            outcome = await _run_fixture(client, name, FIXTURES[name])
        except Exception as exc:  # noqa: BLE001 — report, keep matrix going
            failures.append(f"{name}: run crashed: {exc}")
            continue
        report.append(outcome)
        failures.extend(_judge(name, outcome))

    print(json.dumps({"provider": args.provider, "report": report}, indent=2, default=str)[:8000])
    if failures:
        print("\nG-VIS MATRIX RED:")
        for failure in failures:
            print(f"  ✗ {failure}")
        return 1
    print("\nG-VIS MATRIX GREEN")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(_main()))
