# MVP Frontend Surface Boundary

This repository contains two frontend applications with different responsibilities.

## Canonical Sophia Surface

`AI-companion-mvp-front/` is the only Sophia companion product surface.

All Sophia-specific product work belongs there, including:

- conversation runtime ownership
- session and chat route shells
- onboarding voice-over
- memory recap and review UX
- companion atmosphere, ritual UX, and reflection flows

## Non-MVP Frontend Boundary

`frontend/` is the general DeerFlow frontend and must not regain Sophia-specific product surfaces.

Disallowed examples under `frontend/`:

- `src/core/sophia/`
- `src/app/mock/api/sophia/`
- Sophia-specific settings pages, recap/review flows, or memory-moderation UI
- route-local copies of the Sophia conversation runtime

## Ownership Rules

1. If the feature is Sophia-specific, build it in `AI-companion-mvp-front/`.
2. If the feature is general DeerFlow workspace functionality, build it in `frontend/`.
3. Do not mirror Sophia features into `frontend/` for convenience or temporary testing.
4. Keep the live conversation runtime under `AI-companion-mvp-front/src/app/companion-runtime/`.

## Guardrails

The repository guardrail script `scripts/check-sophia-surface-boundary.js` enforces the most important boundary rules:

- removed top-level frontend Sophia paths stay absent
- deleted route-local runtime owners do not reappear
- route shells stay thin and keep runtime ownership in the canonical MVP runtime namespace

Run from the MVP app:

- `npm run check:sophia:surface-boundary`

This boundary exists to keep cleanup durable. New Sophia work should reduce ownership ambiguity, not recreate it in a second frontend surface.