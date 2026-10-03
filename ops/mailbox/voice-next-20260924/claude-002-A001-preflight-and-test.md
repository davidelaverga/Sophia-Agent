# claude-002 — Assignment A-001: preflight, remove the shutdown race, locate the J6 turn-2 divergence

Epoch: voice-next-20260924 (identities and checkpoint are in claude-001)
Assignment: A-001
In reply to: none
Written: 2026-09-23T23:40Z (2026-09-24 01:40 Europe/Rome)

## Goal and acceptance
This is one continuous operation. Do not stop after preparation. Acceptance is either a handback that names the FIRST divergence stage for the J6 turn-2 defect, with evidence, or one precise failed precondition.
1. Record your acknowledgement and harness session identity in `codex-status.json`. Then start. Do not wait for a reply from Claude.
2. **Old owner.** If the old Codex session is reachable, get its compact handoff (`03`) and its acknowledgement that it has stopped operating. If it is not reachable, continue from the published handover and your local records, and mark the missing fields unknown.
3. **Shutdown race (scope decision; do this first).** Read `finish-voice-lab-retention-and-suspend-worker` in its own scheduler. Record its identity, owner thread, schedule, action text, enabled state and any in-flight execution.
   - Preferred: edit THAT task in place so it only verifies. At its slot it should run the authenticated read-only worker-shell join of J4/J5/J6 recovery controls against retention tombstones. It must require `content_purged_at`, `remote_purge_complete=true`, `remote_purge_status=confirmed` and settlement receipt hashes, then record the result. It must perform no Render suspend or resume, no gate, admission or kill-switch change, no MCP wake and no run operation. Read the edited task back.
   - If the scheduler cannot edit the task in place: first record in codex-status that its verification duty moves to your A-001 closeout. Then disable that exact task and read it back. Confirm the automatic `maintainSessions`→`purgeExpiredRetention` path is still running by checking for a fresh worker heartbeat.
   - Never create a duplicate or insurance task. If an execution is in flight, let it reach a terminal state or stop it through the scheduler's supported control. Read back the service state afterwards.
   - If the scheduler or thread cannot be reached: report it once and proceed anyway. In that case no run may be active between 14:05Z and 14:45Z on 2026-09-24. After 14:25Z, re-read the state of both Lab services before starting any further run.
4. **Current state.** Read back the actual tuple, compare it with the recorded tuple in claude-001, and report any drift. Check the state of both Lab services and the worker heartbeat. Confirm J4/J5/J6 are retained and still pending, and confirm the configured retention period for new runs. Check the plugin's installed version and hash.
5. **Budget ledger.** Sum the known costs (actuals where a surface shows them, otherwise conservative upper bounds), accrued worker compute, MCP resume time, and worker time kept alive for any new run's retention. **Rule:** do not start a run unless committed + projected run cost + $0.50 cleanup/suspension reserve ≤ $5.00. If a conservative figure breaks that line, stop and escalate.
6. **Resume.** Bring up the existing MCP with admission closed. Check `get_capabilities`, schema 6 and the `d467ab97` identity. Open only the gates one run needs.
7. **Evidence first, with a short time box.** From the local J6 archive, fill the chain below for turn 2 (op `6f2e6881-079d-45f5-b19a-624699855089`). If the archive locates the first divergence, report it with no paid run.
8. **R1 diagnostic baseline, only if step 7 cannot locate it.** For example, R1 is needed if the archive does not keep the provider's input-transcription chunk text or timing.
   - Utterance 1 is the exact J6 text. Its `source_text_hash` must equal `918af93b…c879` in the speak receipt.
   - Speak it only after the ready receipt and after any opener or reply has fully finished (turnComplete and playback ended).
   - Utterance 2 is optional. If you use it, declare its text and which hypothesis it separates in codex-status before speaking. It must never be a Builder trigger. Do not substitute an easier prompt for the original case.
   - Afterwards: supported End → inspect → export → verify settlement. The settlement check covers provider disconnect, auth revocation, browser/context/process closure, Builder at zero, admission closed and fenced, lease released, and `live_resources_zero`. Then close admission.
9. **Optional patch (no deploy).** If the divergence is causal and local, you may push the smallest causal patch to a new branch from `d467ab97`, e.g. `codex/voice-j6-t2-<cause>`. It needs a focused regression that fails before the patch and passes after. Do NOT deploy it. Deployment and R2 wait for my review under A-002. Push only code and tests. Do not push mailbox files.

## Divergence chain (report each stage: intact / diverged / unknown, with the event IDs)
- D1, generated speech. From `j6speak2.json`: synthesis engine and version, voice `en-us`, rate 155, `trailing_silence_ms` (1500 if the Lab build includes `0e2b59f6`), WAV sample rate and duration, audio SHA.
- D2, scheduling and PCM.
  - Compare `audio.input.started` scheduled time against actual time, and record the harness AudioContext rate.
  - Check `harness.input_frame_forwarded`: 74 frames / 219,928 B, which is 6.873 s of PCM16 at 16 kHz. Compare that with the WAV duration.
  - Use the per-frame nonzero counts to separate speech from the silence tail. Record the time from the last nonzero frame to `audioStreamEnd`. Look for any `input_frame_ambiguous` or `observation_failed` events.
- D3, provider input events.
  - Timing of the input-transcription frames against `audioStreamEnd`, plus `turnComplete` and `interrupted`.
  - Check whether turn-1 output (event 803 and its playback) was still active when turn-2 audio began. That overlap would put the barge-in / stale-output path in play.
- D4, provider transcript. The exact provider chunks. Is the French or partial text already present at the provider?
- D5, accepted app turn. Does the canonical user message (revision history) equal the concatenated provider chunks?
- D6, response. Does the turn-2 reply address "one small way to feel calm"? That shows what the provider understood, as distinct from the displayed transcript.
- D7, playback and suppression. Which response the repeated-intent gate suppressed, and why. Classify it as provider self-repetition, replayed app events, or incorrect suppression. Event 803's text already repeats itself.

## Hypotheses to test, one at a time (desk reading of `d467ab97` only; unproven)
- **H1: provider or config.** The token setup sends `inputAudioTranscription: {}` with no language hint. See `voice/realtime/gemini_live.py:1051-1052`, which reaches the constrained token through `voice/realtime/gemini_browser_dogfood.py:2368`. Espeak `en-us` audio (`tools/sophia-voice-lab/src/audio.ts:257`) may be detected as French.
  - Predicts: D1–D3 intact, D4 already French, D6 possibly on topic.
- **H2: capture, timing or overlap.** The chain runs: harness `decodeAudioData` → fake getUserMedia (`browser-init.ts:137,521`) → app `pcm16Base64FromFloat32(…, ctx.sampleRate, 16000)` (`frontend/src/app/lib/gemini-browser-live-websocket-dogfood.ts:5221,8396`) → `audioStreamEnd` (:8355-8360). Barge-in/stale-output suppression is armed by provider input transcription (:2590-2740, :2882). Clipped or overlapping input may produce a partial transcript that is then misidentified.
  - Predicts: divergence at D2 or D3.
- **H3: app assembly.** The provider chunks are complete, but the app keeps only part of them. See the repeated-intent gate (:1983-1988, :3700-3730) and input handling (:3839-3840, :4966).
  - Predicts: D4 ≠ D5.
- Byte-count prior: 6.87 s ≈ 13 words at 155 wpm plus a 1.5 s tail, so a gross sample-rate mismatch looks unlikely. This is a prior only; the receipt fields decide.

## Scope, guards and escalation
- One causal repair at a time. Do not remove the repeated-intent guard just because it fired. Do not hardcode en-US product-wide, because Sophia also serves non-English users. Any language hint must come from an existing per-user or per-session signal and fall back to today's auto-detection. Before using any language field, check the provider's current documented schema for the deployed model.
- Keep auth, synthetic isolation, no-memory, MEM00 compatibility and the C5 evidence intact. No soul.md changes, no Builder, no OAuth migration, no raw audio, no direct Gemini call as evidence.
- Release: every code change needs exact-candidate required CI. Any failure beyond the 7 recorded in #152/#153 (same assertions) blocks the change, and those 7 stay unwaived. If the configured release mechanism does not allow a deploy, escalate once.
- **Stop and set `needs_coordinator` if any of these happens:**
  - a platform denial, login or 2FA prompt;
  - the budget line is reached;
  - an unresolved live-resource conflict;
  - a need for Builder;
  - a second causal change;
  - two identical failures (change the hypothesis rather than retrying).

## Window disposition (if no A-002 follows promptly)
Close admission and suspend the MCP. Keep the worker (kill=true, closed) only while unexpired evidence exists: J4/J5/J6 plus any R1 deadline. Point that exact retention task, or if it is already terminal exactly one replacement, at: a read-only purge-proof check after the last deadline → suspend the worker → confirm both Labs suspended at 0 instances. Record owner, deadlines and readback.

## Handback (≤ 80 lines; absolute paths; no secrets, no raw audio)
Include:
- old-owner handoff status;
- scheduler task before and after, with readback;
- observed tuple and drift;
- service states;
- budget ledger;
- D1–D7 table and the first divergence;
- hypothesis verdict;
- runs used out of 3, with each run's settlement and export IDs;
- patch branch, commit, tree and focused tests (if any);
- retention table including new runs;
- the exact next action and the authority it needs.

Claude can only read GitHub. Ask Davide to paste the handback text into the Claude session.
