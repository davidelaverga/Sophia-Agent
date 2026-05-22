# Phase 12.4I - Gemini Turn Capture, Interruption, And Intent Continuity

Date: 2026-05-21
Status: investigation only; no prompt, VAD, runtime, Builder, or UI behavior fix applied
Source branch: `fix/gemini-live-spoken-turn-policy-phase-12-4h-c`
Audit branch: `audit/gemini-turn-capture-intent-continuity-phase-12-4i`
Runtime under investigation: Gemini Live production candidate

## Scope And Safety

This phase investigates why Gemini Live can answer a partial or stale intent during spoken sessions, especially after Phase 12.4H-C added the Gemini-specific spoken turn policy overlay.

This phase intentionally did not:

- Tune VAD, `realtimeInputConfig`, `automaticActivityDetection`, `activityHandling`, `turnCoverage`, `silenceDurationMs`, or generation parameters.
- Change the Gemini prompt overlay or canonical Sophia prompt files.
- Modify `skills/public/sophia/soul.md`.
- Modify Builder, storage, artifact library, or Builder UI behavior.
- Make Gemini the default runtime.
- Apply broad runtime fixes before evidence exists.

Work performed:

- Preserved the dirty Phase 1-12.4H-C worktree and created a dedicated audit branch.
- Re-checked official Gemini Live behavior around realtime input, automatic activity detection, interruptions, setup fields, and tool-call cancellation semantics.
- Searched for the requested telemetry export and confirmed it was not available in the accessible workspace locations.
- Checked the shared browser capture surface; the current capture had `eventCount: 0`.
- Audited Gemini setup, frontend browser WSS/audio handling, Session event ingestion, backend relay ordering, cancellation suppression, tool execution, and public event normalization.
- Wrote this docs-only root-cause classification and next-phase recommendation.

## Evidence Limitations

The exact telemetry archive requested for this phase was not available locally:

```text
sophia-voice-telemetry-report-2026-05-21T02-04-13-838Z.zip
```

The bad-turn strings were not present in the local repository telemetry. The only related telemetry found locally was the older `frontend/src/app/lib/sophia-voice-telemetry-report-2026-05-20T18-27-19-399Z.json`, which belongs to the previous over-continuation investigation.

The requested `docs/audits/gemini-relay-throughput-phase-12-4d.md` file is also absent in this worktree.

Because the exact report is missing, this audit cannot prove the precise provider event timestamps, provider receive sequence, raw `inputTranscription` text, `serverContent.interrupted` timing, `turnComplete`/`generationComplete` timing, or tool-call-cancellation state for the reported reflection failure. The timeline below is therefore a prompt-supplied logical reconstruction plus code-level evidence, not an event-id-accurate trace.

## Reported Bad Segment

Prompt-supplied sequence:

```text
User: Quick question before I go. Um reflect briefly on what I just said.
Sophia/Gemini: want me to focus on?
User: Focus on me, saying, "I'm in control."
```

The important shape is not simple over-continuation. The assistant response is short, but it appears to answer the wrong level of intent. Instead of reflecting on the immediately preceding idea, Gemini asks for a focus target. That means the failure class is likely turn capture or intent continuity, not only spoken response length.

The phrase has three properties that stress a Live native-audio session:

| Phrase feature | Why it matters |
|---|---|
| `Quick question before I go.` | Can be interpreted as a new meta-intent or closing transition. |
| `Um` | Creates a natural pause where automatic activity detection may split or advance turn state. |
| `what I just said` | Requires continuity with a prior utterance, not only the current speech segment. |

If Gemini's internal turn state did not retain or select the antecedent `I'm in control`, then `want me to focus on?` is a plausible clarification to a vague request. If the antecedent was present and correctly captured, the same reply is a failure to use immediate context.

## Official Gemini Live Findings

Official Live API facts relevant to this phase:

| Topic | Official behavior | Sophia impact |
|---|---|---|
| Stateful WebSocket | Live sessions maintain conversation state over the socket after initial `setup`. | Gemini may rely on provider-internal memory of prior speech, not Sophia backend reinjection. |
| Realtime input | `realtimeInput` is processed incrementally before full end-of-turn to reduce latency. | Gemini can begin shaping a reply from partial speech or an incomplete deictic request. |
| Automatic activity detection | Enabled by default if not configured. | Normal pauses, fillers, and hesitations are provider-decided turn boundary evidence. |
| Default activity handling | Unspecified `activityHandling` defaults to start-of-activity interruption behavior. | User speech can interrupt active model output and cancel pending generation/tool loops. |
| Default sensitivity | Unspecified start/end sensitivities use provider defaults. | Sophia currently has no code-level evidence that the defaults are right for pause-heavy reflection requests. |
| `audioStreamEnd` | Used with automatic activity detection when the microphone stream ends. | Sophia sends this on manual mute, but not for ordinary pauses or `um`. |
| `activityStart`/`activityEnd` | Valid only when automatic activity detection is disabled. | Do not add manual activity markers while leaving AAD enabled. |
| `toolCallCancellation` | Signals that the client should not return stale tool responses for cancelled ids. | Existing relay/browser code has explicit suppression paths; cancellation remains a thing to inspect per trace. |

## Current Gemini Setup Review

`voice/realtime/gemini_live.py::build_gemini_live_setup_config` currently builds setup with:

- `model`, defaulting to `models/gemini-3.1-flash-live-preview`.
- `generationConfig.responseModalities`, currently `AUDIO`.
- optional `generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName`.
- `systemInstruction.parts[0].text` with rendered Sophia realtime instructions plus the Phase 12.4H-C Gemini spoken turn overlay.
- existing Sophia tool declarations.
- `inputAudioTranscription: {}`.
- `outputAudioTranscription: {}`.

No current setup evidence of:

- `realtimeInputConfig`.
- `automaticActivityDetection` settings.
- `activityHandling`.
- `turnCoverage`.
- `startOfSpeechSensitivity`.
- `endOfSpeechSensitivity`.
- `silenceDurationMs`.
- `maxOutputTokens`.
- `temperature` or `topP`.

Implication: after 12.4H-C, Sophia gives Gemini a better spoken-output policy, but turn capture itself is still provider default. The code does not currently tell Gemini how tolerant to be of pauses such as `Um`, how much surrounding audio belongs to the same turn, or whether Sophia wants a custom interruption policy.

## Frontend Browser WSS And Audio Findings

The production Gemini browser connector in `frontend/src/app/lib/gemini-browser-live-websocket-dogfood.ts` has the expected ownership model:

- The browser opens the Gemini Live WebSocket, sends `setup`, waits for `setupComplete`, then starts microphone streaming.
- While unmuted, the microphone pipeline continuously sends `realtimeInput.audio` frames as PCM16 16 kHz.
- Manual mute disables the audio track and sends one `realtimeInput.audioStreamEnd` message.
- Unmute resumes audio frames and clears the local `audioStreamEnd` guard.
- Ordinary hesitations and pauses do not produce local turn-boundary markers; Gemini automatic activity detection decides.
- `serverContent.interrupted` stops local PCM playback immediately and emits a `gemini-interruption` capture event.
- Pure output audio remains browser-local and may not be relayed if the provider message has no public continuity fields.

Important observability caveat from earlier phases still applies: WebSocket `onmessage` launches async parsing with `void handleMessage(...)`, and provider receive metadata is assigned after parsing. That means browser-local audio scheduling still has an ordering caveat for Blob/ArrayBuffer parse completion. This is relevant to native audio correctness, but it does not by itself explain a short clarification such as `want me to focus on?`.

## Session Event Ingestion Findings

`frontend/src/app/hooks/useStreamVoiceSession.ts` consumes only normalized `sophia.*` public events for Session state:

- `sophia.user_transcript` updates the visible/reconciled user transcript and dedupes by `utterance_id`.
- `sophia.transcript` updates assistant partial/final text with source-sequence stale guards and paced partials for Gemini.
- `sophia.turn` moves the UI through `user_ended`, `agent_started`, and `agent_ended` phases.
- `onInterruption` resets assistant transcript pacing/stale guard, clears partial reply, flushes speaking state, and respects `userMicMutedRef` when choosing listening vs idle.
- Tool-loop telemetry separately counts received calls, responses, rejected executions, cancellations, artifact calls, and builder calls.

This layer is an observability and UI state consumer. It does not feed resolved `sophia.user_transcript` text back into the active Gemini WebSocket. Therefore, if Gemini loses or missegments the antecedent for `what I just said`, the frontend cannot repair that provider-internal context during the same Live turn.

One small UI-state caveat: the generic `sophia.turn` `agent_ended` path sets the stage back to `listening` without checking `userMicMutedRef`, while the interruption path does check it. Manual mute still gates audio and sends `audioStreamEnd`, so this is not a likely cause of the reported wrong-intent reply. It is a follow-up UI consistency note if muted-session presentation drifts.

## Backend Relay, Ordering, And Tool Findings

`voice/realtime/gemini_browser_dogfood.py` currently applies relayed provider events by source order before executing tools:

- Incoming browser provider events are validated and categorized.
- Source metadata drives contiguous ordering and buffering.
- Stale duplicate/lower-sequence messages are ignored with diagnostics.
- Provider events are pushed into the dogfood session before long-running tool execution.
- `toolCallCancellation` ids are recorded in a session cancellation set.
- Backend tool executions that finish after cancellation are recorded as `completed_after_cancellation` and do not produce client actions for stale send-back.

`voice/realtime/gemini_tool_loop.py` restricts Gemini tools to the approved existing Sophia surface:

- `emit_artifact` executes the existing backend artifact contract.
- Builder lifecycle tools go through a backend-owned LangGraph HTTP bridge and trusted session-scoped task ids.
- `gemini_tool_response_client_action()` sends only respondable, non-cancelled executions back to the browser.

`voice/realtime/normalizer.py` converts provider events into the public `sophia.*` boundary and has stale assistant transcript guards by response/segment/source sequence. `serverContent.inputTranscription` becomes public `sophia.user_transcript` plus `sophia.turn` `user_ended`.

Finding: current code already has targeted protections for the most likely stale relay/tool classes fixed in prior phases. Without the missing telemetry, there is no evidence that this bad reflection reply came from a stale tool response, cancelled tool continuation, Builder/storage UI, or public assistant transcript order regression.

## Timeline Reconstruction

This is the most precise timeline that can be stated without the missing telemetry export:

| Step | Logical event | Proven by local evidence? | Notes |
|---:|---|---|---|
| 1 | User previously said or implied the target idea: `I'm in control.` | Not locally provable | The follow-up clarification says this was the intended antecedent. |
| 2 | User then said: `Quick question before I go. Um reflect briefly on what I just said.` | Prompt-supplied | Contains a pause/filler and a deictic reference. |
| 3 | Gemini may have segmented at or around the filler/transition, or may have selected only the current request without the prior antecedent. | Plausible, not proven | Current setup leaves AAD and turn coverage at provider defaults. |
| 4 | Gemini replied: `want me to focus on?` | Prompt-supplied | This is a clarification to missing focus/context, not an overlong spoken turn. |
| 5 | User clarified: `Focus on me, saying, "I'm in control."` | Prompt-supplied | Confirms the assistant did not use the user's intended antecedent. |

What cannot be proven from available files:

- Whether Gemini emitted one or more `serverContent.inputTranscription` messages for the reflection request.
- Whether the previous `I'm in control` utterance was captured as `inputTranscription` at all.
- Whether `serverContent.interrupted` fired because the user spoke over an active assistant turn.
- Whether `turnComplete`/`generationComplete` occurred before or after the reflection request stabilized.
- Whether a tool call or artifact call was pending and cancelled in that exact segment.
- Whether the visible Session state was ahead of, behind, or mismatched with provider-internal context.

## Candidate Causes

| Candidate | Classification | Rationale |
|---|---|---|
| Prompt overlay failure | Possible but not leading | H-C constrains spoken output length/intent, but it cannot recover an antecedent that Gemini did not capture or select. The bad reply is concise, not a stacked response. |
| Default Gemini AAD / turn capture | Leading suspect | Current setup does not configure AAD, activity handling, turn coverage, or silence duration. The utterance contains `Um` and depends on prior context. |
| Incremental realtime input partial intent | Leading suspect | Gemini can process realtime audio before the user turn is fully stabilized, so a transition like `Quick question before I go` can bias early response planning. |
| Lost antecedent / weak intent continuity | Strong contributor | `what I just said` requires the prior utterance. Sophia does not currently mirror public user transcripts back into the active Gemini session as a continuity buffer. |
| Interruption cleanup | Unknown, inspect per trace | Code flushes playback and resets UI state on `serverContent.interrupted`, but the missing report prevents classification. |
| Tool cancellation or stale toolResponse | Lower probability | Current code records cancellations and suppresses stale tool responses; no event evidence indicates a tool cause for this reported segment. |
| Public transcript ordering | Lower probability | 12.4G-B source-order protections and frontend stale guards target this class. The reported issue is a wrong clarification, not word-order corruption. |
| Builder/storage UI | Ruled out for this phase | The symptom is conversational intent selection, not Builder state or artifact rendering. |
| Gemini default runtime selection | Ruled out | No code path was changed here to make Gemini default. |

## Root Cause Assessment

Primary root-cause classification:

Gemini Live turn capture and intent continuity are still provider-default in the production candidate. The Phase 12.4H-C prompt overlay reduces spoken over-continuation, but Sophia has not yet established an evidence-backed turn-capture policy for pause-heavy, deictic, or interruption-adjacent utterances.

Most likely failure mode:

Gemini answered from a partial or underspecified current intent (`reflect briefly on what I just said`) without reliably binding `what I just said` to the intended prior utterance (`I'm in control`). Default automatic activity detection and incremental realtime input make that plausible, especially around a filler pause and session-closing phrase.

Secondary architectural gap:

The public `sophia.user_transcript` stream proves what Sophia observed after Gemini emits input transcription, but it is not currently a provider-context repair mechanism. The active Gemini session relies on provider-internal conversational continuity. If that continuity is wrong for an antecedent reference, frontend/backend observability cannot fix the current response unless a later phase adds an explicit evidence-backed strategy.

Confidence:

- High that this phase should not change Builder/storage UI or Gemini defaulting.
- High that broad prompt changes are premature.
- High that blind VAD tuning is premature.
- Medium-high that the next evidence should focus on Gemini turn capture, AAD defaults, interruption boundaries, and antecedent continuity.
- Low that this can be conclusively classified without the missing turn-level telemetry export.

## Recommended Next Phase

Recommended next phase: Phase 12.4J - Gemini Turn Capture Evidence Harness.

Do not tune VAD first. Add or verify a compact turn-level diagnostic bundle that can answer, for each bad turn:

- Ordered provider receive sequence and relay sequence.
- Provider categories for `inputTranscription`, `outputTranscription`, `modelTurnAudio`, interruption, turn boundary, tool call, and tool cancellation.
- Bounded `inputTranscription.text` previews and public `sophia.user_transcript` payloads.
- Bounded `outputTranscription.text` previews and public `sophia.transcript` payloads.
- `serverContent.interrupted`, `generationComplete`, and `turnComplete` flags.
- Tool call ids, cancellation ids, and whether any tool response was suppressed as stale.
- Browser mic state transitions, manual mute/unmute, and local `audioStreamEnd` sends.
- Session UI stage transitions around `user_ended`, `agent_started`, `agent_ended`, and `gemini-interruption`.
- A capture marker for the active manual scenario so exported telemetry can be found and compared.

Manual smoke matrix for that phase:

| Scenario | Purpose |
|---|---|
| `I'm in control.` pause 400 ms, then `Quick question before I go. Um reflect briefly on what I just said.` | Test short pause antecedent binding. |
| Same, pause 800 ms | Test likely default silence boundary. |
| Same, pause 1200 ms | Test split-turn behavior. |
| User asks reflection while assistant is still speaking | Test `serverContent.interrupted` and tool cancellation. |
| User mutes after antecedent, unmutes, then asks reflection | Test `audioStreamEnd` and continuity after mic boundary. |
| User says `Reflect briefly on "I'm in control"` in one utterance | Control case where antecedent is local to the request. |

Decision table after evidence:

| Evidence | Next action |
|---|---|
| Previous utterance missing from `inputTranscription` | Investigate microphone/capture/relay and provider transcription health before prompt work. |
| Previous utterance captured, but reflection request split at pause/filler | Consider a narrow `realtimeInputConfig` experiment with documented AAD fields and an A/B smoke matrix. |
| All user transcripts correct and contiguous, but Gemini still asks for focus | Re-open prompt/intent-continuity policy with a specific antecedent-reference rule. |
| `serverContent.interrupted` or `toolCallCancellation` appears before the wrong reply | Investigate interruption/tool cancellation sequencing for that trace only. |
| Public `sophia.*` order diverges from provider order | Fix the relay/normalizer/frontend boundary, not VAD. |

## Contract Clarification

Current contract clarification from this phase:

Gemini production sessions currently do not set `realtimeInputConfig`. Turn capture, activity detection, pause tolerance, interruption-on-speech behavior, and turn coverage therefore use Gemini Live defaults. Any future change to those fields must be evidence-backed by turn-level telemetry, not inferred from a single bad reply.

## Validation

This is a docs-only phase. Validation commands run:

```powershell
git diff --check
git status --short -uall
```

Observed results:

- `git diff --check`: passed, with line-ending warnings only and no whitespace errors reported.
- `git branch --show-current`: `audit/gemini-turn-capture-intent-continuity-phase-12-4i`.
- `git status --short -uall`: worktree remains broadly dirty with 168 modified, deleted, or untracked files from the existing multi-phase migration state plus this docs-only audit.
