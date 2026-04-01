# P3 Logging Inventory Snapshot (2026-03-02)

This is a frozen inventory snapshot taken at P3 closeout to avoid scope creep while preserving visibility.

## Snapshot command
- `grep_search` query: `console\.(log|warn|error|debug|info)`
- scope: `src/app/**`
- snapshot result count: `142` matches

## Post-closeout progress update (same day)
- Additional repository-wide hygiene batches were executed after the frozen snapshot.
- Latest recompute command remained the same (`grep_search` over `src/app/**`).
- Latest result count after the newest `components/**` + `stores/**` sweep: `80` matches.
- Interpretation: snapshot remains valid as historical baseline; current operational remainder is now mostly concentrated in `api/**`, `lib/**`, and explicitly intentional low-level debug utilities.

## Post-closeout progress update (api sweep)
- API-domain follow-up batch completed (`src/app/api/**`).
- Recompute over `src/app/**` now reports: `56` matches.
- Remaining concentration: mostly `lib/**`, selected voice debug paths, i18n fallback warnings, and wrapper internals/examples.

## Post-closeout progress update (lib + voice sweep)
- Follow-up batches completed for `lib/**`, `hooks/voice/**`, `copy/**`, and remaining docs/examples with executable logging replacements.
- Latest recompute over `src/app/**` reports: `6` matches.
- Current remainder is intentionally confined to `src/app/lib/debug-logger.ts` (the central debug wrapper implementation).

## Interpretation
- P3 objective was runtime-critical hygiene in selected session/voice paths, not full-repo eradication.
- Remaining `console.*` usage exists in other bounded areas (API routes, recap/pages/components, utility libraries, and intentional low-level debug wrappers).

## High-level remaining buckets
- API route diagnostics under `src/app/api/**`
- UI/page/component diagnostics under `src/app/components/**`, `src/app/**/page.tsx`
- Utility-layer diagnostics under `src/app/lib/**`
- Existing debug wrapper internals (`debug-logger`, `error-logger`) and explicit media diagnostics

## Guardrail outcome
- P3-governed files are protected via `npm run check:logs:p3`.
- This guardrail prevents regression in the P3-target runtime-critical files while allowing documented exceptions.

## Intentional exceptions
- See `docs/RUNTIME_LOGGING_EXCEPTIONS.md` for explicit allowed direct `console.*` cases.
