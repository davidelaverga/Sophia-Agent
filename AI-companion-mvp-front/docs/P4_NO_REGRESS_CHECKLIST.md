# P4 No-Regress Checklist

Use this checklist before merging any P4 refactor slice.

## Scope discipline
- [ ] Slice is architecture/stability only (no UX change).
- [ ] Public contracts and payload shapes are unchanged, unless explicitly planned.
- [ ] Any intentional exception is documented in `docs/RUNTIME_LOGGING_EXCEPTIONS.md`.
- [ ] Hotspot policy checked against `docs/P4_ARCHITECTURE_BASELINE_2026-03-02.md` thresholds.

## Required verification
- [ ] `npm run check:logs:global`
- [ ] `npm run type-check`

## Targeted verification (run what matches touched areas)
- [ ] Stream/chat seams: `npm run test -- stream-protocol stream-transformers chat-request`
- [ ] Voice seams: `npm run test -- src/__tests__/hooks/voice`
- [ ] Session extracted seams: `npm run test -- useSessionExtractedHooks useSessionRetryHandlers useSessionVoiceCommandSystem`

## Documentation updates
- [ ] Update `docs/REFRACTOR_PROGRESSIVE_PLAN.md` checkpoint for the completed slice.
- [ ] If boundaries/sizes moved materially, update `docs/P4_ARCHITECTURE_BASELINE_2026-03-02.md`.
- [ ] If the slice closes a stability milestone, update `docs/P4_STABILITY_SIGNOFF_2026-03-02.md`.

## One-command gate
- [ ] Optional aggregate run: `npm run test:guardrails:p4`
