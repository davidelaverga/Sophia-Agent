# Phase 0 — Canonical Session Contract (2026-03-03)

Objective: define the canonical frontend session contract so future convergence work can reduce duplication without changing product behavior.

This contract focuses on frontend runtime invariants, ownership boundaries, and compatibility rules.

## Canonical Entities

### Session Identity
- `sessionId`: stable identifier for the active ritual session lifecycle.
- `userId`: authenticated user context (resolved through server-side auth boundaries).
- `mode`: runtime mode discriminator (`ritual` for `/session`, `ritual-less` for `/chat`).

### Message Identity
- `messageId`: unique per message in a transcript scope.
- `role`: `user` or `assistant` (system/internal context is not rendered as transcript messages).
- `timestamp`: normalized to a comparable form for ordering and dedupe guards.

### Stream Lifecycle
- Canonical stream protocol is AI SDK data-stream.
- Required envelope order remains `start -> text-start -> text-delta* -> text-end -> finish` with optional data events and `[DONE]` terminator.
- Interrupt/artifacts/meta payloads travel as data events, not plaintext inline tokens.

Reference: `docs/CHAT_STREAM_PROTOCOL_GUARDRAILS.md`.

## State Ownership Contract

### Ritual Mode (`/session`)
- Primary session lifecycle ownership: `src/app/stores/session-store.ts`.
- Session runtime orchestration ownership: hooks under `src/app/session/*`.
- Session stream runtime owner: `src/app/session/useSessionChatRuntime.ts`.

### Ritual-less Mode (`/chat`)
- Primary chat lifecycle ownership: `src/app/stores/chat-store.ts`.
- Ritual-less orchestration ownership: `src/app/components/ConversationView.tsx` + chat-store runtime path.

### Shared Constraints
- Shared endpoint usage (`/api/chat`) does not imply shared UI orchestration ownership.
- Cross-mode direct store writes are forbidden unless explicitly documented with adapter ownership.

## Persistence Contract

1. Each mode keeps a single authoritative write path for transcript/session persistence.
2. Persisted payloads must preserve message ordering invariants.
3. In-flight stream partial state must be recoverable without duplicate final assistant messages.
4. Storage clean/reset flows must not rely on deprecated legacy helpers as primary behavior.

## Auth and Transport Contract

1. Browser clients call local Next API routes only.
2. Server routes attach backend auth from `httpOnly` cookies.
3. Bearer/session tokens are never exposed to client JS.
4. Sensitive payload logging (raw bodies, tokens, secrets) is disallowed on route boundaries.

## Error Semantics Contract

1. Error classification happens at runtime boundary (usage limit, offline/network, generic).
2. UI copy/rendering remains mode-specific.
3. Retry behavior must be deterministic and local to the mode owner.
4. `429` paths in rate-limited endpoints should provide `Retry-After` to support controlled retry UX.

## Compatibility Rules (No-Regress)

1. `/session` remains the owner for ritual lifecycle flows.
2. `/chat` remains a supported ritual-less mode and is not deprecated.
3. Any shared abstraction introduced in later phases must preserve both route contracts.
4. Stream protocol remains data-stream only; legacy text protocol is retired.

## Convergence Readiness Checklist

- Any proposed extraction identifies one primary owner (`/session` or `/chat`).
- Contract invariants above are preserved by tests or guard checks.
- API boundary changes remain backward compatible with current frontend owners.
- Documentation updates include ownership and compatibility impact.
