# Phase 12.5C-B4 - Artifact UI / Telemetry Count Reconciliation

Date: 2026-05-22
Status: Implemented, focused tests passing
Source branch: `fix/companion-artifact-single-emission-phase-12-5c-b3`
Working branch: `fix/artifact-ui-telemetry-count-reconciliation-phase-12-5c-b4`

## Why This Phase Exists

Phase 12.5C-B3 stabilized Gemini companion artifact emission: successful `emit_artifact` calls now publish public artifacts only after backend validation, cancellation filtering, and duplicate call-id suppression. The latest live smoke proved the execution/rendering path was no longer the primary failure: Builder stayed out of the turn, both `emit_artifact` calls reached `finalState: responded`, and the Session UI visibly rendered a companion artifact.

The contradiction was in telemetry export. The report showed `artifactToolCallCount: 2`, `builderToolCallCount: 0`, `toolCancellationCount: 0`, and `toolResponseSentAt` present, but also `metrics.sessionTelemetry.gemini.artifactCount: 0` and `metrics.counts.artifacts: 0` while the UI displayed:

- Takeaway: `Memory retrieval confirmed that the previous emphasis was on the distinction between intellectual understanding and lived experience.`
- Reflection: `Does calm come from reasoning, or from a shift in your body?`

This phase reconciles rendered artifact state with telemetry counts. It does not add an artifact orientation bridge, change the artifact schema, migrate to the 15-field schema, change Gemini/GPT routing, alter VAD, add tools, replay checkpointer context, or touch runtime `users/**` data.

## Artifact Event Flow

| Step | Code location | Current evidence | Worked? | Telemetry before B4 |
|---|---|---|---|---|
| Gemini model calls `emit_artifact` | `voice/realtime/gemini_live.py`, `voice/realtime/gemini_tool_loop.py` | Tool loop recognizes `emit_artifact` and executes the existing backend contract. | Yes | Counted as `artifactToolCallCount`, but that is not artifact success. |
| Backend validates/executes artifact | `backend/packages/harness/deerflow/sophia/tools/emit_artifact_contract.py`, `voice/realtime/gemini_tool_loop.py` | Arguments are validated with `ArtifactInput`; response includes `artifact_recorded` and `artifact_keys`; execution carries `public_artifact`. | Yes | Tool response/ledger captured. |
| Cancellation and duplicate filters pass | `voice/realtime/gemini_browser_dogfood.py` | Respondable executions exclude cancelled ids; published call ids are tracked per session. | Yes | B3 diagnostics cover cancellation/suppression. |
| Public artifact is emitted | `voice/realtime/gemini_browser_dogfood.py`, `voice/realtime/normalizer.py` | B3 strips raw mapper artifacts, then publishes `ProviderEventType.ARTIFACT_PAYLOAD` post-validation; normalizer emits `sophia.artifact`. | Intended yes | Counted only if the current capture slice contains `sophia.artifact`. |
| Frontend receives artifact | `frontend/src/app/hooks/useStreamVoiceSession.ts` | `handleSophiaEvent` records `sophia.*` events and calls `onArtifacts` for `sophia.artifact`. | Yes when public event arrives through this path | Public event count works only for captured/current-slice events. |
| UI stores/renders artifact | `frontend/src/app/companion-runtime/artifacts-runtime.ts`, `frontend/src/app/session/artifacts.ts`, `PresenceArtifactPanel.tsx` | `ingestArtifacts` merges the payload into `session.artifacts`; Presence panel renders `takeaway` / `reflection_candidate`. | Yes | `artifacts-runtime` evidence and snapshot state were not counted as canonical artifacts. |
| Runtime metrics count artifacts | `frontend/src/app/lib/voice-runtime-metrics.ts` | Before B4, `artifactCount` was `countWhere(activeEvents, event.name === "sophia.artifact")`. | Partially | Missed UI/session artifacts when public events were absent or scoped out. |
| Telemetry report exports counts | `frontend/src/app/lib/voice-telemetry-report.ts` | Before B4, report sanitized the already-built metrics and scoped event bundle. | Partially | Export could preserve zero counts even when current snapshot showed rendered artifacts. |

## Root Cause

The exported counters used only public `sophia.artifact` capture events in the active/current-run event slice. The UI used canonical session artifact state, populated by `artifacts-runtime` after artifact ingestion. Those are related but not identical evidence streams.

That made two mismatches possible:

1. A public artifact event could be missing from the capture bundle or omitted by current-run scoping while the latest artifact remained visible in `session.artifacts` and the Presence panel.
2. The report exported the last computed metrics object without reconciling it against the export-time capture snapshot, so a rendered artifact could be present in the exported snapshot while `counts.artifacts` stayed zero.

The important non-root-cause: raw tool calls are not enough. `artifactToolCallCount` can prove Gemini attempted `emit_artifact`, but a tool call alone must not increment artifact counts. B4 counts only public `sophia.artifact` events, artifact-runtime ingestion of validated UI state, or current rendered/session artifact state.

## Fix Implemented

`frontend/src/app/lib/voice-runtime-metrics.ts` now builds artifact counters from three evidence sources:

- public `sophia.artifact` events in the active capture slice;
- `artifacts-runtime` `ingest-artifacts` / `apply-memory-candidates` events that contain real artifact content;
- current capture snapshot session/DOM artifact state.

The canonical `artifactCount` and `counts.artifacts` are the maximum of those evidence counts, so a rendered/canonical artifact prevents false zeroes while public event count remains separately visible.

`frontend/src/app/lib/voice-telemetry-report.ts` reconciles artifact counts again at export time using the scoped event bundle plus the current capture snapshot. This keeps the downloaded report aligned with what the UI rendered at the moment of export.

`frontend/src/app/lib/turn-capture-diagnostics.ts` now includes compact final UI artifact count fields. It does not include full artifact text.

`VoiceMetricsPanel.tsx` now exposes the split in the live diagnostics panel: total artifacts, public artifact events, rendered artifacts, and count source.

## Count Definitions

| Field | Meaning | Source |
|---|---|---|
| `artifactToolCallCount` | Gemini tool-call attempts named `emit_artifact`. | Tool-loop diagnostics; not artifact success by itself. |
| `artifactPublicEventCount` | Public `sophia.artifact` events in the active/scoped capture events. | Normalized public event capture. |
| `artifactRuntimeIngestCount` | Artifact-runtime ingestion events with real artifact content. | UI artifact ingestion telemetry. |
| `artifactRenderedCount` | Current snapshot has rendered/session artifact content. | Capture snapshot session/DOM artifact state. |
| `artifactCount` / `counts.artifacts` | Canonical Session artifact count for telemetry. | Max of public event, runtime ingest, and rendered state counts. |
| `artifactCountSource` | Which evidence source supplied the canonical count. | `public_event`, `runtime_ingest`, `rendered_state`, or `none`. |
| `artifactCountMismatch` | Canonical count differs from public-event count. | Flags UI/rendered evidence without matching public-event count. |

## Tests Added

Frontend focused tests were added for:

- public `sophia.artifact` still increments `artifactCount` and reports `artifactPublicEventCount`;
- rendered/session artifact state increments `artifactCount` when no public event is present in the active slice;
- `emit_artifact` tool calls and tool responses alone do not increment artifact counts;
- telemetry export reconciles stale zero metrics against export-time rendered artifact state;
- turn-capture diagnostics carry compact artifact final UI state.

Existing B3 backend/Gemini relay tests still cover:

- successful `emit_artifact` emits exactly one public artifact;
- cancelled/suppressed calls do not publish artifacts;
- duplicate call ids do not duplicate backend side effects, tool responses, or public artifacts;
- Builder remains avoided for companion short reflection artifact requests.

## Manual Smoke Plan

Smoke 1 - Artifact create and count:

User: `Sophia, create a short reflection artifact. You can pick whatever subject you want.`

Expected:

- direct `emit_artifact`;
- `builderToolCallCount = 0`;
- `toolCancellationCount = 0` in the non-interrupted case;
- UI artifact visible;
- `artifactToolCallCount >= 1`;
- `artifactCount >= 1` and `counts.artifacts >= 1`;
- `artifactPublicEventCount >= 1` if the public event is present in the scoped export, otherwise `artifactRenderedCount >= 1` and `artifactCountSource` explains the fallback.

Smoke 2 - Visibility retry:

User: `Sophia, without guessing, what was your previous internal takeaway?`

Expected:

- if she answers from the exact latest artifact takeaway, native context may be sufficient;
- if she answers from general context or guesses, proceed to 12.5C-C compact latest-artifact orientation bridge.

Smoke 3 - Export timing:

Export telemetry only after the UI artifact is visibly rendered.

Expected:

- exported `metrics.counts.artifacts >= 1`;
- exported `metrics.sessionTelemetry.gemini.artifactCount >= 1`;
- report contains either a scoped public artifact event or compact rendered-artifact evidence via metrics/turn diagnostics;
- no Builder calls and no cancelled artifact response in the clean path.

## Can The Visibility Proof Be Retried?

Yes. B4 does not prove Gemini can use the artifact as next-turn model context, but it removes the telemetry false-negative that blocked interpreting the smoke. The 12.5C-B visibility proof can be retried once Smoke 1 shows artifact execution, UI rendering, and reconciled counts.

## Recommendation For 12.5C-C

Do not implement the compact artifact orientation bridge until the retried visibility smoke is run against the corrected telemetry. If Gemini still cannot answer from the exact previous takeaway, 12.5C-C should add a compact latest-artifact orientation bridge through a provider-visible path, latest-only and internal/non-spoken.

## Most Important Next-Prompt Context

Phase 12.5C-B4 fixes artifact telemetry counting only. Canonical artifact count now uses public artifact events plus validated UI/session artifact evidence; raw `emit_artifact` tool calls still do not count. B3's validated public emission boundary, cancellation filtering, and duplicate call-id suppression remain unchanged. No artifact schema migration or orientation bridge has been implemented.