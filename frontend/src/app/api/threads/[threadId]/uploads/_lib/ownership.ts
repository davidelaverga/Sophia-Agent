/**
 * Backwards-compatible re-export.
 *
 * The ``userOwnsThread`` helper used to live here, but the chat
 * post-handler needed to use it too (Codex P1 PR #132: ownership
 * gate when the chat request includes ``attached_files``). It was
 * promoted to ``frontend/src/app/lib/api/thread-ownership.ts``;
 * this file stays as a thin re-export so existing imports keep
 * working without churn.
 */

export { userOwnsThread } from "../../../../../lib/api/thread-ownership";
