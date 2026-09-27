# R-010 planning context — ordinary voice greeting produced review/file hallucination

Date: 2026-09-28. Evidence collection was read-only. No code, deploy, environment, Lab, memory, or retention change was made.

## Executive finding

On a fresh ordinary voice session, the only user utterance was “Hey, Sophia.” Gemini returned one provider response containing three conversational segments, including a false claim that review tools were unavailable and a reference to a file the user never mentioned. This was not three backend replies, a duplicated UI event, a tool failure, a stale Builder run, or recalled user context.

The strongest current cause is instruction/schema salience in the Gemini setup: ordinary sessions receive Coreview/review tool declarations whenever the Coreview flags are enabled, even when no review is active and no artifact exists. PR #162 also keeps generic Builder lifecycle declarations in that setup. Gemini appears to have invented a review/file situation from that tool context and then violated the existing one-intent/no-repeat policy. No Coreview or Builder tool was called.

Important refinement: the production memory-aware instruction path does not append the Coreview prompt overlay. Review vocabulary reaches Gemini through always-present tool declarations and descriptions. The generic instruction builder appends that overlay, but production session construction calls the memory-aware builder, which does not.

LangSmith cannot provide a second copy because voice-service multipart ingest was rejected with HTTP 403 throughout the response. That is a separate observability configuration/scope problem.

## Production state

- Frontend: ec8905a29c48999e091dc89ce7567dde731d9eac, deployment dpl_3Ftvvwu7H964zPWc61z1Zk6ZBGxn.
- ec8905a2 merged PR #162; parent 87d471f2, PR head f2c74630.
- PR #162 changed frontend only. Voice remained on f128af0c.
- Public and backend Coreview/still-frame flags read true. No setting changed during diagnosis.

## Correlation IDs

- Voice session: gemini-prod-4d0c405b05db4fbdb6742cd83819cd59
- Voice trace: 01a0e4d8-ed33-7bfc-aa8e-e53b721925dc
- LangSmith project: Sophia-Gemini-Live-Voice
- Parent thread: 01a0e4d8-db0f-7311-a607-467e7c20ab3f
- Sophia session: 3395593f-5487-468e-a86a-fa23226d3ba5
- Provider response: gemini-response-e7d3d8a4-6a05-414e-945b-1ddfd330432e
- User/cohort identity intentionally omitted.

## Exact conversation

User: “Hey, Sophia.”

Assistant, in one response:

> Hey. What's up? Hello. I want to be upfront with you—the review tools aren't working right now, so I can't actually see the file you're referring to. But I'm here to listen and talk through whatever's on your mind. What did you want to get into? Hey. What's up?

Defects: repeated opener, unsupported tool-health claim, unsupported file reference.

## Timeline (UTC)

- 21:50:16.894 trace started; 21:50:22.948 Gemini setupComplete.
- 21:50:26.444 sole input transcription: “Hey, Sophia.”
- 21:50:27.055 first output; through 21:50:44.248, 19 cumulative transcript snapshots for one response ID.
- Counts: sophia.transcript=19, sophia.turn=3, sophia.user_transcript=1.
- One user start/end and one assistant start/end boundary.
- No toolCall, tool result, artifact, Builder lifecycle event, or diagnostic failure.
- All provider relay POSTs returned 202.

Therefore the apparent three replies were segments inside one Gemini response; the UI did not create duplicate assistant turns.

## Context and state ruled out

- Voice memory context at 21:50:16.559: empty; preferred name absent; identity absent; handoff absent; memories=0; Mem0 unavailable.
- Gateway artifact reads at 21:50:16 and 21:50:22: local=0, Builder-task local=0, Builder-task thread=0, Supabase=0, merged=0.
- No active Builder task; only canvas subscription and ordinary snapshots appeared.
- LangGraph searches by parent thread, voice session, and trace found no run. No companion launch reached LangGraph.
- Setup, input transcription, audio, and transcript streaming were healthy; no reconnect preceded the defect.
- No Coreview/Builder tool error existed for Gemini to summarize.

The direct browser-to-provider media channel means server logs cannot mathematically prove no browser frame was sent. However, frontend review state initializes with no artifact and is set only after explicit frame send; the gateway had no artifact to select; the user did not enter Review. There is no positive evidence of review activation or a frame.

## Production code path

Backend f128af0c:

1. voice/realtime/gemini_production_session.py:271-283 calls build_gemini_live_realtime_instructions_with_memory_context and passes it into browser-session setup.
2. voice/realtime/gemini_memory_context.py:43-70 composes base instructions, memory, skill-state seed, and spoken policy. It does not append the Coreview overlay.
3. voice/realtime/dogfood_session.py:124-150 and 464-479 builds setup with Gemini tool declarations.
4. voice/realtime/gemini_tool_loop.py:2065-2094 requests Sophia declarations with include_coreview unset.
5. voice/realtime/sophia_backend_tools.py:131-148 resolves Coreview from SOPHIA_GEMINI_COREVIEW_ENABLED and appends read_artifact_text and Coreview actions.
6. voice/realtime/coreview.py:188-292 descriptions mention co-review, active/selected artifact, current view, and exact file text. Tool descriptions are provider context even without a call.

Frontend ec8905a2:

1. gemini-browser-live-websocket-dogfood.ts:3424-3431 transforms backend setup because the still-frame flag is true.
2. PR #162 added allowGenericBuilderTools=true, preserving start/edit/check/update/cancel/list Builder tools in ordinary setup.
3. coreview-actions.ts:1222-1299 appends frontend Coreview/Builder actions and deduplicates names. No duplicate names were present, but the ordinary setup has a large mixed Builder/review tool surface.
4. The final setup is sent once at gemini-browser-live-websocket-dogfood.ts:4325-4329; Gemini Live fixes tools for the connection.
5. Microphone capture starts only after setup complete at 4331-4341. No startup user message is sent. sendText at 4380-4389 sends only explicit caller text.

The spoken policy at voice/realtime/sophia_prompt.py:114-143 already requires one intent, at most one question, no repeated opener, and no generic-greeting assumptions. Gemini violated it. The normalizer markers at voice/realtime/normalizer.py:14-54 catch literal tool mechanics but not natural-language inventions such as “review tools aren't working” or “the file you're referring to.”

## Relationship to PR #162

PR #162 is temporally adjacent and expanded ordinary setup by retaining six generic Builder lifecycle tools when Coreview is on. It did not add the Coreview backend flag, change the backend prompt, duplicate transcript events, or execute a tool here.

Treat it as a possible load/salience amplifier, not a demonstrated direct cause. Reverting PR #162 would remove the wanted voice-Builder bridge but leave Coreview declarations, so it is not a complete fix.

## LangSmith failure

- The trace ID exists, but its run view showed No inputs and No outputs.
- The project list had no new incident trace.
- From 21:50:27.131 through 21:50:44.936, multipart ingest to the EU endpoint repeatedly returned 403.
- Retries repeated at 21:53:27–28 and 21:56:02–04.

Likely issue: voice LangSmith credential, workspace, endpoint, or project scope does not authorize EU multipart ingest. No secret value was exposed.

## Ranked causes

1. High — ungrounded Gemini response induced by mixed tool context. Review/file schemas are visible while review_active=false.
2. High — provider failure to follow the spoken-turn contract. One response repeated its opener and stacked intents.
3. Medium — PR #162 increased setup complexity with six generic Builder tools. No Builder call occurred.
4. Low — stale browser review state/frame. Initialization and zero-artifact evidence argue against it; direct media is the observability gap.
5. Ruled out — memory/handoff contamination, existing artifact, tool failure, LangGraph/Builder response, duplicate UI replies, transport failure.

## Recommended fix plan

### 1. Ground ordinary mode explicitly

Add a short Gemini-only block to the production memory-aware path in gemini_memory_context.py, next to the spoken policy:

- Session starts with artifact review inactive and no file selected.
- Tool availability is not evidence of a file or review request.
- Never mention file/artifact/review/tool availability unless the user introduced it, trusted app context activated review, or an actual tool result established it.
- Never claim a tool is broken without a tool result saying so.
- For a generic greeting, answer once with one short greeting/neutral prompt and stop.

Add the block to fallback Gemini instruction construction so paths cannot diverge.

### 2. Make review activation explicit

When Review actually starts and a selected artifact/frame is ready, send one trusted app-context event setting review_active=true and the artifact ID before the frame. When Review stops, send review_active=false and clear context. Keep it out of user chat/transcript.

buildGeminiArtifactTextReaderHint expresses active-review context but appears to have no production call site at ec8905a2. Verify this and wire one governed activation path if correct.

### 3. Reduce schema exposure if grounding is insufficient

The stronger option is a separate provider setup/connection for review: ordinary voice excludes Coreview declarations; entering review opens or continues a connection with them. Gemini tools are fixed at setup, so preserve continuity, cleanup authority, microphone ownership, and Builder availability.

Do not use flag disablement or PR #162 revert as the final fix; they remove wanted capability without grounding mode state.

### 4. Add an incident detector

Emit a redacted diagnostic when ordinary output contains review/file/tool-unavailable language while review is inactive, no artifact is selected, and no tool result exists. Transcript suppression alone cannot retract audio already streamed to the browser.

### 5. Repair LangSmith separately

Correct EU endpoint/workspace/project authorization and verify a fresh voice trace has inputs, outputs, provider events, and final status. This did not cause the malformed response.

## Tests and acceptance evidence

- Production memory-aware instructions contain the grounded normal-mode block exactly once.
- Generic greeting produces one response, one short opener, at most one question, no file/review/tool claim, no tool call.
- Review activation sends one trusted active context only after an artifact is bound; stop clears it.
- No activation hint leaks into visible chat/transcript.
- “Can you see the file?” while review is inactive does not claim tool failure.
- With Review active and an artifact bound, view/text tools still work.
- Explicit research/build still calls start_builder_task and preserves PR #162's visible request/progress flow.
- Mic bootstrap/null-cleanup remains intact.
- The supervised run appears in LangSmith with populated input/output.

## Rollout and rollback

Use a focused voice PR, adding frontend only if activation/deactivation wiring is required. Deploy voice first with Coreview flags still on. In a fresh private session test greeting, normal conversation, Builder request, enter/exit Review, and one artifact view command.

Voice rollback is the prior deployment serving f128af0c. If frontend wiring is included, current frontend dpl_3Ftvvwu7H964zPWc61z1Zk6ZBGxn is the rollback target. Keep LangSmith config repair isolated.

## Remaining unknowns

- No raw browser-to-Gemini payload capture, so final outgoing tool list and frame absence are inferred from code/state rather than captured wire data.
- LangSmith 403 blocked independent provider input/output inspection.
- One incident does not establish frequency. Add the detector and run a small repeated greeting matrix before rollout.
