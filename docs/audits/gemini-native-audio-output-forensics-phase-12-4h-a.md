# Phase 12.4H-A - Gemini Native Audio Output Forensics

Date: 2026-05-20
Status: investigation plus bounded diagnostic instrumentation
Source branch: `fix/gemini-sequence-safe-transcript-relay-phase-12-4g-b`
Investigation branch: `audit/gemini-native-audio-forensics-phase-12-4h-a`
Runtime under investigation: Gemini Live production candidate

## Scope And Safety

This phase investigated the remaining Gemini production audio-output defects after Phase 12.4G-B. It did not apply an audio playback behavior fix, did not change prompt files, did not change provider setup, and did not modify `soul.md` or `lead_agent/`.

Allowed work performed:

- Verified branch safety before edits.
- Read the required prior phase documents and architecture notes.
- Re-checked current official Google Live API documentation.
- Inspected the full Gemini production audio path from browser WSS receive through PCM scheduling and backend relay lifecycle.
- Added bounded, non-raw audio chunk diagnostics so the next live run can prove provider order vs playback order.
- Updated docs and focused frontend coverage for the diagnostic ledger.

Branch safety:

- Initial branch was `fix/gemini-sequence-safe-transcript-relay-phase-12-4g-b`, not `main`.
- Created and switched to `audit/gemini-native-audio-forensics-phase-12-4h-a` before edits.
- `main` was not checked out, committed to, pushed to, or modified directly.
- The worktree was already dirty with prior Phase 1-12.4G-B migration work; this phase preserved that state and made only the scoped changes listed below.

## Observed Live Symptoms

Fresh symptom supplied by Edward after 12.4G-B:

User:

```text
Sophia, what do you recommend? What's one thing that I should focus on today?
```

Sophia visibly and audibly answered like two clarification replies were joined:

```text
To give you the best recommendation, what are you playing today? And what's the one thing want to get out of this session? Not winning, something can control. That really depends on what you're getting into today. Is it work, gaming, else? Tell me a little bit more about what you've got planned.
```

Edward also observed cases where the transcript and audio both sounded out of order. This means the visible transcript is not the only corrupt surface; spoken Gemini native audio can carry the same oddity.

## Evidence Limitation And New Report

At the start of this phase, no raw bad-turn telemetry was available locally.

What was checked:

- Repository `logs/` and tracked docs for the new prompt text and known corrupted phrases.
- Workspace files matching telemetry or summary names.
- The shared `/session` browser page. It was signed out and `window.__sophiaCapture.export()` reported `eventCount: 0`.

After the initial audit was written, Edward added `frontend/src/app/lib/sophia-voice-telemetry-report-2026-05-20T18-27-19-399Z.json`, which captures a double-reply turn:

- User transcript: `Hi Sophia, can you hear me clearly?`
- Final public assistant transcript: `Yeah, I hear you great. What's on your mind? You getting ready to jump into something? Loud and clear. up? Ready for a session?`
- Gemini provider event count: 132.
- `serverContent` count: 60.
- `outputTranscription` count: 18.
- `modelTurnAudio` count: 54.
- `toolCall`, `toolCallCancellation`, interruption, and playback-flush counts: 0.
- `gemini-output-audio-chunk` diagnostics: 0, because the capture was produced before the bounded chunk ledger from this phase was available in the running app.

The report changes the forensic classification. It proves the malformed text was already present at the public `sophia.transcript` boundary and that the transcript-bearing provider receive sequences were monotonic: 10, 14, 16, 20, 22, 25, 29, 31, 33, 36, 38, 42, 46, 50, 52, 55, 58, 60. Each of those events also carried one native audio chunk. That rules out the Phase 12.4G-B class of relayed stale/out-of-order transcript application for this capture.

The report still cannot prove browser PCM chunk scheduling order because it lacks the new `gemini-output-audio-chunk` hash/schedule diagnostics. It also could not prove whether the raw provider `outputTranscription.text` fragment at the `Loud and clear. up?` transition was already `up?`, `What's up?`, or another revised fragment, because provider-event telemetry only captured booleans before this addendum. This phase therefore also adds bounded provider transcription text previews to future `gemini-provider-event-correlation` payloads.

## Official Google Grounding

Official sources checked:

- `https://ai.google.dev/gemini-api/docs/live`
- `https://ai.google.dev/api/live`
- `https://ai.google.dev/gemini-api/docs/live-api/capabilities`
- `https://ai.google.dev/gemini-api/docs/live-api/best-practices`
- `https://ai.google.dev/gemini-api/docs/live-api/tools`
- `https://ai.google.dev/gemini-api/docs/live-api/session-management`

Verified facts that matter for this investigation:

| Topic | Official fact | Impact on Sophia |
|---|---|---|
| Server content cadence | `BidiGenerateContentServerContent` is generated as quickly as possible, not in realtime. Clients may buffer and play it in realtime. | Browser scheduling is responsible for human-paced playback order. |
| Audio format | Native audio output is raw PCM16 little-endian at 24 kHz. | Browser must decode PCM, not use compressed media decode APIs. |
| Interruption | `serverContent.interrupted` means current model generation was interrupted; realtime playback clients should stop and empty the playback queue. Interrupted turns go through `interrupted` then `turnComplete`, without `generationComplete`. | Queue flushing is required and already exists locally, but needs chunk-level proof. |
| Generation vs playback | `generationComplete` and `turnComplete` can be separated because playback completion can lag generation completion. | `generationComplete` is not proof the user has heard the whole queued response. |
| Output transcription ordering | `outputTranscription` is independent and has no guaranteed ordering relative to `serverContent`. | Transcript fixes cannot prove audio correctness. |
| Realtime input | `send_realtime_input` is optimized for responsiveness at the expense of deterministic ordering; data can be processed incrementally before end of turn to optimize fast starts. | Gemini may start a reply from partial speech, then continue after more user context. |
| VAD | Too-low silence thresholds split one utterance into fragments and degrade response quality. Automatic VAD is default and configurable. | A single spoken user request can be split into multiple provider turns if activity detection is too aggressive. |
| Function calling | Live API function calling is manual. Gemini 3.1 Flash Live is sequential only; the model waits for tool response. | Duplicate continuation around tools is possible as pre-tool plus post-tool provider speech, but stale send-back has guards after 12.4B. |

Google docs do not document duplicate or revised native-audio `modelTurn.inlineData` semantics beyond saying the model's audio responses are received as chunks. They do not provide a response id for pure audio chunks in the server schema used here.

## Audio Path Flow Map

Current Gemini production audio flow:

```text
Gemini Live WebSocket message
  -> waitForGeminiSetupComplete().websocket.onmessage
  -> async handleMessage(messageEvent)
  -> parseWebSocketMessage(messageEvent.data)
  -> buildGeminiProviderReceiveMetadata(parsed, providerReceiveSequence += 1)
  -> local telemetry and tool ledger
  -> if serverContent.interrupted: stop playback queue
  -> relay only continuity-critical provider events to backend
  -> if not interrupted: play local output audio chunks
  -> createGeminiOutputAudioPlaybackController.playEvent()
  -> read serverContent.modelTurn.parts[].inlineData audio/pcm
  -> base64ToBytes()
  -> pcm16BytesToFloat32()
  -> audioContext.createBuffer(1, samples.length, 24000)
  -> AudioBufferSourceNode.start(max(audioContext.currentTime, nextPlaybackTime))
  -> nextPlaybackTime = startAt + duration
```

Backend/public transcript and lifecycle flow for relayed events:

```text
Browser relay POST
  -> voice/realtime/gemini_browser_dogfood.py
  -> source-order buffer by provider_relay_sequence
  -> RealtimeDogfoodSession.raw_events
  -> GeminiLiveEventMapper
  -> SophiaEventNormalizer
  -> public sophia.* SSE
  -> useStreamVoiceSession
```

Important split:

- Pure `modelTurnAudio` messages are classified as `skip` / `local_only` and are played in the browser.
- Phase 12.4G-B sequence metadata protects relayed transcript/lifecycle events, not browser-local PCM playback.
- Before this phase, the exported telemetry had counts for output audio events, but no audio chunk hash, byte length, schedule time, duplicate count, or provider sequence vs playback schedule ledger.

## Code Evidence By Layer

### Browser WSS receive

`waitForGeminiSetupComplete` assigns `websocket.onmessage = (messageEvent) => { void handleMessage(messageEvent).catch(...) }`. The handler is async, but onmessage calls are not serialized behind a promise chain.

`providerReceiveSequence` is assigned after `parseWebSocketMessage()` completes. For ordinary string JSON messages this is effectively callback order. For Blob or ArrayBuffer messages, parsing awaits async browser APIs, so a later message can finish parsing first and receive the lower sequence number. That is a confirmed code-level ordering risk.

### PCM decode and scheduling

`createGeminiOutputAudioPlaybackController` does not use async audio decoding. It synchronously converts base64 PCM16 to Float32, creates a Web Audio buffer, creates a source node, and calls `source.start(startAt)`.

`nextPlaybackTime` is updated immediately after `source.start(startAt)`. Within one parsed event and within a single synchronous call stack, chunks are scheduled in array order.

The scheduler therefore is not vulnerable to `decodeAudioData`-style async decode reordering. Its ordering risk comes from the upstream async message parse/handler boundary and from the absence of an audio-specific source-order queue.

### Queue flush

On `serverContent.interrupted`, the connector calls `outputAudioPlayer.stop()`. The playback controller tracks scheduled sources in `activeSources`; `stop()` calls `source.stop()`, disconnects each source, clears the set, and resets `nextPlaybackTime` to 0.

This is the right shape for Google's interruption guidance. What was missing before this phase was evidence of how many scheduled nodes were stopped and whether future chunks from an older parse path were scheduled after the flush.

### Relay and backend lifecycle

Pure audio is not relayed. Transcript and boundary events are now ordered by relay sequence after Phase 12.4G-B. Backend `GeminiLiveEventMapper` can mark `assistant_audio_started` and `assistant_audio_ended` from relayed `serverContent`, but pure audio chunks usually do not reach the mapper, so backend response lifecycle is not an authoritative audio-chunk ledger.

### Tool lifecycle

Tool-call stale send-back is guarded in the browser ledger. Backend tool execution records `completed_after_cancellation` and avoids returning stale client actions when cancellation is known. This reduces, but does not eliminate, the possibility that Gemini legitimately emits pre-tool speech and post-tool continuation as one audible answer.

## Diagnostic Instrumentation Added

This phase added a bounded, non-raw chunk ledger for the next live capture.

For each scheduled Gemini output audio chunk, the connector can now emit `gemini-output-audio-chunk` capture events containing:

- `providerReceiveSequence`
- `providerRelaySequence` when present
- `providerReceivedAt`
- `relayCorrelationId`
- `chunkIndex` and `chunksInEvent`
- compact FNV-style `chunkHash` over the base64 payload
- estimated decoded byte length and base64 length
- duplicate ordinal for repeated chunk hashes in the current connection
- decode start and completion timestamps
- `AudioContext.currentTime`
- scheduled start time
- duration seconds
- `nextPlaybackTime` before and after scheduling
- active source count before and after scheduling
- whether scheduling happened

Rules preserved:

- No raw audio is exported.
- Diagnostics are capped to `160` chunks per connector run.
- Playback behavior is unchanged.
- Existing event-level `gemini-output-audio-started` telemetry remains intact.
- Provider-event telemetry now includes bounded `inputTranscriptionTextPreview` and `outputTranscriptionTextPreview` fields so future captures can distinguish raw Gemini transcript fragments from normalizer assembly artifacts.

Focused frontend coverage confirms duplicate chunk hashes and schedule timings are captured while only the bounded first diagnostics are emitted.

## Bad-Turn Timeline Reconstruction

The newly supplied report reconstructs the public transcript timeline and provider event categories for one double-reply turn, but not raw PCM scheduling or raw provider transcript fragments.

The new diagnostics define the required timeline for the next reproduction:

| Field | Why it matters |
|---|---|
| User prompt and `sophia.user_transcript` | Anchors the response to one user turn. |
| Provider receive sequence and timestamp | Proves source order at browser receive time. |
| `modelTurnAudio` chunk hash/byte length | Detects duplicate provider chunks without storing audio. |
| Decode start/completion | Proves whether decode latency can reorder scheduling. |
| Scheduled start time and duration | Proves playback order and overlap. |
| `nextPlaybackTime` before/after | Proves sequential queue behavior. |
| Interruption/generation/turn markers | Proves whether old queued audio should have been flushed. |
| Output transcription fragments | Compares the spoken content surface with provider text. |
| Tool call/response/cancellation ledger | Separates provider pre-tool/post-tool continuation from stale send-back. |

Code-derived timeline risk for a Blob/ArrayBuffer provider path:

| Step | Provider callback order | Current handling risk | Audio effect |
|---|---:|---|---|
| A | message 1 contains audio chunk A | `parseWebSocketMessage` awaits Blob text/arrayBuffer | Handler can yield. |
| B | message 2 contains audio chunk B | message 2 parse can complete first | B receives lower local sequence and schedules first. |
| C | message 1 parse resumes | A schedules after B | Spoken order becomes B, A. |

For string JSON messages, this specific parse-completion inversion is unlikely because parse and scheduling are synchronous inside the callback. The investigation did not prove which browser data type Gemini used in Edward's bad run.

## Failure Class Analysis

### Class 1 - Provider duplicate generation

Classification: strongly plausible for the two-clarification-replies symptom, not confirmed.

Reasoning:

- The spoken text sounds like two semantically complete alternative clarifications.
- Browser PCM scheduling cannot invent new semantic content; it can only reorder, overlap, duplicate, or omit chunks it received.
- Gemini realtime input is documented as incremental and optimized for fast starts, so an early partial-response plus later fuller continuation is a plausible provider/lifecycle behavior.
- No live audio chunk or transcription timeline exists yet to prove both replies were emitted cleanly by Gemini.

### Class 2 - Playback ordering bug

Classification: confirmed code-level risk, not confirmed live cause.

Reasoning:

- PCM decode/schedule itself is synchronous and sequential per parsed event.
- `onmessage` processing is not serialized, and receive sequence is assigned after async parse.
- Pure audio does not have a provider-order queue equivalent to the Phase 12.4G-B transcript relay queue.
- If Gemini messages arrive as Blob/ArrayBuffer, later chunks can theoretically schedule before earlier chunks.

### Class 3 - Playback duplication or queue contamination

Classification: weakly supported as current live cause; instrumentation now covers it.

Reasoning:

- `activeSources` tracks scheduled source nodes and interruption stop clears them.
- `nextPlaybackTime` is reset on stop and disconnect cleanup stops playback.
- Before this phase, there was no chunk hash duplicate ledger, so duplicate provider chunks or accidental double scheduling could not be disproved.
- No code path was found that intentionally replays old audio chunks on reconnect/resume.

## Primary Questions

### Q1 - Is Gemini emitting multiple audio response segments for one user turn?

Insufficient direct evidence for the reported live turn. The current code can count output-audio events and, after this phase, chunk hashes/schedules, but no prior bad-turn ledger exists.

The two-reply symptom is more consistent with provider/lifecycle output than PCM duplication because the two halves are semantically distinct. A chunk replay usually repeats the same waveform or overlaps speech; it does not create a second coherent clarification unless that clarification was already in provider audio.

### Q2 - Can the browser audio scheduler play chunks out of provider receive order?

Yes, in one specific integration path: message handlers are async and not serialized, and sequence is assigned after parse. If provider messages require async parsing, playback can follow parse-completion order instead of callback receive order.

Within a parsed event, and for ordinary string JSON messages, scheduling is source-order-safe because decode and scheduling are synchronous.

### Q3 - Can the playback queue duplicate or overlap chunks?

Overlap from the old Phase 8B immediate-start bug is not present: chunks schedule at `max(currentTime, nextPlaybackTime)` and `nextPlaybackTime` advances by duration.

Duplicate scheduling was not previously observable. The new chunk hash ledger will identify repeated provider chunks or repeated local scheduling. There is no current dedupe suppression, by design, because this phase is diagnostic only.

### Q4 - Can provider turn lifecycle cause duplicate assistant replies?

Yes. Google documents realtime input as incremental before end of turn, and Gemini native audio can start quickly. If VAD splits one user utterance or Gemini begins responding before the full user intent lands, two apparent continuations can arrive in one audible exchange.

Tool boundaries can also produce pre-tool and post-tool speech in one user-visible answer. After 12.4B, stale cancelled tool responses are guarded, so the main remaining lifecycle risk is legitimate provider continuation and turn-boundary segmentation, not obvious stale send-back.

### Q5 - Did 12.4G-B fix transcript ordering while leaving audio ordering independent?

Yes. Phase 12.4G-B added source sequence, ordered relay, backend buffering, normalizer stale guards, and frontend stale rejection for relayed transcript/lifecycle events. Pure PCM audio remains browser-local and previously had no equivalent chunk-level ordering ledger.

## Audio vs Transcript Comparison Matrix

| Layer | Evidence of duplicate reply? | Evidence of out-of-order wording? | Current classification |
|---|---|---|---|
| Provider audio receive order | Unknown before new diagnostics | Unknown before new diagnostics | Insufficient evidence |
| Playback scheduled order | No prior chunk ledger; code schedules parsed chunks sequentially | Confirmed theoretical async parse risk | Strongly supported integration risk |
| Provider output transcription | Edward reports visible transcript mirrored audio in some cases | 12.4G-A/G-B addressed relayed text order | Improved, but independent of audio |
| Public `sophia.transcript` | 12.4G-B guards stale relayed snapshots | Sequence-safe after 12.4G-B for relayed text | Not proof of audio correctness |
| UI transcript | Reflects public transcript snapshots | Can still differ from audio because audio is local-only | Secondary surface |

## Tool, Lifecycle, And Turn Boundary Findings

| Question | Finding |
|---|---|
| Did the captured report turn require a tool call? | No. The report has `toolCallCount: 0`, `toolCallCancellation: 0`, `artifactToolCallCount: 0`, and an empty tool ledger. Tool lifecycle is ruled out for this capture. |
| Could `emit_artifact` be involved? | Not in the captured report. The missing artifact tool call is a separate Gemini companion contract miss, not the double-reply cause in this turn. |
| Could builder tools be involved? | No for the captured report. `builderToolCallCount` and builder events are both 0. |
| Could duplicate tool responses cause a second continuation? | No for the captured report. There were no tool calls or cancellations. |
| Could automatic VAD split the user prompt? | Strongly plausible. Official docs warn realtime input prioritizes responsiveness and VAD thresholds can fragment speech turns. |
| Could old and new audio overlap across turns? | Not supported by the report. Interruption and playback flush counts were 0. Stale async post-flush scheduling remains a code risk for other turns. |

## Hypothesis Classification

| Hypothesis | Classification | Rationale |
|---|---|---|
| Gemini generated duplicate semantic replies | Strongly supported for the captured report, not fully raw-confirmed | The malformed double-reply text is already in public `sophia.transcript`; 18 monotonic provider output-transcription events each also carried audio. Raw provider text previews were not captured yet. |
| Gemini generated intrinsically out-of-order audio | Insufficient evidence | Audio was bad to the ear, but no provider audio capture exists. |
| Browser scheduler reorders chunks | Strongly supported code-level risk, not supported as the captured transcript cause | Async un-serialized message parsing can schedule later messages first; pure audio lacks an order queue. The captured transcript-bearing source sequences were monotonic. |
| Browser scheduler duplicates chunks | Insufficient evidence | No old hash ledger; new diagnostics now expose this. |
| Interrupted or old queue leaks across turns | Not supported for the captured report; weak code risk elsewhere | The report has no interruption or flush. `activeSources.stop()` and `nextPlaybackTime=0` are present; stale async post-flush scheduling remains possible in other turns. |
| Tool-response lifecycle creates duplicate continuation | Ruled out for the captured report | The report has no tool calls, tool responses, or cancellations. |
| Early incremental response contributes | Strongly supported | Official docs explicitly say realtime input is processed incrementally for fast response start. |
| Mixed cause | Strongly supported overall, narrower for the captured report | Provider/lifecycle duplicate candidates and local audio-order blind spots can coexist; this report specifically points upstream of frontend rendering and away from stale relay order. |

## Verdict

The newly supplied report narrows the captured double-reply turn substantially. It rules out tool lifecycle, interruption/flush leakage, and Phase 12.4G-B-style stale/out-of-order transcript relay for this capture. The public transcript corruption is upstream of frontend rendering and is applied from monotonic output-transcription-bearing provider events.

Narrowed verdict by symptom:

- Duplicated semantic reply candidate: strongly likely provider or turn-lifecycle generated for the captured report. The provider sent 18 monotonic output-transcription events, and each text-bearing event also carried one audio chunk. Confidence: medium-high.
- Transcript assembly artifact at `Loud and clear. up?`: still unresolved between raw provider fragment and normalizer assembly because the report did not include raw `outputTranscription.text` previews. Future telemetry now captures those previews.
- Out-of-order spoken words: integration-generated playback ordering remains a serious code risk in general. This report does not prove it for the captured turn because it lacks chunk-level scheduling diagnostics.
- Repeated audio content: not proven. Prior telemetry could not detect duplicate chunks; new diagnostics can.
- Queue contamination after interruption: ruled out for the captured report because interruption and flush counts were 0.

Overall classification: captured report points primarily to provider/turn-lifecycle duplicate output plus a remaining raw-transcript-vs-normalizer-assembly gap. The audio source-order-safe scheduler remains worthwhile, but it is no longer the leading explanation for this specific report.

## Recommended Next Implementation Phase

Recommended title: **Phase 12.4H-B - Gemini Turn Continuity And Native Audio Evidence Closure**

Exact root-cause set to address:

1. Gemini can produce a second semantic opener/continuation in one native-audio response even when the user turn is simple and no tools are involved.
2. Provider telemetry previously did not include raw `outputTranscription.text` previews, leaving a gap between raw provider fragments and normalizer assembly.
3. Provider receive sequence is assigned after async parse, not at WebSocket callback receipt.
4. WebSocket message handling is not serialized, so async parse completion can reorder local audio scheduling.
5. Pure audio chunks do not have a source-order queue equivalent to relayed transcript events.
6. Playback has no explicit generation id to ignore stale decode/schedule work after interruption flush.
7. Duplicate provider chunks are observable after this phase, but not yet suppressed or classified in UI.

Files to change:

- `frontend/src/app/lib/gemini-browser-live-websocket-dogfood.ts`
  - Assign provider receive sequence and received timestamp synchronously at `onmessage` callback entry.
  - Serialize parse and local playback scheduling through a provider-message lane.
  - Add an audio playback generation id that increments on interruption/stop and prevents stale post-flush scheduling.
  - Keep chunk hash diagnostics and add warnings when the same chunk hash schedules twice in one response window.
  - Preserve bounded provider transcription text previews in correlation telemetry.
- `frontend/src/app/hooks/useStreamVoiceSession.ts`
  - Preserve the chunk ledger in current-run capture and summarize duplicate/reorder warnings in Gemini telemetry.
- `frontend/src/__tests__/gemini-browser-live-websocket-dogfood.test.ts`
  - Add async parse fixture: messages A, B, C arrive in order but resolve B, A, C; playback must schedule A, B, C.
  - Add interruption fixture: scheduled and pending chunks from generation N cannot schedule after flush generation N+1.
  - Add duplicate fixture: identical chunk hash is diagnosed with duplicate ordinal and warning.
  - Add two-burst fixture: separate `modelTurnAudio` bursts around `generationComplete` or `turnComplete` remain distinct in diagnostics.

Manual smoke validation:

1. Start Gemini production candidate through normal `/session` gates.
2. Enable current-run capture.
3. Reproduce Edward's exact prompt: `Sophia, what do you recommend? What's one thing that I should focus on today?`
4. Export telemetry and inspect `gemini-output-audio-chunk` events for provider sequence, chunk hash, scheduled start, duration, and duplicate ordinal.
5. Compare chunk order with `gemini-provider-event-correlation`, output transcription snapshots, public `sophia.transcript`, and visible UI text.
6. Repeat with a deliberate interruption and verify all post-flush scheduled chunks belong to the new playback generation.
7. If duplicate semantic replies appear with monotonic chunk scheduling and matching output transcription, classify the issue as provider/turn-lifecycle and move to VAD/turn-boundary control rather than PCM scheduler work.

## Files Changed In This Phase

- `frontend/src/app/lib/gemini-browser-live-websocket-dogfood.ts`
  - Added `GeminiOutputAudioChunkDiagnostic` and bounded chunk diagnostics.
  - Added compact audio chunk hash and byte-length helpers.
  - Preserved existing scheduling behavior.
- `frontend/src/app/hooks/useStreamVoiceSession.ts`
  - Captures `gemini-output-audio-chunk` events for current-run telemetry exports.
- `frontend/src/__tests__/gemini-browser-live-websocket-dogfood.test.ts`
  - Added fixture coverage for non-raw chunk diagnostics and bounded emission.
- `docs/audits/gemini-native-audio-output-forensics-phase-12-4h-a.md`
  - This audit.
- `COMPOUND_LOG.md`, `docs/common-pitfalls.md`, and `docs/architecture/sophia-realtime-runtime-contract.md`
  - Updated with the investigation learning.

## What Remains Unproven

- Whether Gemini emitted the exact two clarification replies as clean provider audio.
- Whether the bad run used string messages or async Blob/ArrayBuffer messages.
- Whether playback scheduled chunks out of provider callback order in the live browser.
- Whether duplicate chunk hashes occur during bad turns.
- Whether automatic VAD split Edward's prompt before Gemini had the full user intent.
- Whether tool boundaries were present in the specific duplicated-reply turn.

## Final Assessment

Phase 12.4G-B made the text path sequence-safe, but it did not make native audio sequence-safe. The remaining audio defects must be debugged at chunk granularity.

The current best reading is mixed: duplicated semantic replies look more provider/turn-lifecycle generated, while out-of-order spoken words remain plausibly integration-generated because the browser schedules audio after async message parsing without an audio-specific source-order lane. The new diagnostic ledger is the minimum evidence needed to turn the next live reproduction from subjective audio weirdness into a provider-vs-playback timeline.