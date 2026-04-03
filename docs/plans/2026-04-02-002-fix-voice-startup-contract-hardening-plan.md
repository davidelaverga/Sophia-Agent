---
title: "fix: voice startup contract hardening"
type: fix
status: active
date: 2026-04-02
origin: docs/brainstorms/2026-04-01-mvp-frontend-ownership-cleanup-requirements.md
---

# Voice Startup Contract Hardening

## Overview

Harden the Sophia live-voice startup path so frontend state reflects actual Sophia readiness rather than transport state. This follow-up is intentionally narrower than the 2026-04-01 ownership-cleanup effort: keep the canonical runtime owner and finalized transcript contract work, but defer same-conversation text fallback and editable draft handoff until startup failure data proves they are needed.

Execution posture for implementation is characterization-first. Preserve the current minimum fix for `session_id: null` and `sophia.user_transcript`, then tighten the remaining readiness gap without broadening the product surface.

Implementation update on 2026-04-02: the first readiness pass landed without a new backend ready event. The frontend now uses the existing gateway `session_id` plus Stream remote participant session IDs as the authoritative startup boundary.

## Problem Frame

The minimum fix closed one real failure mode: the frontend no longer starts a voice session when `/voice/connect` returns `session_id: null`, and finalized user speech is again sourced from `sophia.user_transcript`. The remaining gap is that transport join can still look like usable voice before Sophia has crossed any authoritative ready boundary.

That gap is worth fixing for a premium product. It risks a silent room, ambiguous startup state, and route-local interpretations of when voice is truly ready. It does not require the full earlier brainstorm. The build plan reinforces this narrower approach: it already treats API contracts as first-class artifacts shared across backend, voice, and frontend work, so a minimal startup-ready contract is aligned with the repo's intended architecture.

## Requirements Trace

- R1-R5: explicit startup readiness, bounded connecting window, fail-fast unavailable state, no transport-implies-ready behavior
- R6-R9: canonical finalized user-turn event, invisible command consumption, no provisional transcript authority, idempotent dedupe
- R10-R13: one runtime owner, no route-specific voice orchestration drift, minimal upstream contract work, regression coverage

Deferred from the earlier broader brainstorm:

- same-conversation text fallback
- editable draft handoff on startup failure

## Scope Boundaries

- In scope: readiness signal or equivalent authoritative condition, startup timeout, unavailable-state transition, canonical finalized-turn normalization and dedupe, and runtime ownership cleanup required to enforce those invariants
- In scope: minimal gateway or voice-layer contract changes needed to expose startup success or startup failure cleanly
- Out of scope: same-conversation text fallback, editable draft preservation, auto-resume after startup failure, broad route-shell redesign, or backend architecture rewrite

## Context And Research

### Relevant Code And Patterns

- `backend/app/gateway/routers/voice.py` owns the `/voice/connect` and `/voice/disconnect` contract. It already returns nullable `session_id` and is the correct place for any gateway-level startup semantics.
- `backend/tests/test_voice_gateway.py` already covers happy-path connect, nullable `session_id`, and dispatch context. It remains the natural home if a future startup contract needs additional gateway semantics, but the first pass did not require backend changes.
- `voice/server.py` and `voice/sophia_llm.py` already provide the live call join plus custom-event path. The first pass did not require new voice-layer events because Stream remote participant session IDs turned out to be a stronger readiness boundary.
- `AI-companion-mvp-front/src/app/hooks/useStreamVoiceSession.ts` currently gates only on missing `session_id` and still maps `CallingState.JOINED` to `listening`.
- `AI-companion-mvp-front/src/app/hooks/useStreamVoice.ts` already subscribes to Stream call state and remote participants, making it the correct seam for exposing remote participant session IDs to the higher-level session hook.
- `AI-companion-mvp-front/src/app/companion-runtime/voice-runtime.ts` already centralizes user transcript handling and voice retry state. It is the correct frontend runtime seam to carry shared readiness semantics.
- `AI-companion-mvp-front/src/app/chat/useChatRouteExperience.ts` shows the route shell consuming the shared runtime rather than owning a second startup contract.
- `AI-companion-mvp-front/src/__tests__/hooks/useStreamVoiceSession.test.ts` already provides the exact regression harness for current startup and transcript behavior.

### Institutional Learnings

- `AI-companion-mvp-front/docs/P0_SESSION_CANONICAL_CONTRACT_2026-03-03.md` already names `src/app/companion-runtime/` as the canonical shared runtime owner. This work should strengthen that contract, not add another owner.
- `docs/plans/2026-04-01-001-refactor-mvp-frontend-ownership-cleanup-plan.md` is broader and already completed. It should remain historical context, not be extended in place.
- `02_build_plan (new).md` helps because it explicitly treats API contracts as a first-class artifact shared across tracks. That supports a small readiness contract addition rather than a larger fallback UX initiative.

### External Research Decision

Skipped. The repo already contains the live gateway, voice event contract, runtime ownership guidance, and focused tests for the exact surfaces involved.

## Resolved Planning Questions

### 1. Should this continue the full broader brainstorm?

No. Implement only the startup hardening slice.

Rationale:

- It closes the remaining correctness gap that still affects product quality.
- It avoids carrying a bigger fallback UX branch before there is evidence it is needed.
- It stays aligned with the build plan's contract-first philosophy.

### 2. Should the older 04-01 ownership plan be updated in place?

No. Create a new plan.

Rationale:

- The older plan is completed and broader in scope.
- Reusing it would blur historical record and make the current work look larger than it is.

### 3. Where should readiness be defined?

Define readiness as a cross-layer contract consumed by the canonical frontend runtime.

Rationale:

- Readiness is not a route concern.
- Readiness is not equivalent to Stream transport state.
- The frontend needs one authoritative signal it can trust across `/session` and `/chat`.

Implementation choice:

- Use the existing gateway `session_id` as the expected Sophia agent session identifier.
- Treat the matching Stream remote participant join as the authoritative ready boundary.
- Add a dedicated `sophia.ready` event only if the participant-based contract later proves insufficient.

## Key Technical Decisions

- Keep `session_id: null` fail-fast as the first startup gate, but add a second gate for authoritative Sophia readiness after join.
- Do not map `CallingState.JOINED` directly to `listening`; keep the UI in a bounded startup state until the ready contract is satisfied.
- Use the gateway-returned voice `session_id` plus matching Stream remote participant session IDs as the first authoritative ready contract.
- Defer a dedicated `sophia.ready` custom event unless the participant-based contract later proves ambiguous or insufficient.
- Keep finalized user-turn authority on `sophia.user_transcript` and add or strengthen dedupe on that path rather than introducing a second user-turn channel.
- Route readiness and finalized-turn mutation through the canonical runtime and shared voice hook, not separate route-local orchestration.

## High-Level Technical Design

### Startup State Model

```text
idle -> connecting_transport -> waiting_for_sophia -> listening

failure exits:
- missing session_id -> error
- join failure -> error
- ready timeout -> error
- explicit startup failure signal -> error
```

`waiting_for_sophia` may reuse the existing `connecting` label in UI if a new visible label is unnecessary. The invariant is what matters: the product must not present normal listening before startup readiness is satisfied.

### Preferred Readiness Contract

1. Gateway returns Stream credentials plus `session_id`.
2. Frontend joins the Stream call but remains in startup state.
3. Stream reports remote participant session IDs for the active call.
4. Frontend unlocks listening only after the expected Sophia agent `session_id` is present in that remote participant set.

Fallback only if the dedicated event proves unnecessary:

- if participant-join semantics later prove insufficient, add a dedicated ready event or an equivalent explicit voice-layer signal and enforce it with tests.

### Finalized User-Turn Contract

- `sophia.user_transcript` remains the single authoritative finalized user-turn event.
- Route-local command systems consume that event before any visible append.
- Idempotency keys or equivalent dedupe must prevent duplicate user messages and duplicate command side effects.

## Implementation Units

- [x] **Unit 1: Gate startup readiness on gateway `session_id` plus Stream remote participant join**

**Goal:** Establish a contract the frontend can trust for startup readiness without adding a new backend event surface.

**Requirements:** R1-R5, R12

**Dependencies:** None

**Files:**
- Modify: `AI-companion-mvp-front/src/app/hooks/useStreamVoice.ts`
- Modify: `AI-companion-mvp-front/src/app/hooks/useStreamVoiceSession.ts`
- Modify: `AI-companion-mvp-front/src/__tests__/hooks/useStreamVoice.test.ts`
- Modify: `AI-companion-mvp-front/src/__tests__/hooks/useStreamVoiceSession.test.ts`
- Validate: `AI-companion-mvp-front/src/__tests__/session/useSessionRouteExperience.test.ts`
- Validate: `AI-companion-mvp-front/src/__tests__/session/useSessionVoiceCommandSystem.test.ts`

**Approach:**
- Keep `session_id` as the first startup gate.
- Expose Stream remote participant session IDs from the low-level call hook.
- Keep the session hook in a non-ready startup state until the expected Sophia agent `session_id` appears in the remote participant set.
- Fail startup after a bounded timeout if the agent never joins the call.

**Patterns to follow:**
- Existing `session_id: null` fail-fast handling in `AI-companion-mvp-front/src/app/hooks/useStreamVoiceSession.ts`
- Stream remote participant session IDs already used by audio binding in `AI-companion-mvp-front/src/app/hooks/useStreamVoice.ts`

**Test scenarios:**
- Happy path: connect returns `session_id`, the expected remote participant joins, and the session transitions from startup to listening.
- Edge case: gateway returns `session_id: null`; frontend errors before join.
- Edge case: transport joins but the expected remote participant never appears; startup times out into unavailable.
- Edge case: route-level consumers still pass their existing shared-runtime tests without API widening.

**Verification:**
- `CallingState.JOINED` alone no longer produces a normal listening UI.
- Focused hook tests pass and the adjacent session-route regression slice stays green.

---

- [x] **Unit 2: Harden finalized user-turn authority and dedupe**

**Goal:** Finish the transcript side of the contract so startup hardening and command routing operate on one idempotent finalized user-turn path.

**Requirements:** R6-R9, R10-R11, R13

**Dependencies:** Unit 1

**Files:**
- Modify: `voice/sophia_llm.py`
- Modify: `voice/tests/test_sophia_llm_streaming.py`
- Modify: `AI-companion-mvp-front/src/app/hooks/useStreamVoiceSession.ts`
- Modify: `AI-companion-mvp-front/src/__tests__/hooks/useStreamVoiceSession.test.ts`
- Validate: `AI-companion-mvp-front/src/__tests__/session/useSessionVoiceCommandSystem.test.ts`

**Approach:**
- Keep `sophia.user_transcript` as the only authoritative finalized user-turn event.
- Emit a stable `utterance_id` on that event from the voice layer.
- Ignore repeated finalized-user events with the same `utterance_id` in the frontend session hook before they can create duplicate user messages or duplicate command side effects.
- Preserve invisible-command behavior on the same finalized-turn path.

**Patterns to follow:**
- Current `sophia.user_transcript` emission and ordering assertions in `voice/tests/test_sophia_llm_streaming.py`
- Existing invisible command handling in `AI-companion-mvp-front/src/app/session/useSessionVoiceCommandSystem.ts`
- Existing finalized-turn routing in `AI-companion-mvp-front/src/app/hooks/useStreamVoiceSession.ts`

**Test scenarios:**
- Happy path: one finalized utterance produces one authoritative user-turn callback.
- Edge case: duplicate `sophia.user_transcript` event is ignored idempotently.
- Edge case: supported voice command consumes the finalized turn and does not append a normal history message.
- Edge case: partial transcript data never mutates authoritative conversation state.

**Verification:**
- Finalized user-turn handling is single-path and idempotent.
- Command routing and visible transcript rendering cannot diverge on user-turn authority.
- Focused frontend and voice-layer tests pass with the new `utterance_id` contract.

## Risks And Mitigations

- Risk: remote participant join may not remain sufficient as a readiness signal under future Vision Agents or Stream behavior changes.
  Mitigation: the contract is isolated in the frontend voice hooks, and a dedicated ready event remains an explicit fallback if future evidence requires it.
- Risk: frontend stage changes regress voice status copy or route behavior.
  Mitigation: extend composer and route-experience tests before changing displayed readiness semantics.
- Risk: turn-phase events get treated as a proxy for startup readiness.
  Mitigation: document and test startup readiness separately from `sophia.turn` phases.

## Verification Strategy

- Frontend first pass completed with:
  - `AI-companion-mvp-front/src/__tests__/hooks/useStreamVoice.test.ts`
  - `AI-companion-mvp-front/src/__tests__/hooks/useStreamVoiceSession.test.ts`
  - `AI-companion-mvp-front/src/__tests__/session/useSessionRouteExperience.test.ts`
  - `AI-companion-mvp-front/src/__tests__/session/useSessionVoiceCommandSystem.test.ts`
- Finalized user-turn dedupe pass completed with:
  - `AI-companion-mvp-front/src/__tests__/hooks/useStreamVoiceSession.test.ts`
  - `AI-companion-mvp-front/src/__tests__/session/useSessionVoiceCommandSystem.test.ts`
  - `voice/tests/test_sophia_llm_streaming.py`
- Any future expansion of the startup contract into backend or voice-layer events should add targeted tests in `backend/tests/test_voice_gateway.py` and `voice/tests/test_server_readiness.py`.

## Out-of-Scope Follow-Ups

- Same-conversation text fallback after startup failure
- Editable draft handoff from failed voice startup
- Auto-resume or delayed recovery UX if Sophia becomes ready later

If startup telemetry later shows those paths are common enough to matter, they can be planned as a separate recovery UX pass.