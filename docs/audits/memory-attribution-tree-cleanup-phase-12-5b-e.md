# Phase 12.5B-E — Memory Result Attribution, Current-Session Learning Boundary, and Worktree Cleanup

Date: 2026-05-22
Status: implemented in working tree; PR pending

## Scope

This phase follows the 12.5B-D live-memory smoke. It is intentionally narrow:

- improve attribution for realtime `retrieve_memories(query)` results;
- preserve the current-session-only boundary for newly learned live facts;
- prevent raw memory text from leaking through frontend diagnostics/telemetry;
- document worktree cleanup decisions without committing or broad destructive cleanup.

Explicit non-goals remain unchanged: no `consult_skill`, ritual tools, web tools, artifact schema migration, VAD/turn detection changes, Gemini/GPT default routing changes, permanent sideband writeback, or Builder storage/UI changes.

## Findings

The local workspace did not contain the latest described smoke export. Existing local telemetry exports had no `retrieve_memories` records, movie/LOTR strings, memory statuses, or equivalent recall evidence. That means the exact live failure could not be classified from local artifacts.

The available code path showed enough to explain why the next smoke was hard to interpret:

- backend memory diagnostics distinguished status/count/provider state but not which returned result matched which query;
- model-facing `success` guidance did not explicitly say to answer directly from a matching returned memory;
- `no_results` guidance did not explicitly forbid durable-memory promises after the user provides an answer;
- browser tool-loop diagnostics could include the full `retrieve_memories` backend response, duplicating raw memory text even though backend diagnostics were redacted.

## Changes

The shared realtime memory contract now emits safe attribution fields under `diagnostics`:

- `has_results`;
- `query_fingerprint`, `query_length`, `query_term_count`, and `raw_query_excluded`;
- `result_fingerprints` with rank, text fingerprint, text length, category, score, and query-term match counts;
- `result_preview_included: false` and `raw_memory_text_excluded: true`;
- `max_query_terms_matched_count` and `any_result_exact_query_terms_present`.

The actual tool result still includes bounded memory text for the model to answer from. Diagnostics and telemetry do not include raw memory text or raw query text.

The Gemini backend relay now carries the same safe fields in memory tool diagnostics and compact reliability diagnostics. Browser telemetry redacts `retrieve_memories` tool-call args and backend responses before emitting capture events, while preserving the raw `toolResponse` payload sent back over the Gemini WebSocket.

Realtime prompt guidance now clarifies that facts learned during the live session can be used during that session only. Sophia must not promise permanent memory, long-term storage, or future recall until offline writeback persists the fact.

## Attribution Matrix For Next Smoke

Use the new fields to classify failures:

| Evidence | Likely classification |
|---|---|
| `status=unavailable` or `error` | provider/config/runtime failure |
| `status=no_results`, `has_results=false` | provider reachable, query found no stored match |
| `status=success`, result fingerprints present, low query-term match | query mismatch or weak retrieval |
| `status=success`, high query-term match, model asks user to remind it | model ignored useful returned memory |
| setup/name continuity without a tool call | setup context, not proof of Mem0 retrieval |
| user reveals answer after no retrieved match | current-session knowledge only |

## Worktree Cleanup Notes

No broad cleanup was applied in this implementation pass. The migration worktree remains intentionally dirty from prior phases. The only cleanup applied was to remove two generated local telemetry JSON exports and add an ignore pattern for future `sophia-voice-telemetry-report-*.json` files.

## Validation

- `cd backend; uv run pytest tests/test_retrieve_memories_contract.py` — passed, 16 tests.
- `$env:PYTHONPATH='.'; uv run pytest voice/tests/test_gemini_browser_dogfood.py` — passed, 29 tests.
- `$env:PYTHONPATH='.'; uv run pytest voice/tests/test_sophia_prompt.py -k realtime_memory_recall_guidance` — passed, 1 selected test.
- `cd frontend; pnpm vitest run src/__tests__/gemini-browser-live-websocket-dogfood.test.ts src/__tests__/lib/voice-telemetry-report.test.ts` — passed, 35 tests.
- `cd backend; uv run ruff check packages/harness/deerflow/sophia/tools/retrieve_memories_contract.py tests/test_retrieve_memories_contract.py` — passed.
- `$env:PYTHONPATH='.'; uv run ruff check voice/realtime/gemini_tool_loop.py voice/realtime/gemini_browser_dogfood.py voice/tests/test_gemini_browser_dogfood.py voice/tests/test_sophia_prompt.py` — passed.
- `cd frontend; pnpm eslint src/app/lib/gemini-browser-live-websocket-dogfood.ts src/app/lib/voice-telemetry-report.ts src/__tests__/gemini-browser-live-websocket-dogfood.test.ts src/__tests__/lib/voice-telemetry-report.test.ts` — passed.
