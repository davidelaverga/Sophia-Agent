# Phase 12.4G-B - Gemini Sequence-Safe Transcript Relay

Date: 2026-05-20
Status: implementation complete; targeted validation passing
Source branch: `voice-transport-migration`
Implementation branch: `fix/gemini-sequence-safe-transcript-relay-phase-12-4g-b`
Runtime under change: Gemini Live browser-owned production candidate

## Scope And Safety

This phase implements the source-order contract recommended by `docs/audits/gemini-assistant-transcript-corruption-forensics-phase-12-4g-a.md`.

Branch safety:

- Work was continued from the Gemini transcript forensics context on a non-main worktree.
- No commits or pushes were made.
- Prompt files, `skills/public/sophia/soul.md`, and `lead_agent/` were not modified.

Evidence limitation:

- The requested `docs/audits/gemini-relay-throughput-phase-12-4d.md` file is not present in this worktree. Searches for `*12-4d*`, `*relay*`, and `12.4D` did not find that audit. This implementation relies on the available 12.4G-A forensic audit, current runtime contract, official Gemini Live docs checked in 12.4G-A, and code inspection.

## Problem

Phase 12.4F made public `sophia.transcript.data.text` a replaceable assistant snapshot and hardened unknown Gemini output-transcription chunk assembly. The remaining corruption class was ordering-sensitive:

- Browser receives Gemini Live provider messages in WebSocket callback order.
- Relay POSTs were launched concurrently without source-order metadata in the request body.
- Backend processing order could differ from provider receive order.
- `GeminiLiveEventMapper.sequence` was assigned only after backend processing, so it could not recover original provider order.
- `SophiaEventNormalizer` mutated assistant transcript buffers immediately and had no stale source guard.
- Frontend Session ingestion replaced snapshots, but had no way to reject an older public snapshot for the same response/segment.

Observed phrases such as `to lock You ready`, `tell I can't It has you that`, and `Focus on staying When calm...` are exactly the kind of artifact produced when clean non-overlapping fragments are applied out of order.

## Implementation

### Browser Source Metadata

`frontend/src/app/lib/gemini-browser-live-websocket-dogfood.ts` now creates metadata at provider WebSocket receive time:

- `provider_receive_sequence`
- `provider_received_at`
- `relay_correlation_id`
- `provider_primary_category`
- `provider_categories`

Each relayed message also receives a contiguous `provider_relay_sequence`. This avoids confusing the backend reorder buffer with skipped local-only messages such as pure output audio frames.

Continuity-critical relays go through an ordered browser relay lane. Relay traces now record source sequence, source timestamp, ordered-lane use, queue depth, and oldest queued age.

### Backend Relay Ordering

`voice/server.py` accepts the metadata beside the raw Gemini `event` payload. `voice/realtime/gemini_browser_dogfood.py` validates it through `GeminiRelaySourceMetadata` and applies source safety in `GeminiBrowserDogfoodSessionManager`:

- Events with a future `provider_relay_sequence` are buffered until the missing predecessor arrives.
- Events with an already-applied sequence are accepted as stale/ignored and surfaced through diagnostics instead of being remapped.
- Raw provider events are pushed into the dogfood session in source order before long-running tool execution can delay transcript/boundary observation.
- Diagnostics track buffered, applied, stale rejected, and boundary rejected sequence counts.

The raw event stream stores metadata as internal context rather than mutating the raw Gemini provider payload.

### Mapper Metadata Preservation

`voice/realtime/gemini_live.py` unwraps raw event context and passes source metadata into `GeminiLiveEventMapper`. Mapped `ProviderEvent` values include compact source fields such as `source_sequence`, `provider_relay_sequence`, `provider_received_at`, and `relay_correlation_id`. When source metadata is present, `ProviderEvent.sequence` uses provider receive sequence instead of backend mapper order.

### Normalizer Stale Guards

`voice/realtime/normalizer.py` now tracks the highest assistant transcript source sequence per response/segment and response-boundary source sequence per response. Older transcript snapshots and late snapshots after interruption/cancel/response-end become `sophia.turn_diagnostic` payloads with `transcript_sequence_stale_rejected` or `transcript_boundary_stale_rejected` reasons.

Public transcript payloads remain backward compatible. Legacy/unsequenced paths still emit `{ text, is_final }`. Sequenced Gemini paths additionally emit non-breaking metadata such as `source_sequence`, `response_id`, and `segment_id` so downstream consumers can reject stale snapshots.

### Frontend Stale Snapshot Guard

`frontend/src/app/hooks/voice-session-event-ingestion.ts` parses optional transcript metadata and provides a per-response/segment stale guard. `frontend/src/app/hooks/useStreamVoiceSession.ts` applies that guard before updating partial/final assistant text and records ignored stale snapshots as capture diagnostics.

## Regression Coverage

Added or updated focused tests for:

- Browser relay metadata envelope and monotonic receive/relay sequence fields.
- Frontend stale assistant snapshot rejection.
- Backend relay buffering for HTTP order `N+1` then `N`, producing `You ready to lock` rather than `to lock You ready`.
- Gemini mapper source metadata preservation.
- Normalizer stale transcript rejection for same segment.
- Normalizer late transcript rejection after interruption boundary.

Targeted validation results:

```text
cd frontend; pnpm test -- src/__tests__/hooks/voice-session-event-ingestion.test.ts src/__tests__/gemini-browser-live-websocket-dogfood.test.ts
# 30 passed

$env:PYTHONPATH='.'; python -m pytest voice/tests/test_realtime_normalizer.py voice/tests/test_gemini_live_provider_adapter.py voice/tests/test_gemini_browser_dogfood.py -q
# 57 passed, 5 warnings
```

## Manual Smoke Plan

Use the normal Gemini production candidate session path with telemetry capture enabled.

1. Start a Gemini production voice session.
2. Use Edward's exact control sequence:
   - `Hi, Sophia. Can you hear me clearly?`
   - `What do you recommend? What's one thing that I should focus on today?`
   - `You're right. What matters the most to me is just staying calm under pressure.`
   - `I'm better than this. I'm in control.`
3. Verify the visible Session transcript does not contain `to lock You ready`, `tell I can't It has you that`, stale `Yeah, loud and clear.` prefixes on the next answer, or braided `Focus on staying When calm...` fragments.
4. Export current-run voice telemetry and inspect:
   - Relay bodies include provider receive and relay sequence fields.
   - Relay traces show monotonic provider receive/relay sequence order for transcript-bearing messages.
   - Backend diagnostics have zero stale rejects in a healthy run; if rejects appear, they should correlate with ignored stale snapshots and not visible corruption.
   - Public `sophia.transcript` snapshots for Gemini include `source_sequence` and replace, not append, the active assistant message.

## Expected Impact

This is expected to materially resolve the observed word-order corruption class when provider text fragments are clean but relayed or processed out of order. It cannot guarantee correctness if Gemini itself emits already-corrupted transcription text, but the implementation now preserves browser receive order, repairs out-of-order HTTP relay arrivals, rejects stale backend mutations, and rejects stale frontend snapshots.
