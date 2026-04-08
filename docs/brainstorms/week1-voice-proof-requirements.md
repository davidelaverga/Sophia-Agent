---
date: 2026-03-29
topic: week1-voice-proof
---

# Week 1 Voice Proof

## Problem Frame
Luis already has the Week 1 voice scaffold in place, but the workspace does not yet contain a real `sophia_companion` backend to connect against. If we wait for the backend before proving the voice loop, Week 1 stalls. If we ignore the future backend contract, we risk building a smoke test that has to be thrown away.

This block should prove that Sophia's voice path works end-to-end as a real conversation surface, while keeping the work aligned to the expected DeerFlow streaming contract so the switch to the real backend is low-friction.

## Requirements

**Proof Goal**
- R1. The block must produce a local voice smoke test where a human can speak, the system detects turn end, Sophia responds with streamed text, and the response is heard as audio.
- R2. The primary success criterion is integration smoke, not polish. The system only needs to be reliable enough to demonstrate a real conversation loop.

**Backend Strategy**
- R3. The block must support a dual-mode backend strategy: a contract-respecting shim for immediate validation, and a real backend mode for later swap-in without rewriting the voice surface.
- R4. The shim mode must preserve the core observable contract shape expected from DeerFlow: streamed assistant text and a separate artifact payload/event path, even if the content is simplified.
- R5. Switching from shim mode to real backend mode must be configuration-driven and must not require a second parallel voice stack.
- R6. Shim mode must emit a synthetic artifact shaped closely enough to the expected Sophia artifact contract that artifact parsing and handoff logic are exercised, even if the values are temporary.

**Verification**
- R7. The smoke test must capture the minimum timing checkpoints needed for Week 1 decision-making: speech end to first streamed text, and speech end to first audible TTS output.
- R8. The proof path must run through the existing `voice/` service directly, not through a broader frontend or gateway integration layer.
- R9. The block must end with a concise operator checklist showing how to run the proof, what success looks like, and what remains to validate once `sophia_companion` exists.

**Failure Handling**
- R10. The smoke proof must define minimum expected behavior for silence or empty transcript input, placeholder-backend unavailability, and upstream STT or TTS errors.
- R11. Failures during the proof must be observable enough that the operator can tell which stage failed without reading application code.

## Success Criteria
- A teammate can run the voice service locally and complete at least one real speak-to-hear round trip.
- The proof works without depending on unimplemented backend code.
- The round trip is exercised through the existing `voice/` scaffold rather than a separate temporary path.
- The contract handoff to the real backend is explicit enough that `/ce:plan` can focus on implementation details instead of redefining scope.

## Scope Boundaries
- Not in scope: Week 2 voice-emotion polish, Cartesia emotion quality tuning, or final latency optimization to the `< 3s` target.
- Not in scope: building the actual `sophia_companion` backend.
- Not in scope: memory candidates UI or Journal work.
- Not in scope: full frontend, nginx, or gateway-level integration for this proof.

## Key Decisions
- Dual-mode backend is the recommended direction: prove the voice loop now with a contract-first shim, then swap to the real backend when Jorge lands it.
- This block is judged by conversational viability, not by production readiness.
- Contract fidelity matters more than temporary prompt sophistication.
- The proof should use real STT and TTS providers when credentials are available; only the companion backend is temporarily replaceable.
- The canonical execution path for this block is the existing `voice/` service and its local demo or runner entrypoint.

## Dependencies / Assumptions
- The existing `voice/` scaffold remains the single voice entry point for both shim and real backend modes.
- The backend team will later provide a real `runs/stream` source compatible with the Week 1 contract.
- Real provider credentials for Stream, Deepgram, and Cartesia are available for the smoke proof, or that gap is treated as an explicit environment blocker.

## Outstanding Questions

### Deferred to Planning
- [Affects R3][Technical] What is the smallest shim shape that exercises both streamed text and artifact handling without creating throwaway complexity?
- [Affects R7][Technical] Where should timing checkpoints be recorded so they are easy to compare later against real backend runs?
- [Affects R10][Technical] What is the leanest operator-facing error surface for stage-level failures during the smoke proof?

## Next Steps
→ `/ce:plan` for structured implementation planning