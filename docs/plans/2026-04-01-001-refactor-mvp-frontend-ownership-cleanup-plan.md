---
title: "refactor: MVP frontend ownership cleanup"
type: refactor
status: completed
date: 2026-04-01
origin: docs/brainstorms/2026-04-01-mvp-frontend-ownership-cleanup-requirements.md
---

# MVP Frontend Ownership Cleanup

## Overview

Reduce the Sophia MVP frontend to one canonical conversation runtime owner while preserving two stable entry routes, `/session` and `/chat`. The cleanup should remove duplicate orchestration, quarantine onboarding-only legacy voice code, and rewrite the architecture docs so they describe the real ownership model instead of the current drifted state.

Execution posture for the eventual implementation is characterization-first: preserve current route behavior and transport contracts before deleting or collapsing owners.

## Problem Frame

The origin document is correct about the current failure mode: the repo has cleanup intent, but runtime ownership is still split across multiple high-touch files and route-local stacks. `AI-companion-mvp-front/src/app/session/page.tsx` remains a broad coordinator even after many extractions, while `/chat` still owns an independent stream/runtime path through `AI-companion-mvp-front/src/app/components/ConversationView.tsx`, `AI-companion-mvp-front/src/app/stores/chat-store.ts`, and `AI-companion-mvp-front/src/app/chat/useChatAiRuntime.ts`. Voice ownership is similarly split: the active Stream/WebRTC path runs through `AI-companion-mvp-front/src/app/hooks/useStreamVoiceSession.ts`, but onboarding still depends on the older WebSocket stack under `AI-companion-mvp-front/src/app/hooks/voice/`.

The cleanup therefore needs to reduce owners, not just keep extracting smaller hooks. The explicit target is one canonical runtime owner for transcript, stream lifecycle, artifacts, and voice delivery, with `/session` and `/chat` becoming route shells over that owner.

## Requirements Trace

- R1-R5: One canonical runtime owner, two stable routes, no duplicate full-stack orchestration, route compatibility preserved.
- R6-R8: Cleanup must reduce ambiguity, document one place for new Sophia conversation work, and avoid helper-hook churn without ownership reduction.
- R9-R12: Staged rollout, current capabilities preserved, guardrails improved, and `AI-companion-mvp-front` kept as the only Sophia product surface.

## Scope Boundaries

- In scope: `AI-companion-mvp-front` route/runtime ownership, Stream/WebRTC voice ownership, route shells, runtime guardrails, and repo documentation that defines the Sophia surface boundary.
- In scope: lightweight boundary updates in the top-level `frontend/` app to prevent Sophia surface overlap from returning.
- Out of scope: backend protocol redesign, Mem0 architecture changes, repo-wide frontend consolidation, and cosmetic file movement without ownership reduction.
- Out of scope: deleting `/chat` or `/session` as user-facing URLs in this cleanup program.

## Context And Research

### Relevant Code And Patterns

- `AI-companion-mvp-front/docs/P0_ROUTE_OWNERSHIP_BASELINE_2026-03-03.md` and `AI-companion-mvp-front/docs/P0_SESSION_CANONICAL_CONTRACT_2026-03-03.md` describe the current two-owner model. They are useful as historical baseline, but they now conflict with the desired cleanup target.
- `AI-companion-mvp-front/FRONTEND_ARCHITECTURE.md` still treats `/session` and `/chat` as parallel runtime owners and identifies the largest hotspots as `src/app/session/page.tsx`, `src/app/hooks/useVoiceLoop.ts`, `src/app/stores/chat-store.ts`, and `src/app/api/chat/_lib/stream-transformers.ts`.
- `AI-companion-mvp-front/src/app/session/page.tsx` is still the densest session coordinator and currently composes many extracted hooks, including stream orchestration, artifacts, voice orchestration, and route-only lifecycle work.
- `AI-companion-mvp-front/src/app/components/ConversationView.tsx` remains the `/chat` owner and still wires voice, artifacts, interrupts, mode switching, and runtime integration locally.
- `AI-companion-mvp-front/src/app/stores/chat-store.ts` still owns chat runtime concerns such as `runtimeMode`, `aiSdkRuntime`, send/cancel/retry, stream lifecycle, and recovery behavior. That makes it a second runtime owner, not a route-local UI store.
- `AI-companion-mvp-front/src/app/session/useSessionChatRuntime.ts`, `AI-companion-mvp-front/src/app/session/useSessionStreamContract.ts`, `AI-companion-mvp-front/src/app/session/useSessionArtifactsReducer.ts`, and `AI-companion-mvp-front/src/app/session/useSessionVoiceBridge.ts` already encode the richer runtime behavior and are the best base for a neutral canonical runtime.
- `AI-companion-mvp-front/src/app/hooks/useStreamVoiceSession.ts` and `AI-companion-mvp-front/src/app/hooks/useStreamVoice.ts` are the live Stream/WebRTC voice transport owners.
- `AI-companion-mvp-front/src/app/onboarding/ui/useOnboardingVoice.ts` still imports the WebSocket/audio stack from `AI-companion-mvp-front/src/app/hooks/voice/useVoiceWebSocket.ts`, `useAudioPlayback.ts`, `voice-loop-connection-helpers.ts`, `voice-loop-command-helpers.ts`, and `voice-utils.ts`. Those files are not dead; they are compatibility-only.
- `AI-companion-mvp-front/src/app/components/StreamVoiceProvider.tsx` has no inbound references and is likely dead residue from the Stream migration.
- The top-level repo memory confirms that the duplicate Sophia memory/review surface has already been removed from `frontend/`; the remaining task there is a clear boundary, not another product cleanup pass.

### Institutional Learnings

- `AI-companion-mvp-front/docs/P5_SESSION_PRECHECK_2026-03-02.md` and `AI-companion-mvp-front/docs/REFRACTOR_PROGRESSIVE_PLAN.md` document many prior extractions from `session/page.tsx`. The lesson is clear: extraction alone does not solve ownership if route-level runtime logic still lives in multiple stacks.
- `docs/plans/2026-03-30-001-refactor-voice-transport-migration-plan.md` already expected most of the legacy WebSocket voice stack to be deleted after Stream migration. Current code shows that onboarding kept part of that stack alive, so the right move now is quarantine plus explicit classification, not indiscriminate deletion.
- The app's real test layout is `AI-companion-mvp-front/src/__tests__/`, not `tests/`. New guardrails and characterization coverage should follow that pattern.

### External Research Decision

Skipped. The repo already contains recent ownership contracts, migration plans, and focused implementation seams for the exact surfaces involved here. Additional external research would add little value compared with cleaning up the local ownership model consistently.

## Resolved Planning Questions

### 1. Canonical Route Vs Canonical Runtime

Use one canonical runtime shared by two stable routes.

Rationale:

- It satisfies R5 without forcing a product decision about deleting or redirecting `/chat`.
- `/session` and `/chat` still represent different entry experiences today, but they should stop owning different runtime stacks.
- A single canonical route with aliases would prematurely conflate product navigation with ownership cleanup.

Implication:

- `/session` and `/chat` remain routable.
- Runtime logic moves behind a neutral owner.
- Route-specific code becomes shell logic only.

### 2. Legacy Voice File Classification

Classify remaining voice code into three buckets.

Canonical runtime owners:

- `AI-companion-mvp-front/src/app/hooks/useStreamVoice.ts`
- `AI-companion-mvp-front/src/app/hooks/useStreamVoiceSession.ts`
- The current session-side adapter logic in `AI-companion-mvp-front/src/app/session/useSessionVoiceBridge.ts` as the starting point for the neutral owner

Compatibility-only onboarding voice code:

- `AI-companion-mvp-front/src/app/onboarding/ui/useOnboardingVoice.ts`
- `AI-companion-mvp-front/src/app/hooks/voice/useVoiceWebSocket.ts`
- `AI-companion-mvp-front/src/app/hooks/voice/useAudioPlayback.ts`
- `AI-companion-mvp-front/src/app/hooks/voice/voice-loop-connection-helpers.ts`
- `AI-companion-mvp-front/src/app/hooks/voice/voice-loop-command-helpers.ts`
- `AI-companion-mvp-front/src/app/hooks/voice/voice-websocket-message-parser.ts`
- The transport-specific parts of `AI-companion-mvp-front/src/app/hooks/voice/voice-utils.ts`

Dead or likely removable residue:

- `AI-companion-mvp-front/src/app/components/StreamVoiceProvider.tsx`
- Any leftover re-export surfaces under `AI-companion-mvp-front/src/app/hooks/voice/index.ts` that only point to onboarding-only code once the quarantine is complete

Keep for now:

- `AI-companion-mvp-front/src/app/hooks/useVoiceToggle.ts` is still used by `AI-companion-mvp-front/src/app/components/VoicePanel.tsx` and `AI-companion-mvp-front/src/app/components/VoiceFocusView.tsx`. It is UI logic, not transport logic.

### 3. Boundary Between `AI-companion-mvp-front` And Top-Level `frontend`

Add an explicit boundary document plus a lightweight guardrail check.

Rationale:

- The duplicate non-MVP Sophia memory surface is already gone.
- The remaining risk is future drift, not current duplicated product logic.
- Documentation alone is too soft; a small automated boundary check is justified.

Implication:

- `AI-companion-mvp-front` stays the only Sophia companion product surface.
- The top-level `frontend/` app gets a short boundary note, not another feature cleanup project.
- A static guardrail prevents reintroduction of removed Sophia-specific top-level frontend paths.

## Key Technical Decisions

- Introduce a neutral canonical owner under `AI-companion-mvp-front/src/app/companion-runtime/` rather than continue expanding route-specific stacks.
- Build that neutral owner from the existing session runtime seams because they already handle the richer contract: AI SDK transport, data-part normalization, artifact ingestion, interrupt handling, and Stream/WebRTC voice bridging.
- Reduce `chat-store` to route-local UI state and persistence helpers. Remove network and stream lifecycle ownership from it.
- Keep ritual lifecycle concerns in `src/app/session/` only: bootstrap, session validation, debrief/recap exit flow, and route-only chrome/UX.
- Treat onboarding voice as a compatibility island. Move it under an onboarding-specific namespace so it stops looking like an alternative runtime path.
- Prefer deleting route-wrapper glue after migration rather than preserving wrapper-on-wrapper layers.

## High-Level Technical Design

This section is directional guidance for the implementation, not code to copy directly.

### Target Ownership Shape

```text
/session/page.tsx ---------------------> session route shell
                                         |
                                         v
                                   useSessionRouteExperience
                                         |
                                         v
                                companion-runtime/useCompanionRuntime
                                         |
              ---------------------------------------------------------------
              |                         |                      |              |
              v                         v                      v              v
        chat-runtime             stream-contract        artifacts-runtime   voice-runtime
              |                         |                      |              |
              --------------------------|----------------------|--------------
                                         |
                                         v
                                /api/chat + Stream/WebRTC

/chat/page.tsx -----------------------> chat route shell
                                         |
                                         v
                                   useChatRouteExperience
                                         |
                                         v
                                companion-runtime/useCompanionRuntime

onboarding/ui/useOnboardingVoice.ts --> onboarding/voice-legacy/*
```

### Canonical Public Owner

Create one public runtime seam:

- `AI-companion-mvp-front/src/app/companion-runtime/useCompanionRuntime.ts`

It should own:

- transcript state for live conversation turns
- send/cancel/retry lifecycle
- AI SDK transport binding
- stream data-part normalization
- artifact application
- interrupt delivery into route shells
- Stream/WebRTC voice integration and retry playback hooks

It should not own:

- session bootstrap/start/end flows
- recap/debrief decisions
- top-level route navigation
- onboarding voice-over

### Route Shell Rule

- `/session` may keep route-only lifecycle and ritual UX, but it must stop owning its own runtime stack.
- `/chat` may keep free-chat presentation and route copy, but it must stop owning stream transport, transcript orchestration, or voice transport.

## Implementation Units

### Phase 1: Create The Canonical Runtime Owner

- [x] **Unit 1: Introduce `companion-runtime` as the only runtime owner**

**Goal:** Create the neutral runtime seam and move shared conversation concerns under it without changing user-facing behavior.

**Requirements:** R1, R2, R3, R6, R9, R10, R11

**Dependencies:** None

**Files:**
- Create: `AI-companion-mvp-front/src/app/companion-runtime/useCompanionRuntime.ts`
- Create: `AI-companion-mvp-front/src/app/companion-runtime/chat-runtime.ts`
- Create: `AI-companion-mvp-front/src/app/companion-runtime/stream-contract.ts`
- Create: `AI-companion-mvp-front/src/app/companion-runtime/artifacts-runtime.ts`
- Create: `AI-companion-mvp-front/src/app/companion-runtime/voice-runtime.ts`
- Create: `AI-companion-mvp-front/src/app/companion-runtime/route-profiles.ts`
- Create: `AI-companion-mvp-front/src/app/companion-runtime/types.ts`
- Modify: `AI-companion-mvp-front/src/app/session/useSessionChatRuntime.ts`
- Modify: `AI-companion-mvp-front/src/app/session/useSessionStreamContract.ts`
- Modify: `AI-companion-mvp-front/src/app/session/useSessionArtifactsReducer.ts`
- Modify: `AI-companion-mvp-front/src/app/session/useSessionVoiceBridge.ts`
- Test: `AI-companion-mvp-front/src/__tests__/companion-runtime/useCompanionRuntime.test.ts`
- Test: `AI-companion-mvp-front/src/__tests__/companion-runtime/route-profiles.test.ts`
- Test: `AI-companion-mvp-front/src/__tests__/companion-runtime/stream-contract.test.ts`
- Modify tests: `AI-companion-mvp-front/src/__tests__/session/useSessionChatRuntime.test.ts`
- Modify tests: `AI-companion-mvp-front/src/__tests__/session/useSessionArtifactsReducer.test.ts`
- Modify tests: `AI-companion-mvp-front/src/__tests__/session/stream-contract-adapters.test.ts`

**Approach:**
- Promote the existing session-side runtime logic into neutral modules rather than inventing a second abstraction stack.
- Give route differences a data profile in `route-profiles.ts` instead of route-local runtime code branches.
- Keep session-facing wrappers temporarily only if they simplify incremental migration; delete them once both routes are moved.

**Patterns to follow:**
- `AI-companion-mvp-front/src/app/session/useSessionChatRuntime.ts`
- `AI-companion-mvp-front/src/app/session/useSessionStreamContract.ts`
- `AI-companion-mvp-front/src/app/session/useSessionArtifactsReducer.ts`
- `AI-companion-mvp-front/src/app/session/useSessionVoiceBridge.ts`

**Test scenarios:**
- Happy path: canonical runtime sends a text turn and forwards AI SDK finish metadata into the shared message model.
- Happy path: canonical runtime applies artifacts and interrupts from data events without route-specific parsing.
- Happy path: route profile `ritual` includes session context and route profile `chat` preserves free-chat defaults.
- Edge case: offline or backend-unavailable errors still map to the same warning/error semantics as today.
- Edge case: artifact fallback filtering remains identical to current session behavior.
- Edge case: voice retry state survives runtime migration without replaying duplicate assistant messages.

**Verification:**
- A single runtime import path exists for shared conversation behavior.
- Existing session behavior remains green under characterization tests.

---

- [x] **Unit 2: Move `/chat` onto the canonical runtime and shrink `chat-store`**

**Goal:** Remove `/chat` as an independent runtime owner and reduce it to a route shell plus route-local UI state.

**Requirements:** R1, R2, R4, R5, R6, R8, R10, R11

**Dependencies:** Unit 1

**Files:**
- Create: `AI-companion-mvp-front/src/app/chat/useChatRouteExperience.ts`
- Modify: `AI-companion-mvp-front/src/app/chat/page.tsx`
- Modify: `AI-companion-mvp-front/src/app/components/ConversationView.tsx`
- Modify: `AI-companion-mvp-front/src/app/stores/chat-store.ts`
- Modify: `AI-companion-mvp-front/src/app/chat/chat-voice-artifacts.ts`
- Delete: `AI-companion-mvp-front/src/app/chat/useChatAiRuntime.ts`
- Test: `AI-companion-mvp-front/src/__tests__/chat/useChatRouteExperience.test.tsx`
- Test: `AI-companion-mvp-front/src/__tests__/components/ConversationView.route-shell.test.tsx`
- Modify tests: `AI-companion-mvp-front/src/__tests__/stores/chat-store-ai-sdk-runtime.test.ts`
- Modify tests: `AI-companion-mvp-front/src/__tests__/chat/chat-voice-artifacts.test.ts`
- Delete or replace tests: `AI-companion-mvp-front/src/__tests__/chat/useChatAiRuntime.test.ts`

**Approach:**
- Route all `/chat` send/cancel/retry/voice/artifact behavior through `useCompanionRuntime`.
- Convert `chat-store` into a UI/persistence store only. Remove `runtimeMode`, `aiSdkRuntime`, and network/stream lifecycle ownership.
- Keep `ConversationView` as a presentation-focused route surface. It should consume runtime outputs, not create them.

**Patterns to follow:**
- The current `/chat` message-shaping expectations in `AI-companion-mvp-front/src/app/components/ConversationView.tsx`
- Artifact mapping behavior in `AI-companion-mvp-front/src/app/chat/chat-voice-artifacts.ts`

**Test scenarios:**
- Happy path: `/chat` still streams text turns correctly through `/api/chat`.
- Happy path: `/chat` voice mode still receives transcript and artifact updates from the canonical runtime.
- Happy path: cancel and retry still work from `/chat` without `chat-store` owning transport.
- Edge case: recovered or interrupted turns still rehydrate the correct assistant message.
- Edge case: free-chat route preserves `chat` session profile and does not accidentally adopt ritual-only side effects.

**Verification:**
- No transport or AI SDK binding remains under `/chat`-specific runtime files.
- `ConversationView` reads like a route shell, not an orchestration hub.

---

- [x] **Unit 3: Move `/session` onto the same canonical runtime and leave only ritual-only lifecycle in `src/app/session/`**

**Goal:** Keep `/session` as the ritual route while removing duplicate runtime ownership from the session domain.

**Requirements:** R1, R2, R3, R5, R6, R8, R9, R10, R11

**Dependencies:** Unit 1

**Files:**
- Create: `AI-companion-mvp-front/src/app/session/useSessionRouteExperience.ts`
- Modify: `AI-companion-mvp-front/src/app/session/page.tsx`
- Modify: `AI-companion-mvp-front/src/app/session/useSessionVoiceCommandSystem.ts`
- Modify: `AI-companion-mvp-front/src/app/session/useSessionMessageViewModel.ts`
- Modify: `AI-companion-mvp-front/src/app/session/useSessionUiDerivedState.ts`
- Delete: `AI-companion-mvp-front/src/app/session/useSessionChatRuntime.ts`
- Delete: `AI-companion-mvp-front/src/app/session/useSessionStreamContract.ts`
- Delete: `AI-companion-mvp-front/src/app/session/useSessionArtifactsReducer.ts`
- Delete: `AI-companion-mvp-front/src/app/session/useSessionVoiceOrchestration.ts`
- Delete: `AI-companion-mvp-front/src/app/session/useSessionVoiceBridge.ts`
- Delete: `AI-companion-mvp-front/src/app/session/useSessionVoiceMessages.ts`
- Delete: `AI-companion-mvp-front/src/app/session/useSessionVoiceUiControls.ts`
- Test: `AI-companion-mvp-front/src/__tests__/session/useSessionRouteExperience.test.ts`
- Modify tests: `AI-companion-mvp-front/src/__tests__/session/useSessionVoiceOrchestration.test.ts`
- Modify tests: `AI-companion-mvp-front/src/__tests__/session/useSessionVoiceCommandSystem.test.ts`
- Modify tests: `AI-companion-mvp-front/src/__tests__/session/useSessionRetryHandlers.test.ts`
- Modify tests: `AI-companion-mvp-front/src/__tests__/session/useSessionStreamPersistence.test.ts`

**Approach:**
- Session route code should keep ritual-only behavior: bootstrap, validation, debrief, recap, exit protection, and route chrome.
- Shared transcript/stream/voice/artifact behavior should come from `useCompanionRuntime` through a session adapter.
- Remove wrapper-only session modules once the route shell consumes the canonical owner directly.

**Patterns to follow:**
- The existing session-specific lifecycle hooks already extracted around `page.tsx`
- The separation guidance recorded in `AI-companion-mvp-front/docs/P5_SESSION_PRECHECK_2026-03-02.md`

**Test scenarios:**
- Happy path: ritual session still boots, streams, and updates artifacts exactly once.
- Happy path: voice input, reflection voice flow, and interrupt handling still work on `/session`.
- Happy path: session end, debrief offer, and recap navigation remain route-owned.
- Edge case: reconnect and interrupted-refresh recovery still restore the correct transcript state.
- Edge case: read-only sessions and expired/multi-tab guards remain independent of the shared runtime.

**Verification:**
- `/session` keeps ritual UX but no longer owns a separate runtime stack.
- High-touch wrapper files in `src/app/session/` are materially reduced.

---

- [x] **Unit 4: Quarantine onboarding-only legacy voice code and remove dead voice residue**

**Goal:** Make the Stream/WebRTC path the only conversation voice runtime while keeping onboarding voice-over explicitly separate.

**Requirements:** R3, R6, R9, R10, R11

**Dependencies:** Unit 1, Unit 3

**Files:**
- Create: `AI-companion-mvp-front/src/app/lib/voice-types.ts`
- Create: `AI-companion-mvp-front/src/app/onboarding/voice-legacy/useAudioPlayback.ts`
- Create: `AI-companion-mvp-front/src/app/onboarding/voice-legacy/useVoiceWebSocket.ts`
- Create: `AI-companion-mvp-front/src/app/onboarding/voice-legacy/voice-loop-connection-helpers.ts`
- Create: `AI-companion-mvp-front/src/app/onboarding/voice-legacy/voice-loop-command-helpers.ts`
- Create: `AI-companion-mvp-front/src/app/onboarding/voice-legacy/voice-websocket-message-parser.ts`
- Modify: `AI-companion-mvp-front/src/app/onboarding/ui/useOnboardingVoice.ts`
- Modify: `AI-companion-mvp-front/src/app/hooks/useStreamVoice.ts`
- Modify: `AI-companion-mvp-front/src/app/hooks/useStreamVoiceSession.ts`
- Modify: `AI-companion-mvp-front/src/app/hooks/useVoiceToggle.ts`
- Modify: `AI-companion-mvp-front/src/app/hooks/voice/voice-utils.ts`
- Delete: `AI-companion-mvp-front/src/app/components/StreamVoiceProvider.tsx`
- Delete: `AI-companion-mvp-front/src/app/hooks/voice/useAudioPlayback.ts`
- Delete: `AI-companion-mvp-front/src/app/hooks/voice/useVoiceWebSocket.ts`
- Delete: `AI-companion-mvp-front/src/app/hooks/voice/voice-loop-connection-helpers.ts`
- Delete: `AI-companion-mvp-front/src/app/hooks/voice/voice-loop-command-helpers.ts`
- Delete: `AI-companion-mvp-front/src/app/hooks/voice/voice-websocket-message-parser.ts`
- Test: `AI-companion-mvp-front/src/__tests__/hooks/useStreamVoice.test.ts`
- Test: `AI-companion-mvp-front/src/__tests__/hooks/useStreamVoiceSession.test.ts`
- Create test: `AI-companion-mvp-front/src/__tests__/onboarding/useOnboardingVoice.test.ts`
- Modify tests: `AI-companion-mvp-front/src/__tests__/hooks/voice/voice-loop-command-helpers.test.ts`

**Approach:**
- Extract shared type-only definitions from legacy `voice-utils.ts` into `voice-types.ts`.
- Move onboarding-only transport helpers under an onboarding namespace so they stop appearing to be a competing conversation runtime.
- Remove dead Stream residue once import graphs are clean.

**Patterns to follow:**
- The classification and carve-out rule documented in `docs/plans/2026-03-30-001-refactor-voice-transport-migration-plan.md`
- Current onboarding voice call flow in `AI-companion-mvp-front/src/app/onboarding/ui/useOnboardingVoice.ts`

**Test scenarios:**
- Happy path: session and chat voice still connect and speak through Stream/WebRTC.
- Happy path: onboarding voice-over still plays with the legacy WebSocket path.
- Edge case: no conversation runtime import path points into `src/app/onboarding/voice-legacy/`.
- Edge case: shared `VoiceStage` or related UI types remain stable after the type split.
- Edge case: removing `StreamVoiceProvider.tsx` does not break any imports.

**Verification:**
- One clear voice runtime exists for conversation routes.
- Onboarding legacy voice is visibly quarantined instead of mixed into runtime code.

---

- [x] **Unit 5: Rewrite ownership docs and add a repo boundary guardrail**

**Goal:** Make the cleaned ownership model explicit and prevent Sophia surface overlap from returning.

**Requirements:** R7, R8, R11, R12

**Dependencies:** Units 1-4

**Files:**
- Modify: `AI-companion-mvp-front/FRONTEND_ARCHITECTURE.md`
- Modify: `AI-companion-mvp-front/docs/P0_ROUTE_OWNERSHIP_BASELINE_2026-03-03.md`
- Modify: `AI-companion-mvp-front/docs/P0_SESSION_CANONICAL_CONTRACT_2026-03-03.md`
- Create: `docs/MVP_FRONTEND_SURFACE_BOUNDARY.md`
- Modify: `frontend/CLAUDE.md`
- Create: `scripts/check-sophia-surface-boundary.js`
- Modify: `AI-companion-mvp-front/package.json`
- Create test: `AI-companion-mvp-front/src/__tests__/architecture/runtime-ownership-contract.test.ts`

**Approach:**
- Rewrite the MVP architecture docs so they describe one canonical runtime owner and two route shells.
- Add a repo boundary doc that states `AI-companion-mvp-front` is the only Sophia companion product surface.
- Add a lightweight automated check that fails if removed top-level frontend Sophia paths reappear or if route-local runtime files are reintroduced in the wrong places.

**Patterns to follow:**
- Existing guardrail style in `AI-companion-mvp-front/package.json` such as `test:guardrails:p4`
- The current repo-memory boundary already established by the recent top-level frontend cleanup

**Test scenarios:**
- Happy path: architecture contract test passes when `/session` and `/chat` both point to the canonical runtime.
- Happy path: boundary script passes when the removed top-level frontend Sophia paths stay absent.
- Edge case: boundary script fails if `frontend/src/core/sophia` or `frontend/src/app/mock/api/sophia` reappears.
- Edge case: boundary script fails if a new `/chat`-local transport owner is introduced after cleanup.

**Verification:**
- Docs describe the real ownership model.
- The repo has one explicit place to point contributors for new Sophia conversation work.

## Sequencing

1. Build and characterize the canonical runtime owner.
2. Move `/chat` first because it has the clearest duplicated runtime ownership.
3. Move `/session` second, preserving ritual-only lifecycle hooks.
4. Quarantine onboarding legacy voice only after the canonical voice runtime is stable.
5. Finish with docs and guardrails so the new model stays durable.

## Completion Notes

- Completed on 2026-04-01.
- Final closeout validation passed in `AI-companion-mvp-front` via `corepack pnpm run test:guardrails:p4`.
- The closeout guardrail pass included `check:logs:global`, `check:sophia:surface-boundary`, `type-check`, and the targeted runtime ownership and voice test suite.

## Risks And Mitigations

| Risk | Mitigation |
| --- | --- |
| The new canonical runtime becomes another god-hook instead of a simplification | Keep only cross-route runtime concerns in `companion-runtime`. Leave ritual lifecycle and route chrome outside it. |
| `/chat` loses route-specific behavior during convergence | Encode route differences in `route-profiles.ts` and characterize existing `/chat` behavior before deleting its runtime path. |
| Session voice regressions during wrapper removal | Move session route logic onto the canonical runtime before deleting wrapper modules, and keep voice characterization tests green throughout. |
| Onboarding voice breaks if legacy helpers are deleted too early | Quarantine first, then delete only after the import graph is clean and onboarding tests exist. |
| Docs drift again after cleanup | Add the ownership contract test and boundary script in the same phase as the doc rewrite. |

## Sources And References

- Origin document: `docs/brainstorms/2026-04-01-mvp-frontend-ownership-cleanup-requirements.md`
- Current baseline: `AI-companion-mvp-front/FRONTEND_ARCHITECTURE.md`
- Route ownership baseline: `AI-companion-mvp-front/docs/P0_ROUTE_OWNERSHIP_BASELINE_2026-03-03.md`
- Canonical session contract: `AI-companion-mvp-front/docs/P0_SESSION_CANONICAL_CONTRACT_2026-03-03.md`
- Session extraction learnings: `AI-companion-mvp-front/docs/P5_SESSION_PRECHECK_2026-03-02.md`
- Progressive refactor history: `AI-companion-mvp-front/docs/REFRACTOR_PROGRESSIVE_PLAN.md`
- Voice migration history: `docs/plans/2026-03-30-001-refactor-voice-transport-migration-plan.md`