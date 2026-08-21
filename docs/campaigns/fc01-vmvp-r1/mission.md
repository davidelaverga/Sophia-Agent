# FC01-VMVP-R1 — Native Gemini continuity and observable voice gate

This campaign implements the bounded FC01-R1 packet on branch
`codex/sophia-observability-v1`.

## Scope

- Native Gemini Live session resumption with browser-local handle custody.
- Gemini context-window compression and provider connection epochs.
- GoAway-triggered credential rotation with an epoch/CAS guard.
- Structural-only LangSmith traces with HMAC pseudonyms and audio capture off by default.
- Revision-safe transcript snapshot admission for session durability.
- Production LangGraph checkpointer configuration backed by `LANGGRAPH_POSTGRES_DSN`.

## Explicit non-scope

This campaign does not introduce the deferred M02 semantic event fabric, M03 durable
reconstruction/checkpoint/replay architecture, M04 control service or non-destructive
steer protocol, or the broader M05/M06/M09 work.

## Deployment gate

The SQL migration
`backend/migrations/2026_08_21_fc01_m01_c1_session_message_revision.sql` is additive
and must be applied through the production database change gate before the revisioned
Supabase path can be considered live. No production database mutation is performed by
the branch push itself.
