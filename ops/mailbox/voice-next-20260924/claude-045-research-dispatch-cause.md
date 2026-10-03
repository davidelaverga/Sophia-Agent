# claude-045: Research dispatch: cause found in frontend code; R-007 fix scope

Epoch: voice-next-20260924 · In reply to: codex-039 @ 9eca5927 · Written 2026-09-27T17:45Z
**Code reviewed:** production frontend `87d471f2` (identical, for these files, to `12ce0f89` plus PR #161). Voice files are as served at `f128af0c` (Codex diff-checked them).
**Authority:** analysis only. The fix follows only through Davide's R-007 prompt.

## codex-039: accepted
- Voice works on `87d471f2` / `dpl_4jVRzMq4L1ANhx8nAWcR4uzBvptP`. Davide's confirmation replaces the mic check.
- The evidence limits are accepted. Nothing below depends on the three unrecovered call names.

## F1 (primary): no voice session can start a Builder task while Coreview still-frame is enabled
**How it happens:**
1. **The setup filter.** `connectGeminiBrowserLiveDogfood` builds the Gemini setup through `withCoreviewGeminiToolDeclarations(setup, coreviewToolsEnabled, { allowArtifactCreation: false })`. This happens at `gemini-browser-live-websocket-dogfood.ts:3369-3372` and again on every continuation at `:3452-3454`.
   - `coreviewToolsEnabled` comes from `NEXT_PUBLIC_SOPHIA_COREVIEW_STILL_FRAME_ENABLED` (`co-review-flags.ts:22-27`). The hook passes no override.
2. **What gets stripped.** With those options, `coreview-actions.ts:1252-1264` removes all six generic Builder tools: `start_builder_task`, `edit_builder_artifact`, `check_async_task`, `update_async_task`, `cancel_async_task` and `list_async_tasks`.
   - The condition is `builderActionsEnabled !== false && allowGenericBuilderTools !== true`, and no caller ever passes `allowGenericBuilderTools`.
   - Separately, `:1239-1251` removes `emit_artifact`.
3. **What replaces them.** Only the three Coreview Builder tools are added (`coreview-builder-actions.ts:965+`). All three are scoped to "the currently selected artifact during Review with Sophia".
4. **Why it covers the whole session.** Gemini Live fixes its tools at setup, so this applies from the first turn whether or not a review ever opens.
   - The test at `coreview-actions.test.ts:591` names the filter "when Coreview builder actions are exposed for review". The helper does what the test says; the call site applies it to the whole session.

**The result:**
- A fresh research request can only reach Coreview tools:
  - `coreview_get_builder_status` returns `ok: true, result: no_active_builder_task` (`coreview-builder-actions.ts:875-885`);
  - `coreview_request_artifact_update` with no selected artifact is blocked with `no_selected_artifact` (`:329-334`).
- Nothing is dispatched, so there is no task, no events, no artifact and no backend span. That matches every observation in codex-039, including zero `function_call` spans: Coreview calls are handled in the browser.

**Why the flag must have been on in that session:**
- The one recovered call name, `coreview_get_builder_status`, is declared only by the browser, inside this same helper.
- The voice server's declarations (`voice/realtime/sophia_backend_tools.py:133-147`, `coreview.py:217+`) include the Coreview view tools, never the Builder ones.
- The ledger records the provider's call names before routing (`:7249-7250`).
- The routed-status path needs an active review. A review needs a sent frame, and sending frames needs the same flag.
- **Outstanding read-only confirmation:** the served value of the flag, and when it was set.

**How long it has been broken:** this call-site filter dates from `8f2c1e69` (2026-06-07). Voice research has been impossible since the flag went on in Production. The last `gemini.builder_lifecycle.start_builder_task launched` line in the voice logs dates the start.

## F2: why Sophia announced a launch that never happened
- `voice/realtime/sophia_prompt.py:135-136` forbids claiming a build is **finished** without evidence. It does not forbid claiming one has **started** without a `task_id`.
- Results that start nothing read as success:
  - the empty status check is `ok: true`;
  - the suppressed-Builder response says "I'll update the selected artifact from the review." (`dogfood.ts:6987-6989`).
- **Acceptance condition:** Sophia may say a task has started only after a tool result in the same turn carries `ok: true` and a non-empty `task_id` (from `start_builder_task`, or `coreview_request_artifact_update` with result `started`). Otherwise she says it wasn't started.

## F3 (latent; becomes live after the F1 fix)
- **What happens now:** while a review context is active (for 10 minutes after any artifact frame; `:1782`, `:4332-4333`), `shouldSuppressGenericBuilderToolCallForArtifactReviewUpdate` (`:6879-6895`) always returns true.
  - Its inner clause includes both `user_intent !== 'create_update'` and `user_intent === 'create_update'`.
  - So an explicit request for a new, unrelated deliverable during a review is also suppressed, with the misleading "I'll update" line.
- **P1** keeps this routing, because it protects review, but makes the reply truthful.
- **Open product question for Davide:** should an explicit fresh build during a review be allowed?

## F4 (question only, not in P1)
- The same call sites strip `emit_artifact` from every Coreview-enabled voice session, although the server declares it for ordinary turns.
- The runtime router already suppresses it during review (`:6833-6843`).
- Restoring it changes voice behaviour on every turn, so it needs a separate decision.

## Alternatives
| Alternative | Verdict |
|---|---|
| A backend dispatch happened but was not traced | **Excluded:** `start_builder_task` was not declared, so Gemini could not call it. If S0 shows the flag is false, this analysis is void and codex-039's open hypotheses stand. |
| A display or streaming failure | Excluded: no task existed. |
| The reconnect / 1008 close | Not a dispatch cause; a separate issue. |
| Zero memory admission | Not the cause; the separate recall issue. |

## P1 (frontend only; one PR on `codex/frontend-prod-083d4cb0` @ `87d471f2`)
**Changes:**
1. At `:3370` and `:3452`, add `allowGenericBuilderTools: true`, and keep `allowArtifactCreation: false`. Restrictions during a review stay with the existing runtime router.
2. Make non-launch results truthful:
   - `suppressedGenericBuilderToolResponse` (`:6958+`): for non-status calls, use a truthful "not started" message and add `builder_task_started: false`;
   - `noActiveStatusResult` (`coreview-builder-actions.ts:875`): add `builder_task_started: false` and keep `ok: true`.

**Tests:**
- **(a)** With the flag on, both the initial and the continuation setup contain the six generic tools and the three Coreview Builder tools, with `emit_artifact` absent. **This test must fail on `87d471f2` first.**
- **(b)** Outside a review, `start_builder_task` is relayed unchanged.
- **(c)** An empty status result has no `task_id` and `builder_task_started: false`.
- **(d)** `start_builder_task` during a review is still suppressed, with `builder_task_started: false` and no "I'll update" wording.
- **(e)** The existing review-routing tests stay green unchanged.

**Rollback:** instant rollback to `dpl_4jVRzMq4L1ANhx8nAWcR4uzBvptP`.

## P2 (separate approval; requires a voice deploy)
- **A prompt rule** added to `sophia_prompt.py:136`: never say a Builder or research task has started without `ok=true` and a `task_id` in this turn.
- **Sanitized tracing of browser-local and suppressed calls.**
  - For each call, the browser sends one record to the voice relay with: call id, name, route, ok, result, `blocked_reason`, `task_id`/`run_id`, and provider epoch.
  - It excludes argument text, transcripts, audio and credentials.
  - The backend **records it only and never executes it**, and traces it as `function_call:<name>` with `execution_owner=browser`.

## Evidence recovery
- The browser ledger is **not needed** to prove F1, and no new capture is needed before P1.
- The confirmation is the S0 flag readback plus test (a) failing on `87d471f2`.

## Acceptance after deploy (supervised by Davide)
- **The test:** one voice request for a small, explicit research task with Markdown delivery. It is a real Builder run.
- **It passes if all of these appear:**
  - `start_builder_task` in the ledger;
  - the voice log `start_builder_task launched … task_id … run_id`;
  - the LangSmith `function_call:start_builder_task` span;
  - progress, then the artifact;
  - Sophia's "started" line comes only after the launch result.
