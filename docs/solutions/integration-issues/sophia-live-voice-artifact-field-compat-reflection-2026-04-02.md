---
title: "Sophia live artifact compatibility: normalize raw reflection events into canonical reflection candidates"
date: 2026-04-02
category: integration-issues
module: live-artifact-pipeline
problem_type: integration_issue
component: assistant
symptoms:
  - Live session Artifacts panels could render Takeaway while Reflection stayed stuck in composing.
  - Raw `sophia.artifact` payloads from the live voice path could contain `reflection`, but the live runtime only looked for `reflection_candidate`.
  - Recap or persisted artifact rendering already handled the fallback, so the bug appeared only during live voice sessions.
root_cause: wrong_api
resolution_type: code_fix
severity: medium
related_components:
  - AI-companion-mvp-front session artifacts
  - AI-companion-mvp-front companion runtime
  - voice.server
tags: [voice, artifacts, reflection, contract-normalization, live-session]
---

# Sophia live artifact compatibility: normalize raw reflection events into canonical reflection candidates

## Problem

Sophia's live voice runtime could successfully deliver a takeaway while leaving Reflection stuck in a loading state. The frontend already had a canonical artifact shape, but the live event path and the persisted recap path were not reconciling the same field names before the UI consumed them.

## Symptoms

- The Artifacts panel showed a completed takeaway while the Reflection card remained at "composing".
- Live `sophia.artifact` payloads contained a usable `reflection` value, but the runtime never promoted it into canonical session state.
- The same reflection content rendered correctly in recap or persisted flows, which made the failure look like a live-only UI problem.
- Restarting the voice server after the fix would have failed on a malformed import in `voice/server.py` if that typo had not been corrected during the same pass.

## What Didn't Work

- Patching only the panel component to look for both keys. That would have hidden the contract mismatch instead of fixing the shared state shape.
- Assuming the backend had to rename the field to `reflection_candidate` before the frontend could accept it. The live companion artifact can legitimately arrive as raw `reflection`.
- Looking only at the recap path. The persisted adapter already tolerated `payload.reflection_candidate || payload.reflection`, so it did not explain the live-session failure.

## Solution

The fix moved the compatibility logic into the shared artifact normalization seam so live and persisted ingestion paths converge before UI rendering.

### 1. Alias raw live `reflection` to canonical `reflection_candidate`

`AI-companion-mvp-front/src/app/session/artifacts.ts` now normalizes either field into the same extracted reflection candidate:

```ts
const reflectionCandidate = extractReflectionCandidate(
  payload.reflection_candidate ?? payload.reflection
);
```

That keeps the panel dependent on one canonical field while still accepting the live transport variant.

### 2. Preserve the legacy field through the stream adapter and runtime typing

`AI-companion-mvp-front/src/app/session/stream-contract-adapters.ts` now preserves valid raw `reflection` values instead of dropping them during payload cleanup, and `AI-companion-mvp-front/src/app/companion-runtime/artifacts-runtime.ts` explicitly treats either `reflection_candidate` or `reflection` as a real reflection signal.

```ts
if (
  payload.reflection !== undefined &&
  typeof payload.reflection !== 'string' &&
  (typeof payload.reflection !== 'object' || payload.reflection === null)
) {
  delete payload.reflection;
}
```

This keeps the contract tolerant at the adapter layer and consistent at the state layer.

### 3. Add regression coverage for the real live shape

Targeted tests now prove that a payload containing raw `reflection` becomes canonical `reflection_candidate` state and drives live artifact status to `ready`:

- `AI-companion-mvp-front/src/__tests__/session/artifacts.test.ts`
- `AI-companion-mvp-front/src/__tests__/session/stream-contract-adapters.test.ts`

### 4. Fix the secondary voice-server import typo

`voice/server.py` also had a malformed `dependencies` import token. Correcting it was not the root fix for the Reflection bug, but it prevented the next voice-server restart from failing on syntax.

## Why This Works

The bug was not in the Reflection panel itself. It was in the mismatch between the live artifact contract and the canonical session artifact shape. By normalizing both `reflection_candidate` and raw `reflection` at the shared ingestion seam, the rest of the UI sees one stable field and no longer needs to understand transport-specific variations.

This also brings the live voice path back into line with the persisted recap path. Both routes now converge on the same canonical artifact state before status calculation or rendering happens.

## Prevention

- Treat `artifacts.ts` and `stream-contract-adapters.ts` as the compatibility boundary for artifact-shape differences. Do not push transport exceptions into UI components.
- Keep regression tests for both accepted input shapes: raw `reflection` and canonical `reflection_candidate`.
- When a live artifact issue looks visual, compare the live path against the persisted recap adapter before changing panel rendering.
- Restart the live voice server after touching runtime files such as `voice/server.py`; stale processes can make a good fix look broken.

## Related Issues

- Related but distinct: [docs/solutions/integration-issues/sophia-voice-degraded-transcript-mapping-and-turn-closure-2026-04-02.md](sophia-voice-degraded-transcript-mapping-and-turn-closure-2026-04-02.md)
- Upstream context: [docs/plans/2026-04-01-002-fix-live-voice-artifact-pipeline-plan.md](../../plans/2026-04-01-002-fix-live-voice-artifact-pipeline-plan.md)