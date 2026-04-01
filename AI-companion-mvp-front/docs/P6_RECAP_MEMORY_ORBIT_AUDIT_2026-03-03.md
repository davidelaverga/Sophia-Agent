# P6 RecapMemoryOrbit Audit (2026-03-03)

Objective: perform an exhaustive audit of `src/app/components/recap/RecapMemoryOrbit.tsx`, define a concrete plan, and execute it end-to-end without UX regressions.

## Audit Scope

- File architecture and complexity concentration
- State ownership and side-effects
- Navigation and accessibility behavior
- Candidate derivation and decision flow consistency
- Regression safety based on existing recap smoke tests

## Findings (before P6.7)

1. **God-file concentration (high)**
   - `RecapMemoryOrbit.tsx` combined cinematic UI rendering + candidate derivation + navigation/controller logic + animation timing side-effects in a single ~1200-line file.

2. **Derived-state coupling (medium)**
   - `normalizedCandidates`, `activeCandidates`, `processedCandidates`, `approvedCount`, safe index, and visible candidate windows were computed inline, increasing cognitive load and duplication risk.

3. **Interaction controller density (high)**
   - Keyboard listeners, focused-index bounds enforcement, circular navigation, keep/discard animation timers, and haptic side effects lived in the page component body.

4. **Timer cleanup risk (medium)**
   - Keep/discard animation delays used raw `setTimeout` without a centralized timeout lifecycle owner, raising stale timeout/unmount risk.

5. **Behavioral contract risk (medium)**
   - Core decisions and orbit motion were correct, but coupling made future edits more likely to regress keyboard/animation behavior.

## Plan Executed (P6.7)

1. Extract orbit candidate derivation and visible-window computation into pure utilities.
2. Extract interaction/navigation/timer ownership into a dedicated controller hook with timeout cleanup.
3. Rewire `RecapMemoryOrbit` to consume extracted modules while preserving props, ARIA, copy, visual styles, and motion behavior.
4. Validate with recap-targeted smoke tests + project type-check.

## Implementation Delivered

### New utility module
- `src/app/components/recap/RecapMemoryOrbitUtils.ts`
  - `normalizeOrbitCandidates`
  - `getOrbitCandidateBuckets`
  - `getSafeFocusedIndex`
  - `getVisibleOrbitCandidates`

### New controller hook
- `src/app/components/recap/useRecapMemoryOrbitController.ts`
  - Owns:
    - focused index state
    - exiting id / exit animation state
    - circular navigation (`navigatePrev`/`navigateNext`)
    - keyboard arrow handling
    - keep/discard handlers with animation-timed decision dispatch
    - timeout lifecycle cleanup on unmount

### Main component rewired
- `src/app/components/recap/RecapMemoryOrbit.tsx`
  - Replaced inline derivation/controller blocks with extracted module consumption.
  - Preserved UI structure and existing action flows.

## Validation Results

- `npm run type-check` ✅
- `npx vitest run src/__tests__/recap/memory-candidates-v2.smoke.test.tsx` ✅ (3/3)

## Post-Audit Status

- `RecapMemoryOrbit.tsx` now operates as composition + render orchestration rather than owning all domain logic.
- Candidate and controller behavior are separated into reusable/test-friendly seams.
- No UX changes were introduced in this audit slice.

## Follow-up Slice (P6.8)

To continue the audit plan and reduce remaining god-file density, the visual layer was extracted as a dedicated slice:

- Added `src/app/components/recap/RecapMemoryOrbitVisuals.tsx`
   - `CosmicBackground`
   - `KeyTakeaway`
   - `ReflectionPrompt`
   - `RecapOrbitLoading`
   - `RecapOrbitEmpty`
   - `RecapOrbitCompleted`
- Rewired `src/app/components/recap/RecapMemoryOrbit.tsx` to consume these visual components.

Validation after P6.8:

- `npm run type-check` ✅
- `npx vitest run src/__tests__/recap/memory-candidates-v2.smoke.test.tsx` ✅ (3/3)
- `npm run test:guardrails:p4` ✅

## Follow-up Slice (P6.9)

To continue reducing orbit-file density while preserving UX, the largest remaining leaf render/action block was extracted:

- Added `src/app/components/recap/RecapMemoryOrbitBubble.tsx`
   - `CosmicMemoryBubble` (visual rendering, keep/discard actions, side-bubble navigation affordance, a11y labels)
- Rewired `src/app/components/recap/RecapMemoryOrbit.tsx` to consume extracted bubble component.

Validation after P6.9:

- `npm run type-check` ✅
- `npx vitest run src/__tests__/recap/memory-candidates-v2.smoke.test.tsx` ✅ (3/3)
- `npm run test:guardrails:p4` ✅

## Follow-up Slice (P6.10)

To keep reducing composition density in `RecapMemoryOrbit.tsx`, orbit navigation/pagination controls were extracted:

- Added `src/app/components/recap/RecapMemoryOrbitNavigation.tsx`
   - Previous/next arrows
   - Pagination indicator tabs
   - Selection callbacks with preserved ARIA labels/roles
- Rewired `src/app/components/recap/RecapMemoryOrbit.tsx` to consume the navigation component while preserving existing haptic-triggered selection behavior.

Validation after P6.10:

- `npm run type-check` ✅
- `npx vitest run src/__tests__/recap/memory-candidates-v2.smoke.test.tsx` ✅ (3/3)
- `npm run test:guardrails:p4` ✅

## Follow-up Slice (P6.11)

A final micro-slice extracted the remaining interaction glue and SR announcements from `RecapMemoryOrbit.tsx`:

- Added `src/app/components/recap/useRecapMemoryOrbitSelection.ts`
   - index selection callback
   - side-candidate selection callback with haptic + id lookup
- Added `src/app/components/recap/RecapMemoryOrbitAnnouncements.tsx`
   - live-region announcement rendering for focused memory and keep/discard outcomes
- Rewired `src/app/components/recap/RecapMemoryOrbit.tsx` to consume both.

Validation after P6.11:

- `npm run type-check` ✅
- `npx vitest run src/__tests__/recap/memory-candidates-v2.smoke.test.tsx` ✅ (3/3)
- `npm run test:guardrails:p4` ✅

## Closure Decision (P6.12)

After P6.11, remaining inline code in `RecapMemoryOrbit.tsx` is primarily composition glue and does not justify additional micro-extraction.

- Decision: **freeze Orbit de-godification at current boundaries**.
- Reopen criterion: only if new behavior introduces a clear ownership seam (not stylistic splitting).
- Final status: architecture is now partitioned with stable behavior and green validation.

## Next Domain Follow-up (P6.13)

After Orbit freeze, recap refactor continued in `src/app/recap/[sessionId]/page.tsx` to reduce repeated chrome rendering density:

- Added `src/app/recap/[sessionId]/RecapPageChrome.tsx`
   - `RecapPageFloatingHeader`
   - `RecapBottomActionBar`
   - `RecapSaveSuccessOverlay`
- Rewired recap page to consume the extracted chrome components.

Validation after P6.13:

- `npm run type-check` ✅
- `npx vitest run src/__tests__/recap/memory-candidates-v2.smoke.test.tsx` ✅ (3/3)
- `npm run test:guardrails:p4` ✅

## Next Domain Follow-up (P6.14)

Recap page side-effect ownership was then extracted to reduce page-level orchestration density:

- Added `src/app/recap/[sessionId]/useRecapArtifactsLoader.ts`
   - load/status lifecycle for artifacts fetch + mapping + dev fallback
- Added `src/app/recap/[sessionId]/useRecapMemoryActions.ts`
   - discard/decision/save flows, retry/error/success states
- Rewired `src/app/recap/[sessionId]/page.tsx` to consume both hooks.

Validation after P6.14:

- `npm run type-check` ✅
- `npx vitest run src/__tests__/recap/memory-candidates-v2.smoke.test.tsx` ✅ (3/3)
- `npm run test:guardrails:p4` ✅
