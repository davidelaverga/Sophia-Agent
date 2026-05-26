# Sophia Session Continuity And Rehydration

Date: 2026-05-26
Status: implemented narrow transcript durability slice

## Source Of Truths

Sophia session continuity has several related but separate stores:

- Session metadata: `SessionStore` writes `users/{user_id}/sessions/{session_id}.json`. This record owns `session_id`, `thread_id`, status, timestamps, title, preview, platform, context, and message count.
- Transcript messages: `SessionStore` writes `users/{user_id}/transcripts/{session_id}.json`. This sidecar is the durable ordered visible conversation transcript.
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

## Reopen Flow

1. Frontend restores or selects a session metadata record.
2. Frontend calls `GET /api/v1/sessions/{session_id}/messages`.
3. Gateway returns `users/{user_id}/transcripts/{session_id}.json` if it exists.
4. If no transcript sidecar exists, gateway falls back to `GET /threads/{thread_id}/state`, extracts visible human/assistant messages, and backfills the transcript sidecar.
5. Frontend renders the returned ordered messages before a new user message is sent.
6. Text sends continue with the same `thread_id`. If the checkpointer no longer has that thread, a later recovery/reseed path should be explicit rather than silently treating recap as transcript.

## Incremental Persistence

The session page sends visible transcript snapshots to `PUT /api/v1/sessions/{session_id}/messages` as messages change. Browser `pagehide` and hidden-tab events use the `POST` alias for best-effort `sendBeacon`/`keepalive` flushing.

Streaming assistant text may be stored only when marked `final=false` or `incomplete=true`. Completed text and voice turns are stored as final visible messages. Tool calls, artifacts, diagnostics, and raw provider events should not appear in the user-visible transcript unless a later product decision explicitly surfaces them.

## Voice Reopen Semantics

Old voice sessions reopen as readable transcript/history through the same transcript sidecar. A provider-native socket should not be assumed resumable. Gemini Live setup is effectively immutable after the initial setup, so continuing voice after reopening should start a fresh provider session seeded from durable context, not from the old provider session id.

Assistant voice transcripts may be approximate when sourced from provider output transcription. The transcript store has `source` and `approximate` fields for that distinction, even if the current UI renders them plainly.

## Abandoned Sessions

Explicit End Session still owns recap/offline-pipeline finalization. Browser back, refresh, close, hidden-tab, and network loss are handled by incremental transcript persistence first. Inactivity tracking may mark a session `paused`, but the transcript sidecar is the durable protection against losing visible conversation history.

A future hardening pass should add deterministic `abandoned`/`interrupted` status and a sweeper-backed finalization policy. That status work should not block transcript rehydration.

## Production Storage Requirements

File-based metadata and transcripts are only durable if the service filesystem is durable and shared with the service that serves session APIs. LangGraph checkpointer state is only durable if configured with SQLite/Postgres or equivalent persistent storage. `config.production.yaml` must explicitly configure a persistent checkpointer if same-thread resume across restarts/deploys is required.

For multi-service deployments, the gateway must own transcript reads/writes or use shared durable storage. Recap, trace, handoff, transcript, and metadata files must not be split across non-shared ephemeral filesystems.

## Privacy

Do not log raw transcript or memory text in diagnostics. Reports should use counts, field presence, ids only when necessary, and safe hashes/previews only in explicit debugging contexts.
