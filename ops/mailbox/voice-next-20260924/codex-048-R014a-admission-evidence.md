# codex-048: R-014a admission evidence

Read-only production check on 2026-09-29. Times below are UTC. No message content, owner identifiers, or secret values are included.

## Q0: sessions behind the two threads

| thread_id | session_id | status | message_revision | updated_at |
|---|---|---:|---:|---|
| `01a0e865-1a34-7ac0-9863-42ddf7a72633` | `ddf1f956-3285-4a07-9c9e-b1a6d846c367` | ended | 20 | `2026-09-28T23:39:30.175766Z` |
| `01a0ea63-535c-7843-a35e-b49581d10201` | `71981319-07ec-46ff-9ac3-1acbc3d6932c` | resumable | 30 | `2026-09-29T00:03:43.628544Z` |

## Q1: each intake receipt against its current row

All five receipts are `source=text`, `final=true`, `row_exists=true`, `epoch_equal=true`, `metadata_unchanged=true`, `thread_equal=true`, and have exactly one row with the recorded message id.

| turn | receipt_created_at | receipt_seq | revisions_since_intake | receipt_epoch | version_equal | sequence_equal | created_at_equal | created_at_ms_truncated | verdict |
|---|---|---:|---:|---:|---|---|---|---|---|
| W0a | `2026-09-28T14:23:41.704867Z` | 6 | 14 | 0 | false | false | false | true | **Same family (renumber); planned fix covers it** |
| W0b | `2026-09-28T14:23:56.873303Z` | 8 | 11 | 0 | false | true | false | true | **Leading cause confirmed** |
| W1 | `2026-09-28T23:49:39.653011Z` | 16 | 14 | 0 | false | false | false | true | **Same family (renumber); planned fix covers it** |
| W2 | `2026-09-28T23:50:02.042062Z` | 19 | 10 | 0 | false | false | false | true | **Same family (renumber); planned fix covers it** |
| W3 | `2026-09-28T23:50:32.637059Z` | 22 | 6 | 0 | false | false | false | true | **Same family (renumber); planned fix covers it** |

## Q2: row order around each recorded row (no content)

Thread `01a0e865…`: current rows around W0 are `seq5 assistant/voice 14:23:28.972`, `seq6 user/voice 14:23:41.586`, `seq7 user/text 14:23:41.704 intake`, `seq8 user/text 14:23:56.873 intake`, `seq9 user/voice 14:23:57.043`. W0a moved from receipt sequence 6 to current sequence 7; W0b remained sequence 8. Both intake timestamps are stored at millisecond precision.

Thread `01a0ea63…`: current rows are `seq15 user/voice 23:49:31.646`, `seq16 user/voice 23:49:39.137`, `seq17 user/text 23:49:39.653 intake`, `seq18 assistant/voice 23:49:57.539`, `seq19 user/voice 23:50:01.698`, `seq20 user/text 23:50:02.042 intake`, `seq21 assistant/voice 23:50:18.969`, `seq22 user/voice 23:50:32.160`, `seq23 user/text 23:50:32.637 intake`, `seq24 user/voice 23:50:36.559`. W1/W2/W3 moved from receipt sequences 16/19/22 to current 17/20/23; all three intake timestamps are stored at millisecond precision.

## Q3: epoch and fence state

The single matching owner has `memory_clear_epoch=0` and `authority_state=governed`.

| thread | memory_source_action_accepted | source_target_at_epoch_aligned | any source fence |
|---|---:|---:|---|
| `01a0e865…` | 2 | 2 | false |
| `01a0ea63…` | 3 | 2 | false |

## Q4: log order in each window

Gateway (time, method, suffix, status only):

- W0a: `14:23:41 POST memory-source-actions 200`; `14:23:43 POST touch 200`; `14:23:45 PUT messages 200`; `14:23:47 PUT messages 200`.
- W0b: `14:23:47 PUT messages 200`; `14:23:56 POST memory-source-actions 200`; `14:23:58 PUT messages 200`; `14:23:59 POST touch 200`; `14:23:59 GET messages 200`; `14:24:01 PUT messages 200`; `14:24:02 PUT messages 200`.
- W1: `23:49:39 POST memory-source-actions 200`; `23:49:40 PUT messages 200`; `23:49:41 POST touch 200`; `23:49:42 GET messages 200`; `23:49:43 PUT messages 200`; `23:49:45 PUT messages 200`.
- W2: `23:49:58 PUT messages 200`; `23:50:02 POST memory-source-actions 200`; `23:50:02 PUT messages 200`; `23:50:03 GET messages 200`; `23:50:03 POST touch 200`; `23:50:04 PUT messages 200`; `23:50:06 PUT messages 200`.
- W3: `23:50:32 POST memory-source-actions 200`; `23:50:33 PUT messages 200`; `23:50:34 POST touch 200`; `23:50:34 GET messages 200`; `23:50:35 PUT messages 200`; `23:50:37 PUT messages 200`; `23:50:38 POST touch 200`.
- No `memory-source-profile` or `POST messages` call occurred in these five windows. W1–W3 show the required `PUT -> GET -> PUT` signature before the matching 403: **race order confirmed**.

LangGraph requests and store calls:

- W0a `4f12fdb7…`: failed after `2227ms`; ingress `contract 200`, `user_governance 200`, `lookup_source_action 200 x2`, `source_snapshot 200`; recheck added `contract 200 x4`, `user_governance 200 x4`, `lookup_source_action 200`, `source_snapshot 200`. `memory.context.entry_denied`: `error_type=MemoryGovernanceUnavailable`, `denied_at_line=414`.
- W0b `ac6eecf6…`: failed after `2276ms`; the same ingress/recheck status pattern as W0a. `memory.context.entry_denied`: `error_type=MemoryGovernanceUnavailable`, `denied_at_line=256`.
- W1 `d87e0f5e…`: `403`, `1057ms`; `contract 200`, `user_governance 200`, `lookup_source_action 200 x2`, `source_snapshot 200`.
- W2 `36269a8b…`: `403`, `637ms`; `contract 200`, `user_governance 200`, `lookup_source_action 200 x2`, `source_snapshot 200`.
- W3 `a5b0746d…`: `403`, `1682ms`; `contract 200`, `user_governance 200`, `lookup_source_action 200 x2`, `source_snapshot 200`.

Supabase API Logs Explorer returned zero retained rows for both exact incident windows even when queried without a path filter. It could not independently list `accept_source_action`, `replace_session_messages`, `lookup_source_action`, `source_snapshot`, or `POST sophia_sessions`; Render application logs above are the available request evidence.

## Q5: config parity, to rule out drift

- Render event histories show no gateway or LangGraph environment edit, deploy, or restart between `2026-09-28T14:24Z` and `23:51Z`. The latest preceding gateway event was 2026-09-25; the latest preceding LangGraph event was 2026-09-22.
- `SOPHIA_MEMORY_REFERENCE_HMAC_SECRET` gateway vs LangGraph: **equal**.
- `SUPABASE_URL` host gateway vs LangGraph: **equal**.
- `SUPABASE_SERVICE_ROLE_KEY` gateway vs LangGraph: **equal**.

Conclusion: config drift is ruled out. Every failed intake row still exists, every recorded source version changed, all five timestamps were rewritten at millisecond precision, four rows were renumbered, and W1–W3 have the gateway conflict-recovery order before the 403. This confirms the proposed transcript-rewrite/source-version failure family for every turn; W0b directly satisfies the leading-cause row in the decision table. The separate line-256 pending-input-recovery defect explains W0b's later-stage refusal.
