# Phase 0 — Canonical Session Contract (Refreshed 2026-04-01)

Objective: define the current canonical frontend conversation contract after runtime ownership cleanup.

This contract focuses on runtime invariants, route-shell boundaries, and compatibility rules for the Sophia MVP app.

## Canonical Entities

### Session Identity
- `sessionId`: stable identifier for the active ritual or free-chat conversation lifecycle.
- `userId`: authenticated user context resolved through server-side auth boundaries.
- `routeProfile`: canonical runtime discriminator resolved through `src/app/companion-runtime/route-profiles.ts`.

### Message Identity
- `messageId`: unique per message in a transcript scope.
- `role`: `user` or `assistant` in runtime form, adapted into route-specific view models for UI.
- `timestamp`: normalized for ordering, dedupe, and persistence safety.

### Stream Lifecycle
- Canonical stream protocol is AI SDK data-stream.
- Required envelope order remains `start -> text-start -> text-delta* -> text-end -> finish`, with optional data events and `[DONE]` terminator.
- Interrupts, artifacts, and metadata travel as structured data events rather than inline plaintext tokens.

Reference: `docs/CHAT_STREAM_PROTOCOL_GUARDRAILS.md`.

## Ownership Contract

### Canonical Runtime

The only canonical runtime owner is the `src/app/companion-runtime/` namespace.

It owns:
- chat/send/cancel/retry lifecycle
- stream contract normalization
- artifact ingress and merge behavior
- live Stream/WebRTC voice runtime
- route-profile-aware defaults shared by `/session` and `/chat`

It does not own:
- ritual bootstrap and validation
- debrief or recap exit flows
- top-level route chrome or navigation
- onboarding voice-over

### Ritual Route (`/session`)

- Route shell: `src/app/session/page.tsx`
- Route runtime adapter: `src/app/session/useSessionRouteExperience.ts`
- Route-owned concerns: bootstrap, validation, ritual lifecycle guards, recap/debrief flows, and route chrome
- Primary route state owner: `src/app/stores/session-store.ts`

### Ritual-less Route (`/chat`)

- Route shell: `src/app/chat/page.tsx`
- Route runtime adapter: `src/app/chat/useChatRouteExperience.ts`
- Route-owned concerns: free-chat presentation and route-local UI state
- Primary route UI/persistence bridge: `src/app/stores/chat-store.ts`

### Compatibility Voice Island

- Onboarding voice-over remains under `src/app/onboarding/voice-legacy/`
- It is not part of the live conversation runtime and must not be imported by `/session`, `/chat`, or `src/app/companion-runtime/*`

## Persistence Contract

1. Shared transcript/stream behavior persists through the canonical runtime, not route-local transport owners.
2. Ritual-specific lifecycle persistence remains in `session-store` and session snapshots.
3. Route-local UI stores may persist view state, but they must not become alternate runtime owners.
4. In-flight stream partial state must remain recoverable without duplicating final assistant messages.

## Auth and Transport Contract

1. Browser clients call local Next API routes only.
2. Server routes attach backend auth from `httpOnly` cookies.
3. Bearer/session tokens are never exposed to client JS.
4. Sensitive payload logging (raw bodies, tokens, secrets) is disallowed on route boundaries.

## Error and Recovery Contract

1. Error classification happens at the canonical runtime boundary whenever the behavior is shared across routes.
2. Route copy/rendering may stay route-specific.
3. Retry and recovery logic must be deterministic and originate from the canonical runtime or explicit route adapters.
4. Rate-limited paths should continue to expose `Retry-After` semantics to support controlled retry UX.

## Compatibility Rules (No Regress)

1. `/session` remains the supported ritual route.
2. `/chat` remains the supported free-chat route and is not legacy.
3. New shared abstractions must reduce ownership, not create another route-local transport owner.
4. Stream protocol remains data-stream only.
5. Onboarding legacy voice stays quarantined unless explicitly migrated onto the live conversation runtime.

## Guardrail Checklist

- Route shells do not import transport owners directly.
- `src/app/companion-runtime/*` remains the only shared runtime namespace.
- Deleted route-local runtime files remain absent.
- Top-level `frontend/` remains free of Sophia-specific product surfaces.
