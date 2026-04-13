# Sophia Voice Backend Findings Report

Date: 2026-04-13
Branch: `feat/voice-sse-browser-bridge`
Commit: `87446e8f`
Prepared for: Davide
Complement to: [Sophia Voice Mode Improvements Report](./sophia-voice-mode-improvements-report-2026-04-12.md)

## Executive Summary

This document complements the broader voice-mode report by isolating the backend-side findings that emerged once browser transport, startup, and duplicate-turn issues were largely under control.

The main conclusion is straightforward:

1. The remaining latency problem is now primarily backend-side.
2. Several backend costs were still self-inflicted and have now been removed or reduced.
3. The largest remaining delay is no longer browser startup or event transport. It is the time between a committed user turn and DeerFlow / LangGraph / model progress producing the first meaningful response text.

The highest-value backend findings in this branch were:

- local LangGraph dev queueing was effectively under-provisioned unless worker concurrency was passed explicitly on the CLI
- backend prompt assembly could still bloat the voice path through prompt-block accumulation and tone-guidance parsing fallback
- Mem0 was still an avoidable cost on many voice follow-up turns
- the first real backend turn still paid cold-start cost even after frontend warm-start improved voice session startup
- diagnostics were mixing committed-turn latency with raw speech-end latency, which overstated some backend stalls
- stale or abandoned DeerFlow runs needed stronger cancellation semantics to avoid queue noise

## Backend Findings

## 1. Queue wait was real, and local LangGraph dev was hiding it

Once the frontend startup path was improved, queue wait became one of the largest remaining chunks in local voice testing.

The key finding was that local LangGraph dev did not reliably honor env-only worker tuning in the way we needed. In practice, the safe fix was to pass worker concurrency explicitly with `--n-jobs-per-worker`.

Related operational finding:

- when running LangGraph locally with `--allow-blocking`, `BG_JOB_ISOLATED_LOOPS=true` should also be set so blocking work does not starve the background queue path

This was verified live after restart through LangGraph logs showing:

- `Starting queue with isolated loops`
- `Starting 4 background workers`

## 2. Prompt inflation on the backend path was still costing first-token time

Several backend prompt-path issues were still inflating the voice path even after transport and browser fixes:

- `system_prompt_blocks` had previously relied on reducer semantics that are not appropriate for this middleware chain and could duplicate prompt content within a turn
- `ToneGuidanceMiddleware` could fall back to injecting the full live tone-guidance file if it failed to parse the current heading structure
- artifact instructions for voice were heavier than necessary relative to the actual `emit_artifact` contract used by the runtime
- `turn_count` was not being derived early enough from history, so first-turn-only middleware behavior could keep re-firing on later requests

The practical result was unnecessary prompt size, repeated first-turn logic, and more work before first useful backend output.

## 3. Mem0 was still a significant cost on voice follow-up turns

Mem0 already had a cache, but voice was still paying more retrieval cost than necessary.

The main findings were:

- low-signal voice turns were still capable of triggering remote search unless explicitly short-circuited
- similar voice follow-ups inside the same thread were still re-searching too often
- blank extracted user text and warmup traffic needed explicit skip logic
- voice did not need the same memory fan-out as text mode

This mattered because by this point startup and frontend overhead were lower, so hundreds of milliseconds of avoidable memory retrieval became much more visible.

## 4. Backend cold-start still remained after frontend warm-start improvements

The frontend preconnect path improved session-ready time materially, but the first real backend turn could still pay cold-start cost inside the backend and voice runtime stack.

Important findings:

- DeerFlow thread creation and first `runs/stream` setup were still worth warming independently of the browser session startup path
- TTS also had a meaningful one-time cold-start component worth priming on the server side
- warmup needed to keep the real conversation thread clean rather than consuming it with fake traffic

This led to a session-scoped warmup seam across frontend proxy, gateway, voice server, `SophiaLLM`, DeerFlow, and TTS.

## 5. Some apparent backend stalls were actually mixed-latency accounting

Before this branch, the diagnostics path could make some turns look like pure backend stalls even when the committed user-visible response path had already recovered.

The root issue was that these concepts were being conflated:

- committed transcript to visible backend response
- public `user_ended` turn boundary timing
- raw diagnostic speech-end to first-text timing
- transcript stabilization wait before the backend request

Without separating those clocks, a turn could be partly stabilized or re-committed cleanly but still look like a monolithic backend stall.

## 6. Run cancellation semantics needed to be stricter

For live voice turns, abandoned or superseded DeerFlow runs should not remain active or drift in the background.

The finding here was that voice runs needed explicit lifecycle semantics on the DeerFlow request path:

- `on_disconnect="cancel"`
- `multitask_strategy="rollback"`

Without that, stale work could continue running or stack up behind later voice turns, which is exactly the kind of behavior that shows up downstream as queue wait or noisy `backend_stall` symptoms.

## Changes Implemented

## 1. LangGraph queue and launcher fixes

Updated:

- `backend/Makefile`
- `scripts/serve.sh`
- `scripts/start-daemon.sh`
- `scripts/start-all.ps1`
- `scripts/sophia-dev.ps1`

Changes:

- local LangGraph dev now passes `--n-jobs-per-worker 4` explicitly
- blocking dev launchers now default `BG_JOB_ISOLATED_LOOPS=true`
- queue isolation and worker count are now consistent across the main local launch paths

## 2. Sophia middleware and prompt-path fixes

Updated:

- `backend/packages/harness/deerflow/agents/sophia_agent/agent.py`
- `backend/packages/harness/deerflow/agents/sophia_agent/state.py`
- `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/artifact.py`
- `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/tone_guidance.py`
- `backend/packages/harness/deerflow/agents/sophia_agent/utils.py`
- `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/turn_count.py`

Changes:

- added `TurnCountMiddleware` so prior completed user turns are derived before first-turn-sensitive middleware runs
- changed `SophiaState.system_prompt_blocks` to plain state with manual accumulation only, removing reducer-driven duplication risk
- taught `ToneGuidanceMiddleware` to parse the live structured tone file instead of falling back to the full document
- switched voice artifact instructions to a compact contract aligned with the actual `emit_artifact` schema
- hardened `extract_last_message_text()` so downstream logic uses the latest real user utterance, including nested multimodal content

## 3. Mem0 latency reduction for voice

Updated:

- `backend/packages/harness/deerflow/sophia/mem0_client.py`
- `backend/packages/harness/deerflow/agents/sophia_agent/middlewares/mem0_memory.py`

Changes:

- made Mem0 warmup idempotent
- added explicit `limit` handling and reduced voice retrieval limit to `4`
- added recent-result reuse for voice within the same thread
- added sticky reuse and recent-turn reuse windows
- skip Mem0 for blank queries, the warmup user, and low-signal voice turns without useful cache
- preserve refreshes for explicit memory questions and clear topic shifts

## 4. Backend session warmup seam

Updated:

- `frontend/src/app/api/sophia/[userId]/voice/warmup/route.ts`
- `backend/app/gateway/routers/voice.py`
- `voice/server.py`
- `voice/sophia_llm.py`
- `voice/adapters/deerflow.py`
- `voice/sophia_tts.py`

Changes:

- added a dedicated `/voice/warmup` path from frontend proxy to gateway to voice server
- `SophiaLLM.start_backend_warmup()` now schedules a best-effort backend warmup per bound session context
- `DeerFlowBackendAdapter.warmup()` precreates the real user thread early, then warms `runs/stream` on an isolated ephemeral warmup thread so the live conversation thread stays clean
- `SophiaTTS.start_warmup()` primes TTS once per process

## 5. Turn-stabilization and backend timing diagnostics

Updated:

- `voice/sophia_turn.py`
- `voice/server.py`
- `voice/turn_diagnostics.py`
- `voice/sophia_llm.py`
- `frontend/src/app/lib/voice-runtime-metrics.ts`
- `frontend/src/app/components/session/VoiceMetricsPanel.tsx`

Changes:

- transcript stabilization is now adaptive instead of always sleeping the full fragile window
- `submission_stabilization_ms` is now recorded explicitly in turn diagnostics
- committed response timing is now separated from raw speech-end timing
- added `commit-boundary` as a first-class classification when raw and committed latency diverge
- recent-turn summaries now surface committed-close and backend-start timing directly

## 6. DeerFlow run lifecycle hardening

Updated:

- `voice/adapters/deerflow.py`

Changes:

- all voice DeerFlow runs now set `on_disconnect="cancel"`
- all voice DeerFlow runs now set `multitask_strategy="rollback"`
- this prevents abandoned or superseded voice turns from continuing as stale background work

## Validation Performed

## Automated regression coverage

Backend coverage added or updated in:

- `backend/tests/test_mem0_client.py`
- `backend/tests/test_sophia_integration.py`
- `backend/tests/test_sophia_middlewares.py`
- `backend/tests/test_sophia_state.py`

Voice runtime coverage added or updated in:

- `voice/tests/test_deerflow_adapter.py`
- `voice/tests/test_sophia_llm_streaming.py`
- `voice/tests/test_sophia_tts.py`
- `voice/tests/test_sophia_turn.py`
- `voice/tests/test_turn_diagnostics.py`
- `voice/tests/test_turn_metrics.py`
- `voice/tests/test_voice_artifact_contract.py`

These tests cover the new warmup path, compact artifact instructions, tone-guidance parsing, turn counting, Mem0 reuse/skip behavior, streaming chunking, diagnostics, and cancellation semantics.

## Live validation

Live validation after restart showed:

- queue isolation enabled
- `4` LangGraph background workers active
- voice `/health` returned `200`
- warm-start remained healthy with `sessionReadyMs` around `1088-1103ms`
- local runtime hot-path overhead before the backend request was largely removed, with `backendRequestStartMs` dropping to low tens of milliseconds and one measured turn near `~10ms`

The strongest remaining latency evidence after these fixes was:

- `requestStartToFirstTextMs` remained roughly `~2675ms`
- `firstTextToBackendCompleteMs` remained roughly `~5278ms`

That is the clearest sign that the branch has already removed most self-inflicted backend overhead and that the remaining bottleneck is now inside DeerFlow / LangGraph / model execution before and after first meaningful text.

## Current Interpretation

After this work, the backend picture is much cleaner:

- queue provisioning is explicit and verified
- prompt inflation risks on the voice path are reduced
- Mem0 is much cheaper on voice follow-ups
- backend and TTS cold-start have a real warmup seam
- committed response latency is now distinguished from raw diagnostic timing
- abandoned runs are less likely to poison later turns

In other words, the branch has converted a mixed and partially self-inflicted backend latency profile into a narrower, more honest one.

## Recommended Next Step

The next backend pass should focus on the portion that still dominates after these fixes:

1. inspect DeerFlow / LangGraph work before the first meaningful backend text event
2. separate model-first-token delay from middleware / graph orchestration delay
3. reduce the long tail from first text to backend complete without regressing artifact correctness or turn stability

That is now the highest-value remaining optimization target for Sophia voice.

## Scope Note

This report is intentionally backend-focused. The same commit also contains frontend activation and telemetry wiring that was necessary to trigger or observe the backend changes. It also contains tracked runtime-generated `users/` artifacts that should not be treated as core product implementation scope for Davide's review.