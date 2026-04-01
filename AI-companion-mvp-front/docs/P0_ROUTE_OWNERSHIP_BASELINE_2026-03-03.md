# Phase 0 — Route Ownership Baseline (2026-03-03)

Objective: establish explicit ownership boundaries for `/session` (ritual mode) and `/chat` (ritual-less mode) before deeper convergence work.

This baseline is descriptive (current-state), not a migration spec.

## Scope

- Runtime mode surfaces: `/session`, `/chat`
- Shared backend transport: `/api/chat`
- Related support routes: `/api/sessions/[...path]`, `/api/ws-ticket`, `/api/resume`

## Ownership Matrix (Current State)

| Concern | `/session` (ritual mode) owner | `/chat` (ritual-less mode) owner | Shared/Boundary Notes |
| --- | --- | --- | --- |
| Primary UI container | `src/app/session/page.tsx` | `src/app/components/ConversationView.tsx` | Keep route-level ownership explicit; avoid mixing orchestration logic between containers. |
| State source of truth | `src/app/stores/session-store.ts` + session orchestration hooks in `src/app/session/*` | `src/app/stores/chat-store.ts` | No cross-mode writes to each other’s primary store as a side-effect path. |
| Streaming runtime | `src/app/session/useSessionChatRuntime.ts` | `chat-store` stream path (ConversationView integration) | Both consume `/api/chat` but keep mode-specific orchestration local. |
| Stream contract normalization | `src/app/session/useSessionStreamContract.ts` + `src/app/session/stream-contract-adapters.ts` | `chat-store`/chat runtime path with shared API stream protocol | Stream transport contract is globally data-stream only (see protocol guardrails). |
| Stream persistence | `src/app/session/useSessionStreamPersistence.ts` + session snapshot/store actions | `chat-store` persistence path | Single-writer principle per mode persistence path. |
| Retry/cancel orchestration | `src/app/session/useSessionRetryHandlers.ts` + related orchestration hooks | `chat-store` retry/cancel flow | Keep retry semantics mode-local even when backend endpoint is shared. |
| Voice orchestration | `src/app/session/useSessionVoiceOrchestration.ts` + `useVoiceLoop` integrations | Minimal/optional for ritual-less chat flow | Voice lifecycle complexity remains primarily under `/session`. |
| Auth handoff (BFF) | Local API routes with server cookie token attachment | Same | Never expose backend bearer tokens to browser JS. |
| Sessions proxy | `/api/sessions/[...path]` used by session lifecycle/validation | Not primary for ritual-less chat | Raw request body logging is disallowed in this boundary. |
| WS ticket issuance | `/api/ws-ticket` used for realtime voice/session bridge | Shared when needed | Route is rate-limited and should emit `Retry-After` on `429`. |
| Resume/interrupt preflight | `/api/resume` for interrupt-resume workflows | Not primary for ritual-less chat | CORS preflight allowlist behavior is required (no wildcard permissiveness). |
| Error policy | Session runtime maps usage-limit/offline/generic with mode-specific UI | Chat runtime maps analogous errors to chat UX | Classify errors once at boundary; render-mode-specific copy remains local. |

## Boundary Rules (Phase 0 guardrails)

1. New ritual flow changes go to `/session` owners first.
2. New ritual-less chat UX changes go to `/chat` owners first.
3. Shared API behavior changes must be protocol-safe for both modes.
4. Do not introduce backdoor coupling (`/session` importing `/chat` orchestration internals or vice versa).
5. If behavior must be shared, extract to neutral utility/hook under `src/app/lib` or dedicated shared session/chat seam with clear ownership.

## Known Hotspots to Track During Convergence

- `src/app/session/page.tsx`
- `src/app/stores/chat-store.ts`
- `src/app/hooks/useVoiceLoop.ts`
- `src/app/api/chat/_lib/stream-transformers.ts`

## Exit Criteria for Phase 0 Baseline

- Ownership matrix is documented and linked from architecture docs.
- Teams can classify any change request into one primary runtime owner before coding.
- Follow-up convergence phases can reference this baseline as source-of-truth for scope decisions.
