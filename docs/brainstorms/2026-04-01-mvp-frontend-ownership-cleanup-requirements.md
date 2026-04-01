---
date: 2026-04-01
topic: mvp-frontend-ownership-cleanup
---

# MVP Frontend Ownership Cleanup

## Problem Frame

The Sophia MVP frontend has strong cleanup intent on paper but still carries multiple competing conversation owners in code. Large owners such as `ConversationView` and `useStreamVoiceSession` still coordinate broad runtime behavior, Stream/WebRTC voice flow remains split across overlapping hooks, and the repo still contains companion-adjacent chat surfaces outside the MVP app. Recent extraction work reduced some file-size pressure, but much of the complexity was redistributed into orchestration hooks rather than removed.

This makes the system harder to extend safely. New conversation work still has to choose between `/session`, `/chat`, voice session hooks, and parallel chat surfaces elsewhere in the repo. That increases regression risk, weakens the ownership rules already documented in the MVP frontend docs, and turns "cleanup" into local reshuffling instead of simplification.

## Requirements

**Canonical Ownership**
- R1. The MVP frontend must define one canonical conversation owner for Sophia's runtime state, streaming lifecycle, and transcript orchestration.
- R2. Ritual session and ritual-less chat may remain separate entry experiences during migration, but they must not continue as separate full-stack owners of conversation orchestration.
- R3. Voice session lifecycle, Stream/WebRTC join flow, transcript delivery, and artifact application must have one clear owner within the MVP frontend.
- R4. Any route that survives outside the canonical owner must become a thin shell, redirect, or compatibility layer with no independent business logic.
- R5. Existing `/session` and `/chat` URLs, bookmarks, and in-app navigation must continue to resolve correctly throughout the staged cleanup, even if they ultimately share one underlying runtime owner.

**Surface Simplification**
- R6. The cleanup must reduce ownership ambiguity rather than only moving logic into more helper hooks.
- R7. The MVP frontend architecture docs must be rewritten to match the post-cleanup ownership model exactly, including route, store, and voice-runtime boundaries.
- R8. The cleanup must preserve a single clear rule for where new Sophia conversation work belongs, so future features do not have to choose between multiple parallel containers.

**Delivery and Safety**
- R9. The cleanup must be delivered as a staged program with bounded phases, checkpoints, and rollback-safe slices.
- R10. Current user-visible capabilities must continue to work throughout the cleanup: ritual session flow, ritual-less chat, voice mode, text mode, and current companion UI behavior unless a later explicit product decision changes them.
- R11. The cleanup must preserve or improve existing guardrails for streaming contracts, ownership boundaries, and regression testing.
- R12. The cleanup must keep the rule that Sophia companion product surfaces live in `AI-companion-mvp-front`; any overlap from other repo apps is either explicitly out of scope or explicitly walled off.

## Success Criteria
- A new contributor can point to one canonical owner for Sophia conversation runtime without ambiguity.
- `/session` and `/chat` are no longer separate orchestration stacks.
- Existing `/session` and `/chat` navigation remains usable throughout the staged rollout.
- Voice runtime ownership is singular and documented.
- The cleanup reduces the number of high-touch files that act as cross-domain coordinators.
- Architecture and ownership docs describe the real code instead of a target state that has already drifted.
- Future conversation features can be classified into one primary owner before implementation begins.

## Scope Boundaries
- No repo-wide rewrite of the non-MVP `frontend/` workspace app.
- The top-level `frontend/` app may receive boundary documentation or guardrail updates, but not structural chat consolidation as part of this effort.
- No backend protocol redesign or Mem0 architecture change as part of this cleanup.
- No cosmetic "cleanup" whose main outcome is file movement without ownership reduction.
- No deletion of historical brainstorm, plan, or solution artifacts.
- No broad UX redesign beyond what is required to unify ownership and remove duplicate runtime paths.

## Key Decisions
- Staged program over single big-bang rewrite.
- Ownership reduction over line-count reduction.
- Route consolidation is allowed now if it materially removes duplicated orchestration.
- Separate entry experiences may survive as thin compatibility shells during rollout, but runtime duplication may not.
- Compatibility shells or redirects are preferred over abrupt route removal.
- The MVP frontend is the primary cleanup target; other repo apps matter only where they create product-surface confusion.

## Dependencies / Assumptions
- Existing MVP frontend docs such as the route ownership baseline, canonical session contract, and progressive refactor plan are valid starting context, even where the current code has drifted.
- Backend chat and voice contracts are stable enough that the frontend can consolidate around them without simultaneous protocol redesign.
- Some legacy voice or onboarding code may need a temporary compatibility seam during migration.

## Outstanding Questions

### Deferred to Planning
- [Affects R2][Technical] Should the end state use one canonical route with aliases, or one canonical runtime shared by two stable routes?
- [Affects R3][Needs research] Which remaining legacy voice files are still required for onboarding or fallback behavior, and which are dead ownership residue?
- [Affects R12][Technical] What explicit boundary or documentation is needed between `AI-companion-mvp-front` and the top-level `frontend` app to prevent future Sophia surface overlap?

## Alternatives Considered
- Continue local extractions without consolidation: rejected because the repo already shows that extraction alone can redistribute complexity without reducing ownership count.
- Run a repo-wide cleanup across every frontend and backend surface at once: rejected because the blast radius is too high for the stated goal of MVP frontend ownership cleanup.

## Next Steps
-> /ce-plan for structured implementation planning