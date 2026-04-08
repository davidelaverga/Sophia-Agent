---
title: feat: Add frontend-only Sophia memory candidate review surface
type: feat
status: active
date: 2026-03-29
origin: 02_build_plan (new).md
---

# feat: Add frontend-only Sophia memory candidate review surface

## Overview

Add a minimal Sophia-specific memory candidate review surface to the existing workspace settings dialog so Luis can complete the Week 1 Day 5 slice without waiting for the full Journal or the real Sophia gateway router.

The slice should list `pending_review` memory candidates, render fixed category badges for the nine Sophia memory types, support inline edit, and preserve a safe delete flow, while staying compatible with the future `/api/sophia/...` contract through a frontend-owned mock route fallback.

## Problem Frame

The Week 1 build plan describes memory candidate cards as an existing surface and asks for edit mode plus category badges. The current repo does not expose Sophia-specific memory candidate UI or `/api/sophia` gateway code; instead it has a generic DeerFlow memory settings page that renders global memory markdown from `GET /api/memory`, plus reusable CRUD patterns elsewhere in the frontend.

Waiting for the full Sophia backend would unnecessarily stall Luis. Building a one-off review UI disconnected from the intended Sophia memory contract would create throwaway integration work. This plan keeps the slice honest: define the frontend contract boundary, let Luis advance against a mock-compatible surface, and land the UI inside the current settings dialog instead of expanding to the full Journal prematurely.

## Requirements Trace

- R1. Surface pending Sophia memory candidates from the documented `pending_review` flow.
- R2. Add edit mode to each memory candidate card.
- R3. Add category badges mapped to the fixed Sophia nine-category taxonomy.
- R4. Preserve a safe delete flow for candidate dismissal.
- R5. Keep Mem0 and the offline pipeline as the single memory authority; the UI only reviews or updates candidate records.
- R6. Allow frontend progress while the real Sophia router is still pending by using one frontend-owned contract shape that can later point at the live backend.
- R7. Keep scope bounded to the Week 1 review slice; do not expand to the Week 3 Journal, timeline, reflect flow, or notification deep links.
- R8. Make loading, empty, save, delete, validation, and stale-item failure states explicit enough to be testable.

## Scope Boundaries

- No full Sophia Journal page or Insights/Timeline tabs.
- No bulk review flow or auto-promotion countdown in this slice.
- No offline pipeline changes, Mem0 extraction changes, or memory-authority changes.
- No push notification UI or deep linking to a future Journal screen.
- No `/api/sophia` router implementation in this slice.
- No custom frontend test harness introduction beyond the repo's current Node-based test pattern unless proven necessary.

## Context & Research

### Source Inputs

- No relevant `docs/brainstorms/*-requirements.md` file exists for this slice.
- Planning input comes from the user request, `02_build_plan (new).md`, `docs/specs/05_frontend_ux.md`, `docs/specs/03_memory_system.md`, and `CLAUDE.md`.

### Relevant Code and Patterns

- `frontend/src/components/workspace/settings/memory-settings-page.tsx` currently renders generic DeerFlow memory as markdown via `GET /api/memory`; it is the natural Week 1 insertion point for a lightweight Sophia review surface.
- `frontend/src/components/workspace/settings/settings-dialog.tsx` already mounts the `memory` section inside the workspace settings dialog, so no new top-level route is needed for this slice.
- `frontend/src/core/memory/api.ts`, `frontend/src/core/memory/hooks.ts`, and `frontend/src/core/memory/types.ts` show the existing pattern for a small domain API wrapper under `core/`.
- `frontend/src/core/uploads/api.ts` and `frontend/src/core/uploads/hooks.ts` show the preferred fetch plus React Query invalidation pattern for simple CRUD mutations.
- `frontend/src/components/workspace/agents/agent-card.tsx` shows the current destructive-action pattern: card UI, confirm dialog, mutation hook, and toast feedback.
- `frontend/src/components/workspace/recent-chat-list.tsx` shows inline rename state and dropdown-based list actions that can inform candidate card edit and delete controls.
- `frontend/src/app/mock/api/...` and `frontend/src/core/config/index.ts` confirm the repo already supports mock API routes; this is the right unblocking path while the real Sophia router is pending.
- `frontend/src/core/api/stream-mode.test.ts` confirms there is an existing Node `node:test` pattern even though the frontend does not have a full component test harness.

### Institutional Learnings

- The repo currently exposes spec-level Sophia memory-review contracts, but not code-confirmed `/api/sophia` or Journal UI surfaces.
- The current `memory` settings tab is generic and read-only; this feature is new in code even if it is described as "existing" in the build plan.
- Mock-compatible development is already a first-class pattern in the frontend and should be used to keep Luis unblocked.

### External Research

- External research is intentionally skipped. The relevant work is repo-shaped: existing React Query CRUD patterns, a known settings dialog insertion point, and Sophia-specific API and UX constraints are already documented locally.

## Key Technical Decisions

- Implement the Week 1 memory-candidate review surface inside the existing `memory` section of the workspace settings dialog.
  Rationale: the repo already has a mounted `memory` section, and the full Journal belongs to Week 3. Reusing the current surface avoids route churn and keeps scope bounded.

- Introduce a new Sophia-specific domain module under `frontend/src/core/sophia/` rather than overloading the existing generic `core/memory/` module.
  Rationale: the current `core/memory/` module is tied to DeerFlow's global memory shape. Sophia memory candidates, Journal, visual artifacts, and reflect endpoints will form a separate API family.

- Define one shared contract shape in the frontend domain layer and implement it first against mock routes only.
  Rationale: Luis should be able to build against stable response and mutation types now, then repoint the same client module to the live backend later without rewriting UI logic.

- Treat category as editable in Week 1 edit mode, not badge-only display.
  Rationale: the UX spec explicitly calls for an edit form with a text field plus category dropdown, and the API example already includes `metadata.category` updates.

- Use the fixed nine-category taxonomy as a typed enum and a single badge-style map.
  Rationale: this prevents drift between badge rendering, dropdown options, and backend validation, and it keeps category colors centralized.

- Use server-authoritative mutations with React Query invalidation, not optimistic edit state.
  Rationale: the repo's simple CRUD hooks already prefer invalidate-on-success patterns. Optimistic edits add little value here and complicate stale-item handling. Delete may remove the item from the rendered list only after a successful server response.

- Require confirm-before-delete in the UI.
  Rationale: the repo already uses confirm dialogs for destructive card actions, and candidate deletion is materially destructive in a review workflow.

- Provide mock API routes for the full Week 1 contract and treat the live Sophia router as an external dependency, not part of this slice.
  Rationale: this keeps Luis moving while Jorge lands the live router and avoids frontend churn and scope bleed.

## Open Questions

### Resolved During Planning

- Should this wait for the full Sophia Journal? No. The Week 1 slice should ship inside the existing settings dialog.
- Should category be editable? Yes. Use the spec's text plus category edit shape.
- Should this rely on optimistic updates? No. Use server-authoritative saves and invalidate queries after success.
- Should Luis block on Jorge? No. Use mock routes with the same contract shape until the live router exists.

### Deferred to Implementation

- Whether the candidate list appears above or instead of the current generic memory markdown can be finalized during implementation, as long as the Sophia review surface is discoverable in the `memory` settings section.
- Whether the generic DeerFlow memory markdown remains visible behind a collapsible subsection can be decided during implementation cleanup.
- Exact copy and i18n labels for the nine category names can be finalized during implementation, as long as the enum values remain canonical.

## High-Level Technical Design

```mermaid
sequenceDiagram
    participant User as User
    participant Settings as Memory Settings UI
    participant Core as frontend/src/core/sophia
    participant Mock as frontend mock API
    participant Contract as future /api/sophia contract

    User->>Settings: Open Settings > Memory
    Settings->>Core: useSophiaMemoryCandidates(userId)

    alt Mock path
        Core->>Mock: GET /mock/api/sophia/{user_id}/memories/recent?status=pending_review
        Mock-->>Core: candidate list
    note over Contract: Live backend is out of scope for this plan

    Core-->>Settings: typed candidate records
    User->>Settings: Edit or delete candidate
    Settings->>Core: PUT or DELETE mutation
    Core->>Mock: mirrored contract during frontend-first development
    Core-->>Settings: invalidate and refetch updated list
```

## Implementation Units

- [ ] **Unit 1: Create the Sophia memory candidate data contract and mock-compatible frontend domain layer**

**Goal:** Give the frontend a stable Week 1 contract for candidate list, edit, and delete without depending on the real router landing in parallel.

**Requirements:** R1, R2, R3, R4, R6, R8

**Dependencies:** None

**Files:**
- Create: `frontend/src/core/sophia/api.ts`
- Create: `frontend/src/core/sophia/hooks.ts`
- Create: `frontend/src/core/sophia/types.ts`
- Create: `frontend/src/core/sophia/category-badges.ts`
- Create: `frontend/src/core/sophia/index.ts`
- Create: `frontend/src/core/sophia/api.test.ts`
- Create: `frontend/src/core/sophia/category-badges.test.ts`
- Create: `frontend/src/app/mock/api/sophia/[user_id]/memories/recent/route.ts`
- Create: `frontend/src/app/mock/api/sophia/[user_id]/memories/[memory_id]/route.ts`

**Approach:**
- Define `SophiaMemoryCategory`, `SophiaMemoryCandidate`, list response, update payload, and delete response types.
- Add fetch and mutation helpers using the backend base URL and matching the documented `GET`, `PUT`, and `DELETE` Sophia memory endpoints.
- Add mock routes returning representative `pending_review` data and handling `PUT` and `DELETE` with the same payload shapes the live router will use.
- Centralize category label and color mapping in `category-badges.ts` so display and edit surfaces share one source of truth.

**Patterns to follow:**
- `frontend/src/core/uploads/api.ts`
- `frontend/src/core/uploads/hooks.ts`
- `frontend/src/app/mock/api/...`

**Test scenarios:**
- Happy path: list loading from the mock base path returns typed pending candidates.
- Happy path: `PUT` accepts text plus `metadata.category` payload and returns the updated candidate.
- Edge case: unknown category maps to a neutral fallback style and is rejected on mutation payload construction.
- Error path: failed list fetch surfaces a descriptive error message.
- Error path: failed `PUT` or `DELETE` propagates detail text from the response.

**Verification:**
- The frontend can fetch candidates against mock routes without touching the live backend.
- The category enum and badge map stay in sync across display and edit options.

- [ ] **Unit 2: Build the settings-based memory candidate cards with badges and inline edit flow**

**Goal:** Replace the current read-only memory-only experience in the `memory` settings section with a Week 1 review surface for Sophia candidates.

**Requirements:** R1, R2, R3, R4, R7, R8

**Dependencies:** Unit 1

**Files:**
- Create: `frontend/src/components/workspace/settings/sophia-memory-candidates-section.tsx`
- Create: `frontend/src/components/workspace/settings/sophia-memory-candidate-card.tsx`
- Create: `frontend/src/components/workspace/settings/sophia-memory-candidate-form.tsx`
- Modify: `frontend/src/components/workspace/settings/memory-settings-page.tsx`
- Modify: `frontend/src/core/i18n/locales/en-US.ts`
- Modify: `frontend/src/core/i18n/locales/zh-CN.ts`
- Modify: `frontend/src/core/i18n/locales/types.ts`

**Approach:**
- Render a candidate list at the top of the memory settings page with explicit loading, empty, and error states.
- Build card UI using the existing `Card`, `Badge`, `Button`, `Dialog`, `Input`, and `Select` primitives.
- Show category badge, candidate content, and enough metadata to help review without turning the card into a full Journal entry.
- Edit toggles the card into an inline form or expanded editor with textarea plus category dropdown; save and cancel remain card-local.
- Delete uses a confirm dialog and, on success, removes the card after query invalidation.
- Keep the generic memory markdown below a secondary divider or collapsible only if it remains useful; do not let it dominate the Week 1 review surface.

**Patterns to follow:**
- `frontend/src/components/workspace/agents/agent-card.tsx`
- `frontend/src/components/workspace/recent-chat-list.tsx`
- `frontend/src/components/workspace/settings/memory-settings-page.tsx`

**Test scenarios:**
- Happy path: list renders multiple candidates with correct badges for all nine categories.
- Happy path: edit mode updates text and category and exits cleanly after save.
- Happy path: delete removes a candidate after confirmation and refetch.
- Edge case: deleting the last remaining candidate transitions to the empty state.
- Edge case: canceling edit restores original card content with no partial draft rendered.
- Error path: save failure leaves the card in edit mode and shows inline or toast error feedback.
- Error path: delete failure closes neither the whole settings dialog nor corrupts the list state.

**Verification:**
- A user can open `Settings > Memory` and complete keep, edit, and delete review without leaving the dialog.
- The card UI respects current repo design patterns and does not introduce a parallel navigation surface.

## System-Wide Impact

- **Interaction surface:** the existing settings dialog gains a new Sophia-specific review surface in the memory section; no new Week 1 route is required.
- **Data contract:** the frontend defines a stable Sophia candidate contract and implements it against mock routes first, without disturbing the existing generic `/api/memory` endpoint.
- **State management:** React Query becomes the single frontend source of truth for candidate lists and card mutations; no local parallel memory store is introduced.
- **Mock/live parity:** mock API routes mirror the intended live contract to keep frontend development unblocked.
- **Unchanged invariants:** Mem0 remains the single memory authority, writes stay in the offline pipeline, and Week 3 Journal and notification flows remain separate.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| The build plan assumes "existing" candidate UI, but the repo only has spec-level Sophia guidance. | Treat the feature as a new Week 1 Sophia surface and reuse existing settings and CRUD patterns instead of searching for nonexistent components. |
| Luis gets blocked by the live Sophia router not landing in time. | Freeze the contract in `frontend/src/core/sophia/types.ts` and build against mock routes first. |
| Badge colors or enum values drift between mock data, UI, and the later live backend. | Centralize the category enum and badge map in one frontend module and use that same type contract for mock responses and future live integration. |
| Edit flow becomes too broad and spills into Journal scope. | Keep the surface inside `Settings > Memory` and defer bulk review, timeline, countdown, and deep links. |
| No full frontend component test harness exists. | Add Node-based tests for pure domain logic and rely on manual UI verification plus `pnpm lint` and `pnpm typecheck` for the component slice. |

## Documentation / Operational Notes

- Update the Week 1 and UX-facing docs only if implementation intentionally narrows or rephrases the current spec for edit and delete behavior.
- Document the mock/live contract handoff clearly so frontend work does not hardcode mock-only assumptions.
- Keep category labels and badge colors aligned with `docs/specs/05_frontend_ux.md` and the fixed taxonomy in `CLAUDE.md`.

## Sources & References

- **Origin document:** `02_build_plan (new).md`
- Related UX spec: `docs/specs/05_frontend_ux.md`
- Related memory spec: `docs/specs/03_memory_system.md`
- Related backend spec: `docs/specs/04_backend_integration.md`
- Repo constraints: `CLAUDE.md`
- Existing frontend surfaces: `frontend/src/components/workspace/settings/memory-settings-page.tsx`
- Existing frontend surfaces: `frontend/src/components/workspace/settings/settings-dialog.tsx`
- Existing frontend domain pattern: `frontend/src/core/memory/api.ts`
- Existing frontend domain pattern: `frontend/src/core/memory/hooks.ts`
- Existing frontend CRUD pattern: `frontend/src/core/uploads/api.ts`
- Existing frontend CRUD pattern: `frontend/src/core/uploads/hooks.ts`
- Existing frontend destructive-action pattern: `frontend/src/components/workspace/agents/agent-card.tsx`
- Existing frontend inline-action pattern: `frontend/src/components/workspace/recent-chat-list.tsx`
- Future live contract reference: `CLAUDE.md`