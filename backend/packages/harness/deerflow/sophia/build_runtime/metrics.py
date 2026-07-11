from __future__ import annotations

from collections.abc import Iterable

from deerflow.sophia.build_runtime.events import BuildOperationEvent


def derive_prepare_metrics(events: Iterable[BuildOperationEvent]) -> dict[str, object]:
    emitted: set[str] = set()
    executed: set[str] = set()
    results: set[str] = set()
    service_calls = 0
    service_results = 0
    for event in events:
        call_id = event.tool_call_id
        if event.event_type == "prepare.emitted" and call_id:
            emitted.add(call_id)
        elif event.event_type == "prepare.execution_started" and call_id:
            executed.add(call_id)
        elif event.event_type == "prepare.result_recorded" and call_id:
            results.add(call_id)
        elif event.event_type == "prepare.service_started":
            service_calls += 1
        elif event.event_type == "prepare.service_finished":
            service_results += 1
    dangling = emitted - results
    return {
        "prepare_call_count": len(emitted),
        "prepare_emitted_call_count": len(emitted),
        "prepare_execution_count": len(executed),
        "prepare_result_count": len(results),
        "prepare_service_call_count": service_calls,
        "prepare_service_result_count": service_results,
        "dangling_prepare_call_count": len(dangling),
        "prepare_emitted_call_ids": sorted(emitted),
        "prepare_executed_call_ids": sorted(executed),
        "prepare_result_call_ids": sorted(results),
        "dangling_prepare_call_ids": sorted(dangling),
    }
