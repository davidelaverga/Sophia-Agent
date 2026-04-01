# Phase 0 — Route Ownership Baseline (Refreshed 2026-04-01)

Objective: document the current ownership model after canonical runtime consolidation. This file is now a current-state baseline for the two supported routes, `/session` and `/chat`.

## Scope

- Stable product routes: `/session`, `/chat`
- Canonical shared runtime: `src/app/companion-runtime/*`
- Related support routes: `/api/chat`, `/api/sessions/[...path]`, `/api/ws-ticket`, `/api/resume`
- Onboarding-only legacy voice: `src/app/onboarding/voice-legacy/*`

## Ownership Matrix (Current State)

| Concern | Canonical owner | Route-specific owner | Boundary notes |
| --- | --- | --- | --- |
| Primary route shell | N/A | `/session`: `src/app/session/page.tsx` · `/chat`: `src/app/chat/page.tsx` | Pages are route shells only. They should not own transport or shared voice runtime setup. |
| Route experience | `/chat`: `src/app/chat/useChatRouteExperience.ts` · `/session`: `src/app/session/useSessionRouteExperience.ts` | Same | Route experiences adapt route-only UX/lifecycle to the canonical runtime. |
| Shared chat/send/cancel/retry lifecycle | `src/app/companion-runtime/chat-runtime.ts` | None | No route-local AI SDK or transport owner should reappear. |
| Stream contract normalization + interrupt ingress | `src/app/companion-runtime/stream-contract.ts` | None | Shared protocol handling belongs in the canonical runtime namespace. |
| Artifact ingestion and persistence | `src/app/companion-runtime/artifacts-runtime.ts` | None | Route shells can render artifacts, but artifact contract handling is shared. |
| Live conversation voice runtime | `src/app/companion-runtime/voice-runtime.ts` with `src/app/hooks/useStreamVoice.ts` and `src/app/hooks/useStreamVoiceSession.ts` | None | `/session` and `/chat` both use Stream/WebRTC via the canonical runtime. |
| Ritual lifecycle and recap/debrief | None | `src/app/session/*` route-only hooks + `src/app/stores/session-store.ts` | Session-only lifecycle remains under `/session`. |
| Free-chat UI state and persistence bridge | None | `src/app/stores/chat-store.ts` | `chat-store` is no longer a transport owner. |
| Onboarding voice-over | None | `src/app/onboarding/voice-legacy/*` | Compatibility-only. Not part of the conversation runtime. |

## Boundary Rules

1. New shared conversation behavior goes under `src/app/companion-runtime/`.
2. New ritual-only lifecycle work goes under `src/app/session/`.
3. New `/chat` work should remain route-shell or presentation work unless it is explicitly a shared runtime concern.
4. Do not introduce route-local transport owners such as `useChatAiRuntime`, `useSession*Runtime`, or direct Stream/WebRTC setup in page/components files.
5. Onboarding voice changes must stay under `src/app/onboarding/voice-legacy/` unless the onboarding flow is explicitly migrated onto the live conversation runtime.
6. The top-level `frontend/` app must not regain Sophia-specific product surfaces. See `../docs/MVP_FRONTEND_SURFACE_BOUNDARY.md`.

## Known Hotspots To Keep Small

- `src/app/session/page.tsx` - route shell should stay route-focused, not runtime-focused
- `src/app/components/ConversationView.tsx` - presentation shell only, not another orchestration hub
- `src/app/stores/chat-store.ts` - UI/persistence bridge only
- `src/app/companion-runtime/*` - shared runtime owner; growth here must reduce owners elsewhere

## Exit Criteria For This Baseline

- Both routes are documented as shells over the canonical runtime.
- No deleted route-local runtime files reappear.
- The repo boundary script and architecture contract test both pass.
