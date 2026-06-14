"""G-DEL live lane (Spec D). NOT a pytest file — live API spend.

Drives a REAL langgraph stack over the 40-turn delegation fixture and
asserts the live halves of G-DEL-2/3/5. The runner and the langgraph
server must share a working directory (local `make dev` or the nightly CI
job that boots langgraph in-job): the ledger is materialized directly into
`users/{user_id}/traces/` on the shared disk, exactly where the
companion-side middleware would have written it across 40 turns.

    SOPHIA_EVAL_LANGGRAPH_URL=http://localhost:2024 \
        uv run python tests/evals/delegation/run_matrix.py --provider anthropic
    SOPHIA_BUILDER_FORCE_PROVIDER=openai ... --provider openai
    # (the force flag must also be set on the langgraph SERVER process)

Fixtures:
- complete: full brief in the description; assert the build completes and
  the digest plumbing did not regress delivery.
- incomplete: audience/style/data OMITTED from the description but present
  in the ledger (t3/t12/t18) → assert the builder either recovered them
  (read_session_context call in the run) or disclosed assumptions
  (brief_assumptions non-empty) — never a silent guess (G-DEL-5).
Provider matrix note: under --provider openai, brief extraction degrades
to digest-only BY DESIGN (Anthropic-only extraction); the assertion is
that the build still completes — degradation, not failure.
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
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / ".."))

from delegation_fixture import fixture_entries  # noqa: E402

_COMPLETE_BRIEF = (
    "Create a professional 10-slide technical launch deck for enterprise "
    "CTOs. Include the Q3 numbers (4.2M revenue, 38% margin) and the "
    "migration timeline; exclude pricing slides; hand-drawn visual style."
)
_INCOMPLETE_BRIEF = "Build the launch deck we discussed."

FIXTURES = {
    "complete": {"brief": _COMPLETE_BRIEF, "expect_gate": False},
    "incomplete": {"brief": _INCOMPLETE_BRIEF, "expect_gate": True},
}


def _materialize_ledger(user_id: str, thread_id: str) -> None:
    """Write the fixture ledger where the langgraph server reads it."""
    from deerflow.sophia import delegation_ledger

    for entry in fixture_entries():
        assert delegation_ledger.append_turn(user_id, thread_id, entry)


async def _run_fixture(client, name: str, fixture: dict) -> dict:
    user_id = f"eval-del-{uuid.uuid4().hex[:8]}"
    parent_thread = await client.threads.create()
    parent_thread_id = parent_thread["thread_id"]
    _materialize_ledger(user_id, parent_thread_id)

    thread = await client.threads.create()
    thread_id = thread["thread_id"]
    run_input = {
        "messages": [{"role": "user", "content": fixture["brief"]}],
        "delegation_context": {
            "task": fixture["brief"],
            "task_type": "presentation",
            "artifact_target_path": "/mnt/user-data/outputs/launch_deck.pptx",
            "parent_thread_id": parent_thread_id,
            "parent_user_id": user_id,
            "delegation_ledger": {
                "turns": 40,
                "deliverable_intent_turns": 8,
                "was_summarized": True,
                "available": True,
            },
            "dispatched_at_turn": 41,
        },
        "builder_artifact_target_path": "/mnt/user-data/outputs/launch_deck.pptx",
        "allow_web_research": False,
    }
    result = await client.runs.wait(
        thread_id,
        "sophia_builder",
        input=run_input,
        context={"thread_id": thread_id, "user_id": user_id},
        config={
            "configurable": {
                "thread_id": thread_id,
                "user_id": user_id,
                "parent_thread_id": parent_thread_id,
            }
        },
    )
    values = result if isinstance(result, dict) else {}
    return {
        "fixture": name,
        "thread_id": thread_id,
        "builder_result": values.get("builder_result") or {},
        "session_context_reads": int(values.get("builder_session_context_reads", 0) or 0),
        "brief_schema_present": bool(values.get("brief_schema")),
    }


def _judge(name: str, fixture: dict, outcome: dict, provider: str) -> list[str]:
    failures: list[str] = []
    result = outcome.get("builder_result") or {}
    artifact_path = str(result.get("artifact_path") or "")
    if not artifact_path.endswith(".pptx"):
        failures.append(
            f"{name}: no .pptx delivered (path={artifact_path!r}, "
            f"summary={result.get('companion_summary')})"
        )
        return failures
    if provider == "anthropic" and not outcome.get("brief_schema_present"):
        failures.append(f"{name}: extraction never produced a brief_schema (trigger was armed)")
    if fixture["expect_gate"]:
        assumptions = result.get("brief_assumptions") or []
        reads = outcome.get("session_context_reads", 0)
        unmet = [
            condition
            for condition in (result.get("unmet_conditions") or [])
            if str(condition).startswith("brief_incomplete:")
        ]
        if not assumptions and reads == 0 and not unmet:
            failures.append(
                f"{name}: SILENT GUESS — gaps neither recovered (reads=0) nor "
                "disclosed (no assumptions, no brief_incomplete:* stamp)"
            )
    return failures


async def _main() -> int:
    parser = argparse.ArgumentParser(description="G-DEL live matrix")
    parser.add_argument("--provider", choices=["anthropic", "openai"], default="anthropic")
    parser.add_argument("--fixtures", nargs="*", default=list(FIXTURES))
    args = parser.parse_args()

    url = os.environ.get("SOPHIA_EVAL_LANGGRAPH_URL", "http://localhost:2024")
    from langgraph_sdk import get_client

    client = get_client(url=url)
    failures: list[str] = []
    report: list[dict] = []
    for name in args.fixtures:
        print(f"[delegation:{args.provider}] running fixture={name} …", flush=True)
        try:
            outcome = await _run_fixture(client, name, FIXTURES[name])
        except Exception as exc:  # noqa: BLE001 — report, keep matrix going
            failures.append(f"{name}: run crashed: {exc}")
            continue
        report.append(outcome)
        failures.extend(_judge(name, FIXTURES[name], outcome, args.provider))

    print(json.dumps({"provider": args.provider, "report": report}, indent=2, default=str)[:8000])
    if failures:
        print("\nG-DEL MATRIX RED:")
        for failure in failures:
            print(f"  ✗ {failure}")
        return 1
    print("\nG-DEL MATRIX GREEN")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(_main()))
