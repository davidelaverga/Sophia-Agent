# Phase 12.4H-B - Gemini Over-Continuation, Duplicate Intent, And Turn Policy Forensics

Date: 2026-05-21
Status: investigation only; no prompt or runtime behavior fix applied
Source branch: `audit/gemini-over-continuation-turn-policy-phase-12-4h-b`
Runtime under investigation: Gemini Live production candidate

## Scope And Safety

This audit investigates why Gemini sometimes produces assistant responses that feel like multiple replies or multiple conversational intents stacked together in one spoken turn.

This phase intentionally did not:

- Edit Sophia prompt files.
- Edit Gemini setup/runtime behavior.
- Add frontend suppression or transcript filtering.
- Modify `skills/public/sophia/soul.md`.
- Modify `lead_agent/`.
- Treat the issue as greeting-only.

Work performed:

- Verified branch safety and current dirty worktree state.
- Re-read the current bad-run telemetry export.
- Re-checked official Gemini Live behavior that affects realtime turn formation.
- Audited Gemini setup, prompt assembly, tool declarations, transcript ingestion, frontend greeting/session initialization, and relevant Sophia prompt sources.
- Wrote this root-cause report and recommended the next implementation phase.

Evidence limitation:

- The requested `docs/audits/gemini-relay-throughput-phase-12-4d.md` file is not present in this worktree. This audit relies on the available Phase 12.4F, 12.4G-A, 12.4G-B, 12.4H-A docs, the current telemetry export, current code, and official Gemini Live docs.
- The current telemetry report predates raw `outputTranscription.text` previews and `gemini-output-audio-chunk` diagnostics, so it cannot prove the exact raw provider text fragment at `Loud and clear. up?` or browser PCM schedule order.

Branch safety:

- Current branch during this audit: `audit/gemini-over-continuation-turn-policy-phase-12-4h-b`.
- `main` is not checked out.
- The worktree was already broadly dirty from prior realtime phases. This audit preserved that state and only adds/updates documentation.

## Observed Symptoms

### Captured report: hearing check

Telemetry file:

`frontend/src/app/lib/sophia-voice-telemetry-report-2026-05-20T18-27-19-399Z.json`

User said:

```text
Hi Sophia, can you hear me clearly?
```

Final public assistant transcript:

```text
Yeah, I hear you great. What's on your mind? You getting ready to jump into something? Loud and clear. up? Ready for a session?
```

Key report facts:

| Signal | Value | Meaning |
|---|---:|---|
| `providerEventCount` | 132 | Gemini session was active and producing provider events. |
| `serverContent` | 60 | Many provider content frames arrived. |
| `outputTranscription` | 18 | The visible assistant text came from Gemini output transcription snapshots. |
| `modelTurnAudio` | 54 | Native audio was produced for the turn. |
| `toolCallCount` | 0 | Tool lifecycle is ruled out for this capture. |
| `toolCallCancellation` | 0 | No cancelled tool continuation explains the duplicate. |
| `interruptionCount` | 0 | Not an interruption/flush leakage capture. |
| `playbackFlushCount` | 0 | No playback queue flush occurred. |

The final public assistant transcript was already malformed before UI rendering. This is not primarily a React bubble dedupe issue.

### Reported broader symptom: recommendation/focus prompt

Reported user request:

```text
Sophia, what do you recommend? What's one thing that I should focus on today?
```

Reported response felt like two clarification strategies joined:

```text
To give you the best recommendation, what are you playing today? And what's the one thing want to get out of this session? Not winning, something can control. That really depends on what you're getting into today. Is it work, gaming, else? Tell me a little bit more about what you've got planned.
```

This proves the problem is not only a greeting/hearing-check issue. It is a general duplicate-intent / over-continuation pattern: Gemini can answer one user turn with more than one candidate conversational move.

## Symptom Taxonomy

| Class | Example | Likely layer | Status |
|---|---|---|---|
| Duplicate opener | `What's on your mind? ... Ready for a session?` | Model turn policy + prompt pressure | Strongly supported. |
| Duplicate clarifier | `what are you playing today? ... is it work, gaming, else?` | Prompt/context/ritual intent collision | Strongly supported by reported example. |
| Fragment restart | `Loud and clear. up?` | Raw provider transcript vs normalizer assembly gap | Unresolved without raw preview. |
| Word-order corruption | `to lock You ready` class | Source-order relay bug | Addressed by 12.4G-B for relayed text. |
| Spoken audio disorder | Audio sounds stacked/out-of-order | Provider output or browser PCM schedule | Still needs chunk ledger evidence from 12.4H-A diagnostics. |
| UI greeting collision | Bootstrap greeting adjacent to first live response | Frontend presentation | Possible visual adjacency; not primary cause of captured malformed provider transcript. |

## Official Gemini Live Findings

Official docs checked in this phase and prior Phase 12.4H-A:

- `https://ai.google.dev/gemini-api/docs/live`
- `https://ai.google.dev/api/live`
- `https://ai.google.dev/gemini-api/docs/live-api/capabilities`
- `https://ai.google.dev/gemini-api/docs/live-api/best-practices`
- `https://ai.google.dev/gemini-api/docs/live-api/tools`
- `https://ai.google.dev/gemini-api/docs/live-api/session-management`

Facts that matter here:

| Topic | Official fact | Sophia impact |
|---|---|---|
| Native audio mode | Gemini Live native audio output is `AUDIO`; text visibility comes from `outputAudioTranscription`. | Spoken output is provider-native, not Cartesia reading backend text. |
| Incremental realtime input | `send_realtime_input` optimizes responsiveness and can process input before end-of-turn. | Gemini can begin an answer before the user's full intent has stabilized. |
| VAD | Automatic VAD is default and configurable. Too-low silence thresholds can fragment a single utterance and degrade response quality. | One user utterance can become multiple provider-intent opportunities. |
| Silence tolerance | Docs recommend a moderate silence tolerance, commonly 500-800ms; server default is around 800ms. | Sophia currently leaves this to defaults rather than a Sophia-specific voice policy. |
| Setup config | `generationConfig` can carry response modalities and other generation fields. | Current setup does not constrain length, temperature, or one-turn stop behavior. |
| Function calling | Gemini 3.1 function calling is sequential. | Tool-adjacent continuation is not the captured cause, but tool prompts still add policy weight. |
| Proactivity | API references proactivity, but current Gemini 3.1 Flash Live support is not the same as 2.5 proactive audio docs. | Do not explain this capture as an enabled proactivity feature in current setup. |

## Current Runtime Setup Review

`voice/realtime/gemini_live.py` builds Gemini setup with:

- `model`: default `gemini-3.1-flash-live-preview`.
- `generationConfig.responseModalities`: `AUDIO`.
- optional `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName`.
- `systemInstruction.parts[0].text`: full rendered Sophia realtime instructions.
- `tools`: existing Sophia declarations.
- `inputAudioTranscription`: enabled.
- `outputAudioTranscription`: enabled.

No current setup evidence of:

- `maxOutputTokens`.
- `temperature`.
- `topP`.
- `thinkingConfig`.
- `realtimeInputConfig`.
- `automaticActivityDetection` thresholds.
- `activityHandling`.
- `turnCoverage`.
- Gemini proactivity enablement.

Implication: Gemini receives a rich companion prompt but no Gemini-specific spoken-response compression policy in setup. The default Live turn behavior is allowed to decide how much of the prompt's competing conversation agenda to express.

## Prompt Assembly Findings

`voice/realtime/sophia_prompt.py` composes Gemini instructions directly from canonical Sophia prompt sources:

- `skills/public/sophia/soul.md`.
- `skills/public/sophia/voice.md`.
- `skills/public/sophia/techniques.md`.
- `skills/public/sophia/AGENTS.md`.
- Platform prompt from `PlatformContextMiddleware`.
- Context prompt such as `context/life.md` or `context/gaming.md`.
- Optional ritual prompt such as `Rituals/prepare.md`.
- Voice artifact contract from `ArtifactMiddleware`.

The fully rendered prompt confirms several helpful but competing pressures:

| Prompt source | Helpful intent | Over-continuation risk in Gemini native audio |
|---|---|---|
| `voice.md` | `Respond in 1-3 sentences`; one question at a time; never stack questions. | Correct rule exists, but it is diffuse inside a larger prompt and not framed as a hard Live spoken-stop policy. |
| `techniques.md` | Mirror, label, calibrated question; avoid stacked questions. | Gives several possible primitives Gemini can combine if no single-intent stop condition wins. |
| Platform voice prompt | `Respond in 1-3 sentences. Spoken rhythm. Think before each word.` | Length guidance allows multiple short intents inside three sentences. |
| `context/life.md` | Ask real questions, go deeper, do not stay on the surface. | Can turn a simple availability check into an opener plus deeper invitation. |
| `context/gaming.md` | Teammate/coach, sharper, direct, faster. | Can pull a recommendation turn into coaching mode before context is established. |
| `Rituals/prepare.md` | Ask ONE question to surface intention; gaming focus example. | Can collide with a generic clarifier, producing both `what are you playing` and `what one thing`. |
| `AGENTS.md` | Companion gathers specs and delegates build tasks when needed. | Adds complete-brief/spec-gathering pressure even in the same system prompt as emotional companion behavior. |
| Artifact instructions | Every turn has text plus exactly one `emit_artifact`; track session goals, active goals, next step, tone. | Pushes even trivial voice checks toward session framing and next-step language. |

The issue is not that Sophia lacks short-response guidance. She has it. The issue is that Gemini Live is being asked to directly produce native spoken audio from the full canonical companion prompt, and the prompt lacks a higher-priority, runtime-specific rule saying: pick one main conversational intent, answer that, then stop.

## First-Turn And Greeting Collision Analysis

Frontend session initialization does create an assistant greeting message before live voice output:

- `useSessionPageContext.ts` chooses `session.greetingMessage` or a fallback such as `I'm here with you. What's on your mind?`.
- `useSessionChatInitialization.ts` inserts that greeting as an assistant chat message.
- `BootstrapGreeting.tsx` renders the greeting as a bootstrap bubble.
- `VoiceCaption.tsx` deliberately skips the initial greeting for voice captions.
- `useSessionVoiceMessages.ts` appends Gemini assistant transcript output as a separate `voice-assistant-*` message and replaces the active live voice assistant message.

This creates possible visual adjacency between the bootstrap greeting and the first Gemini answer. However, the captured bad turn is not explained by UI greeting duplication alone:

- The malformed text appears in `lastAssistantTranscript` and public transcript details from the Gemini path.
- `toolCallCount`, interruption, and playback flush counts are zero.
- No inspected code path sends the bootstrap assistant greeting as a Gemini `clientContent` or prompt turn during Live setup. Gemini setup receives `systemInstruction`, tools, and audio/transcription configuration.
- The bad assistant content contains multiple new opener intents in the provider transcript, not merely the existing UI greeting duplicated verbatim.

Verdict: frontend greeting can make the first live exchange feel busier, and first-turn policy should be tested, but it is not the root cause of the captured over-continuation.

## General Over-Continuation Analysis

The recommendation/focus example is the stronger general signal. It combines multiple candidate intents:

1. Ask game-specific context: `what are you playing today?`
2. Ask ritual/prepare intention: `what's the one thing you want to get out of this session?`
3. Ask mode/context classification: `is it work, gaming, else?`
4. Ask broad planning context: `tell me a little bit more about what you've got planned.`

Those intents correspond to real prompt sources:

- Gaming context wants sharper coach energy.
- Prepare ritual asks for one focus/intention question.
- Companion behavior wants to gather enough context before acting.
- Life/default context wants to ask real questions and not stay on the surface.

In the legacy cascade, these pressures were mediated by a text backend turn after finalized STT and then spoken by Cartesia. In Gemini Live native audio, the same pressures are inside one provider session that can begin responding incrementally. That increases the chance that Gemini expresses more than one plausible next move before stopping.

## Legacy Cascade Vs Gemini Live Response Shaping

| Layer | Legacy cascade | Gemini Live candidate |
|---|---|---|
| User turn boundary | Finalized STT text reaches backend. | Realtime audio can be processed incrementally before end-of-turn. |
| Spoken output | Backend text response is piped to TTS. | Gemini generates native audio directly. |
| Transcript text | Backend text is source of truth. | Output transcription is a side surface for generated audio. |
| Prompt stack | LangGraph companion middleware assembles prompt and tools. | `sophia_prompt.py` renders canonical sources into Gemini `systemInstruction`. |
| Artifact contract | Tool use after/within backend agent turn. | Tool contract lives in same Live prompt as spoken audio obligation. |
| Stop conditions | Backend model turn ends before TTS speaks complete text. | Live model can stream speech and transcription as it forms the turn. |

The migration changed the response-shaping topology. Gemini now owns turn start, speech content, audio cadence, output transcript, and tool-call decision inside one Live session. The existing Sophia prompt was not originally designed as a native-audio turn compressor.

## Ruled-Out Or Lower-Probability Causes

| Candidate cause | Classification | Reason |
|---|---|---|
| Frontend transcript renderer appending snapshots | Not primary for captured report | Public transcript already contains over-continuation; frontend voice message code replaces active assistant message. |
| Phase 12.4G-B stale/out-of-order relayed transcript mutation | Not supported for captured report | Output-transcription-bearing events were monotonic in prior analysis. |
| Tool lifecycle continuation | Ruled out for captured report | `toolCallCount`, builder tool count, artifact tool count, and cancellation counts are zero. |
| Interruption or playback flush leakage | Ruled out for captured report | Interruption and flush counts are zero. |
| UI bootstrap greeting as direct provider input | Not supported by code inspection | Greeting is inserted into UI/session messages; inspected Gemini setup sends system instruction and audio path, not bootstrap greeting as a Live turn. |
| Greeting-only prompt bug | Rejected | The recommendation/focus example shows duplicate intent outside greeting. |
| PCM replay as sole cause | Weak for semantic duplicates | PCM replay can repeat/reorder sound, but cannot invent a second coherent clarifier unless provider output already contains it. |

## Root Cause Assessment

Primary root cause:

Gemini Live is receiving the full canonical Sophia companion prompt without a Gemini-native spoken turn policy that forces one main conversational intent, one optional clarifier, and an immediate stop after satisfying the user's surface intent.

Contributing causes:

1. Gemini Live realtime input is incremental and optimized for low latency, so the model may begin an answer before the user's intent is fully stabilized.
2. Current setup does not specify Sophia-specific VAD/turn-coverage controls or generation length controls.
3. The canonical prompt contains several valid but competing pressures: emotional depth, context routing, ritual prep, builder spec gathering, artifact/session-goal management, and one-question guidance.
4. Short-response rules exist, but they are not framed as the highest-priority Live spoken-output contract.
5. Simple-intent cases, such as hearing checks, do not have explicit stop rules like: answer only the check, optionally invite one next step, do not start a session agenda.
6. The first-turn UI greeting can make live output feel adjacent to an opener, but it does not explain the provider transcript content by itself.

Confidence:

- High that this is not just frontend rendering, stale relay order, tools, or interruption cleanup.
- High that it is not greeting-only.
- Medium-high that the leading fix is prompt/policy shaping specific to Gemini Live native audio.
- Medium that config/VAD tuning will also matter; it should be measured after a policy overlay test.

## Recommended Implementation Phase

Recommended next phase:

**Phase 12.4H-C - Gemini Live Spoken Turn Policy Overlay**

Recommended strategy: hybrid, narrow, and measurable.

Implement a Gemini Live voice-specific policy overlay in `voice/realtime/sophia_prompt.py` or adjacent prompt assembly, not by editing canonical Sophia skill files first. The overlay should sit near the top or bottom of the rendered Gemini instruction with explicit Live spoken-output priority.

Policy goals:

- One main conversational intent per assistant turn.
- For simple availability/hearing checks: answer in one sentence, then stop or ask one light opener only if needed.
- For recommendation/focus asks: choose either a context clarifier or a focus question, not both.
- Max one question total in spoken text.
- No agenda shift after answering a user check.
- No second opener after a first opener.
- No generic `what's on your mind` if the user already provided the immediate intent.
- Artifact/tool obligations remain structured; do not verbalize artifact/session bookkeeping.
- Stop after the spoken response and required structured tool call behavior.

Why overlay first:

- It preserves canonical Sophia identity and `soul.md` immutability.
- It avoids broad frontend suppression that would hide provider behavior.
- It targets the migration-specific topology change: native audio from a full companion prompt.
- It can be A/B tested without rewriting the broader companion prompt system.

Recommended files for the implementation phase:

- `voice/realtime/sophia_prompt.py` for the Gemini-only spoken turn policy overlay.
- `docs/debug/gemini-live-fully-rendered-sophia-prompt.md` regeneration path if used by the repo.
- Focused tests for rendered prompt inclusion and non-inclusion in non-Gemini paths.
- Manual dogfood matrix docs or telemetry checklist updates.

Do not start with:

- Editing `soul.md`.
- Removing context/ritual prompts globally.
- Adding broad transcript or audio suppression.
- Treating all duplicated content as a greeting duplicate.
- Hard-capping output so aggressively that Sophia cannot handle real emotional turns.

## Test Matrix For Next Phase

Run each before and after the overlay, with current-run telemetry export.

| Scenario | User prompt | Expected spoken behavior | Failure to catch |
|---|---|---|---|
| Hearing check | `Hi Sophia, can you hear me clearly?` | One acknowledgement; at most one light next question. | Multiple openers: `what's on your mind`, `ready for a session`, `jump into something`. |
| Simple greeting | `Hey Sophia.` | Brief greeting and one opener. | Repeating greeting/opener in different words. |
| Recommendation | `What do you recommend I focus on today?` | One clarifier or one recommendation path. | Both context classification and ritual focus question stacked. |
| Gaming focus | `I'm about to play ranked. What should I focus on?` | One gaming focus question or one concise recommendation. | `what game`, `what focus`, and `what planned` all in one reply. |
| Prepare ritual | Start voice in prepare mode. | Follow ritual step with one question. | Generic session opener plus ritual opener. |
| Life context | `I don't know what I need today.` | One gentle question. | Deepening question plus session-agenda question. |
| Builder-adjacent | `Can you help me make a short plan?` | Ask only the missing spec or start a focused companion response. | Builder spec gathering plus emotional opener plus artifact framing. |
| Long utterance with pause | User pauses mid-sentence. | Wait for full turn or respond only once. | Early answer then later continuation. |

Telemetry checks:

- `outputTranscription` text previews show one semantic path.
- Public `sophia.transcript` matches the provider semantic path.
- `interruptionCount` and `playbackFlushCount` stay zero for non-interruption tests.
- Tool counts stay zero unless a scenario explicitly needs a tool.
- `gemini-output-audio-chunk` diagnostics do not show duplicate audio chunks for semantic duplicates.

## Deferred Strategies

Consider these only after the policy overlay test matrix:

| Strategy | When to consider | Risk |
|---|---|---|
| VAD/turn config tuning | If long-pause utterances split or early response persists. | Too much delay hurts voice responsiveness. |
| `maxOutputTokens` or generation length controls | If overlay reduces intent stacking but responses still ramble. | Can truncate emotional or complex turns. |
| Temperature/topP tuning | If Gemini keeps offering multiple alternatives. | May flatten Sophia's voice. |
| Context/ritual prompt slimming for Gemini only | If specific overlays still collide. | Can reduce companion depth if applied globally. |
| Intent classifier/router | If prompt-only policy cannot separate hearing checks, greetings, rituals, and recommendations. | Adds latency and complexity. |
| Frontend first-turn presentation changes | If UI greeting adjacency remains confusing after provider output is clean. | Treats presentation, not provider root cause. |
| Transcript/audio suppression | Only for proven duplicate transport replay. | Can hide real provider output and mask root cause. |

## Risks To Avoid

- Do not solve this as a greeting-only issue. Greeting is one specimen, not the disease.
- Do not add broad suppression of repeated phrases in the frontend. It would hide provider policy failures and could erase legitimate emotional mirroring.
- Do not parse or trim assistant text post hoc as the primary fix. Gemini is speaking native audio; post-text filtering cannot reliably change what the user already heard.
- Do not remove all depth/context prompts from Sophia. The problem is priority and stop policy, not Sophia's identity.
- Do not use `runs/wait` or route voice back through legacy text just to regain deterministic text output.
- Do not weaken `emit_artifact` as a companion contract without a separate architecture decision.
- Do not modify `soul.md`.

## Conclusion

The best current explanation is a mixed provider/prompt-topology root cause: Gemini Live's incremental native-audio turn behavior is being driven by a rich canonical Sophia companion prompt that lacks a Gemini-specific spoken turn stop policy. The captured bad turn is already malformed at the provider/public transcript boundary and has no tools, interruptions, or playback flushes. The broader recommendation example shows the same duplicate-intent pattern outside greeting.

The next implementation should be a narrow Gemini Live spoken-response policy overlay, followed by a measured test matrix. Runtime config tuning, VAD changes, and UI presentation changes should remain secondary until the overlay proves what remains.