---
date: 2026-04-01
topic: mvp-voice-startup-contract-hardening
---

# MVP Voice Startup Contract Hardening

## Problem Frame

The current live voice path still conflates transport connection with Sophia readiness. The minimum fix already blocks the known `session_id: null` failure, but a user can still reach a transport-joined state before the product has an authoritative signal that Sophia is actually ready to respond.

That remaining gap is worth fixing for product quality. The earlier brainstorm drifted further than necessary into same-conversation fallback, editable draft handoff, and broader recovery UX. Those are optional recovery features, not the core correctness issue. The better route is narrower: define an explicit startup readiness contract, keep the UI non-ready until that contract is satisfied, and fail fast into a clear retryable unavailable state when startup does not complete.

This keeps the work focused on what materially improves the product: one canonical runtime owner for readiness and finalized-turn handling, rather than a richer degraded-state product mode.

## Requirements

**Voice Startup Contract**
- R1. Voice startup must distinguish between transport connection and Sophia readiness; transport join alone is not sufficient to treat voice as available.
- R2. The product must unlock normal voice interaction only after an explicit Sophia-ready signal from the canonical runtime contract.
- R3. Any pre-ready state may exist only as a short bounded connecting window and must not present as listening, ready, or normal conversation mode.
- R4. If Sophia is not ready within that bounded window, the product must fail fast into a clear retryable unavailable state rather than leaving the user in a silent connected room.
- R5. The connect contract and/or voice event contract must clearly indicate startup success or retryable startup failure; the frontend must not infer readiness from absence of errors alone.

**Canonical Transcript Contract**
- R6. The canonical runtime must normalize finalized user turns once and expose them as the only authoritative user-turn event for rendering, command routing, and startup hardening flows.
- R7. Supported voice commands must consume that same finalized user-turn event before history append and remain invisible as normal conversation messages.
- R8. Partial or provisional transcript data may exist for transient UI only and must never become authoritative conversation state.
- R9. Duplicate or revised finalized-turn events must be handled idempotently so one utterance cannot create duplicate user messages or duplicate command side effects.

**Ownership Boundaries**
- R10. One canonical runtime owner in AI-companion-mvp-front must exclusively own readiness gating, transcript normalization, and shared conversation state mutation.
- R11. `/session` and `/chat` may differ only in entry experience and route-shell UX; they must not own separate voice or transcript orchestration stacks.
- R12. Minimal upstream gateway or voice-layer changes required to expose explicit readiness or finalized-turn signals are in scope; broad backend redesign is not.
- R13. Regression coverage must protect the readiness contract, unavailable-state transition, invisible command routing, and finalized-turn idempotency.

## Success Criteria
- The user never sees normal listening or ready voice UI before Sophia is actually available.
- A missing Sophia agent session or missing startup readiness fails fast into a retryable unavailable state rather than a long-lived silent connected room.
- Finalized user turns are rendered at most once.
- Supported voice commands work from the same finalized-turn event path and do not appear in normal conversation history.
- A new contributor can point to one canonical runtime owner for readiness, transcript normalization, and modality transitions without ambiguity.

## Scope Boundaries
- No true offline or no-network mode.
- No long-lived "connected but Sophia unavailable" product mode.
- No same-conversation text fallback or editable draft handoff in this pass.
- No broad voice UX redesign beyond what is required to enforce fail-fast startup and one canonical transcript contract.
- No broad backend architecture rewrite; only the minimal readiness or final-turn contract work needed to support the frontend contract.
- No second transcript pipeline for commands versus visible user messages.

## Key Decisions
- Fail fast over a rich degraded connected state.
- Treat Sophia readiness as an explicit contract, not an inferred UI heuristic.
- Use the existing gateway `session_id` plus matching Stream remote participant session IDs as the first startup-ready contract; add a dedicated ready event only if that proves insufficient.
- Defer same-conversation text fallback and editable draft preservation unless startup failure data later shows they are necessary.
- Use finalized user turns as the only authoritative transcript event.
- Keep voice commands invisible in history even though they consume the same finalized-turn contract.
- Keep ownership cleanup focused on enforcing one runtime owner, not on building more buffering behavior.

## Dependencies / Assumptions
- The gateway `session_id` returned by `/voice/connect` matches the Sophia agent participant session that later appears in Stream remote participant state.
- The build plan's API-contract-first posture is still the right model here; a small startup contract addition is preferable to a broader recovery feature branch.
- The canonical runtime owner can differentiate transient UI transcript state from authoritative finalized-turn state.

## Outstanding Questions

### Deferred to Planning
- [Affects R3-R5][Technical] What exact readiness signal and timeout shape should define the bounded startup window?
- [Affects R6-R9][Technical] Which event source should own finalized user-turn normalization and dedupe?
- [Affects R10-R11][Technical] Which current runtime module becomes the single owner, and which route-local layers must remain passive consumers?

## Alternatives Considered
- Long-lived connected-but-waiting voice mode with buffering and visible pending transcript: rejected because it externalizes backend availability uncertainty to the user and creates more transcript and fallback complexity than the problem warrants.
- Same-conversation text fallback with editable draft preservation: deferred because it may be good recovery UX later, but it is not required to close the current startup correctness gap.

## Next Steps
- Implement against `docs/plans/2026-04-02-002-fix-voice-startup-contract-hardening-plan.md`.