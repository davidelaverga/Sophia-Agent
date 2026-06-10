# Companion Fallback — UI-Silent Reply & Telemetry Audit (Issue B)

Branch: `feat/coreview-native-builder-actions`
HEAD: `2042ff49` (`fix: surface OpenAI companion fallback replies`)
Worktree: `C:\Users\zerof\Sophia-Agent-X\.worktrees\main-health-pr133-verify`
Companion to: the Builder OpenAI `tool_choice` normalization fix (Issue A) in the same change.

## Scope

Secondary priority from the audit request: "Sophia's text did not appear in the
UI" and the exported telemetry showed `turns=0 / assistantTranscripts=0` despite
backend runs completing. Per the request, this is fixed only if low-risk and
clearly identified; otherwise documented. **Conclusion: not a clearly-identified
low-risk backend bug — documented here, no speculative frontend change made.**

## Grounded findings (from `logs/langgraph.log`, run at 2026-06-10T02:14–02:15Z)

1. **Companion fallback replies ARE produced server-side.** Every companion turn
   that hit Anthropic's billing 400 retried OpenAI and logged
   `fallback_result=success` (not `empty_response`):
   - `02:15:04` run `019eaf4f-b483-…` — `Background run succeeded` (sophia_companion).
   - `02:15:35` run `019eaf50-33f3-…` — `[CompanionProviderFallback] OpenAI fallback succeeded`,
     same run later `Background run succeeded`. This is the turn that fired
     `start_builder_task` (lifecycle_tool_call at `02:15:35`).
   So the companion produced visible content on the OpenAI path; the backend is
   not dropping the reply.

2. **The companion surfacing path already handles the empty-reply case.** HEAD
   commit `2042ff49` added `CompanionProviderFallbackMiddleware._response_is_empty`
   + a `companionFallbackEmptyResponse=true` diagnostic. The logs show
   `fallback_result=success`, i.e. the response carried visible text / a tool
   call — the empty-response guard did not trigger.

3. **The "Builder failed" the user saw was Issue A**, the OpenAI
   `Missing required parameter: 'tool_choice.function'` 400 that crashed the
   `sophia_builder` background run at `02:15:42` — fixed in this change by
   provider-aware `tool_choice` normalization.

4. **`turns=0 / assistantTranscripts=0` originates in the frontend voice
   telemetry exporter**, not the backend. The companion reply reaches the thread
   message stream (LangGraph `messages-tuple`); the voice-runtime metrics /
   voice-telemetry-report capture assistant *transcripts* from the voice runtime
   turn loop. In a Coreview / text-mode run driven through the OpenAI fallback,
   the voice turn loop may not register assistant transcripts, so the export
   reads zero even though the backend run completed. This is a telemetry-capture
   surface (`frontend/src/.../voice-runtime-metrics`,
   `voice-telemetry-report`), independent of the companion reply being produced.

## Why no code change here

- The backend already does the right thing (replies produced + empty-response
  diagnostic in place). Changing it would be a no-op or a regression risk.
- The telemetry gap is in the frontend voice-runtime metrics capture. A correct
  fix needs a grounded reproduction of which runtime path (voice vs. text vs.
  Coreview) feeds the exporter and where assistant transcripts are (not) appended
  — not available from the backend logs alone. Guessing risks weakening or
  double-counting telemetry.

## Suggested follow-up (separate, scoped task)

1. Reproduce with the companion fallback ON and capture the frontend
   message-stream events for the companion turn (confirm the `messages-tuple`
   assistant message arrives client-side).
2. If it arrives but isn't rendered: trace the session UI append path for
   fallback turns (the run still completes via OpenAI; ensure the UI append
   isn't gated on a voice-runtime-only signal).
3. If it isn't captured by telemetry: add an assistant-transcript capture point
   in the text/Coreview path of `voice-runtime-metrics` so `assistantTranscripts`
   reflects fallback turns. Candidate safe telemetry fields (only if grounded):
   `companionFallbackVisibleMessageEmitted`,
   `companionFallbackMessagesTupleSeen`,
   `companionFallbackUiAppendResult`.

No raw provider payloads, prompts, API keys, signed URLs, or telemetry exports
were read or reproduced for this note.
