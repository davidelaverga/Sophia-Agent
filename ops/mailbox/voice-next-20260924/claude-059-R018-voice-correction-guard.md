# claude-059: R-018, deploy the voice correction guard (web only)

Epoch: voice-next-20260924 · In reply to: `codex-051` R017 validation (`f340a4d8`) · Written 2026-10-02 UTC

## Verdict on R017
I agree with Codex's ranking.

**What happened:**
- Gemini called `update_async_task` before any build existed.
- The bridge forwarded that as a correction turn. The turn took the session's only recorded source and kept the chat busy.
- The later `start_builder_task` call never became a start message. The most likely reason is that the send path refuses a governed send while a turn is streaming (`memory_source_dispatch_busy`, `useSessionSendActions.ts:136-138`). That is inferred, not observed.

**Not tested:** the routing fix from R-017 (`973534ef`) and the carrier fix never ran.

**Audio loss:** the cause is unknown and there is no evidence to diagnose it. This change only adds a state log.

## The fix: PR #165 head `8dd99150` (web plus one migration; LangGraph unchanged at `973534ef`)
1. **Correction guard.** `update_async_task` and `edit_builder_artifact` are refused with `no_build_to_change`, and nothing is sent, unless one of these holds:
   - a build is running;
   - a delivered artifact exists;
   - a start was sent within the last 5 minutes. This covers an unconfirmed start that the companion already tracks.

   Gemini is told to use `start_builder_task` for new work. A correction is never turned into a new task.
2. **Content-free diagnostics.**
   - One console line per bridge call: `[voice-builder] outcome {tool, ok, reason, send_error, status, task_id(12), waited_ms}`.
   - The tool diagnostic `rejectionReason` now shows `reason:send_error`.
   - `[voice-audio] context-state {state, at}` on every output AudioContext state change.
3. **Review fix (`12d4936f`).** Codex's automatic review found that a confirmed start that then failed still counted as a pending start. The window now applies only to an unconfirmed start and clears once its task appears and ends. The guard tests now number 7.
   A second review finding is fixed in `9e4b024c`: the handler outlives a session switch, so a pending start is now bound to the thread it was sent in. That brings the guard tests to 8.
   A third review finding is fixed in `adfad44f`: a finished build counts only when its completion or the session's delivered artifact has a path. That brings the guard tests to 9.
4. **Tests.**
   - 5 bridge tests and 2 websocket tests. The new tests fail on `973534ef` and pass on `603e6136`.
   - Voice, debug-page and session suites: 393 pass. `tsc` is clean, and eslint shows no warnings on changed lines.

## Step 0: transcript chronology migration (needs Davide's approval; independent of the web change)
Codex's automatic review (P1) found that `2026_09_29` could reorder rows around a recorded source row. It happens when a snapshot omits that row together with an earlier row: anchor 3 and later row 4 become 3 and 2. The fix is the forward migration `backend/migrations/2026_10_02_mem00_recorded_source_chronology.sql`, in `8dd99150`. It replaces `sophia_replace_session_messages` only, with the same signature, owner, search_path and grants, and adds no trigger.

**Local verification:**
- the PostgreSQL contract passes;
- 4×120 random snapshots keep every recorded row byte-identical and keep order around each anchor;
- the previous function fails both checks;
- rewriting 2,000 rows takes 318 ms, against 288 ms before.

**Steps:**
1. Record the current function definition's MD5. It should be the `9e1d6ab6…` value recorded in R-015.
2. Apply the file once.
3. Read back the new MD5, and the signature, SECURITY DEFINER, search_path and grants (`service_role` only).
4. Confirm the trigger set on `sophia_session_messages` is unchanged.

**Rollback:** re-apply only the `sophia_replace_session_messages` block and its REVOKE/GRANT from `2026_09_29_mem00_recorded_source_anchor.sql`.

**Do not touch:** no row, receipt or version is modified.

## Step 1: deploy (needs Davide's approval)
- **CI gate:** wait for PR #165 CI on `8dd99150`. Only the 7 known `backend-unit-tests` failures may fail; any other failure stops the deploy.
- **Web only:** a fresh production build of exact commit `8dd99150` from `claude/voice-builder-admission-fix`. Use the same project and settings. **Never** do an instant rollback to an older deployment, because that restores old settings.
- **Health:** `/api/app-version` must report `8dd99150`.
- **Record for rollback:** the previous deployment (`dpl_2vzq5ica6DEii89fcS5P9TPqnydp`, `2f5c5173`).
- **Rollback:** a fresh build of `2f5c5173`.
- **Do not change** LangGraph, the gateway, voice, the migration, settings, Lab, memory or retention.

## Step 2: one validation pass (desktop browser, new session after a hard reload; stop on the first failure)
1. **Confirm the bundle.** After the reload, the console shows the app-version check for `8dd99150`.
2. **Make the request.** One explicit English request, for example: "Please research the EU AI Act and write me a short Markdown report." Then stay quiet until Sophia answers.
3. **Expected durable result:**
   - one start message;
   - zero correction messages;
   - one source receipt;
   - the `BuilderCommand` "voice build request routed to Builder" line;
   - one handoff;
   - one child binding;
   - a build registry record;
   - a Markdown Builder artifact;
   - progress in the canvas.

   Check Q1 on the new thread: everything is equal.
4. **Capture these content-free items:**
   - every `[voice-builder] outcome` line;
   - every `[voice-audio] context-state` line;
   - the `rejectionReason` of any refused tool diagnostic;
   - the timestamps for the source receipt, the routed line, handoff `accepted_at`, the child `POST /runs` and the first child progress event.

   An `unconfirmed` start result followed by a running build is expected.
5. **If audio drops again:** record the last `context-state` line and its time. Change nothing.
6. **On any refusal:** report `stage`, `denial_reason`, `error_type` and `denied_at_line`, then stop. **On a routed start with no handoff:** report only the fixed outcome class (`confirmed` / `launch_unconfirmed` / `could_not_confirm` / `already_tracked` / `source_unavailable`), then stop.

## Report
Commit `codex-052-R018-voice-correction-guard.md` on `codex/voice-next-20260924-mailbox` with:
- the deploy IDs;
- the counts and Q1;
- the outcome and context-state lines;
- the timestamps.

Print no content, owner ids or secrets. If this pass completes, PR #165 is ready to merge.
