# Runtime Logging Exceptions (P3.4)

This document defines the explicit, allowed direct `console.*` usage that remains after P3 logging hygiene.

## Rule
- Runtime-critical app flows should use centralized logging wrappers (`logger`, `debugLog`, `debugWarn`, `debugInfo`) instead of direct `console.*`.
- Direct `console.*` is allowed only for low-level browser/media debugging where wrappers add no practical value.

## Allowed Exceptions
- `src/app/lib/debug-logger.ts`
  - Purpose: thin debug wrapper implementation; internally calls `console.*` by design.

## Notes
- These exceptions are intentional and should remain minimal.
- Any new direct `console.*` in runtime-critical hooks/stores/session paths requires explicit justification and documentation in this file.

## Guardrail Scope (P3)
- `npm run check:logs:p3` enforces no unapproved `console.*` usage in P3-governed runtime-critical files:
  - `src/app/hooks/voice/useVoiceWebSocket.ts`
  - `src/app/hooks/useVoiceLoop.ts`
  - `src/app/session/useSessionMemoryActions.ts`
  - `src/app/session/useSessionExitFlow.ts`
  - `src/app/session/useSessionExitProtection.ts`
  - `src/app/session/useSessionRetryHandlers.ts`
  - `src/app/session/useSessionVoiceCommandSystem.ts`
  - `src/app/hooks/voice/useAudioPlayback.ts` (only documented debug-level exceptions allowed)

## Guardrail Scope (Global)
- `npm run check:logs:global` enforces no direct `console.*` usage across `src/app/**`, except explicit allowlist entries.
- Current allowlist:
  - `src/app/lib/debug-logger.ts` (wrapper implementation by design)

## Inventory Snapshot
- Remaining whole-repo `console.*` inventory is tracked in `docs/P3_LOGGING_INVENTORY_2026-03-02.md`.
- Current effective remainder after repo-wide continuation: wrapper-only (`src/app/lib/debug-logger.ts`).
