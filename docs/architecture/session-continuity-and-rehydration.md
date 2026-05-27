# Sophia Session Continuity And Rehydration

Date: 2026-05-26
Status: productionized transcript durability contract

## Source Of Truths

Sophia session continuity has several related but separate stores:

- Session metadata: `SessionStore` is an abstraction selected by `SOPHIA_SESSION_STORE`. Filesystem local/dev writes `users/{user_id}/sessions/{session_id}.json`; production should use Supabase Postgres table `sophia_sessions`.
- Transcript messages: filesystem local/dev writes `users/{user_id}/transcripts/{session_id}.json`; production should use Supabase Postgres table `sophia_session_messages`. This store is the durable ordered visible conversation transcript.
- LangGraph checkpointer: the companion graph stores internal graph state by `thread_id`. This may include `messages`, prior artifacts, middleware state, tool state, summaries, and async builder state, but it is not the UI transcript archive.
- Recap: `users/{user_id}/recaps/{session_id}.json` is the session-finalization envelope and recap artifact state. It must not replace transcript history.
- Trace: `users/{user_id}/traces/{session_id}.json` is turn telemetry for evaluation and GEPA. It is not a complete chat transcript.
- Handoff: `users/{user_id}/handoffs/latest.md` is the latest cross-session summary and smart-opener source. It is overwritten, not accumulated.
- Mem0: Mem0 is durable cross-session memory. It stores extracted facts, feelings, decisions, lessons, commitments, preferences, relationships, patterns, and ritual context. It is not the ordered conversation transcript.

## ID Contract

- `session_id` is the stable UI conversation id and the key for metadata, transcript, recap, and trace files.
- `thread_id` is the LangGraph/checkpointer id used when continuing text companion execution.
- `run_id` identifies a single LangGraph run, not the conversation.
- Voice provider session ids identify a provider socket/session and are not durable conversation ids.

When a user reopens a conversation, the UI should load by `session_id`, render the transcript sidecar, and continue text turns with the stored `thread_id` when available.

Ended sessions are resumable conversations, not immutable archives. Opening an ended session renders the stored transcript and allows the next user message to continue the same `session_id`. The backend reactivates the row on the first new message, preserves the current `thread_id` when LangGraph still has it, increments the continuation/segment counters, and appends new transcript rows after the previous max sequence.

## Reopen Flow

1. Frontend restores or selects a session metadata record.
2. Frontend calls `GET /api/v1/sessions/{session_id}/messages`.
3. Gateway returns durable transcript messages from the configured session store.
4. If no transcript exists, gateway falls back to `GET /threads/{thread_id}/state`, extracts visible human/assistant messages, and backfills the configured transcript store.
5. Frontend renders the returned ordered messages before a new user message is sent.
6. Text sends continue with the same `thread_id`. If LangGraph reports the thread is missing, the chat proxy creates a fresh thread, seeds it with a bounded excerpt of recent durable transcript messages, and marks the stream metadata with `recovered_from_transcript=true`.

## Incremental Persistence

The session page sends visible transcript snapshots to `PUT /api/v1/sessions/{session_id}/messages` as messages change. Browser `pagehide` and hidden-tab events use the `POST` alias for best-effort `sendBeacon`/`keepalive` flushing. The backend treats these writes as append-or-upsert operations, keyed by stable message ids, so retries do not duplicate transcript rows.

Streaming assistant text may be stored only when marked `final=false` or `incomplete=true`. Completed text and voice turns are stored as final visible messages. Tool calls, artifacts, diagnostics, and raw provider events should not appear in the user-visible transcript unless a later product decision explicitly surfaces them.

Session finalization is incremental. `sophia_sessions.memory_processed_until_sequence` and `recap_processed_until_sequence` record the last successfully processed transcript sequence. The offline pipeline extracts only durable messages with `sequence > memory_processed_until_sequence`; successful extraction advances the checkpoint to the range end, while failures leave it untouched. Candidate metadata carries `session_id`, `thread_id`, `sequence_start`, `sequence_end`, `source_message_ids`, and `extraction_run_id` so review overlays can distinguish continuation segments without relying on Mem0 semantic dedupe.

## Voice Reopen Semantics

Old voice sessions reopen as readable transcript/history through the same transcript sidecar. A provider-native socket should not be assumed resumable. Gemini Live setup is effectively immutable after the initial setup, so continuing voice after reopening should start a fresh provider session seeded from durable context, not from the old provider session id.

Assistant voice transcripts may be approximate when sourced from provider output transcription. The transcript store has `source` and `approximate` fields for that distinction, even if the current UI renders them plainly.

## Abandoned Sessions

Explicit End Session still owns recap/offline-pipeline finalization. Browser back, refresh, close, hidden-tab, and network loss are handled by incremental transcript persistence first. Inactivity tracking may mark a session `paused`, but the transcript sidecar is the durable protection against losing visible conversation history.

A future hardening pass should add deterministic `abandoned`/`interrupted` status and a sweeper-backed finalization policy. That status work should not block transcript rehydration.

## Production Storage Requirements

Render filesystems are ephemeral by default. File-based metadata and transcript sidecars are local/dev conveniences only and must not be the production source of truth.

Production transcript persistence uses Supabase Postgres:

- Set `SOPHIA_SESSION_STORE=supabase` on backend services that read/write sessions.
- Set backend-only `SUPABASE_URL`.
- Set backend-only `SUPABASE_SERVICE_ROLE_KEY`.
- Run `backend/migrations/2026_05_26_sophia_session_transcripts.sql`.

`SUPABASE_SERVICE_ROLE_KEY` must never be exposed to the frontend. The frontend continues to call existing session APIs; only the trusted backend talks to Supabase.

Supabase Storage may be useful later for large debug/archive blobs, exported transcripts, or diagnostic bundles. It is not the hot-path primary transcript store.

LangGraph checkpointer state is only durable if configured with SQLite/Postgres or equivalent persistent storage. `config.production.yaml` must explicitly configure a persistent checkpointer if same-thread resume across restarts/deploys is required.

For multi-service deployments, the gateway must own transcript reads/writes through the configured store. Recap, trace, handoff, transcript, and metadata files must not be split across non-shared ephemeral filesystems.

## Supabase Schema

`sophia_sessions` stores one row per conversation:

- `id`: stable session id.
- `user_id`: trusted backend user id.
- `thread_id`: LangGraph/checkpointer thread id.
- `mode`: `text`, `voice`, or `mixed`.
- `status`: `active`, `resumable`, `ended`, `abandoned`, or `interrupted`.
- `title`, `preview`, `message_count`, timestamps, recap/checkpointer/transcript flags.
- `memory_processed_until_sequence`, `recap_processed_until_sequence`, extraction timestamps/status/range, `active_segment_started_at`, `segment_count`, and `continuation_count` for resumable finalization.
- `metadata`: non-indexed compatibility fields such as `preset_type`, `context_mode`, `platform`, `intention`, and `focus_cue`.

`sophia_session_messages` stores ordered transcript rows:

- `id`: deterministic session-scoped storage id for idempotency.
- `message_id`: original client/provider message id when present.
- `session_id`, `user_id`, `thread_id`.
- `role`, `content`, `source`, `final`, `approximate`, `turn_id`, `provider_event_id`.
- `sequence` plus `created_at` for stable ordering.
- `metadata`: diagnostics such as `redaction_level`; do not put secrets here.

## Rollout

1. Run the SQL migration in Supabase.
2. Add `SOPHIA_SESSION_STORE=supabase`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY` to the backend/gateway Render service.
3. Redeploy the gateway/backend service that serves `/api/v1/sessions`.
4. Smoke test: start text session, send two turns, refresh, reopen from history, verify transcript.
5. Smoke test: start voice session, wait for finalized transcript events, end/reopen, verify readable history.

Existing filesystem-only local sessions are not automatically migrated. If preserving old production sessions is necessary, write a one-off backend-only backfill that reads old JSON sidecars and calls the session store abstraction.

## Rollback

If Supabase transcript persistence misbehaves before data migration matters, set `SOPHIA_SESSION_STORE=filesystem` only in local/dev. Do not use filesystem rollback on Render for durable production history. A production rollback should instead redeploy the prior application version while keeping the Supabase tables intact, then fix the backend store code and redeploy.

## Privacy

Do not log raw transcript or memory text in diagnostics. Reports should use counts, field presence, ids only when necessary, and safe hashes/previews only in explicit debugging contexts.
