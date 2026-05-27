# Gemini Ordered Relay Caption Throughput - Phase 12.4K

Date: 2026-05-21
Status: Implemented after Phase 12.4M

## Scope

Phase 12.4K reduces visible Gemini assistant caption lag by cleaning up the browser ordered relay queue. It does not change Gemini spoken policy, Mem0 or memory writes, the artifact contract, VAD, `realtimeInputConfig`, Gemini runtime defaulting, or the Phase 12.4G-B sequence-safety contract.

## Root Cause

Gemini Live sends `outputTranscription` independently from other server messages, and Google does not guarantee those transcription messages are word-synchronous with audio playback. The production path already preserves correctness by assigning browser receive metadata, relaying critical events through a sequence-safe backend buffer, mapping source metadata into `ProviderEvent`, and rejecting stale transcript snapshots in the normalizer and frontend.

The remaining lag was throughput: the browser had one ordered relay lane for continuity-critical events. Every assistant partial caption was queued behind earlier critical work, even when a newer partial fully superseded it. That preserved order but let old replaceable snapshots delay fresher captions.

## Implementation

`frontend/src/app/lib/gemini-browser-live-websocket-dogfood.ts` now uses an explicit ordered relay queue instead of a promise-tail chain. Pending non-final assistant `serverContent.outputTranscription` events receive a coalescing key for the current assistant segment. If a newer pending partial for the same key arrives before the older one is sent, the older task is replaced.

The important sequence rule is unchanged: `provider_relay_sequence` is assigned only inside the task at send time. A coalesced partial never receives a relay sequence number, so the backend sees contiguous relay sequences even though `provider_receive_sequence` can legitimately jump over the dropped browser-local snapshot.

Only non-final assistant output transcription partials are coalescible. These remain non-droppable:

- Final assistant transcript boundary events.
- User `inputTranscription`.
- Tool calls and tool-call cancellations.
- Interruptions, response boundaries, setup/lifecycle messages, provider errors, and `goAway`.

Tool-call cancellation now uses the ordered critical lane so backend observation remains sequenced with neighboring tool/transcript events. Browser-local cancellation ledger updates still happen immediately, preserving stale `toolResponse` suppression.

Gemini-only Session caption pacing was reduced from the previous conservative defaults to `minInitialCharacters=16`, `minCharacterDelta=16`, `minIntervalMs=120`, and `maxIntervalMs=360`. Final text still flushes through the exact final transcript path.

## Telemetry

Relay traces now include a `throughput` snapshot with:

- `orderedRelayQueueDepth`
- `oldestQueuedAgeMs`
- `transcriptPartialsCoalesced`
- `transcriptPartialsSent`
- `transcriptPartialsDropped`
- `finalTranscriptEventsSent`
- `nonDroppableCriticalEventsSent`
- `lastTranscriptRelayLatencyMs`
- `maxTranscriptRelayLatencyMs`
- `p95TranscriptRelayLatencyMs`
- `coalescedBySegment`

Coalescing emits separate current-run capture events named `gemini-transcript-partial-coalesced`. Session runtime telemetry, derived voice developer metrics, and the scoped voice telemetry report expose the same counters. Telemetry report exports include `diagnosticsSummary.geminiRelayThroughput` so queue age/depth and coalescing can be compared across runs without inspecting raw provider payloads.

## Safety Checks

Added focused coverage for:

- Browser coalescing of pending assistant partials while preserving contiguous `provider_relay_sequence` values.
- Final assistant transcript boundary events staying non-droppable behind pending partials.
- Terminal relay failure coverage using non-droppable user transcription events instead of coalescible assistant partials.
- Backend normalizer acceptance of increasing non-contiguous transcript `source_sequence` values, while still rejecting a stale lower source sequence.
- Telemetry export and derived metrics coverage for the new throughput fields.

## Manual Smoke

For a live Gemini production candidate smoke, use a normal Session voice run and export current-run voice telemetry after a long assistant reply. Inspect:

- Captions update before the full assistant audio finishes.
- `geminiRelayThroughput.transcriptPartialsCoalesced` is nonzero during bursty partials.
- `maxOldestQueuedAgeMs` and `p95TranscriptRelayLatencyMs` remain bounded compared with pre-12.4K traces.
- Final visible assistant text matches the final public `sophia.transcript` snapshot.
- Tool calls, cancellations, user transcript, and turn boundary events still appear in the ordered timeline.

## Non-Goals

- No prompt or spoken policy edits.
- No Mem0 or offline-pipeline behavior changes.
- No artifact schema or reflection behavior changes.
- No VAD, activity handling, or `realtimeInputConfig` tuning.
- No Gemini runtime promotion or default change.
- No removal or weakening of Phase 12.4G-B source-order protection.