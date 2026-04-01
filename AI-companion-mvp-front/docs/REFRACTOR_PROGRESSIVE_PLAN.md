# Sophia Frontend Refactor — Progressive Plan (Single Source of Truth)

## Purpose
This document is the canonical plan to eliminate remaining god files safely, without UX regressions.
Every new refactor task should start by reviewing this file and updating progress.

## Current Status (as of 2026-03-01)
- ✅ PR1: observability/log hygiene
- ✅ PR2: stream protocol normalization (data-stream by default)
- ✅ PR3: send/retry dedupe consolidation (`send-gate`)
- ✅ PR4: defensive parser against accidental UI stream dump rendering
- ✅ PR5: session page de-godification (mini-PRs 5.1–5.5)
- ✅ PR6: chat API route phase-1 pipeline partitioning
- ✅ PR7: voice loop phase-1 partitioning
- ✅ PR8: legacy text-path retirement (data-stream only)
- ✅ PR9: hardening + documentation closeout
- ✅ PR10: cleanup hardening pass (lint + legacy residue removal)
- ✅ PR11: session outbound send extraction (page de-godification increment)
- ✅ PR12: voice command orchestration extraction (page de-godification increment)
- ✅ PR13: voice message append extraction (page de-godification increment)
- ✅ PR14: voice UI controls extraction (page de-godification increment)
- ✅ PR15: session UI panel state consolidation
- ✅ PR16: queue/connectivity runtime extraction
- ✅ PR17: session companion integration extraction
- ✅ PR18: interrupt/retry local state extraction
- ✅ PR19: session page context consolidation
- ✅ PR20: page render block composition split
- ✅ PR21: voice loop phase-2 hardening
- ✅ PR22: regression guard tests for extracted session hooks
- ✅ Phase 2 roadmap complete (PR16–PR22)
- ⚠️ New quality roadmap pending (P1–P4):
  - `P1` critical domain partition (chat store / voice loop / session page)
  - `P2` type-safety hardening (`strict` migration by slices)
  - `P3` legacy residue retirement + observability hygiene
  - `P4` architecture alignment + stability gates

---

## Refactor Principles (non-negotiable)
1. No UX changes unless explicitly requested.
2. Keep PRs small and reversible.
3. Each PR must include validation (tests + type-check + smoke when relevant).
4. Do not mix architecture refactor with unrelated feature work.
5. Prefer extraction + adapter layers over big rewrites.

---

## Progressive Roadmap

## PR5 — De-godify Session Page (Phase 1, split into mini-PRs)
**Goal:** Reduce orchestration weight in `session/page.tsx` without redoing already extracted hooks.

### PR5.1 — Extract Stream Contract Handler
**Scope**
- Extract from `page.tsx` the data-part normalization + metadata finalization flow (`onData`, `onFinish`).
- Keep `useChat` wiring in page, only move protocol parsing/state effects.

**Validation**
- `npm run type-check`
- `npm run test -- stream-protocol`
- `npm run smoke:stream-auth`

**Exit Criteria**
- Stream contract logic no longer in page body.
- No regression in artifacts/meta delivery.

**Checkpoint**
- ✅ Implemented locally on 2026-02-27.
- ✅ Validations passed:
  - `npm run type-check`
  - `npm run test -- stream-protocol`
  - `npm run smoke:stream-auth`

### PR5.2 — Extract Message Mapping + Timestamp Normalization
**Scope**
- Move `chatMessages -> UIMessage[]` mapping and timestamp bookkeeping to a dedicated hook.
- Keep render tree unchanged.

**Validation**
- `npm run type-check`
- `npm run test -- ui-message-stream-parser`

**Exit Criteria**
- Page no longer owns mapping/dedupe formatting internals.
- No visual/ordering change in transcript.

**Checkpoint**
- ✅ Implemented locally on 2026-02-27.
- ✅ Validations passed:
  - `npm run type-check`
  - `npm run test -- ui-message-stream-parser send-gate`

### PR5.3 — Extract Stream Persistence/Recovery Side-effects
**Scope**
- Move streaming persistence side-effects (incomplete flags + localStorage sync path) into focused hook.
- Keep current storage keys/contracts untouched.

**Validation**
- `npm run type-check`
- targeted tests for new hook (if added)

**Exit Criteria**
- `page.tsx` no longer directly mutates persisted session payload.
- Refresh/cancel retry behavior unchanged.

**Checkpoint**
- ✅ Implemented locally on 2026-02-27.
- ✅ Validations passed:
  - `npm run type-check`
  - `npm run test -- send-gate ui-message-stream-parser`

### PR5.4 — Extract Reflection Voice Flow Orchestration
**Scope**
- Move reflection voice lifecycle (command-driven queue, speakText trigger, flow guards/timeouts) into dedicated hook.
- Keep existing `useSessionVoiceCommandSystem` as-is; compose with new hook.

**Validation**
- `npm run type-check`
- `npm run test -- ui-message-stream-parser stream-protocol`
- `npm run smoke:stream-auth`

**Exit Criteria**
- Large reflection voice block removed from page.
- Voice/text parity preserved for reflection behavior.

**Checkpoint**
- ✅ Implemented locally on 2026-02-27.
- ✅ Validations passed:
  - `npm run type-check`
  - `npm run test -- ui-message-stream-parser stream-protocol send-gate`

### PR5.5 — Session Page Composition Pass
**Scope**
- Final composition cleanup: ensure page is mostly wiring + render.
- Remove dead refs/effects left after extractions.

**Validation**
- `npm run type-check`
- run all focused suites used in PR5.1–PR5.4

**Exit Criteria**
- `page.tsx` materially reduced and easier to reason about.
- No UX change, no protocol regressions.

**Checkpoint**
- ✅ Implemented locally on 2026-02-27.
- ✅ Validations passed:
  - `npm run type-check`
  - `npm run test -- ui-message-stream-parser stream-protocol send-gate`

### PR5 Global Exit Criteria
- Mini-PRs 5.1–5.5 merged sequentially.
- `session/page.tsx` no longer contains heavy domain orchestration blocks already extracted.
- All validations green after each mini-PR.

---

## PR6 — De-godify Chat API Route (Phase 1)
**Goal:** Split `api/chat/route.ts` into pipeline modules.

### Scope
- Create explicit layers:
  - request parsing/validation
  - upstream backend client
  - stream transformers (`text`, `ui-message`)
  - fallback/error mapping
- Keep route handler thin (wire-up only).

### Exit Criteria
- Route file becomes orchestration shell.
- Existing protocol tests pass.
- Add 1–2 focused tests for pipeline boundaries.

---

## PR7 — Voice Loop Partitioning (Phase 1)
**Goal:** Reduce complexity concentration in `useVoiceLoop.ts`.

### Scope
- Extract command/rate-limit/error branches into dedicated helpers.
- Isolate playback state transitions into a small state adapter.
- Preserve current API contract of `useVoiceLoop`.

### Exit Criteria
- Smaller decision blocks in `useVoiceLoop.ts`.
- No regression in voice transcript/artifacts flow.
- Voice smoke scenario passes.

### Checkpoint
- ✅ Implemented locally on 2026-03-01.
- ✅ Scope completed:
  - extracted command send helper (`voice-loop-command-helpers.ts`)
  - extracted websocket error/rate-limit helper (`voice-loop-error-helpers.ts`)
  - added state transition adapter (`voice-loop-state-adapter.ts`)
- ✅ Validations passed:
  - `npm run type-check`
  - `npm run test -- src/__tests__/hooks/voice`

---

## PR8 — Legacy Path Retirement
**Goal:** Remove controlled legacy branches that are no longer used.

### Scope
- Remove legacy `text` stream path only after confirming no consumers.
- Remove temporary compatibility shims introduced for migration safety.

### Exit Criteria
- Runtime still stable under data protocol only.
- Updated docs/tests reflect single canonical path.

### Checkpoint
- ✅ Implemented locally on 2026-03-01.
- ✅ Scope completed:
  - retired `text`/`legacy` protocol branch in chat route handling
  - removed text-stream transformer path from runtime and tests
  - enforced AI SDK data-stream as single protocol path
- ✅ Validations passed:
  - `npm run type-check`
  - `npm run test -- stream-protocol stream-transformers chat-request`

---

## PR9 — Hardening + Documentation Closeout
**Goal:** Lock architecture and prevent regression.

### Scope
- Add guard tests for protocol/stream contracts.
- Add lint/docs guidance for transport/protocol usage.
- Final architecture snapshot doc update.

### Exit Criteria
- Clear “how not to regress” section in docs.
- Refactor objectives complete and tracked as done.

### Checkpoint
- ✅ Implemented locally on 2026-03-01.
- ✅ Scope completed:
  - added protocol hardening guard tests for stream envelope and fallback path contracts
  - documented anti-regression transport/protocol guidance in `docs/CHAT_STREAM_PROTOCOL_GUARDRAILS.md`
  - closed final roadmap phase with architecture snapshot guidance
- ✅ Validations passed:
  - `npm run type-check`
  - `npm run test -- stream-protocol stream-transformers chat-request`
  - `npm run smoke:stream-auth`

---

## PR10 — Cleanup Hardening Pass
**Goal:** Remove post-migration residue and close active quality warnings.

### Scope
- Remove legacy stream header usage from session chat transport/request options.
- Remove dead protocol constant now unused after data-stream enforcement.
- Fix active lint warnings in high-touch files (`session/page.tsx`, `useVoiceLoop.ts`, auth callback typing).

### Exit Criteria
- No functional/UX behavior changes in chat/voice flows.
- Lint warnings from current touched files are resolved.
- Existing stream protocol tests remain green.

### Checkpoint
- ✅ Implemented locally on 2026-03-01.
- ✅ Scope completed:
  - removed `x-sophia-stream-protocol` request decoration from session chat sends
  - removed unused `STREAM_PROTOCOL_HEADER` constant
  - fixed hook cleanup/dependency and explicit `any` lint warnings in touched files
- ✅ Validations passed:
  - `npm run lint`
  - `npm run type-check`
  - `npm run test -- stream-protocol stream-transformers chat-request`

---

## PR11 — Session Outbound Send Extraction
**Goal:** Continue reducing orchestration weight in `session/page.tsx` by moving outbound chat send logic to existing session hooks.

### Scope
- Extract outbound send responsibilities from page into `useSessionSendActions.ts`:
  - text sanitization
  - duplicate outbound guard
  - stream-turn timing mark
  - backend session validity guard and user warning
  - request options shaping (`chatRequestBody`)
- Reuse extracted hook from `page.tsx` and remove local refs/callbacks no longer needed.

### Exit Criteria
- No UX/behavior change in send flow.
- `session/page.tsx` has less orchestration code for outbound send path.
- Existing send/retry/chat stream tests remain green.

### Checkpoint
- ✅ Implemented locally on 2026-03-01.
- ✅ Scope completed:
  - added `useSessionOutboundSend` in existing `useSessionSendActions.ts`
  - removed local outbound send refs/callback from `session/page.tsx`
  - wired page send path through extracted hook
- ✅ Validations passed:
  - `npm run lint`
  - `npm run type-check`
  - `npm run test -- stream-protocol stream-transformers chat-request`

---

## PR12 — Voice Command Orchestration Extraction
**Goal:** Continue reducing `session/page.tsx` orchestration by consolidating voice-command routing and suppression lifecycle into existing session hook.

### Scope
- Move command-routing suppression lifecycle ownership into `useSessionVoiceCommandSystem.ts`:
  - internal suppression refs
  - suppression timer cleanup on unmount
  - command-vs-transcript routing helper
- Remove local command routing refs/effects from `session/page.tsx`.
- Wire `useSessionVoiceBridge` transcripts through the extracted command handler via ref adapter to avoid cyclic hook dependency.

### Exit Criteria
- No UX or behavior change for voice commands/voice transcript rendering.
- `session/page.tsx` removes voice-command orchestration refs/effects.
- Existing chat/stream tests and lint/type-check remain green.

### Checkpoint
- ✅ Implemented locally on 2026-03-01.
- ✅ Scope completed:
  - `useSessionVoiceCommandSystem` now owns suppression refs + timer cleanup
  - removed `routeVoiceCommandRef` and suppression refs/effects from `session/page.tsx`
  - connected `useSessionVoiceBridge` transcript path through extracted command router with safe ref adapter
- ✅ Validations passed:
  - `npm run lint`
  - `npm run type-check`
  - `npm run test -- stream-protocol stream-transformers chat-request`

---

## PR13 — Voice Message Append Extraction
**Goal:** Continue trimming `session/page.tsx` by extracting voice message append/dedupe behavior to an existing session-domain composition layer.

### Scope
- Move inline `appendVoiceUserMessage` + `appendVoiceAssistantMessage` logic from `session/page.tsx` into `useSessionVoiceMessages.ts`.
- Keep suppression behavior for assistant voice output controlled by command-system flag in page wiring.
- Rewire `useSessionVoiceBridge` callbacks to use extracted hook outputs.

### Exit Criteria
- No behavior change in voice transcript rendering, dedupe, or assistant replacement rules.
- Reduced inline callback complexity in `session/page.tsx`.
- Lint/type-check/tests remain green.

### Checkpoint
- ✅ Implemented locally on 2026-03-01.
- ✅ Scope completed:
  - extracted voice user/assistant append logic into `useSessionVoiceMessages.ts`
  - removed duplicated inline append logic from `session/page.tsx`
  - preserved assistant suppression via explicit adapter in page wiring
- ✅ Validations passed:
  - `npm run lint`
  - `npm run type-check`
  - `npm run test -- stream-protocol stream-transformers chat-request`

---

## PR14 — Voice UI Controls Extraction
**Goal:** Keep shrinking `session/page.tsx` orchestration by moving mic/status transition callbacks into a dedicated session hook.

### Scope
- Extract `baseHandleMicClick` and `setVoiceStatusCompat` from `session/page.tsx` into `useSessionVoiceUiControls.ts`.
- Keep existing behavior for listening/connecting stop, speaking barge-in, thinking no-op, and error reset.
- Rewire existing consumers (`useSessionUiInteractions`, `useSessionSendActions`) through extracted hook outputs.

### Exit Criteria
- No UX change in voice mic interactions or submit flow compatibility.
- Reduced callback logic in `session/page.tsx`.
- Lint/type-check/tests stay green.

### Checkpoint
- ✅ Implemented locally on 2026-03-01.
- ✅ Scope completed:
  - added `useSessionVoiceUiControls.ts`
  - removed inline voice UI control callbacks from `session/page.tsx`
  - preserved existing behavior through hook wiring
- ✅ Validations passed:
  - `npm run lint`
  - `npm run type-check`
  - `npm run test -- stream-protocol stream-transformers chat-request`

---

## PR15 — Session UI Panel State Consolidation
**Goal:** Remove remaining artifact panel visibility orchestration from `session/page.tsx`.

### Scope
- Move `showArtifactsUi` derivation + close-on-hidden effect from page into existing UI-focused session hook (`useSessionUiDerivedState` or `useSessionUiInteractions`).
- Keep current behavior for desktop panel + mobile drawer gating unchanged.

### Exit Criteria
- `page.tsx` no longer owns panel visibility reconciliation effect.
- No change in panel open/close UX.

### Validation
- `npm run lint`
- `npm run type-check`
- targeted session UI tests if introduced

### Checkpoint
- ✅ Implemented locally on 2026-03-01.
- ✅ Scope completed:
  - moved `showArtifactsUi` derivation into `useSessionUiDerivedState`
  - moved close-on-hidden panel reconciliation effect into `useSessionUiInteractions`
  - removed local panel-visibility memo/effect orchestration from `session/page.tsx`
- ✅ Validations passed:
  - `npm run lint`
  - `npm run type-check`
  - `npm run test -- stream-protocol stream-transformers chat-request`

---

## PR16 — Queue/Connectivity Runtime Extraction
**Goal:** Reduce stateful runtime refs/effects in `session/page.tsx` related to queue sync.

### Scope
- Extract `chatStatusRef`, `chatMessagesRef`, and connectivity transition tracking (`previousConnectivityStatusRef`) into a dedicated session runtime hook.
- Keep `useSessionQueueSync` API unchanged; page should only pass declarative inputs.

### Exit Criteria
- Page no longer manages queue/runtime mirror refs directly.
- Offline→online recovery behavior remains identical.

### Validation
- `npm run lint`
- `npm run type-check`
- `npm run test -- send-gate`

### Checkpoint
- ✅ Implemented locally on 2026-03-01.
- ✅ Scope completed:
  - extracted queue runtime mirrors (`chatStatusRef`, `chatMessagesRef`) into `useSessionQueueRuntime`
  - extracted offline→online transition tracking (`previousConnectivityStatusRef`) into `useSessionQueueRuntime`
  - removed runtime ref/effect orchestration for queue/connectivity from `session/page.tsx` while keeping `useSessionQueueSync` API unchanged
- ✅ Validations passed:
  - `npm run lint`
  - `npm run type-check`
  - `npm run test -- send-gate`

---

## PR17 — Session Companion Integration Extraction
**Goal:** Isolate companion integration wiring away from `session/page.tsx`.

### Scope
- Extract companion-specific append message + artifact/error callbacks and `useSessionCompanion` wiring to a composition hook in `session/`.
- Keep UI render contracts and invoked actions unchanged.

### Exit Criteria
- Page no longer owns companion callback plumbing.
- Companion invoke/nudge behavior unchanged.

### Validation
- `npm run lint`
- `npm run type-check`
- targeted tests for companion integration (if added)

### Checkpoint
- ✅ Implemented locally on 2026-03-01.
- ✅ Scope completed:
  - extracted companion message append/artifact/error callback plumbing into `useSessionCompanionIntegration`
  - moved `useSessionCompanion` wiring from `session/page.tsx` into integration hook
  - kept `NudgeBanner` and `CompanionRail` contracts unchanged via the same returned handlers/state
- ✅ Validations passed:
  - `npm run lint`
  - `npm run type-check`
  - `npm run test -- send-gate`

---

## PR18 — Interrupt/Retry Local State Extraction
**Goal:** Minimize page-local state juggling for interrupt resume and retry placeholders.

### Scope
- Move `resumeError`, `resumeRetryOptionId`, and cancellation/retry helper state orchestration into a session hook.
- Keep current `RetryAction` UX and interrupt queue semantics unchanged.

### Exit Criteria
- Reduced local state count in `page.tsx`.
- No behavior change for resume retry and dismiss/retry actions.

### Validation
- `npm run lint`
- `npm run type-check`
- `npm run test -- stream-protocol chat-request`

### Checkpoint
- ✅ Implemented locally on 2026-03-01.
- ✅ Scope completed:
  - extracted interrupt/retry local state (`cancelledMessageId`, `lastUserMessageId`, `lastUserMessageContent`, `isInterruptedByRefresh`, `refreshInterruptedAt`) into `useSessionInterruptRetryState`
  - extracted resume-retry local state (`resumeError`, `resumeRetryOptionId`) and helper actions (`prepareInterruptSelectRetry`, `clearResumeError`, `handleResumeError`) into `useSessionInterruptRetryState`
  - rewired `session/page.tsx` to consume extracted state/actions while preserving existing `RetryAction` and interrupt selection UX
- ✅ Validations passed:
  - `npm run lint`
  - `npm run type-check`
  - `npm run test -- stream-protocol chat-request`
  - `npm run test -- send-gate`

---

## PR19 — Session Page Context Consolidation
**Goal:** Centralize repeated selector-driven session primitives into one composition layer.

### Scope
- Introduce a consolidated session page context hook that returns `sessionId`, `backendSessionId`, flags (`isReadOnly`, `hasValidBackendSessionId`), and shared store actions.
- Keep existing selectors/stores and API contracts intact.

### Exit Criteria
- Fewer ad-hoc derived constants in page body.
- No runtime contract changes.

### Validation
- `npm run lint`
- `npm run type-check`

### Checkpoint
- ✅ Implemented locally on 2026-03-01.
- ✅ Scope completed:
  - added consolidated context hook `useSessionPageContext` to centralize session selectors and derived primitives (`sessionId`, `backendSessionId`, `isReadOnly`, `hasValidBackendSessionId`, `safeSessionId`)
  - removed duplicated selector/derived-constant block from `session/page.tsx` and rewired to consume `useSessionPageContext`
  - preserved existing store contracts and downstream hook APIs
- ✅ Validations passed:
  - `npm run lint`
  - `npm run type-check`
  - `npm run test -- send-gate stream-protocol chat-request`

---

## PR20 — Page Render Block Composition Split
**Goal:** Reduce JSX density and improve readability of `session/page.tsx`.

### Scope
- Split large render regions (message rail / interrupt region / typing-retry region) into focused presentational components under `components/session`.
- No styling or behavior changes; composition-only extraction.

### Exit Criteria
- `page.tsx` render section significantly shorter and easier to scan.
- Snapshot/visual behavior remains unchanged.

### Validation
- `npm run lint`
- `npm run type-check`
- targeted component tests if added

### Checkpoint
- ✅ Implemented locally on 2026-03-01.
- ✅ Scope completed:
  - extracted the message rail / interrupt / typing-retry / nudge render region into `SessionConversationPane` under `components/session`
  - reduced `session/page.tsx` render density by replacing the large inline block with presentational component composition
  - preserved existing UX contracts for reflection bubbles, interrupt retry, stream error retry, and read-only banner behavior
- ✅ Validations passed:
  - `npm run lint`
  - `npm run type-check`
  - `npm run test -- send-gate stream-protocol chat-request`

---

## PR21 — Voice Loop Phase-2 Hardening
**Goal:** Continue reducing complexity concentration in `useVoiceLoop.ts` after phase-1 extraction.

### Scope
- Extract remaining orchestration clusters (retry/fallback branches, cleanup orchestration, speakText connection setup) into existing `hooks/voice` helper modules.
- Update stale header comment about file size reduction to reflect current state.

### Exit Criteria
- Smaller decision density in `useVoiceLoop.ts`.
- Existing voice behavior unchanged.

### Validation
- `npm run lint`
- `npm run type-check`
- `npm run test -- src/__tests__/hooks/voice`

### Checkpoint
- ✅ Implemented locally on 2026-03-01.
- ✅ Scope completed:
  - extracted voice WebSocket connection orchestration (session id generation, ws-ticket retrieval, single-retry connect flow) into `hooks/voice/voice-loop-connection-helpers.ts`
  - rewired `useVoiceLoop.ts` to consume extracted connection helpers for both `startTalking` and `speakText` paths
  - updated stale `useVoiceLoop` header comment to reflect current phase-2 hardening reality
- ✅ Validations passed:
  - `npm run lint`
  - `npm run type-check`
  - `npm run test -- src/__tests__/hooks/voice`

---

## PR22 — Regression Guard Tests for Session Extractions
**Goal:** Prevent regressions after PR11–PR21 extraction wave.

### Scope
- Add focused tests for newly extracted session composition hooks (send flow, voice command routing, voice append behavior, queue runtime).
- Ensure de-godification remains behavior-preserving.

### Exit Criteria
- Guard tests cover critical extraction seams.
- Future refactors fail fast on behavior drift.

### Validation
- `npm run lint`
- `npm run type-check`
- `npm run test -- stream-protocol stream-transformers chat-request send-gate`

### Checkpoint
- ✅ Implemented locally on 2026-03-01.
- ✅ Scope completed:
  - added extracted-hook guard tests in `src/__tests__/session/useSessionExtractedHooks.test.ts`
  - covered queue runtime behavior (`useSessionQueueRuntime`) for latest ref mirrors and offline→online reconnect transition
  - covered interrupt/retry state behavior (`useSessionInterruptRetryState`) for resume retry wiring and canonical error mapping
- ✅ Validations passed:
  - `npm run lint`
  - `npm run type-check`
  - `npm run test -- stream-protocol stream-transformers chat-request send-gate useSessionExtractedHooks`

---

  ## Quality Roadmap — P1 / P2 / P3 / P4 (Post-Phase-2)

  ### P1 — Critical Domain Partitioning (Highest ROI)
  **Goal:** Remove remaining god-responsibility concentration in session/chat/voice core runtime.

  **Scope (must-do)**
  - Split `stores/chat-store.ts` into layered units while preserving public store API:
    - stream lifecycle orchestration
    - event emission adapter
    - recovery/retry helper policies
  - Continue shrinking `session/page.tsx` to composition-only boundaries:
    - move UI callbacks/actions that do not need page-local state into dedicated controller hooks
    - keep render/UX contracts unchanged
  - Partition `hooks/useVoiceLoop.ts` by protocol/runtime concern:
    - isolate message-protocol handlers from state transitions
    - keep hook as orchestration shell over focused helpers

  **Exit Criteria**
  - No UX behavior changes.
  - Store/hook external contracts preserved.
  - Files materially reduced in decision density and side-effect mixing.

  **Validation**
  - `npm run lint`
  - `npm run type-check`
  - `npm run test -- send-gate stream-protocol chat-request src/__tests__/hooks/voice`

  **Checkpoint (in progress)**
  - ✅ P1.1 completed (2026-03-01): extracted chat event emission adapter into `stores/chat-store-events.ts` and removed direct event bus emission from `chat-store.ts`.
  - ✅ P1.2 completed (2026-03-01): extracted retry/recovery decision policies into `stores/chat-store-recovery-policies.ts` and simplified `retryStream`/`attemptRecovery` orchestration in `chat-store.ts`.
  - ✅ P1.3 completed (2026-03-01): extracted session UI callbacks (`feedback`, `stream error retry`, `dashboard navigation`) into `session/useSessionUiCallbacks.ts` and removed inline callback implementations from `session/page.tsx`.
  - ✅ P1.4 completed (2026-03-01): extracted redirect/loading page guard logic into `session/useSessionPageGuards.ts` and removed inline redirect effect from `session/page.tsx`.
  - ✅ P1.5 completed (2026-03-01): extracted voice WebSocket message parsing/protocol helpers into `hooks/voice/voice-loop-message-helpers.ts` and rewired `useVoiceLoop.ts` to consume typed parsing utilities instead of inline record casting.
  - ✅ P1.6 completed (2026-03-01): extracted voice thinking-timeout lifecycle helpers into `hooks/voice/voice-loop-timeout-helpers.ts` and rewired `useVoiceLoop.ts` to use centralized timeout clear/start orchestration.
  - ✅ P1.7 completed (2026-03-01): extracted timeout-to-idle transition handling into `hooks/voice/voice-loop-transition-helpers.ts` and rewired repeated timeout branches in `useVoiceLoop.ts` to use adapter-driven idle-settled transitions.
  - ✅ P1.8 completed (2026-03-01): extracted response finalization/reset helpers into `hooks/voice/voice-loop-response-helpers.ts` and removed duplicated final-reply/buffer-reset blocks from `useVoiceLoop.ts` (`response_end`, `response`, `reply_done`).
  - ✅ P1.9 completed (2026-03-01): extracted transcript/assistant persistence helpers into `hooks/voice/voice-loop-persistence-helpers.ts` and removed repeated message-save branches from `useVoiceLoop.ts` while preserving dedupe/guard behavior.
  - ✅ P1.10 completed (2026-03-01): hardened refresh/F5 stream interruption recovery in `lib/stream-recovery.ts` (latest user-match selection, sanitized recovered content, wider recovery window) and aligned retry wait bounds in `session/useSessionRetryHandlers.ts`.
  - ✅ Validated after each slice:
    - `npm run lint`
    - `npm run type-check`
    - `npm run test -- src/__tests__/hooks/voice send-gate stream-protocol chat-request useSessionExtractedHooks`
  - ✅ P1 final closure validation (2026-03-03):
    - `npm run lint` (passes with warnings only, no blocking errors)
    - `npm run type-check`
    - `npm run test -- send-gate stream-protocol chat-request src/__tests__/hooks/voice` (21 files, 59 tests passed)
  - ✅ **P1 complete** (2026-03-03).

  ---

  ### P2 — Type Safety Hardening (Strict-by-Slices)
  **Goal:** Raise correctness guarantees without a risky one-shot strict migration.

  **Scope (must-do)**
  - Introduce strictness incrementally by high-churn slices first (`session/*`, `hooks/voice/*`, `stores/*`).
  - Remove avoidable `unknown`/implicit-any edges in hot paths.
  - Add typed adapters where backend payloads are currently loosely shaped.

  **Exit Criteria**
  - Core runtime slices compile under tighter checks.
  - Reduced unsafe casts in session/chat/voice flow.

  **Validation**
  - `npm run type-check`
  - targeted suites for touched slices

  **Checkpoint (in progress)**
  - ✅ P2.1 completed (2026-03-01): added typed stream payload adapters in `session/stream-contract-adapters.ts`, removed inline unsafe stream/meta/interrupt casts from `session/useSessionStreamContract.ts`, and validated interrupt payload shape through `InterruptPayloadSchema` before dispatch.
  - ✅ Added regression guard: `src/__tests__/session/stream-contract-adapters.test.ts`.
  - ✅ P2.2 completed (2026-03-02): extracted typed stream payload parsers for `stores/chat-store.ts` into `stores/chat-store-payload-parsers.ts` (presence, feedback-gate, usage-info, done-payload), removed inline unknown-cast parsing branches, and validated backend usage shape before store update.
  - ✅ Added regression guard: `src/__tests__/stores/chat-store-payload-parsers.test.ts`.
  - ✅ P2.3 completed (2026-03-02): narrowed voice `response_start.artifacts` parsing to validated object payloads in `hooks/voice/voice-loop-message-helpers.ts` and aligned callback contracts in `hooks/useVoiceLoop.ts` + `session/useSessionVoiceBridge.ts` to avoid raw unknown artifact propagation.
  - ✅ P2.4 completed (2026-03-02): aligned `session/*` artifact contracts to typed object payloads (`session/useSessionArtifactsReducer.ts`, `session/useSessionCompanion.ts`, `session/useSessionCompanionIntegration.ts`, `session/page.tsx`) and removed remaining `unknown` artifact edges in companion/voice ingest paths.
  - ✅ Validated P2.4 with targeted session suites: `npm run test -- useSessionArtifactsReducer useSessionExtractedHooks`.
  - ✅ P2.5 completed (2026-03-02): hardened `session/artifacts.ts` normalization/merge helpers with safe record guards (removing direct `as Record<string, unknown>` casts in candidate/reflection/merge paths) and tightened tag normalization to string-only values.
  - ✅ Added regression guard: `src/__tests__/session/artifacts.test.ts`.
  - ✅ P2.6 completed (2026-03-02): replaced unsafe metadata extractor casts in `stores/message-metadata-store.ts` with typed field readers (string/enum/memory-source filtering) and preserved existing partial metadata behavior.
  - ✅ Added regression guard: `src/__tests__/stores/message-metadata-store.test.ts`.
  - ✅ P2.7 completed (2026-03-02): introduced typed incoming WS message parser for voice (`hooks/voice/voice-websocket-message-parser.ts`), removed unsafe `JSON.parse(... as WebSocketMessage)` flow in `hooks/voice/useVoiceWebSocket.ts`, and aligned `useVoiceLoop` message handler typing with the shared WS message contract.
  - ✅ Added regression guard: `src/__tests__/hooks/voice/voice-websocket-message-parser.test.ts`.
  - ✅ P2.8 completed (2026-03-02): tightened retry handler message part typing in `session/useSessionRetryHandlers.ts` (removed `unknown[]` in hot path), centralized assistant text-part construction for recovery branches, and preserved resend fallback behavior.
  - ✅ Added regression guard: `src/__tests__/session/useSessionRetryHandlers.test.ts`.
  - ✅ P2.9 completed (2026-03-02): introduced shared typed artifacts payload contract (`StreamArtifactsPayload`) in `session/stream-contract-adapters.ts` and propagated it through `session/useSessionStreamContract.ts`, `session/useSessionArtifactsReducer.ts`, `session/useSessionCompanion.ts`, `session/useSessionCompanionIntegration.ts`, `session/useSessionVoiceBridge.ts`, and `session/page.tsx`.
  - ✅ Extended regression guard: `src/__tests__/session/stream-contract-adapters.test.ts` now validates artifacts payload normalization for known fields.
  - ✅ P2.10 completed (2026-03-02): removed unsafe legacy `meta` casts in `hooks/useVoiceLoop.ts` by adding typed parser `parseLegacyMetaMessage` in `hooks/voice/voice-loop-message-helpers.ts`, preserving existing presence/path behavior.
  - ✅ Added regression guard: `src/__tests__/hooks/voice/voice-loop-message-helpers.test.ts`.
  - ✅ P2.11 completed (2026-03-02): consolidated duplicated typed record readers into shared utility `lib/record-parsers.ts` (`asRecord`, `readString`, `readNumber`, `readBoolean`) and rewired P2 modules in `session/stream-contract-adapters.ts`, `session/artifacts.ts`, `stores/chat-store-payload-parsers.ts`, `stores/message-metadata-store.ts`, `hooks/voice/voice-websocket-message-parser.ts`, and `hooks/voice/voice-loop-message-helpers.ts` without behavior changes.
  - ✅ Validated P2.11 with focused suites: `npm run test -- stream-contract-adapters chat-store-payload-parsers artifacts message-metadata-store voice-websocket-message-parser voice-loop-message-helpers`.
  - ✅ P2 final closure validation (2026-03-03):
    - `npm run type-check`
    - `npm run test -- stream-contract-adapters chat-store-payload-parsers artifacts message-metadata-store voice-websocket-message-parser voice-loop-message-helpers` (9 files, 30 tests passed)
  - ✅ **P2 complete** (2026-03-03).

  ---

  ### P3 — Legacy Residue Retirement + Logging Hygiene
  **Goal:** Remove dead compatibility branches and standardize runtime diagnostics.

  **Scope (must-do)**
  - Retire stale legacy branches that are no longer exercised in production paths.
  - Replace scattered direct `console.*` diagnostics in runtime-critical paths with centralized logger wrappers.
  - Keep explicit, documented exceptions only where low-level browser/media debugging requires it.

  **Exit Criteria**
  - Reduced dual-path complexity.
  - Debug surface is intentional and consistent.

  **Validation**
  - `npm run lint`
  - `npm run type-check`
  - targeted feature tests (voice/chat/history/recap based on touched modules)

  **Execution Plan (bounded, finite)**
  - Total slices for P3: **4** (`P3.1`–`P3.4`).
  - No new P3 slices are added unless explicitly approved in this document.
  - P3 is considered complete when `P3.1`–`P3.4` are ✅ and validations pass per slice.

  **Planned slices**
  - `P3.1` (done): voice websocket diagnostics normalization.
  - `P3.2`: voice runtime logging hygiene in `hooks/useVoiceLoop.ts` and `hooks/voice/useAudioPlayback.ts` (replace direct `console.*` in runtime-critical branches with centralized logger/debug wrappers, no behavior changes).
  - `P3.3`: session runtime logging hygiene in `session/*` high-churn hooks (`useSessionMemoryActions.ts`, `useSessionExitFlow.ts`, `useSessionExitProtection.ts`, `useSessionRetryHandlers.ts`, `useSessionVoiceCommandSystem.ts`) with centralized logging and unchanged UX/runtime behavior.
  - `P3.4`: legacy residue closeout + explicit exceptions list (retire validated dead compatibility branches touched in P3, and document allowed low-level debug exceptions where direct `console.*` remains intentional).

  **Per-slice validation gate**
  - Always: `npm run type-check`
  - Voice slices (`P3.2`): `npm run test -- src/__tests__/hooks/voice voice-websocket-message-parser`
  - Session slices (`P3.3`/`P3.4`): targeted suites for touched hooks + relevant session tests
  - Stop condition for P3: after `P3.4` validations are green, mark P3 complete and move to P4 only on explicit request.

  **Checkpoint (in progress)**
  - ✅ P3.1 completed (2026-03-02): replaced direct `console.*` diagnostics in `hooks/voice/useVoiceWebSocket.ts` with centralized debug logger wrappers (`debugLog` / `debugWarn`) to keep runtime diagnostics consistent without changing websocket behavior.
  - ✅ Validated P3.1 with focused suites: `npm run test -- src/__tests__/hooks/voice voice-websocket-message-parser`.
  - ✅ P3.2 completed (2026-03-02): normalized runtime-critical voice diagnostics in `hooks/useVoiceLoop.ts` and `hooks/voice/useAudioPlayback.ts`, replacing direct `console.*` calls with centralized debug logger wrappers while preserving existing playback/stream behavior.
  - ✅ Validated P3.2 with focused suites: `npm run test -- src/__tests__/hooks/voice voice-websocket-message-parser`.
  - ✅ P3.3 completed (2026-03-02): normalized session runtime logging in high-churn hooks (`session/useSessionMemoryActions.ts`, `session/useSessionExitFlow.ts`, `session/useSessionExitProtection.ts`, `session/useSessionRetryHandlers.ts`, `session/useSessionVoiceCommandSystem.ts`) by replacing direct `console.*` diagnostics with centralized logger calls, without behavioral changes.
  - ✅ Validated P3.3 with focused suites: `npm run test -- useSessionRetryHandlers useSessionExtractedHooks`.
  - ✅ P3.4 completed (2026-03-02): closed P3 residue pass by removing dead compatibility residue (`hooks/useVoiceLoop.ts` unused legacy import) and documenting explicit low-level `console.*` exceptions in `docs/RUNTIME_LOGGING_EXCEPTIONS.md`.
  - ✅ Validated P3.4 with focused suites: `npm run test -- src/__tests__/hooks/voice voice-websocket-message-parser useSessionRetryHandlers useSessionExtractedHooks`.
  - ✅ P3 closeout addendum (2026-03-02): added frozen remaining-log inventory snapshot in `docs/P3_LOGGING_INVENTORY_2026-03-02.md` and created anti-regression guardrail `npm run check:logs:p3` (`scripts/check-p3-console-guardrail.js`) to block new unapproved `console.*` usage in P3-governed runtime-critical files.
  - ✅ Post-P3 hygiene continuation (2026-03-02): completed additional repo-wide centralization batches in `session/hooks/pages`, then `components/**` and `stores/**`; latest `src/app/**` console inventory reduced to `80` matches (current concentration in `api/**` and `lib/**` domains + documented wrapper internals).
  - ✅ Post-P3 hygiene continuation (2026-03-02, API sweep): completed centralization in `api/**`; latest `src/app/**` console inventory reduced further to `56` matches.
  - ✅ Post-P3 hygiene continuation (2026-03-02, lib/voice sweep): completed centralization in `lib/**` + `hooks/voice/**` + remaining runtime surfaces; latest `src/app/**` inventory reduced to `6` matches, intentionally confined to `lib/debug-logger.ts`.
  - ✅ Anti-regression global gate (2026-03-02): added `npm run check:logs:global` (`scripts/check-global-console-guardrail.js`) to block new direct `console.*` usage across `src/app/**` outside explicit allowlist.
  - ✅ P3 final closure validation (2026-03-03):
    - `npm run check:logs:p3`
    - `npm run check:logs:global`
    - `npm run type-check`
    - `npm run test -- src/__tests__/hooks/voice voice-websocket-message-parser useSessionRetryHandlers useSessionExtractedHooks` (20 files, 58 tests passed)
  - ✅ **P3 complete** (`P3.1`–`P3.4`).

  ---

  ### P4 — Architecture Alignment + Stability Gates
  **Goal:** Keep docs, boundaries, and regression gates aligned with real code evolution.

  **Scope (must-do)**
  - Refresh architecture docs to match actual module boundaries and file sizes.
  - Add/extend guard tests around extracted seams and adapter contracts.
  - Establish explicit “no regress” checklist for future refactor PRs.

  **Exit Criteria**
  - Documentation reflects current architecture truthfully.
  - Regression guards cover critical seams discovered in Phase 2 and P1–P3.

  **Validation**
  - `npm run lint`
  - `npm run type-check`
  - focused test matrix for newly guarded seams

  **Execution Plan (bounded, finite)**
  - `P4.1`: architecture baseline + no-regress checklist + aggregate stability gate.
  - `P4.2`: guard-test coverage extension for extracted seams/adapters.
  - `P4.3`: docs boundary refresh closeout and stability signoff.

  **Checkpoint (started)**
  - ✅ P4.1 kickoff completed (2026-03-02): published measured baseline in `docs/P4_ARCHITECTURE_BASELINE_2026-03-02.md`, added operational checklist in `docs/P4_NO_REGRESS_CHECKLIST.md`, and added aggregate gate command `npm run test:guardrails:p4`.
  - ✅ P4.2 progress (2026-03-02): expanded seam guard tests for session command orchestration and chat request contract normalization/truncation in:
    - `src/__tests__/session/useSessionVoiceCommandSystem.test.ts`
    - `src/__tests__/api/chat/chat-request.test.ts`
    Validated with `npm run test -- useSessionVoiceCommandSystem chat-request`.
  - ✅ P4.3 completed (2026-03-02): closed architecture alignment docs with operating thresholds/trigger policy (`docs/P4_ARCHITECTURE_BASELINE_2026-03-02.md`), published stability signoff (`docs/P4_STABILITY_SIGNOFF_2026-03-02.md`), and aligned merge checklist requirements (`docs/P4_NO_REGRESS_CHECKLIST.md`).
  - ✅ P4 validation gate remains green via `npm run test:guardrails:p4`.
  - ✅ P4 final closure validation (2026-03-03):
    - `npm run test:guardrails:p4` (24 files, 76 tests passed)
    - `npm run lint` (passes with warnings only, no blocking errors)
  - ✅ **P4 complete**.

  ---

  ## Immediate Start (Now)
  - ✅ Kickoff P1 with first slice: extract chat stream event emission out of `stores/chat-store.ts` into dedicated adapter module.

  ---

## Validation Matrix (run per PR)
- Required:
  - `npm run type-check`
  - Targeted tests for touched modules
- If stream/chat touched:
  - `npm run test -- stream-protocol`
  - `npm run smoke:stream-auth`
- If send/retry touched:
  - `npm run test -- send-gate`
- If parser/render touched:
  - `npm run test -- ui-message-stream-parser`

---

## Definition of Done (per PR)
- Scope completed with no UX changes.
- Validation matrix passed.
- Commit(s) pushed to `refactor/fase-1`.
- This document updated:
  - move current PR status to ✅
  - add brief notes if scope changed.

---

## How we keep returning to this plan
At the start of each new refactor task:
1. Open this file.
2. Pick next pending PR in order.
3. Execute only that scope.
4. Update status/checkpoints here before closing the task.

Before opening P5 extraction slices for `session/page.tsx`, run pre-flight inventory in:
- `docs/P5_SESSION_PRECHECK_2026-03-02.md`

Before opening P6 recap extraction slices, run pre-flight inventory in:
- `docs/P6_RECAP_PRECHECK_2026-03-03.md`

P5 checkpoint:
- ✅ P5.1 completed (2026-03-02): extracted residual page-local state/ref cluster into `src/app/session/useSessionPageLocalState.ts` and rewired `src/app/session/page.tsx` to consume it, without touching already-extracted session domains.
- ✅ Added focused guard test: `src/__tests__/session/useSessionPageLocalState.test.ts`.
- ✅ P5.2 completed (2026-03-02): extracted cancelled-retry voice replay flow from `src/app/session/page.tsx` into `src/app/session/useSessionCancelledRetryVoiceReplay.ts` and added focused guard test `src/__tests__/session/useSessionCancelledRetryVoiceReplay.test.ts`.
- ✅ P5.3 completed (2026-03-02): moved voice command normalization + reflection command matching ownership from `src/app/session/page.tsx` to existing seam `src/app/session/useSessionVoiceCommandSystem.ts` (no new module), and extended seam coverage in `src/__tests__/session/useSessionVoiceCommandSystem.test.ts`.
- ✅ P5.4 completed (2026-03-02): moved memory toast snippet formatting ownership from `src/app/session/page.tsx` to existing seam `src/app/session/useSessionMemoryActions.ts`, removing local callback duplication from page wiring.
- ✅ P5.5 completed (2026-03-02): moved reflection queued-user append + reflection prefix ownership from `src/app/session/page.tsx` to existing seam `src/app/session/useSessionReflectionVoiceFlow.ts` (`SESSION_REFLECTION_PREFIX`), and added focused guard test `src/__tests__/session/useSessionReflectionVoiceFlow.test.ts`.
- ✅ P5.6 completed (2026-03-02): moved latest assistant message derivation ownership from `src/app/session/page.tsx` to existing seam `src/app/session/useSessionMessageViewModel.ts`, and added focused guard test `src/__tests__/session/useSessionMessageViewModel.test.ts`.
- ✅ P5.7 completed (2026-03-02): moved `isSophiaResponding` derivation ownership from `src/app/session/page.tsx` to existing seam `src/app/session/useSessionUiDerivedState.ts`, and added focused guard test `src/__tests__/session/useSessionUiDerivedState.test.ts`.
- ✅ P5.8 completed (2026-03-02): moved quick prompt-selection callback ownership from `src/app/session/page.tsx` to existing seam `src/app/session/useSessionUiCallbacks.ts`, and added focused guard test `src/__tests__/session/useSessionUiCallbacks.test.ts`.
- ✅ P5.9 completed (2026-03-02): moved cancel-thinking orchestration ownership from `src/app/session/page.tsx` to existing seam `src/app/session/useSessionSendActions.ts`, and added focused guard test `src/__tests__/session/useSessionSendActions.test.ts`.
- ✅ P5.10 completed (2026-03-02): moved interrupt-select-with-retry wrapper ownership from `src/app/session/page.tsx` to existing seam `src/app/session/useSessionInterruptRetryState.ts`, and extended seam coverage in `src/__tests__/session/useSessionExtractedHooks.test.ts`.
- ✅ P5.11 completed (2026-03-02): moved chat request body context assembly ownership from `src/app/session/page.tsx` to existing seam `src/app/session/useSessionPageContext.ts`, reducing local transport payload assembly in page orchestration.
- ✅ P5.12 completed (2026-03-02): moved greeting fallback/anchor context derivations from `src/app/session/page.tsx` to existing seam `src/app/session/useSessionPageContext.ts`, reducing local initialization metadata assembly in page orchestration.
- ✅ P5.13 completed (2026-03-02): removed duplicated chat transport payload assembly in `src/app/session/page.tsx` by wiring `DefaultChatTransport` directly to context-owned `chatRequestBody` from `src/app/session/useSessionPageContext.ts`.
- ✅ P5.14 completed (2026-03-02): moved session active-lifecycle effect (`resumeSession` + guarded `pauseSession` cleanup) from `src/app/session/page.tsx` to existing seam `src/app/session/useSessionPageContext.ts`.
- ✅ P5.15 completed (2026-03-02): moved memory highlights derivation from `src/app/session/page.tsx` to existing seam `src/app/session/useSessionPageContext.ts` and resolved typing against canonical `MemoryHighlight` model.
- ✅ P5.16 completed (2026-03-02): moved voice artifacts source-tagging wrapper from `src/app/session/page.tsx` to existing seam `src/app/session/useSessionVoiceBridge.ts`, so page passes `ingestArtifacts` directly without local wrapper glue.
- ✅ P5.17 completed (2026-03-02): moved memory-highlights render-gate debug effect from `src/app/session/page.tsx` to existing seam `src/app/session/useSessionMessageViewModel.ts`, removing local gate logging glue from page orchestration.
- ✅ P5.18 completed (2026-03-02): moved interrupt-select-with-retry wrapper glue from `src/app/session/page.tsx` into existing seam `src/app/session/useSessionInterruptRetryState.ts` using hook-owned handler binding (`setInterruptSelectHandler`) and callback exposure (`handleInterruptSelectWithRetry`).
- ✅ P5.19 completed (2026-03-02): removed residual unused interrupt retry helper destructuring from `src/app/session/page.tsx` after P5.18, reducing remaining page-level glue and keeping interrupt retry ownership centralized in `src/app/session/useSessionInterruptRetryState.ts`.
- ✅ P5.20 completed (2026-03-02): moved exit-protection `responseMode` derivation from `src/app/session/page.tsx` into existing seam `src/app/session/useSessionUiDerivedState.ts`, so page wiring now consumes hook-owned `exitProtectionResponseMode` instead of inline composite logic.
- ✅ P5.21 completed (2026-03-02): moved voice transcript/assistant suppression bridge ownership from local `src/app/session/page.tsx` refs/wrappers into existing seam `src/app/session/useSessionVoiceBridge.ts` using hook-owned binders (`setOnUserTranscriptHandler`, `setAssistantResponseSuppressedChecker`), reducing page-level glue while preserving behavior.
- ✅ P5.22 completed (2026-03-02): moved resume-retry callback ownership from inline `SessionConversationPane` JSX in `src/app/session/page.tsx` into existing seam `src/app/session/useSessionInterruptRetryState.ts` via hook-owned `handleResumeRetry`, removing render-time option-id glue from page.
- ✅ P5.23 completed (2026-03-02): moved stream-error dismiss callback ownership from inline `SessionConversationPane` JSX in `src/app/session/page.tsx` into existing seam `src/app/session/useSessionUiCallbacks.ts` via hook-owned `handleDismissStreamError`, removing render-time dismiss lambda glue from page.
- ✅ P5.24 completed (2026-03-02): moved cancelled-retry trigger callback ownership from inline `SessionConversationPane` JSX in `src/app/session/page.tsx` into existing seam `src/app/session/useSessionCancelledRetryVoiceReplay.ts` via hook-owned sync `handleCancelledRetryPress`, removing render-time promise-void wrapper glue from page.
- ✅ P5.25 completed (2026-03-02): moved voice-retry trigger callback ownership from inline `SessionConversationPane` JSX in `src/app/session/page.tsx` into existing seam `src/app/session/useSessionVoiceBridge.ts` via hook-owned sync `handleVoiceRetryPress`, removing render-time promise-void wrapper glue from page.
- ✅ P5.26 completed (2026-03-02): moved resume-retry trigger callback ownership from inline `SessionConversationPane` JSX in `src/app/session/page.tsx` into existing seam `src/app/session/useSessionInterruptRetryState.ts` via hook-owned sync `handleResumeRetryPress`, removing render-time promise-void wrapper glue from page.
- ✅ P5.27 completed (2026-03-02): extracted remaining minimal inline UI callbacks from `src/app/session/page.tsx` into existing owners (`useSessionPageLocalState.ts`, `useSessionUiInteractions.ts`, `useSessionUiCallbacks.ts`) including reconnect dismiss, artifacts/drawer toggles, and feedback/session-expired/multi-tab modal actions, leaving only non-domain event passthrough (`stopPropagation`) inline.
- ✅ P5.28 completed (2026-03-02): extracted the large store/connectivity infrastructure cluster from `src/app/session/page.tsx` into new page-local hook `src/app/session/useSessionInfrastructure.ts`, centralizing connectivity monitoring/selectors, metadata/toast selectors, usage-limit selectors, feedback selectors, and connectivity failure action wiring without UX changes.
- ✅ P5.29 completed (2026-03-02): extracted session validation wiring from `src/app/session/page.tsx` into new page-local hook `src/app/session/useSessionValidationState.ts` and moved feedback-toast local state ownership into `src/app/session/useSessionPageLocalState.ts`, reducing remaining page orchestration glue around modal-state concerns.
- ✅ P5.30 completed (2026-03-02): extracted AI SDK chat runtime orchestration from `src/app/session/page.tsx` into new session hook `src/app/session/useSessionChatRuntime.ts`, including transport creation, `useChat` binding, stream error policy, and stop-stream cleanup.
- ✅ P5.31 completed (2026-03-02): created dedicated session owner `src/app/session/useSessionInterruptOrchestration.ts` and migrated interrupt orchestration wiring from `src/app/session/page.tsx` (`useInterrupt` callbacks + interrupt-select handler binding) while preserving stream interrupt ingestion via a ref bridge.
- ✅ P5.32 completed (2026-03-02): extracted stream-contract interrupt bridge wiring from `src/app/session/page.tsx` into new session owner `src/app/session/useSessionStreamOrchestration.ts`, centralizing stream interrupt routing and stream-contract hook integration while keeping runtime behavior unchanged.
- ✅ P5.33 completed (2026-03-02): extracted chat-initialization orchestration wiring from `src/app/session/page.tsx` into new session owner `src/app/session/useSessionInitializationOrchestration.ts`, grouping and mapping initialization dependencies into `useSessionChatInitialization.ts`.
- ✅ P5.34 completed (2026-03-02): extracted voice bridge/messages/controls orchestration from `src/app/session/page.tsx` into new session owner `src/app/session/useSessionVoiceOrchestration.ts`, while preserving command-routing ownership in `useSessionVoiceCommandSystem.ts` to avoid voice/reflection dependency cycles.
- ✅ P5.35 completed (2026-03-02): extracted queue runtime/sync orchestration from `src/app/session/page.tsx` into new session owner `src/app/session/useSessionQueueOrchestration.ts`, centralizing `useSessionQueueRuntime.ts` + `useSessionQueueSync.ts` wiring without behavior changes.
- ✅ P5.36 completed (2026-03-02): extracted exit flow/protection orchestration from `src/app/session/page.tsx` into new session owner `src/app/session/useSessionExitOrchestration.ts`, consolidating `useSessionExitFlow.ts` + `useSessionExitProtection.ts` wiring and in-progress gating.
- ✅ P5.37 completed (2026-03-02): extracted interaction action-cluster wiring from `src/app/session/page.tsx` into new session owner `src/app/session/useSessionInteractionOrchestration.ts`, centralizing send/retry/cancelled-retry/UI-callback/memory-action composition.
- ✅ P5 traceability update (2026-03-02): after detecting a temporary desync that reintroduced older inline orchestration in `src/app/session/page.tsx`, the page was re-aligned to the documented P5.28–P5.37 owner-based composition baseline; post-fix validation remained green (`npm run type-check`, `npm run test:guardrails:p4`).
- ✅ P5.38 completed (2026-03-03): removed reintroduced local context/message/reflection glue from `src/app/session/page.tsx` by reusing existing owners (`src/app/session/useSessionPageContext.ts`, `src/app/session/useSessionMessageViewModel.ts`, `src/app/session/useSessionReflectionVoiceFlow.ts`) for greeting/request-body/session-lifecycle/memory highlights/latest assistant/reflection prefix concerns.
- ✅ P5.39 completed (2026-03-03): removed remaining inline artifacts/drawer UI callbacks from `src/app/session/page.tsx` by consuming existing handler outputs from `src/app/session/useSessionUiInteractions.ts` (panel close/open + mobile tab/drawer toggles), keeping render composition thinner without UX changes.
- ✅ P5.40 completed (2026-03-03): moved companion rail visibility composite from `src/app/session/page.tsx` into existing UI-derivation owner `src/app/session/useSessionUiDerivedState.ts` (`showCompanionRail`) and added focused coverage in `src/__tests__/session/useSessionUiDerivedState.test.ts`.
- ✅ P5.41 completed (2026-03-03): moved residual dev/debug orchestration effects from `src/app/session/page.tsx` into existing owners (`src/app/session/useSessionStreamOrchestration.ts`, `src/app/session/useSessionInterruptOrchestration.ts`) while keeping behavior and guardrails unchanged.
- ✅ P5.42 completed (2026-03-03): moved voice command binder effect from `src/app/session/page.tsx` into existing seam `src/app/session/useSessionVoiceCommandSystem.ts` by allowing hook-owned binder wiring (`setOnUserTranscriptHandler`, `setAssistantResponseSuppressedChecker`) without behavior changes.
- ✅ P5.43 completed (2026-03-03): removed residual dead imports in `src/app/session/page.tsx` and replaced inline page-guard home redirect lambda with existing `navigateHome` callback, keeping page composition cleaner with no UX/runtime changes.
- ✅ P5.44 completed (2026-03-03): moved stream-interrupt bridge binding from `src/app/session/page.tsx` local effect into existing seam `src/app/session/useSessionInterruptOrchestration.ts` (`setStreamInterruptHandler`), reducing page orchestration glue while preserving behavior.
- ✅ P5.45 completed (2026-03-03): moved page-guard home navigation callback ownership from `src/app/session/page.tsx` into `src/app/session/useSessionPageGuards.ts` (hook-owned `navigateHome`), and added focused coverage in `src/__tests__/session/useSessionPageGuards.test.ts`.

### P5 Closeout (2026-03-03)
- ✅ No remaining large orchestration blocks in `src/app/session/page.tsx`; file acts as composition + render shell.
- ✅ Owner boundaries consolidated across infrastructure, validation, chat runtime, stream/interrupt/voice/queue/exit/interaction orchestration.
- ✅ Guardrail validation kept green after final slices (`npm run type-check`, `npm run test:guardrails:p4`).
- ✅ P5 is considered functionally closed; follow-up work should be treated as minor hygiene or new-scope refactor.

## P6 — Recap Components De-godification (Kickoff)
**Goal:** Reduce complexity concentration in recap UI by splitting high-density component internals into focused files without UX or contract changes.

### P6.1 — Extract Memory Candidate Row
**Scope**
- Move the internal `MemoryCandidateRow` implementation out of `src/app/components/recap/RecapComponents.tsx` into a dedicated file.
- Keep `MemoryCandidatesPanel` props and render behavior unchanged.

**Checkpoint**
- ✅ P6.1 completed (2026-03-03): extracted `RecapMemoryCandidateRow` into `src/app/components/recap/RecapMemoryCandidateRow.tsx` and rewired `MemoryCandidatesPanel` to consume it.
- ✅ Validation passed:
  - `npm run type-check`
  - `npm run test:guardrails:p4`

### P6.2 — Extract Recap Empty State Variants
**Scope**
- Move `RecapEmptyState` variant rendering (`processing`/`unavailable`/`not_found`) from `src/app/components/recap/RecapComponents.tsx` into a dedicated recap file.
- Keep public `RecapEmptyState` API and rendered UX unchanged.

**Checkpoint**
- ✅ P6.2 completed (2026-03-03): extracted variant views to `src/app/components/recap/RecapEmptyStateViews.tsx` and rewired `RecapEmptyState` in `RecapComponents.tsx` as a delegating wrapper.
- ✅ Validation passed:
  - `npm run type-check`
  - `npm run test:guardrails:p4`

### P6.3 — Extract Memory Candidates Footer/Actions
**Scope**
- Move `MemoryCandidatesPanel` save-footer/action cluster into a dedicated recap component.
- Keep `MemoryCandidatesPanel` props, counts, and save button behavior unchanged.

**Checkpoint**
- ✅ P6.3 completed (2026-03-03): extracted footer/actions to `src/app/components/recap/RecapMemoryCandidatesFooter.tsx` and rewired `MemoryCandidatesPanel` in `RecapComponents.tsx`.
- ✅ Validation passed:
  - `npm run type-check`
  - `npm run test:guardrails:p4`

### P6.4 — Extract Memory Candidates Intro/Header
**Scope**
- Move `MemoryCandidatesPanel` header + trust-banner block into a dedicated recap component.
- Keep panel copy, counts, and visual structure unchanged.

**Checkpoint**
- ✅ P6.4 completed (2026-03-03): extracted intro/header section into dedicated recap subcomponent ownership (co-located in `src/app/components/recap/RecapMemoryCandidatesFooter.tsx`) and rewired `MemoryCandidatesPanel` in `RecapComponents.tsx`.
- ✅ Validation passed:
  - `npm run type-check`
  - `npm run test:guardrails:p4`

### P6.5 — Extract Memory Candidates Loading/Empty States
**Scope**
- Move `MemoryCandidatesPanel` internal loading and no-data branches into dedicated recap state components.
- Keep loading copy, empty-state copy, and visual hierarchy unchanged.

**Checkpoint**
- ✅ P6.5 completed (2026-03-03): extracted loading/no-data state branches into dedicated recap subcomponent ownership (co-located in `src/app/components/recap/RecapMemoryCandidatesFooter.tsx`) and rewired `MemoryCandidatesPanel` in `RecapComponents.tsx`.
- ✅ Validation passed:
  - `npm run type-check`
  - `npm run test:guardrails:p4`

### P6.6 — Extract Insight Cards Module
**Scope**
- Move `TakeawayCard` and `ReflectionCard` out of `RecapComponents.tsx` into a dedicated recap module.
- Keep card copy, loading/empty/content states, haptic trigger, and public exports unchanged.

**Checkpoint**
- ✅ P6.6 completed (2026-03-03): extracted insight cards to `src/app/components/recap/RecapInsightCards.tsx` and rewired exports from `RecapComponents.tsx`.
- ✅ Validation passed:
  - `npm run type-check`
  - `npm run test:guardrails:p4`

### P6.7 — RecapMemoryOrbit Exhaustive Audit + Controller/Derivation Extraction
**Scope**
- Audit `RecapMemoryOrbit.tsx` for complexity hotspots and regression risk.
- Extract candidate derivation/visibility logic into pure utilities.
- Extract orbit interaction controller (navigation, keyboard, exit animations, timer cleanup) into dedicated hook.
- Keep orbit visuals, copy, and behavior contracts unchanged.

**Checkpoint**
- ✅ P6.7 completed (2026-03-03):
  - added `src/app/components/recap/RecapMemoryOrbitUtils.ts`
  - added `src/app/components/recap/useRecapMemoryOrbitController.ts`
  - rewired `src/app/components/recap/RecapMemoryOrbit.tsx` to consume extracted modules
  - added audit report `docs/P6_RECAP_MEMORY_ORBIT_AUDIT_2026-03-03.md`
- ✅ Validation passed:
  - `npm run type-check`
  - `npx vitest run src/__tests__/recap/memory-candidates-v2.smoke.test.tsx`

### P6.8 — RecapMemoryOrbit Visual Layer Extraction
**Scope**
- Extract dense presentational blocks from `RecapMemoryOrbit.tsx` (cosmic stage background + orbit state views).
- Keep visual hierarchy, copy, ARIA semantics, and transitions unchanged.

**Checkpoint**
- ✅ P6.8 completed (2026-03-03):
  - added `src/app/components/recap/RecapMemoryOrbitVisuals.tsx`
  - moved `CosmicBackground`, `KeyTakeaway`, `ReflectionPrompt`, `RecapOrbitLoading`, `RecapOrbitEmpty`, `RecapOrbitCompleted`
  - rewired `src/app/components/recap/RecapMemoryOrbit.tsx` as leaner orchestrator
- ✅ Validation passed:
  - `npm run type-check`
  - `npx vitest run src/__tests__/recap/memory-candidates-v2.smoke.test.tsx`
  - `npm run test:guardrails:p4`

### P6.9 — RecapMemoryOrbit Bubble Component Extraction
**Scope**
- Extract `CosmicMemoryBubble` from `RecapMemoryOrbit.tsx` into a dedicated module.
- Preserve bubble visuals, keep/discard action behavior, side-bubble navigation click behavior, and accessibility labels.

**Checkpoint**
- ✅ P6.9 completed (2026-03-03):
  - added `src/app/components/recap/RecapMemoryOrbitBubble.tsx`
  - rewired `src/app/components/recap/RecapMemoryOrbit.tsx` to consume extracted bubble component
- ✅ Validation passed:
  - `npm run type-check`
  - `npx vitest run src/__tests__/recap/memory-candidates-v2.smoke.test.tsx`
  - `npm run test:guardrails:p4`

### P6.10 — RecapMemoryOrbit Navigation/Pagination Extraction
**Scope**
- Extract orbit navigation arrows and pagination indicator from `RecapMemoryOrbit.tsx` into a dedicated component.
- Preserve keyboard/selection behavior, haptic-triggered selection, and existing ARIA labels.

**Checkpoint**
- ✅ P6.10 completed (2026-03-03):
  - added `src/app/components/recap/RecapMemoryOrbitNavigation.tsx`
  - rewired `src/app/components/recap/RecapMemoryOrbit.tsx` to consume extracted navigation component
- ✅ Validation passed:
  - `npm run type-check`
  - `npx vitest run src/__tests__/recap/memory-candidates-v2.smoke.test.tsx`
  - `npm run test:guardrails:p4`

### P6.11 — RecapMemoryOrbit Glue Extraction (Selection + SR Announcements)
**Scope**
- Extract residual inline interaction glue from `RecapMemoryOrbit.tsx`:
  - orbit index/candidate selection callbacks
  - screen-reader live announcement block
- Preserve existing interaction behavior, haptics, and announcement text semantics.

**Checkpoint**
- ✅ P6.11 completed (2026-03-03):
  - added `src/app/components/recap/useRecapMemoryOrbitSelection.ts`
  - added `src/app/components/recap/RecapMemoryOrbitAnnouncements.tsx`
  - rewired `src/app/components/recap/RecapMemoryOrbit.tsx`
- ✅ Validation passed:
  - `npm run type-check`
  - `npx vitest run src/__tests__/recap/memory-candidates-v2.smoke.test.tsx`
  - `npm run test:guardrails:p4`

### P6.12 — Orbit De-godification Closeout / Freeze
**Scope**
- Evaluate post-P6.11 `RecapMemoryOrbit` for remaining extraction opportunities.
- Close phase when additional splits would introduce over-fragmentation without clear ownership gain.

**Closeout Decision**
- ✅ P6.12 completed (2026-03-03): Orbit de-godification is considered complete for this cycle.
- ✅ Freeze guidance: keep current module boundaries (`OrbitUtils`, controller, visuals, bubble, navigation, selection, announcements) and avoid further micro-splits unless a new behavioral requirement appears.
- ✅ Validation status remains green:
  - `npm run type-check`
  - `npx vitest run src/__tests__/recap/memory-candidates-v2.smoke.test.tsx`
  - `npm run test:guardrails:p4`

### P6.13 — Recap Page Chrome Extraction
**Scope**
- Extract repeated recap page chrome blocks from `src/app/recap/[sessionId]/page.tsx`:
  - floating header variants (loading/error/ready)
  - bottom action bar (retry + complete)
  - save success overlay
- Keep UX, copy, and navigation behavior unchanged.

**Checkpoint**
- ✅ P6.13 completed (2026-03-03):
  - added `src/app/recap/[sessionId]/RecapPageChrome.tsx`
  - rewired `src/app/recap/[sessionId]/page.tsx` to consume extracted chrome components
- ✅ Validation passed:
  - `npm run type-check`
  - `npx vitest run src/__tests__/recap/memory-candidates-v2.smoke.test.tsx`
  - `npm run test:guardrails:p4`

### P6.14 — Recap Page Side-effect Hooks Extraction
**Scope**
- Extract recap page heavy side-effect logic from `src/app/recap/[sessionId]/page.tsx`:
  - artifacts loading/status lifecycle
  - memory decision/discard/save action flows + retry/error state
- Preserve all existing network behavior, copy, toasts, and navigation timing.

**Checkpoint**
- ✅ P6.14 completed (2026-03-03):
  - added `src/app/recap/[sessionId]/useRecapArtifactsLoader.ts`
  - added `src/app/recap/[sessionId]/useRecapMemoryActions.ts`
  - rewired `src/app/recap/[sessionId]/page.tsx` to consume both hooks
- ✅ Validation passed:
  - `npm run type-check`
  - `npx vitest run src/__tests__/recap/memory-candidates-v2.smoke.test.tsx`
  - `npm run test:guardrails:p4`

### P7.1 — Voice Loop Connection Flow Consolidation (Post-Phase Hardening)
**Scope**
- Reduce repeated “fresh socket” orchestration in `src/app/hooks/useVoiceLoop.ts` by extracting connect/disconnect flow helpers into `voice-loop-connection-helpers`.
- Reuse the new helpers in `startTalking`, `retryLastVoiceTurn`, and `speakText` without changing behavior or public hook contract.

**Checkpoint**
- ✅ P7.1 completed (2026-03-03):
  - added `connectVoiceSocketFresh` and `connectVoiceSocketFreshWithSingleRetry` in `src/app/hooks/voice/voice-loop-connection-helpers.ts`
  - rewired connection paths in `src/app/hooks/useVoiceLoop.ts`
- ✅ Validation passed:
  - `npm run type-check`
  - `npm run test -- src/__tests__/hooks/voice`
  - `npm run check:logs:global`

### P7.2 — Voice Loop Turn Finalization Consolidation
**Scope**
- Extract repeated assistant-turn finalization flow from `src/app/hooks/useVoiceLoop.ts` (persist assistant response, emit final reply, reset reply buffer) into a dedicated helper.
- Reuse helper in `response_end`, legacy `response`, `reply_done`, and transient-error recovery branches without behavior changes.

**Checkpoint**
- ✅ P7.2 completed (2026-03-03):
  - added `src/app/hooks/voice/voice-loop-turn-finalization-helpers.ts`
  - rewired finalization branches in `src/app/hooks/useVoiceLoop.ts`
- ✅ Validation passed:
  - `npm run type-check`
  - `npm run test -- src/__tests__/hooks/voice`
  - `npm run check:logs:global`

### P7.3 — Voice Loop Thinking Timeout Wiring Consolidation
**Scope**
- Extract repeated thinking-timeout arming logic from `src/app/hooks/useVoiceLoop.ts` into a focused helper that composes timeout and idle-transition behavior.
- Reuse helper across `token`, `stopTalking`, `retryLastVoiceTurn`, and `speakText` timeout paths while preserving messages, telemetry reasons, and disconnect behavior.

**Checkpoint**
- ✅ P7.3 completed (2026-03-03):
  - added `src/app/hooks/voice/voice-loop-thinking-helpers.ts`
  - rewired timeout arming branches in `src/app/hooks/useVoiceLoop.ts`
- ✅ Validation passed:
  - `npm run type-check`
  - `npm run test -- src/__tests__/hooks/voice`
  - `npm run check:logs:global`

### P7.4 — Voice Loop WS Base Resolution Consolidation
**Scope**
- Remove repeated environment fallback logic for voice websocket base URL from `src/app/hooks/useVoiceLoop.ts`.
- Centralize base URL resolution in `src/app/hooks/voice/voice-loop-connection-helpers.ts` and reuse in `startTalking`, `retryLastVoiceTurn`, and `speakText`.

**Checkpoint**
- ✅ P7.4 completed (2026-03-03):
  - added `resolveVoiceWsBaseUrl` to `src/app/hooks/voice/voice-loop-connection-helpers.ts`
  - rewired wsBase resolution in `src/app/hooks/useVoiceLoop.ts`
- ✅ Validation passed:
  - `npm run type-check`
  - `npm run test -- src/__tests__/hooks/voice`
  - `npm run check:logs:global`

### P7.5 — Voice Loop Session ID Resolution Consolidation
**Scope**
- Remove duplicated preferred-session-or-generated-session logic in `src/app/hooks/useVoiceLoop.ts`.
- Centralize session id resolution in `src/app/hooks/voice/voice-loop-connection-helpers.ts` for start/retry voice paths.

**Checkpoint**
- ✅ P7.5 completed (2026-03-03):
  - added `resolveVoiceSessionId` to `src/app/hooks/voice/voice-loop-connection-helpers.ts`
  - rewired session id selection in `startTalking` and `retryLastVoiceTurn` in `src/app/hooks/useVoiceLoop.ts`
- ✅ Validation passed:
  - `npm run type-check`
  - `npm run test -- src/__tests__/hooks/voice`
  - `npm run check:logs:global`

### P7.6 — Voice Loop Assistant Handler Wiring Deduplication
**Scope**
- Remove repeated assistant persistence handler object literals in `src/app/hooks/useVoiceLoop.ts`.
- Introduce a memoized shared handler object and reuse it across assistant-turn finalization branches.

**Checkpoint**
- ✅ P7.6 completed (2026-03-03):
  - added memoized `assistantResponseHandlers` in `src/app/hooks/useVoiceLoop.ts`
  - rewired response finalization branches to consume shared handler wiring
- ✅ Validation passed:
  - `npm run type-check`
  - `npm run test -- src/__tests__/hooks/voice`
  - `npm run check:logs:global`

### P7.7 — Stop/Retry Command Failure Handling Consolidation
**Scope**
- Extract shared failure handling for `sendStopTalkingCommands` results from `src/app/hooks/useVoiceLoop.ts`.
- Reuse helper in `stopTalking` and `retryLastVoiceTurn` while preserving distinct `send-failed` logging behavior for stop flow.

**Checkpoint**
- ✅ P7.7 completed (2026-03-03):
  - added `handleStopTalkingCommandFailure` in `src/app/hooks/voice/voice-loop-command-helpers.ts`
  - rewired stop/retry command-result branches in `src/app/hooks/useVoiceLoop.ts`
- ✅ Validation passed:
  - `npm run type-check`
  - `npm run test -- src/__tests__/hooks/voice`
  - `npm run check:logs:global`

### P7.8 — Connection Session Orchestration Consolidation
**Scope**
- Consolidate repeated `ws-ticket` fetch + fresh socket connect wiring from `src/app/hooks/useVoiceLoop.ts`.
- Introduce a single helper in `src/app/hooks/voice/voice-loop-connection-helpers.ts` with optional single-retry behavior and reuse across `startTalking`, `retryLastVoiceTurn`, and `speakText`.

**Checkpoint**
- ✅ P7.8 completed (2026-03-03):
  - added `connectVoiceSessionFresh` in `src/app/hooks/voice/voice-loop-connection-helpers.ts`
  - rewired connection orchestration in `src/app/hooks/useVoiceLoop.ts`
- ✅ Validation passed:
  - `npm run type-check`
  - `npm run test -- src/__tests__/hooks/voice`
  - `npm run check:logs:global`

### P7.9 — Voice Helper Regression Coverage Expansion
**Scope**
- Add focused tests for newly extracted helper behavior to keep de-godification slices protected.
- Cover stop-command failure handling and fresh-session connect orchestration with retry.

**Checkpoint**
- ✅ P7.9 completed (2026-03-03):
  - extended `src/__tests__/hooks/voice/voice-loop-command-helpers.test.ts`
  - added `src/__tests__/hooks/voice/voice-loop-connection-helpers.test.ts`
- ✅ Validation passed:
  - `npm run test -- src/__tests__/hooks/voice` (6 files, 20 tests)
  - `npm run type-check`
  - `npm run check:logs:global`

### P7.10 — Presence/Timing Reset Consolidation
**Scope**
- Remove duplicated presence-reset and speech-timing ref-reset wiring from `bargeIn` and `resetVoiceState` in `src/app/hooks/useVoiceLoop.ts`.
- Extract focused helpers without changing reset order or visible UX behavior.

**Checkpoint**
- ✅ P7.10 completed (2026-03-03):
  - added `src/app/hooks/voice/voice-loop-presence-helpers.ts`
  - rewired `bargeIn` and `resetVoiceState` in `src/app/hooks/useVoiceLoop.ts`
- ✅ Validation passed:
  - `npm run type-check`
  - `npm run test -- src/__tests__/hooks/voice` (6 files, 20 tests)
  - `npm run check:logs:global`

### P7.11 — Session-ended Transition Consolidation
**Scope**
- Remove repeated “session ended” error handling fragments from `src/app/hooks/useVoiceLoop.ts`.
- Add a dedicated transition helper supporting optional idle/disconnect side-effects and reuse it in retry/speak flows.

**Checkpoint**
- ✅ P7.11 completed (2026-03-03):
  - added `handleSessionEnded` in `src/app/hooks/voice/voice-loop-transition-helpers.ts`
  - rewired session-ended branches in `src/app/hooks/useVoiceLoop.ts`
  - added `src/__tests__/hooks/voice/voice-loop-transition-helpers.test.ts`
- ✅ Validation passed:
  - `npm run test -- src/__tests__/hooks/voice` (7 files, 22 tests)
  - `npm run type-check`
  - `npm run check:logs:global`

### P7.12 — Cleanup/Unmount Wiring Consolidation
**Scope**
- Remove duplicated cleanup function wiring and unmount cleanup sequence from `src/app/hooks/useVoiceLoop.ts`.
- Extract dedicated helpers for cleanup object composition and unmount execution order.

**Checkpoint**
- ✅ P7.12 completed (2026-03-03):
  - added `src/app/hooks/voice/voice-loop-cleanup-helpers.ts`
  - rewired `cleanupFunctionsRef` setup/update and unmount cleanup in `src/app/hooks/useVoiceLoop.ts`
  - added `src/__tests__/hooks/voice/voice-loop-cleanup-helpers.test.ts`
- ✅ Validation passed:
  - `npm run test -- src/__tests__/hooks/voice` (8 files, 24 tests)
  - `npm run type-check`
  - `npm run check:logs:global`

### P7.13 — speakText Connect Error-path Simplification
**Scope**
- Remove nested async IIFE from `speakText` connection block in `src/app/hooks/useVoiceLoop.ts`.
- Add a safe connection wrapper helper in connection helpers and preserve existing warning/log + session-ended behavior.

**Checkpoint**
- ✅ P7.13 completed (2026-03-03):
  - added `connectVoiceSessionFreshSafely` in `src/app/hooks/voice/voice-loop-connection-helpers.ts`
  - rewired `speakText` in `src/app/hooks/useVoiceLoop.ts` to use safe wrapper
  - extended `src/__tests__/hooks/voice/voice-loop-connection-helpers.test.ts`
- ✅ Validation passed:
  - `npm run test -- src/__tests__/hooks/voice` (8 files, 25 tests)
  - `npm run type-check`
  - `npm run check:logs:global`

### P7.14 — stopTalking Transition Consolidation
**Scope**
- Extract stream cleanup and post-stop stage-transition orchestration from `stopTalking` in `src/app/hooks/useVoiceLoop.ts`.
- Preserve connected/disconnected stage behavior, timeout arming path, and listening reset order.

**Checkpoint**
- ✅ P7.14 completed (2026-03-03):
  - added `src/app/hooks/voice/voice-loop-stop-helpers.ts`
  - rewired `stopTalking` stream cleanup + transition branch in `src/app/hooks/useVoiceLoop.ts`
  - added `src/__tests__/hooks/voice/voice-loop-stop-helpers.test.ts`
- ✅ Validation passed:
  - `npm run test -- src/__tests__/hooks/voice` (9 files, 28 tests)
  - `npm run type-check`
  - `npm run check:logs:global`

### P7.15 — startTalking Capture Error Mapping Consolidation
**Scope**
- Extract start-capture error-to-user-message mapping from `src/app/hooks/useVoiceLoop.ts` into a dedicated helper.
- Preserve exact message mapping for `NotAllowedError`/denied, `NotFoundError`, `NotReadableError`, and fallback.

**Checkpoint**
- ✅ P7.15 completed (2026-03-03):
  - added `src/app/hooks/voice/voice-loop-capture-helpers.ts`
  - rewired start-capture catch branch in `src/app/hooks/useVoiceLoop.ts`
  - added `src/__tests__/hooks/voice/voice-loop-capture-helpers.test.ts`
- ✅ Validation passed:
  - `npm run test -- src/__tests__/hooks/voice` (10 files, 32 tests)
  - `npm run type-check`
  - `npm run check:logs:global`

### P7.16 — startTalking Preflight Consolidation
**Scope**
- Extract microphone preflight orchestration from `startTalking` in `src/app/hooks/useVoiceLoop.ts`:
  - one-time diagnostics execution
  - safe permission-state resolution
- Preserve existing warning, permission-denied, and capture-start behavior.

**Checkpoint**
- ✅ P7.16 completed (2026-03-03):
  - added `src/app/hooks/voice/voice-loop-preflight-helpers.ts`
  - rewired preflight block in `src/app/hooks/useVoiceLoop.ts`
  - added `src/__tests__/hooks/voice/voice-loop-preflight-helpers.test.ts`
- ✅ Validation passed:
  - `npm run test -- src/__tests__/hooks/voice` (11 files, 35 tests)
  - `npm run type-check`
  - `npm run check:logs:global`

### P7.17 — startTalking Capture-start Flow Consolidation
**Scope**
- Extract post-mic-start success side-effects from `startTalking` in `src/app/hooks/useVoiceLoop.ts`:
  - stream ref assignment
  - listening stage/presence updates
  - speech start timestamp
  - recording start event + breadcrumb + capture telemetry
- Preserve event/timing semantics and visible UX behavior.

**Checkpoint**
- ✅ P7.17 completed (2026-03-03):
  - added `src/app/hooks/voice/voice-loop-start-helpers.ts`
  - rewired start-capture success branch in `src/app/hooks/useVoiceLoop.ts`
  - added `src/__tests__/hooks/voice/voice-loop-start-helpers.test.ts`
- ✅ Validation passed:
  - `npm run test -- src/__tests__/hooks/voice` (12 files, 36 tests)
  - `npm run type-check`
  - `npm run check:logs:global`

### P7.18 — startTalking Failure Branch Consolidation
**Scope**
- Extract capture-failure side-effects from `startTalking` catch branch in `src/app/hooks/useVoiceLoop.ts`:
  - error message state
  - fallback store propagation
  - telemetry emission
  - listening reset + recorder cleanup
- Preserve fallback telemetry message behavior for empty errors.

**Checkpoint**
- ✅ P7.18 completed (2026-03-03):
  - added `src/app/hooks/voice/voice-loop-failure-helpers.ts`
  - rewired capture-failure branch in `src/app/hooks/useVoiceLoop.ts`
  - added `src/__tests__/hooks/voice/voice-loop-failure-helpers.test.ts`
- ✅ Validation passed:
  - `npm run test -- src/__tests__/hooks/voice` (13 files, 37 tests)
  - `npm run type-check`
  - `npm run check:logs:global`

### P7.19 — stopTalking Metrics/Event Consolidation
**Scope**
- Extract `stopTalking` metrics/event side-effects from `src/app/hooks/useVoiceLoop.ts`:
  - recording stop event payload calculation
  - capture-stop telemetry emission
  - speech end timestamp finalization
- Preserve timing semantics and emitted payload shape.

**Checkpoint**
- ✅ P7.19 completed (2026-03-03):
  - added `src/app/hooks/voice/voice-loop-stop-metrics-helpers.ts`
  - rewired stop metrics/event block in `src/app/hooks/useVoiceLoop.ts`
  - added `src/__tests__/hooks/voice/voice-loop-stop-metrics-helpers.test.ts`
- ✅ Validation passed:
  - `npm run test -- src/__tests__/hooks/voice` (14 files, 39 tests)
  - `npm run type-check`
  - `npm run check:logs:global`

### P7.20 — startTalking Attempt/Permission Branch Consolidation
**Scope**
- Extract start-attempt state reset and permission-denied side-effects from `src/app/hooks/useVoiceLoop.ts`.
- Preserve connecting-stage initialization and denied-permission telemetry semantics.

**Checkpoint**
- ✅ P7.20 completed (2026-03-03):
  - added `src/app/hooks/voice/voice-loop-start-state-helpers.ts`
  - rewired start-attempt prep and denied-permission branch in `src/app/hooks/useVoiceLoop.ts`
  - added `src/__tests__/hooks/voice/voice-loop-start-state-helpers.test.ts`
- ✅ Validation passed:
  - `npm run test -- src/__tests__/hooks/voice` (15 files, 41 tests)
  - `npm run type-check`
  - `npm run check:logs:global`

### P7.21 — Thinking-flow Consolidation for Retry/Speak
**Scope**
- Extract repeated `clear timeout -> enter thinking -> arm thinking timeout` orchestration into a dedicated helper.
- Reuse helper in `retryLastVoiceTurn` and `speakText` while preserving timeout reasons and timeout-side diagnostics.

**Checkpoint**
- ✅ P7.21 completed (2026-03-03):
  - added `beginVoiceThinkingWithTimeout` in `src/app/hooks/voice/voice-loop-thinking-helpers.ts`
  - rewired retry/speak thinking transitions in `src/app/hooks/useVoiceLoop.ts`
  - added `src/__tests__/hooks/voice/voice-loop-thinking-helpers.test.ts`
- ✅ Validation passed:
  - `npm run test -- src/__tests__/hooks/voice` (16 files, 42 tests)
  - `npm run type-check`
  - `npm run check:logs:global`

### P7.22 — startTalking Usage-limit Gate Consolidation
**Scope**
- Extract usage-limit gating from `startTalking` in `src/app/hooks/useVoiceLoop.ts`:
  - limit-check short-circuit
  - modal open policy
  - limit title error message emission
- Preserve existing modal payload semantics (`FREE`, `limit:0`, `used:0`).

**Checkpoint**
- ✅ P7.22 completed (2026-03-03):
  - added `src/app/hooks/voice/voice-loop-usage-helpers.ts`
  - rewired usage gate in `src/app/hooks/useVoiceLoop.ts`
  - added `src/__tests__/hooks/voice/voice-loop-usage-helpers.test.ts`
- ✅ Validation passed:
  - `npm run test -- src/__tests__/hooks/voice` (17 files, 45 tests)
  - `npm run type-check`
  - `npm run check:logs:global`

### P7.23 — WebSocket onClose Lifecycle Consolidation
**Scope**
- Extract websocket `onClose` side-effects from `src/app/hooks/useVoiceLoop.ts` into a dedicated helper.
- Preserve timeout clear, playback flush, guarded idle transition, and presence reset behavior.

**Checkpoint**
- ✅ P7.23 completed (2026-03-03):
  - added `src/app/hooks/voice/voice-loop-websocket-helpers.ts`
  - rewired websocket `onClose` branch in `src/app/hooks/useVoiceLoop.ts`
  - added `src/__tests__/hooks/voice/voice-loop-websocket-helpers.test.ts`
- ✅ Validation passed:
  - `npm run test -- src/__tests__/hooks/voice` (18 files, 47 tests)
  - `npm run type-check`
  - `npm run check:logs:global`

### P7.24 — WebSocket Message Handler Extraction (Major Size Drop)
**Scope**
- Extract the large websocket message/binary handling block from `src/app/hooks/useVoiceLoop.ts` into a dedicated hook module.
- Keep behavior and side-effect order unchanged while materially reducing hook file size.

**Checkpoint**
- ✅ P7.24 completed (2026-03-03):
  - added `src/app/hooks/voice/useVoiceLoopWsHandlers.ts`
  - rewired `src/app/hooks/useVoiceLoop.ts` to consume extracted ws handlers hook
  - fixed `setPath` typing bridge after extraction
- ✅ Validation passed:
  - `npm run test -- src/__tests__/hooks/voice` (18 files, 47 tests)
  - `npm run type-check`
  - `npm run check:logs:global`
- ✅ Size impact:
  - `src/app/hooks/useVoiceLoop.ts` reduced from 1035 lines to 691 lines

### P7.25 — startTalking Hook Extraction (Further Size Drop)
**Scope**
- Extract the full `startTalking` orchestration from `src/app/hooks/useVoiceLoop.ts` into a dedicated hook module.
- Preserve usage-limit gating, mic diagnostics/permission flow, ws connect timing telemetry, capture-start events, and failure mapping.

**Checkpoint**
- ✅ P7.25 completed (2026-03-03):
  - added `src/app/hooks/voice/useVoiceLoopStartTalking.ts`
  - rewired `src/app/hooks/useVoiceLoop.ts` to consume extracted start-talking hook
  - aligned recording API typing bridge (`unlockAudio` return compatibility)
- ✅ Validation passed:
  - `npm run test -- src/__tests__/hooks/voice` (18 files, 47 tests)
  - `npm run type-check`
  - `npm run check:logs:global`
- ✅ Size impact:
  - `src/app/hooks/useVoiceLoop.ts` reduced from 691 lines to 583 lines

### P7.26 — stopTalking Hook Extraction (Further Size Drop)
**Scope**
- Extract the full `stopTalking` orchestration from `src/app/hooks/useVoiceLoop.ts` into a dedicated hook module.
- Preserve command send/failure handling, stop-transition semantics, recording-stop event emission, and stop telemetry.

**Checkpoint**
- ✅ P7.26 completed (2026-03-03):
  - added `src/app/hooks/voice/useVoiceLoopStopTalking.ts`
  - rewired `src/app/hooks/useVoiceLoop.ts` to consume extracted stop-talking hook
  - aligned websocket send signature typing bridge with command helper contracts
- ✅ Validation passed:
  - `npm run test -- src/__tests__/hooks/voice` (18 files, 47 tests)
  - `npm run type-check`
  - `npm run check:logs:global`
- ✅ Size impact:
  - `src/app/hooks/useVoiceLoop.ts` reduced from 583 lines to 515 lines

### P7.27 — retryLastVoiceTurn Hook Extraction (Further Size Drop)
**Scope**
- Extract `retryLastVoiceTurn` retry orchestration and `hasRetryableVoiceTurn` guard from `src/app/hooks/useVoiceLoop.ts` into a dedicated hook.
- Preserve ws reconnect, command resend, session-ended fallback, and thinking-timeout transition behavior.

**Checkpoint**
- ✅ P7.27 completed (2026-03-03):
  - added `src/app/hooks/voice/useVoiceLoopRetryLastVoiceTurn.ts`
  - rewired `src/app/hooks/useVoiceLoop.ts` to consume extracted retry hook
  - removed now-inline retry command/connect handling from main hook file
- ✅ Validation passed:
  - `npm run test -- src/__tests__/hooks/voice` (18 files, 47 tests)
  - `npm run type-check`
  - `npm run check:logs:global`
- ✅ Size impact:
  - `src/app/hooks/useVoiceLoop.ts` reduced from 515 lines to 461 lines

### P7.28 — speakText Hook Extraction (Planned Final Slice)
**Scope**
- Extract `speakText` orchestration from `src/app/hooks/useVoiceLoop.ts` into a dedicated hook.
- Preserve connect-with-retry flow, reflection voice telemetry/debug traces, thinking-timeout arm, and session-ended fallback semantics.

**Checkpoint**
- ✅ P7.28 completed (2026-03-03):
  - added `src/app/hooks/voice/useVoiceLoopSpeakText.ts`
  - rewired `src/app/hooks/useVoiceLoop.ts` to consume extracted speak-text hook
  - removed now-unused connection/transition imports from main hook file
- ✅ Validation passed:
  - `npm run test -- src/__tests__/hooks/voice` (18 files, 47 tests)
  - `npm run type-check`
  - `npm run check:logs:global`
- ✅ Size impact:
  - `src/app/hooks/useVoiceLoop.ts` reduced from 461 lines to 369 lines
