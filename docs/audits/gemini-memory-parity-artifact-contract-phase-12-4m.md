# Phase 12.4M — Gemini Memory Parity And Artifact Contract Hardening

Date: 2026-05-21
Branch: `fix/gemini-memory-parity-artifact-contract-phase-12-4m`

## Scope

This phase narrows two product gaps in the Gemini Live production candidate:

- Gemini Live setup did not receive the same stored user context that legacy cascade voice gets through the Sophia companion middleware chain.
- Artifact payloads could carry stringified null values such as `reflection: "null"`, causing the Presence artifact UI to render a fake reflection.

Out of scope: VAD tuning, `realtimeInputConfig`, relay throughput/order, runtime default changes, Builder storage UI, and canonical Sophia identity file edits.

## Memory Parity Audit

Legacy cascade voice enters DeerFlow through `voice/adapters/deerflow.py` using `/threads/{thread_id}/runs/stream` with trusted `config.configurable.user_id`, `platform`, `context_mode`, `ritual`, and `thread_id`. The `sophia_agent` chain then injects stored continuity through:

- `UserIdentityMiddleware`, which reads `users/{user_id}/identity.md`.
- `SessionStateMiddleware`, which reads `users/{user_id}/handoffs/latest.md` on first-turn/session-state paths.
- `Mem0MemoryMiddleware`, which calls `deerflow.sophia.mem0_client.search_memories()` and injects a bounded `<memories>` block.

Gemini Live did not previously have equivalent stored-user context. Its setup instructions came from canonical prompt files plus the Gemini spoken-turn policy overlay, but the production setup builder had no `user_id` parameter in the prompt builder and did not fetch identity, handoff, preferred-name, or Mem0 snippets before minting the first setup payload.

## Implementation

`voice/realtime/gemini_memory_context.py` now builds a setup-time `<gemini_live_user_context>` block from the authenticated session user id. It may include:

- Preferred name inferred from stored identity or latest handoff text when available.
- A bounded stored identity excerpt.
- A bounded latest session handoff excerpt.
- Up to four bounded Mem0 snippets from `search_memories()` using the same Mem0 client path as the Sophia middleware.

The context is inserted after canonical Sophia realtime instructions and before `<gemini_live_spoken_turn_policy>`, keeping the Gemini-specific spoken policy as the final overlay. Production and dogfood Gemini browser session startup both carry compact `memory_context` diagnostics in setup/public payloads and relay diagnostics.

Privacy bounds:

- The prompt block uses the trusted authenticated session user id only for lookup; it does not expose the raw user id in the prompt.
- Diagnostics expose presence/count/category/status/length metadata only, not raw identity or memory text.
- Mem0 absence or failure degrades to no memory snippets and a diagnostic status; session startup does not fail.

## Artifact Contract Hardening

Null-like reflection strings are normalized to absence at these boundaries:

- Backend `emit_artifact` contract validation.
- Sophia `ArtifactMiddleware` captured `current_artifact` state.
- Gemini provider artifact mapper before public `sophia.artifact` emission.
- Frontend live stream artifact parser.
- Frontend artifact merge/status helpers.
- Presence artifact panel rendering/tap guard.
- Recap artifact adapter.

Covered null-like values: empty string, `"null"`, `"none"`, `"undefined"`, and `"n/a"`. Valid reflection prompts still render and mark reflection ready.

## Manual Smoke Plan

Run Gemini production candidate with the same default-off flag set as prior phases. Use a user with stored identity or Mem0 context.

1. Start a Gemini Live voice session and ask: `What do you remember about me?`
2. Confirm Sophia uses concrete stored context and does not say generic `User` language.
3. Trigger a companion turn whose artifact has no reflection.
4. Confirm the Presence artifact panel does not render `null`, `None`, or equivalent text.
5. Inspect the setup/relay diagnostics and confirm `memory_context.schema = gemini_live_memory_context_v1`, with counts/status present but no raw memory content.

## Remaining Gaps

This is setup-time memory parity, not full middleware parity. Gemini Live still does not run the full Sophia companion middleware chain inside the native audio session, and Mem0 writes remain offline-only. Per-turn Mem0 semantic retrieval based on the just-spoken user utterance remains limited by Gemini Live setup immutability unless a future design adds a safe tool or session-rotation strategy.
