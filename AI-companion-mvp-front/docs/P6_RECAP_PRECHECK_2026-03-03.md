# P6 Recap Precheck (2026-03-03)

Objective: start recap-domain de-godification safely after P5 closure, preserving UX and existing recap contracts.

## Target domain

Primary file for incremental slices:
- `src/app/components/recap/RecapComponents.tsx`

Supporting recap files in scope:
- `src/app/components/recap/RecapMemoryOrbit.tsx`
- `src/app/history/page.tsx` (only if recap rendering orchestration requires it)

## Ownership baseline (after P6.14)

- `RecapMemoryCandidateRow` ownership:
  - `src/app/components/recap/RecapMemoryCandidateRow.tsx`
- `RecapEmptyState` variants ownership:
  - `src/app/components/recap/RecapEmptyStateViews.tsx`
- `MemoryCandidatesFooter` ownership:
  - `src/app/components/recap/RecapMemoryCandidatesFooter.tsx`
- `MemoryCandidatesIntro` ownership:
  - `src/app/components/recap/RecapMemoryCandidatesFooter.tsx` (co-located)
- `MemoryCandidatesPanel` loading/no-data state ownership:
  - `src/app/components/recap/RecapMemoryCandidatesFooter.tsx` (co-located)
- `TakeawayCard` and `ReflectionCard` ownership:
  - `src/app/components/recap/RecapInsightCards.tsx`
- `RecapMemoryOrbit` derivation ownership:
  - `src/app/components/recap/RecapMemoryOrbitUtils.ts`
- `RecapMemoryOrbit` interaction/controller ownership:
  - `src/app/components/recap/useRecapMemoryOrbitController.ts`
- `RecapMemoryOrbit` visual/state ownership:
  - `src/app/components/recap/RecapMemoryOrbitVisuals.tsx`
- `RecapMemoryOrbit` bubble/render-surface ownership:
  - `src/app/components/recap/RecapMemoryOrbitBubble.tsx`
- `RecapMemoryOrbit` navigation/pagination ownership:
  - `src/app/components/recap/RecapMemoryOrbitNavigation.tsx`
- `RecapMemoryOrbit` selection glue ownership:
  - `src/app/components/recap/useRecapMemoryOrbitSelection.ts`
- `RecapMemoryOrbit` screen-reader announcement ownership:
  - `src/app/components/recap/RecapMemoryOrbitAnnouncements.tsx`
- `Recap page chrome ownership` (header/actions/success overlay):
  - `src/app/recap/[sessionId]/RecapPageChrome.tsx`
- `Recap page artifacts loading ownership`:
  - `src/app/recap/[sessionId]/useRecapArtifactsLoader.ts`
- `Recap page memory action side-effects ownership`:
  - `src/app/recap/[sessionId]/useRecapMemoryActions.ts`
- `MemoryCandidatesPanel` composition ownership:
  - `src/app/components/recap/RecapComponents.tsx`

Rule: do not re-inline `RecapMemoryCandidateRow` into `RecapComponents.tsx`.
Rule: do not re-inline recap empty-state variant branches into `RecapComponents.tsx`.
Rule: do not re-inline memory candidates footer/actions block into `RecapComponents.tsx`.
Rule: do not re-inline memory candidates intro/header block into `RecapComponents.tsx`.
Rule: do not re-inline memory candidates loading/no-data branches into `RecapComponents.tsx`.
Rule: do not re-inline `TakeawayCard`/`ReflectionCard` into `RecapComponents.tsx`.
Rule: do not re-inline orbit candidate derivation/controller logic into `RecapMemoryOrbit.tsx`.
Rule: do not re-inline orbit visual/state render blocks into `RecapMemoryOrbit.tsx`.
Rule: do not re-inline orbit bubble render/action block into `RecapMemoryOrbit.tsx`.
Rule: do not re-inline orbit navigation/pagination block into `RecapMemoryOrbit.tsx`.
Rule: do not re-inline orbit selection and SR-announcement glue into `RecapMemoryOrbit.tsx`.
Rule: do not re-inline recap page chrome blocks into `src/app/recap/[sessionId]/page.tsx`.
Rule: do not re-inline recap page loading and memory-action side-effect blocks into `src/app/recap/[sessionId]/page.tsx`.

## Session checkpoints

- ✅ P6.1 complete: extracted memory row item into `RecapMemoryCandidateRow` with behavior parity.
- ✅ P6.2 complete: extracted recap empty-state variants into `RecapEmptyStateViews` and rewired panel branches.
- ✅ P6.3 complete: extracted `MemoryCandidatesPanel` footer/actions into `RecapMemoryCandidatesFooter` and rewired panel composition.
- ✅ P6.4 complete: extracted `MemoryCandidatesPanel` intro/header block into `RecapMemoryCandidatesIntro` and rewired panel composition.
- ✅ P6.5 complete: extracted `MemoryCandidatesPanel` loading/no-data branches into `RecapMemoryCandidatesStates` and rewired panel composition.
- ✅ P6.6 complete: extracted `TakeawayCard` and `ReflectionCard` into `RecapInsightCards` and rewired `RecapComponents` exports.
- ✅ P6.7 complete: audited `RecapMemoryOrbit` and extracted candidate derivation/controller logic into `RecapMemoryOrbitUtils` + `useRecapMemoryOrbitController`.
- ✅ P6.8 complete: extracted orbit visual/state blocks into `RecapMemoryOrbitVisuals` and rewired `RecapMemoryOrbit` composition.
- ✅ P6.9 complete: extracted `CosmicMemoryBubble` into `RecapMemoryOrbitBubble` and rewired orbit composition.
- ✅ P6.10 complete: extracted orbit navigation/pagination controls into `RecapMemoryOrbitNavigation` and rewired orbit composition.
- ✅ P6.11 complete: extracted orbit selection callbacks and SR announcements into dedicated hook/component and rewired orbit composition.
- ✅ P6.12 closeout: orbit de-godification freeze applied (no further micro-splits unless new behavioral ownership appears).
- ✅ P6.13 complete: extracted recap page floating header, bottom action bar, and success overlay into `RecapPageChrome`.
- ✅ P6.14 complete: extracted recap page artifacts-loader and memory-action side-effects into dedicated hooks.

## P6 execution rules

1. No UX changes unless explicitly requested.
2. Keep recap visual hierarchy and copy intact.
3. Prefer extracting dense internal components/helpers before introducing new abstractions.
4. Keep prop contracts stable at recap component boundaries.
5. Validate every slice with:
   - `npm run type-check`
   - `npm run test:guardrails:p4`

## Candidate next slices

- Orbit de-godification is frozen after P6.12; only reopen if new behavior introduces a clear ownership seam.
- Evaluate recap page composition closure (freeze condition) and only continue extraction if a new high-value ownership boundary appears.
- Introduce recap-focused tests only if adjacent test seams already exist or a new component boundary is created.
