# Memory Review Overlay

Use this pattern when the recap or moderation UI needs reliable `pending_review` behavior even though Mem0 metadata writes are delayed, partially dropped, or returned without stable IDs.

## When To Use
- Session end writes memory candidates that must immediately appear in recap review.
- `MemoryClient.add()` or follow-up metadata updates can return missing IDs or stale metadata.
- The UI needs to edit, approve, discard, or rehydrate candidates before Mem0 is fully consistent.

## Procedure
1. Persist review metadata locally in `users/{user_id}/memories/review_metadata.json` for every extracted candidate.
2. Treat the local store as the source of truth for moderation state (`pending_review`, `approved`, `discarded`) until Mem0 reconciliation is complete.
3. On `GET /api/sophia/{user_id}/memories/recent`, apply the local overlay before deciding whether per-memory Mem0 hydration is necessary.
4. Only call `client.get(memory_id)` when status is still unknown or when category/detail fields are missing and no local status already resolves the review filter.
5. If the frontend recap fallback must query the unfiltered memory list, re-filter fallback results to `pending_review` or missing-status records before returning them to the UI.
6. Support `local:{content_hash}` IDs in update, delete, and bulk-review routes so local-only candidates remain actionable.
7. Reconcile local-only entries back to real Mem0 IDs using fuzzy content matching once Mem0 eventually returns a stable record.

## Pitfalls
- Do not rely on Mem0 server-side filtering alone for review queues; local-only candidates will disappear.
- Do not drop `metadata` in frontend fallback handling before filtering by status.
- Do not default dev auth bypass to a tracked seeded user if runtime `users/` data is versioned.
- Do not hydrate every memory on every `pending_review` request; that turns recap loads into N+1 Mem0 traffic.

## Verification
- End a session and confirm new candidates appear in recap immediately.
- Approve or discard a candidate, refresh the recap route, and verify it does not reappear as pending.
- Run backend coverage for `memories/recent` and confirm status-filtered overlay cases do not call `client.get(...)` unnecessarily.
- Run frontend coverage for `/api/memory/recent` fallback and confirm approved/discarded candidates are filtered out.