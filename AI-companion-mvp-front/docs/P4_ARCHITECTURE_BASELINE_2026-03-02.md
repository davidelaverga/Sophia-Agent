# P4 Architecture Baseline (2026-03-02)

This document captures the architecture baseline used to start P4.
All values below were measured from the current workspace state.

## Domain boundaries (src/app)
- `api`: 42 TS/TSX files
- `components`: 98 TS/TSX files
- `copy`: 10 TS/TSX files
- `hooks`: 42 TS/TSX files
- `lib`: 56 TS/TSX files
- `session`: 31 TS/TSX files
- `stores`: 22 TS/TSX files
- `types`: 8 TS/TSX files

## High-risk hotspots by file size
- `src/app/session/page.tsx`: 1312 lines
- `src/app/hooks/useVoiceLoop.ts`: 1036 lines
- `src/app/stores/chat-store.ts`: 753 lines
- `src/app/api/chat/_lib/stream-transformers.ts`: 543 lines
- `src/app/session/useSessionVoiceCommandSystem.ts`: 310 lines
- `src/app/api/chat/_lib/post-handler.ts`: 266 lines
- `src/app/session/useSessionRetryHandlers.ts`: 179 lines
- `src/app/api/chat/_lib/chat-request.ts`: 83 lines

## Operating thresholds (P4)
- Hard threshold: files above `900` lines are considered architectural hotspots and require extraction-first changes.
- Warning threshold: files between `500-900` lines require explicit scope notes in PR/checkpoint updates.
- Target threshold: new modules introduced during refactor should remain under `350` lines when practical.

## Extraction trigger policy
- If a touched hotspot (`>900`) receives non-trivial logic changes, extract one cohesive seam in the same slice.
- If a touched warning file (`500-900`) grows by more than ~`10%` in a slice, add follow-up extraction task in roadmap notes.
- If contracts are touched (stream/session adapters), guard tests must be added or extended in the same slice.

## Stability gates available at P4 kickoff
- `npm run check:logs:p3`
- `npm run check:logs:global`
- `npm run type-check`
- Focused suites already green in prior batch:
  - `vitest run src/__tests__/hooks/voice`
  - `vitest run stream-protocol stream-transformers chat-request`
  - `vitest run useSessionExtractedHooks useSessionRetryHandlers`

## P4.1 completion criteria (baseline slice)
- Baseline metrics documented (this file).
- No-regress checklist published and linked from plan/docs.
- Guardrail command for repeated P4 validation available in `package.json`.
