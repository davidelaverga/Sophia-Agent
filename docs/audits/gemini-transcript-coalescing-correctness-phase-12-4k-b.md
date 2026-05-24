# Gemini Transcript Coalescing Correctness - Phase 12.4K-B

Date: 2026-05-21
Status: Implemented hotfix after failed Phase 12.4K live smoke

## Scope

Phase 12.4K-B restores visible transcript correctness for Gemini Live by disabling unsafe browser-side dropping of raw assistant `serverContent.outputTranscription` fragments.

This phase does not change Gemini spoken policy, VAD, `realtimeInputConfig`, Mem0 or memory behavior, artifact behavior, runtime defaulting, or the Phase 12.4G-B sequence-safety contract. The explicit ordered relay queue from Phase 12.4K remains in place.

## Regression

The live smoke after Phase 12.4K had good spoken audio but scrambled visible captions, including sparse phrases shaped like:

- `rising. When pressure like to it Don't for you?`
- `you focus When you're more and make emotionally. control. in?`
- `strategy. You see key. to you?`

The control telemetry showed high coalescing and dropping counts, with no final transcript events sent in that run. Provider output transcription previews were clean ordered fragments, including:

- `You're asking`
- `for a`
- `deeper`
- `understanding`
- `of how`
- `calmness`
- `improves`
- `strategy.`

Those previews show that the raw non-final output transcription stream behaved like ordered semantic fragments in the observed run. Phase 12.4K treated those raw fragments as replaceable snapshots and dropped pending intermediate fragments. The backend normalizer then assembled only the sparse surviving fragments, so the visible transcript lost meaning even though relay sequence numbers stayed contiguous.

## Hotfix Behavior

Raw Gemini assistant `outputTranscription` fragments are now non-droppable ordered critical events. They still use the explicit ordered relay queue, provider receive metadata, and send-time contiguous `provider_relay_sequence`; they simply do not receive a coalescing key.

Throughput telemetry remains useful:

- `transcriptPartialsSent` counts raw assistant output transcription partials that are relayed.
- `transcriptPartialsCoalesced` remains zero for raw provider fragments.
- `transcriptPartialsDropped` remains zero for raw provider fragments.
- `transcriptCoalescingDisabledReason` is set to `provider_output_transcription_is_delta_like`.

Final transcript and turn-boundary events, user input transcripts, tool calls, tool-call cancellations, interruptions, setup/lifecycle messages, provider errors, and turn boundaries remain non-droppable.

## Validation Focus

Added or updated focused coverage for:

- Raw output transcription fragments relaying in order without drops.
- The control fragment sequence `You're asking` -> `for a` -> `deeper` -> `understanding` preserving all raw meaning.
- User transcript, tool call, tool cancellation, and turn-boundary events staying queued and non-droppable behind a blocked transcript relay.
- Backend normalizer assembly of ordered delta-like fragments into a coherent public transcript.
- Telemetry reporting zero raw coalescing/drops plus the disabled reason.

## Deferred Caption Latency Work

Future caption optimization should be designed around a local source-ordered assembler:

`raw Gemini outputTranscription fragments -> browser accumulator -> app-assembled cumulative snapshot -> optional coalesced snapshot relay`

The backend should be able to distinguish provider-raw fragments from app-assembled cumulative snapshots before any dropping is reintroduced. Until then, correctness wins over caption freshness.

## Manual Smoke

Run the production Gemini Session path and test:

1. `Tell me one short thing about staying calm under pressure.`
2. `Give me a slightly longer explanation of why staying calm helps in strategy games.`
3. `Sophia, reflect briefly on what I just said.`

Expected result: spoken audio remains good, visible transcript is coherent again, and captions may lag more than Phase 12.4K but must not become sparse or nonsensical.