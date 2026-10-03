# Voice Builder requests denied at LangGraph admission: final failure analysis

**Production code:** LangGraph `def5c454`, gateway `eb849b62`, web `6f6545d6` (and `e601de54`, whose diff only changes error reporting). Citations are `path:line@commit`.

- **READ** means I checked it in code at that commit.
- **INFERRED** means it is reasoning that has not been confirmed with production data.

**Date correction.** The "Sep 29" incident happened on **2026-09-28 at 23:49–23:50 UTC**. Decoding the UUIDv7 thread id `01a0ea63-535c…` gives a creation time of 23:39:33Z. PR #164 (`e601de54`) was committed at 23:28:38Z. The earlier incident was at 14:23Z on the same day, on the same backend commits.

---

## 1. Verdict

**Most likely root cause.** In a live voice session, the web app's own transcript persistence overwrites the source row that the gateway just recorded, within about 1–5 s of recording it. How it happens:

1. Recording bumps `message_revision`. The browser never takes the new revision from the receipt, so its next transcript PUT is rejected as a revision conflict.
2. The browser then re-reads the transcript. The gateway returns every `created_at` truncated to milliseconds.
3. If any voice transcript rows are still unsaved, the browser writes the merged list back with a second PUT. That rewrites the stored row's `created_at`.
4. A database trigger then gives the row a new `memory_source_version`. `recheck_recorded_source` fails with `source_changed`.
5. When that check runs after the rewrite, create_run returns 403. That is all three 23:49Z turns. When it runs before the rewrite, the run is admitted and then refused in before_agent at line 250 → 414. That is 14:23Z run 1.

**A separate, certain defect explains 14:23Z run 2.** `pending_input_recovery.py:73@def5c454` calls `store.source_action_receipt_for_message`, which does not exist anywhere in the repo. So any retry on a thread whose previous run failed in before_agent is refused at `memory_context.py:256`.

**Confidence:**
- About 0.7 that the cause is this family: browser transcript persistence changes the recorded row.
- About 0.6 that the first change was specifically the millisecond write-back after a conflict.
- The missing store method is certain.

**What is proven and what is not:**
- Every link in the chain is READ at the production commits.
- The chain was reproduced by running the real `def5c454` admission code against a store that mimics the SQL behaviour. A voice-shaped turn gave `ROTATED [created_at]`: it was admitted when checked before the rewrite and got HTTP 403 `sophia_access_denied` when checked after.
- The same class of failure was proven in production on 2026-09-22 (`docs/campaigns/mem00-durable-memory/c3-hosted-diagnostic-2026-09-22.md:11-17@eb849b62`). The fix at that time, `ef12097b`, only covered the local timestamp path.
- **Not proven:** that this rewrite actually happened in these five runs. One read-only query comparing each receipt with its stored row settles it (§6, Q1).

---

## 2. Ranked causes

The failure path is the same for every cause below. create_run calls `langgraph_auth.py:539-541`, then `input_provenance.py:117`, then `source_input_provenance.py:84`, then `recheck_recorded_source`. Every error is collapsed to one message at `source_input_provenance.py:67-68,85-86` (`from None`, so the reason is lost). The hook then calls `_deny()` at `langgraph_auth.py:549-550`, which returns 403 `{"detail":"sophia_access_denied"}` (`:55-56`).

| # | Cause | Failing check | Verifier verdicts | Fit with the 3 turns and the 14:23Z incident |
|---|---|---|---|---|
| 1 | **H1: the browser rewrites the recorded row after a conflict.** Recording inserts the row with `created_at=clock_timestamp()` (microseconds), `sequence=max+1`, and bumps the revision (`2026_09_09_mem00_c1_source_intake.sql:120-126@eb849b62`). The first PUT afterwards always conflicts (`useSessionStreamPersistence.ts:199-208,219@6f6545d6`; `reject_stale_session_snapshots.sql:37-47`). The browser re-GETs; the gateway truncates timestamps to ms (`session_store.py:285-288,304-315,1699@eb849b62`). The rebuilt list is PUT back when there are local additions (`useSessionStreamPersistence.ts:120-136,262-293`). The RPC updates the row because `created_at IS DISTINCT` (`reject_stale…sql:63-85`), and the version trigger fires (`2026_09_09_mem00_c1_dependency_authority.sql:75-87`). | `source_input_provenance.py:56-59@def5c454` (`source_changed`; at a nonzero clear epoch the row's eligibility becomes `accepted_version_changed`, which fails the same check) | code-path **plausible 0.55**, timing **plausible 0.68**, alternative **plausible 0.55**. All links confirmed in code; only whether it happened in production is open. | 23:49Z: each turn records a fresh row (`memory-source-client.ts:24@6f6545d6`), and the rewrite lands in the 3–5 s gap before create_run, so 403. 14:23Z run 1: create_run (about 44.1–44.9 s) came before the rewrite; the line-250 recheck came after it (by 46.369 s), so line 414. A 403 creates no run or checkpoint, so each of the three turns failed on its own. |
| 2 | **D1: missing store method.** | `pending_input_recovery.py:73@def5c454` raises AttributeError. It becomes `memory_pending_source_history_unproven` (`:95-96`), reported as `memory_context.py:256` | Confirmed in code by every verifier. It is also overdetermined: with the method present, the recheck of run 1's rewritten row at `:84-89` would still deny. | 14:23Z run 2 only. It passed its own current-source check at `:250`, then failed on run 1's unsealed input. It cannot produce a create_run 403. |
| 3 | **H2: other writes by the browser.** Position-based renumbering (`sessions.py:1666@eb849b62`), deletion after a lost update of `message_revision` (`session_store.py:2362-2370`; `reject_stale…sql:88-96`), or content cut by the view model. | `:56-59` (`source_changed`) or `:52-54` (`source_missing`) | **refuted as first cause** 0.7 / 0.7 / 0.65. These are real, but happen as second rewrites after H1's write, or need millisecond races on every turn. | Only as later rewrites. **The fix must still cover them.** |
| 4 | **H5: config drift after 14:24Z.** Different HMAC secret (gateway `source_intake.py:162` vs LangGraph `source_input_provenance.py:80-83`, giving `action_changed`), or a different Supabase project or key. | `:80-83` / `:77-78` | code-path **plausible 0.55** (HMAC variant only); timing **refuted 0.7**; alternative **refuted 0.75**. The grants and contract variants are refuted in code: both services use the same role, and the accept call passes the same authority check. | Would need an undocumented env change plus restart between 14:24Z and 23:49Z. Doesn't explain why only voice fails. A quick private comparison rules it in or out (§6). |
| 5 | **H4: transient store failure** (`store.py:122-132@def5c454` maps it to `_deny`) | Any of the 5 store calls in create_run | code-path **plausible 0.15**; timing **refuted 0.78**; alternative **refuted 0.72** | The timeout variant is impossible: the client timeout is 10 s (`store.py:93`) but the whole window was 3–5 s. The gateway ran the same `resolve_owner_authority` and the accept RPC successfully 1–3 s before each 403. It would need four independent failures, all on voice turns. |
| 6 | **H3: a static problem in the 23:49Z session** (snapshot partition, trailing NEL/U+001C-1F in content, status flip) | `2026_09_09_mem00_c1_epoch_source_target.sql:17-23,32-40`; `input_provenance.py:115-116` | **refuted** 0.75 / 0.8 / 0.72 | No writer can create a lasting partition violation. Both web sanitizers strip `\x0E-\x1F`. Fences are permanent and the recording step checks for them. |

---

## 3. Why voice fails and typed text does not

Recording always makes the first transcript PUT afterwards conflict, for typed text and voice alike. The difference is the branch taken after the conflict (`useSessionStreamPersistence.ts:246-293@6f6545d6`):

**Typed text.**
- At the first conflict the only new local rows are the source message itself (already on the server) and the incomplete trailing assistant reply. The reply is filtered out while the chat status is submitted or streaming (`:464,493`).
- So the rebuilt list equals the server copy, and nothing is written (`:262-269`).
- Later ordinary PUTs carry the receipt's exact microsecond string (pinned at `useSessionSendActions.ts:182-186`) and the same position, so the row is never updated.
- This matches the Sep 22 typed pilot passing on `def5c454`. Verifiers report the persistence and send code is identical between `b103c4af` and `6f6545d6`.

**Voice.** Voice transcript rows are appended to the same chat list (`useSessionVoiceMessages.ts:62-154@6f6545d6`), so new local rows are likely at the first conflict:
- Any input-transcript chunk that arrives after the hidden message is appended gets a **new** `voice-user-*` id, because the last message is no longer a voice-user row (`:74-103`).
- The bridge waits up to 1.5 s for exactly these late transcripts (`gemini-browser-live-websocket-dogfood.ts:1860,6581-6593`).
- Voice rows appended before the hidden message, whose debounced PUT (150/700 ms, `:531-535`) had not been accepted when recording committed, also count as new.

Verifier caveat: a trailing voice-assistant row after the hidden message does not count on its own, because it is filtered as incomplete. So this is a race that voice makes likely, not a certainty.

**Would typed text fail the same way?**
- **Quiet typed session:** no (READ path above).
- **Typed send while voice transcripts are arriving:** yes, the same failure (INFERRED). The trigger is transcript activity around recording, not how the build request was produced.
- **Latent typed risk (INFERRED, untested):** after a page reload or a hide-page beacon, snapshots carry the gateway's millisecond timestamps (`useSessionStreamPersistence.ts:408-446`). An accepted PUT would then rewrite older recorded rows, and later turns would fail at 266 → 414. Typed text is protected by timing luck, not by design.

**Two UI loose ends. Neither changes the root cause.**
- Under `e601de54`, a create_run 403 should be labelled "unconfirmed". "Not sent" for attempt 3 would need a `memory_context_rotation_required` stream error before any activity (`voice-builder-actions.ts:76-97@e601de54`). The operator's 403 table is authoritative; the label may be Gemini paraphrasing.
- `useChat.onError` shows "Connection interrupted. Retry?" on every governed failure (`chat-runtime.ts:61-65`, `error-copy.ts:2`). The operator separately attributed the banner to Gemini `connection_lost`.

---

## 4. Relationship to the earlier `memory_context_rotation_required` incident (14:23Z)

It is **the same mechanism at a later stage, plus the separate defect.**

- **The label.** `memory_context_rotation_required` is a catch-all. `MemoryContextUnavailable` always carries that text (`memory_context.py:60-62`), and every refusal in `enter()` is re-raised as it (`:321-352`). Nothing actually rotated a thread.
- **Run 1** (`01a0e866-77b0…`):
  - Thread created at 14:22:15Z (89 s earlier), so most likely the first companion run.
  - Run id minted at 44.560; run created at 44.914, so create_run's recheck passed around then.
  - `enter()` re-ran the same `recheck_recorded_source` at `:250` → `_check_source` `:414` and failed by 46.369.
  - So the row changed inside that window of about 1.4 s.
  - `denied_at_line` records the deepest frame in the module (`:334-339`). So 414 cannot tell `:250` apart from `:266`. With no prior runs on the thread, `:250` is the likely one.
- **Run 2** (`01a0e866-b0c7…`):
  - Passed create_run and its own current-source check at `:250`, so its own row, the snapshot and the store were healthy at about 14:24:00.9.
  - It then failed at `:256`. Run 1 had left its input message unsealed in the checkpoint (`MemoryContextEntryMiddleware` runs first, so only messages exist), and `checkpoint_source_history` reached the missing method at `:73`.
  - This rules out a static owner, config or store mismatch at 14:24Z.
- **The timing contrast between the two incidents.** It is consistent with one race whose outcome depended on timing, but not established:
  - The operator's "2,227 ms" runs from LangGraph request start to denial; creation to denial is 1,455 ms.
  - The 14:23Z recording times are unknown.
  - Backend code was identical on both days. The only change in between was PR #164, which only touches error reporting (`turn-error-transport.ts`; the request body is unchanged).
- **The voice bridge is new.** It shipped in `a1635523` (2026-09-27). Both incidents are among its first production uses, and no voice-bridged governed turn has ever passed.

---

## 5. Fix design

### 5.1 Required: recorded sources become write-once in the database (new forward migration)

All transcript writers go through one RPC:
- `sessions.py:1516,1620,1670@eb849b62`: GET fallback, synthetic sessions, PUT and its beacon alias.
- `sophia.py:1769,1777@eb849b62`: end-of-session transcript.

So the invariant belongs in `sophia_replace_session_messages`. Add `backend/migrations/2026_09_xx_mem00_c3_anchor_recorded_sources.sql`, which does `CREATE OR REPLACE` of that function (same signature, same SECURITY DEFINER and search_path, grants unchanged), under the existing session-row `FOR UPDATE`:

1. **Define the protected set.**
   - Protected rows are rows of `(p_user_id, p_session_id)` whose `id` appears as `source_intake_receipt->>'source_row_id'` in `sophia_memory_governance_events` with `event_type='memory_source_action_accepted'`.
   - Lookup is an index probe via `sophia_memory_source_intake_row_identity` (`source_intake.sql:6-7`).
   - These are exactly the rows LangGraph pins. `chat_context_recovery.py:56,87-98@def5c454` rebuilds only from user rows that have receipts: "Old assistant/tool output is never a reconstruction input".
2. **Never update a protected row.**
   - Add `AND NOT protected` to the `ON CONFLICT … DO UPDATE WHERE` (`reject_stale…sql:75-85`).
   - Client values for content, `created_at`, sequence, source and metadata are ignored for these rows. The row written by `sophia_memory_accept_source_action` is the authority.
3. **Never delete a protected row by leaving it out of a snapshot.** Add `AND NOT protected` to the DELETE (`:88-96`). The receipt is already immutable (`source_intake.sql:39-51`), so the row must be too.
4. **Keep sequences unique around protected rows.**
   - The snapshot refuses duplicate sequences (`epoch_source_target.sql:33-34`). Pinning protected rows while unprotected rows keep position-based sequences (`sessions.py:1666`) could collide.
   - Rule: walk `p_messages` in order with a cursor `c=0`. For a protected item, `c := max(c, stored_sequence)`. For any other item, assign the smallest integer greater than `c` that no protected row in the session holds.
   - This keeps sequences unique by construction and roughly preserves client order. Unprotected rows may get new versions, which is harmless.
5. **Unchanged:** the stale-revision contract (`:37-47`) and when the revision is bumped (only on real changes).
6. **Backstop trigger.** Add `BEFORE UPDATE ON sophia_session_messages`: raise `23514 memory_source_anchor_immutable` when `OLD.id` is protected and `(to_jsonb(NEW)-'memory_source_version') IS DISTINCT FROM (to_jsonb(OLD)-'memory_source_version')`.
   - It does not guard DELETE, so ordinary session deletion (`2026_09_06_mem00_ordinary_session_delete_order.sql:45`) and Voice Lab cleanup (`2026_08_23_voice_lab_cleanup_obligation_indexes.sql:3370,3577`) keep working.
   - Any future writer that tries to change a source then fails loudly instead of silently changing its version.

**Why this is the minimal correct fix:**
- It fixes all the verified ways the row gets changed at once: the millisecond write-back, renumbering, deletion after a lost revision update, content cuts, beacon or reload writes, the GET fallback, and the end-of-session rewrite of `source` to the platform (`sophia.py:1703-1798`).
- It does not depend on settling H1 versus H2.
- **A browser-only fix is not enough:**
  - Taking `receipt.transcript_revision` into the browser would let a local-order PUT through, which renumbers the row (H2).
  - Pinning receipt timestamps during the rebase leaves reload, beacon, end-of-session and other future clients exposed.

### 5.2 Required: implement the missing store method (LangGraph)

- **SQL** (same migration): new read-only `sophia_memory_lookup_source_action_by_message(p_user_id, p_session_id, p_message_id)`.
  - It uses the same governed/contract `42501` gate as `sophia_memory_lookup_source_action` (`source_intake.sql:144-148`).
  - It selects through the unique index `sophia_memory_source_intake_message_identity` (`:8-9`) and returns the receipt with `idempotent_replay:true`, or raises if there is none.
  - Access: SECURITY DEFINER; `REVOKE` from `PUBLIC, anon, authenticated`; grant it exactly as the existing lookup is granted in production (verify with Q5).
- **Python:** add `SupabaseMemoryGovernanceStore.source_action_receipt_for_message(*, user_id, session_id, message_id)` next to `store.py:567-571@def5c454`.
- **The receipt is still not a permit.** `pending_input_recovery.py:76-89` keeps requiring scope, order, `content_ref` equal to the HMAC of the checkpoint message, and a full `recheck_recorded_source` of that row.

### 5.3 Not required, but recommended hygiene

- **Web:** in `historyMessageToPersisted` / the rebase (`useSessionStreamPersistence.ts:93-107,120-136`), stop using the GET's millisecond projection as write input for ids the client already has a timestamp for. This reduces pointless new versions on unprotected rows.
- **Gateway:** make `_store.update` (`session_store.py:2362-2370@eb849b62`) a column-scoped PATCH that never writes `message_revision`. This removes the lost-update race (H2(b)) for ordinary transcripts.

### 5.4 What the fix preserves

- **Authentication and owner isolation.** No change to `authenticate`/`create_run` guards or the 403 body. The protected set and the new lookup are scoped by `(user_id, session_id)` and gated on governed authority.
- **Source immutability.** Strengthened. The version trigger, the receipt-immutable trigger, the accepted-version trigger and `recheck_recorded_source` are all unchanged.
- **No receipt-as-permit.** create_run still needs receipt, witness, snapshot and an unchanged row. Pending recovery still rechecks the row.
- **Companion-minted Builder handoff proof.** The `bind_builder_run` branch (`langgraph_auth.py:515-535`) is untouched. The Builder binding's SQL check on sequence and version (`2026_09_14_mem00_c2_model_authority.sql:194-203@def5c454`) now holds for the whole run, because the parent row can no longer change.
- **No duplicate tasks.**
  - No new retries. Governed sends still never retry or fall back to a fresh thread (`backend-client.ts:392,398,414@6f6545d6`).
  - Every explicit request still mints a new `command_key` and `message_id`.
  - Existing dedupe stays in place: `memory_source_dispatch_busy` (`useSessionSendActions.ts:136-139`) and `builder_already_running` (`voice-builder-actions.ts:277-288`).

### 5.5 Tests to add

- **Migration and SQL** (following `backend/tests/test_mem00_delete_order_migration.py`, run against real Postgres):
  1. Record a source, then replace with the same id but a millisecond `created_at`, a different sequence, content, source and metadata. Expect: row unchanged, version equal to the receipt's, and `sophia_memory_source_snapshot` returns it as `eligible`.
  2. Replace without the protected id. Expect: the row still exists.
  3. Voice interleaving: a new unprotected row placed before the protected row. Expect: the snapshot sequences are unique, the protected sequence equals the receipt's, and there is no partition error.
  4. The stale-revision conflict still writes nothing.
  5. A direct UPDATE of a protected row raises `23514`. Ordinary session delete still works.
  6. The by-message lookup keeps owners and sessions apart, raises `42501` for a non-governed owner, and returns exactly one receipt.
- **Backend Python:**
  7. The real `langgraph_auth.create_run` with recording, a voice-shaped conflict/GET/rebase PUT, then create_run. Expect admitted, and the `:250` recheck passes. Start from the scratch harness `scratchpad/scratch_403_create_run.py`, which reproduces the 403 today.
  8. `checkpoint_source_history` with an unsealed pending input, using `create_autospec(SupabaseMemoryGovernanceStore)`. Expect: passes when the row is intact, denied when it was rewritten.
  9. A contract test: every `store.<name>(` call under `deerflow/sophia/memory_governance/` must exist on `SupabaseMemoryGovernanceStore`. It would have caught D1. Also make `backend/tests/mem00_recorded_input_fixture.py` autospec'd.
- **Frontend** (`useSessionStreamPersistence.test.ts`, `voice-builder-actions.test.ts`):
  10. Governed send, then a `voice-user-*` row appended after it, then first PUT conflict, then GET with millisecond timestamps, then the rebuilt PUT. Assert the request shape and that convergence needs at most one extra round trip.
  11. After a 403, the voice bridge starts no second task, and a running build blocks a new start.

**Operations note.** Thread `01a0e865…` stays permanently refused at `:256` even after the fix, because run 1's row really was rewritten. That is correct fail-closed behaviour: use a new session. Deploy order: migration first (the RPC signature is unchanged), then LangGraph, since the store method needs the new RPC. Gateway and web need no redeploy.

---

## 6. Read-only production evidence asks

For an operator with Render logs and Supabase read access. Run the SQL in the Supabase SQL editor as read-only. No content, owner ids or secrets are printed.

**Time windows (UTC, 2026-09-28):**
- **W1:** 23:49:35–23:49:46 (LangGraph request `d87e0f5e…`)
- **W2:** 23:49:58–23:50:07 (`36269a8b…`)
- **W3:** 23:50:28–23:50:38 (`a5b0746d…`)
- **W0a:** 14:23:25–14:23:47 (request `4f12fdb7-f6fb-4094-bf0d-92e7b0f34356`)
- **W0b:** 14:23:47–14:24:02 (request `ac6eecf6-10a8-4c59-8cc5-ee28d1d43e3c`)

**Q0: sessions behind the two threads.**
```sql
SELECT s.id AS session_id, s.thread_id, s.status, s.message_revision, s.updated_at,
       coalesce(s.metadata,'{}') ? 'synthetic_voice_lab' AS synthetic
FROM public.sophia_sessions s
WHERE s.thread_id IN ('01a0ea63-535c-7843-a35e-b49581d10201','01a0e865-1a34-7ac0-9863-42ddf7a72633');
```

**Q1: the decisive comparison of each receipt with its row.**
```sql
WITH s AS (SELECT id, user_id, thread_id, message_revision FROM public.sophia_sessions
           WHERE thread_id IN ('01a0ea63-535c-7843-a35e-b49581d10201','01a0e865-1a34-7ac0-9863-42ddf7a72633')),
r AS (SELECT s.thread_id, s.message_revision, e.user_id, e.source_session_id, e.source_intake_receipt rc
      FROM public.sophia_memory_governance_events e JOIN s ON s.id=e.source_session_id AND s.user_id=e.user_id
      WHERE e.event_type='memory_source_action_accepted')
SELECT r.thread_id, r.rc->>'created_at' receipt_created_at, (r.rc->>'sequence')::bigint receipt_seq,
       r.message_revision-(r.rc->>'transcript_revision')::bigint revisions_since_intake,
       (r.rc->>'memory_clear_epoch')::bigint receipt_epoch,
       m.id IS NOT NULL row_exists,
       m.memory_source_version::text = r.rc->>'source_version' version_equal,
       m.sequence = (r.rc->>'sequence')::bigint sequence_equal,
       m.created_at = (r.rc->>'created_at')::timestamptz created_at_equal,
       m.created_at = date_trunc('milliseconds',(r.rc->>'created_at')::timestamptz) created_at_ms_truncated,
       m.memory_source_acceptance_epoch = (r.rc->>'memory_clear_epoch')::bigint epoch_equal,
       m.source, m.final, m.role, m.metadata = '{"redaction_level":"none"}'::jsonb metadata_unchanged,
       m.thread_id = r.rc->>'thread_id' thread_equal,
       m.content ~* '(^|\n)\s*user(\s*_?\s*message)?\s*:' has_user_label_line,
       m.content ~ E'^\u0085|\u0085$' nel_at_edge,
       (SELECT count(*) FROM public.sophia_session_messages x WHERE x.user_id=r.user_id
          AND x.session_id=r.source_session_id AND x.message_id=r.rc->>'message_id') rows_with_message_id
FROM r LEFT JOIN public.sophia_session_messages m ON m.id = r.rc->>'source_row_id'
ORDER BY (r.rc->>'created_at')::timestamptz;
```

**Q2: row order around each recorded row.** Show voice interleaving; no content.
```sql
SELECT s.thread_id, m.sequence, m.role, m.source, m.created_at, left(m.message_id,24) id_prefix,
       EXISTS(SELECT 1 FROM public.sophia_memory_governance_events e
              WHERE e.source_intake_receipt->>'source_row_id'=m.id) is_intake_row
FROM public.sophia_session_messages m JOIN public.sophia_sessions s ON s.id=m.session_id AND s.user_id=m.user_id
WHERE s.thread_id IN ('01a0ea63-535c-7843-a35e-b49581d10201','01a0e865-1a34-7ac0-9863-42ddf7a72633')
ORDER BY s.thread_id, m.sequence;
```

**Q3: epoch, contract, fence and partition state.**
```sql
SELECT g.authority_state, g.authority_epoch, g.memory_clear_epoch, c.schema_version, c.contract_epoch, c.mode
FROM public.sophia_memory_user_governance g JOIN public.sophia_sessions s ON s.user_id=g.user_id
CROSS JOIN public.sophia_memory_contract c
WHERE c.singleton AND s.thread_id='01a0ea63-535c-7843-a35e-b49581d10201';

SELECT e.event_type, count(*), bool_or(coalesce(e.source_fence,false)) any_fence
FROM public.sophia_memory_governance_events e JOIN public.sophia_sessions s ON s.id=e.source_session_id AND s.user_id=e.user_id
WHERE s.thread_id IN ('01a0ea63-535c-7843-a35e-b49581d10201','01a0e865-1a34-7ac0-9863-42ddf7a72633')
GROUP BY e.event_type;

-- STABLE, read-only; raises 42501 with a named reason if the current partition/session is invalid
SELECT public.sophia_memory_source_snapshot(s.user_id, s.id, s.thread_id) ? 'snapshot_id' AS snapshot_ok
FROM public.sophia_sessions s WHERE s.thread_id='01a0ea63-535c-7843-a35e-b49581d10201';
```

**Q4: logs.**
- **Render `sophia-gateway`, W1–W3 and W0a/b.** Search `/api/v1/sessions/<session_id from Q0>/`. List time, method, path suffix and status for `memory-source-actions`, `messages` (PUT, GET, POST), `touch`, `memory-source-profile`, plus `/api/sophia-auth/memory-authority` and `sessions/open`. A conflicting PUT also returns 200, so read the call pattern, not the status. A GET between two PUTs is the conflict signature. For W0a/b this also gives the unknown 14:23Z recording times.
- **Render `sophia-langgraph`.**
  - Search the five request ids above and read each response duration.
  - Within ±3 s of each, look for httpx lines `rpc/sophia_memory_lookup_source_action`, `rpc/sophia_memory_source_snapshot` and `sophia_memory_contract` / `sophia_memory_user_governance` with their statuses.
  - For W0a/b, find `memory.context.entry_denied` and record `error_type` and `denied_at_line`.
- **Supabase Logs Explorer (API/edge logs), same windows.**
  - Paths: `/rest/v1/rpc/sophia_memory_accept_source_action`, `/rest/v1/rpc/sophia_replace_session_messages`, `/rest/v1/rpc/sophia_memory_lookup_source_action`, `/rest/v1/rpc/sophia_memory_source_snapshot`, and `POST /rest/v1/sophia_sessions` (whole-row upserts).
  - Record timestamp and status. Tell gateway calls from LangGraph calls by source IP or user agent; both use `service_role`.
- **Vercel.** `/api/chat` and `/api/sessions/[...path]` calls in W1–W3: duration and cold starts. This explains the 3–5 s gap.

**Q5: configuration parity (H5).**
- Render events: any env edit, deploy or restart of either backend service between 2026-09-28T14:24Z and 23:50Z.
- Compare `SOPHIA_MEMORY_REFERENCE_HMAC_SECRET`, `SUPABASE_SERVICE_ROLE_KEY` and the `SUPABASE_URL` host between the two services privately, and report **equal / not equal** only.
- Grants:

  ```sql
  SELECT has_function_privilege('service_role','public.sophia_memory_lookup_source_action(text,text)','EXECUTE'),
         has_function_privilege('service_role','public.sophia_memory_source_snapshot(text,text,text)','EXECUTE');
  ```

**What each result means:**

| Result | Meaning |
|---|---|
| Q1 `version_equal = true` for a failed turn | H1 and H2 **refuted** for that turn, because versions never revert. Go to Q3, Q4 (LangGraph and Supabase) and Q5. |
| `version_equal = false`, `sequence_equal = true`, `created_at_ms_truncated = true` | **H1 confirmed**. If `created_at_equal = true` instead, a later local PUT wrote the microseconds back; the version still proves the rewrite. |
| `sequence_equal = false` | H2 renumbering. The fix covers it too. |
| `row_exists = false` | Deletion: H2(b) or the GET fallback. |
| `rows_with_message_id > 1`, or Q3 snapshot raises `partition` | H3. |
| `nel_at_edge` or `has_user_label_line` true | Content-transform edge case. |
| `revisions_since_intake ≥ 1` | Replace writes happened after recording. Q4 gives their order. |
| Gateway log shows PUT → GET → PUT **before** the matching 403 | Race order confirmed. No PUT before the 403 rules out H1 for that turn. |
| LangGraph/Supabase: lookup, lookup, then snapshot 200 before the 403 | A Python comparison failed (`source_changed`/`missing`), consistent with H1/H2. |
| Snapshot returns 4xx | SQL refusal (H3). |
| Only one lookup and no snapshot | Witness mismatch (H5 HMAC) or `source_not_recorded` (H5 project). |
| 5xx, transport error, or a duration ≥ 10 s | H4. |
| Q5 fingerprints differ, or an env change or restart in the window | H5 confirmed. |
| Q3 `memory_clear_epoch` ≠ receipt epoch | Epoch change, `source_scope_or_epoch`. |

---

## 7. Observability gap

**Why nothing is visible today:**
- The exact reason is raised as a fixed literal (`scope`, `original_receipt`, `source_scope_or_epoch`, `source_missing`, `source_changed`, `source_acceptance_changed`, `thread`, `source_not_recorded`, `action_changed`) and then discarded by `raise … from None` at `source_input_provenance.py:67-68,85-86@def5c454` and `pending_input_recovery.py:95-96`.
- create_run logs nothing (`langgraph_auth.py:549-550`).
- before_agent logs a fixed `safe_reason_code` (`memory_context.py:347-349`).
- The web discards the upstream body without logging (`post-handler.ts:291-299@6f6545d6`).

**Smallest change, about 30 lines of Python, with no content and no change to the response body:**
1. **Keep the reason code.** In the three `except` blocks, keep `from None` so exception text is never chained. Set `err.safe_reason` to the raised literal only if it is in a fixed allowlist. For store errors, use the store's own safe code (`governance_http_4xx`, `governance_transport_error`, `governance_invalid_json`, `store.py:122-138`). Otherwise use the exception class name. For `source_changed`, also attach `row_eligibility` (an enum value) and three booleans: `sequence_equal`, `version_equal`, `epoch_equal`.
2. **Log in create_run.** At `langgraph_auth.py:549`, before `_deny()`, emit one `memory.admission.denied` event through the same emitter and `keyed_ref` hashing used at `memory_context.py:342-349`. Include `safe_reason_code`, `error_type`, `stage` (`owner_authority` | `recorded_input`), and `owner_ref` / `context_ref` / `run_ref`. The HTTP body stays `sophia_access_denied`.
3. **Improve the before_agent event.** At `memory_context.py:333-349`, report `safe_reason_code=getattr(exc,"safe_reason",…)` instead of the fixed label. Add `entry_line`, the shallowest frame inside `enter()`, so 250 and 266 can be told apart; today only the deepest line (414) is kept.
4. **Optional, in the same PR:** in `post-handler.ts:291-299`, log the governed upstream status and LangGraph's request id server-side only. Separately, transport and 5xx store failures in create_run could return `503` instead of `403`. That does not weaken governance: the run is still refused, but outages stop looking like policy denials.