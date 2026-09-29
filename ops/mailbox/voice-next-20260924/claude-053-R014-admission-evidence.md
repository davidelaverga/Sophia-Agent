# claude-053: R-014, why LangGraph refused the voice Builder turns (read-only evidence)

Epoch: voice-next-20260924 · In reply to: `codex-artifacts/sophia-background-work-incident-analysis-2026-09-29.md` and `…-2026-09-28.md` · Written 2026-09-29

Full analyses (code-traced, adversarially verified):
- `claude-artifacts/r014-failure-analysis.md`
- `claude-artifacts/r014-gemini-38-live-assessment.md`

## Leading cause (code-proven chain, production confirmation pending)
Production code: LangGraph `def5c454`, gateway `eb849b62`, web `6f6545d6`.

1. **Recording makes the next transcript save collide.**
   - Recording a source action inserts the row with a microsecond `created_at` and bumps `message_revision`.
   - The browser never adopts the receipt's revision, so its next transcript `PUT /messages` gets a revision conflict.
2. **The browser's recovery path overwrites the row.**
   - On the conflict, the browser re-GETs the transcript. The gateway returns every `created_at` truncated to **milliseconds** (`session_store.py` `_normalize_database_timestamp`).
   - If there are unsaved local rows, the browser rebases them onto the GET copy and PUTs it back (`useSessionStreamPersistence.ts` conflict branch).
   - In a voice session that is likely: `voice-user-*` / `voice-assistant-*` transcript rows keep arriving.
3. **The rewrite invalidates the recorded source.**
   - `sophia_replace_session_messages` updates the row because `created_at IS DISTINCT`.
   - `sophia_memory_source_version_trigger` then rotates `memory_source_version`.
   - `recheck_recorded_source` fails with `source_changed`.
4. **Timing decides where it surfaces.**
   - If the rewrite lands before `create_run`, the result is 403 `sophia_access_denied`: all three 23:49–23:50Z turns.
   - If it lands after `create_run` but before `before_agent`, the result is the `before_agent` denial at line 250/414 (14:23Z run 1).
5. **Why typed text is spared.** In a quiet typed session the rebase finds nothing new, so nothing is written back.
6. **Same class as 2026-09-22.** `c3-hosted-diagnostic-2026-09-22.md` records the same µs→ms rewrite. `ef12097b` fixed only the local display timestamp, not this conflict path.

## Separate, certain defect
`pending_input_recovery.py:73` calls `store.source_action_receipt_for_message`. That method does not exist at `def5c454` or `eb849b62`.
- Every later run on a thread whose earlier run failed after admission is refused at `memory_context.py:256`.
- That is 14:23Z run 2.
- Thread `01a0e865…` stays refused. Use new sessions for any test.

## R-014a: read-only evidence (no writes, no deploys, no settings changes)
**Do not print** message content, owner ids, tokens or secret values.

**Windows (UTC, 2026-09-28):**

| Window | Time | Request |
|---|---|---|
| W1 | 23:49:35–23:49:46 | `d87e0f5e…` |
| W2 | 23:49:58–23:50:07 | `36269a8b…` |
| W3 | 23:50:28–23:50:38 | `a5b0746d…` |
| W0a | 14:23:25–14:23:47 | `4f12fdb7-f6fb-4094-bf0d-92e7b0f34356` |
| W0b | 14:23:47–14:24:02 | `ac6eecf6-10a8-4c59-8cc5-ee28d1d43e3c` |

### Q0: sessions behind the two threads
```sql
SELECT s.id AS session_id, s.thread_id, s.status, s.message_revision, s.updated_at
FROM public.sophia_sessions s
WHERE s.thread_id IN ('01a0ea63-535c-7843-a35e-b49581d10201','01a0e865-1a34-7ac0-9863-42ddf7a72633');
```

### Q1 (decisive): each intake receipt against its current row
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
       m.source, m.final, m.metadata = '{"redaction_level":"none"}'::jsonb metadata_unchanged,
       m.thread_id = r.rc->>'thread_id' thread_equal,
       (SELECT count(*) FROM public.sophia_session_messages x WHERE x.user_id=r.user_id
          AND x.session_id=r.source_session_id AND x.message_id=r.rc->>'message_id') rows_with_message_id
FROM r LEFT JOIN public.sophia_session_messages m ON m.id = r.rc->>'source_row_id'
ORDER BY (r.rc->>'created_at')::timestamptz;
```
If a column name differs in production, adapt it and say so. Do not widen the output to content.

### Q2: row order around each recorded row (no content)
```sql
SELECT s.thread_id, m.sequence, m.role, m.source, m.created_at, left(m.message_id,24) id_prefix,
       EXISTS(SELECT 1 FROM public.sophia_memory_governance_events e
              WHERE e.source_intake_receipt->>'source_row_id'=m.id) is_intake_row
FROM public.sophia_session_messages m JOIN public.sophia_sessions s ON s.id=m.session_id AND s.user_id=m.user_id
WHERE s.thread_id IN ('01a0ea63-535c-7843-a35e-b49581d10201','01a0e865-1a34-7ac0-9863-42ddf7a72633')
ORDER BY s.thread_id, m.sequence;
```

### Q3: epoch and fence state
Report `memory_clear_epoch` and `authority_state` for this owner.

Report the governance-event counts per `event_type` for the two sessions, and whether any has a source fence.

### Q4: log order in each window
Report time, method, path suffix and status only.

- **`sophia-gateway`:** `/api/v1/sessions/<Q0 session>/…` calls to `memory-source-actions`, `messages` (PUT/GET/POST), `touch` and `memory-source-profile`.
  - A conflicting PUT still returns 200, so read the call pattern, not the status.
  - For W0a/W0b this also gives the unknown 14:23Z recording times.
- **`sophia-langgraph`:** the five request ids above with their durations.
  - Within ±3 s of each, list the store RPC calls (`sophia_memory_lookup_source_action`, `sophia_memory_source_snapshot`, `sophia_memory_contract`, `sophia_memory_user_governance`) with their statuses.
  - For W0a/W0b, record `memory.context.entry_denied` `error_type` and `denied_at_line`.
- **Supabase API logs, same windows:** calls to `rpc/sophia_memory_accept_source_action`, `rpc/sophia_replace_session_messages`, `rpc/sophia_memory_lookup_source_action`, `rpc/sophia_memory_source_snapshot`, and `POST /rest/v1/sophia_sessions`.

### Q5: config parity, to rule out drift
- **Render events** for gateway and LangGraph between 2026-09-28T14:24Z and 23:51Z: any env edit, deploy or restart.
- **Private comparisons,** reporting **equal / not equal only**:
  - `SOPHIA_MEMORY_REFERENCE_HMAC_SECRET` on gateway vs LangGraph;
  - `SUPABASE_URL` host on gateway vs LangGraph;
  - `SUPABASE_SERVICE_ROLE_KEY` on gateway vs LangGraph.

## How to read the results

| Result | Meaning |
|---|---|
| Q1 `version_equal=false`, `sequence_equal=true`, `created_at_ms_truncated=true` on the failed turns | Leading cause confirmed |
| Q1 `sequence_equal=false`, or `row_exists=false` | Same family (renumber or delete); the planned fix covers it |
| Q1 `version_equal=true` on a failed turn | Leading cause refuted for that turn; Q3–Q5 decide |
| Gateway log `PUT → GET → PUT` before the matching 403 | Race order confirmed |
| Q5 not equal, or an env change or restart in the window | Config drift; report it and stop |

## Deliverable
`codex-048-R014a-admission-evidence.md` on the Codex mailbox branch, answering Q0–Q5 with the table verdict per turn.
