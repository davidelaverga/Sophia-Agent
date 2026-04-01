# P5 Session Precheck (2026-03-02)

Objective: start P5 without re-refactoring domains that were already extracted in previous phases.

## Session inventory snapshot

Folder: `src/app/session`

- Total modules: 31
- Main orchestrator: `page.tsx` (1243 lines)
- Extracted hooks/utilities around page: 30 modules

## Already extracted and integrated in page (do not recreate)

`src/app/session/page.tsx` currently imports these session modules directly:

- `useSessionMemoryActions`
- `useSessionQueueSync`
- `useSessionExitFlow`
- `useSessionExitProtection`
- `useSessionUiInteractions`
- `useSessionCompanionIntegration`
- `useSessionOutboundSend`, `useSessionSendActions`
- `useSessionChatInitialization`
- `useSessionRetryHandlers`
- `stream-contract-adapters` (types/contracts)
- `useSessionConversationArchive`
- `useSessionVoiceBridge`
- `useSessionVoiceCommandSystem`
- `useSessionVoiceMessages`
- `useSessionVoiceUiControls`
- `useSessionArtifactsReducer`
- `useSessionStreamContract`
- `useSessionMessageViewModel`
- `useSessionStreamPersistence`
- `useSessionReflectionVoiceFlow`
- `useSessionUiDerivedState`
- `useSessionQueueRuntime`
- `useSessionInterruptRetryState`
- `useSessionPageContext`
- `useSessionUiCallbacks`
- `useSessionPageGuards`

Rule: if a change belongs to one of these domains, modify the existing module instead of creating a parallel hook/module.

P5.1 update:
- Local page-only state ownership has been extracted to `useSessionPageLocalState.ts`.
- Do not recreate alternative local-state hooks for the same concern.

P5.2 update:
- Cancelled-retry voice replay ownership has been extracted to `useSessionCancelledRetryVoiceReplay.ts`.
- Do not duplicate this retry+voice replay logic inside `page.tsx`, `useSessionRetryHandlers.ts`, or `useSessionVoiceBridge.ts`.

P5.3 update:
- Voice command normalization + reflection command matching ownership moved from `page.tsx` to existing seam `useSessionVoiceCommandSystem.ts`.
- Do not reintroduce `normalizeVoiceCommand` / `isReflectionVoiceCommand` callbacks in `page.tsx`; extend `useSessionVoiceCommandSystem.ts` and its existing test seam instead.

P5.4 update:
- Memory snippet formatting ownership moved from `page.tsx` to existing seam `useSessionMemoryActions.ts`.
- Do not reintroduce local `formatMemorySnippet` callback in `page.tsx`; keep toast-snippet formatting centralized in `useSessionMemoryActions.ts`.

P5.5 update:
- Reflection queued-user append ownership moved from `page.tsx` into existing seam `useSessionReflectionVoiceFlow.ts` via `setChatMessages`.
- Reflection prefix constant ownership moved to `useSessionReflectionVoiceFlow.ts` (`SESSION_REFLECTION_PREFIX`); do not reintroduce local `REFLECTION_PREFIX` in `page.tsx`.

P5.6 update:
- Latest assistant message derivation ownership moved from `page.tsx` to existing seam `useSessionMessageViewModel.ts`.
- Do not reintroduce local `latestAssistantMessage` memo loop in `page.tsx`; consume `latestAssistantMessage` from `useSessionMessageViewModel.ts`.

P5.7 update:
- `isSophiaResponding` derivation ownership moved from `page.tsx` to existing seam `useSessionUiDerivedState.ts`.
- Do not reintroduce local `isSophiaResponding` composite in `page.tsx`; consume it from `useSessionUiDerivedState.ts`.

P5.8 update:
- Quick prompt-selection callback ownership moved from `page.tsx` to existing seam `useSessionUiCallbacks.ts`.
- Do not reintroduce local `handlePromptSelect` callback in `page.tsx`; consume it from `useSessionUiCallbacks.ts`.

P5.9 update:
- Cancel-thinking orchestration ownership moved from `page.tsx` to existing seam `useSessionSendActions.ts`.
- Do not reintroduce local `handleCancelThinking` callback in `page.tsx`; consume it from `useSessionSendActions.ts`.

P5.10 update:
- Interrupt-select-with-retry wrapper ownership moved from `page.tsx` to existing seam `useSessionInterruptRetryState.ts`.
- Do not reintroduce local retry-wrapper callback in `page.tsx`; consume hook-owned `runInterruptSelectWithRetry` from `useSessionInterruptRetryState.ts`.

P5.11 update:
- Chat request body context assembly ownership moved from `page.tsx` to existing seam `useSessionPageContext.ts`.
- Do not reintroduce local `chatRequestBody` memo in `page.tsx`; consume `chatRequestBody` from `useSessionPageContext.ts`.

P5.12 update:
- Greeting fallback/anchor derivation ownership moved from `page.tsx` to existing seam `useSessionPageContext.ts`.
- Do not reintroduce local `fallbackGreeting`/`initialGreeting`/`greetingMessageId`/`greetingAnchorId` derivations in `page.tsx`; consume them from `useSessionPageContext.ts`.

P5.13 update:
- Chat transport payload wiring in `page.tsx` now consumes context-owned `chatRequestBody` from `useSessionPageContext.ts`.
- Do not reintroduce duplicated payload object assembly inside `chatTransport` config in `page.tsx`.

P5.14 update:
- Session active-lifecycle effect (`resumeSession` on mount + guarded `pauseSession` cleanup) ownership moved from `page.tsx` to existing seam `useSessionPageContext.ts`.
- Do not reintroduce this session lifecycle effect in `page.tsx`; keep it centralized in `useSessionPageContext.ts`.

P5.15 update:
- Memory highlights derivation ownership moved from `page.tsx` to existing seam `useSessionPageContext.ts`.
- Do not reintroduce local `memoryHighlights` derivation in `page.tsx`; consume `memoryHighlights` from `useSessionPageContext.ts`.

P5.16 update:
- Voice artifacts source-tagging wrapper ownership moved from `page.tsx` to existing seam `useSessionVoiceBridge.ts`.
- Do not reintroduce local `handleVoiceArtifacts` callback in `page.tsx`; pass `ingestArtifacts` directly to `useSessionVoiceBridge.ts`.

P5.17 update:
- Memory-highlights render-gate debug effect ownership moved from `page.tsx` to existing seam `useSessionMessageViewModel.ts`.
- Do not reintroduce local gate effect/ref (`memoryHighlightsGateLogRef`) in `page.tsx`; keep this gate logging inside `useSessionMessageViewModel.ts`.

P5.18 update:
- Interrupt-select-with-retry callback ownership moved from `page.tsx` wrapper glue to existing seam `useSessionInterruptRetryState.ts` via hook-owned binder (`setInterruptSelectHandler` + `handleInterruptSelectWithRetry`).
- Do not reintroduce local wrapper callback for interrupt select retry in `page.tsx`; bind handler and consume hook-owned `handleInterruptSelectWithRetry`.

P5.19 update:
- Removed residual unused interrupt retry helper destructuring (`runInterruptSelectWithRetry`) from `page.tsx` after P5.18 ownership move.
- Keep interrupt retry orchestration surface in `useSessionInterruptRetryState.ts`; avoid reintroducing unused helper glue in `page.tsx`.

P5.20 update:
- Exit protection `responseMode` derivation ownership moved from `page.tsx` to existing seam `useSessionUiDerivedState.ts`.
- Do not reintroduce inline response-mode composite logic in `page.tsx`; consume `exitProtectionResponseMode` from `useSessionUiDerivedState.ts`.

P5.21 update:
- Voice transcript/assistant suppression bridge ownership moved from local `page.tsx` refs/wrappers to existing seam `useSessionVoiceBridge.ts` via hook-owned binder APIs.
- Do not reintroduce local ref wrappers (`handleVoiceTranscriptRef` / `isAssistantResponseSuppressedRef`) in `page.tsx`; bind handlers through `useSessionVoiceBridge.ts` (`setOnUserTranscriptHandler`, `setAssistantResponseSuppressedChecker`).

P5.22 update:
- Resume-retry callback ownership moved from inline `SessionConversationPane` JSX callback in `page.tsx` to existing seam `useSessionInterruptRetryState.ts` via hook-owned `handleResumeRetry`.
- Do not reintroduce inline `onResumeRetry` option-id checks in `page.tsx`; consume `handleResumeRetry` from `useSessionInterruptRetryState.ts`.

P5.23 update:
- Stream-error dismiss callback ownership moved from inline `SessionConversationPane` JSX callback in `page.tsx` to existing seam `useSessionUiCallbacks.ts` via hook-owned `handleDismissStreamError`.
- Do not reintroduce inline `onDismissStreamError` lambdas in `page.tsx`; consume `handleDismissStreamError` from `useSessionUiCallbacks.ts`.

P5.24 update:
- Cancelled-retry trigger callback ownership moved from inline `SessionConversationPane` JSX callback in `page.tsx` to existing seam `useSessionCancelledRetryVoiceReplay.ts` via hook-owned sync `handleCancelledRetryPress`.
- Do not reintroduce inline promise-void wrappers for `onRetryCancelled` in `page.tsx`; consume `handleCancelledRetryPress` from `useSessionCancelledRetryVoiceReplay.ts`.

P5.25 update:
- Voice-retry trigger callback ownership moved from inline `SessionConversationPane` JSX callback in `page.tsx` to existing seam `useSessionVoiceBridge.ts` via hook-owned sync `handleVoiceRetryPress`.
- Do not reintroduce inline promise-void wrappers for `onRetryVoice` in `page.tsx`; consume `handleVoiceRetryPress` from `useSessionVoiceBridge.ts`.

P5.26 update:
- Resume-retry trigger callback ownership moved from inline `SessionConversationPane` JSX callback in `page.tsx` to existing seam `useSessionInterruptRetryState.ts` via hook-owned sync `handleResumeRetryPress`.
- Do not reintroduce inline promise-void wrappers for `onResumeRetry` in `page.tsx`; consume `handleResumeRetryPress` from `useSessionInterruptRetryState.ts`.

P5.27 update:
- Remaining minimal UI callback seams in `page.tsx` were moved to existing owners:
	- reconnect-online dismiss callback -> `useSessionPageLocalState.ts` (`handleReconnectOnline`)
	- artifacts panel + mobile drawer toggle callbacks -> `useSessionUiInteractions.ts`
	- feedback/session-expired/multi-tab modal callbacks -> `useSessionUiCallbacks.ts`
	- home navigation callback reuse -> `useSessionUiCallbacks.ts` + `useSessionPageGuards.ts` wiring
- Do not reintroduce inline UI callback lambdas for these concerns in `page.tsx`; consume hook-owned handlers.

P5.28 update:
- Store/connectivity infrastructure ownership moved from a large local cluster in `page.tsx` to new page-local hook `useSessionInfrastructure.ts`.
- `useSessionInfrastructure.ts` now owns connectivity monitoring wiring, connectivity queue/store selectors, message metadata setters, usage-limit selectors, feedback selectors, and connectivity failure action wiring for chat error handling.
- Do not reintroduce this selector/connectivity cluster in `page.tsx`; consume infrastructure outputs from `useSessionInfrastructure.ts`.

P5.29 update:
- Session validation wiring ownership moved from `page.tsx` to new page-local hook `useSessionValidationState.ts` (including expired/multi-tab state mapping and validation hook binding).
- Feedback toast local state ownership moved from `page.tsx` to existing local-state owner `useSessionPageLocalState.ts`.
- Do not reintroduce direct `useSessionValidation` setup or local `showFeedbackToast` state in `page.tsx`; consume through `useSessionValidationState.ts` and `useSessionPageLocalState.ts`.

P5.30 update:
- `useChat` runtime wiring ownership moved from `page.tsx` to new session hook `useSessionChatRuntime.ts`.
- `useSessionChatRuntime.ts` now owns chat transport creation, AI SDK `useChat` binding, stream error policy (usage-limit/offline/generic toasts), and stop-stream cleanup.
- Do not reintroduce direct `useChat` + transport + inline `onError` handling in `page.tsx`; consume chat runtime outputs from `useSessionChatRuntime.ts`.

P5.31 update:
- Added dedicated session owner `useSessionInterruptOrchestration.ts` for interrupt domain orchestration previously embedded in `page.tsx`.
- This owner now wraps `useInterrupt` wiring (`onArtifacts`, `onResumeSuccess`, `onResumeError`) and `setInterruptSelectHandler` binding.
- Do not reintroduce this interrupt orchestration block in `page.tsx`; consume interrupt state/actions via `useSessionInterruptOrchestration.ts`.

P5.32 update:
- Stream-contract coordination ownership moved from `page.tsx` to new session owner `useSessionStreamOrchestration.ts`.
- `useSessionStreamOrchestration.ts` now owns the stream interrupt bridge (incoming interrupt routing + setter binding) and delegates protocol parsing/metadata finalization to `useSessionStreamContract.ts`.
- Do not reintroduce local interrupt ref-bridge + direct `useSessionStreamContract` wiring in `page.tsx`; consume through `useSessionStreamOrchestration.ts`.

P5.33 update:
- Chat initialization wiring ownership moved from `page.tsx` to new session owner `useSessionInitializationOrchestration.ts`.
- `useSessionInitializationOrchestration.ts` now owns grouped initialization dependency mapping into `useSessionChatInitialization.ts` (greeting/bootstrap/context/chat/retry refs).
- Do not reintroduce the large initialization parameter block in `page.tsx`; consume `isInitializingChat` via `useSessionInitializationOrchestration.ts`.

P5.34 update:
- Voice bridge/messages/UI-controls orchestration ownership moved from `page.tsx` to new session owner `useSessionVoiceOrchestration.ts`.
- `useSessionVoiceOrchestration.ts` now owns voice message appenders (`useSessionVoiceMessages.ts`), voice bridge wiring (`useSessionVoiceBridge.ts`), and voice UI controls (`useSessionVoiceUiControls.ts`), including default transcript/suppression binder setup.
- Keep command-routing ownership in `useSessionVoiceCommandSystem.ts`; do not reintroduce bridge/messages/controls setup blocks in `page.tsx`.

P5.35 update:
- Queue runtime + sync orchestration ownership moved from `page.tsx` to new session owner `useSessionQueueOrchestration.ts`.
- `useSessionQueueOrchestration.ts` now owns `useSessionQueueRuntime.ts` + `useSessionQueueSync.ts` composition and wiring (runtime getters bridged into sync execution).
- Do not reintroduce inline queue runtime/getter/sync wiring block in `page.tsx`; consume through `useSessionQueueOrchestration.ts`.

P5.36 update:
- Exit flow + exit protection orchestration ownership moved from `page.tsx` to new session owner `useSessionExitOrchestration.ts`.
- `useSessionExitOrchestration.ts` now composes `useSessionExitFlow.ts` + `useSessionExitProtection.ts`, including centralized `isExitInProgress` gate wiring.
- Do not reintroduce inline exit-flow/protection wiring blocks in `page.tsx`; consume through `useSessionExitOrchestration.ts`.

P5.37 update:
- Interaction action-cluster ownership moved from `page.tsx` to new session owner `useSessionInteractionOrchestration.ts`.
- `useSessionInteractionOrchestration.ts` now composes send/retry/cancelled-retry/UI-callback/memory-action seams (`useSessionSendActions.ts`, `useSessionRetryHandlers.ts`, `useSessionCancelledRetryVoiceReplay.ts`, `useSessionUiCallbacks.ts`, `useSessionMemoryActions.ts`).
- Do not reintroduce inline interaction wiring blocks in `page.tsx`; consume action handlers through `useSessionInteractionOrchestration.ts`.

P5.38 update:
- Restored context/message/reflection ownership boundaries in `page.tsx` using existing seams (`useSessionPageContext.ts`, `useSessionMessageViewModel.ts`, `useSessionReflectionVoiceFlow.ts`).
- `page.tsx` now consumes hook-owned `initialGreeting`/`greetingMessageId`/`greetingAnchorId`/`memoryHighlights`/`chatRequestBody`, hook-owned `latestAssistantMessage`, and `SESSION_REFLECTION_PREFIX` constant instead of local derivations.
- Do not reintroduce local greeting/request-body/session-lifecycle/memory-highlights/latest-assistant/reflection-prefix glue in `page.tsx`; keep these concerns in their existing owners.

P5.39 update:
- Artifacts/drawer render callback ownership was consolidated in existing seam `useSessionUiInteractions.ts`.
- `page.tsx` now consumes hook-owned handlers for artifacts panel close/open and mobile artifacts tab/drawer toggles (`handleCloseArtifactsPanel`, `handleOpenArtifactsPanel`, `handleToggleMobileArtifactsTab`, `handleToggleMobileDrawer`) instead of inline JSX lambdas.
- Do not reintroduce inline artifacts/drawer toggle lambdas in `page.tsx`; keep these UI interaction callbacks centralized in `useSessionUiInteractions.ts`.

P5.40 update:
- Companion rail visibility derivation ownership moved from `page.tsx` render condition to existing seam `useSessionUiDerivedState.ts` (`showCompanionRail`).
- `page.tsx` now consumes `showCompanionRail` from `useSessionUiDerivedState.ts` instead of computing `messages.length >= 2 && !isTyping && sessionContextMode` inline.
- Do not reintroduce inline companion visibility composite conditions in `page.tsx`; keep this UI derivation centralized in `useSessionUiDerivedState.ts`.

P5.41 update:
- Dev/debug effects ownership moved from `page.tsx` to existing orchestration owners:
	- stream protocol debug marker -> `useSessionStreamOrchestration.ts`
	- interrupt-card render-gating debug marker -> `useSessionInterruptOrchestration.ts`
- `page.tsx` now passes owner inputs (`debugEnabled`, `isTyping`) instead of hosting these effects locally.
- Do not reintroduce these debug effects in `page.tsx`; keep orchestration observability inside the corresponding owner hooks.

P5.42 update:
- Voice command binder ownership moved from `page.tsx` to existing seam `useSessionVoiceCommandSystem.ts`.
- `useSessionVoiceCommandSystem.ts` now supports binder callbacks (`setOnUserTranscriptHandler`, `setAssistantResponseSuppressedChecker`) and owns wiring `handleVoiceTranscript` + suppression checker to voice bridge binders.
- Do not reintroduce local binder `useEffect` in `page.tsx` for voice command handlers; keep this wiring inside `useSessionVoiceCommandSystem.ts`.

P5.43 update:
- Page-level residue cleanup in `page.tsx`: removed dead imports (`_detectErrorKind`, `useSessionSendActions`) and reused existing `navigateHome` callback for `useSessionPageGuards` redirect wiring.
- Do not reintroduce duplicate/unused imports or inline redirect lambdas where an existing page callback is already available.

P5.44 update:
- Stream-interrupt bridge ownership moved from `page.tsx` local `useEffect` to existing seam `useSessionInterruptOrchestration.ts`.
- `useSessionInterruptOrchestration.ts` now accepts optional `setStreamInterruptHandler` and owns binding `setInterrupt` into stream routing.
- Do not reintroduce local stream-interrupt binding effects in `page.tsx`; keep this bridge wiring inside `useSessionInterruptOrchestration.ts`.

P5.45 update:
- Home navigation ownership for page guards moved from `page.tsx` local callback to existing seam `useSessionPageGuards.ts`.
- `useSessionPageGuards.ts` now owns `navigateHome` derivation from `navigateTo` and exposes it for reuse in other orchestration consumers.
- `page.tsx` now consumes hook-owned `navigateHome` for both guard redirect and interaction orchestration wiring.
- Added focused guard test coverage: `src/__tests__/session/useSessionPageGuards.test.ts`.

## P5 closure decision (2026-03-03)

- Closure status: ✅ accepted.
- Rationale: no large unowned orchestration blocks remain in `src/app/session/page.tsx`; residual logic is primarily render composition and pass-through props.
- Validation baseline at close: `npm run type-check` and `npm run test:guardrails:p4` green.
- Freeze rule for this phase: avoid reopening `page.tsx` for broad extraction unless a new large local orchestration block is introduced by future feature work.

## Supporting utility modules (already extracted; keep as canonical)

- `artifacts.ts` -> consumed by `useSessionArtifactsReducer` (+ tests)
- `send-gate.ts` -> consumed by `useSessionSendActions` (+ tests)
- `refresh-interrupt-hint.ts` -> consumed by `useSessionChatInitialization` and `useSessionExitProtection`
- `useSessionCompanion.ts` -> consumed by `useSessionCompanionIntegration`

Rule: do not create a second adapter/helper for the same concern while these files already own it.

## Existing seam tests (coverage anchors)

Current tests already pin these session seams/contracts:

- `artifacts.ts`
- `send-gate.ts`
- `stream-contract-adapters.ts`
- `useSessionArtifactsReducer.ts`
- `useSessionInterruptRetryState.ts`
- `useSessionQueueRuntime.ts`
- `useSessionRetryHandlers.ts`
- `useSessionVoiceCommandSystem.ts`

Rule: if a P5 slice touches one of these seams, extend its existing test file first; do not create a duplicate test seam in another location.

## Residual logic still in page (candidate-only area for P5)

After P5.1, the above local UI-state cluster is owned by:
- `useSessionPageLocalState.ts`

Remaining safe candidate areas should target logic still embedded in page (not already represented by any existing `useSession*` module).

## Surgical rules for P5 execution

1. No new module if an existing `useSession*` module already owns that domain.
2. No second “adapter” file for stream/send/artifacts/interrupt concerns.
3. Prefer edits inside existing extracted module + its existing tests.
4. New file creation is allowed only for logic still local to `page.tsx` and not represented by existing session modules.
5. Before each P5 slice, verify this file and `docs/REFRACTOR_PROGRESSIVE_PLAN.md` to avoid overlap.

## Traceability note (2026-03-02)

- A temporary desynchronization reintroduced older inline orchestration blocks in `src/app/session/page.tsx`.
- `page.tsx` was re-aligned to the documented extraction baseline (P5.28–P5.37): infrastructure, validation state, chat runtime, interrupt orchestration, stream orchestration, initialization orchestration, voice orchestration, queue orchestration, exit orchestration, and interaction orchestration owners.
- Validation after re-alignment: `npm run type-check` and `npm run test:guardrails:p4` passed.
