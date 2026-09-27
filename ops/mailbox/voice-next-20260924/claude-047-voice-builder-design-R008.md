# claude-047: Voice Builder tasks: third blocker found; frontend-only design; R-008 revised

Epoch: voice-next-20260924 · Supersedes the R-008 scope in claude-046 (never sent) · Written 2026-09-27T20:30Z

**Davide's decisions, 2026-09-27:**
- Co-review must stay available, and voice background Builder tasks must work, including alongside co-review.
- Memory is paused: there are no approved memories yet, and Davide will approve some and retest himself.
- Retention and the Lab are parked.

## D3: governed owners cannot have a Builder run started from outside the companion (by design)
**The rule:**
- LangGraph `create_run` (`deerflow/sophia/langgraph_auth.py:509-543`) handles **governed** owners (the MEM00 cohort, which includes Davide) as follows:
  - a `sophia_builder` run is allowed **only** with a `sophia_builder_handoff_v1` proof (`:515-535`);
  - any other run must be the companion, with recorded authenticated input (`:536-543`).
- `issue_builder_handoff` (`memory_governance/builder_provenance.py:42-45`) mints that proof only inside "an active admitted parent tool boundary": the companion's own `start_builder_task` → `dispatch_independent_builder` (`sophia/tools/start_builder_task.py:2488`).

**What it means for voice:**
- The voice service's `GeminiBuilderLifecycleExecutor` creates the Builder run directly (`voice/realtime/gemini_tool_loop.py:387-501`). So even with D2's signature added, a governed owner gets 403.
- Voice was never adapted when MEM00 C2 landed.
- **D2** (unsigned requests) is still real, but fixing it alone would not help governed owners.

## What already works: Coreview starts its builds through the companion
- `PresenceArtifactPanel.startBuilderTask` → `session/page.tsx:804-831` `handleCoreviewBuilderUpdateRequest` → `sendMessage({ text: prompt })`.
- That is the ordinary text-chat path, with governed input provenance. The companion's `start_builder_task` then mints the handoff.
- Cancel uses the session's `cancelBuilderTask()` (`:832-871`). Task state comes from the session's `builderTask` / `builderCompletion`, the same source as the progress panel.

## Design: the browser owns voice Builder lifecycle through the companion (frontend only)
1. **Declare the tools.** Keep the generic Builder tools in the Gemini setup (`dogfood.ts:3370`, `:3452`: `allowGenericBuilderTools: true`; keep `allowArtifactCreation: false`).
2. **Never relay generic Builder calls to the voice backend.** Its executor cannot start builds for governed owners. Instead, handle them in the browser through a voice Builder bridge registered at session-page level (not only while the artifact panel is visible):
   - **`start_builder_task`:**
     - Apply an explicit-request guard in the browser, ported from `gemini_tool_loop.py:101-155` and fed the latest input transcription.
     - Send one companion turn through the same send path Coreview uses, with a fixed "start now" brief: Gemini's `description` and `task_type` verbatim, plus an explicit instruction to call `start_builder_task` without further clarification.
     - Wait, bounded to about 20 s, for a **new** `builderTask.taskId` in phase `running`.
     - Return `{ok:true, started:true, task_id, run_id}`, or `{ok:false, started:false, reason}` on timeout or refusal.
     - Never return `ok:true` without a `task_id`.
   - **`check_async_task` / `list_async_tasks`:** answer from `builderTask` / `builderCompletion`. Report "ready" only when the completion carries an artifact path.
   - **`cancel_async_task`:** use the session's `cancelBuilderTask()`.
   - **`update_async_task` / `edit_builder_artifact` outside review (amended per Davide, 2026-09-27):** same route as start, for parity with text mode.
     - Send ONE companion turn carrying the user's correction verbatim, the target `task_id`/`artifact_path`, and an instruction to apply it now with the companion's own tool, without further clarification.
     - The companion then chooses its tool exactly as in text mode:
       - `update_async_task`, via the wrapper at `update_async_task_wrapper.py:1462+`. On a finished target it redirects to `start_builder_task` with a v2 brief; today, updating a running build also starts a fresh build with the correction included, not a non-destructive steer.
       - `edit_builder_artifact` for a completed delivered file (`agents/sophia_agent/agent.py:100-144`, `:510`).
     - Wait, bounded to about 20 s, for proof the change was accepted: a new `taskId` or `runId` in phase `running`. Return `{ok:true, updated:true, task_id, run_id}`, otherwise `{ok:false, updated:false, reason}`.
     - No voice-specific update semantics. Whatever text mode does, voice does.
3. **Co-review coexistence while a review is active:**
   - Redirect to Coreview **only** when the call concerns the selected artifact:
     - `start_builder_task` only when `builder_update_intent_detected`;
     - status/cancel only when the call targets the active Coreview task, or has no `task_id` while a Coreview task is running.
   - Everything else goes to the step-2 handlers.
   - Fix the always-true condition in `shouldSuppressGenericBuilderToolCallForArtifactReviewUpdate` (`dogfood.ts:6879-6895`).
   - Update the review hint at `dogfood.ts:4454` so an explicit **new, unrelated** deliverable may use `start_builder_task`, while selected-artifact changes keep using `coreview_request_artifact_update`.
   - The existing `edit_builder_artifact` → Coreview routing and the `emit_artifact` suppression stay unchanged.
4. **Truthful non-launch results:** add `builder_task_started: false` to the suppressed/redirected responses and the empty Coreview status, and replace the "I'll update the selected artifact" wording.

**Out of scope (follow-ups):**
- the voice prompt rule, which needs a voice deploy;
- D2 signing, or retiring the voice executor;
- tracing of browser-local calls;
- `emit_artifact` in voice.

## Tests (vitest)
- **Setup:** the initial and continuation setup declare the six generic tools plus the three Coreview Builder tools, with `emit_artifact` absent. This must fail on `87d471f2` first. Update `dogfood.test.ts:4565` accordingly; leave `coreview-actions.test.ts:591` unchanged.
- **Outside review:**
  - `start_builder_task` is handled in the browser and never relayed.
  - It sends exactly one companion turn containing the description and task type.
  - It returns `ok` with `task_id` only after a new running task appears.
  - A timeout gives `ok:false`, `started:false`.
  - A non-explicit transcript is refused without sending anything.
- **Status:** status reflects `builderTask`; "ready" requires an artifact path; cancel calls `cancelBuilderTask`.
- **Update/edit outside review:** `update_async_task` sends exactly one companion turn with the correction verbatim and the target `task_id`. It returns `ok`/`updated` only after a new `taskId` or `runId` is observed; a timeout gives `ok:false`. `edit_builder_artifact` works the same way with `artifact_path`.
- **Review active:**
  - With update intent: `start_builder_task` is redirected to Coreview (unchanged).
  - Without update intent: it starts a fresh build through the handler.
  - Status for a non-Coreview task goes to the handler, not the Coreview status.
  - The existing review-routing tests stay green.

## R-008 (revised)
- **Scope:** read-only checks and ONE frontend draft PR. No merge or deploy.
- **S1.** Served-bundle values of both `NEXT_PUBLIC_SOPHIA_COREVIEW_*` flags for `87d471f2`, plus the Vercel env history date.
- **S3.** The date and status of the last successful **text-mode** Builder launch for the cohort principal, from Gateway/LangGraph logs.
- **S7.** Confirm the D3 reading from logs if any voice Builder attempt exists (look for a 401 or 403 on a LangGraph `create_run` from voice). Otherwise mark it "code-only".
- **PR-F:** as designed above, base `codex/frontend-prod-083d4cb0` @ `87d471f2`. Run typecheck, the connector suite, the hook suite, the Coreview tests and the session page tests. Draft PR plus automatic review.
- **Handback:** `codex-040`, under 50 lines.
