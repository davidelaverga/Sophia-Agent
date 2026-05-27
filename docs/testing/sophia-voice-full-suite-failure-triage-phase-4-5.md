# Sophia Voice Full Suite Failure Triage - Phase 4.5

Date: 2026-05-17
Branch: `chore/voice-suite-failure-triage-phase-4-5`
Source branch: `feat/openai-realtime-provider-phase-4`

## Executive Summary

The previously reported full voice suite result was reproduced exactly on the dirty Phase 4 worktree: `58 failed, 226 passed, 2 warnings` from `python -m pytest voice/tests -q`.

The same 58 failing tests were then reproduced on a temporary clean detached worktree at HEAD commit `2a0ea5cd1c27bd714c6c37b56c785f9deb91ec8c` with dummy required voice env vars. That clean run did not include the untracked realtime tests, so its pass count was lower (`187 passed`), but the failing test set was identical.

Conclusion: the 58 failures were preexisting baseline/stale-test debt, not caused by the Phase 4 OpenAI adapter and not caused by the uncommitted Phase 1-3 realtime contract/bridge/shadow work. The failures were repaired with test-only updates. No production voice runtime code was changed.

Final current-branch result after test stabilization: `284 passed, 2 warnings` from `python -m pytest voice/tests -q`.

## Commands Run

Initial current worktree reproduction:

```powershell
python -m pytest voice/tests -q
```

Result: `58 failed, 226 passed, 2 warnings in 16.16s`.

Failure-list capture:

```powershell
python -m pytest voice/tests -q --tb=no -ra
```

Result: `58 failed, 226 passed, 2 warnings in 8.64s`.

Clean detached baseline comparison:

```powershell
git worktree add --detach <temp-worktree> 2a0ea5cd1c27bd714c6c37b56c785f9deb91ec8c
$env:STREAM_API_KEY='test-stream'
$env:STREAM_API_SECRET='test-stream-secret'
$env:DEEPGRAM_API_KEY='test-deepgram'
$env:CARTESIA_API_KEY='test-cartesia'
python -m pytest voice/tests -q --tb=no -ra
git worktree remove --force <temp-worktree>
```

Result: `58 failed, 187 passed, 2 warnings in 9.69s`. The failing test set matched the current worktree exactly. The pass count was lower because the clean worktree did not contain the untracked Phase 1-4 realtime tests.

Focused realtime regression set:

```powershell
python -m pytest voice/tests/test_openai_realtime_provider_adapter.py voice/tests/test_realtime_runtime_selection.py voice/tests/test_realtime_normalizer.py voice/tests/test_realtime_legacy_cascade_bridge.py voice/tests/test_realtime_shadow_parity.py voice/tests/test_config.py voice/tests/test_sophia_llm_streaming.py -q
```

Result after stabilization: `69 passed, 1 warning`.

Individual focused results after stabilization:

```powershell
python -m pytest voice/tests/test_openai_realtime_provider_adapter.py -q
python -m pytest voice/tests/test_realtime_runtime_selection.py -q
python -m pytest voice/tests/test_realtime_normalizer.py -q
python -m pytest voice/tests/test_realtime_legacy_cascade_bridge.py -q
python -m pytest voice/tests/test_realtime_shadow_parity.py -q
python -m pytest voice/tests/test_config.py -q
python -m pytest voice/tests/test_sophia_llm_streaming.py -q
```

Results: `9 passed`, `4 passed`, `7 passed`, `7 passed`, `4 passed`, `10 passed`, `28 passed, 1 warning`.

Targeted repaired clusters:

```powershell
python -m pytest voice/tests/test_deerflow_adapter.py voice/tests/test_sophia_turn.py voice/tests/test_voice_artifact_contract.py -q
```

Result: `104 passed, 2 warnings`.

Final full voice suite:

```powershell
python -m pytest voice/tests -q
```

Result: `284 passed, 2 warnings in 8.27s`.

## Failure Classification

| Failure cluster | Count | Files | Root cause | Caused by Phase 4? | Caused by earlier realtime phases? | Action |
|---|---:|---|---|---|---|---|
| DeerFlow payload expectations | 2 | `voice/tests/test_deerflow_adapter.py` | Tests expected the pre-April payload shape and omitted `config.recursion_limit`, while production `DeerFlowBackendAdapter._build_run_payload` has included `recursion_limit: 150` since commit `8a8aa976` (`fix: prevent summarization leak into responses + raise recursion limit`). | No | No | Updated tests to include `recursion_limit: 150`. |
| Sophia turn adaptive silence expectations | 53 | `voice/tests/test_sophia_turn.py`, `voice/tests/conftest.py` | Tests and helper defaults still reflected the original 1000/1500/2000/2800ms design. Production was intentionally retuned to 600/800/1200/1400ms with lower continuation/fragment bonuses in commit `a76f45bb` (`perf: aggressive turn detection tuning - ceiling 1400ms, drop article continuations`). | No | No | Updated tests and helper defaults to current production tuning. |
| TTS fake object contract | 1 | `voice/tests/test_sophia_turn.py` | The test constructs `SophiaTTS` with `__new__` and skipped fields later added to `SophiaTTS.__init__`, including `_synthesis_count` and `_active_response_user_id`. | No | No | Completed the test stub runtime fields. |
| `create_agent` fake LLM contract | 2 | `voice/tests/test_voice_artifact_contract.py` | Fake LLM objects lacked the current `note_backend_progress` hook required by `voice/server.py` after builder progress/stall tracking work in commit `0953ed4d`. | No | No | Added `note_backend_progress` to the fakes. |

## Attribution Evidence

- Current source branch before triage: `feat/openai-realtime-provider-phase-4`.
- New triage branch: `chore/voice-suite-failure-triage-phase-4-5`.
- Both branches point at HEAD commit `2a0ea5cd`, which is also `main`/`origin/main`; Phase 1-4 realtime work existed as dirty/untracked files in the worktree.
- Initial dirty diff touched `.env.example`, `COMPOUND_LOG.md`, `voice/config.py`, `voice/sophia_llm.py`, `voice/tests/test_config.py`, `voice/tests/test_sophia_llm_streaming.py`, plus untracked `voice/realtime/**` and focused realtime tests.
- The failing clusters were in `voice/tests/test_deerflow_adapter.py`, `voice/tests/test_sophia_turn.py`, and `voice/tests/test_voice_artifact_contract.py`; their production roots were `voice/adapters/deerflow.py`, `voice/sophia_turn.py`, `voice/sophia_tts.py`, and `voice/server.py`.
- The same failing set occurred in a clean detached worktree without the dirty realtime files, establishing that the failures predated Phase 4 adapter work.
- No Phase 4 implementation report was found under `docs/**/*phase*4*`; attribution relied on the current branch diff, compound log entries, test state, clean-baseline comparison, and blame on the failure-root lines.

## Files Changed For Stabilization

Production code: none.

Test files:

- `voice/tests/test_deerflow_adapter.py`
- `voice/tests/test_sophia_turn.py`
- `voice/tests/conftest.py`
- `voice/tests/test_voice_artifact_contract.py`

Documentation files:

- `COMPOUND_LOG.md`
- `docs/common-pitfalls.md`
- `docs/testing/sophia-voice-full-suite-failure-triage-phase-4-5.md`

## Recommendation

Proceed to the next Gemini Live planning/implementation prompt from a testing standpoint. The OpenAI adapter and provider-neutral realtime foundation remained green, and the red global suite was proven to be stale baseline test debt before the dirty Phase 1-4 realtime files were present.

The next migration phase should still avoid wiring Gemini Live into `voice/server.py` immediately. Continue with an inactive Gemini provider adapter/mapper and focused parity tests first, preserving `legacy_cascade` as the only active runtime until the Gemini adapter has equivalent event-normalization coverage.