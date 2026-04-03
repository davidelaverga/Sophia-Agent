---
date: 2026-04-01
topic: sophia-artifact-pipeline-audit
---

# Sophia Artifact Pipeline Audit

## Problem Frame

Sophia's product spec expects a full artifact on every companion turn and expects that artifact to influence voice continuity, TTS emotion, and frontend artifact display during live interaction. The MVP frontend already has a shared artifact ingestion and rendering path for chat, session, and live voice experiences. The open question is whether the live backend and live frontend are actually connected end to end, or whether the artifact panel is waiting on data that never arrives.

Current audit findings:

- The text and structured-stream frontend path is implemented around structured artifact events and passes targeted frontend tests.
- The live voice frontend path is also implemented, but it depends on Stream custom events named `sophia.artifact`, `sophia.transcript`, and `sophia.turn`.
- The live voice backend currently does not wire the `SophiaLLM.attach_call_emitter(...)` hook in agent startup, so `sophia.artifact` is not forwarded to the client even when an artifact is captured.
- The live DeerFlow voice adapter currently requests only `messages-tuple` stream mode and treats streamed `emit_artifact` tool-call args as the authoritative artifact source.
- Prior repo validation indicates Anthropic streaming can surface empty or partial tool-call args during chunked output, while the reliable completed artifact appears in `values.current_artifact`.
- `origin/main` does not contain a newer version of the voice adapter stack. This is not a case where the current backend is simply behind an upstream main-branch fix.

Conclusion: live voice artifacts are not currently reliable end to end. The primary fault is in the live voice transport contract, not in the artifact panel UI.

## Requirements

**Voice Transport Contract**

- R1. The live voice server must attach a custom-event emitter to `SophiaLLM` during agent creation so artifact events can reach Stream clients in real time.
- R2. The live voice backend must treat the final normalized artifact as the source of truth, not partial streamed `tool_calls[].args` fragments.
- R3. The DeerFlow voice adapter must request the stream modes needed to observe the completed artifact state, including `values`, and must read the final artifact from the run state when available.
- R4. Partial or empty streamed `emit_artifact` args must not trigger a hard contract failure by themselves if a valid final artifact becomes available later in the same turn.
- R5. A live voice turn should only fail the artifact contract when the turn completes without any parseable final artifact.

**Frontend Contract Preservation**

- R6. The frontend live voice contract should remain event-driven: `useStreamVoiceSession` continues to consume `sophia.artifact` for artifact updates rather than introducing a second polling or recap-only path.
- R7. The existing shared artifact ingestion seams in `AI-companion-mvp-front` remain the canonical place for artifact normalization, merge, and panel rendering; the fix should not move artifact ownership back into route pages or UI components.
- R8. The text/chat artifact path using structured `data-artifactsV1` events must continue to work unchanged.
- R9. The live session artifacts panel must update from voice artifacts during the active conversation, without requiring session end or a later recap fetch.

**Contract Completeness**

- R10. If the frontend continues to rely on `sophia.transcript` and `sophia.turn`, the live voice backend must explicitly emit those events as part of the same Stream custom-event contract.
- R11. If transcript or turn events are intentionally not part of the live contract, the frontend voice runtime must be revised so it no longer waits on events that the server never emits.
- R12. Planning must choose one contract and remove the current split-brain state where the frontend expects custom events that the server does not produce.

**Verification**

- R13. Voice adapter tests must cover the real streamed artifact lifecycle: partial tool args, empty tool args, completed artifact in final state, and exactly-once artifact emission to the frontend layer.
- R14. A server-level integration test must verify that the voice agent startup path actually wires the custom-event emitter used by `SophiaLLM`.
- R15. Frontend tests must continue to verify artifact ingestion and panel rendering, but at least one higher-level smoke path must validate that a live voice artifact reaches the frontend from the real server contract rather than a locally injected fake event.
- R16. Validation must explicitly distinguish between three states: no artifact produced, artifact produced but not forwarded, and artifact forwarded but not rendered.

## Success Criteria

- SC1. During a live voice conversation, the frontend receives a `sophia.artifact` event for a completed turn and the artifacts panel updates without waiting for session exit.
- SC2. A valid live Sophia turn no longer fails with a backend-contract error because streamed `emit_artifact` args were partial or empty mid-stream.
- SC3. The current frontend artifact tests continue to pass after the transport fix.
- SC4. The transport contract is explicit enough that planning can describe one authoritative artifact source for live voice.
- SC5. The implementation no longer depends on a presumed upstream fix that does not exist on `origin/main`.

## Scope Boundaries

- In scope: live voice artifact transport, event forwarding, authoritative artifact source selection, and test coverage needed to prove the contract.
- In scope: deciding whether transcript/turn custom events are part of the supported live frontend contract.
- Out of scope: redesigning the artifact panel UI, recap experience, or memory review UX.
- Out of scope: changing the 13-field artifact schema itself unless a separate product decision is made.
- Out of scope: Journal visual artifacts, offline pipeline generation, or broader Mem0 review flows.

## Key Decisions

- Live voice artifact failure is primarily a backend transport problem, not an artifact panel rendering problem.
- The shared `AI-companion-mvp-front` artifact runtime is already the correct frontend owner and should be preserved.
- `origin/main` is not the source of a missing fix for the live voice artifact path; the problem exists within the current branch-local voice implementation.
- Planning should prefer one authoritative live artifact source. The strongest current candidate is final run state (`current_artifact` via `values`) rather than partial streamed tool-call args.
- The current live custom-event contract is incomplete. Either the backend must emit the events the frontend expects, or the frontend must stop depending on them.

## Dependencies / Assumptions

- Stream custom events are supported by the live voice transport and can carry the Sophia artifact payload.
- The artifact payload size remains within Stream custom-event limits.
- The backend state already stores `current_artifact` and `previous_artifact`, so a final-state artifact source exists conceptually.

## Outstanding Questions

### Deferred to Planning

- [Affects R3][Technical] What is the smallest safe change to the DeerFlow voice adapter that reads final artifact state without regressing text streaming latency?
- [Affects R10][Technical] Should `sophia.transcript` and `sophia.turn` be emitted from the voice server, or should the frontend voice runtime derive that state differently?
- [Affects R14][Needs research] What is the cleanest integration seam in Vision Agents to attach the call emitter from `SophiaLLM` to the active Stream call lifecycle?
- [Affects R15][Needs research] What is the most reliable smoke test for proving live artifact delivery in local dev: mocked Stream edge, local browser smoke, or a backend integration harness?

## Next Steps

→ /ce-plan for structured implementation planning