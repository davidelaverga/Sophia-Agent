# Phase 12.4G-A - Gemini Assistant Transcript Corruption Forensics

Date: 2026-05-20
Status: investigation only; no transcript behavior fix implemented
Source branch: `voice-transport-migration`
Investigation branch: `audit/gemini-transcript-corruption-forensics-phase-12-4g-a`
Runtime under investigation: Gemini Live production candidate

## Scope And Safety

This phase was deliberately forensic. It did not change runtime transcript behavior, relay scheduling, normalizer semantics, provider mapping, prompt files, or frontend reducers.

Branch safety performed before investigation:

- `git status --short -uall` confirmed the worktree was already dirty with prior Phase 1-12.4F migration edits.
- `git branch --show-current` reported `voice-transport-migration`, not `main`.
- A new branch was created and checked out: `audit/gemini-transcript-corruption-forensics-phase-12-4g-a`.
- `main` was not checked out, committed to, pushed to, or modified directly.

Important evidence limitation:

- The requested `new summary.zip` telemetry archive was not present in the workspace, repo logs, Downloads, Desktop, Documents, Temp, or the Copilot chat resource storage searched during this investigation.
- The shared browser Session page was signed out and `window.__sophiaCapture.export()` contained zero events.
- Therefore this report cannot quote raw provider payloads or absolute timestamps from the live run. It uses Edward's observed transcript excerpt, official Google documentation, code inspection, and read-only simulations of the current Phase 12.4F merge helper.

## Observed Live Symptoms

Fresh post-12.4F Session transcript excerpt supplied as control evidence:

```text
I'm here with you. What's on your mind?

Yeah, loud and clear.

Hi, Sophia. Can you hear me clearly?

Yeah, loud and clear. to lock You ready your game? What's the ONE thing in before you want to focus on?

What do you recommend? What's one thing that I should focus on today?

tell I can't It has you that. to come from you. What's the part of your gameplay keeps costing you? Focus on that.

You're right. What matters the most to me is just staying calm under pressure.

Focus on

I'm better than this. I'm in control.

Focus on staying When calm. pressure"I'm better hits, than this. in control."'em. Go get I'm here when you're done. internal on that"I'm in hits: it.
```

Failure signature:

- Word groups appear in the wrong order: `to lock You ready your game`, `tell I can't It has you that`.
- Fragments from different conceptual clauses are braided together: `Focus on staying When calm. pressure"I'm better hits...`.
- A previous assistant phrase appears to contaminate a later assistant answer: `Yeah, loud and clear.` prefixes the next reply.
- The visible transcript is not merely duplicated text or punctuation drift; it is order-sensitive corruption.

## Official Google Documentation Findings

Official sources checked:

- `https://ai.google.dev/gemini-api/docs/live`
- `https://ai.google.dev/api/live`
- `https://ai.google.dev/gemini-api/docs/live-api/capabilities`
- `https://ai.google.dev/gemini-api/docs/live-api/tools`

Relevant verified facts:

| Topic | Officially documented | Impact |
|---|---|---|
| Transport | Live API is a stateful WebSocket. Server messages are `setupComplete`, `serverContent`, `toolCall`, `toolCallCancellation`, `goAway`, `sessionResumptionUpdate`, plus `usageMetadata`. | Browser observes provider messages in WebSocket callback order, but that order is not currently preserved through relay. |
| Output transcription setup | `outputAudioTranscription` enables model audio output transcription. Server content can include `outputTranscription.text`. | `outputTranscription` is the assistant transcript source for native-audio output. |
| Cumulative vs delta semantics | The API reference defines `BidiGenerateContentTranscription.text` only as `Transcription text`. It does not specify cumulative snapshots, deltas, revisions, or append-only fragments. | Treating text as cumulative, delta, or fragment is an implementation assumption unless verified by telemetry. |
| Ordering | `inputTranscription` and `outputTranscription` are sent independently and have no guaranteed ordering. The reference specifically says output transcription has no guaranteed ordering, in particular not between `serverContent` and `outputTranscription`. | `generationComplete`, `turnComplete`, audio parts, and output transcription can be observed at different boundaries; local code must not rely on cross-field semantic order. |
| Realtime input | `send_realtime_input` is optimized for responsiveness at the expense of deterministic ordering. Different realtime modalities are concurrent and ordering across them is not guaranteed. | Turn/response boundaries in voice sessions need explicit local ordering/identity guards. |
| Interruption | `serverContent.interrupted` means a client message interrupted generation; clients should stop playback and clear queued audio. Interrupted turns do not get `generationComplete`; they go through `interrupted` then `turnComplete`. | Interruption is a transcript-buffer boundary. Late transcript relay after interruption is dangerous without stale rejection. |
| Tool cancellation | `toolCallCancellation` says previous tool call ids should not have been executed and should be cancelled. It occurs when clients interrupt server turns. | Tool-adjacent transcript segmentation and cancellation ordering matter. |
| Function calling | Gemini 3.1 Flash Live function calling is sequential; the model waits for `toolResponse`. | Tool relays can take longer than transcript relays and can reorder backend processing relative to provider arrival. |

Documentation conclusion: Google does not provide enough transcript semantics to justify appending output transcription chunks blindly, nor enough event-order semantics to justify applying relayed transcript events in HTTP completion order.

## Layer-by-Layer Flow Map

Current production Gemini transcript path:

```text
Gemini Live WSS message
  -> frontend/src/app/lib/gemini-browser-live-websocket-dogfood.ts
     WebSocket onmessage callback
     provider telemetry callback
     fire-and-forget relay POST
  -> Next relay route
  -> voice/server.py production relay endpoint
  -> voice/realtime/gemini_browser_dogfood.py ingest_browser_provider_event
  -> RealtimeDogfoodSession.raw_events queue
  -> voice/realtime/gemini_live.py GeminiLiveEventMapper
  -> voice/realtime/normalizer.py SophiaEventNormalizer
  -> public sophia.transcript SSE payload
  -> frontend/src/app/hooks/useStreamVoiceSession.ts
  -> voice-session-event-ingestion.ts
  -> appendVoiceAssistantMessage replacement path
```

Ordering facts by layer:

| Layer | What is ordered today? | Gap |
|---|---|---|
| Browser WSS callback | Provider messages are handled in callback order after parsing. | The callback does not produce a durable provider sequence field in the relayed payload. |
| Browser relay scheduling | A local `relayCorrelationSequence` is incremented for relay trace ids. | Relay POSTs use `void relayGeminiProviderEvent(...)`; they are concurrent and not awaited or queued. |
| Relay request body | Body is `{ session_id, event }`. | Correlation id, provider receive order, and provider received timestamp are not sent to the backend. |
| Backend relay endpoint | Processes whatever HTTP request reaches the endpoint. | No source sequence exists to detect or buffer out-of-order relay arrivals. |
| Backend tool relay | Tool calls are executed before the raw provider event is pushed into the session. | A tool-bearing provider message can be delayed behind later transcript or boundary messages. |
| Raw event pump | `DogfoodRawEventStream` preserves queue insertion order. | Queue insertion order is backend processing order, not provider arrival order. |
| Gemini mapper | Assigns `ProviderEvent.sequence` inside `map_event`. | Sequence is mapper-processing order only; it cannot recover original provider order. |
| Normalizer | Applies transcript chunks immediately in received order. | No source sequence, stale partial rejection, or per-provider order guard. |
| SSE | Publishes queued public payloads FIFO. | It faithfully delivers already-ordered or already-corrupted backend output. |
| Session frontend | Replaces active assistant text with each public snapshot. | No stale public event rejection exists if older backend snapshots arrive late. |

## Forensic Timeline Reconstruction

Because `new summary.zip` was unavailable, the exact live timestamps cannot be reconstructed. The following timeline is the strongest evidence-compatible reconstruction for the first corrupted assistant reply.

### Specimen A - `Yeah, loud and clear. to lock You ready your game?`

Observed public transcript sequence:

```text
Yeah, loud and clear.
...
Yeah, loud and clear. to lock You ready your game? What's the ONE thing in before you want to focus on?
```

Read-only simulation using the current Phase 12.4F merge helper:

```text
Input chunks in processed order:
1. Yeah, loud and clear.
2. to lock
3. You ready
4. your game?

Current public snapshots produced:
1. Yeah, loud and clear.
2. Yeah, loud and clear. to lock
3. Yeah, loud and clear. to lock You ready
4. Yeah, loud and clear. to lock You ready your game?
```

This reproduces the observed corruption prefix exactly. It does not prove these were the raw provider chunks, because raw payloads were unavailable, but it proves the current backend assembler can create the exact symptom from clean fragments processed in the wrong order.

Evidence-compatible event timeline:

| Step | Provider arrival | Relay scheduling | Backend processing | Public transcript result |
|---|---|---|---|---|
| 1 | Previous assistant output or stale same-response buffer contains `Yeah, loud and clear.` | Relayed as a critical output transcript or retained in same response buffer. | Normalizer buffer for response/segment contains `Yeah, loud and clear.`. | Clean first assistant text appears. |
| 2 | New assistant response begins, but prior `turnComplete`/boundary is late, missing, or processed after the new output chunk. | Relay has no source sequence to prove this boundary order. | Mapper can keep using `_active_response_id`; normalizer can reuse prior response buffer. | Later answer starts with old text. |
| 3 | Provider emits clean fragment `You ready` before or near `to lock`. | Relay POSTs are concurrent; later/lower-latency request can complete first. | Backend sees `to lock` before `You ready`. | `to lock You ready` is assembled. |
| 4 | Provider emits `your game?`. | Relayed normally. | Normalizer appends it after already-inverted fragments. | `to lock You ready your game?`. |

### Specimen B - `tell I can't It has you that.`

Read-only simulation:

```text
Input chunks in processed order:
1. tell
2. I can't
3. It has
4. you that.

Final current merge output:
tell I can't It has you that.
```

This reproduces the observed failure prefix exactly. The intended semantic order was likely closer to `I can't tell you that. It has to come from you.` If the provider emitted clean fragments in semantic order but relay/backend processed them as `tell`, `I can't`, `It has`, `you that.`, the Phase 12.4F auto assembler would produce the observed corruption.

### Specimen C - `Focus on staying When calm. pressure"I'm better...`

Read-only simulation:

```text
Input chunks in processed order:
1. Focus on staying
2. When calm.
3. pressure"I'm better
4. hits, than this.
5. in control."

Current public snapshots produced:
Focus on staying
Focus on staying When calm.
Focus on staying When calm. pressure"I'm better
Focus on staying When calm. pressure"I'm better hits, than this.
Focus on staying When calm. pressure"I'm better hits, than this. in control."
```

This matches the observed class: words from a sentence about calm under pressure and a quoted mantra are interleaved in completion order rather than semantic order.

## Hypothesis Evidence

### Hypothesis A - Provider Transcript Semantics

Classification: Strongly supported as a contributing uncertainty; not proven as provider-side corruption.

Evidence:

- Official docs do not define `outputTranscription.text` as cumulative or delta.
- Official docs say output transcription is independent and has no guaranteed ordering relative to other server messages.
- Phase 12.4F already stopped treating output transcription as append-only, but still treats non-overlapping text chunks as fragments that can be appended.
- Raw provider text from the live run was unavailable, so this investigation cannot prove whether Gemini itself emitted already-scrambled strings such as `to lock You ready`.

Conclusion: Provider semantics remain underspecified and must be treated defensively. Provider text being intrinsically corrupted is unproven.

### Hypothesis B - Relay Completion Order

Classification: Confirmed code-level root-cause class; strongly supported for the observed symptom; live-session inversion unproven without the missing zip.

Evidence:

- The browser increments `relayCorrelationSequence`, but uses it only for local trace ids.
- `relayGeminiProviderEvent(...)` is launched with `void`; relays are concurrent and not queued.
- The backend request body does not include the correlation id, local receive sequence, or provider receive timestamp.
- Backend `ingest_browser_provider_event` processes requests in arrival/execution order.
- The current merge helper reproduces observed corrupted prefixes exactly when clean chunks are processed in inverted order.

Conclusion: The system has no end-to-end provider-order guarantee. This is the narrowest evidence-backed next fix target.

### Hypothesis C - Backend Mapper Ordering

Classification: Contributing factor.

Evidence:

- `DogfoodRawEventStream` preserves queue insertion order, but insertion order is backend processing order.
- `GeminiLiveEventMapper._event()` assigns `ProviderEvent.sequence` after mapping, so sequence reflects mapper order, not provider order.
- No backend reorder buffer or stale rejection exists because source order is not preserved.

Conclusion: The mapper is not independently reordering events, but it currently has no data with which to preserve provider order or reject stale events.

### Hypothesis D - Normalizer Merge Algorithm

Classification: Confirmed insufficient for unordered clean fragments.

Evidence:

- `_merge_unknown_transcript_chunk` handles cumulative snapshots, duplicates/subsets, overlaps, likely revisions, and safe append.
- For non-overlapping text, it appends in the order received.
- Simulations show exact observed corruption prefixes from plausible clean fragments processed out of order.
- The algorithm has no source sequence, no timestamp, no stale partial guard, and no confidence signal to distinguish unordered fragments from legitimate next fragments.

Conclusion: Phase 12.4F fixed append-only duplication but not unordered fragment streams. The normalizer needs either ordered input or explicit stale/out-of-order rejection.

### Hypothesis E - Turn/Segment Identity Is Still Insufficient

Classification: Strongly supported; not fully proven for every corrupted instance.

Evidence:

- Google docs do not guarantee a stable response id in the server message schema used here.
- The mapper creates `_active_response_id` locally and reuses it until `turnComplete` or interruption clears it.
- If relay order lets a new output transcription arrive before the prior `turnComplete`, the new assistant response can share the previous response id and normalizer buffer.
- `SophiaEventNormalizer._agent_ended()` clears the active segment pointer, but it does not clear retained transcript text for a response id.
- The observed later answer begins with an earlier assistant sentence: `Yeah, loud and clear.`

Conclusion: Segment ids are useful for tool-adjacent continuation, but they are not enough without source-order preservation and robust response-boundary identity.

### Hypothesis F - Frontend Event Application Order

Classification: Weakly supported as an amplifier; not supported as the main cause.

Evidence:

- SSE publication and EventSource delivery are FIFO for the stream the backend emits.
- `voice-session-event-ingestion.ts` treats public `sophia.transcript.data.text` as an authoritative replacement snapshot, not an append instruction.
- `appendVoiceAssistantMessage` replaces the last voice assistant message for partial growth.
- There is no public transcript sequence or stale rejection in the Session layer, so a late older public snapshot would overwrite a newer one if the backend emitted it late.
- The exact corruption strings can already be produced before frontend application.

Conclusion: The frontend should eventually reject stale public transcript snapshots if sequence metadata is added, but current evidence points upstream.

### Hypothesis G - Mixed Causes

Classification: Confirmed.

Evidence-backed mix:

- Provider transcript semantics are underspecified.
- Browser relay is concurrent and sequence-free at the backend boundary.
- Backend mapper sequence is processing-order only.
- Normalizer appends unordered fragments in received order.
- Response/segment identity is locally inferred and can be polluted by late boundaries.

## Turn, Tool, And Interruption Matrix

No raw telemetry was available to correlate exact tool, interruption, or boundary events. The matrix therefore separates observed symptom evidence from code-level risk.

| Corruption instance | Tool-adjacent? | Interrupted? | New turn boundary? | Same transcript buffer likely? | Evidence |
|---|---:|---:|---:|---:|---|
| `Yeah, loud and clear. to lock You ready your game?` | Unknown | Unknown | Yes, after user `Hi, Sophia...` | Strongly likely | Old assistant sentence prefixes later answer; mapper response id is local and boundary order is not guaranteed. |
| `tell I can't It has you that.` | Unknown | Unknown | Yes, after user asks for recommendation | Possible | Exact phrase reproduced by current merge helper from unordered clean fragments. |
| `Focus on` | Unknown | Unknown | Yes, after user mantra | Possible | Could be an early partial or prematurely finalized fragment; no raw events available. |
| `Focus on staying When calm. pressure"I'm better...` | Unknown | Unknown | Yes, after user mantra | Possible | Exact class reproduced by current merge helper from unordered clean fragments. |

Tool-specific conclusion: Every companion turn may include `emit_artifact`, but the corrupted visible strings do not show pseudo-tool syntax. Tool adjacency is plausible because Gemini function calling is sequential and tool relays can delay provider event ingestion, but the available evidence does not prove tool adjacency as the primary trigger.

Interruption conclusion: Interruption is a known boundary hazard. The supplied excerpt does not include enough telemetry to tie the corrupted responses to `serverContent.interrupted` or `toolCallCancellation`.

## What Is Proven vs Unproven

Proven:

- The current code does not preserve provider receive order through the browser-to-backend relay.
- The backend does not receive a source sequence id for Gemini provider events.
- Mapper `sequence` is assigned after backend processing and cannot recover original provider order.
- Current auto merge appends non-overlapping fragments in received order.
- Current auto merge can reproduce the exact observed corruption prefixes when clean chunks are processed in the wrong order.
- Public frontend ingestion treats transcript text as replacement snapshots, not append deltas.

Strongly supported:

- Residual corruption is caused by mixed ordering and identity gaps upstream of the visible Session reducer.
- `Yeah, loud and clear.` leaking into a later answer indicates turn/response boundary contamination, likely made possible by late or out-of-order boundary processing.

Unproven because telemetry was unavailable:

- The exact provider payload text in Edward's live run.
- Whether Gemini itself emitted already-scrambled transcript strings.
- Absolute provider arrival, relay start, relay completion, backend acceptance, public emission, and Session ingestion timestamps for the corrupted run.
- Whether tool calls or interruptions occurred immediately before each corrupted public transcript.
- Whether any public SSE event arrived at the browser out of order relative to backend emission.

## Hypothesis Classification Table

| Hypothesis | Classification | Rationale |
|---|---|---|
| A. Provider transcript semantics are the main issue | Strongly supported as contributing uncertainty; insufficient evidence as main issue | Docs leave cumulative/delta/fragment semantics unspecified, but raw provider text was unavailable. |
| B. Relay completion order is the main issue | Confirmed code-level root-cause class; strongly supported for symptoms | Concurrent fire-and-forget relays plus no backend source sequence; current merge reproduces observed strings from out-of-order clean chunks. |
| C. Backend mapper order is the main issue | Contributing factor | Mapper preserves backend processing order, not provider order, because no source order is supplied. |
| D. Normalizer merge logic remains insufficient | Confirmed | It is order-sensitive for non-overlapping fragments and cannot detect stale/out-of-order chunks. |
| E. Segment/turn identity remains insufficient | Strongly supported | Response ids are local; late boundaries can reuse buffers; observed old reply prefix suggests contamination. |
| F. Frontend stale event application causes corruption | Weakly supported as amplifier; not supported as main cause | Frontend replaces snapshots and has no stale guard, but corruption can be produced upstream. |
| G. More than one cause exists | Confirmed | The failure needs ordering, merge, and identity concerns handled together. |

## Recommended Next Implementation Phase

Recommended title: **Phase 12.4G-B - Sequence-Safe Gemini Transcript Relay And Stale Snapshot Rejection**

Exact root-cause set to address:

1. Browser provider event order is not preserved across concurrent relay POSTs.
2. Backend mapper/normalizer apply transcript mutations in backend processing order.
3. Normalizer has no source sequence or stale guard for unordered fragments.
4. Locally inferred response/segment identity can be polluted by late boundary events.

Likely files to change:

- `frontend/src/app/lib/gemini-browser-live-websocket-dogfood.ts`
  - Attach monotonic provider receive sequence and provider receive timestamp to every relayed provider event.
  - Prefer a per-session relay queue for transcript/boundary-critical events, or preserve concurrent fetch while backend buffers by sequence.
  - Include correlation id and sequence in relay traces and backend request body.
- `voice/server.py`
  - Extend Gemini relay request schema to accept diagnostic/source-order metadata without changing provider raw event shape.
- `voice/realtime/gemini_browser_dogfood.py`
  - Record source sequence in diagnostics.
  - Apply transcript and turn-boundary events in provider sequence order, or reject/hold stale transcript-bearing events.
  - Avoid tool execution delaying publication of the original provider event when the event also carries transcript/boundary data.
- `voice/realtime/gemini_live.py`
  - Preserve source sequence on `ProviderEvent` values.
  - Strengthen response boundary metadata where provider lacks response ids.
- `voice/realtime/normalizer.py`
  - Add stale/out-of-order guards for transcript auto assembly keyed by response/segment/source sequence.
  - Treat late old segments after interruption/turnComplete as diagnostics rather than public transcript mutations.
- `frontend/src/app/hooks/useStreamVoiceSession.ts` and `voice-session-event-ingestion.ts`
  - If public transcript sequence metadata is emitted, ignore stale public assistant snapshots.

Tests to add:

- Browser helper: relay metadata includes monotonic provider sequence and correlation id for output transcription events.
- Browser helper: transcript/boundary relays cannot overtake each other, or backend receives enough sequence metadata to correct overtakes.
- Backend relay: provider events N, N+1, N+2 processed in HTTP order N+1, N, N+2 still produce public transcript order N, N+1, N+2.
- Normalizer: out-of-order fragment `to lock` before `You ready` does not produce `to lock You ready` publicly when sequence metadata proves staleness.
- Boundary: late `turnComplete` and late old output transcription cannot make a new assistant response share the previous transcript buffer.
- Frontend: stale public transcript snapshot with older sequence cannot replace newer text.

Manual smoke for 12.4G-B:

1. Run production Gemini candidate through `/session` with all Gemini gates enabled.
2. Capture a fresh telemetry export and verify every `outputTranscription` event has provider receive sequence, relay start, relay completion, backend accepted order, public emission order, and Session ingestion order.
3. Reproduce the prompt sequence from Edward's report:
   - `Hi, Sophia. Can you hear me clearly?`
   - `What do you recommend? What's one thing that I should focus on today?`
   - `What matters the most to me is just staying calm under pressure.`
   - `I'm better than this. I'm in control.`
4. Verify no public assistant transcript contains `to lock You ready`, `tell I can't It has you`, or `Focus on staying When calm. pressure`.
5. Interrupt during an assistant response and verify old output transcription events are rejected or isolated.
6. Trigger a tool-adjacent companion turn and verify pre-tool and post-tool transcript segments remain isolated.

## Why Implementation Was Deferred

The next fix should not be another broad transcript merge heuristic. The evidence points to missing end-to-end source order and stale identity guards. Implementing that safely requires a focused phase that changes relay metadata, backend ordering, normalizer stale handling, and frontend stale rejection together with tests. This investigation intentionally stopped before making those behavior changes.

## Validation Performed

Read-only commands/smokes performed during investigation:

- `git status --short -uall`
- `git branch --show-current`
- branch creation: `audit/gemini-transcript-corruption-forensics-phase-12-4g-a`
- searched for `new summary.zip` / `summary` / `telemetry` archives in workspace, Downloads, Desktop, Documents, Temp, and Copilot chat resource storage; no zip found.
- inspected the shared Session page capture; it had zero events.
- read official Google Live API documentation from official Google domains.
- inspected the browser Gemini helper, Session hook, frontend ingestion helper, backend relay manager, dogfood session pump, Gemini mapper, event contracts, normalizer, and SSE formatting.
- ran read-only local merge simulations showing current Phase 12.4F assembly can reproduce the observed corruption prefixes from clean chunks processed out of order.

No test fixtures or diagnostic instrumentation were added in this phase.